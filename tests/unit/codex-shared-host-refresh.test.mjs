// codex-shared-host-refresh.test.mjs — #492 (b). A running shared Codex app-server (the managed daemon the TUI attaches
// to) keeps the plugin declarations it parsed before the Brain changed the installed plugin from another process:
// openai/codex rust-v0.164.0 codex-rs/core-plugins/src/manager.rs LoadedPluginsCache::get() drops a cached entry only
// when the active plugin ROOT changes. Measured 2026-10-25 on codex-cli 0.164.0 in an isolated CODEX_HOME: after an
// in-place change the daemon's hooks/list still showed the old SessionEnd declaration (3s) while a fresh server and the
// disk showed the new one (2s); a no-edit config/batchWrite with reloadUserConfig made the daemon agree.
// The server here is a real WebSocket endpoint on a real Unix socket behind Codex's rendezvous symlink.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { refreshSharedCodexAppServer } from '../../scripts/codex-hook-trust-reconcile.mjs';
import { refreshCodexSharedHost } from '../../bin/install.mjs';

const cleanups = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

/** A fake shared app-server: answers like Codex and records every request it receives. */
async function sharedServer({ rejectWrite = false } = {}) {
  const codexHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cxh-')));
  const sockDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cs-')));
  const socket = path.join(sockDir, 's');
  const received = [];
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws, req) => {
    received.push({ path: req.url });
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)); received.push(msg);
      if (msg.id === undefined) return;
      const reply = (result) => ws.send(JSON.stringify({ id: msg.id, result }));
      if (msg.method === 'initialize') reply({ userAgent: 'codex' });
      else if (msg.method === 'config/read') reply({ config: {}, layers: [{ name: { type: 'user', file: path.join(codexHome, 'config.toml') }, version: 'sha256:v1', config: {} }] });
      else if (msg.method === 'config/batchWrite') {
        if (rejectWrite) ws.send(JSON.stringify({ id: msg.id, error: { code: -32600, message: 'Configuration was modified since last read. secret=hunter2' } }));
        else reply({ status: 'ok', version: 'sha256:v1' });
      }
    });
  });
  await new Promise((resolve) => server.listen(socket, resolve));
  fs.mkdirSync(path.join(codexHome, 'app-server-control'));
  fs.symlinkSync(socket, path.join(codexHome, 'app-server-control', 'app-server-control.sock'));
  cleanups.push(async () => {
    for (const c of wss.clients) c.terminate();
    await new Promise((resolve) => wss.close(() => server.close(() => resolve())));
    fs.rmSync(codexHome, { recursive: true, force: true }); fs.rmSync(sockDir, { recursive: true, force: true });
  });
  return { codexHome, received };
}

describe('refreshSharedCodexAppServer — reload a running Codex host without changing anything', () => {
  it('sends Codex\'s own no-edit reload, version-checked, and grants nothing', async () => {
    const { codexHome, received } = await sharedServer();
    const result = await refreshSharedCodexAppServer({ codexHome });
    expect(result).toEqual({ state: 'refreshed', changed: false, approvalsGranted: 0 });
    expect(received[0].path).toBe('/'); // never the daemon's /daemon/shutdown endpoint
    expect(received.slice(1).map((m) => m.method)).toEqual(['initialize', 'initialized', 'config/read', 'config/batchWrite']);
    expect(received.at(-1).params).toEqual({ filePath: path.join(codexHome, 'config.toml'), expectedVersion: 'sha256:v1', reloadUserConfig: true, edits: [] });
  });
  it('does nothing when no shared server is listening, and never starts one', async () => {
    const codexHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cxh-')));
    cleanups.push(() => fs.rmSync(codexHome, { recursive: true, force: true }));
    expect(await refreshSharedCodexAppServer({ codexHome })).toEqual({ state: 'no-shared-server', changed: false });
    expect(fs.existsSync(path.join(codexHome, 'app-server-control'))).toBe(false);
  });
  it('reports a refused reload as failed without echoing the native error text', async () => {
    const { codexHome } = await sharedServer({ rejectWrite: true });
    const result = await refreshSharedCodexAppServer({ codexHome });
    expect(result.state).toBe('failed');
    expect(result.reason).not.toMatch(/hunter2/);
  });
});

describe('refreshCodexSharedHost — the installer reloads the host only after it changed what the host sees', () => {
  it('reloads after an install, an update or a trust write; not after a no-op run', async () => {
    const calls = [];
    const refresh = async (args) => { calls.push(args); return { state: 'refreshed', changed: false }; };
    for (const action of ['installed', 'updated']) expect((await refreshCodexSharedHost({ action }, { codexHome: '/x', refresh })).state).toBe('refreshed');
    expect((await refreshCodexSharedHost({ action: 'unchanged', hookTrust: { state: 'registry-verified', changed: true } }, { codexHome: '/x', refresh })).state).toBe('refreshed');
    expect(await refreshCodexSharedHost({ action: 'unchanged', hookTrust: { state: 'unchanged', changed: false } }, { codexHome: '/x', refresh })).toEqual({ state: 'not-needed', changed: false });
    expect(await refreshCodexSharedHost({ action: 'disabled' }, { codexHome: '/x', refresh })).toEqual({ state: 'not-needed', changed: false });
    expect(calls).toEqual([{ codexHome: '/x' }, { codexHome: '/x' }, { codexHome: '/x' }]);
  });
});
