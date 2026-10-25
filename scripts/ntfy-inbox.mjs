#!/usr/bin/env node
// scripts/ntfy-inbox.mjs — Claude reads the owner's ntfy channel instead of the owner relaying it (2026-10-25).
//
// The owner asked: "I don't want to be in the middle of this equation where I'm having to tell you what's broken."
// ntfy.sh keeps a topic's messages for ~12 h, so this polls every 15 min (LaunchAgent com.ruvnet.ntfy-inbox, wrapped
// by job-heartbeat.sh), appends every message to a local inbox, and keeps a list of OPEN alerts — each one something
// that needs action. An alert closes by itself when its cause clears (the job passes, the workflow goes green on main,
// the issue is closed or answered) or when a session records what it did (--ack). SessionStart in this repo prints
// the open list (plugin/scripts/session-start-issue-alert.mjs), so every session starts by handling them.
//
//   node scripts/ntfy-inbox.mjs            poll, file new alerts, auto-close resolved ones
//   node scripts/ntfy-inbox.mjs --open     print the open alerts
//   node scripts/ntfy-inbox.mjs --ack <id|all> [--note "what was done"]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'stuinfla/ruvnet-brain';
export const STATE_DIR = () => process.env.RUVNET_NTFY_INBOX_DIR || path.join(os.homedir(), '.cache', 'ruvnet-brain');
const INBOX = () => path.join(STATE_DIR(), 'ntfy-inbox.jsonl');
export const OPEN_FILE = () => path.join(STATE_DIR(), 'ntfy-open-alerts.json');
const MAX_INBOX_BYTES = 4 * 1024 * 1024;

export function resolveTopic(env = process.env) {
  if (env.NTFY_TOPIC !== undefined) return env.NTFY_TOPIC || null;
  try { const t = fs.readFileSync(path.join(os.homedir(), '.cache', 'ruvnet-brain', 'ntfy-topic'), 'utf8').trim(); if (t) return t; } catch { /* next */ }
  try { const m = /^NTFY_TOPIC=(.*)$/m.exec(fs.readFileSync(path.join(ROOT, '.env'), 'utf8')); if (m) return m[1].trim(); } catch { /* none */ }
  return null;
}

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const writeJson = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.tmp-${process.pid}`; fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`); fs.renameSync(tmp, file); };

/** What an ntfy message is about, and whether it needs action. `key` groups repeats of the same cause. */
export function classify(msg) {
  const title = String(msg.title || ''); const body = String(msg.message || '');
  let m;
  if ((m = /SCHEDULED JOB FAILED: (\S+)/.exec(title))) return { kind: 'job', key: `job:${m[1]}`, label: m[1], actionable: true };
  if ((m = /Recovered: (\S+)/.exec(title))) return { kind: 'job-recovered', key: `job:${m[1]}`, label: m[1], actionable: false, resolves: true };
  if ((m = /CI \w+: (.+)$/.exec(title))) return { kind: 'ci', key: `ci:${m[1].trim()}`, workflow: m[1].trim(), actionable: true };
  if ((m = /(?:New issue|SLA breach: issue) #(\d+)/.exec(title))) return { kind: 'issue', key: `issue:${m[1]}`, number: Number(m[1]), actionable: true };
  if ((m = /New PR #(\d+)/.exec(title))) return { kind: 'pr', key: `pr:${m[1]}`, number: Number(m[1]), actionable: true };
  if (/^Waiting on a reply/.test(title)) return { kind: 'digest', key: 'digest:issues', actionable: false };
  if (/New star/.test(title)) return { kind: 'info', key: `info:${msg.id}`, actionable: false };
  return { kind: 'other', key: `other:${title.slice(0, 60) || body.slice(0, 60)}`, actionable: true };
}

/** Is this alert's cause gone? Checked live; an unreadable fact keeps the alert open. */
export function resolvedNow(alert, { gh = ghJson, heartbeat = readHeartbeat } = {}) {
  try {
    if (alert.kind === 'job') return heartbeat(alert.label)?.state === 'ok';
    if (alert.kind === 'issue' || alert.kind === 'pr') {
      const item = gh([alert.kind === 'pr' ? 'pr' : 'issue', 'view', String(alert.number), '--repo', REPO, '--json', 'state']);
      return item && item.state !== 'OPEN';
    }
    if (alert.kind === 'ci') {
      const runs = gh(['run', 'list', '--repo', REPO, '--workflow', alert.workflow, '--branch', 'main', '--limit', '1', '--json', 'conclusion,status,createdAt']);
      const run = runs?.[0];
      return Boolean(run && run.status === 'completed' && run.conclusion === 'success' && Date.parse(run.createdAt) > Date.parse(alert.lastAt));
    }
  } catch { return false; }
  return false;
}
function ghJson(args) { const r = spawnSync('gh', args, { encoding: 'utf8', timeout: 30_000 }); if (r.status !== 0) throw new Error(r.stderr || 'gh failed'); return JSON.parse(r.stdout || 'null'); }
function readHeartbeat(label) { return readJson(path.join(os.homedir(), '.cache', 'ruvnet-brain', 'heartbeats', `${label}.json`), null); }

/** Fold new messages into the open list. Pure apart from the injected resolver. */
export function fold(open, messages, { now = Date.now(), resolver = resolvedNow } = {}) {
  const byKey = new Map(open.map((a) => [a.key, a]));
  for (const msg of messages) {
    const c = classify(msg);
    if (c.resolves) { const a = byKey.get(c.key); if (a) { a.closedAt = new Date(msg.time * 1000).toISOString(); a.closedBy = 'recovered notice'; } continue; }
    if (!c.actionable) continue;
    const at = new Date((msg.time || now / 1000) * 1000).toISOString();
    const existing = byKey.get(c.key);
    if (existing && !existing.closedAt) { existing.count += 1; existing.lastAt = at; existing.lastTitle = msg.title; continue; }
    byKey.set(c.key, { id: msg.id, ...c, firstAt: at, lastAt: at, count: 1, title: msg.title || '', body: String(msg.message || '').slice(0, 500) });
  }
  for (const a of byKey.values()) {
    if (!a.closedAt && resolver(a)) { a.closedAt = new Date(now).toISOString(); a.closedBy = 'cause cleared'; }
  }
  // Closed alerts are kept 7 days for the record, then dropped.
  return [...byKey.values()].filter((a) => !a.closedAt || now - Date.parse(a.closedAt) < 7 * 86_400_000);
}

export async function poll({ fetcher = globalThis.fetch, now = Date.now(), resolver } = {}) {
  const topic = resolveTopic();
  if (!topic) throw new Error('no ntfy topic configured');
  const statePath = path.join(STATE_DIR(), 'ntfy-inbox-state.json');
  const state = readJson(statePath, {});
  const since = state.lastId || '12h';
  // Bounded: the first scheduled run hung for over an hour on a fetch with no deadline (2026-10-25).
  const res = await fetcher(`https://ntfy.sh/${encodeURIComponent(topic)}/json?poll=1&since=${encodeURIComponent(since)}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`ntfy poll failed: HTTP ${res.status}`);
  const messages = (await res.text()).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((m) => m && m.event === 'message' && m.id !== state.lastId);
  if (messages.length) {
    fs.mkdirSync(STATE_DIR(), { recursive: true });
    try { if (fs.statSync(INBOX()).size > MAX_INBOX_BYTES) fs.renameSync(INBOX(), `${INBOX()}.1`); } catch { /* new inbox */ }
    fs.appendFileSync(INBOX(), messages.map((m) => JSON.stringify({ id: m.id, time: m.time, title: m.title, message: m.message, priority: m.priority })).join('\n') + '\n');
    state.lastId = messages.at(-1).id;
  }
  const open = fold(readJson(OPEN_FILE(), []), messages, { now, ...(resolver ? { resolver } : {}) });
  // Every open actionable alert not yet handed to a responder is handed over once.
  // At most 3 per run, so each gets a real fix: a person's issue first, then main/scheduled failures, oldest first.
  const rank = { issue: 0, pr: 1, ci: 2, job: 3, other: 4 };
  const fresh = open.filter((a) => !a.closedAt && !a.dispatchedAt)
    .sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9) || Date.parse(a.firstAt) - Date.parse(b.firstAt)).slice(0, 3);
  const responded = maybeRespond(fresh, { now });
  if (responded.started) for (const a of fresh) a.dispatchedAt = new Date(now).toISOString();
  writeJson(OPEN_FILE(), open);
  state.polledAt = new Date(now).toISOString();
  writeJson(statePath, state);
  return { received: messages.length, open: open.filter((a) => !a.closedAt), responder: responded };
}

// ── THE RESPONDER (owner's choice 2026-10-25: "fix and ship") ─────────────────────────────────────────────────────
// When an actionable alert is new and the responder is enabled (~/.config/ruvnet-brain/ntfy-responder.json
// {"enabled": true}), ONE headless Claude starts in its own worktree (never the owner's checkout, so it can never
// collide with a live session), finds the root cause, fixes it, and ships through the repo's own gated release rules.
// Bounded: one run at a time (pid lock), at most maxRunsPerDay (default 4), each alert dispatched once.
const RESPONDER_CONFIG = () => path.join(os.homedir(), '.config', 'ruvnet-brain', 'ntfy-responder.json');
const RESPONDER_DIR = () => path.join(STATE_DIR(), 'responder');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

export function responderPrompt(alerts) {
  const list = alerts.map((a) => `- [${a.kind}] ${a.title}\n  ${a.body.split('\n').slice(0, 3).join(' / ')}\n  alert id: ${a.id}`).join('\n');
  return `You are the RuvNet Brain responder. The owner (Stuart) asked that alerts on his ntfy channel be handled without him relaying them: find the root cause, fix it, and ship it, so the alert never comes back. You run headless; nobody will answer questions.

New alerts:
${list}

Rules:
1. Read CLAUDE.md and CONTRIBUTING.md in this repo first; CONTRIBUTING.md is the only rulebook for branches, versions and releases. Ground any claim about rUv tools with the search_ruvnet tool.
2. You are in a dedicated clone on the internal disk, reset to origin/main. Never touch /Users/stuartkerr/Code/ruvnet-brain (the owner's checkout, on an external drive). Run npm ci before tests.
3. For each alert: reproduce or read the evidence (job receipts in ~/.cache/ruvnet-brain/heartbeats, logs in ~/Library/Logs/launchd and ~/.claude/*.log, gh run view for CI, gh issue view for issues), find the root cause, and fix it properly (with a test that fails before the fix).
   - A problem on this Mac only (a job's config, a missing tool) is fixed on this Mac and verified by re-running the job.
   - A code fix ships via a release/X.Y.Z branch exactly as CONTRIBUTING.md describes: preflight green, an independent review by an Opus agent and a cross-vendor review via codex exec with every finding fixed, ADR currency and the ADR-0103 lock clean, fast-forward main, dispatch protected-release, watch it to install-verified. If CORPUS_NIGHTLY must be off for the window, turn it back on afterwards.
   - A person's GitHub issue: fix it the same way, then reply on the issue in plain, warm language saying what changed and in which version, and close it if fully fixed.
4. Close each alert you handled: node scripts/ntfy-inbox.mjs --ack <alert id> --note "<root cause and what shipped>". If you could not fix one, leave it open and add a note with --note on a new line in ~/.cache/ruvnet-brain/responder/blocked.md saying exactly what blocks it.
5. Never force-push, never skip hooks or gates, never merge with the GitHub merge button, never publish outside protected-release.yml, never print secrets.
6. Finish with a short plain-English summary of what you found and did.`;
}

export function maybeRespond(newAlerts, { now = Date.now(), launcher = launchResponder } = {}) {
  const cfg = readJson(RESPONDER_CONFIG(), null);
  if (!cfg?.enabled || !newAlerts.length) return { started: false, why: cfg?.enabled ? 'nothing new' : 'responder off' };
  const statePath = path.join(RESPONDER_DIR(), 'state.json');
  const st = readJson(statePath, { runs: [] });
  if (st.pid && alive(st.pid)) return { started: false, why: `responder ${st.pid} still running` };
  const today = new Date(now).toISOString().slice(0, 10);
  const runsToday = st.runs.filter((r) => r.startedAt.startsWith(today)).length;
  if (runsToday >= (cfg.maxRunsPerDay || 4)) return { started: false, why: 'daily cap reached' };
  const pid = launcher(responderPrompt(newAlerts), cfg);
  st.pid = pid; st.runs = [...st.runs.slice(-50), { startedAt: new Date(now).toISOString(), pid, alerts: newAlerts.map((a) => a.id) }];
  writeJson(statePath, st);
  return { started: true, pid };
}

/** The responder's environment: subscription login only (no API keys), approved programs first, a 3 h limit. */
export function responderEnv(base, cfg = {}) {
  const env = { ...base, RUVNET_RESPONDER: '1', JOB_MAX_SECONDS: String(cfg.maxSeconds || 10_800) };
  // ~/Code is an external drive: macOS holds or refuses reads from programs it has not approved for it, and
  // Homebrew's ad-hoc-signed builds lose approval on every upgrade (measured 2026-10-25: Homebrew node and git
  // blocked; Apple's /usr/bin tools and the approved node in job-bin allowed). Approved programs come first.
  env.PATH = [path.join(os.homedir(), '.local', 'share', 'ruvnet-brain', 'job-bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin',
    path.join(os.homedir(), '.npm-global', 'bin'), '/opt/homebrew/bin'].join(':');
  for (const k of ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'REACT_APP_CLAUDE_API_KEY']) delete env[k];
  return env;
}

function launchResponder(prompt, cfg) {
  // Its own clone on the INTERNAL disk, never the owner's checkout: ~/Code is an external drive that macOS keeps
  // Homebrew's git/gh/node out of when launchd starts them (measured 2026-10-25), and a separate clone can never
  // collide with a live session. Reset to origin/main before every run.
  const worktree = cfg.worktree || path.join(os.homedir(), '.local', 'share', 'ruvnet-brain', 'responder-repo');
  const git = (args) => spawnSync('/usr/bin/git', args, { encoding: 'utf8', timeout: 600_000 });
  if (!fs.existsSync(path.join(worktree, '.git'))) {
    const r = git(['clone', '--filter=blob:none', `https://github.com/${REPO}.git`, worktree]);
    if (r.status !== 0) throw new Error(`responder clone: ${r.stderr}`);
  }
  for (const args of [['fetch', '-q', 'origin'], ['checkout', '-q', '--detach', '--force', 'origin/main'], ['clean', '-fdq', '-e', 'node_modules']]) {
    const r = git(['-C', worktree, ...args]);
    if (r.status !== 0) throw new Error(`responder repo ${args[0]}: ${r.stderr}`);
  }
  fs.mkdirSync(RESPONDER_DIR(), { recursive: true });
  const log = fs.openSync(path.join(RESPONDER_DIR(), `${new Date().toISOString().replace(/[:.]/g, '-')}.log`), 'a');
  const claude = cfg.claudeBin || path.join(os.homedir(), '.npm-global', 'bin', 'claude');
  // BILLING SAFETY (issue-fix.mjs, the $1,600 lesson): strip every API key so the run uses the owner's
  // subscription login, never a metered key. Same least-privilege shape as issue-fix: an explicit tool list,
  // no --dangerously-skip-permissions. Wrapped by job-heartbeat.sh: a receipt, a 3 h limit, one page on failure.
  const env = responderEnv(process.env, cfg);
  const tools = 'Bash Read Edit Write Glob Grep Agent mcp__plugin_ruvnet-brain_ruvnet-brain__search_ruvnet';
  const child = spawn('/bin/sh', [path.join(ROOT, 'scripts', 'job-heartbeat.sh'), 'com.ruvnet.ntfy-responder', '--',
    claude, '-p', prompt, '--model', cfg.model || 'opus', '--permission-mode', 'acceptEdits', '--allowedTools', tools, '--output-format', 'text'],
  { cwd: worktree, detached: true, stdio: ['ignore', log, log], env });
  child.unref();
  return child.pid;
}

export function ack(idOrAll, note = '', now = Date.now()) {
  const open = readJson(OPEN_FILE(), []);
  let n = 0;
  for (const a of open) if (!a.closedAt && (idOrAll === 'all' || a.id === idOrAll || a.key === idOrAll)) { a.closedAt = new Date(now).toISOString(); a.closedBy = note || 'acknowledged by a session'; n += 1; }
  writeJson(OPEN_FILE(), open);
  return n;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    if (args[0] === '--open') {
      const open = readJson(OPEN_FILE(), []).filter((a) => !a.closedAt);
      if (!open.length) console.log('No open ntfy alerts.');
      for (const a of open) console.log(`${a.id}  [${a.kind}] ${a.title}${a.count > 1 ? `  (×${a.count}, since ${a.firstAt})` : ''}\n    ${a.body.split('\n')[0].slice(0, 160)}`);
    } else if (args[0] === '--ack') {
      const noteAt = args.indexOf('--note');
      console.log(`closed ${ack(args[1] || 'all', noteAt > 0 ? args[noteAt + 1] : '')} alert(s)`);
    } else {
      const r = await poll();
      console.log(`ntfy-inbox: ${r.received} new message(s); ${r.open.length} open alert(s); responder: ${r.responder.started ? `started pid ${r.responder.pid}` : r.responder.why}`);
    }
  } catch (error) {
    console.error(`ntfy-inbox: FAILED — ${error.message}`);
    process.exit(1);
  }
}
