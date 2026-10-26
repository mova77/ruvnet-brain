// tests/unit/brain-alarm-paging.test.mjs — the brain-down alarm must reach the phone, and only when it matters.
//
// THE DEFECTS (4.7.21, RC1.1 / RC1.7): kb/brain-alarm.mjs titled its pages "🚨 RuvNet Brain is DOWN" and
// "✅ RuvNet Brain recovered". fetch() refuses a non-ByteString header before sending, `catch → false` hid
// it, so the brain-down alarm had NEVER paged anyone. The moment that is fixed a second defect goes live: the
// throttle reset on every "up", so a flapping brain would page DOWN/RECOVERED on every flap. Both are fixed
// together and pinned here against a real local HTTP server (NTFY_URL), never ntfy.sh.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MIN = 60_000;
const T0 = Date.parse('2026-10-26T04:00:00Z');
let dir; let server; let requests; let alarm;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-alarm-'));
  requests = [];
  server = http.createServer((req, res) => { req.resume(); req.on('end', () => { requests.push(req.headers); res.end('{}'); }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  vi.stubEnv('HOME', dir); vi.stubEnv('USERPROFILE', dir);
  vi.stubEnv('NTFY_TOPIC', 'alarm-fixture'); vi.stubEnv('NTFY_URL', `http://127.0.0.1:${server.address().port}`);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.resetModules();
  alarm = await import('../../kb/brain-alarm.mjs');
});
afterEach(async () => {
  vi.useRealTimers(); vi.unstubAllEnvs();
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

const at = (ms) => vi.setSystemTime(new Date(T0 + ms));
const down = (ms) => { at(ms); return alarm.reportBrainDown({ error: 'ERR: every repo failed', source: 'test' }); };
const up = (ms) => { at(ms); return alarm.reportBrainUp({ source: 'test' }); };
const health = () => JSON.parse(fs.readFileSync(path.join(dir, '.cache', 'ruvnet-brain', 'health.json'), 'utf8'));

describe('brain-alarm paging', () => {
  it('a sustained outage pages DOWN once with an ASCII title (before: zero pages, ever)', async () => {
    await down(0); await down(6 * MIN);
    expect(requests).toHaveLength(1);
    expect(requests[0].title).toMatch(/^[\x20-\x7e]+$/);
    expect(requests[0].title).toBe('RuvNet Brain is DOWN');
    expect(requests[0].priority).toBe('urgent');
    expect(health().status).toBe('down');
  });

  it('a single transient failure pages nothing, but the banner still sees it', async () => {
    await down(0);
    await up(MIN);
    expect(requests).toHaveLength(0);
    expect(health().status).toBe('ok');
  });

  it('two failures less than 5 minutes apart do not page yet', async () => {
    await down(0); await down(2 * MIN);
    expect(requests).toHaveLength(0);
    expect(health().status).toBe('down'); // the session banner is never damped
  });

  it('down / up / down within 6 h is ONE DOWN page; the recovery is announced once', async () => {
    await down(0); await down(6 * MIN);                 // page 1: DOWN
    await up(20 * MIN);                                 // page 2: recovered (paged outage, lasted 20 min)
    await down(30 * MIN); await down(40 * MIN);         // second outage, within 6 h of the last DOWN page
    await up(60 * MIN);                                 // its DOWN never paged, so no recovery either
    expect(requests.map((h) => h.title)).toEqual(['RuvNet Brain is DOWN', 'RuvNet Brain recovered']);
    await down(7 * 60 * MIN); await down(7 * 60 * MIN + 6 * MIN); // more than 6 h later: pages again
    expect(requests).toHaveLength(3);
  });

  it('a paged outage shorter than 10 minutes recovers silently', async () => {
    await down(0); await down(5 * MIN);
    await up(8 * MIN);
    expect(requests.map((h) => h.title)).toEqual(['RuvNet Brain is DOWN']);
  });

  it('NTFY_TOPIC="" sends nothing even with a topic file present (before: the file was used)', async () => {
    vi.stubEnv('NTFY_TOPIC', '');
    fs.mkdirSync(path.join(dir, '.cache', 'ruvnet-brain'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.cache', 'ruvnet-brain', 'ntfy-topic'), 'file-topic');
    await down(0); await down(6 * MIN);
    expect(requests).toHaveLength(0);
    expect(health().status).toBe('down');
  });

  it('an HTTP error is not a delivered page: it is retried on the next failure', async () => {
    let first = true;
    server.removeAllListeners('request');
    server.on('request', (req, res) => { req.resume(); req.on('end', () => { requests.push(req.headers); res.statusCode = first ? 429 : 200; first = false; res.end(); }); });
    await down(0); await down(6 * MIN); await down(7 * MIN);
    expect(requests).toHaveLength(2);
    await down(8 * MIN);
    expect(requests).toHaveLength(2); // delivered once; quiet after that
  });

  // 4.7.21 review (Fable P2-1): every "up" reset the outage, so a flapping brain never paged.
  it('a brain that flaps down/up every 2 minutes pages DOWN once in 6 h (before: zero pages)', async () => {
    for (let t = 0; t < 6 * 60 * MIN; t += 4 * MIN) { await down(t); await up(t + 2 * MIN); }
    expect(requests.map((h) => h.title)).toEqual(['RuvNet Brain is DOWN']);
  });

  it('4-minute outages with a minute of health between them page DOWN once in 6 h; the flaps recover silently', async () => {
    for (let t = 0; t < 6 * 60 * MIN; t += 6 * MIN) { await down(t); await down(t + 4 * MIN); await up(t + 5 * MIN); }
    expect(requests.map((h) => h.title)).toEqual(['RuvNet Brain is DOWN']);
  });

  it('failures more than an hour apart are not a flap: one blip a day never pages', async () => {
    for (let d = 0; d < 3; d++) { await down(d * 24 * 60 * MIN); await up(d * 24 * 60 * MIN + MIN); }
    await down(3 * 24 * 60 * MIN); await up(3 * 24 * 60 * MIN + 61 * MIN); await down(3 * 24 * 60 * MIN + 62 * MIN);
    expect(requests).toHaveLength(0);
  });

  // 4.7.21 review (Opus #3): read -> await push -> write was not atomic; parallel failing searches all paged.
  it('three parallel failing searches in one process page ONCE (before: three pages)', async () => {
    await down(0);
    at(10 * MIN);
    await Promise.all([1, 2, 3].map(() => alarm.reportBrainDown({ error: 'ERR: every repo failed', source: 'parallel' })));
    expect(requests).toHaveLength(1);
    expect(health().downPaged).toBe(true);
  });

  it('an undelivered claimed page is released: the next failure retries it', async () => {
    let first = true;
    server.removeAllListeners('request');
    server.on('request', (req, res) => { req.resume(); req.on('end', () => { requests.push(req.headers); res.statusCode = first ? 503 : 200; first = false; res.end(); }); });
    await down(0);
    at(10 * MIN);
    await Promise.all([1, 2, 3].map(() => alarm.reportBrainDown({ error: 'ERR', source: 'parallel' })));
    expect(requests).toHaveLength(1); // one claimed attempt, refused
    expect(health().downPaged).toBe(false);
    await down(11 * MIN);
    expect(requests).toHaveLength(2);
    expect(health().downPaged).toBe(true);
  });

  it('a claim abandoned by a killed sender does not swallow the page for 6 h', async () => {
    await down(0);
    const file = path.join(dir, '.cache', 'ruvnet-brain', 'health.json');
    const h = health();
    fs.writeFileSync(file, JSON.stringify({ ...h, downPaged: 'pending', lastDownPageAt: T0 + 5 * MIN, claimPrevPageAt: 0 }));
    await down(5 * MIN + 30_000); // claim still fresh (sender may be mid-POST): no second page
    expect(requests).toHaveLength(0);
    await down(7 * MIN);          // claim older than 60 s: abandoned, page now
    expect(requests).toHaveLength(1);
  });
});

describe('brain-alarm across processes', () => {
  it('three PROCESSES failing at once page ONCE', async () => {
    vi.useRealTimers();
    const stateDir = path.join(dir, '.cache', 'ruvnet-brain');
    fs.mkdirSync(stateDir, { recursive: true });
    const now = Date.now();
    fs.writeFileSync(path.join(stateDir, 'health.json'), JSON.stringify({ status: 'down', firstDownTs: now - 10 * MIN, failCount: 1,
      recentFails: [now - 10 * MIN], lastDownPageAt: 0, downPaged: false }));
    // Slow the stub so every process is mid-POST together (the window the old code double-paged in).
    server.removeAllListeners('request');
    server.on('request', (req, res) => { req.resume(); req.on('end', () => { requests.push(req.headers); setTimeout(() => res.end('{}'), 300); }); });
    const mod = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'kb', 'brain-alarm.mjs');
    const go = path.join(dir, 'go');
    const script = `import fs from 'node:fs'; while (!fs.existsSync(${JSON.stringify(go)})) await new Promise((r) => setTimeout(r, 2));
const a = await import(${JSON.stringify(new URL(`file://${mod}`).href)}); await a.reportBrainDown({ error: 'ERR', source: 'proc' });`;
    const env = { ...process.env, HOME: dir, USERPROFILE: dir, NTFY_TOPIC: 'alarm-fixture', NTFY_URL: process.env.NTFY_URL };
    const kids = [1, 2, 3].map(() => spawn(process.execPath, ['--input-type=module', '-e', script], { env, stdio: 'ignore' }));
    const exits = kids.map((k) => new Promise((r) => k.on('exit', r)));
    await new Promise((r) => setTimeout(r, 300));
    fs.writeFileSync(go, '');
    expect(await Promise.all(exits)).toEqual([0, 0, 0]);
    expect(requests).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(stateDir, 'health.json'), 'utf8')).downPaged).toBe(true);
  }, 20_000);
});
