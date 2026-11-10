// Several Orcas behind the single-client interface the bridge uses: this PC's (over
// its pipe, unless turned off) plus any paired with `orca-wow remote add` (over
// Orca's encrypted WebSocket, orca-remote.js). Modelled on fleet.js (T3 Code).
//
// Ids stay unique across machines: this PC's keep their raw ids (so saved views and
// state stay valid), other machines' get a short prefix ("e1~<id>"). Every thread
// and project handed out is a shallow copy with `id`/`projectId` rewritten and
// `_env` ({ code, label, local }) naming its machine, which the bridge shows and the
// addon filters by. Writes are routed by that prefix.
//
// config.orca: { local: true, localLabel?, remotes: [{ code, label, id, endpoint }],
// ...OrcaClient options (pollMs, defaultAgent, userDataDir, ...) }. A remote's device
// token and host key live in CONFIG_DIR/remotes/<id>.json, never in config.json.

import { EventEmitter } from 'node:events';
import path from 'node:path';
import { OrcaClient, AGENT_CHOICES } from './orca.js';
import { PairedTransport, readRemoteSecret, markRemoteV2, plainText, DEFAULT_SECRETS_DIR } from './orca-remote.js';

const SEP = '~';
const GONE = 'That agent is gone from Orca.';

export class OrcaFleet extends EventEmitter {
  constructor({ local = true, localLabel = 'This PC', remotes = [], secretsDir = DEFAULT_SECRETS_DIR, readSecret = (id) => readRemoteSecret(id, secretsDir), markV2 = (id) => markRemoteV2(id, secretsDir), log = () => {}, stateDir = null, ...clientOptions } = {}) {
    super();
    this.log = log;
    this.envs = [];
    this.threads = new Map();
    this.projects = new Map();
    this.olderSettled = 0;
    if (local !== false) {
      const env = { code: '', id: 'local', label: localLabel, local: true };
      env.client = new OrcaClient({ ...clientOptions, log, stateDir });
      this.envs.push(env);
    }
    const used = new Set();
    for (const r of remotes || []) {
      if (!r || r.disabled || !r.id || !/^e\d+$/.test(r.code || '') || used.has(r.code)) continue;
      const label = String(r.label || r.code);
      const secret = readSecret(r.id);
      const env = { code: r.code, id: r.id, label, local: false };
      const tag = `Orca (${label})`;
      // Lines about another computer can carry its text (errors, versions): keep it plain.
      const envLog = (...a) => log(plainText(a.join(' ').replace(/^Orca:/, `${tag}:`)));
      if (!secret) {
        // Config names it but its secret file is gone: show it, offline, with the fix.
        env.client = new MissingRemote(label);
      } else {
        const transport = new PairedTransport({
          endpoint: secret.endpoint || r.endpoint,
          deviceToken: secret.deviceToken,
          publicKeyB64: secret.publicKeyB64,
          label,
          timeoutMs: clientOptions.connectTimeoutMs,
          e2ee: secret.e2ee,
          allowLegacy: secret.allowLegacy,
          onLatch: () => markV2(r.id),
          log: envLog,
        });
        // Their archive and screenshot bookkeeping must not mix with this PC's.
        env.client = new OrcaClient({ ...clientOptions, userDataDir: undefined, transport, log: envLog, stateDir: stateDir ? path.join(stateDir, 'remotes', r.id) : null });
      }
      used.add(r.code);
      this.envs.push(env);
    }
    for (const env of this.envs) {
      env.tag = Object.freeze({ code: env.code, label: env.label, local: env.local });
      this.wire(env);
    }
  }

  get local() {
    return this.envs.find((e) => e.local) || null;
  }

  key(env, id) {
    return env.code ? `${env.code}${SEP}${id}` : id;
  }

  split(key) {
    const k = String(key || '');
    const i = k.indexOf(SEP);
    if (i > 0) {
      const env = this.envs.find((e) => e.code && e.code === k.slice(0, i));
      if (env) return { env, id: k.slice(i + 1) };
      throw new Error(GONE);
    }
    const env = this.envs.find((e) => e.code === '');
    if (!env) throw new Error(GONE);
    return { env, id: k };
  }

  // Route a call, turning a lookup failure into a rejected promise like the clients do.
  route(key, fn) {
    try {
      const { env, id } = this.split(key);
      return Promise.resolve(fn(env.client, id, env));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  wrapThread(env, t) {
    return { ...t, id: this.key(env, t.id), projectId: this.key(env, t.projectId), _env: env.tag };
  }

  wrapProject(env, p) {
    return { ...p, id: this.key(env, p.id), _env: env.tag };
  }

  drop(env) {
    for (const [k, t] of this.threads) if (t._env === env.tag) this.threads.delete(k);
    for (const [k, p] of this.projects) if (p._env === env.tag) this.projects.delete(k);
  }

  rebuild(env) {
    this.drop(env);
    for (const t of env.client.threads.values()) {
      const w = this.wrapThread(env, t);
      this.threads.set(w.id, w);
    }
    for (const p of env.client.projects.values()) {
      const w = this.wrapProject(env, p);
      this.projects.set(w.id, w);
    }
  }

  wire(env) {
    const c = env.client;
    c.on('state', (s, e) => {
      if (!env.local) this.log(plainText(`Orca (${env.label}): ${s}${e ? ` (${e})` : ''}`));
      // Another machine that drops off takes its agents with it until it's back.
      if (s === 'offline' && !env.local && this.hasEnvItems(env)) {
        this.drop(env);
        this.emit('change', { kind: 'snapshot', env });
      }
      this.emit('state', this.state, this.error, env);
    });
    c.on('config', () => this.emit('config', env));
    c.on('change', (ev) => {
      if (ev.kind === 'thread') {
        const thread = this.wrapThread(env, ev.thread);
        this.threads.set(thread.id, thread);
        this.emit('change', { kind: 'thread', id: thread.id, thread, prev: ev.prev ? this.wrapThread(env, ev.prev) : undefined, env });
      } else if (ev.kind === 'removed') {
        this.threads.delete(this.key(env, ev.id));
        this.emit('change', { kind: 'removed', id: this.key(env, ev.id), env });
      } else {
        this.rebuild(env);
        this.emit('change', { kind: ev.kind, env });
      }
    });
  }

  hasEnvItems(env) {
    for (const t of this.threads.values()) if (t._env === env.tag) return true;
    for (const p of this.projects.values()) if (p._env === env.tag) return true;
    return false;
  }

  start() {
    for (const env of this.envs) env.client.start();
  }

  stop() {
    for (const env of this.envs) env.client.stop();
  }

  // Connected when any machine is; an error only when none is.
  get state() {
    const states = this.envs.map((e) => e.client.state);
    if (!states.length) return 'offline';
    if (states.includes('connected')) return 'connected';
    if (states.includes('connecting')) return 'connecting';
    return states[0];
  }

  get error() {
    if (!this.envs.length) return 'No Orca to show: turn this PC\'s back on with `orca-wow local on`, or add one with `orca-wow remote add`.';
    if (this.envs.some((e) => e.client.state === 'connected')) return null;
    const errors = this.envs.filter((e) => e.client.error);
    if (!errors.length) return null;
    if (this.envs.length === 1) return errors[0].client.error;
    return errors.map((e) => (e.local ? `${e.label}: ${e.client.error}` : e.client.error)).join('; ');
  }

  get origin() {
    const env = this.local?.client.state === 'connected' ? this.local : this.envs.find((e) => e.client.state === 'connected') || this.local || this.envs[0];
    return env?.client.origin || null;
  }

  get config() {
    const connected = this.envs.filter((e) => e.client.state === 'connected');
    const live = connected[0] || this.envs[0];
    // The machines the game is showing ("Orca on MacBook"); none while nothing is connected.
    const label = connected.map((e) => (e.local ? 'this PC' : e.label)).join(', ') || undefined;
    return { environment: { label, serverVersion: live?.client.config?.environment?.serverVersion }, providers: [] };
  }

  environments() {
    return this.envs.map((e) => ({
      code: e.code,
      label: e.label,
      local: e.local || undefined,
      state: e.client.state,
      error: e.client.error || undefined,
      threads: e.client.threads.size,
      origin: e.client.origin || undefined,
    }));
  }

  // ---- reads and writes, routed by id ------------------------------------------

  threadProjection(key) {
    return this.route(key, (c, id) => c.threadProjection(id));
  }

  sendMessage(key, text, mode, attachments) {
    return this.route(key, (c, id) => c.sendMessage(id, text, mode, attachments));
  }

  // The image goes to the machine whose agent will read it (a thread or project key).
  uploadImage(routeKey, data, name, mime) {
    return this.route(routeKey, (c, id) => c.uploadImage(id, data, name, mime));
  }

  launchThread(projectKey, text, attachments, opts) {
    return this.route(projectKey, async (c, id, env) => {
      const res = await c.launchThread(id, text, attachments, opts);
      if (res?.threadId) res.threadId = this.key(env, res.threadId);
      return res;
    });
  }

  interrupt(key) {
    return this.route(key, (c, id) => c.interrupt(id));
  }

  respondApproval(key, requestId, decision) {
    return this.route(key, (c, id) => c.respondApproval(id, requestId, decision));
  }

  respondAnswers(key, requestId, answers) {
    return this.route(key, (c, id) => c.respondAnswers(id, requestId, answers));
  }

  settle(key) {
    return this.route(key, (c, id) => c.settle(id));
  }

  unsettle(key) {
    return this.route(key, (c, id) => c.unsettle(id));
  }

  archive(key) {
    return this.route(key, (c, id) => c.archive(id));
  }

  visit(key) {
    return this.route(key, (c, id) => c.visit(id));
  }

  setModel() {
    throw new Error("Orca's agents choose their own model");
  }

  defaultModelFor() {
    return null;
  }

  modelGroups() {
    return [];
  }

  // The new-worktree picker, from the first machine that's connected.
  agentChoices() {
    const env = this.envs.find((e) => e.client.state === 'connected') || this.envs[0];
    return env?.client.agentChoices?.() || { list: AGENT_CHOICES, default: 'claude' };
  }
}

// A remote named in config.json whose secret file is missing: never connects, says why.
class MissingRemote extends EventEmitter {
  constructor(label) {
    super();
    this.state = 'disconnected';
    this.error = null;
    this.origin = null;
    this.label = label;
    this.threads = new Map();
    this.projects = new Map();
    this.config = { environment: { label, serverVersion: undefined }, providers: [] };
  }

  start() {
    this.state = 'offline';
    this.error = `${this.label}'s pairing is missing from this PC. Run orca-wow remote add "${this.label}" and paste a new access link.`;
    this.emit('state', this.state, this.error);
  }

  stop() {
    this.state = 'disconnected';
  }

  agentChoices() {
    return { list: AGENT_CHOICES, default: 'claude' };
  }
}
for (const m of ['threadProjection', 'sendMessage', 'uploadImage', 'launchThread', 'interrupt', 'respondApproval', 'respondAnswers', 'settle', 'unsettle', 'archive', 'visit']) {
  MissingRemote.prototype[m] = function () {
    return Promise.reject(new Error(this.error || GONE));
  };
}
