// scripts/issue-autofix-diff.mjs — what the build stage changed, and whether its new test is a real test.
// The orchestrator never takes the builder's word for either: it reads the diff from git itself (S4) and measures
// the new test against origin/main WITHOUT the fix and against the worktree WITH it (spec §4 "Test validity").
import fs from 'node:fs';
import path from 'node:path';
import { AutofixAbort, judgeDiff, judgeTestValidity } from './issue-autofix-policy.mjs';
import { parseUnifiedDiff } from './issue-autofix-release-util.mjs';

const GIT_DIFF = ['diff', '--no-color', '--no-ext-diff', '--no-renames'];
const SAFE_TEST_PATH = /^[\w./-]+$/;

/** The working-tree diff against the commit the worktree was cut from (untracked files included via intent-to-add). */
export function collectDiff(exec, wt, gitBin = 'git') {
  const g = (...a) => exec(gitBin, ['-C', wt, ...a]);
  const head = g('rev-parse', 'HEAD');
  if (head.status !== 0) throw new AutofixAbort('S4', 'diff-policy', 'cannot read the worktree HEAD');
  const add = g('add', '-A', '-N');
  if (add.status !== 0) throw new AutofixAbort('S4', 'diff-policy', `git add -N failed: ${add.stderr.slice(-300)}`);
  const u0 = g(...GIT_DIFF, '-U0', 'HEAD');
  const full = g(...GIT_DIFF, 'HEAD');
  if (u0.status !== 0 || full.status !== 0) throw new AutofixAbort('S4', 'diff-policy', 'git diff failed');
  const files = parseUnifiedDiff(u0.stdout);
  return { base: head.stdout.trim(), files, text: full.stdout,
    changedLines: files.reduce((n, f) => n + f.added.length + f.removed.length, 0) };
}

/** judgeDiff, mapped to the abort code the receipt and page use. */
export function assertDiffAllowed(diff, governed0103) {
  if (diff.files.length === 0) throw new AutofixAbort('S4', 'diff-policy', 'the build stage changed nothing');
  const verdict = judgeDiff({ files: diff.files, governed0103 });
  if (!verdict.ok) {
    const v = verdict.violations[0];
    const code = { 'test-weakened': 'test-weakened', 'protected-path': 'protected-path', 'not-editable': 'not-editable' }[v.rule] || 'diff-policy';
    throw new AutofixAbort('S4', code, verdict.violations.map((x) => `${x.rule} ${x.path}: ${x.detail}`).join('; ').slice(0, 800));
  }
  return verdict;
}

function parseVitestJson(stdout) {
  const i = stdout.indexOf('{'); const j = stdout.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  try { return JSON.parse(stdout.slice(i, j + 1)); } catch { return null; }
}

/**
 * `vitest run <files>` in `cwd`, ALWAYS through the sandbox runner (issue-autofix-sandbox.mjs): the files were written
 * by a model from a stranger's issue. vitest is started from the worktree's own node_modules entry, never through npx,
 * so nothing is resolved from the network. Returns the exit code, the failing tests ("<file> > <title>") and the output.
 */
export function runVitest(runSandboxed, cwd, files) {
  if (typeof runSandboxed !== 'function') throw new AutofixAbort('S4', 'sandbox-unavailable', 'no sandbox runner');
  if (!files.length || !files.every((f) => SAFE_TEST_PATH.test(f) && !f.startsWith('-') && !f.split('/').includes('..'))) {
    throw new AutofixAbort('S4', 'test-validity', `unsafe test path in ${JSON.stringify(files)}`);
  }
  const r = runSandboxed(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--reporter=json', ...files], { cwd, timeoutMs: 20 * 60_000 });
  const out = `${r.stdout}${r.stderr}`;
  const json = parseVitestJson(r.stdout);
  const failedTests = [];
  for (const tr of json?.testResults || []) {
    const file = files.find((f) => String(tr.name).endsWith(`/${f}`) || tr.name === f) || tr.name;
    for (const a of tr.assertionResults || []) if (a.status === 'failed') failedTests.push(`${file} > ${a.fullName || a.title}`);
  }
  return { exitCode: r.timedOut ? 124 : r.status, failedTests, output: out.slice(-6000) };
}

const linkModules = (from, to) => {
  if (from && fs.existsSync(from) && !fs.existsSync(path.join(to, 'node_modules'))) fs.symlinkSync(from, path.join(to, 'node_modules'));
};
export { linkModules };

/**
 * The new tests must FAIL on unfixed code and PASS on the fix. `scratch` is a detached worktree at the base commit
 * onto which only the test files are copied.
 */
export function measureTestValidity(exec, { wt, scratch, diff, newTests, nodeModules, gitBin = 'git', runSandboxed }) {
  const present = newTests.map((t) => t.replace(/^(\.\/)+/, '')).filter((t) => diff.files.some((f) => f.path === t));
  if (present.length === 0) return { verdict: judgeTestValidity({ newTests: [] }), before: null, after: null, newTests: [] };
  const head = exec(gitBin, ['-C', wt, 'rev-parse', 'HEAD']);
  const mk = exec(gitBin, ['-C', wt, 'worktree', 'add', '--detach', scratch, head.stdout.trim()]);
  if (mk.status !== 0) throw new AutofixAbort('S4', 'test-validity', `cannot create the scratch worktree: ${mk.stderr.slice(-300)}`);
  // The scratch checkout is left in place (it holds only copied test files): nothing is force-removed, and a
  // directory the job did not finish with is evidence, not litter.
  for (const f of diff.files.filter((x) => x.status !== 'D' && /(^|\/)tests?\/|\.(test|spec)\.[cm]?[jt]sx?$/i.test(x.path))) {
    fs.mkdirSync(path.dirname(path.join(scratch, f.path)), { recursive: true });
    fs.copyFileSync(path.join(wt, f.path), path.join(scratch, f.path));
  }
  linkModules(nodeModules, scratch);
  const before = runVitest(runSandboxed, scratch, present);
  const after = runVitest(runSandboxed, wt, present);
  return { verdict: judgeTestValidity({ before, after, newTests: present }), before, after, newTests: present };
}
