// WP-B2 (4.7.21, AuditC #9): the developer lock wedged forever on an empty or invalid owner.json ("lock unknown") and
// treated any live process holding a reused pid as the owner. Reclaim is bounded: only an owner that is provably gone
// (dead pid, or a live pid whose process start differs from the recorded one) or unreadable, and only once it is
// STALE_RECLAIM_MS old. Every refusal names the directory and the exact removal command.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireDeveloperLock, sharedLockStatus, processStartOf, STALE_RECLAIM_MS } from '../../plugin/scripts/developer-update-lock.mjs';

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
