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
export function sharedLockStatus({ brainHome, alive = pidAlive, startOf = processStartOf } = {}) {
  const directory = path.join(brainRoot(brainHome), 'developer-update.lock');
  try {
    if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) throw Error('not an owned directory');
    const owner = JSON.parse(fs.readFileSync(path.join(directory, 'owner.json'), 'utf8'));
    if (!Number.isInteger(owner.pid) || owner.pid < 1 || typeof owner.token !== 'string' || owner.token.length < 16) throw Error('invalid owner');
    if (!alive(owner.pid)) return { state: 'stale', directory, owner };
    // A live pid is the owner only when the recorded process start matches: a reused pid is another process.
    const observed = typeof owner.processStart === 'string' && owner.processStart ? startOf(owner.pid) : null;
    if (observed && observed !== owner.processStart) return { state: 'stale', directory, owner, reusedPid: true };
    return { state: 'running', directory, owner };
  } catch (error) { return { state: error.code === 'ENOENT' && !fs.existsSync(directory) ? 'idle' : 'unknown', directory, error: error.message }; }
}
export function acquireDeveloperLock({ brainHome, token = process.env.RUVNET_DEVELOPER_UPDATE_TOKEN, pid = process.pid, alive, startOf = processStartOf, now = Date.now() } = {}) {
  const status = sharedLockStatus({ brainHome, alive, startOf });
  if (token && status.state === 'running' && status.owner.token === token) return { token, ownerPid: status.owner.pid, inherited: true, release() {} };
  // A dead owner's lock must not wedge every future update (measured 2026-10-15: a coordinator killed mid-run left `stale`
  // behind and the automatic updater refused until a person removed the directory). Reclaimable: a provably dead or reused-pid
  // owner, or a directory with no readable owner (a kill between mkdir and the owner write), once STALE_RECLAIM_MS old by its
  // recorded start or, failing that, the directory's own mtime. Move it aside atomically (two reclaimers cannot both win),
  // then fall through to the normal atomic mkdir claim. A live owner, or anything younger, still refuses.
  let ageMs = NaN;
  if (status.state === 'stale' || status.state === 'unknown') {
    ageMs = now - Date.parse(status.owner?.startedAt || '');
    if (!Number.isFinite(ageMs)) try { ageMs = now - fs.lstatSync(status.directory).mtimeMs; } catch { ageMs = NaN; }
  }
  const refuse = state => Error(`developer update lock ${state}; ${status.directory}. If no update is running on this machine, remove it: ${removal(status.directory)}`);
  if ((status.state === 'stale' || status.state === 'unknown') && Number.isFinite(ageMs) && ageMs >= STALE_RECLAIM_MS) {
    const tomb = `${status.directory}.stale-${process.pid}-${Date.now()}`;
    try { fs.renameSync(status.directory, tomb); fs.rmSync(tomb, { recursive: true, force: true }); }
    catch { /* another reclaimer won, or the owner came back: re-read below */ }
    const after = sharedLockStatus({ brainHome, alive, startOf });
    if (after.state !== 'idle') throw refuse(after.state);
  } else if (status.state !== 'idle') throw refuse(status.state);
  fs.mkdirSync(path.dirname(status.directory), { recursive: true });
  fs.mkdirSync(status.directory, { mode: 0o700 }); // atomic claim; racing owners get EEXIST
  const owner = { pid, token: crypto.randomUUID(), startedAt: new Date().toISOString(), processStart: startOf(pid) };
  const file = path.join(status.directory, 'owner.json'), tmp = `${file}.tmp`;
  // Complete-or-absent: a reader never sees a half-written owner.json.
  try { fs.writeFileSync(tmp, JSON.stringify(owner), { flag: 'wx', mode: 0o600 }); fs.renameSync(tmp, file); }
  catch (error) { fs.rmSync(status.directory, { recursive: true, force: true }); throw error; }
  return { token: owner.token, ownerPid: pid, inherited: false, release() {
    const current = sharedLockStatus({ brainHome, alive, startOf });
    if (current.owner?.token !== owner.token || current.owner?.pid !== pid) throw Error('developer update lock ownership changed');
    fs.unlinkSync(file); fs.rmdirSync(status.directory);
  } };
}
