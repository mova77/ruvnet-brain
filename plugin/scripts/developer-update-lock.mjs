// Directory ownership protocol shared with agentic-kit. Inherited children do not release the parent.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
const brainRoot = brainHome => brainHome || process.env.RUVNET_BRAIN_HOME || path.join(os.homedir(), '.cache/ruvnet-brain');
const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// A dead or reclaimable owner must have been gone this long; an unreadable owner is judged by the directory's age.
export const STALE_RECLAIM_MS = 10 * 60 * 1000;
/** The OS start time of `pid` (`ps -o lstart=`, as kb/refresh-run.mjs records it), or null when it cannot be read (Windows). */
export function processStartOf(pid, { platform = process.platform } = {}) {
  if (platform === 'win32' || !Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    const r = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 5000, env: { ...process.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C' } });
    const start = String(r.stdout || '').trim();
    return r.status === 0 && start ? start : null;
  } catch { return null; }
}
const removal = directory => process.platform === 'win32' ? `Remove-Item -Recurse -Force "${directory}"` : `rm -rf "${directory}"`;
// ── takeover is serialized (4.7.21 review, Codex #1) ─────────────────────────────────────────────
// Two contenders could judge the same abandoned lock: A moved it aside and acquired, then B moved A's FRESH lock
// aside on its stale judgement and both ran. A takeover now (1) creates an exclusive claim file inside the judged
// directory ('wx': one winner per directory instance), (2) re-checks, while holding the claim, that it is the same
// directory (dev/ino) with byte-identical owner.json, and only then (3) moves it aside. A claim left by a crashed
// reclaimer is superseded by the next numbered claim once CLAIM_STALE_MS old. The owner record is published with an
// exclusive link, so two processes that both believe they created the directory cannot both become its owner.
export const CLAIM_STALE_MS = 5 * 60 * 1000;
const CLAIM_FILE = /^takeover(?:-(\d+))?\.json$/;
function observeDirectory(directory) {
  const stat = fs.lstatSync(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('not an owned directory');
  let raw = null;
  try { raw = fs.readFileSync(path.join(directory, 'owner.json'), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { identity: `${stat.dev}:${stat.ino}`, raw };
}
const readRaw = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
function claimTakeover(directory) {
  let highest = -1, highestName = null;
  for (const name of fs.readdirSync(directory)) {
    const match = CLAIM_FILE.exec(name);
    if (match && (match[1] ? Number(match[1]) : 0) > highest) { highest = match[1] ? Number(match[1]) : 0; highestName = name; }
  }
  if (highestName) {
    let ageMs = 0;
    try { ageMs = Date.now() - fs.lstatSync(path.join(directory, highestName)).mtimeMs; } catch { return null; }
    if (!(ageMs > CLAIM_STALE_MS)) return null; // another reclaimer is mid-takeover
  }
  const level = highest + 1;
  const file = path.join(directory, level ? `takeover-${level}.json` : 'takeover.json');
  const token = crypto.randomUUID();
  try { fs.writeFileSync(file, JSON.stringify({ token, pid: process.pid, claimedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code === 'EEXIST' || error.code === 'ENOENT') return null; throw error; }
  return { file, token };
}
const dropClaim = claim => { try { if (readRaw(claim.file)?.includes(claim.token)) fs.unlinkSync(claim.file); } catch { /* gone with its directory */ } };
/** Move `directory` aside only if it is still exactly the one observed: 'removed' | 'changed' | 'busy'. */
function removeObservedLock(directory, observed, { afterClaim = null } = {}) {
  const claim = claimTakeover(directory);
  if (!claim) return 'busy';
  afterClaim?.({ directory, claim });
  let same = false;
  try {
    const now = observeDirectory(directory);
    same = now.identity === observed.identity && now.raw === observed.raw && Boolean(readRaw(claim.file)?.includes(claim.token));
  } catch { same = false; }
  if (!same) { dropClaim(claim); return 'changed'; }
  const tomb = `${directory}.stale-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try { fs.renameSync(directory, tomb); } catch (error) { if (error.code === 'ENOENT') return 'changed'; dropClaim(claim); throw error; }
  if (!readRaw(path.join(tomb, path.basename(claim.file)))?.includes(claim.token)) {
    try { if (!fs.existsSync(directory)) fs.renameSync(tomb, directory); } catch { /* keep it as evidence */ }
    throw Error(`developer update lock takeover moved a directory it did not claim; ${directory}`);
  }
  fs.rmSync(tomb, { recursive: true, force: true });
  return 'removed';
}
/** Publish owner.json complete-or-absent AND exclusively: a hard link fails with EEXIST when another owner got there first. */
function publishOwner(file, content) {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  fs.writeFileSync(tmp, content, { flag: 'wx', mode: 0o600 });
  try {
    try { fs.linkSync(tmp, file); }
    catch (error) {
      if (!['EPERM', 'ENOTSUP', 'ENOSYS', 'EXDEV'].includes(error.code)) throw error;
      fs.writeFileSync(file, content, { flag: 'wx', mode: 0o600 }); // a filesystem without hard links: still exclusive
    }
  } finally { try { fs.unlinkSync(tmp); } catch { /* already gone */ } }
}
export function sharedLockStatus({ brainHome, alive = pidAlive, startOf = processStartOf } = {}) {
  const directory = path.join(brainRoot(brainHome), 'developer-update.lock');
  let observed = null;
  try {
    observed = observeDirectory(directory);
    if (observed.raw === null) throw Object.assign(Error('owner.json absent'), { code: 'ENOENT' });
    const owner = JSON.parse(observed.raw);
    if (!Number.isInteger(owner.pid) || owner.pid < 1 || typeof owner.token !== 'string' || owner.token.length < 16) throw Error('invalid owner');
    if (!alive(owner.pid)) return { state: 'stale', directory, owner, observed };
    // A live pid is the owner only when the recorded process start matches: a reused pid is another process.
    const seen = typeof owner.processStart === 'string' && owner.processStart ? startOf(owner.pid) : null;
    if (seen && seen !== owner.processStart) return { state: 'stale', directory, owner, reusedPid: true, observed };
    return { state: 'running', directory, owner, observed };
  } catch (error) { return { state: error.code === 'ENOENT' && !fs.existsSync(directory) ? 'idle' : 'unknown', directory, error: error.message, observed }; }
}
export function acquireDeveloperLock({ brainHome, token = process.env.RUVNET_DEVELOPER_UPDATE_TOKEN, pid = process.pid, alive, startOf = processStartOf, now = Date.now(), afterTakeoverClaim = null } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const status = sharedLockStatus({ brainHome, alive, startOf });
    if (token && status.state === 'running' && status.owner.token === token) return { token, ownerPid: status.owner.pid, inherited: true, release() {} };
    // A dead owner's lock must not wedge every future update (measured 2026-10-15: a coordinator killed mid-run left `stale`
    // behind and the automatic updater refused until a person removed the directory). Reclaimable: a provably dead or reused-pid
    // owner, or a directory with no readable owner (a kill between mkdir and the owner write), once STALE_RECLAIM_MS old by its
    // recorded start or, failing that, the directory's own mtime. The takeover is claimed and re-checked (above), then the
    // normal atomic mkdir claim follows. A live owner, or anything younger, still refuses.
    let ageMs = NaN;
    if (status.state === 'stale' || status.state === 'unknown') {
      ageMs = now - Date.parse(status.owner?.startedAt || '');
      if (!Number.isFinite(ageMs)) try { ageMs = now - fs.lstatSync(status.directory).mtimeMs; } catch { ageMs = NaN; }
    }
    const refuse = state => Error(`developer update lock ${state}; ${status.directory}. If no update is running on this machine, remove it: ${removal(status.directory)}`);
    if ((status.state === 'stale' || status.state === 'unknown') && Number.isFinite(ageMs) && ageMs >= STALE_RECLAIM_MS) {
      if (!status.observed) throw refuse(status.state); // not a lock directory this protocol can judge (a symlink or a file)
      const outcome = removeObservedLock(status.directory, status.observed, { afterClaim: afterTakeoverClaim });
      if (outcome === 'busy') throw refuse('is being reclaimed by another process');
      continue; // 'removed' or 'changed': judge the directory afresh
    } else if (status.state !== 'idle') throw refuse(status.state);
    fs.mkdirSync(path.dirname(status.directory), { recursive: true });
    try { fs.mkdirSync(status.directory, { mode: 0o700 }); } // atomic claim; racing owners get EEXIST
    catch (error) { if (error.code === 'EEXIST') continue; throw error; }
    const owner = { pid, token: crypto.randomUUID(), startedAt: new Date().toISOString(), processStart: startOf(pid) };
    const file = path.join(status.directory, 'owner.json');
    try { publishOwner(file, JSON.stringify(owner)); }
    catch (error) {
      if (error.code === 'EEXIST') throw refuse('running'); // another process published into this directory first: it is the owner
      try { fs.rmdirSync(status.directory); } catch { /* not empty: no longer only ours */ }
      throw error;
    }
    return { token: owner.token, ownerPid: pid, inherited: false, release() {
      const current = sharedLockStatus({ brainHome, alive, startOf });
      if (current.owner?.token !== owner.token || current.owner?.pid !== pid) throw Error('developer update lock ownership changed');
      fs.unlinkSync(file);
      try { fs.rmdirSync(status.directory); }
      catch (error) { // a contender's claim file can sit here for an instant; the directory is still this owner's to dispose of
        if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') throw error;
        const tomb = `${status.directory}.released-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
        fs.renameSync(status.directory, tomb); fs.rmSync(tomb, { recursive: true, force: true });
      }
    } };
  }
  throw Error(`developer update lock is contended; ${path.join(brainRoot(brainHome), 'developer-update.lock')}. Retry shortly.`);
}
