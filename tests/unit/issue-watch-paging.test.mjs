// issue-watch-paging.test.mjs — how often the issue watcher may page (owner, 2026-10-25: 10,747 notifications on
// one topic; most were "SLA breach" re-pages every 4 h for ~14 old issues, including the owner's own Dream Cycle
// issues). The rule now: a person's issue pages when it arrives and once more if it passes the 4 h SLA unanswered;
// an issue the owner's automation opened never pages; everything still waiting goes into ONE morning summary.
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));

const START = Date.parse('2026-10-25T05:30:00Z'); // 1:30 a.m. ET, so the day holds exactly one 9 a.m.
const HOUR = 3_600_000;
let dir, run, digestDue, fetcher, issues;
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-watch-paging-'));
  vi.stubEnv('ISSUE_WATCH_STATE', path.join(dir, 'state.json')); vi.stubEnv('HOME', dir); vi.stubEnv('USERPROFILE', dir);
  vi.stubEnv('NTFY_TOPIC', 'owned-fixture');
  vi.resetModules();
  issues = [
    { number: 301, title: 'a person waiting', createdAt: new Date(START - 40 * 24 * HOUR).toISOString(), author: { login: 'HF-teamdev' } },
    { number: 494, title: 'Dream Cycle self-report', createdAt: new Date(START - 5 * HOUR).toISOString(), author: { login: 'stuinfla' } },
    { number: 478, title: 'bump vite', createdAt: new Date(START - 5 * HOUR).toISOString(), author: { login: 'app/dependabot', is_bot: true } },
  ];
  vi.mocked(spawnSync).mockReset().mockImplementation((bin, args) => {
    if (args[1] === 'list') return { status: 0, stdout: JSON.stringify(issues) };
    if (args[1] === 'view') return { status: 0, stdout: JSON.stringify({ comments: [] }) };
    if (args[1] === 'comment') return { status: 0, stdout: '' };
    throw new Error('unexpected external command');
  });
  fetcher = vi.fn().mockResolvedValue({ ok: true }); vi.stubGlobal('fetch', fetcher);
  ({ run, digestDue } = await import('../../scripts/issue-watch.mjs'));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); fs.rmSync(dir, { recursive: true, force: true }); });
const pages = () => fetcher.mock.calls.map(([, init]) => init?.headers?.Title || init?.headers?.title || '');

describe('issue watcher paging frequency', () => {
  it('a full day of hourly runs: a few clear pages, not dozens', async () => {
    for (let h = 0; h < 24; h += 1) await run({ now: START + h * HOUR });
    const titles = pages();
    // #301: one SLA page, then silence (arrival is paged by the GitHub workflow). Owner/bot issues: nothing.
    expect(titles.filter((t) => /#301/.test(t))).toHaveLength(1);
    expect(titles.some((t) => /#494|#478/.test(t))).toBe(false);
    // One morning summary (9 a.m. ET = 13:00 UTC), naming the person still waiting.
    expect(titles.filter((t) => /^Waiting on a reply/.test(t))).toHaveLength(1);
    expect(titles.length).toBe(2);
    // The bot never posts an acknowledgment on the owner's own issues.
    const commented = vi.mocked(spawnSync).mock.calls.filter((c) => c[1][1] === 'comment').map((c) => c[1][2]);
    expect(commented).toEqual(['301']);
  });
  it('the summary is once per Eastern day, from 9 a.m.', () => {
    expect(digestDue(undefined, Date.parse('2026-10-25T12:59:00Z')).due).toBe(false); // 8:59 a.m. EDT
    const at9 = digestDue(undefined, Date.parse('2026-10-25T13:00:00Z'));
    expect(at9).toEqual({ due: true, day: '2026-10-25' });
    expect(digestDue('2026-10-25', Date.parse('2026-10-25T20:00:00Z')).due).toBe(false);
    expect(digestDue('2026-10-25', Date.parse('2026-10-26T13:05:00Z')).due).toBe(true);
  });
  it('nothing waiting means no summary', async () => {
    issues = issues.filter((i) => i.number !== 301);
    for (let h = 0; h < 24; h += 1) await run({ now: START + h * HOUR });
    expect(pages()).toEqual([]);
  });
});
