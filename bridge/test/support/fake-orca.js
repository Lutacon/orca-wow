// A stand-in for Orca's local RPC: NDJSON over a real named pipe (a unix socket
// elsewhere), the same envelope and auth check as Orca's unix-socket-transport.ts,
// and scriptable worktrees, agents and terminals. It writes orca-runtime.json into
// `dir`, which tests pass to OrcaClient as `userDataDir`.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export function pipePath() {
  const name = `orca-test-${randomBytes(6).toString('hex')}`;
  return process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), `${name}.sock`);
}

export function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orca-fake-'));
}

const now = Date.now();

// A worktree.ps row with sensible defaults.
export function worktreeRow(over = {}) {
  return {
    worktreeId: 'repo-1::C:/src/app/fix-login',
    repoId: 'repo-1',
    repo: 'app',
    path: 'C:/src/app/fix-login',
    branch: 'fix-login',
    displayName: 'fix-login',
    workspaceStatus: 'in-progress',
    isArchived: false,
    unread: false,
    status: 'active',
    createdAt: now - 3600_000,
    agents: [],
    ...over,
  };
}

export function agentRow(over = {}) {
  return {
    paneKey: 'tab-1:leaf-1',
    parentPaneKey: null,
    state: 'working',
    agentType: 'claude',
    prompt: 'Fix the login bug',
    taskTitle: null,
    displayName: null,
    lastAssistantMessage: null,
    toolName: null,
    toolInput: null,
    interrupted: false,
    stateStartedAt: now - 60_000,
    updatedAt: now - 1000,
    ...over,
  };
}

export class FakeOrca {
  constructor({ dir, token = randomBytes(24).toString('hex'), runtimeId = randomUUID(), endpoint = pipePath() } = {}) {
    this.dir = dir;
    this.token = token;
    this.runtimeId = runtimeId;
    this.endpoint = endpoint;
    this.calls = []; // { method, params }
    this.authFailures = 0;
    this.repos = [{ id: 'repo-1', path: 'C:/src/app', displayName: 'app' }];
    this.worktrees = [];
    this.terminals = []; // terminal.list rows: { handle, worktreeId, tabId, leafId }
    this.screens = {}; // handle -> lines (terminal.read)
    this.waits = {}; // handle -> agentWait (terminal.show)
    this.handlers = {}; // method -> (params) => result, overriding the defaults
    this.sockets = new Set();
    this.server = null;
  }

  get runtimeFile() {
    return path.join(this.dir, 'orca-runtime.json');
  }

  writeRuntime() {
    const meta = { runtimeId: this.runtimeId, pid: process.pid, transports: [{ kind: process.platform === 'win32' ? 'named-pipe' : 'unix', endpoint: this.endpoint }], authToken: this.token, startedAt: Date.now() };
    const tmp = this.runtimeFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(meta));
    fs.renameSync(tmp, this.runtimeFile);
  }

  async start({ writeFile = true } = {}) {
    this.server = net.createServer((sock) => this.onConnection(sock));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.endpoint, resolve);
    });
    if (writeFile) this.writeRuntime();
    return this;
  }

  async stop({ removeFile = true } = {}) {
    for (const s of this.sockets) s.destroy();
    await new Promise((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server = null;
    if (removeFile) fs.rmSync(this.runtimeFile, { force: true });
  }

  callsOf(method) {
    return this.calls.filter((c) => c.method === method).map((c) => c.params);
  }

  onConnection(sock) {
    this.sockets.add(sock);
    sock.setEncoding('utf8');
    let buf = '';
    sock.on('close', () => this.sockets.delete(sock));
    sock.on('error', () => sock.destroy());
    sock.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) this.dispatch(sock, line);
      }
    });
  }

  async dispatch(sock, line) {
    const req = JSON.parse(line);
    const meta = { runtimeId: this.runtimeId };
    const reply = (obj) => !sock.destroyed && sock.write(JSON.stringify({ id: req.id, ...obj, _meta: meta }) + '\n');
    if (req.authToken !== this.token) {
      this.authFailures++;
      return reply({ ok: false, error: { code: 'unauthorized', message: 'Invalid auth token' } });
    }
    this.calls.push({ method: req.method, params: req.params });
    // A long poll would send these; clients must skip them.
    sock.write('{"_keepalive":true}\n');
    try {
      const handler = this.handlers[req.method] || this[`m_${req.method.replace(/\./g, '_')}`];
      if (!handler) return reply({ ok: false, error: { code: 'method_not_found', message: `Unknown method: ${req.method}` } });
      const result = await handler.call(this, req.params || {});
      reply({ ok: true, result });
    } catch (err) {
      reply({ ok: false, error: { code: err.code || 'runtime_error', message: err.message } });
    }
  }

  // ---- default methods ------------------------------------------------------

  m_status_get() {
    return { runtimeId: this.runtimeId, appVersion: '1.4.300' };
  }

  m_repo_list() {
    return { repos: this.repos };
  }

  m_worktree_ps(params) {
    const result = { worktrees: this.worktrees, totalCount: this.worktrees.length, truncated: false };
    if (params.afterSnapshotId === undefined) return result;
    const snapshotId = createHash('sha1').update(JSON.stringify(result)).digest('hex').slice(0, 16);
    return params.afterSnapshotId === snapshotId ? { unchanged: true, snapshotId } : { ...result, snapshotId };
  }

  m_terminal_list(params) {
    const id = String(params.worktree || '').replace(/^id:/, '');
    const terminals = this.terminals.filter((t) => !id || t.worktreeId === id);
    return { terminals, totalCount: terminals.length, truncated: false };
  }

  m_terminal_read(params) {
    const lines = this.screens[params.terminal];
    if (!lines) throw Object.assign(new Error('terminal_handle_stale'), { code: 'terminal_handle_stale' });
    return { terminal: { handle: params.terminal, status: 'running', tail: lines, truncated: false, nextCursor: null, source: params.screen ? 'screen' : 'stream' } };
  }

  m_terminal_show(params) {
    const t = this.terminals.find((x) => x.handle === params.terminal);
    if (!t) throw Object.assign(new Error('terminal_handle_stale'), { code: 'terminal_handle_stale' });
    return { terminal: { ...t, agentWait: this.waits[params.terminal] ?? null } };
  }

  m_terminal_send(params) {
    return { send: { handle: params.terminal, accepted: true, bytesWritten: String(params.text || '').length } };
  }

  m_worktree_set(params) {
    const id = params.worktree.replace(/^id:/, '');
    const row = this.worktrees.find((w) => w.worktreeId === id);
    if (!row) throw Object.assign(new Error('selector_not_found'), { code: 'selector_not_found' });
    if (params.workspaceStatus !== undefined) row.workspaceStatus = params.workspaceStatus;
    if (params.isUnread !== undefined) row.unread = params.isUnread;
    return { worktree: { id } };
  }

  m_worktree_sleep() {
    return { slept: true };
  }

  m_agentActivity_setRead() {
    return { applied: true };
  }

  m_worktree_create(params) {
    const repoId = params.repo.replace(/^id:/, '');
    const worktreeId = `${repoId}::C:/src/app/${params.name}`;
    const handle = `term-${this.terminals.length + 1}`;
    const tabId = `tab-${randomBytes(3).toString('hex')}`;
    this.terminals.push({ handle, worktreeId, tabId, leafId: 'leaf-1', title: params.startupAgent });
    this.screens[handle] = ['> starting'];
    this.lastCreated = { worktreeId, handle, paneKey: `${tabId}:leaf-1` };
    return { worktree: { id: worktreeId, displayName: params.name, branch: params.name, path: `C:/src/app/${params.name}` }, agentTerminalHandle: handle, warnings: [] };
  }
}
