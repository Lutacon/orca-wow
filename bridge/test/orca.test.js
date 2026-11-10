import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { OrcaClient, readRuntime, parseMenu, threadIdFor, projectIdFor } from '../src/orca.js';
import { threadStatus, isUnread } from '../src/t3.js';
import { pendingRequest, activityLabel, runSummary } from '../src/bridge.js';
import { FakeOrca, tempDir, worktreeRow, agentRow } from './support/fake-orca.js';

const CLAUDE_MENU = [
  ' Bash command',
  '',
  '   npm test',
  '   Run the unit tests',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  "   2. Yes, and don't ask again for npm test commands in C:\\src\\app",
  '   3. No, and tell Claude what to do differently (esc)',
];

async function waitFor(fn, ms = 4000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

// A fake Orca with one connected client; `logs` collects everything it logged.
async function setup(t, script = () => {}) {
  const dir = tempDir();
  const orca = new FakeOrca({ dir });
  script(orca);
  await orca.start();
  const logs = [];
  const stateDir = tempDir();
  const client = new OrcaClient({ userDataDir: dir, stateDir, pollMs: 40, keyDelayMs: 1, retryMs: 50, log: (...a) => logs.push(a.join(' ')) });
  const events = [];
  client.on('change', (ev) => events.push(ev));
  client.on('state', (s, e) => logs.push(`state ${s} ${e || ''}`));
  client.start();
  t.after(async () => {
    client.stop();
    await orca.stop().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
  await waitFor(() => client.state === 'connected' && events.some((e) => e.kind === 'snapshot'));
  return { orca, client, logs, events, dir };
}

const only = (client) => [...client.threads.values()][0];

test('readRuntime takes the transports list or the older single transport', () => {
  const dir = tempDir();
  const file = path.join(dir, 'orca-runtime.json');
  fs.writeFileSync(file, JSON.stringify({ runtimeId: 'r', pid: 1, transports: [{ kind: 'websocket', endpoint: 'ws://x' }, { kind: 'named-pipe', endpoint: '\\\\.\\pipe\\o' }], authToken: 't', startedAt: 1 }));
  assert.equal(readRuntime(dir).transport.endpoint, '\\\\.\\pipe\\o');
  fs.writeFileSync(file, JSON.stringify({ runtimeId: 'r', pid: 1, transport: { kind: 'unix', endpoint: '/tmp/o.sock' }, authToken: 't', startedAt: 1 }));
  assert.equal(readRuntime(dir).transport.endpoint, '/tmp/o.sock');
  fs.rmSync(file);
  assert.throws(() => readRuntime(dir), { code: 'ENOENT' });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('connects and turns worktrees and agents into threads and projects', async (t) => {
  const { client, orca } = await setup(t, (o) => {
    o.repos.push({ id: 'repo-2', path: 'C:/src/other', displayName: 'other' });
    o.worktrees = [
      worktreeRow({ agents: [agentRow(), agentRow({ paneKey: 'tab-2:leaf-1', state: 'done', agentType: 'codex' }), agentRow({ paneKey: 'tab-1:leaf-9', parentPaneKey: 'tab-1:leaf-1' })] }),
      worktreeRow({ worktreeId: 'repo-1::C:/src/app/empty', displayName: 'empty', agents: [] }),
    ];
  });
  assert.equal(client.threads.size, 2, 'one thread per lead agent; subagents and empty worktrees skipped');
  const id = threadIdFor('repo-1::C:/src/app/fix-login', 'tab-1:leaf-1');
  const th = client.threads.get(id);
  assert.ok(th);
  assert.ok(id.length <= 48 && !/[\x1e\x1f|~]/.test(id));
  assert.equal(th.title, 'fix-login · Claude');
  assert.equal(th.branch, 'fix-login');
  assert.equal(th.projectId, projectIdFor('repo-1'));
  assert.equal(client.projects.get(projectIdFor('repo-1')).title, 'app');
  assert.equal(client.projects.get(projectIdFor('repo-2')).title, 'other');
  assert.equal(client.config.environment.serverVersion, '1.4.300');
  assert.equal(client.origin, orca.endpoint);
  assert.deepEqual(client.environments(), [{ code: '', label: 'Orca', local: true, state: 'connected', error: undefined, threads: 2 }]);
  assert.deepEqual(client.modelGroups(), []);
  assert.equal(client.defaultModelFor(), null);
  assert.throws(() => client.setModel(), /choose their own model/);
  // Ids are stable across polls.
  const before = [...client.threads.keys()].sort();
  await waitFor(() => orca.callsOf('worktree.ps').length >= 3);
  assert.deepEqual([...client.threads.keys()].sort(), before);
});

test('maps agent states onto T3 thread statuses', async (t) => {
  const done = Date.now() - 5000;
  const { client } = await setup(t, (o) => {
    o.worktrees = [
      worktreeRow({ worktreeId: 'w::working', agents: [agentRow({ toolName: 'Bash', toolInput: 'npm test' })] }),
      worktreeRow({ worktreeId: 'w::approval', agents: [agentRow({ state: 'blocked', toolName: 'Bash', toolInput: 'rm -rf build' })] }),
      worktreeRow({ worktreeId: 'w::question', agents: [agentRow({ state: 'waiting', toolName: 'AskUserQuestion' })] }),
      worktreeRow({ worktreeId: 'w::unread', unread: true, agents: [agentRow({ state: 'done', stateStartedAt: done, lastAssistantMessage: 'Fixed it.' })] }),
      worktreeRow({ worktreeId: 'w::read', status: 'inactive', agents: [agentRow({ state: 'done', stateStartedAt: done })] }),
      worktreeRow({ worktreeId: 'w::settled', workspaceStatus: 'completed', agents: [agentRow({ state: 'done', stateStartedAt: done })] }),
      worktreeRow({ worktreeId: 'w::stopped', agents: [agentRow({ state: 'done', interrupted: true, stateStartedAt: done })] }),
    ];
  });
  const get = (wt) => client.threads.get(threadIdFor(wt, 'tab-1:leaf-1'));
  assert.equal(threadStatus(get('w::working')), 'working');
  assert.equal(threadStatus(get('w::approval')), 'input');
  assert.equal(get('w::approval').pendingRuntimeRequest.kind, 'command');
  assert.equal(get('w::question').pendingRuntimeRequest.kind, 'user_input');
  assert.equal(threadStatus(get('w::unread')), 'open');
  assert.equal(isUnread(get('w::unread')), true);
  assert.deepEqual(get('w::unread').latestVisibleMessage, { role: 'assistant', text: 'Fixed it.' });
  assert.equal(threadStatus(get('w::read')), 'open');
  assert.equal(isUnread(get('w::read')), false);
  assert.equal(get('w::read').status, 'idle');
  assert.equal(threadStatus(get('w::settled')), 'settled');
  assert.equal(get('w::stopped').status, 'interrupted');
});

test('emits thread changes only when something changed', async (t) => {
  const { client, orca, events } = await setup(t, (o) => {
    o.worktrees = [worktreeRow({ agents: [agentRow()] })];
  });
  const id = only(client).id;
  const count = () => events.filter((e) => e.kind === 'thread').length;
  await waitFor(() => orca.callsOf('worktree.ps').length >= 4);
  assert.equal(count(), 0, 'unchanged polls are quiet');
  const finishedAt = Date.now();
  orca.worktrees = [worktreeRow({ unread: true, agents: [agentRow({ state: 'done', stateStartedAt: finishedAt, updatedAt: finishedAt })] })];
  const ev = await waitFor(() => events.find((e) => e.kind === 'thread'));
  assert.equal(ev.id, id);
  assert.equal(threadStatus(ev.prev), 'working');
  assert.equal(threadStatus(ev.thread), 'open');
  assert.equal(isUnread(ev.thread), true);
  // The run's start was remembered from when it was working.
  assert.ok(Date.parse(ev.thread.latestRunStartedAt) < Date.parse(ev.thread.latestRunCompletedAt));
  orca.worktrees = [];
  await waitFor(() => events.find((e) => e.kind === 'removed' && e.id === id));
  assert.equal(client.threads.size, 0);
});

test('projection: prompt, reply, terminal tail, and the live tool', async (t) => {
  const { client } = await setup(t, (o) => {
    o.worktrees = [worktreeRow({ agents: [agentRow({ toolName: 'Bash', toolInput: 'npm test', lastAssistantMessage: 'Running the tests now.' })] })];
    o.terminals = [{ handle: 'h1', worktreeId: 'repo-1::C:/src/app/fix-login', tabId: 'tab-1', leafId: 'leaf-1' }];
    o.screens.h1 = ['', '\x1b[32m✓ 12 passing\x1b[0m', '', '', '\x1b[1m● Running\x1b[0m npm test', ''];
  });
  const p = await client.threadProjection(only(client).id);
  assert.deepEqual(p.messages.map((m) => m.role), ['user', 'assistant', 'assistant']);
  assert.equal(p.messages[0].text, 'Fix the login bug');
  assert.equal(p.messages[1].text, 'Running the tests now.');
  assert.equal(p.messages[2].text, '```text\n✓ 12 passing\n\n● Running npm test\n```');
  assert.equal(p.messages[2].streaming, true);
  assert.equal(p.runs.length, 1);
  assert.equal(p.runs[0].status, 'running');
  assert.equal(activityLabel(p), 'Running npm test');
  assert.equal(p.runtimeRequests.length, 0);
});

test('projection of a finished agent keeps its reply last', async (t) => {
  const { client } = await setup(t, (o) => {
    o.worktrees = [worktreeRow({ agents: [agentRow({ state: 'done', lastAssistantMessage: 'All done.' })] })];
    o.terminals = [{ handle: 'h1', worktreeId: 'repo-1::C:/src/app/fix-login', tabId: 'tab-1', leafId: 'leaf-1' }];
    o.screens.h1 = ['> '];
  });
  const p = await client.threadProjection(only(client).id);
  assert.equal(p.messages.at(-1).text, 'All done.');
  assert.equal(p.runs[0].status, 'completed');
  // First seen already done: no invented start, so no made-up duration.
  assert.equal(p.runs[0].startedAt, undefined);
  assert.equal(runSummary(p), null);
});

test('a run seen working then done gets a summary with its duration', async (t) => {
  const started = Date.now() - 75_000;
  const { client, orca } = await setup(t, (o) => {
    o.worktrees = [worktreeRow({ agents: [agentRow({ stateStartedAt: started })] })];
  });
  orca.worktrees = [worktreeRow({ agents: [agentRow({ state: 'done', stateStartedAt: started + 72_000, lastAssistantMessage: 'Done.' })] })];
  await waitFor(() => only(client).status === 'ready');
  const p = await client.threadProjection(only(client).id);
  assert.equal(runSummary(p), 'Last run: 1m 12s');
});

test('projection of an approval wait renders as "The agent wants to run…"', async (t) => {
  const { client } = await setup(t, (o) => {
    o.worktrees = [worktreeRow({ agents: [agentRow({ state: 'blocked', toolName: 'Bash', toolInput: 'npm test' })] })];
    o.terminals = [{ handle: 'h1', worktreeId: 'repo-1::C:/src/app/fix-login', tabId: 'tab-1', leafId: 'leaf-1' }];
    o.screens.h1 = CLAUDE_MENU;
    o.waits.h1 = { source: 'hook', reason: 'agent-approval-prompt' };
  });
  const th = only(client);
  const p = await client.threadProjection(th.id);
  const req = pendingRequest(p);
  assert.equal(req.kind, 'approval');
  assert.equal(req.what, 'Run a command');
  assert.equal(req.detail, 'npm test');
  assert.equal(req.always, true);
  assert.equal(req.id, th.pendingRuntimeRequest.id);
});

test('projection of a question offers the menu rows', async (t) => {
  const { client } = await setup(t, (o) => {
    o.worktrees = [worktreeRow({ agents: [agentRow({ state: 'waiting', toolName: 'AskUserQuestion' })] })];
    o.terminals = [{ handle: 'h1', worktreeId: 'repo-1::C:/src/app/fix-login', tabId: 'tab-1', leafId: 'leaf-1' }];
    o.screens.h1 = ['☐ Approach', '', 'Which approach should I take?', '', '❯ 1. Patch it', '     Quick fix in place', '  2. Rewrite', '     Cleaner, slower', '  3. Type something.', '', 'Enter to select · Esc to cancel'];
    o.waits.h1 = { source: 'hook', reason: 'agent-interactive-prompt' };
  });
  const p = await client.threadProjection(only(client).id);
  const req = pendingRequest(p);
  assert.equal(req.kind, 'question');
  assert.equal(req.questions[0].q, 'Which approach should I take?');
  assert.deepEqual(req.questions[0].opts.map((o) => [o.l, o.d, o.v]), [['Patch it', 'Quick fix in place', '1'], ['Rewrite', 'Cleaner, slower', '2']]);
  assert.equal(req.questions[0].custom, true);
});

test('parseMenu reads Codex approval menus too', () => {
  const menu = parseMenu(['Would you like to run the following command?', '', '$ cargo test', '', '› 1. Yes, proceed (y)', "  2. Yes, and don't ask again for this command (a)", '  3. No, and tell Codex what to do differently (esc)', '', 'Press enter to confirm or esc to cancel']);
  assert.deepEqual(menu.options.map((o) => o.n), [1, 2, 3]);
  assert.match(menu.options[1].label, /don't ask again/);
  assert.equal(parseMenu(['just output', 'no menu here']), null);
});

test('sendMessage types the prompt like `orca terminal send --text --enter`, with screenshot paths', async (t) => {
  const { client, orca } = await setup(t, (o) => {
    o.worktrees = [worktreeRow({ workspaceStatus: 'completed', agents: [agentRow({ state: 'done' })] })];
    o.terminals = [{ handle: 'h1', worktreeId: 'repo-1::C:/src/app/fix-login', tabId: 'tab-1', leafId: 'leaf-1' }];
  });
  const shot = await client.uploadImage(only(client).id, Buffer.from('png-bytes'), 'shot.png', 'image/png');
  assert.equal(shot.type, 'image');
  assert.equal(fs.readFileSync(shot.path, 'utf8'), 'png-bytes');
  await client.sendMessage(only(client).id, 'Now add a test', 'auto', [shot]);
  const [send] = orca.callsOf('terminal.send');
  assert.equal(send.terminal, 'h1');
  assert.equal(send.enter, true);
  assert.equal(send.agentPrompt, true);
  assert.equal(send.client.type, 'desktop');
  assert.ok(send.text.startsWith('Now add a test'));
  assert.ok(send.text.includes(shot.path));
  // A settled worktree goes back in progress when it gets new work.
  assert.deepEqual(orca.callsOf('worktree.set')[0], { worktree: 'id:repo-1::C:/src/app/fix-login', workspaceStatus: 'in-progress' });
});

test('a refused prompt surfaces as an error', async (t) => {
  const { client } = await setup(t, (o) => {
    o.worktrees = [worktreeRow({ agents: [agentRow({ state: 'done' })] })];
    o.terminals = [{ handle: 'h1', worktreeId: 'repo-1::C:/src/app/fix-login', tabId: 'tab-1', leafId: 'leaf-1' }];
    o.handlers['terminal.send'] = () => {
      throw Object.assign(new Error('agent_prompt_blocked'), { code: 'agent_prompt_blocked' });
    };
  });
  await assert.rejects(client.sendMessage(only(client).id, 'hi'), /waiting for an approval/);
});

test('interrupt sends Escape', async (t) => {
  const { client, orca } = await setup(t, (o) => {
    o.worktrees = [worktreeRow({ agents: [agentRow()] })];
    o.terminals = [{ handle: 'h1', worktreeId: 'repo-1::C:/src/app/fix-login', tabId: 'tab-1', leafId: 'leaf-1' }];
  });
  await client.interrupt(only(client).id);
  const [send] = orca.callsOf('terminal.send');
  assert.equal(send.text, '\x1b');
  assert.equal(send.enter, undefined);
});

test('respondApproval presses the menu key each decision names', async (t) => {
  const { client, orca } = await setup(t, (o) => {
    o.worktrees = [worktreeRow({ agents: [agentRow({ state: 'blocked', toolName: 'Bash', toolInput: 'npm test' })] })];
    o.terminals = [{ handle: 'h1', worktreeId: 'repo-1::C:/src/app/fix-login', tabId: 'tab-1', leafId: 'leaf-1' }];
    o.screens.h1 = CLAUDE_MENU;
  });
  const th = only(client);
  const req = th.pendingRuntimeRequest.id;
  const sent = () => orca.callsOf('terminal.send').map((s) => s.text);
  await client.respondApproval(th.id, req, 'accept');
  await client.respondApproval(th.id, req, 'acceptForSession');
  await client.respondApproval(th.id, req, 'acceptAlways');
  await client.respondApproval(th.id, req, 'decline');
  assert.deepEqual(sent(), ['1', '2', '2', '\x1b']);
  assert.ok(orca.callsOf('terminal.send').every((s) => s.enter === undefined), 'menu keys go without Enter');
  // A menu without a "don't ask again" row: accepting for the session is a plain yes.
  orca.screens.h1 = ['Allow fetch of https://example.com?', '❯ 1. Yes', '  2. No'];
  await client.respondApproval(th.id, req, 'acceptForSession');
  assert.equal(sent().at(-1), '1');
  // An answer to an older wait is refused.
  await assert.rejects(client.respondApproval(th.id, 'qold', 'accept'), /already answered/);
});

test('respondAnswers picks options by digit or types a free answer', async (t) => {
  const { client, orca } = await setup(t, (o) => {
    o.worktrees = [worktreeRow({ agents: [agentRow({ state: 'waiting', toolName: 'AskUserQuestion' })] })];
    o.terminals = [{ handle: 'h1', worktreeId: 'repo-1::C:/src/app/fix-login', tabId: 'tab-1', leafId: 'leaf-1' }];
    o.screens.h1 = ['Which approach?', '❯ 1. Patch it', '  2. Rewrite', '  3. Type something.'];
  });
  const th = only(client);
  const req = th.pendingRuntimeRequest.id;
  await client.respondAnswers(th.id, req, { q1: '2' });
  assert.deepEqual(orca.callsOf('terminal.send').map((s) => s.text), ['2']);
  await client.respondAnswers(th.id, req, { q1: 'Do both' });
  assert.deepEqual(orca.callsOf('terminal.send').slice(1).map((s) => s.text), ['3', 'Do both', '\r']);
});

test('launchThread creates a worktree with the agent and returns its thread id', async (t) => {
  const { client, orca } = await setup(t, (o) => {
    o.worktrees = [];
  });
  const res = await client.launchThread(projectIdFor('repo-1'), 'Add dark mode to settings', [], {});
  const [create] = orca.callsOf('worktree.create');
  assert.equal(create.repo, 'id:repo-1');
  assert.equal(create.startupAgent, 'claude');
  assert.equal(create.startupPrompt, 'Add dark mode to settings');
  assert.equal(create.noParent, true);
  assert.match(create.name, /^wow-add-dark-mode/);
  const { worktreeId, paneKey } = orca.lastCreated;
  assert.equal(res.threadId, threadIdFor(worktreeId, paneKey));
  // Shown as starting until Orca lists the agent, then as the real agent.
  assert.equal(threadStatus(client.threads.get(res.threadId)), 'working');
  orca.worktrees = [worktreeRow({ worktreeId, agents: [agentRow({ paneKey, prompt: 'Add dark mode to settings' })] })];
  await waitFor(() => client.threads.get(res.threadId)?.status === 'running');
  assert.equal(client.threads.size, 1);
});

test('launchThread retries a repo that wants a setup decision without setup', async (t) => {
  const { client, orca } = await setup(t, (o) => {
    const create = o.m_worktree_create;
    o.handlers['worktree.create'] = function (params) {
      if (!params.setupDecision) throw new Error('Setup decision required for this repository');
      return create.call(this, params);
    };
  });
  const res = await client.launchThread(projectIdFor('repo-1'), 'Do it', [], {});
  assert.ok(res.threadId);
  assert.equal(orca.callsOf('worktree.create').at(-1).setupDecision, 'skip');
});

test('settle, unsettle, visit and archive map onto Orca', async (t) => {
  const { client, orca } = await setup(t, (o) => {
    o.worktrees = [worktreeRow({ unread: true, agents: [agentRow({ state: 'done', stateStartedAt: Date.now() - 1000 })] })];
  });
  const id = only(client).id;
  const wt = 'id:repo-1::C:/src/app/fix-login';
  assert.equal(isUnread(only(client)), true);
  await client.visit(id);
  assert.deepEqual(orca.callsOf('agentActivity.setRead')[0], { paneKeys: ['tab-1:leaf-1'], read: true });
  assert.deepEqual(orca.callsOf('worktree.set')[0], { worktree: wt, isUnread: false, acknowledgeAttention: true });
  assert.equal(isUnread(client.threads.get(id)), false);

  await client.settle(id);
  assert.deepEqual(orca.callsOf('worktree.set')[1], { worktree: wt, workspaceStatus: 'completed', isUnread: false, acknowledgeAttention: true });
  await waitFor(() => threadStatus(client.threads.get(id)) === 'settled');

  await client.unsettle(id);
  assert.deepEqual(orca.callsOf('worktree.set')[2], { worktree: wt, workspaceStatus: 'in-progress' });
  await waitFor(() => threadStatus(client.threads.get(id)) === 'open');

  await client.archive(id);
  assert.deepEqual(orca.callsOf('worktree.sleep')[0], { worktree: wt });
  assert.equal(threadStatus(client.threads.get(id)), 'archived');
  // Still archived after later polls of the same (now idle) agent.
  const polls = orca.callsOf('worktree.ps').length;
  await waitFor(() => orca.callsOf('worktree.ps').length > polls + 2);
  assert.equal(threadStatus(client.threads.get(id)), 'archived');
});

test("offline while Orca isn't running, then connects when the runtime file appears", async (t) => {
  const dir = tempDir();
  const states = [];
  const client = new OrcaClient({ userDataDir: dir, pollMs: 40, retryMs: 50 });
  client.on('state', (s, e) => states.push([s, e]));
  client.start();
  const orca = new FakeOrca({ dir });
  orca.worktrees = [worktreeRow({ agents: [agentRow()] })];
  t.after(async () => {
    client.stop();
    await orca.stop().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitFor(() => client.state === 'offline');
  assert.equal(client.error, "Orca isn't running");
  assert.equal(client.environments()[0].error, "Orca isn't running");
  await orca.start();
  await waitFor(() => client.state === 'connected' && client.threads.size === 1);
  assert.deepEqual(states.at(-1), ['connected', null]);
});

test('a stale runtime file (pipe gone) also reads as not running', async (t) => {
  const dir = tempDir();
  const orca = new FakeOrca({ dir });
  orca.writeRuntime(); // file written, nothing listening
  const client = new OrcaClient({ userDataDir: dir, retryMs: 50 });
  client.start();
  t.after(() => {
    client.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitFor(() => client.state === 'offline');
  assert.equal(client.error, "Orca isn't running");
});

test('reconnects to a restarted Orca with a new pipe and token, never logging tokens', async (t) => {
  const { client, orca, logs, dir } = await setup(t, (o) => {
    o.worktrees = [worktreeRow({ agents: [agentRow()] })];
  });
  const id = only(client).id;
  const firstToken = orca.token;
  await orca.stop();
  await waitFor(() => client.state === 'offline');
  const next = new FakeOrca({ dir });
  next.worktrees = [worktreeRow({ agents: [agentRow({ state: 'done' })] })];
  await next.start();
  t.after(() => next.stop().catch(() => {}));
  assert.notEqual(next.endpoint, orca.endpoint);
  await waitFor(() => client.state === 'connected' && client.threads.get(id)?.status === 'ready');
  assert.equal(client.origin, next.endpoint);
  assert.equal(next.authFailures, 0);
  assert.ok(next.callsOf('worktree.ps').length > 0);
  const all = logs.join('\n');
  assert.ok(!all.includes(firstToken) && !all.includes(next.token), 'no token in the log');
});

test('a rejected token reads as offline without echoing it', async (t) => {
  const dir = tempDir();
  const orca = new FakeOrca({ dir });
  await orca.start();
  // The file names this pipe but a different token, as if Orca restarted mid-read.
  const meta = JSON.parse(fs.readFileSync(orca.runtimeFile, 'utf8'));
  fs.writeFileSync(orca.runtimeFile, JSON.stringify({ ...meta, authToken: 'stale-token-1234' }));
  const logs = [];
  const client = new OrcaClient({ userDataDir: dir, retryMs: 50, log: (m) => logs.push(m) });
  client.on('state', (s, e) => logs.push(`${s} ${e}`));
  client.start();
  t.after(async () => {
    client.stop();
    await orca.stop().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitFor(() => client.state === 'offline' && orca.authFailures > 0);
  assert.match(client.error, /token/);
  assert.ok(!logs.join('\n').includes('stale-token-1234'));
  assert.ok(!logs.join('\n').includes(orca.token));
  // Fixing the file (Orca rewrites it) lets the next retry in.
  orca.writeRuntime();
  await waitFor(() => client.state === 'connected');
});
