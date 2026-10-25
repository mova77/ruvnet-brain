// tests/unit/job-heartbeat-alerting.test.mjs — scripts/job-heartbeat.sh must actually PAGE on failure.
//
// THE BUG THIS ENCODES (found 2026-09-27, cause #5 of the consolidation effort): job-heartbeat.sh's
// notify() and nightly-watchdog.mjs's push() both resolve the ntfy topic as
// `$NTFY_TOPIC` env var, then `~/.cache/ruvnet-brain/ntfy-topic`. Neither launchd plist for
// com.ruvnet.issue-watch, com.ruvnet.nightly-watchdog, or com.ruvnet.npm-token-renew sets
// NTFY_TOPIC in its EnvironmentVariables, and the topic FILE did not exist on disk — so every
// "SCHEDULED JOB FAILED" alert for every wrapped job was silently swallowed (notify() returns 0,
// no error, no log) for as long as the file was missing. Three jobs failing loudly in their own
// receipts and logs, and paging NOBODY, is exactly "too much loaded, and failures go unnoticed."
//
// Fix: ~/.cache/ruvnet-brain/ntfy-topic now holds the same topic already configured in .env
// (NTFY_TOPIC=ruvnet-brain-stuart-e37a0e58) and confirmed live via a real ntfy.sh delivery during
// this fix (message id ivcb7EloTrlG, 2026-09-27T12:38:14Z).
//
// This test proves the WIRING, not the network: it stubs `curl` on PATH and points $HOME at a temp
// dir, so it never touches the real machine's topic file or fires a real push, but it asserts the
// exact condition that was broken — a failing wrapped job must attempt exactly one alert push, a
// successful one must attempt none, and with no topic configured (the pre-fix state) no push is
// attempted either, so the negative case can't be satisfied by a curl stub that always "works".
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const WRAPPER = path.join(ROOT, 'scripts', 'job-heartbeat.sh');

let workDir;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-heartbeat-test-'));
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

/** Build an isolated fake $HOME with a fake-`curl` bin directory ahead of PATH, so the wrapper's
 * alert call is captured to a log file instead of reaching the real network. */
function makeHarness({ withTopic }) {
  const home = path.join(workDir, 'home');
  const cacheDir = path.join(home, '.cache', 'ruvnet-brain');
  fs.mkdirSync(cacheDir, { recursive: true });
  if (withTopic) fs.writeFileSync(path.join(cacheDir, 'ntfy-topic'), 'test-topic-xyz');

  const binDir = path.join(workDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const curlLog = path.join(workDir, 'curl-calls.log');
  const fakeCurl = path.join(binDir, 'curl');
  // Records every invocation (one line of JSON-ish args) instead of making a network call.
  fs.writeFileSync(fakeCurl, `#!/bin/sh\necho "$@" >> "${curlLog}"\nexit 0\n`);
  fs.chmodSync(fakeCurl, 0o755);

  const hbDir = path.join(workDir, 'heartbeats');
  fs.mkdirSync(hbDir, { recursive: true });

  const script = (exitCode) => {
    const p = path.join(workDir, `child-${exitCode}.sh`);
    fs.writeFileSync(p, `#!/bin/sh\nexit ${exitCode}\n`);
    fs.chmodSync(p, 0o755);
    return p;
  };

  const run = (label, exitCode) => spawnSync('/bin/sh', [WRAPPER, label, '--', script(exitCode)], {
    encoding: 'utf8',
    env: {
      PATH: `${binDir}:/usr/bin:/bin`,
      HOME: home,
      JOB_HEARTBEAT_DIR: hbDir,
      // Explicit unset opt-out (NTFY_TOPIC="") is job-heartbeat.sh's own test convention — leaving
      // it entirely absent from env here so resolution falls through to the topic FILE, which is
      // the exact path that was broken.
    },
  });

  const curlCalls = () => (fs.existsSync(curlLog) ? fs.readFileSync(curlLog, 'utf8').trim().split('\n').filter(Boolean) : []);
  const receipt = (label) => JSON.parse(fs.readFileSync(path.join(hbDir, `${label}.json`), 'utf8'));

  return { run, curlCalls, receipt };
}

describe('job-heartbeat.sh — a failing job must actually page, not just record a receipt', () => {
  it('with a topic configured, a FAILING job fires exactly one alert push', () => {
    const { run, curlCalls, receipt } = makeHarness({ withTopic: true });
    const res = run('com.test.failing-job', 17);

    expect(res.status).toBe(17); // wrapper propagates the child's real exit code to launchd
    expect(receipt('com.test.failing-job').state).toBe('failed');
    expect(receipt('com.test.failing-job').exit_code).toBe(17);

    const calls = curlCalls();
    expect(calls.length).toBe(1); // exactly one page — not zero (the bug), not a flood
    expect(calls[0]).toContain('test-topic-xyz'); // resolved via the topic FILE fallback
    expect(calls[0]).toContain('SCHEDULED JOB FAILED: com.test.failing-job');
  });

  it('with a topic configured, a SUCCESSFUL job fires no alert', () => {
    const { run, curlCalls, receipt } = makeHarness({ withTopic: true });
    const res = run('com.test.ok-job', 0);

    expect(res.status).toBe(0);
    expect(receipt('com.test.ok-job').state).toBe('ok');
    expect(curlCalls().length).toBe(0); // success must never page
  });

  it('a job that KEEPS failing pages once, stays quiet while it fails, and sends one low "recovered" note (2026-10-25)', () => {
    const { run, curlCalls, receipt } = makeHarness({ withTopic: true });
    run('com.test.flaky', 1);
    const since = receipt('com.test.flaky').failing_since;
    expect(since).toBeTruthy();
    run('com.test.flaky', 1); run('com.test.flaky', 2);
    expect(curlCalls().length).toBe(1); // one page for the whole failing streak, not one per run
    expect(receipt('com.test.flaky').failing_since).toBe(since); // the streak keeps its first failure time
    run('com.test.flaky', 0);
    const calls = curlCalls();
    expect(calls.length).toBe(2);
    expect(calls[1]).toContain('Recovered: com.test.flaky');
    expect(calls[1]).toContain('Priority: low');
    run('com.test.flaky', 0);
    expect(curlCalls().length).toBe(2); // staying green is silent
    run('com.test.flaky', 3);
    expect(curlCalls().length).toBe(3); // a NEW streak pages again
  });

  it('a job that never exits is stopped at JOB_MAX_SECONDS and recorded as timed out (2026-10-25)', () => {
    const { curlCalls, receipt } = makeHarness({ withTopic: true });
    const hang = path.join(workDir, 'hang.sh');
    fs.writeFileSync(hang, '#!/bin/sh\nsleep 60\n'); fs.chmodSync(hang, 0o755);
    const t0 = Date.now();
    spawnSync('/bin/sh', [WRAPPER, 'com.test.hang', '--', hang], {
      encoding: 'utf8',
      env: { PATH: `${path.join(workDir, 'bin')}:/usr/bin:/bin`, HOME: path.join(workDir, 'home'), JOB_HEARTBEAT_DIR: path.join(workDir, 'heartbeats'), JOB_MAX_SECONDS: '1' },
    });
    expect(Date.now() - t0).toBeLessThan(20_000); // stopped near the limit, not after the job's 60 s
    const r = receipt('com.test.hang');
    expect(r.state).toBe('killed');
    expect(r.timed_out_after_sec).toBe(1);
    expect(curlCalls().length).toBe(1);
    expect(fs.readdirSync(path.join(workDir, 'heartbeats')).some((f) => f.includes('.timeout-'))).toBe(false);
  }, 30_000);

  it('a quick job leaves no timer behind and is not marked timed out', () => {
    const { run, receipt } = makeHarness({ withTopic: false });
    const t0 = Date.now();
    run('com.test.quick', 0);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(receipt('com.test.quick').timed_out_after_sec).toBeUndefined();
  });

  it('REGRESSION GUARD: with NO topic configured (the pre-fix state on this machine), a failing '
    + 'job still records the failure but CANNOT page — proving the missing topic file, not a code '
    + 'bug, was the entire reason three jobs failed silently', () => {
    const { run, curlCalls, receipt } = makeHarness({ withTopic: false });
    const res = run('com.test.unpageable-failure', 3);

    expect(res.status).toBe(3);
    expect(receipt('com.test.unpageable-failure').state).toBe('failed'); // the evidence exists...
    expect(curlCalls().length).toBe(0); // ...but nothing was ever going to tell anyone
  });
});
