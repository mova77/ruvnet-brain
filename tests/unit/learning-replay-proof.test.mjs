import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createReplaySource } from '../helpers/learning-replay-source.mjs';

let ROOT, HEAD, replay, source;
beforeAll(async () => {
  source = createReplaySource();
  ROOT = source.repo;
  HEAD = source.sha;
  replay = await import(pathToFileURL(path.join(ROOT, 'scripts/learning-replay.mjs')).href);
});
afterAll(() => source?.cleanup());

let dir;
beforeEach(() => {
  fs.mkdirSync(path.join(ROOT, '.ruvnet-brain'), { recursive: true });
  dir = fs.mkdtempSync(path.join(ROOT, '.ruvnet-brain', 'proof-test-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const exec = (worked) => ({
  ran: true,
  argv: ['ruflo', 'memory', 'search'],
  exit: worked ? 0 : 1,
  exitOk: worked,
  retrieved: worked,
  why: worked ? 'exit 0; seeded memory retrieved' : 'exit 1; required option missing',
  output: worked ? 'note-caching-stra... The caching strategy' : '[ERROR] Required option missing: --query',
});

function armRecord({ trap, treated, passing }) {
  const memory = trap === replay.TRAP.MEMORY_SEARCH;
  return treated ? {
    class: passing ? 'flagged' : (memory ? 'positional' : 'partial'),
    subcommandCorrect: true,
    command: passing
      ? (memory
        ? 'ruflo memory search -q "caching strategy" --path .swarm/memory.db'
        : 'ruflo hooks post-task --task "release retry-budget investigation" --agent tester --success --store-results')
      : (memory
        ? 'ruflo memory search "caching strategy" --path .swarm/memory.db'
        : 'ruflo hooks post-task --task-id release-retry-budget-investigation --success true'),
    forcedCommand: false,
    exec: exec(passing),
    lessonIndex: passing ? 0 : -1,
    firstToolIndex: passing ? 1 : 0,
    lessonBeforeFirstToolCall: passing,
    model: 'gpt-5.6-sol',
  } : {
    class: memory ? 'positional' : 'partial',
    subcommandCorrect: true,
    command: memory
      ? 'ruflo memory search "caching strategy" --path .swarm/memory.db'
      : 'ruflo hooks post-task --task-id release-retry-budget-investigation --success true',
    exec: exec(false),
    lessonDelivered: false,
    model: 'gpt-5.6-sol',
  };
}

function proofRef({ trap, run, arm, record, sourceSha = HEAD, mutant = null }) {
  const envelope = { schema: 2, sourceSha, trap, mutant, run, arm, record };
  const bytes = `${JSON.stringify(envelope, null, 2)}\n`;
  const hash = sha256(bytes);
  const file = path.join(dir, `${hash}.json`);
  fs.writeFileSync(file, bytes);
  return { path: path.relative(ROOT, file), sha256: hash, sourceSha, mutant };
}

function runRecord({ trap, passing = true, i = 1, error = null, mutant = null }) {
  const treatedRecord = armRecord({ trap, treated: true, passing });
  const controlRecord = armRecord({ trap, treated: false, passing: false });
  return {
    i,
    verdict: error ? replay.VERDICT.UNKNOWN : (passing ? replay.VERDICT.PASS : replay.VERDICT.FAIL),
    why: error
      ? `harness could not measure this run: ${error}`
      : (passing ? 'treated action executed and retrieved' : `treated arm produced "${treatedRecord.class}", not the token`),
    error,
    treated: { ...treatedRecord, transcript: proofRef({ trap, mutant, run: i, arm: 'treated', record: treatedRecord }) },
    control: { ...controlRecord, transcript: proofRef({ trap, mutant, run: i, arm: 'control', record: controlRecord }) },
  };
}

function artifact({ trap = replay.TRAP.MEMORY_SEARCH, passing = true, mutant = null, run = null, top = {} } = {}) {
  const row = run || runRecord({ trap, passing, mutant });
  const passes = passing ? 1 : 0;
  return {
    invariant: replay.INVARIANT,
    verdict: passing ? replay.VERDICT.PASS : replay.VERDICT.FAIL,
    why: passing ? '1/1 runs passed' : '0/1 runs passed',
    sha: HEAD,
    at: new Date().toISOString(),
    host: 'codex',
    model: 'gpt-5.6-sol',
    modelResolved: 'gpt-5.6-sol',
    mutant,
    trap,
    task: trap,
    taskHash: sha256(trap),
    n: 1,
    passes,
    fails: passing ? 0 : 1,
    unknowns: 0,
    controlTokenRuns: 0,
    controlWorkedRuns: 0,
    treatedTokenRuns: passes,
    executionGate: {
      treatedSubcommandRuns: 1,
      treatedExecutedRuns: passes,
      treatedRetrievedRuns: passes,
    },
    rate: passes,
    promotion: { projectCount: 2, sourceProjects: ['a', 'b'], promoted: true },
    record: { lessonId: `lesson-${trap}` },
    refresh: { lessonSurvived: true },
    runs: [row],
    ...top,
  };
}

function writeArtifact(value, name = `artifact-${Math.random()}.json`) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

function mutantFiles(overrides = {}) {
  return Object.fromEntries([replay.TRAP.MEMORY_SEARCH, replay.TRAP.POST_TASK].map((trap) => [trap,
    Object.fromEntries(['delete-lesson', 'brain-off-treated'].map((mutant) => {
      const key = `${trap}/${mutant}`;
      const value = overrides[key] || artifact({ trap, passing: false, mutant });
      return [mutant, writeArtifact(value, `${trap}-${mutant}.json`)];
    })),
  ]));
}

describe('receipt verification recomputes evidence instead of trusting JSON claims', () => {
  it('writes a bounded content-addressed proof and omits the raw task', () => {
    const treated = armRecord({ trap: replay.TRAP.MEMORY_SEARCH, treated: true, passing: true });
    const control = armRecord({ trap: replay.TRAP.MEMORY_SEARCH, treated: false, passing: false });
    const result = replay.aggregate([{
      i: 1,
      treatedClass: treated.class,
      controlClass: control.class,
      lessonBeforeFirstToolCall: treated.lessonBeforeFirstToolCall,
      treatedSubcommandCorrect: treated.subcommandCorrect,
      treatedExecOk: treated.exec.exitOk,
      treatedRetrieved: treated.exec.retrieved,
      treatedExecWhy: treated.exec.why,
      controlWorked: false,
      error: null,
      treated,
      control,
    }]);
    const privateTask = 'PRIVATE fixture task that must never enter committed evidence';
    const file = path.join(dir, 'round-trip.json');
    const value = replay.writeArtifact(file, result, {
      trap: replay.TRAP.MEMORY_SEARCH,
      task: privateTask,
      proofRoot: path.join(dir, 'proof'),
    });
    expect(value).not.toHaveProperty('task');
    expect(value.runs[0].treated.transcript.path).toContain(path.basename(dir));
    expect(fs.readFileSync(file, 'utf8')).not.toContain(privateTask);
    expect(replay.checkArtifact({ file, repo: ROOT }).status).toBe(replay.VERDICT.PASS);
  });

  it('redacts the host home directory before hashing published evidence', () => {
    const treated = armRecord({ trap: replay.TRAP.MEMORY_SEARCH, treated: true, passing: true });
    const control = armRecord({ trap: replay.TRAP.MEMORY_SEARCH, treated: false, passing: false });
    treated.command = `${os.homedir()}/.npm-global/bin/ruflo memory search -q "caching strategy"`;
    treated.exec.argv = [`${os.homedir()}/.npm-global/bin/ruflo`, 'memory', 'search'];
    treated.exec.output = `loaded from ${os.homedir()}/private-cache`;
    const result = replay.aggregate([{
      i: 1,
      treatedClass: treated.class,
      controlClass: control.class,
      lessonBeforeFirstToolCall: treated.lessonBeforeFirstToolCall,
      treatedSubcommandCorrect: treated.subcommandCorrect,
      treatedExecOk: treated.exec.exitOk,
      treatedRetrieved: treated.exec.retrieved,
      treatedExecWhy: treated.exec.why,
      controlWorked: false,
      error: null,
      treated,
      control,
    }]);
    const file = path.join(dir, 'redacted.json');
    const value = replay.writeArtifact(file, result, {
      trap: replay.TRAP.MEMORY_SEARCH,
      proofRoot: path.join(dir, 'redacted-proof'),
    });
    const bytes = fs.readFileSync(file, 'utf8');
    expect(bytes).not.toContain(os.homedir());
    expect(bytes).toContain('$HOME/.npm-global/bin/ruflo');
    expect(value.runs[0].treated.exec.argv[0]).toBe('$HOME/.npm-global/bin/ruflo');
  });

  it('binds proof identity to the mutant, not only trap/run/arm', () => {
    const treated = armRecord({ trap: replay.TRAP.MEMORY_SEARCH, treated: true, passing: false });
    const control = armRecord({ trap: replay.TRAP.MEMORY_SEARCH, treated: false, passing: false });
    const result = replay.aggregate([{
      i: 1,
      treatedClass: treated.class,
      controlClass: control.class,
      lessonBeforeFirstToolCall: false,
      treatedSubcommandCorrect: true,
      treatedExecOk: false,
      treatedRetrieved: false,
      treatedExecWhy: treated.exec.why,
      controlWorked: false,
      error: null,
      treated,
      control,
    }]);
    const proofRoot = path.join(dir, 'mutant-proofs');
    const deleted = replay.writeArtifact(path.join(dir, 'delete.json'), result, {
      trap: replay.TRAP.MEMORY_SEARCH,
      mutant: 'delete-lesson',
      task: 'fixture',
      proofRoot,
    });
    const disabled = replay.writeArtifact(path.join(dir, 'brain-off.json'), result, {
      trap: replay.TRAP.MEMORY_SEARCH,
      mutant: 'brain-off-treated',
      task: 'fixture',
      proofRoot,
    });
    expect(deleted.runs[0].treated.transcript.sha256)
      .not.toBe(disabled.runs[0].treated.transcript.sha256);
  });

  it('rejects a data-only edit that changes top-level counts without changing red runs', () => {
    const file = writeArtifact(artifact({ passing: false, top: { verdict: replay.VERDICT.PASS, passes: 1, fails: 0, rate: 1 } }));
    const checked = replay.checkArtifact({ file, repo: ROOT });
    expect(checked.status).toBe(replay.VERDICT.FAIL);
    expect(checked.why).toMatch(/recomputed|does not match/i);
  });

  it('rejects a receipt when a referenced transcript was deleted', () => {
    const value = artifact();
    fs.rmSync(path.join(ROOT, value.runs[0].treated.transcript.path));
    const checked = replay.checkArtifact({ file: writeArtifact(value), repo: ROOT });
    expect(checked.status).toBe(replay.VERDICT.UNKNOWN);
    expect(checked.why).toMatch(/transcript/i);
  });

  it('rejects a receipt when a transcript hash is wrong', () => {
    const value = artifact();
    value.runs[0].treated.transcript.sha256 = '0'.repeat(64);
    const checked = replay.checkArtifact({ file: writeArtifact(value), repo: ROOT });
    expect(checked.status).toBe(replay.VERDICT.UNKNOWN);
    expect(checked.why).toMatch(/hash/i);
  });

  it('rejects a receipt whose transcript names a different source SHA', () => {
    const value = artifact();
    value.runs[0].treated.transcript.sourceSha = 'f'.repeat(40);
    const checked = replay.checkArtifact({ file: writeArtifact(value), repo: ROOT });
    expect(checked.status).toBe(replay.VERDICT.UNKNOWN);
    expect(checked.why).toMatch(/source/i);
  });

  it('rejects a run with a missing control arm', () => {
    const value = artifact();
    delete value.runs[0].control;
    expect(replay.checkArtifact({ file: writeArtifact(value), repo: ROOT }).status).not.toBe(replay.VERDICT.PASS);
  });

  it('recomputes a harness-error arm as UNKNOWN even if top-level JSON says PASS', () => {
    const value = artifact({ run: runRecord({ trap: replay.TRAP.MEMORY_SEARCH, error: 'spawn failed' }) });
    expect(replay.checkArtifact({ file: writeArtifact(value), repo: ROOT }).status).toBe(replay.VERDICT.UNKNOWN);
  });
});

describe('portfolio and mutant checks consume recomputed run evidence', () => {
  it('rejects a portfolio whose memory receipt claims PASS over a failing run', () => {
    const forgedPass = (trap, passing) => ({
      verdict: replay.VERDICT.PASS,
      why: '3/3 runs passed',
      n: 3,
      passes: 3,
      fails: 0,
      unknowns: 0,
      treatedTokenRuns: 3,
      controlTokenRuns: 0,
      controlWorkedRuns: 0,
      executionGate: {
        treatedSubcommandRuns: 3,
        treatedExecutedRuns: 3,
        treatedRetrievedRuns: 3,
      },
      rate: 1,
      runs: [1, 2, 3].map((i) => runRecord({ trap, passing, i })),
    });
    const memory = artifact({
      passing: false,
      top: forgedPass(replay.TRAP.MEMORY_SEARCH, false),
    });
    const post = artifact({
      trap: replay.TRAP.POST_TASK,
      top: forgedPass(replay.TRAP.POST_TASK, true),
    });
    const checked = replay.checkPortfolio({
      files: {
        [replay.TRAP.MEMORY_SEARCH]: writeArtifact(memory, 'memory.json'),
        [replay.TRAP.POST_TASK]: writeArtifact(post, 'post.json'),
      },
      mutantFiles: mutantFiles(),
      repo: ROOT,
    });
    expect(checked.status).toBe(replay.VERDICT.FAIL);
    expect(checked.why).toMatch(/memory-search-query/i);
  });

  it('rejects generic mutant failures whose arms never executed', () => {
    const generic = artifact({ passing: false, mutant: 'delete-lesson' });
    generic.runs[0].why = 'generic failure';
    generic.runs[0].treated.exec.ran = false;
    generic.runs[0].control.exec.ran = false;
    const checked = replay.checkMutantArtifacts({
      files: mutantFiles({ [`${replay.TRAP.MEMORY_SEARCH}/delete-lesson`]: generic }),
      repo: ROOT,
    });
    expect(checked.status).not.toBe(replay.VERDICT.PASS);
    expect(checked.why).toMatch(/execut|causal|expected/i);
  });

  it('rejects a mutant receipt containing an UNKNOWN run', () => {
    const unknown = artifact({ passing: false, mutant: 'brain-off-treated', top: { unknowns: 1, fails: 0 } });
    unknown.runs[0].verdict = replay.VERDICT.UNKNOWN;
    unknown.runs[0].error = 'executor unavailable';
    const checked = replay.checkMutantArtifacts({
      files: mutantFiles({ [`${replay.TRAP.MEMORY_SEARCH}/brain-off-treated`]: unknown }),
      repo: ROOT,
    });
    expect(checked.status).not.toBe(replay.VERDICT.PASS);
    expect(checked.why).toMatch(/unknown|measure/i);
  });
});

describe('archive retention is chronological and receipt-aware', () => {
  function runDir(name, createdAt) {
    const base = path.join(dir, name);
    fs.mkdirSync(path.join(base, 'transcripts'), { recursive: true });
    fs.writeFileSync(path.join(base, 'run-manifest.json'), JSON.stringify({ createdAt, sequence: Date.parse(createdAt) }));
    return base;
  }

  it('prunes the oldest manifest time, never the lexicographically smallest random name', () => {
    const old = runDir('run-z-old', '2026-01-01T00:00:00.000Z');
    const fresh = runDir('run-a-new', '2026-02-01T00:00:00.000Z');
    expect(replay.pruneArchive).toBeTypeOf('function');
    replay.pruneArchive({ base: fresh }, { keepRuns: 1 });
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('never deletes a run containing a transcript referenced by the accepted receipt', () => {
    const old = runDir('run-z-preserved', '2026-01-01T00:00:00.000Z');
    const transcript = path.join(old, 'transcripts', 'accepted.jsonl');
    fs.writeFileSync(transcript, '{}\n');
    const fresh = runDir('run-a-new', '2026-02-01T00:00:00.000Z');
    expect(replay.pruneArchive).toBeTypeOf('function');
    replay.pruneArchive({ base: fresh }, { keepRuns: 1, preservePaths: [transcript] });
    expect(fs.existsSync(transcript)).toBe(true);
    expect(fs.existsSync(fresh)).toBe(true);
  });
});

describe('learning replay source boundaries', () => {
  it('rejects a dirty default lesson source in both receipt verification and CLI dry-run', () => {
    const lesson = path.join(ROOT, 'plugin/scripts/lesson-gate.mjs');
    const original = fs.readFileSync(lesson);
    const file = writeArtifact(artifact());
    expect(replay.checkSourceIdentity({ repo: ROOT }).clean).toBe(true);
    try {
      fs.appendFileSync(lesson, '\n// Deliberately dirty load-bearing fixture.\n');
      const checked = replay.checkArtifact({ file, repo: ROOT });
      expect(checked.status).toBe(replay.VERDICT.UNKNOWN);
      expect(checked.why).toMatch(/uncommitted.*lesson-gate/);
      const out = path.join(dir, 'dirty-dry-run.json');
      const result = spawnSync(process.execPath, [
        'scripts/learning-replay.mjs', '--dry-run', '--out', out,
      ], { cwd: ROOT, encoding: 'utf8', timeout: 10_000 });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(replay.EXIT.UNKNOWN);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(/uncommitted.*lesson-gate/);
      expect(fs.existsSync(out)).toBe(false);
      expect(fs.existsSync(path.join(ROOT, '.ruvnet-brain/learning-replay'))).toBe(false);
    } finally {
      fs.writeFileSync(lesson, original);
    }
    expect(replay.checkSourceIdentity({ repo: ROOT }).clean).toBe(true);
  });

  it('refuses a dirty load-bearing source identity before an expensive replay', () => {
    const repo = path.join(dir, 'identity-repo');
    fs.mkdirSync(repo);
    spawnSync('git', ['init', '-q'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'gate.mjs'), 'export const gate = true;\n');
    spawnSync('git', ['add', 'gate.mjs'], { cwd: repo });
    spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '-qm', 'fixture'], { cwd: repo });
    expect(replay.checkSourceIdentity).toBeTypeOf('function');
    expect(replay.checkSourceIdentity({ repo, loadBearing: ['gate.mjs'] }).clean).toBe(true);
    fs.appendFileSync(path.join(repo, 'gate.mjs'), 'export const dirty = true;\n');
    const dirty = replay.checkSourceIdentity({ repo, loadBearing: ['gate.mjs'] });
    expect(dirty.clean).toBe(false);
    expect(dirty.why).toMatch(/dirty|uncommitted/i);
  });

  it('keeps every replay source module below 500 lines', () => {
    const files = fs.readdirSync(path.join(ROOT, 'scripts'))
      .filter((name) => /^learning-replay(?:-[a-z-]+)?\.mjs$/.test(name));
    for (const file of files) {
      const lines = fs.readFileSync(path.join(ROOT, 'scripts', file), 'utf8').split('\n').length;
      expect(lines, `${file} must stay below 500 lines`).toBeLessThan(500);
    }
  });
});

// Codex 4.7.21 r3 #5 + review F2: the scheduled workflow softened EVERY non-zero portfolio result, including a
// recomputed FAIL. Run the real CLI against hash-consistent evidence, then the workflow's own step script.
describe('portfolio exit contract: only out-of-date evidence is softened', () => {
  const files = () => replay.PORTFOLIO_RESULT_FILES;
  const cli = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/learning-replay.mjs'), '--check-portfolio', ...args],
    { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
  function place({ memory, post }) {
    fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
    for (const [trap, value] of [[replay.TRAP.MEMORY_SEARCH, memory], [replay.TRAP.POST_TASK, post]]) {
      if (value === null) fs.rmSync(files()[trap], { force: true });
      else fs.writeFileSync(files()[trap], `${JSON.stringify(value, null, 2)}\n`);
    }
  }
  const failing = () => ({ memory: artifact({ passing: false }), post: artifact({ trap: replay.TRAP.POST_TASK }) });
  const stale = () => ({
    memory: artifact({ top: { at: new Date(Date.now() - 30 * 86_400_000).toISOString() } }),
    post: artifact({ trap: replay.TRAP.POST_TASK }),
  });
  afterEach(() => place({ memory: null, post: null }));

  it('a recomputed FAIL exits 1 with or without --tolerate-stale', () => {
    place(failing());
    expect(replay.checkPortfolio({ repo: ROOT }).status).toBe(replay.VERDICT.FAIL);
    expect(cli().status).toBe(1);
    const tolerated = cli('--tolerate-stale');
    expect(tolerated.status).toBe(1);
    expect(tolerated.stdout).not.toContain('STALE-TOLERATED');
  });

  it('out-of-date evidence is UNKNOWN (exit 4), and exit 0 + STALE-TOLERATED only when asked', () => {
    place(stale());
    const checked = replay.checkPortfolio({ repo: ROOT });
    expect(checked).toMatchObject({ status: replay.VERDICT.UNKNOWN, stale: true });
    expect(cli().status).toBe(4);
    const tolerated = cli('--tolerate-stale');
    expect(tolerated.status).toBe(0);
    expect(tolerated.stdout).toContain('STALE-TOLERATED');
  });

  it('a missing artifact is an UNKNOWN that is NOT stale, so it stays exit 4 when tolerating', () => {
    place({ memory: null, post: null });
    expect(replay.checkPortfolio({ repo: ROOT }).stale).toBeUndefined();
    expect(cli('--tolerate-stale').status).toBe(4);
  });

  describe.skipIf(process.platform === 'win32')('the workflow step itself', () => {
    const YML = path.resolve(import.meta.dirname, '../../.github/workflows/learning-replay.yml');
    function stepScript() {
      const lines = fs.readFileSync(YML, 'utf8').split('\n');
      const start = lines.findIndex((l) => l.includes('- name: LEARNING-REPLAY-PORTFOLIO'));
      const run = lines.findIndex((l, i) => i > start && /^\s+run: \|\s*$/.test(l));
      const indent = lines[run + 1].match(/^\s*/)[0].length;
      const body = [];
      for (let i = run + 1; i < lines.length && (lines[i].trim() === '' || lines[i].match(/^\s*/)[0].length >= indent); i++) body.push(lines[i].slice(indent));
      return body.join('\n');
    }
    function step(strict) {
      const bin = fs.mkdtempSync(path.join(dir, 'bin-'));
      // `npm run --silent learning:replay:check -- [args]` → the real CLI in the fixture source.
      fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/bash\nwhile [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done; [ "$1" = "--" ] && shift\n`
        + `exec "${process.execPath}" "${path.join(ROOT, 'scripts/learning-replay.mjs')}" --check-portfolio "$@"\n`, { mode: 0o755 });
      const summary = path.join(bin, 'summary.md');
      const r = spawnSync('bash', ['-e', '-c', stepScript()], { cwd: ROOT, encoding: 'utf8', timeout: 60_000,
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, STRICT: strict, GITHUB_STEP_SUMMARY: summary } });
      return { status: r.status, out: r.stdout };
    }

    it('the STRICT input defaults off and only a manual dispatch can turn it on', () => {
      expect(fs.readFileSync(YML, 'utf8')).toMatch(/STRICT: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.strict_portfolio == true \}\}/);
    });

    it('schedule/push/dispatch: a recomputed FAIL is red', () => {
      place(failing());
      const r = step('false');
      expect(r.status).toBe(1);
      expect(r.out).toContain('::error title=LEARNING-REPLAY portfolio');
    });

    it('schedule/push/dispatch: out-of-date evidence is green and annotated; strict_portfolio makes it red', () => {
      place(stale());
      const soft = step('false');
      expect(soft.status).toBe(0);
      expect(soft.out).toContain('::warning title=LEARNING-REPLAY portfolio not current');
      expect(step('true').status).toBe(4);
    });

    it('a missing artifact is red even when not strict', () => {
      place({ memory: null, post: null });
      expect(step('false').status).toBe(4);
    });
  });
});
