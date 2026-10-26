// WP-B2 (4.7.21, AuditC #9): the developer lock wedged forever on an empty or invalid owner.json ("lock unknown") and
// treated any live process holding a reused pid as the owner. Reclaim is bounded: only an owner that is provably gone
// (dead pid, or a live pid whose process start differs from the recorded one) or unreadable, and only once it is
// STALE_RECLAIM_MS old. Every refusal names the directory and the exact removal command.
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireDeveloperLock, sharedLockStatus, processStartOf, STALE_RECLAIM_MS, CLAIM_STALE_MS } from '../../plugin/scripts/developer-update-lock.mjs';

const roots = [];
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });
const brain = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dul-'))); roots.push(d); return d; };
const lockDir = brainHome => path.join(brainHome, 'developer-update.lock');
const ageDir = (dir, ms) => { const t = (Date.now() - ms) / 1000; fs.utimesSync(dir, t, t); };
const token = 't'.repeat(32);

describe('developer update lock reclaim', () => {
  it('pins the reclaim window at ten minutes', () => expect(STALE_RECLAIM_MS).toBe(600_000));

  it('an empty lock directory 11 minutes old is reclaimed and acquired', () => {
    const brainHome = brain(), dir = lockDir(brainHome);
    fs.mkdirSync(dir); ageDir(dir, 11 * 60_000);
    expect(sharedLockStatus({ brainHome }).state).toBe('unknown');
    const lock = acquireDeveloperLock({ brainHome });
    expect(lock.inherited).toBe(false);
    expect(sharedLockStatus({ brainHome })).toMatchObject({ state: 'running', owner: { pid: process.pid, token: lock.token } });
    lock.release();
    expect(sharedLockStatus({ brainHome }).state).toBe('idle');
  });

  it('an empty lock directory 2 minutes old is refused, naming the path and the removal command', () => {
    const brainHome = brain(), dir = lockDir(brainHome);
    fs.mkdirSync(dir); ageDir(dir, 2 * 60_000);
    let message = '';
    try { acquireDeveloperLock({ brainHome }); } catch (error) { message = error.message; }
    expect(message).toMatch(/^developer update lock unknown; /);
    expect(message).toContain(dir);
    expect(message).toContain(process.platform === 'win32' ? `Remove-Item -Recurse -Force "${dir}"` : `rm -rf "${dir}"`);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('an invalid owner.json is judged by the directory age the same way', () => {
    const brainHome = brain(), dir = lockDir(brainHome);
    fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'owner.json'), '');
    ageDir(dir, 3 * 60_000);
    expect(() => acquireDeveloperLock({ brainHome })).toThrow(/lock unknown/);
    ageDir(dir, 20 * 60_000);
    acquireDeveloperLock({ brainHome }).release();
  });

  it('a dead owner without startedAt is reclaimed by the directory mtime, and refused while it is young', () => {
    const brainHome = brain(), dir = lockDir(brainHome);
    fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: 4242, token }));
    ageDir(dir, 60_000);
    expect(() => acquireDeveloperLock({ brainHome, alive: () => false })).toThrow(/lock stale/);
    ageDir(dir, 20 * 60_000);
    acquireDeveloperLock({ brainHome, alive: () => false }).release();
  });

  it('a live pid whose process start differs from the recorded one is a reused pid: reclaimed', () => {
    const brainHome = brain(), dir = lockDir(brainHome);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: 4242, token, startedAt: new Date(Date.now() - 11 * 60_000).toISOString(), processStart: 'Mon Jan  1 00:00:00 2001' }));
    const status = sharedLockStatus({ brainHome, alive: () => true, startOf: () => 'Sun Oct 26 00:15:00 2026' });
    expect(status).toMatchObject({ state: 'stale', reusedPid: true });
    const lock = acquireDeveloperLock({ brainHome, alive: () => true, startOf: () => 'Sun Oct 26 00:15:00 2026' });
    expect(lock.inherited).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8'))).toMatchObject({ pid: process.pid, token: lock.token, processStart: 'Sun Oct 26 00:15:00 2026' });
  });

  it('a live pid with the matching process start is the owner: refused as running', () => {
    const brainHome = brain(), dir = lockDir(brainHome);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: 4242, token, startedAt: new Date(Date.now() - 60 * 60_000).toISOString(), processStart: 'Sun Oct 26 00:15:00 2026' }));
    expect(() => acquireDeveloperLock({ brainHome, alive: () => true, startOf: () => 'Sun Oct 26 00:15:00 2026' })).toThrow(/lock running; .*rm -rf|lock running; .*Remove-Item/);
  });

  it.skipIf(process.platform === 'win32')('records the real process start, and the real ps reading of this process matches it', () => {
    const brainHome = brain();
    const start = processStartOf(process.pid);
    expect(start).toMatch(/\d{2}:\d{2}:\d{2}/);
    const lock = acquireDeveloperLock({ brainHome });
    const owner = JSON.parse(fs.readFileSync(path.join(lockDir(brainHome), 'owner.json'), 'utf8'));
    expect(owner.processStart).toBe(start);
    expect(fs.existsSync(path.join(lockDir(brainHome), 'owner.json.tmp'))).toBe(false);
    expect(sharedLockStatus({ brainHome }).state).toBe('running');
    lock.release();
  });
});

// 4.7.21 review (Codex #1): two contenders judged the same abandoned lock; A reclaimed and acquired, then B moved A's
// FRESH lock aside on its stale judgement and both ran. Takeover is now claimed inside the judged directory and
// re-checked (dev/ino + owner bytes) before the move; owner.json is published with an exclusive link.
describe('developer update lock: concurrent reclaimers', () => {
  const MODULE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugin', 'scripts', 'developer-update-lock.mjs');
  const ownerOf = brainHome => JSON.parse(fs.readFileSync(path.join(lockDir(brainHome), 'owner.json'), 'utf8'));
  const plantDead = brainHome => {
    const dir = lockDir(brainHome);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: 4242, token, startedAt: new Date(Date.now() - 11 * 60_000).toISOString() }));
    ageDir(dir, 11 * 60_000);
  };
  const notDead = pid => pid !== 4242;
  const errorOf = fn => { try { fn(); return null; } catch (error) { return error; } };

  it('B judged a dead owner, A reclaimed and acquired first: B refuses and A keeps its lock', () => {
    const brainHome = brain();
    plantDead(brainHome);
    let a = null, fired = false;
    // alive() runs right after B has read the lock: A's whole acquisition happens there.
    const bAlive = pid => { if (!fired) { fired = true; a = acquireDeveloperLock({ brainHome, alive: notDead }); } return notDead(pid); };
    const bError = errorOf(() => acquireDeveloperLock({ brainHome, alive: bAlive }));
    expect(fired).toBe(true);
    expect(a?.inherited).toBe(false);
    expect(bError?.message).toMatch(/^developer update lock running; /); // before: B took the lock too
    expect(ownerOf(brainHome).token).toBe(a.token);
    expect(fs.readdirSync(lockDir(brainHome))).toEqual(['owner.json']); // B left no claim behind
    a.release();
    expect(sharedLockStatus({ brainHome }).state).toBe('idle');
  });

  it('an empty lock: A acquires inside B\'s takeover window, and exactly one of them owns the lock', () => {
    const brainHome = brain(), dir = lockDir(brainHome);
    fs.mkdirSync(dir); ageDir(dir, 11 * 60_000);
    const realRename = fs.renameSync;
    let a = null, aError = null, fired = false;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (!fired && from === dir && String(to).startsWith(`${dir}.stale-`)) {
        fired = true;
        try { a = acquireDeveloperLock({ brainHome }); } catch (error) { aError = error; }
      }
      return realRename(from, to);
    });
    let b = null, bError = null;
    try { b = acquireDeveloperLock({ brainHome }); } catch (error) { bError = error; } finally { spy.mockRestore(); }
    expect(fired).toBe(true);
    const owners = [a, b].filter(Boolean);
    expect(owners, `A: ${aError?.message} / B: ${bError?.message}`).toHaveLength(1); // before: both owned it
    expect(ownerOf(brainHome).token).toBe(owners[0].token);
    owners[0].release();
  });

  it('an owner published into the directory between mkdir and this process\'s own write wins: no overwrite', () => {
    const brainHome = brain(), dir = lockDir(brainHome);
    const foreign = { pid: process.pid, token: 'f'.repeat(32), startedAt: new Date().toISOString(), processStart: processStartOf(process.pid) };
    const realMkdir = fs.mkdirSync;
    const spy = vi.spyOn(fs, 'mkdirSync').mockImplementation((target, options) => {
      const result = realMkdir(target, options);
      if (target === dir) fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify(foreign));
      return result;
    });
    let error = null;
    try { acquireDeveloperLock({ brainHome }); } catch (e) { error = e; } finally { spy.mockRestore(); }
    expect(error?.message).toMatch(/^developer update lock running; /); // before: the foreign owner was overwritten
    expect(ownerOf(brainHome).token).toBe(foreign.token);
  });

  it('while one reclaimer holds the claim, a second one refuses instead of racing it', () => {
    const brainHome = brain();
    plantDead(brainHome);
    let second = null;
    const a = acquireDeveloperLock({ brainHome, alive: notDead,
      afterTakeoverClaim: () => { second = errorOf(() => acquireDeveloperLock({ brainHome, alive: notDead })); } });
    expect(second?.message).toMatch(/^developer update lock is being reclaimed by another process; /);
    expect(ownerOf(brainHome).token).toBe(a.token);
    a.release();
  });

  it('a claim left by a crashed reclaimer is superseded once older than the claim window', () => {
    const brainHome = brain(), dir = lockDir(brainHome);
    plantDead(brainHome);
    const claim = path.join(dir, 'takeover.json');
    fs.writeFileSync(claim, '{}');
    expect(() => acquireDeveloperLock({ brainHome, alive: notDead })).toThrow(/being reclaimed by another process/);
    const old = (Date.now() - CLAIM_STALE_MS - 60_000) / 1000;
    fs.utimesSync(claim, old, old);
    const lock = acquireDeveloperLock({ brainHome, alive: notDead });
    expect(ownerOf(brainHome).token).toBe(lock.token);
    lock.release();
  });

  it('six processes released together on one dead lock: exactly one owns it', async () => {
    const brainHome = brain();
    plantDead(brainHome);
    const barrier = path.join(brainHome, 'go');
    const script = `
      import fs from 'node:fs';
      const m = await import(${JSON.stringify(MODULE)});
      while (!fs.existsSync(${JSON.stringify(barrier)})) { /* barrier */ }
      try {
        const lock = m.acquireDeveloperLock({ brainHome: ${JSON.stringify(brainHome)}, alive: (pid) => pid !== 4242, startOf: () => null });
        console.log('OWNED ' + lock.token);
      } catch (error) { console.log('REFUSED ' + error.message); }`;
    const children = Array.from({ length: 6 }, () => spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] }));
    const outputs = children.map(child => new Promise(resolve => {
      let out = '';
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { out += d; });
      child.on('exit', () => resolve(out.trim()));
    }));
    await new Promise(resolve => setTimeout(resolve, 400));
    fs.writeFileSync(barrier, '');
    const results = await Promise.all(outputs);
    const owned = results.filter(line => line.startsWith('OWNED '));
    expect(owned, results.join('\n')).toHaveLength(1);
    expect(results.filter(line => line.startsWith('REFUSED ')), results.join('\n')).toHaveLength(5);
    expect(ownerOf(brainHome).token).toBe(owned[0].slice('OWNED '.length));
  }, 30_000);
});
