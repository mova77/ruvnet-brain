// brain-alarm.mjs — the GONG. When retrieval itself breaks, this makes the failure IMPOSSIBLE to miss.
//
// Born 2026-07-12: the brain went completely dark (node_modules wiped — every repo erroring) and
// search_ruvnet reported it as an innocent "(no results)" for an unknown number of days. Stuart's
// standing order: "big gonging things flashing all over the place — that can NEVER happen silently."
//
// This module is the shared alarm plumbing behind three independent gong layers:
//   1. REAL-TIME  — forge-mcp-all.mjs / forge-ask-all.mjs call reportBrainDown() the moment a
//                   total-failure search happens (all repos erroring ≠ empty result).
//   2. PER-SESSION — plugin/scripts/session-start.sh reads health.json (written here) plus its own
//                   structural checks, and flashes a banner in EVERY new Claude Code session.
//   3. NIGHTLY    — scripts/nightly-wrapper.sh runs a canary query; a non-zero exit (which
//                   forge-ask-all now guarantees on total failure) triggers an urgent phone push.
//
// Contract: NEVER throws, NEVER blocks a healthy query. Alarm failure must not break search —
// but search failure must always ring the alarm.
//
// Phone push: sent via ntfy when a topic is discoverable (NTFY_TOPIC env, or a one-line
// ~/.cache/ruvnet-brain/ntfy-topic file). No topic → no push (public installs stay quiet), but
// health.json is ALWAYS written, so the session-start banner still gongs on every machine.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const STATE_DIR = path.join(os.homedir(), '.cache', 'ruvnet-brain');
export const HEALTH_PATH = path.join(STATE_DIR, 'health.json');
// PAGE DAMPING (4.7.21). The pages below never left the machine before 4.7.21 (an emoji Title made fetch() throw
// before sending), so these rules were never exercised. Now that pages arrive, a flapping brain must not flap the
// phone: DOWN pages only after two failures at least 5 min apart, at most once per 6 h (remembered across "up"
// states), and a recovery is announced only for a DOWN page that was delivered and an outage of 10 min or more.
const MIN = 60_000;
const DOWN_CONFIRM_MS = 5 * MIN;
const DOWN_PAGE_GAP_MS = 6 * 60 * MIN;
const RECOVERY_MIN_OUTAGE_MS = 10 * MIN;

function readHealth() {
  try { return JSON.parse(fs.readFileSync(HEALTH_PATH, 'utf8')); } catch { return null; }
}

function writeHealth(obj) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(HEALTH_PATH, JSON.stringify(obj, null, 2) + '\n');
  } catch { /* the alarm must never throw */ }
}

function ntfyTopic() {
  // Set-but-EMPTY is an explicit opt-out (job-heartbeat.sh's convention): never fall through to the topic file.
  if (process.env.NTFY_TOPIC !== undefined) return process.env.NTFY_TOPIC.trim() || null;
  try {
    const t = fs.readFileSync(path.join(STATE_DIR, 'ntfy-topic'), 'utf8').trim();
    if (t) return t;
  } catch { /* no topic file — push disabled, banner still gongs */ }
  return null;
}

/** Delivered means a 2xx. The Title is plain ASCII (an HTTP header must be a ByteString); Tags carry the emoji. */
async function push(title, message, priority = 'urgent', tags = 'rotating_light') {
  const topic = ntfyTopic();
  if (!topic) return false;
  const base = (process.env.NTFY_URL || 'https://ntfy.sh').replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: { Title: String(title).replace(/[^\x20-\x7e]+/g, ' ').trim(), Priority: priority, Tags: tags },
      body: message,
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch { return false; }
}

/**
 * Ring the gong: the brain failed a real search (total failure — retrieval itself is broken).
 * Writes health.json on EVERY call (the session-start banner is never damped) and pages per the rules above.
 * Never throws. Await it from a CLI that is about to exit; fire-and-forget from a server.
 */
export async function reportBrainDown({ error, source }) {
  try {
    const prev = readHealth();
    const now = Date.now();
    const continuing = prev?.status === 'down';
    const firstDownTs = continuing ? (prev.firstDownTs || now) : now;
    const failCount = continuing ? (Number(prev.failCount) || 1) + 1 : 1;
    const lastDownPageAt = Number(prev?.lastDownPageAt) || (continuing ? Number(prev.lastNtfyTs) || 0 : 0);
    const health = {
      status: 'down',
      error: String(error || 'unknown').slice(0, 500),
      source: source || 'unknown',
      ts: new Date(now).toISOString(),
      firstDownTs,
      failCount,
      lastDownPageAt,
      downPaged: continuing ? !!prev.downPaged : false,
      fix: 'cd ~/.cache/ruvnet-brain/kb && npm i   — then verify: npx github:stuinfla/ruvnet-brain --doctor',
    };
    if (!health.downPaged && failCount >= 2 && now - firstDownTs >= DOWN_CONFIRM_MS && now - lastDownPageAt >= DOWN_PAGE_GAP_MS) {
      const sent = await push(
        'RuvNet Brain is DOWN',
        `Every repo failed to search (source: ${health.source}). This is NOT an empty result — retrieval itself is broken.\n`
        + `First error: ${health.error.slice(0, 200)}\n`
        + `Fix: ${health.fix}`,
      );
      if (sent) { health.lastDownPageAt = now; health.downPaged = true; }
    }
    writeHealth(health);
  } catch { /* never */ }
}

/**
 * All-clear: a real search succeeded with zero repo errors. Only writes on a down→ok transition
 * (no write churn on every healthy query). The 6 h DOWN-page memory survives the "ok" record.
 */
export async function reportBrainUp({ source } = {}) {
  try {
    const prev = readHealth();
    if (!prev || prev.status !== 'down') return;
    const now = Date.now();
    writeHealth({ status: 'ok', ts: new Date(now).toISOString(), recoveredFrom: prev.error, source: source || 'unknown',
      lastDownPageAt: Number(prev.lastDownPageAt) || 0 });
    if (prev.downPaged && now - (Number(prev.firstDownTs) || now) >= RECOVERY_MIN_OUTAGE_MS) {
      await push('RuvNet Brain recovered', `Searches are working again (source: ${source || 'unknown'}).`, 'default', 'white_check_mark');
    }
  } catch { /* never */ }
}

/** Classify a searchAll() perRepo map: which repos errored, and is this a TOTAL failure? */
export function classifyPerRepo(perRepo, repos) {
  const errors = Object.entries(perRepo || {}).filter(([, v]) => typeof v === 'string' && v.startsWith('ERR:'));
  return {
    errors,
    total: repos?.length || 0,
    allFailed: repos?.length > 0 && errors.length === repos.length,
  };
}
