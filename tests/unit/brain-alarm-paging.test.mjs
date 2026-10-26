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
});
