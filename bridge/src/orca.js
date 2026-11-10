// Client for a running Orca (stablyai/orca): the IDE that runs CLI coding agents
// (Claude Code, Codex, ...) in terminals, one git worktree each. It speaks the same
// local RPC the `orca` CLI uses and hands the bridge one thread per agent, in the
// shape the helpers in threads.js and bridge.js (threadStatus, isUnread,
// pendingRequest, ...) read.
//
// Transport: NDJSON over Orca's named pipe (unix socket elsewhere). Its address and
// auth token live in <userData>/orca-runtime.json and change on every Orca launch,
// so the file is re-read whenever a connection opens. Streaming methods are refused
// on the pipe, so we poll `worktree.ps`. An Orca on another computer is reached the
// same way over a paired, end-to-end encrypted WebSocket instead (orca-remote.js):
// pass `transport: new PairedTransport(...)`. A transport opens one connection at a
// time ({ call, close, closed }); everything above it is shared.
//
// One thread per agent pane (`agents[].paneKey` = `<tabId>:<leafId>`) of a
// worktree; one project per Orca repo. Commands map onto Orca like this:
//   sendMessage  terminal.send {text, enter, agentPrompt}: what `orca terminal send
//                --text --enter` sends; Orca types it into the agent's prompt box.
//   interrupt    Escape, the key Orca's own phone app sends for Stop.
//   approvals    the menu keys Orca's phone app sends: the option's digit to allow,
//                Escape to deny. "Don't ask again" picks the menu row that says so,
//                whose label the game shows. The menu is read again first and must
//                be the one the player saw; nothing is pressed when it can't be read.
//   questions    the selector keystrokes Orca's chat card sends (the option's
//                on-screen digit, "Type something" row + text for a free answer).
//   settle       worktree.set workspaceStatus 'completed' (Orca's Done column) + read
//   unsettle     worktree.set workspaceStatus 'in-progress'
//   archive      worktree.sleep (stops the worktree's agents; Orca can resume them)
//                and hides the thread here until that agent works again
//   visit        agentActivity.setRead + worktree.set isUnread:false (the unread dot)
// Orca's agents pick their own models, so there is no model list.

import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const RUNTIME_FILE = 'orca-runtime.json';
// Orca drops frames over 1 MB (src/shared/local-runtime-rpc-limits.ts).
const MAX_FRAME = 1024 * 1024;
const CLIENT = { id: 'wow-bridge', type: 'desktop' };
const NOT_RUNNING = "Orca isn't running";
// A prompt that starts with "!" runs a shell command in Claude Code (and Codex) with
// no approval. Other addons share the game's Lua state and can queue messages, so the
// game can't send those unless config.orca.allowShell is on (`orca-wow shell on`).
// Every line counts (after leading spaces), since a line break can reach the prompt
// box as Enter. "/" (slash commands such as /clear or /compact) stays allowed: those
// are the agent's own commands, or ones the user wrote, and anything they run still
// asks for approval the usual way.
const SHELL_LINE = /^\s*!/;
const LINE_BREAK = /[\n\u2028\u2029]/;
export const SHELL_REFUSED = 'Messages with a line that starts with "!" run shell commands in the agent, and that\'s off from the game. To allow it, run orca-wow shell on at the computer.';

// Text from the game is typed into a terminal, where control characters are keys: DEL
// or Ctrl+U could edit the line so a "!" ends up first, and others move the cursor or
// start escape sequences. Only line breaks and tabs are kept (C0, DEL and C1 go).
export function gameText(text) {
  return String(text ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

// Answers to a wait are refused rather than pressed blind.
const CHANGED = 'The question changed, so nothing was pressed. Look again.';
const UNREADABLE = "Couldn't read the agent's screen, so nothing was pressed. Try again, or answer it in Orca.";
const NO_MENU = "Couldn't find the agent's menu on its screen, so nothing was pressed. Answer it in Orca.";
const NO_YES = "Couldn't tell which option says yes, so nothing was pressed. Answer it in Orca.";
const NO_ALWAYS = 'That menu has no "don\'t ask again" option, so nothing was pressed. Pick Yes or No.';
const AT_COMPUTER = "Answer this at the computer: the game can't approve it. You can still say No from here.";
// Why a request is shown as needing the computer (`pcw` in the snapshot).
const PC_ONE_LINE = "The game only sees one line of this prompt, so it can't approve it. You can still say No from here.";
const PC_NEEDS_COMPUTER = 'This prompt needs the computer (signing in, or picking a model). You can still say No from here.';
const PC_NO_MENU = "The bridge can't find this prompt's options on the agent's screen, so the game can't approve it. You can still say No from here.";
const PC_NO_YES = "None of this prompt's options says yes, so the game can't approve it. You can still say No from here.";
const ESC = '\x1b';
const TAIL_LINES = 40;
// The pause between selector keystrokes, so each step renders before the next
// (Orca paces its own answers at 500 ms: native-chat-answer-stepping.ts).
const KEY_DELAY_MS = 500;
// Handle errors that mean "look the terminal up again" (src/main/runtime/rpc/errors.ts).
const STALE_HANDLE = new Set(['terminal_handle_stale', 'terminal_gone', 'terminal_not_found', 'terminal_exited']);
const READS = new Set(['status.get', 'repo.list', 'worktree.ps', 'terminal.list', 'terminal.read', 'terminal.show']);
// Base64 per clipboard.appendImageUploadChunk (CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS).
const IMAGE_CHUNK = 512 * 1024;

export function defaultUserDataDir() {
  if (process.env.ORCA_USER_DATA_PATH) return process.env.ORCA_USER_DATA_PATH;
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'orca');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'orca');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'orca');
}

// Orca's runtime file, with `transport` set to the pipe/socket we can use. Older
// builds wrote a single `transport` instead of `transports`. Throws when the file is
// missing (Orca isn't running) or unusable.
export function readRuntime(userDataDir = defaultUserDataDir()) {
  const file = path.join(userDataDir, RUNTIME_FILE);
  const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(meta?.transports) ? meta.transports : meta?.transport ? [meta.transport] : [];
  const transport = list.find((t) => t && (t.kind === 'named-pipe' || t.kind === 'unix') && t.endpoint);
  if (!transport || !meta.authToken) throw new Error(`Orca's runtime file has no local transport or token (${file})`);
  return { ...meta, transport };
}

// Is the process that wrote the runtime file still running? Orca can exit without
// removing the file, and then anyone could be listening on the pipe it names. EPERM
// means it runs but as another account (an elevated Orca on Windows), so it counts.
export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true; // older files have no pid: can't tell
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

export class OrcaRpcError extends Error {
  constructor(code, message, data) {
    super(message || code);
    this.code = code;
    this.data = data;
  }
}

// agentActivity.setRead errors that mean Orca's window couldn't apply it (Orca's
// agent-pane-activity-relay.ts and runtime-client-state.ts), not that the call is wrong.
const WINDOW_REFUSALS = ['agent_activity_timeout', 'agent_activity_needs_desktop_window', 'agent_activity_not_ready', 'renderer_unavailable'];

// One connection to Orca's pipe, many requests on it (the server answers by id).
class RpcPipe {
  constructor(endpoint, token) {
    this.endpoint = endpoint;
    this.token = token;
    this.pending = new Map();
    this.buffer = '';
    this.closed = false;
    this.sock = null;
  }

  open(timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      let connected = false;
      let lastError = null;
      const sock = net.createConnection(this.endpoint);
      this.sock = sock;
      sock.setEncoding('utf8');
      const timer = setTimeout(() => sock.destroy(new Error('timed out connecting to Orca')), timeoutMs);
      sock.once('connect', () => {
        connected = true;
        clearTimeout(timer);
        resolve();
      });
      sock.on('data', (chunk) => this.onData(chunk));
      sock.on('error', (err) => {
        lastError = err;
      });
      sock.on('close', () => {
        clearTimeout(timer);
        this.closed = true;
        const err = new Error('Orca closed the connection');
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(err);
        }
        this.pending.clear();
        if (!connected) reject(lastError || err);
      });
    });
  }

  close() {
    this.closed = true;
    this.sock?.destroy();
  }

  call(method, params, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('not connected to Orca'));
      const id = randomUUID();
      const line = JSON.stringify({ id, authToken: this.token, method, params }) + '\n';
      if (Buffer.byteLength(line, 'utf8') > MAX_FRAME) return reject(new Error('That is too long to send to Orca in one go.'));
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.sock.write(line);
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    let i;
    while ((i = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      // Long polls send keepalives; they only mean "still working on it".
      if (msg?._keepalive) {
        for (const p of this.pending.values()) p.timer.refresh();
        continue;
      }
      const p = this.pending.get(msg?.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new OrcaRpcError(msg.error?.code || 'error', msg.error?.message || 'Orca refused the request', msg.error?.data));
    }
  }
}

// This computer's Orca: its runtime file names the pipe and token. open() resolves to
// { conn, origin, runtimeId } (a remote transport also hands back the status it read).
export class LocalTransport {
  constructor(userDataDir = defaultUserDataDir()) {
    this.userDataDir = userDataDir;
    this.remote = false;
  }

  async open() {
    let runtime;
    try {
      runtime = readRuntime(this.userDataDir);
    } catch (err) {
      throw err.code === 'ENOENT' ? Object.assign(new Error(NOT_RUNNING), { code: 'ENOENT' }) : err;
    }
    // A file left behind by an Orca that exited: don't connect to whatever has its pipe now.
    if (!processAlive(Number(runtime.pid))) throw Object.assign(new Error(NOT_RUNNING), { code: 'ENOENT' });
    const pipe = new RpcPipe(runtime.transport.endpoint, runtime.authToken);
    await pipe.open();
    return { conn: pipe, origin: runtime.transport.endpoint, runtimeId: runtime.runtimeId };
  }

  describeFailure(err) {
    if (err?.code === 'ENOENT' || err?.code === 'ECONNREFUSED' || err?.code === 'EPIPE') return NOT_RUNNING;
    if (err?.code === 'unauthorized') return "Orca didn't accept the bridge's token";
    return String(err?.message || err).split('\n')[0];
  }
}

// ---- terminal text -----------------------------------------------------------

export function stripAnsi(text) {
  return String(text ?? '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\t/g, '  ')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

// The last few meaningful lines of a terminal, for the game's chat view.
export function cleanTail(lines, max = TAIL_LINES) {
  const out = [];
  for (const raw of lines || []) {
    const line = stripAnsi(raw).trimEnd();
    if (!line && (!out.length || !out.at(-1))) continue; // no leading or doubled blanks
    out.push(line);
  }
  while (out.length && !out.at(-1)) out.pop();
  return out.slice(-max).join('\n').replace(/```/g, "'''");
}

// A TUI menu row: "❯ 1. Yes", "  2. Yes, and don't ask again", "› 3. No (esc)".
const OPTION_ROW = /^\s*(?:[❯›>▶➤→*]\s*)?(\d{1,2})[.)]\s+(.*\S)\s*$/;
const CHECKBOX = /^(?:\[[ xX✓✔*]?\]|[☐☑☒◻◼□■✔✓])\s*/;
const FREE_TEXT_ROW = /^(type something|other\b|none of the above|chat about this)/i;

function unbox(line) {
  return stripAnsi(line).replace(/^[\s│┃║]+/, '').replace(/[\s│┃║]+$/, '');
}

// The numbered menu nearest the bottom of the screen: its rows (with any indented
// description lines under them) and the question line above row 1.
export function parseMenu(lines) {
  const rows = (lines || []).map(unbox);
  let last = -1;
  for (let i = rows.length - 1; i >= Math.max(0, rows.length - 40); i--) {
    if (OPTION_ROW.test(rows[i])) {
      last = i;
      break;
    }
  }
  if (last < 0) return null;
  const options = [];
  let expect = Number(OPTION_ROW.exec(rows[last])[1]);
  let desc = [];
  let i = last;
  for (; i >= 0 && expect >= 1 && last - i < 40; i--) {
    const m = OPTION_ROW.exec(rows[i]);
    if (m && Number(m[1]) === expect) {
      options.unshift({ n: expect, label: m[2], description: desc.reverse().join(' ').trim() || undefined });
      desc = [];
      expect--;
      if (expect === 0) break;
    } else if (i !== last && rows[i].trim()) {
      desc.push(rows[i].trim());
    }
  }
  if (!options.length || options[0].n !== 1) return null;
  let question = '';
  for (let j = i - 1; j >= 0 && i - j <= 6; j--) {
    const t = rows[j].trim();
    if (!t || /^[─━═\-_~·.\s]+$/.test(t)) continue;
    question = t;
    break;
  }
  return { question, options };
}

const TYPE_ROW = /^(type something|other\b)/i;

// A menu row's label without the key hint some agents add: "No (esc)", "Yes (y)".
function rowLabel(label) {
  return String(label).replace(/\s*\((?:esc|tab|shift\+tab|y|a|n)\)\s*$/i, '');
}

// The question an agent is showing, in the shape bridge.js renders, plus what we
// need to answer it with keystrokes. Every option keeps its on-screen number as its
// value, so the key pressed is the row the player picked. Rows like "Type something"
// or "Chat about this" are the selector's own and come after the agent's options;
// one that comes before a real option is one of the agent's and stays an option.
export function questionFromMenu(menu, fallbackText) {
  let multiSelect = false;
  const rows = (menu?.options || []).map((o) => {
    let label = rowLabel(o.label);
    if (CHECKBOX.test(label)) {
      multiSelect = true;
      label = label.replace(CHECKBOX, '');
    }
    return { n: o.n, label, description: o.description };
  });
  let firstExtra = rows.length;
  while (firstExtra > 0 && FREE_TEXT_ROW.test(rows[firstExtra - 1].label)) firstExtra--;
  const extras = rows.slice(firstExtra);
  const typeRow = extras.find((r) => TYPE_ROW.test(r.label)) || extras[0];
  return {
    id: 'q1',
    header: 'Question',
    question: menu?.question || fallbackText || 'The agent is asking you something.',
    multiSelect,
    allowCustomAnswer: true,
    options: rows.slice(0, firstExtra).map((r) => ({ label: r.label, description: r.description, value: String(r.n) })),
    freeRow: typeRow ? typeRow.n : null,
  };
}

// The screen number of the row that takes typed text: the selector's own row, or the
// one after the last option when the menu doesn't show it.
function typeRowOf(q) {
  return q.freeRow ?? Number(q.options.at(-1)?.value || 0) + 1;
}

// Keystrokes that answer Claude Code's AskUserQuestion selector (ported from Orca's
// buildAskAnswerKeys, native-chat-ask-answer.ts): a digit picks a row, the type row
// takes typed text, multi-select toggles digits then submits.
export function claudeAnswerKeys(q, sel) {
  const keys = [];
  const typeRow = String(typeRowOf(q));
  if (q.multiSelect) {
    for (const i of sel.indices) keys.push({ raw: q.options[i].value });
    if (sel.other) keys.push({ raw: typeRow }, { text: sel.other }, { raw: '\r' });
    keys.push({ raw: '\x1b[C' }, { raw: '\r' });
  } else if (sel.other) {
    const labels = sel.indices.map((i) => q.options[i]?.label).filter(Boolean);
    keys.push({ raw: typeRow }, { text: [...labels, sel.other].join(', ') }, { raw: '\r' });
  } else if (sel.indices.length) {
    keys.push({ raw: q.options[sel.indices[0]].value });
  }
  return keys;
}

// Codex commits on the option's digit; a note goes on the picked row, or on the
// free-form row (buildCodexAskAnswerKeys in the same Orca file). Down moves one screen
// row from row 1, so the count comes from screen numbers too.
export function codexAnswerKeys(q, sel) {
  if (sel.other) {
    const target = sel.indices.length ? Number(q.options[sel.indices[0]].value) : typeRowOf(q);
    const keys = [];
    for (let i = 1; i < target; i++) keys.push({ raw: '\x1b[B' });
    keys.push({ raw: '\t' }, { text: sel.other }, { raw: '\r' });
    return keys;
  }
  return sel.indices.length ? [{ raw: q.options[sel.indices[0]].value }] : [];
}

const YES_ROW = /^(yes|allow|approve|proceed|accept|continue|trust|run)\b/i;
// Rows that allow more than this one request: "don't ask again", session-wide rules,
// and modes such as "Yes, and auto-accept edits" or "bypass permissions".
const ALWAYS_ROW = /don'?t ask again|do not ask again|\balways\b|this session|allow all|for the session|auto-?accept|\bbypass\b/i;

// An approval menu's "yes, once" row and its "don't ask again" row, if it has them.
export function approvalRows(menu) {
  const options = menu?.options || [];
  const always = options.find((o) => ALWAYS_ROW.test(o.label) && !/^(no|deny|reject|cancel)\b/i.test(o.label)) || null;
  const yes = options.find((o) => o !== always && YES_ROW.test(o.label) && !ALWAYS_ROW.test(o.label)) || null;
  return { yes, always };
}

// ---- mapping Orca rows to threads ----------------------------------------------

const AGENT_NAMES = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', gemini: 'Gemini', omp: 'OMP', pi: 'Pi', grok: 'Grok', cursor: 'Cursor', copilot: 'Copilot', amp: 'Amp' };
const iso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : undefined);
const shortHash = (s, n) => createHash('sha1').update(s).digest('base64url').slice(0, n);
const WAITING = new Set(['blocked', 'waiting']);

// The agents a new worktree can start with, for the game's picker (Orca checks the id
// against its own catalog, tui-agent-config.ts, and that the CLI is installed).
export const AGENT_CHOICES = Object.entries(AGENT_NAMES).map(([id, label]) => ({ id, label }));

export function agentName(type) {
  if (!type || type === 'unknown') return 'agent';
  return AGENT_NAMES[type] || type.charAt(0).toUpperCase() + type.slice(1);
}

// Short ids that survive the pixel strip (no RS/US/|/~), stable across polls and
// Orca restarts.
export function threadIdFor(worktreeId, paneKey) {
  return 'o' + shortHash(`${worktreeId}\n${paneKey}`, 14);
}

export function projectIdFor(repoId) {
  return 'r' + shortHash(String(repoId), 10);
}

function normTool(name) {
  return String(name || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

// What kind of tool an agent's status names, for labels and approval kinds.
function toolClass(toolName) {
  const t = normTool(toolName);
  if (!t) return null;
  if (t === 'askuserquestion' || t === 'requestuserinput') return 'question';
  if (/^(bash|shell|localshell|execcommand|exec|runcommand|runshellcommand|powershell|terminal|command)$/.test(t)) return 'command';
  if (/(edit|write|applypatch|patch|notebook|createfile|strreplace)/.test(t)) return 'file';
  if (t === 'websearch' || t === 'webfetch') return 'web';
  return 'tool';
}

function requestKind(agent) {
  switch (toolClass(agent.toolName)) {
    case 'question':
      return 'user_input';
    case 'command':
      return 'command';
    case 'file':
      return 'file-change';
    default:
      return 'permission';
  }
}

// A wait's identity: it changes whenever the agent enters a new wait, so a stale
// answer from the game is refused instead of landing on the next menu. With `seen`
// (what the player was shown: see seenFor), it also covers the tool, its input and
// the menu, so an answer only lands on the menu the player saw.
function requestIdFor(agent, seen) {
  const base = 'q' + Math.floor(agent.stateStartedAt || 0).toString(36);
  return seen === undefined ? base : `${base}.${shortHash(JSON.stringify(seen), 10)}`;
}

function seenFor(agent, menu, reason) {
  const input = agent.toolInput == null ? '' : typeof agent.toolInput === 'string' ? agent.toolInput : JSON.stringify(agent.toolInput);
  return [agent.toolName || '', input, reason || '', menu?.question || '', ...(menu?.options || []).map((o) => `${o.n}. ${o.label}`)];
}

function toolItem(agent, extra) {
  const input = agent.toolInput || undefined;
  switch (toolClass(agent.toolName)) {
    case 'command':
      return { type: 'command_execution', input, title: input, ...extra };
    case 'file':
      return { type: 'file_change', fileName: input, title: agent.toolName, ...extra };
    case 'web':
      return { type: 'web_search', input, title: agent.toolName, ...extra };
    default:
      return { type: 'dynamic_tool', toolName: agent.toolName || undefined, input, ...extra };
  }
}

// Orca's non-tool waits (terminal-contracts RuntimeTerminalWaitBlockedReason).
const WAIT_LABELS = {
  'agent-trust-workspace': 'Trust this folder',
  'codex-trust-workspace': 'Trust this folder',
  'agent-update-prompt': 'Answer an update prompt',
  'codex-update-prompt': 'Answer an update prompt',
  'agent-cwd-prompt': 'Confirm the working folder',
  'codex-cwd-prompt': 'Confirm the working folder',
  'agent-hooks-review-prompt': 'Review hooks',
  'codex-hooks-review-prompt': 'Review hooks',
  'codex-model-migration-prompt': 'Answer a model prompt',
  'agent-sign-in-prompt': 'Sign in again',
};
// Waits the game must not approve: Orca shows it one line of a prompt that grants a
// lot (trusting a folder runs its hooks and settings; a hooks review approves them).
// The game shows them as needing the computer and can still say no.
const COMPUTER_ONLY = new Set(['agent-trust-workspace', 'codex-trust-workspace', 'agent-hooks-review-prompt', 'codex-hooks-review-prompt']);
// Waits the game can't answer with Yes: signing in needs a browser, and a model
// migration prompt picks between models rather than saying yes.
const NOT_FROM_GAME = new Set(['codex-model-migration-prompt', 'agent-sign-in-prompt']);
const QUESTION_WAITS = new Set(['agent-interactive-prompt', 'codex-interactive-prompt']);

// Why the game can't approve a wait (it can still say No), or null when it can. This
// is decided when the request is shown, so the game never offers a Yes the bridge
// would refuse: a prompt that isn't a numbered menu (OpenCode's, say) or a menu with
// no row that says yes needs the computer.
function atComputerWhy(reason, menu) {
  if (COMPUTER_ONLY.has(reason)) return PC_ONE_LINE;
  if (NOT_FROM_GAME.has(reason)) return PC_NEEDS_COMPUTER;
  if (!menu) return PC_NO_MENU;
  if (!approvalRows(menu).yes) return PC_NO_YES;
  return null;
}

export class OrcaClient extends EventEmitter {
  constructor({ log = () => {}, userDataDir = defaultUserDataDir(), transport = null, pollMs, stateDir = null, keyDelayMs = KEY_DELAY_MS, retryMs = 1000, defaultAgent = 'claude', allowShell = false } = {}) {
    super();
    this.log = log;
    this.allowShell = allowShell === true;
    this.userDataDir = userDataDir;
    this.transport = transport || new LocalTransport(userDataDir);
    // Quick while an agent works or waits, slower when everything is idle.
    const busy = typeof pollMs === 'number' ? pollMs : pollMs?.busy || 2000;
    this.pollBusyMs = busy;
    this.pollIdleMs = typeof pollMs === 'number' ? busy * 3 : pollMs?.idle || 6000;
    this.stateDir = stateDir;
    this.keyDelayMs = keyDelayMs;
    this.retryMs = retryMs;
    this.defaultAgent = defaultAgent;
    this.state = 'disconnected';
    this.error = null;
    this.origin = null;
    this.config = { environment: { label: 'Orca', serverVersion: undefined }, providers: [] };
    this.olderSettled = 0;
    this.envs = [{ code: '', id: 'local', label: 'Orca', local: true }];
    this.threads = new Map();
    this.projects = new Map();
    this.refs = new Map(); // threadId -> { worktreeId, paneKey, repoId, row, agent }
    this.memory = new Map(); // threadId -> { runStart, lastDone, state }
    this.handles = new Map(); // handleKey(worktreeId, paneKey) -> terminal handle (runtime-scoped)
    this.keyLocks = new Map(); // handleKey(worktreeId, paneKey) -> the tail of its key sequences
    this.launched = new Map(); // threadId -> a just-started agent Orca doesn't list yet
    this.repos = new Map(); // repoId -> repo
    this.reposAt = 0;
    this.archived = this.loadArchived();
    this.pipe = null;
    this.opening = null;
    this.runtimeId = null;
    this.snapshotId = null;
    this.fresh = true; // next poll replaces everything (emits 'snapshot')
    this.backoff = retryMs;
    this.timer = null;
    this.stopped = true;
    this.ticking = null;
  }

  // ---- lifecycle -----------------------------------------------------------

  setState(state, error = null) {
    if (this.state === state && this.error === error) return;
    this.state = state;
    this.error = error;
    this.emit('state', state, error);
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.setState('connecting');
    this.schedule(0);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.pipe?.close();
    this.pipe = null;
    this.setState('disconnected');
  }

  schedule(ms) {
    clearTimeout(this.timer);
    if (this.stopped) return;
    this.timer = setTimeout(() => this.tick(), ms);
  }

  // Poll soon after a command, so the game sees its effect.
  pollSoon() {
    if (this.state === 'connected') this.schedule(250);
  }

  get busy() {
    for (const t of this.threads.values()) if (t.activityRunStatus || t.pendingRuntimeRequest || t.status === 'starting') return true;
    return false;
  }

  tick() {
    if (this.ticking) return this.ticking;
    this.ticking = (async () => {
      try {
        await this.poll();
        this.backoff = this.retryMs;
        this.schedule(this.busy ? this.pollBusyMs : this.pollIdleMs);
      } catch (err) {
        if (this.stopped) return;
        this.pipe?.close();
        this.pipe = null;
        this.setState('offline', this.describeFailure(err));
        this.schedule(this.backoff);
        this.backoff = Math.min(this.backoff * 2, 15000);
      }
    })().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  describeFailure(err) {
    return this.transport.describeFailure(err);
  }

  // A live pipe, reopening it (and re-reading the runtime file) when Orca closed it.
  // Orca reaps idle connections after 30 s; reopening is invisible to the game. A
  // paired socket is reopened (and re-authenticated) the same way.
  connection() {
    if (this.pipe && !this.pipe.closed) return Promise.resolve(this.pipe);
    // A poll and a command can both find the pipe gone; open one, not two.
    this.opening ||= this.openPipe().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  async openPipe() {
    this.pipe = null;
    const opened = await this.transport.open();
    const pipe = opened.conn;
    if (this.stopped) {
      pipe.close();
      throw new Error('stopped');
    }
    this.origin = opened.origin;
    if (opened.runtimeId !== this.runtimeId) {
      // A new Orca: terminal handles are runtime-scoped and its snapshot ids are new.
      this.runtimeId = opened.runtimeId;
      this.handles.clear();
      this.fresh = true;
    }
    this.snapshotId = null;
    this.pipe = pipe;
    if (this.state !== 'connected') {
      const status = opened.status || (await pipe.call('status.get', {}));
      if (status?.appVersion && status.appVersion !== this.config.environment.serverVersion) {
        this.config = { ...this.config, environment: { ...this.config.environment, serverVersion: status.appVersion } };
        this.emit('config');
      }
      this.log(`Orca: connected to ${this.origin}${status?.appVersion ? ` (Orca ${status.appVersion})` : ''}`);
      this.fresh = true;
      this.setState('connected');
    }
    return pipe;
  }

  async call(method, params, timeoutMs) {
    const pipe = await this.connection();
    try {
      return await pipe.call(method, params, timeoutMs);
    } catch (err) {
      // Orca may reap the connection just as a request goes out; reads are safe to
      // repeat on a fresh one, writes are not (they could land twice).
      if (!pipe.closed || !READS.has(method) || this.stopped) throw err;
      return (await this.connection()).call(method, params, timeoutMs);
    }
  }

  // ---- polling -------------------------------------------------------------

  async poll() {
    let reply = await this.call('worktree.ps', { afterSnapshotId: this.snapshotId });
    // The request named the snapshot from before a reconnect; a fresh start needs the rows.
    if (reply?.unchanged && this.fresh) reply = await this.call('worktree.ps', { afterSnapshotId: null });
    if (reply?.snapshotId) this.snapshotId = reply.snapshotId;
    if (reply?.unchanged && !this.fresh) return this.expireLaunched();
    const rows = Array.isArray(reply?.worktrees) ? reply.worktrees : [];
    if (Date.now() - this.reposAt > 60000 || rows.some((r) => r.repoId && !this.repos.has(r.repoId))) await this.loadRepos();
    this.apply(rows);
  }

  async loadRepos() {
    try {
      const res = await this.call('repo.list', {});
      this.repos = new Map((res?.repos || []).map((r) => [r.id, r]));
    } catch (err) {
      if (!(err instanceof OrcaRpcError)) throw err;
      this.log(`Orca: repo.list failed: ${err.message}`);
    }
    this.reposAt = Date.now();
  }

  expireLaunched() {
    let changed = false;
    for (const [id, l] of this.launched) {
      if (Date.now() - l.at > 90000) {
        this.launched.delete(id);
        if (this.threads.delete(id)) {
          changed = true;
          this.emit('change', { kind: 'removed', id });
        }
      }
    }
    return changed;
  }

  apply(rows) {
    const threads = new Map();
    const refs = new Map();
    for (const row of rows) {
      if (!row?.worktreeId || row.removing) continue;
      // Subagents nest under their lead: only leads get a thread.
      const agents = (row.agents || []).filter((a) => a?.paneKey && !a.parentPaneKey);
      const counts = {};
      for (const a of agents) counts[a.agentType] = (counts[a.agentType] || 0) + 1;
      const seen = {};
      for (const a of agents) {
        const id = threadIdFor(row.worktreeId, a.paneKey);
        seen[a.agentType] = (seen[a.agentType] || 0) + 1;
        const suffix = counts[a.agentType] > 1 ? ` ${seen[a.agentType]}` : '';
        refs.set(id, { worktreeId: row.worktreeId, paneKey: a.paneKey, repoId: row.repoId, row, agent: a });
        threads.set(id, this.toThread(id, row, a, suffix));
        this.launched.delete(id);
      }
    }
    for (const [id, l] of this.launched) {
      if (Date.now() - l.at > 90000) this.launched.delete(id);
      else threads.set(id, l.thread);
    }
    const projects = new Map();
    for (const repo of this.repos.values()) {
      const pid = projectIdFor(repo.id);
      projects.set(pid, { id: pid, title: repo.displayName || path.basename(repo.path || '') || 'Project', repoId: repo.id });
    }
    for (const row of rows) {
      const pid = projectIdFor(row.repoId);
      if (row.repoId && !projects.has(pid)) projects.set(pid, { id: pid, title: row.repo || 'Project', repoId: row.repoId });
    }

    const projectsChanged = JSON.stringify([...projects.values()]) !== JSON.stringify([...this.projects.values()]);
    this.projects = projects;
    const prevThreads = this.threads;
    this.threads = threads;
    this.refs = refs;
    if (this.fresh) {
      this.fresh = false;
      this.emit('change', { kind: 'snapshot' });
      return;
    }
    for (const [id, t] of threads) {
      const prev = prevThreads.get(id);
      if (!prev || JSON.stringify(prev) !== JSON.stringify(t)) this.emit('change', { kind: 'thread', id, thread: t, prev });
    }
    for (const id of prevThreads.keys()) if (!threads.has(id)) this.emit('change', { kind: 'removed', id });
    if (projectsChanged) this.emit('change', { kind: 'project' });
  }

  toThread(id, row, a, suffix = '') {
    const working = a.state === 'working';
    const waiting = WAITING.has(a.state);
    // Run start and end aren't in one row: remember them across polls.
    const mem = this.memory.get(id) || {};
    if ((working || waiting) && !(mem.state === 'working' || WAITING.has(mem.state))) mem.runStart = a.stateStartedAt;
    if (a.state === 'done') mem.lastDone = a.stateStartedAt;
    mem.state = a.state;
    mem.createdAt ||= row.createdAt || a.stateStartedAt;
    this.memory.set(id, mem);

    const archivedAt = this.archived.get(id);
    if (archivedAt && working && a.stateStartedAt > archivedAt) this.unarchive(id);
    const unread = a.activity?.listed ? !!a.activity.unread : !!row.unread;
    const completed = iso(mem.lastDone);
    const name = row.displayName || path.basename(String(row.path || '')) || row.branch || 'worktree';
    return {
      id,
      projectId: projectIdFor(row.repoId),
      title: `${name} · ${agentName(a.agentType)}${suffix}`,
      status: working || waiting ? 'running' : a.interrupted ? 'interrupted' : row.status === 'inactive' ? 'idle' : 'ready',
      createdAt: iso(mem.createdAt),
      updatedAt: iso(a.updatedAt || a.stateStartedAt),
      branch: row.branch || undefined,
      pendingRuntimeRequest: waiting ? { id: requestIdFor(a), kind: requestKind(a) } : null,
      activityRunStatus: working ? 'running' : undefined,
      activityRunStartedAt: working || waiting ? iso(mem.runStart) : undefined,
      latestRunStartedAt: iso(mem.runStart),
      latestRunCompletedAt: completed,
      // Orca keeps an unread flag rather than a visit time; isUnread compares the two.
      lastVisitedAt: unread ? undefined : completed,
      settledOverride: row.workspaceStatus === 'completed' ? 'settled' : undefined,
      archivedAt: row.isArchived ? iso(row.lastActivityAt || a.updatedAt) || new Date(0).toISOString() : this.archived.has(id) ? iso(this.archived.get(id)) : undefined,
      latestVisibleMessage: a.lastAssistantMessage ? { role: 'assistant', text: a.lastAssistantMessage } : undefined,
    };
  }

  // ---- archive bookkeeping (Orca has no per-agent archive) ------------------

  archiveFile() {
    return this.stateDir ? path.join(this.stateDir, 'orca-archived.json') : null;
  }

  loadArchived() {
    try {
      return new Map(Object.entries(JSON.parse(fs.readFileSync(this.archiveFile(), 'utf8'))));
    } catch {
      return new Map();
    }
  }

  saveArchived() {
    const file = this.archiveFile();
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(Object.fromEntries(this.archived)));
    } catch (err) {
      this.log(`Orca: couldn't save archived threads: ${err.message}`);
    }
  }

  unarchive(id) {
    if (this.archived.delete(id)) this.saveArchived();
  }

  // ---- terminals -----------------------------------------------------------

  ref(threadId) {
    const r = this.refs.get(threadId) || this.launched.get(threadId);
    if (!r) throw new Error('That agent is gone from Orca.');
    return r;
  }

  // The latest row for a thread, polling first so answers go to the current wait.
  async liveRef(threadId) {
    await this.tick();
    return this.ref(threadId);
  }

  // The terminal handle of an agent's pane: join terminal.list rows to the paneKey
  // (the join Orca's CLI guide prescribes).
  // Pane keys (`<tabId>:<leafId>`) are only unique within a worktree, so the cache is
  // keyed by both.
  async handleFor(ref, refresh = false) {
    const key = handleKey(ref.worktreeId, ref.paneKey);
    if (!refresh && this.handles.has(key)) return this.handles.get(key);
    const res = await this.call('terminal.list', { worktree: `id:${ref.worktreeId}`, includePreview: false });
    for (const t of res?.terminals || []) {
      if (t.tabId && t.leafId && t.handle) this.handles.set(handleKey(t.worktreeId || ref.worktreeId, `${t.tabId}:${t.leafId}`), t.handle);
    }
    return this.handles.get(key) || null;
  }

  async withHandle(ref, fn) {
    let handle = await this.handleFor(ref);
    if (!handle) handle = await this.handleFor(ref, true);
    if (!handle) throw new Error('That agent has no terminal Orca can type into (is it an Orca chat? Answer it in Orca).');
    try {
      return await fn(handle);
    } catch (err) {
      if (!STALE_HANDLE.has(err?.code)) throw err;
      this.handles.delete(handleKey(ref.worktreeId, ref.paneKey));
      const again = await this.handleFor(ref, true);
      if (!again || again === handle) throw err;
      return fn(again);
    }
  }

  async type(handle, text, extra = {}) {
    const res = await this.call('terminal.send', { terminal: handle, text, ...extra, client: CLIENT }, extra.agentPrompt ? 30000 : 15000);
    const send = res?.send;
    if (send && send.accepted === false) {
      throw new Error(send.refusedReason === 'permission' ? 'The agent is waiting for an approval; answer it first.' : send.refusedReason === 'no-agent' ? 'No agent is running in that terminal.' : 'Orca refused the input.');
    }
    return send;
  }

  async screen(handle) {
    const res = await this.call('terminal.read', { terminal: handle, screen: true });
    let read = res?.terminal;
    // Older Orca ignores `screen` and returns the stream; a host without a screen says so.
    if (!read?.tail?.length || read.source === 'screen-unavailable') {
      const s = await this.call('terminal.read', { terminal: handle, limit: 200 });
      read = s?.terminal || read;
    }
    return read?.tail || [];
  }

  // A wait as the player sees it, read fresh: the menu, Orca's reason for the wait and
  // the request id covering both. Read errors other than a stale handle (which
  // withHandle retries) become "couldn't read": nothing is pressed blind.
  async readWait(handle, agent) {
    let lines;
    let wait;
    try {
      lines = await this.screen(handle);
      wait = (await this.call('terminal.show', { terminal: handle }))?.terminal?.agentWait || null;
    } catch (err) {
      if (STALE_HANDLE.has(err?.code)) throw err;
      this.log(`Orca: couldn't read a waiting agent's terminal: ${err.message}`);
      throw new Error(UNREADABLE);
    }
    const menu = parseMenu(lines);
    const reason = wait?.reason;
    return { menu, reason, id: requestIdFor(agent, seenFor(agent, menu, reason)) };
  }

  // Pass text from the game through gameText first: this only looks at what's typed.
  checkShell(text) {
    if (this.allowShell) return;
    if (String(text ?? '').split(LINE_BREAK).some((line) => SHELL_LINE.test(line))) throw new Error(SHELL_REFUSED);
  }

  // Answers (several keys) and approvals (read the screen, then press) hold their
  // pane's key lock, and so does Stop. The bridge doesn't queue Stop behind other
  // commands for the thread, so this keeps its Escape out of the middle of an answer:
  // there it would close the selector, and the rest would be typed into the prompt box.
  async withKeyLock(ref, fn) {
    const key = handleKey(ref.worktreeId, ref.paneKey);
    const prev = this.keyLocks.get(key) || Promise.resolve();
    let release;
    const held = new Promise((r) => (release = r));
    const tail = prev.then(() => held);
    this.keyLocks.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.keyLocks.get(key) === tail) this.keyLocks.delete(key);
    }
  }

  // ---- reads ---------------------------------------------------------------

  async threadProjection(threadId) {
    const ref = this.ref(threadId);
    const a = ref.agent;
    const mem = this.memory.get(threadId) || {};
    const working = a.state === 'working';
    const waiting = WAITING.has(a.state);
    // An agent first seen already done has no known start; don't invent one.
    const runAt = mem.runStart || a.stateStartedAt;
    const runId = `run-${Math.floor(runAt || 0).toString(36)}`;
    const proj = { messages: [], runs: [], turnItems: [], runtimeRequests: [] };
    if (a.prompt) proj.messages.push({ role: 'user', text: a.prompt, createdAt: iso(runAt) });
    if (ref.pending) return proj; // just launched: Orca has no terminal for it yet

    let lines = [];
    let wait = null;
    try {
      await this.withHandle(ref, async (handle) => {
        lines = await this.screen(handle);
        if (waiting) wait = (await this.call('terminal.show', { terminal: handle }))?.terminal?.agentWait || null;
      });
    } catch (err) {
      this.log(`Orca: couldn't read ${threadId}'s terminal: ${err.message}`);
    }
    const tail = cleanTail(lines);
    const tailMsg = tail ? { role: 'assistant', text: '```text\n' + tail + '\n```', createdAt: iso(Date.now()), streaming: working || undefined } : null;
    const reply = a.lastAssistantMessage ? { role: 'assistant', text: a.lastAssistantMessage, createdAt: iso(a.updatedAt) } : null;
    // A finished agent's reply stays last, so read-aloud and list previews use it
    // rather than the terminal frame; while it works, the live terminal goes last.
    if (a.state === 'done' && reply) proj.messages.push(...[tailMsg, reply].filter(Boolean));
    else proj.messages.push(...[reply, tailMsg].filter(Boolean));

    if (runAt) {
      proj.runs.push({
        id: runId,
        status: working || waiting ? 'running' : a.interrupted ? 'interrupted' : 'completed',
        startedAt: iso(mem.runStart),
        completedAt: a.state === 'done' ? iso(a.stateStartedAt) : undefined,
      });
    }
    if (working && a.toolName) proj.turnItems.push(toolItem(a, { runId, status: 'running', nodeId: `tool-${a.updatedAt}` }));
    if (waiting) {
      const reason = wait?.reason;
      const menu = parseMenu(lines);
      // The same id respondApproval/respondAnswers recompute from the screen before
      // pressing anything.
      const requestId = requestIdFor(a, seenFor(a, menu, reason));
      const nodeId = `wait-${requestId}`;
      let kind = requestKind(a);
      if (QUESTION_WAITS.has(reason)) kind = 'user_input';
      else if (WAIT_LABELS[reason]) kind = 'permission';
      proj.runtimeRequests.push({ id: requestId, status: 'pending', kind, nodeId });
      if (kind === 'user_input') {
        const { freeRow, ...q } = questionFromMenu(menu, a.toolInput);
        proj.turnItems.push({ type: 'user_input_request', requestId, runId, nodeId, status: 'pending', questions: [q] });
      } else {
        // `atComputer`: the game may only say No (`pc`), and `atComputerWhy` says why.
        const why = atComputerWhy(reason, menu);
        const pc = why ? { atComputer: true, atComputerWhy: why } : {};
        if (WAIT_LABELS[reason]) {
          proj.turnItems.push({ type: 'dynamic_tool', toolName: WAIT_LABELS[reason], input: menu?.question || undefined, runId, nodeId, status: 'pending', wait: true, ...pc });
        } else {
          // The game shows the exact rows it would press: the yes row's label when it
          // says more than "Yes", and the "don't ask again" row (null: none).
          const { yes, always } = approvalRows(menu);
          proj.turnItems.push(toolItem(a, { runId, nodeId, status: 'pending', yesLabel: yes ? rowLabel(yes.label) : undefined, alwaysLabel: always ? rowLabel(always.label) : null, ...pc }));
        }
      }
    }
    return proj;
  }

  // ---- writes --------------------------------------------------------------

  async sendMessage(threadId, text, mode = 'auto', attachments = []) {
    // Claude Code and Codex take typed prompts while they work and queue or steer
    // them themselves, so every mode is the same keystrokes.
    void mode;
    text = gameText(text);
    this.checkShell(text);
    const ref = this.ref(threadId);
    if (ref.pending) throw new Error('That agent is still starting. Try again in a moment.');
    const full = withAttachments(text, attachments);
    await this.withHandle(ref, (handle) => this.type(handle, full, { enter: true, agentPrompt: true })).catch((err) => {
      if (err?.code === 'agent_prompt_blocked') throw new Error('The agent is waiting for an approval; answer it first.');
      throw err;
    });
    // New work takes a settled agent off the Done column.
    if (ref.row?.workspaceStatus === 'completed') {
      await this.call('worktree.set', { worktree: `id:${ref.worktreeId}`, workspaceStatus: 'in-progress' }).catch((err) => this.log(`Orca: worktree.set: ${err.message}`));
    }
    this.pollSoon();
  }

  // Agents read images from disk, so a screenshot becomes a file whose path goes
  // into the prompt.
  async uploadImage(routeKey, data, name = 'screenshot.png', mime = 'image/png') {
    void routeKey;
    if (this.transport.remote) return this.uploadRemoteImage(data, name, mime);
    const dir = this.stateDir ? path.join(this.stateDir, 'shots') : path.join(os.tmpdir(), 'orca-wow-shots');
    fs.mkdirSync(dir, { recursive: true });
    pruneShots(dir);
    const ext = (/\.[a-z0-9]{1,5}$/i.exec(name)?.[0] || `.${String(mime).split('/')[1] || 'png'}`).toLowerCase();
    const base = String(name).replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[^\w.-]+/g, '_').slice(0, 40) || 'screenshot';
    const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${base}-${randomUUID().slice(0, 6)}${ext}`);
    fs.writeFileSync(file, data);
    return { type: 'image', path: file, name, mimeType: mime, sizeBytes: data.length };
  }

  // An agent on another computer can't open this PC's files, so the image goes to
  // that host the way Orca's phone sends a pasted image: clipboard.startImageUpload,
  // 512 KB base64 chunks, then commit, which saves it to the host's temp folder and
  // returns the path there (src/main/runtime/rpc/methods/clipboard/clipboard.ts).
  async uploadRemoteImage(data, name, mime) {
    const content = Buffer.from(data).toString('base64');
    const ext = (/\.[a-z0-9]{1,5}$/i.exec(name)?.[0] || `.${String(mime).split('/')[1] || 'png'}`).toLowerCase();
    const fileName = `${String(name).replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[^\w.-]+/g, '_').slice(0, 40) || 'screenshot'}${ext}`;
    const { uploadId } = (await this.call('clipboard.startImageUpload', { expectedBase64Length: content.length, fileName })) || {};
    if (!uploadId) throw new Error("Orca didn't start the image upload.");
    let hostPath;
    try {
      for (let offset = 0; offset < content.length; offset += IMAGE_CHUNK) {
        await this.call('clipboard.appendImageUploadChunk', { uploadId, offset, contentBase64: content.slice(offset, offset + IMAGE_CHUNK) }, 30000);
      }
      hostPath = await this.call('clipboard.commitImageUpload', { uploadId }, 30000);
    } catch (err) {
      this.call('clipboard.abortImageUpload', { uploadId }).catch(() => {});
      throw err;
    }
    if (typeof hostPath !== 'string' || !hostPath) throw new Error("Orca didn't say where it saved the image.");
    return { type: 'image', path: hostPath, name, mimeType: mime, sizeBytes: data.length };
  }

  // A new worktree in that repo with an agent started on `text`. worktree.create
  // with startupAgent/startupPrompt starts a terminal agent on every Orca version
  // that has the pipe (the CLI's fallback path, worktree-create-agent-launch.ts),
  // and its reply names the agent's terminal, which gives us the new thread id.
  // opts: { agent (an AGENT_NAMES id), name (the worktree's name as typed), baseBranch }.
  async launchThread(projectId, text, attachments = [], opts = {}) {
    const project = this.projects.get(projectId);
    if (!project) throw new Error('That project is gone from Orca.');
    const agent = opts.agent || (AGENT_NAMES[opts.model?.instanceId] ? opts.model.instanceId : this.defaultAgent);
    if (!AGENT_NAMES[agent]) throw new Error(`Orca doesn't know an agent called "${agent}".`);
    text = gameText(text);
    this.checkShell(text);
    const prompt = withAttachments(text, attachments);
    const base = { repo: `id:${project.repoId}`, noParent: true, startupAgent: agent, startupPrompt: prompt, launchSource: 'cli' };
    const baseBranch = String(opts.baseBranch || '').trim();
    if (baseBranch) {
      const why = refNameProblem(baseBranch);
      if (why) throw new Error(`"${baseBranch}" can't be a base branch: ${why}.`);
      base.baseBranch = baseBranch;
    }
    // A typed name is used as is (Orca refuses one that's taken, and we say so); a
    // generated one gets a suffix on a collision.
    const typed = String(opts.name || '').trim();
    if (typed) {
      if (!/^[\w.\-/]+$/.test(typed)) throw new Error('Worktree names can use letters, digits, ".", "-", "_" and "/".');
      const why = refNameProblem(typed);
      if (why) throw new Error(`"${typed}" can't be a worktree name: ${why}.`);
    }
    let name = typed || slugName(opts.title || text);
    if (!typed) base.nameWasGenerated = true;
    let created;
    for (let attempt = 0; ; attempt++) {
      try {
        created = await this.call('worktree.create', { ...base, name }, 180000);
        break;
      } catch (err) {
        if (attempt >= 3) throw err;
        // A repo with a setup script asks the caller first; the game can't answer, so
        // skip it (the agent can install what it needs).
        if (/setup decision required/i.test(err?.message)) {
          this.log('Orca: repo wants a setup decision; creating without running setup');
          base.setupDecision = 'skip';
        } else if (err?.code === 'worktree_create_collision' || err?.code === 'worktree_create_exact_name_taken') {
          if (typed) throw new Error(`There's already a worktree called "${typed}" in ${project.title}. Pick another name.`);
          name = `${slugName(opts.title || text)}-${randomUUID().slice(0, 4)}`;
        } else {
          throw err;
        }
      }
    }
    const worktreeId = created?.worktree?.id;
    const handle = created?.agentTerminalHandle || created?.startupTerminal?.handle;
    this.pollSoon();
    if (!worktreeId || !handle) return {};
    let shown;
    try {
      shown = (await this.call('terminal.show', { terminal: handle }))?.terminal;
    } catch (err) {
      this.log(`Orca: terminal.show after create: ${err.message}`);
    }
    if (!shown?.tabId || !shown?.leafId) return {};
    const paneKey = `${shown.tabId}:${shown.leafId}`;
    const threadId = threadIdFor(worktreeId, paneKey);
    this.handles.set(handleKey(worktreeId, paneKey), handle);
    if (!this.threads.has(threadId)) {
      // Until Orca lists the agent, show it as starting so the game can open it.
      const now = Date.now();
      const agentRow = { paneKey, state: 'starting', agentType: agent, prompt: text, stateStartedAt: now, updatedAt: now };
      const row = { worktreeId, repoId: project.repoId, displayName: created.worktree.displayName || name, branch: created.worktree.branch, path: created.worktree.path };
      const thread = {
        ...this.toThread(threadId, row, agentRow),
        status: 'starting',
        title: `${row.displayName} · ${agentName(agent)}`,
      };
      this.memory.delete(threadId);
      this.launched.set(threadId, { worktreeId, paneKey, repoId: project.repoId, row, agent: agentRow, pending: true, at: now, thread });
      this.threads.set(threadId, thread);
      this.emit('change', { kind: 'thread', id: threadId, thread, prev: undefined });
    }
    return { threadId };
  }

  async interrupt(threadId) {
    const ref = this.ref(threadId);
    if (ref.agent.state !== 'working' && !WAITING.has(ref.agent.state)) throw new Error('nothing is running in that thread');
    await this.withKeyLock(ref, () =>
      this.withHandle(ref, async (handle) => {
        await this.type(handle, ESC);
        // OpenCode needs a second Escape (Orca's nativeChatStopSendsSecondEscape).
        if (ref.agent.agentType === 'opencode') {
          await sleep(Math.max(this.keyDelayMs, 1));
          await this.type(handle, ESC);
        }
      }),
    );
    this.pollSoon();
  }

  // Answer an approval menu the way Orca's phone does: the option's digit, no Enter
  // (Claude Code and Codex pick on the digit), or Escape to say no. The menu is read
  // again first and must be the one the player saw (the request id covers it); "don't
  // ask again" presses the row whose label the game showed. Nothing is pressed when
  // the screen or its menu can't be read.
  async respondApproval(threadId, requestId, decision = 'accept') {
    const ref = await this.liveRef(threadId);
    this.checkWait(ref, requestId);
    const no = decision === 'decline' || decision === 'cancel';
    await this.withKeyLock(ref, () =>
      this.withHandle(ref, async (handle) => {
        // Escape only ever says no to this wait (checkWait made sure it's the same
        // one), so it needs neither the menu nor the exact question the game showed.
        if (no) return this.type(handle, ESC);
        const seen = await this.readWait(handle, ref.agent);
        if (seen.id !== requestId) throw new Error(CHANGED);
        if (COMPUTER_ONLY.has(seen.reason) || NOT_FROM_GAME.has(seen.reason)) throw new Error(AT_COMPUTER);
        if (!seen.menu) throw new Error(NO_MENU);
        const { yes, always } = approvalRows(seen.menu);
        const forGood = decision === 'acceptForSession' || decision === 'acceptAlways';
        const row = forGood ? always : yes;
        if (!row) throw new Error(forGood ? NO_ALWAYS : NO_YES);
        return this.type(handle, String(row.n));
      }),
    );
    this.pollSoon();
  }

  // answers: { q1: '2' | ['1', '3'] | 'free text' }. Digits name the options we
  // offered (their on-screen numbers); anything else is typed into the selector's
  // free-text row. As with approvals, the menu must still be the one the player saw.
  async respondAnswers(threadId, requestId, answers = {}) {
    const ref = await this.liveRef(threadId);
    this.checkWait(ref, requestId);
    const given = [].concat(answers.q1 ?? Object.values(answers)[0] ?? []).map(gameText).filter((v) => v.trim());
    if (!given.length) throw new Error('No answer to send.');
    await this.withKeyLock(ref, () => this.withHandle(ref, async (handle) => {
      const seen = await this.readWait(handle, ref.agent);
      if (seen.id !== requestId) throw new Error(CHANGED);
      if (COMPUTER_ONLY.has(seen.reason) || NOT_FROM_GAME.has(seen.reason)) throw new Error(AT_COMPUTER);
      const q = questionFromMenu(seen.menu, ref.agent.toolInput);
      const indices = [];
      const other = [];
      for (const v of given) {
        const opt = q.options.findIndex((o) => o.value === v || o.label === v);
        if (opt >= 0) indices.push(opt);
        else other.push(v);
      }
      for (const v of other) this.checkShell(v);
      const sel = { indices, other: other.join(', ') };
      let keys;
      if (!q.options.length) keys = [{ text: sel.other || given.join(', ') }, { raw: '\r' }];
      else keys = ref.agent.agentType === 'codex' ? codexAnswerKeys(q, sel) : claudeAnswerKeys(q, sel);
      for (let i = 0; i < keys.length; i++) {
        if (i) await sleep(this.keyDelayMs);
        await this.type(handle, keys[i].raw ?? keys[i].text);
      }
    }));
    this.pollSoon();
  }

  checkWait(ref, requestId) {
    if (!WAITING.has(ref.agent.state)) throw new Error("The agent isn't waiting for an answer any more.");
    if (!requestId) throw new Error(CHANGED);
    if (String(requestId).split('.')[0] !== requestIdFor(ref.agent)) throw new Error('That question was already answered.');
  }

  async settle(threadId) {
    const ref = this.ref(threadId);
    await this.call('worktree.set', { worktree: `id:${ref.worktreeId}`, workspaceStatus: 'completed', isUnread: false, acknowledgeAttention: true });
    void this.markRead(ref);
    this.pollSoon();
  }

  async unsettle(threadId) {
    const ref = this.ref(threadId);
    await this.call('worktree.set', { worktree: `id:${ref.worktreeId}`, workspaceStatus: 'in-progress' });
    this.pollSoon();
  }

  async archive(threadId) {
    const ref = this.ref(threadId);
    await this.call('worktree.sleep', { worktree: `id:${ref.worktreeId}` }, 60000);
    this.archived.set(threadId, Date.now());
    this.saveArchived();
    const prev = this.threads.get(threadId);
    if (prev) {
      const thread = { ...prev, archivedAt: new Date().toISOString() };
      this.threads.set(threadId, thread);
      this.emit('change', { kind: 'thread', id: threadId, thread, prev });
    }
    this.pollSoon();
  }

  async visit(threadId) {
    const ref = this.ref(threadId);
    void this.markRead(ref);
    const prev = this.threads.get(threadId);
    if (ref.row?.unread) {
      await this.call('worktree.set', { worktree: `id:${ref.worktreeId}`, isUnread: false, acknowledgeAttention: true });
    }
    // Show it read right away instead of after the next poll.
    if (prev && prev.latestRunCompletedAt && prev.lastVisitedAt !== prev.latestRunCompletedAt) {
      const thread = { ...prev, lastVisitedAt: prev.latestRunCompletedAt };
      this.threads.set(threadId, thread);
      this.emit('change', { kind: 'thread', id: threadId, thread, prev });
    }
    this.pollSoon();
  }

  // The desktop Agents list keeps its own per-pane read state; older Orca lacks it. Orca
  // applies agentActivity.setRead in its window and gives up after 10 s when the window
  // doesn't answer (closed, hidden or asleep on that computer), so visits don't wait for
  // it: reads go out one batch at a time, and a window that can't take them is logged
  // once until a read gets through again. worktree.set still clears the unread dot.
  markRead(ref) {
    (this.readsToSend ??= new Set()).add(ref.paneKey);
    this.sendingReads ??= this.sendReads().finally(() => {
      this.sendingReads = null;
    });
    return this.sendingReads;
  }

  async sendReads() {
    while (this.readsToSend.size && !this.stopped) {
      const paneKeys = [...this.readsToSend];
      this.readsToSend.clear();
      try {
        await this.call('agentActivity.setRead', { paneKeys, read: true });
        this.readRefusal = null;
      } catch (err) {
        if (err?.code === 'method_not_found') continue;
        const reason = WINDOW_REFUSALS.find((r) => r === err?.code || r === err?.message);
        if (!reason) {
          this.log(`Orca: agentActivity.setRead: ${err.message}`);
        } else if (this.readRefusal !== reason) {
          this.readRefusal = reason;
          this.log(`Orca: couldn't mark agents read in Orca's Agents list at ${this.origin} (${reason}). Orca's window on that computer has to be open and awake for that; the game still shows them as read.`);
        }
      }
    }
  }

  // The new-worktree picker: which agents, and which one is preselected.
  agentChoices() {
    return { list: AGENT_CHOICES, default: this.defaultAgent };
  }

  environments() {
    return [{ code: '', label: 'Orca', local: true, state: this.state, error: this.error || undefined, threads: this.threads.size }];
  }
}

function handleKey(worktreeId, paneKey) {
  return `${worktreeId}\n${paneKey}`;
}

// Why a name typed in the game can't be a git branch (git check-ref-format's rules),
// or null. Names go to Orca, which hands them to git; a leading "-" would read as an
// option there.
export function refNameProblem(name) {
  const s = String(name);
  if (/[\x00-\x20\x7f]/.test(s)) return 'it has spaces or control characters';
  if (/[~^:?*[\\]/.test(s)) return 'it has one of ~ ^ : ? * [ \\';
  if (s.startsWith('-')) return 'it starts with "-"';
  if (s.startsWith('/') || s.endsWith('/')) return 'it starts or ends with "/"';
  if (s.includes('//')) return 'it has "//"';
  if (s.includes('..')) return 'it has ".."';
  if (s.includes('@{') || s === '@') return 'it has "@{"';
  if (s.endsWith('.')) return 'it ends with "."';
  if (s.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock'))) return 'a part of it starts with "." or ends with ".lock"';
  return null;
}

function withAttachments(text, attachments = []) {
  const paths = (attachments || []).map((a) => a?.path).filter(Boolean);
  if (!paths.length) return text;
  return `${text}\n\n${paths.length === 1 ? 'Screenshot' : 'Screenshots'} from the game (open to view):\n${paths.map((p) => `- ${p}`).join('\n')}`;
}

// A worktree/branch name from the prompt's first words.
function slugName(text) {
  const words = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .join('-')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `wow-${words || 'task'}`;
}

// Screenshots only matter until the agent has read them; keep a day's worth.
function pruneShots(dir) {
  try {
    const cutoff = Date.now() - 24 * 3600 * 1000;
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true });
    }
  } catch {}
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
