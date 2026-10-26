/**
 * The Stable Spine lock under two concurrent reclaimers (4.7.21 review, Codex #1 applied to update-apply.mjs).
 *
 * The old quarantine path judged the lock, then moved LOCK aside and compared what it moved with what it judged. For
 * an owner-less lock both read `null`, and another run's directory between its mkdir and its owner write also reads
 * `null`: B moved A's brand-new lock away as "the same debris", took the lock, and A then wrote its owner into B's
 * directory. Both runs applied. Two real threads drive that exact interleaving through barriers; exactly one may own
 * the lock. A takeover now holds an exclusive claim and re-checks the directory identity before moving anything.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ENGINE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugin', 'scripts', 'update-apply.mjs');
const homes = [];
afterEach(() => homes.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

// Slots: 0 = B paused before moving the lock aside, 1 = release B, 2 = A paused before writing its owner, 3 = release A.
const WORKER = `
const { workerData, parentPort } = require('node:worker_threads');
const fs = require('node:fs');
const flags = new Int32Array(workerData.sab);
const lock = workerData.lock;
const pause = (reached, release) => { Atomics.store(flags, reached, 1); Atomics.notify(flags, reached); Atomics.wait(flags, release, 0, 15000); };
if (workerData.role === 'B') {
  const real = fs.renameSync; let fired = false;
  fs.renameSync = function (from, to) {
    if (!fired && from === lock && String(to).startsWith(lock + '.stale-')) { fired = true; pause(0, 1); }
    return real.apply(this, arguments);
  };
} else {
  const real = fs.writeFileSync; let fired = false;
  fs.writeFileSync = function (file) {
    if (!fired && String(file).startsWith(lock + require('node:path').sep + 'owner.json.tmp')) { fired = true; pause(2, 3); }
    return real.apply(this, arguments);
  };
}
import(workerData.module).then((m) => parentPort.postMessage({ acquired: Boolean(m.acquireLock('race-' + workerData.role).acquired) }),
  (error) => parentPort.postMessage({ error: String(error && error.stack || error) }));
`;

const waitFor = async (predicate, ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the interleaving');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe('update-apply lock: two reclaimers of one owner-less lock', () => {
  it('B judged the debris, A reclaimed it and is mid-publish when B moves the lock: exactly one run owns it', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-race-'));
    homes.push(home);
    const lock = path.join(home, '.update.lock');
    fs.mkdirSync(lock); // a run killed between mkdir and its owner write, 5 minutes ago
    const old = new Date(Date.now() - 5 * 60_000);
    fs.utimesSync(lock, old, old);
    const sab = new SharedArrayBuffer(16);
    const flags = new Int32Array(sab);
    const env = { ...process.env, RUVNET_BRAIN_HOME: home, RUVNET_BRAIN_IMPORT_ONLY: 'update-shell-test' };
    const start = (role) => {
      const worker = new Worker(WORKER, { eval: true, env, workerData: { role, sab, lock, module: pathToFileURL(ENGINE).href } });
      const result = { done: false, value: null };
      worker.once('message', (value) => { result.value = value; result.done = true; });
      worker.once('error', (error) => { result.value = { error: String(error) }; result.done = true; });
      return result;
    };
    const b = start('B');
    await waitFor(() => Atomics.load(flags, 0) === 1 || b.done);
    const a = start('A');
    await waitFor(() => Atomics.load(flags, 2) === 1 || a.done);
    Atomics.store(flags, 1, 1); Atomics.notify(flags, 1);
    await waitFor(() => b.done);
    Atomics.store(flags, 3, 1); Atomics.notify(flags, 3);
    await waitFor(() => a.done);
    expect(a.value.error, a.value.error).toBeUndefined();
    expect(b.value.error, b.value.error).toBeUndefined();
    const owners = [a.value, b.value].filter((value) => value.acquired);
    expect(owners, JSON.stringify({ a: a.value, b: b.value })).toHaveLength(1); // before: both acquired
    const owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'));
    expect(owner.target).toBe(a.value.acquired ? 'race-A' : 'race-B');
  }, 40_000);
});
