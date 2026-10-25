// ntfy-inbox.test.mjs — Claude reads the owner's ntfy channel (2026-10-25). Classification, grouping of repeats,
// self-closing when the cause clears, and the responder's bounds (off unless enabled, one run at a time, daily cap).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let dir, mod;
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntfy-inbox-'));
  vi.stubEnv('RUVNET_NTFY_INBOX_DIR', dir); vi.stubEnv('HOME', dir); vi.stubEnv('NTFY_TOPIC', 'fixture-topic');
  vi.resetModules();
  mod = await import('../../scripts/ntfy-inbox.mjs');
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(dir, { recursive: true, force: true }); });
const msg = (id, title, t = 1_792_900_000, message = '') => ({ id, event: 'message', time: t, title, message });

describe('classify', () => {
  it('names what each alert is about', () => {
    expect(mod.classify(msg('a', '🔴 SCHEDULED JOB FAILED: com.ruvnet.model-refresh'))).toMatchObject({ kind: 'job', key: 'job:com.ruvnet.model-refresh', actionable: true });
    expect(mod.classify(msg('b', '✅ Recovered: com.ruvnet.model-refresh'))).toMatchObject({ resolves: true, key: 'job:com.ruvnet.model-refresh' });
    expect(mod.classify(msg('c', '🔴 CI failure: learning-replay'))).toMatchObject({ kind: 'ci', workflow: 'learning-replay' });
    expect(mod.classify(msg('d', 'SLA breach: issue #301'))).toMatchObject({ kind: 'issue', number: 301 });
    expect(mod.classify(msg('e', 'New issue #301 (open 1h 0m)')).key).toBe('issue:301');
    expect(mod.classify(msg('f', 'Waiting on a reply: 2 contributor issues')).actionable).toBe(false);
    expect(mod.classify(msg('g', '⭐ New star')).actionable).toBe(false);
  });
});

describe('fold', () => {
  const never = () => false;
  it('groups repeats of one cause into one alert with a count', () => {
    const open = mod.fold([], [msg('1', 'SLA breach: issue #301'), msg('2', 'New issue #301 (open 5h)'), msg('3', 'SLA breach: issue #301')], { resolver: never });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ key: 'issue:301', count: 3, id: '1' });
  });
  it('a "recovered" notice closes its job alert; a cleared cause closes on its own', () => {
    let open = mod.fold([], [msg('1', '🔴 SCHEDULED JOB FAILED: com.x'), msg('2', '🔴 CI failure: integration-linux')], { resolver: never });
    open = mod.fold(open, [msg('3', '✅ Recovered: com.x')], { resolver: never });
    expect(open.find((a) => a.key === 'job:com.x').closedBy).toBe('recovered notice');
    open = mod.fold(open, [], { resolver: (a) => a.kind === 'ci' });
    expect(open.find((a) => a.kind === 'ci').closedBy).toBe('cause cleared');
  });
  it('a new failure after a closed alert opens a fresh one', () => {
    let open = mod.fold([], [msg('1', '🔴 SCHEDULED JOB FAILED: com.x')], { resolver: never });
    open = mod.fold(open, [msg('2', '✅ Recovered: com.x')], { resolver: never });
    open = mod.fold(open.filter((a) => !a.closedAt), [msg('3', '🔴 SCHEDULED JOB FAILED: com.x')], { resolver: never });
    expect(open.filter((a) => !a.closedAt)).toHaveLength(1);
    expect(open.find((a) => !a.closedAt).id).toBe('3');
  });
});

describe('responder bounds', () => {
  const alert = { id: 'a1', kind: 'job', title: 'SCHEDULED JOB FAILED: com.x', body: 'exit 1' };
  const cfg = (value) => { fs.mkdirSync(path.join(dir, '.config', 'ruvnet-brain'), { recursive: true }); fs.writeFileSync(path.join(dir, '.config', 'ruvnet-brain', 'ntfy-responder.json'), JSON.stringify(value)); };
  it('does nothing unless enabled', () => {
    const launcher = vi.fn();
    expect(mod.maybeRespond([alert], { launcher })).toMatchObject({ started: false, why: 'responder off' });
    expect(launcher).not.toHaveBeenCalled();
  });
  it('one run at a time, and at most maxRunsPerDay', () => {
    cfg({ enabled: true, maxRunsPerDay: 2 });
    const launcher = vi.fn(() => 999_999_999); // a pid that is not alive
    const now = Date.parse('2026-10-25T12:00:00Z');
    expect(mod.maybeRespond([alert], { launcher, now }).started).toBe(true);
    expect(mod.maybeRespond([alert], { launcher, now: now + 1 }).started).toBe(true);
    expect(mod.maybeRespond([alert], { launcher, now: now + 2 })).toMatchObject({ started: false, why: 'daily cap reached' });
    const live = vi.fn(() => process.pid); // this process: alive
    expect(mod.maybeRespond([alert], { launcher: live, now: now + 86_400_000 }).started).toBe(true);
    expect(mod.maybeRespond([alert], { launcher: live, now: now + 86_400_001 }).why).toMatch(/still running/);
  });
  it('the responder never carries an API key (subscription only) and finds approved tools first', () => {
    const env = mod.responderEnv({ ANTHROPIC_API_KEY: 'k1', CLAUDE_API_KEY: 'k2', ANTHROPIC_AUTH_TOKEN: 'k3', KEEP: 'x', PATH: '/opt/homebrew/bin' });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined(); expect(env.CLAUDE_API_KEY).toBeUndefined(); expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.KEEP).toBe('x');
    const parts = env.PATH.split(':');
    expect(parts[0]).toMatch(/job-bin$/);
    expect(parts.indexOf('/usr/bin')).toBeLessThan(parts.indexOf('/opt/homebrew/bin'));
    expect(env.JOB_MAX_SECONDS).toBe('10800');
  });
  it('the prompt names each alert id and the release rules', () => {
    const p = mod.responderPrompt([alert]);
    expect(p).toContain('alert id: a1');
    expect(p).toContain('CONTRIBUTING.md');
    expect(p).toMatch(/Never touch \/Users\/stuartkerr\/Code\/ruvnet-brain/);
  });
});
