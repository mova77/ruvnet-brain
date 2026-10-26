// Runs the REAL `run:` block of .github/workflows/ntfy-alerts.yml under `bash -e` (GitHub's default shell for a
// run step) with curl and gh stubbed on PATH, over an event matrix. A page = one curl invocation.
// The rule under test (4.7.21): page a first red, never a repeat red; never a pull_request-event run; never a star;
// never a reopened issue/PR; and if the previous-run lookup fails, page anyway.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const WORKFLOW = fs.readFileSync(new URL('../../.github/workflows/ntfy-alerts.yml', import.meta.url), 'utf8');
const hasJq = process.platform !== 'win32' && spawnSync('jq', ['--version']).status === 0;

/** The send step's env keys and its run block, read from the YAML as GitHub would see them. */
function sendStep() {
  const lines = WORKFLOW.split('\n');
  const start = lines.findIndex((l) => /^ {6}- name: send$/.test(l));
  const env = []; let run = null;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {8}env:$/.test(lines[i])) {
      for (i++; i < lines.length && /^ {10}\S/.test(lines[i]); i++) env.push(lines[i].trim().split(':')[0]);
      i--; continue;
    }
    if (/^ {8}run: \|$/.test(lines[i])) {
      const body = [];
      for (i++; i < lines.length && (lines[i] === '' || /^ {10}/.test(lines[i])); i++) body.push(lines[i].slice(10));
      run = body.join('\n'); break;
    }
  }
  return { env, run };
}
const { env: ENV_KEYS, run: RUN } = sendStep();
// Pre-4.7.21 the block interpolated `${{ github.event_name }}`; translate that one expression so the same matrix
// runs against the old file (fail-before evidence). The new file must contain no interpolation at all.
const SCRIPT = RUN.replaceAll('${{ github.event_name }}', '${EVENT}');

let work;
beforeAll(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-ntfy-filter-'));
  fs.mkdirSync(path.join(work, 'bin'));
  fs.writeFileSync(path.join(work, 'send.sh'), SCRIPT);
  // curl: record the invocation, deliver nothing.
  fs.writeFileSync(path.join(work, 'bin', 'curl'), '#!/bin/bash\nprintf "%s\\n" "$*" >> "$STUB_LOG/curl.log"\nexit 0\n', { mode: 0o755 });
  // gh: record the invocation, then answer from STUB_GH_RESPONSE (a file) or fail like an API/auth error.
  fs.writeFileSync(path.join(work, 'bin', 'gh'), [
    '#!/bin/bash', 'printf "%s\\n" "$*" >> "$STUB_LOG/gh.log"',
    'if [ "$STUB_GH_MODE" = fail ]; then echo \'{"message":"Bad credentials","status":"401"}\'; echo "gh: Bad credentials (HTTP 401)" >&2; exit 1; fi',
    'cat "$STUB_GH_RESPONSE"', ''].join('\n'), { mode: 0o755 });
});
afterAll(() => { if (work) fs.rmSync(work, { recursive: true, force: true }); });

const run = (id, run_number, conclusion) => ({ id, run_number, conclusion, status: 'completed' });
const CURRENT = { WR_ID: '9000', WR_RUN_NUMBER: '90' };
const red = (over = {}) => ({ EVENT: 'workflow_run', WR_CONC: 'failure', WR_NAME: 'learning-replay', WR_BRANCH: 'main',
  WR_URL: 'https://github.com/stuinfla/ruvnet-brain/actions/runs/9000', WR_EVENT: 'schedule', WR_WORKFLOW_ID: '777',
  REPO: 'stuinfla/ruvnet-brain', ...CURRENT, ...over });

let n = 0;
function send(vars, { history = null, ghMode = 'ok' } = {}) {
  const log = fs.mkdtempSync(path.join(work, `case-${n++}-`));
  const response = path.join(log, 'runs.json');
  fs.writeFileSync(response, history === null ? '' : JSON.stringify({ total_count: history.length, workflow_runs: history }));
  const result = spawnSync('bash', ['-e', path.join(work, 'send.sh')], { encoding: 'utf8', timeout: 20_000,
    env: { PATH: `${path.join(work, 'bin')}${path.delimiter}${process.env.PATH}`, HOME: work, TOPIC: 'test-topic-not-real',
      STUB_LOG: log, STUB_GH_RESPONSE: response, STUB_GH_MODE: ghMode, ...vars } });
  const read = (f) => fs.existsSync(path.join(log, f)) ? fs.readFileSync(path.join(log, f), 'utf8').trim().split('\n').filter(Boolean) : [];
  return { status: result.status, stderr: result.stderr, pages: read('curl.log'), gh: read('gh.log') };
}

describe.skipIf(!hasJq)('ntfy-alerts send step', () => {
  it('reads every variable it uses from the step env, with no ${{ }} interpolation inside run:', () => {
    expect(RUN).not.toContain('${{');
    const assigned = new Set([...RUN.matchAll(/(?:^|\s|;)([A-Z][A-Z0-9_]*)=/g)].map((m) => m[1]));
    const used = new Set([...RUN.matchAll(/\$\{?([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]));
    const undeclared = [...used].filter((v) => !assigned.has(v) && !ENV_KEYS.includes(v));
    expect(undeclared).toEqual([]);
    for (const key of ['GH_TOKEN', 'REPO', 'WR_ID', 'WR_RUN_NUMBER', 'WR_WORKFLOW_ID', 'EVENT']) expect(ENV_KEYS).toContain(key);
  });

  it('triggers: no stars, no reopened; the token can read run history and nothing else', () => {
    expect(WORKFLOW).not.toMatch(/^ {2}watch:/m);
    expect(WORKFLOW).not.toMatch(/types: \[[^\]]*reopened/);
    expect(WORKFLOW.match(/^ {4}types: \[opened\]$/gm)).toHaveLength(2);
    expect(WORKFLOW).toMatch(/^permissions:\n {2}actions: read\n/m);
    expect(WORKFLOW).not.toMatch(/: write\b/);
    expect(WORKFLOW).toMatch(/timeout-minutes: 5\n/);
  });

  it('a first red on main pages exactly once, after looking up the same workflow, branch and event', () => {
    const r = send(red(), { history: [run(9000, 90, 'failure'), run(8999, 89, 'success'), run(8998, 88, 'failure')] });
    expect(r.status, r.stderr).toBe(0);
    expect(r.pages).toHaveLength(1);
    expect(r.pages[0]).toContain('Title: 🔴 CI failure: learning-replay');
    expect(r.pages[0]).toContain('https://ntfy.sh/test-topic-not-real');
    expect(r.pages[0]).not.toContain('lookup failed');
    expect(r.gh).toEqual(['api -X GET repos/stuinfla/ruvnet-brain/actions/workflows/777/runs -f branch=main -f event=schedule -f status=completed -f per_page=10']);
  });

  it('a repeat red (previous completed run also red) does not page', () => {
    for (const prior of ['failure', 'timed_out', 'startup_failure']) {
      const r = send(red(), { history: [run(9000, 90, 'failure'), run(8999, 89, prior), run(8998, 88, 'success')] });
      expect(r.status, `${prior}: ${r.stderr}`).toBe(0);
      expect(r.pages, prior).toHaveLength(0);
    }
  });

  it('cancelled and skipped runs are passed over when finding the previous result', () => {
    const history = [run(9000, 90, 'failure'), run(8999, 89, 'cancelled'), run(8997, 88, 'skipped'), run(8996, 87, 'failure')];
    expect(send(red(), { history }).pages).toHaveLength(0);
    const recovered = [run(9000, 90, 'failure'), run(8999, 89, 'cancelled'), run(8996, 87, 'success')];
    expect(send(red(), { history: recovered }).pages).toHaveLength(1);
  });

  it('a newer run listed above the current one is not mistaken for the previous run', () => {
    const history = [run(9100, 91, 'failure'), run(9000, 90, 'failure'), run(8999, 89, 'success')];
    expect(send(red(), { history }).pages).toHaveLength(1);
  });

  it('the very first run of a workflow pages', () => {
    expect(send(red(), { history: [run(9000, 90, 'failure')] }).pages).toHaveLength(1);
    expect(send(red(), { history: [] }).pages).toHaveLength(1);
  });

  it('a failed or malformed lookup pages (fail loud), and says so in the body', () => {
    for (const [label, opts] of [['gh 401', { ghMode: 'fail' }], ['empty body', { history: null }]]) {
      const r = send(red(), opts);
      expect(r.status, `${label}: ${r.stderr}`).toBe(0);
      expect(r.pages, label).toHaveLength(1);
      expect(r.pages[0], label).toContain('(previous-run lookup failed)');
    }
    const noNumber = send(red({ WR_RUN_NUMBER: '' }), { history: [run(9000, 90, 'failure'), run(8999, 89, 'failure')] });
    expect(noNumber.pages).toHaveLength(1);
  });

  it('a pull_request-event run never pages, even on release/*', () => {
    const r = send(red({ WR_EVENT: 'pull_request', WR_BRANCH: 'release/4.7.21', WR_NAME: 'integration-linux' }),
      { history: [run(9000, 90, 'failure'), run(8999, 89, 'success')] });
    expect(r.pages).toHaveLength(0);
    expect(r.gh).toHaveLength(0);
  });

  it('a first red on a release/* push and on a scheduled job pages; a working-branch push does not', () => {
    const fresh = { history: [run(9000, 90, 'failure'), run(8999, 89, 'success')] };
    expect(send(red({ WR_EVENT: 'push', WR_BRANCH: 'release/4.7.21', WR_NAME: 'release-candidate-preflight' }), fresh).pages).toHaveLength(1);
    expect(send(red({ WR_EVENT: 'schedule', WR_BRANCH: 'dream/x' }), fresh).pages).toHaveLength(1);
    expect(send(red({ WR_EVENT: 'push', WR_BRANCH: 'fix/thing' }), fresh).pages).toHaveLength(0);
  });

  it('green, cancelled and skipped runs never page or look anything up', () => {
    for (const conclusion of ['success', 'cancelled', 'skipped', 'neutral', 'action_required', 'stale']) {
      const r = send(red({ WR_CONC: conclusion }), { history: [] });
      expect(r.pages, conclusion).toHaveLength(0);
      expect(r.gh, conclusion).toHaveLength(0);
    }
  });

  it('a star does not page', () => {
    expect(send({ EVENT: 'watch', SENDER: 'someone' }).pages).toHaveLength(0);
  });

  it("a person's new issue or PR pages once; the owner's and bots' do not", () => {
    const marker = path.join(work, 'injected');
    const issue = send({ EVENT: 'issues', ISSUE_NUM: '501', ISSUE_TITLE: `Search broke; $(touch ${marker})`, ISSUE_USER: 'alice', ISSUE_USER_TYPE: 'User' });
    expect(issue.pages).toHaveLength(1);
    expect(issue.pages[0]).toContain('Title: 🐛 New issue #501');
    expect(issue.pages[0]).toContain(`Search broke; $(touch ${marker}) — by alice`);
    expect(fs.existsSync(marker)).toBe(false);
    expect(send({ EVENT: 'pull_request_target', PR_NUM: '7', PR_TITLE: 'fix', PR_USER: 'bob', PR_USER_TYPE: 'User' }).pages).toHaveLength(1);
    expect(send({ EVENT: 'issues', ISSUE_NUM: '1', ISSUE_TITLE: 't', ISSUE_USER: 'stuinfla', ISSUE_USER_TYPE: 'User' }).pages).toHaveLength(0);
    expect(send({ EVENT: 'pull_request_target', PR_NUM: '2', PR_TITLE: 't', PR_USER: 'dependabot[bot]', PR_USER_TYPE: 'Bot' }).pages).toHaveLength(0);
  });

  it('an empty topic sends nothing', () => {
    expect(send({ ...red(), TOPIC: '' }, { history: [] }).pages).toHaveLength(0);
  });
});
