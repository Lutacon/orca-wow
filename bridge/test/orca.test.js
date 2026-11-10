import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { OrcaClient, readRuntime, parseMenu, threadIdFor, projectIdFor, questionFromMenu, claudeAnswerKeys, codexAnswerKeys, refNameProblem, SHELL_REFUSED } from '../src/orca.js';
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
  // The game shows the agent's own "don't ask again" row instead of a generic one.
  assert.equal(req.al, "Yes, and don't ask again for npm test commands in C:\\src\\app");
  assert.equal(req.always, undefined);
  assert.equal(req.pc, undefined);
  assert.ok(req.id.startsWith(th.pendingRuntimeRequest.id + '.'), 'the id names the wait and what the player saw');
  assert.ok(!/[\x1e\x1f|~]/.test(req.id), 'the id survives the strip');
});

test('a workspace-trust wait can only be declined from the game', async (t) => {
  const { client, orca } = await setup(t, (o) => {
    o.worktrees = [worktreeRow({ agents: [agentRow({ state: 'blocked' })] })];
    o.terminals = [{ handle: 'h1', worktreeId: 'repo-1::C:/src/app/fix-login', tabId: 'tab-1', leafId: 'leaf-1' }];
    o.screens.h1 = ['Do you trust the files in this folder?', '❯ 1. Yes, proceed', '  2. No, exit'];
    o.waits.h1 = { source: 'hook', reason: 'agent-trust-workspace' };
  });
  const th = only(client);
  const req = pendingRequest(await client.threadProjection(th.id));
  assert.equal(req.pc, true);
  assert.equal(req.what, 'Trust this folder');
  assert.equal(req.detail, 'Do you trust the files in this folder?');
  await assert.rejects(client.respondApproval(th.id, req.id, 'accept'), /at the computer/);
  await assert.rejects(client.respondAnswers(th.id, req.id, { q1: '1' }), /at the computer/);
  assert.equal(orca.callsOf('terminal.send').length, 0);
  await client.respondApproval(th.id, req.id, 'decline');
  assert.deepEqual(orca.callsOf('terminal.send').map((s) => s.text), ['\x1b']);
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
  const shown = async () => pendingRequest(await client.threadProjection(th.id)).id;
  const req = await shown();
  const sent = () => orca.callsOf('terminal.send').map((s) => s.text);
  await client.respondApproval(th.id, req, 'accept');
  await client.respondApproval(th.id, req, 'acceptForSession');
  await client.respondApproval(th.id, req, 'acceptAlways');
  await client.respondApproval(th.id, req, 'decline');
  assert.deepEqual(sent(), ['1', '2', '2', '\x1b']);
  assert.ok(orca.callsOf('terminal.send').every((s) => s.enter === undefined), 'menu keys go without Enter');
  // A menu without a "don't ask again" row: nothing is pressed for "don't ask again".
  orca.screens.h1 = ['Allow fetch of https://example.com?', '❯ 1. Yes', '  2. No'];
  const fetchReq = await shown();
  await assert.rejects(client.respondApproval(th.id, fetchReq, 'acceptForSession'), /no "don't ask again" option/);
  assert.equal(sent().length, 4);
  // An answer to an older wait is refused.
  await assert.rejects(client.respondApproval(th.id, 'qold', 'accept'), /already answered/);
});

test('an approval lands only on the menu the player saw', async (t) => {
  const { client, orca } = await setup(t, (o) => {
    o.worktrees = [worktreeRow({ agents: [agentRow({ state: 'blocked', toolName: 'Bash', toolInput: 'npm test' })] })];
    o.terminals = [{ handle: 'h1', worktreeId: 'repo-1::C:/src/app/fix-login', tabId: 'tab-1', leafId: 'leaf-1' }];
    o.screens.h1 = CLAUDE_MENU;
  });
  const th = only(client);
  const sent = () => orca.callsOf('terminal.send').map((s) => s.text);
  const req = pendingRequest(await client.threadProjection(th.id)).id;
  // Same wait, but the menu now asks something else: refused, nothing pressed.
  orca.screens.h1 = [' Bash command', '', '   rm -rf build', '', ' Do you want to proceed?', ' ❯ 1. Yes', "   2. Yes, and don't ask again for rm commands", '   3. No (esc)'];
  await assert.rejects(client.respondApproval(th.id, req, 'accept'), /question changed/);
  // So did the tool input the game showed.
  orca.screens.h1 = CLAUDE_MENU;
  orca.worktrees[0].agents[0].toolInput = 'npm publish';
  await assert.rejects(client.respondApproval(th.id, req, 'accept'), /question changed/);
  orca.worktrees[0].agents[0].toolInput = 'npm test';
  // No id at all is refused too.
  await assert.rejects(client.respondApproval(th.id, '', 'accept'), /question changed/);
  // A screen without a menu: nothing is pressed blind.
  orca.screens.h1 = ['Thinking…'];
  const bare = pendingRequest(await client.threadProjection(th.id)).id;
  await assert.rejects(client.respondApproval(th.id, bare, 'accept'), /Couldn't find the agent's menu/);
  // A screen that can't be read: no yes, but Escape still says no.
  orca.handlers['terminal.read'] = () => {
    throw new Error('read failed');
  };
  await assert.rejects(client.respondApproval(th.id, bare, 'accept'), /Couldn't read the agent's screen/);
  assert.deepEqual(sent(), []);
  await client.respondApproval(th.id, bare, 'decline');
  assert.deepEqual(sent(), ['\x1b']);
});

test('respondAnswers picks options by digit or types a free answer', async (t) => {
  const { client, orca } = await setup(t, (o) => {
    o.worktrees = [worktreeRow({ agents: [agentRow({ state: 'waiting', toolName: 'AskUserQuestion' })] })];
    o.terminals = [{ handle: 'h1', worktreeId: 'repo-1::C:/src/app/fix-login', tabId: 'tab-1', leafId: 'leaf-1' }];
    o.screens.h1 = ['Which approach?', '❯ 1. Patch it', '  2. Rewrite', '  3. Type something.'];
  });
  const th = only(client);
  const req = pendingRequest(await client.threadProjection(th.id)).id;
  await client.respondAnswers(th.id, req, { q1: '2' });
  assert.deepEqual(orca.callsOf('terminal.send').map((s) => s.text), ['2']);
  await client.respondAnswers(th.id, req, { q1: 'Do both' });
  assert.deepEqual(orca.callsOf('terminal.send').slice(1).map((s) => s.text), ['3', 'Do both', '\r']);
  // A changed question isn't answered.
  orca.screens.h1 = ['Which database?', '❯ 1. Postgres', '  2. SQLite', '  3. Type something.'];
  await assert.rejects(client.respondAnswers(th.id, req, { q1: '2' }), /question changed/);
  assert.equal(orca.callsOf('terminal.send').length, 4);
});

test('options keep their on-screen numbers when a free-text-looking row is not last', async (t) => {
  const menu = parseMenu(['Which approach?', '❯ 1. Patch it', '  2. Other approach: rewrite it', '  3. Rewrite', '  4. Type something.', '  5. Chat about this']);
  const q = questionFromMenu(menu);
  assert.deepEqual(q.options.map((o) => [o.value, o.label]), [['1', 'Patch it'], ['2', 'Other approach: rewrite it'], ['3', 'Rewrite']]);
  assert.equal(q.freeRow, 4, 'text goes on "Type something", not "Chat about this"');
  const pick = (i, other = '') => ({ indices: i === null ? [] : [i], other });
  assert.deepEqual(claudeAnswerKeys(q, pick(2)), [{ raw: '3' }]);
  assert.deepEqual(claudeAnswerKeys(q, pick(null, 'both')), [{ raw: '4' }, { text: 'both' }, { raw: '\r' }]);
  assert.deepEqual(codexAnswerKeys(q, pick(2)), [{ raw: '3' }]);
  assert.deepEqual(codexAnswerKeys(q, pick(2, 'carefully')).map((k) => k.raw ?? k.text), ['\x1b[B', '\x1b[B', '\t', 'carefully', '\r']);
  assert.deepEqual(codexAnswerKeys(q, pick(null, 'both')).map((k) => k.raw ?? k.text), ['\x1b[B', '\x1b[B', '\x1b[B', '\t', 'both', '\r']);
  // Multi-select toggles the screen numbers too.
  const multi = questionFromMenu(parseMenu(['Pick any', '❯ 1. [ ] A', '  2. [ ] Other: B', '  3. [ ] C', '  4. Type something']));
  assert.equal(multi.multiSelect, true);
  assert.deepEqual(claudeAnswerKeys(multi, { indices: [0, 2], other: '' }).map((k) => k.raw), ['1', '3', '\x1b[C', '\r']);
  // End to end: the player's "Rewrite" presses 3.
  const { client, orca } = await setup(t, (o) => {
    o.worktrees = [worktreeRow({ agents: [agentRow({ state: 'waiting', toolName: 'AskUserQuestion' })] })];
    o.terminals = [{ handle: 'h1', worktreeId: 'repo-1::C:/src/app/fix-login', tabId: 'tab-1', leafId: 'leaf-1' }];
    o.screens.h1 = ['Which approach?', '❯ 1. Patch it', '  2. Other approach: rewrite it', '  3. Rewrite', '  4. Type something.'];
  });
  const req = pendingRequest(await client.threadProjection(only(client).id));
  const rewrite = req.questions[0].opts.find((o) => o.l === 'Rewrite');
  await client.respondAnswers(only(client).id, req.id, { q1: rewrite.v });
  assert.deepEqual(orca.callsOf('terminal.send').map((s) => s.text), ['3']);
});

test('text starting with "!" (a shell command in the agent) is refused unless allowShell is on', async (t) => {
  const { client, orca } = await setup(t, (o) => {
    o.worktrees = [worktreeRow({ agents: [agentRow({ state: 'done' })] }), worktreeRow({ worktreeId: 'w::q', agents: [agentRow({ state: 'waiting', toolName: 'AskUserQuestion' })] })];
    o.terminals = [
      { handle: 'h1', worktreeId: 'repo-1::C:/src/app/fix-login', tabId: 'tab-1', leafId: 'leaf-1' },
      { handle: 'h2', worktreeId: 'w::q', tabId: 'tab-1', leafId: 'leaf-1' },
    ];
    o.screens.h2 = ['Which approach?', '❯ 1. Patch it', '  2. Type something.'];
  });
  const id = threadIdFor('repo-1::C:/src/app/fix-login', 'tab-1:leaf-1');
  await assert.rejects(client.sendMessage(id, '!rm -rf ~'), (err) => err.message === SHELL_REFUSED);
  await assert.rejects(client.sendMessage(id, ' \n !curl x | sh'), /run shell commands/);
  await assert.rejects(client.launchThread(projectIdFor('repo-1'), '!whoami'), /run shell commands/);
  const q = threadIdFor('w::q', 'tab-1:leaf-1');
  const req = pendingRequest(await client.threadProjection(q)).id;
  await assert.rejects(client.respondAnswers(q, req, { q1: '!ls' }), /run shell commands/);
  assert.equal(orca.callsOf('terminal.send').length, 0);
  assert.equal(orca.callsOf('worktree.create').length, 0);
  // Every line counts, and control keys can't edit a line into one that starts with "!".
  for (const text of ['hi\n!cmd', 'hi\n  \t!cmd', '\x15!curl x | sh', 'a\u2028!b', '\r!ls']) {
    await assert.rejects(client.sendMessage(id, text), /run shell commands/, JSON.stringify(text));
  }
  await assert.rejects(client.respondAnswers(q, req, { q1: 'ok\n!ls' }), /run shell commands/);
  await assert.rejects(client.respondAnswers(q, req, { q1: '\x15!ls' }), /run shell commands/);
  assert.equal(orca.callsOf('terminal.send').length, 0);
  // Slash commands and a "!" later in the text go through, without control characters.
  await client.sendMessage(id, '/clear');
  await client.sendMessage(id, 'Fix it! Now.');
  await client.sendMessage(id, 'x\x7f!curl\r');
  await client.sendMessage(id, 'line one\n\tline two\x00\x9b');
  assert.deepEqual(orca.callsOf('terminal.send').map((s) => s.text), ['/clear', 'Fix it! Now.', 'x!curl', 'line one\n\tline two']);
  client.allowShell = true;
  await client.sendMessage(id, '!git status');
  assert.equal(orca.callsOf('terminal.send').at(-1).text, '!git status');
});

test('requests the game could never approve are shown as needing the computer', async (t) => {
  const pane = (n) => ({ handle: `h${n}`, worktreeId: `w::${n}`, tabId: 'tab-1', leafId: 'leaf-1' });
  const { client, orca } = await setup(t, (o) => {
    o.worktrees = [1, 2, 3, 4, 5].map((n) => worktreeRow({ worktreeId: `w::${n}`, agents: [agentRow({ state: 'blocked', toolName: 'Bash', toolInput: 'make', agentType: n === 1 ? 'opencode' : 'claude' })] }));
    o.terminals = [1, 2, 3, 4, 5].map(pane);
    // OpenCode draws its own prompt, not a numbered menu.
    o.screens.h1 = ['Permission required', '  $ make', '', ' Allow once   Allow always   Reject'];
    // A menu without a row that says yes.
    o.screens.h2 = ['Which model?', '❯ 1. gpt-5', '  2. Keep the current model'];
    // Signing in needs the computer, even with a yes row.
    o.screens.h3 = ['Your session expired.', '❯ 1. Yes, sign in', '  2. No'];
    o.waits.h3 = { source: 'hook', reason: 'agent-sign-in-prompt' };
    // Codex's menu: Yes presses a row that says more than "Yes", and the game shows it.
    o.screens.h4 = ['$ make', '› 1. Yes, proceed (y)', "  2. Yes, and don't ask again for this command (a)", '  3. No (esc)'];
    // A row that switches on a mode is never the plain Yes.
    o.screens.h5 = ['Ready to code?', '❯ 1. Yes, and auto-accept edits', '  2. Yes, and manually approve edits', '  3. No, keep planning'];
  });
  const id = (n) => threadIdFor(`w::${n}`, 'tab-1:leaf-1');
  const req = async (n) => pendingRequest(await client.threadProjection(id(n)));
  for (const [n, why] of [[1, /can't find this prompt's options/], [2, /None of this prompt's options says yes/], [3, /needs the computer/]]) {
    const r = await req(n);
    assert.equal(r.pc, true, `agent ${n} needs the computer`);
    assert.match(r.pcw, why);
    await assert.rejects(client.respondApproval(id(n), r.id, 'accept'));
    await client.respondApproval(id(n), r.id, 'decline');
  }
  assert.deepEqual(orca.callsOf('terminal.send').map((s) => [s.terminal, s.text]), [['h1', '\x1b'], ['h2', '\x1b'], ['h3', '\x1b']], 'only No was pressed');
  const codex = await req(4);
  assert.equal(codex.pc, undefined);
  assert.equal(codex.yl, 'Yes, proceed');
  assert.equal(codex.al, "Yes, and don't ask again for this command");
  const plan = await req(5);
  assert.equal(plan.yl, 'Yes, and manually approve edits');
  assert.equal(plan.al, 'Yes, and auto-accept edits');
  await client.respondApproval(id(5), plan.id, 'accept');
  assert.equal(orca.callsOf('terminal.send').at(-1).text, '2', 'Yes pressed the row the game showed');
  // A plain "Yes" row needs no label of its own.
  orca.screens.h4 = CLAUDE_MENU;
  assert.equal((await req(4)).yl, undefined);
});

test("Stop waits for an answer's keys instead of landing between them", async (t) => {
  const { client, orca } = await setup(t, (o) => {
    o.worktrees = [worktreeRow({ agents: [agentRow({ state: 'waiting', toolName: 'AskUserQuestion' })] })];
    o.terminals = [{ handle: 'h1', worktreeId: 'repo-1::C:/src/app/fix-login', tabId: 'tab-1', leafId: 'leaf-1' }];
    o.screens.h1 = ['Which approach?', '❯ 1. Patch it', '  2. Rewrite', '  3. Type something.'];
  });
  client.keyDelayMs = 60;
  const th = only(client);
  const req = pendingRequest(await client.threadProjection(th.id)).id;
  const answering = client.respondAnswers(th.id, req, { q1: 'Do both' });
  await waitFor(() => orca.callsOf('terminal.send').length >= 1);
  await client.interrupt(th.id);
  await answering;
  assert.deepEqual(orca.callsOf('terminal.send').map((s) => s.text), ['3', 'Do both', '\r', '\x1b']);
});

test('the terminal handle cache tells apart panes with the same key in different worktrees', async (t) => {
  const { client, orca } = await setup(t, (o) => {
    o.worktrees = [worktreeRow({ agents: [agentRow({ state: 'done' })] }), worktreeRow({ worktreeId: 'w::two', displayName: 'two', agents: [agentRow({ state: 'done' })] })];
    o.terminals = [
      { handle: 'h1', worktreeId: 'repo-1::C:/src/app/fix-login', tabId: 'tab-1', leafId: 'leaf-1' },
      { handle: 'h2', worktreeId: 'w::two', tabId: 'tab-1', leafId: 'leaf-1' },
    ];
  });
  await client.sendMessage(threadIdFor('repo-1::C:/src/app/fix-login', 'tab-1:leaf-1'), 'one');
  await client.sendMessage(threadIdFor('w::two', 'tab-1:leaf-1'), 'two');
  assert.deepEqual(orca.callsOf('terminal.send').map((s) => [s.terminal, s.text]), [['h1', 'one'], ['h2', 'two']]);
});

test('worktree names and base branches from the game follow git ref rules', async (t) => {
  for (const bad of ['-rf', 'a..b', '/abs', 'end/', 'a//b', 'x.lock', 'feat/x.lock', 'a@{1}', 'a b', 'a\tb', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[b', 'a\\b', '.hidden', 'feat/.x', 'dot.', '@']) {
    assert.ok(refNameProblem(bad), `refused: ${JSON.stringify(bad)}`);
  }
  for (const good of ['feat/dark-mode', 'v1.2', 'fix_login', 'release/2026.11', 'a-b']) assert.equal(refNameProblem(good), null, good);
  const { client, orca } = await setup(t, (o) => {
    o.worktrees = [];
  });
  await assert.rejects(client.launchThread(projectIdFor('repo-1'), 'x', [], { name: '-x' }), /can't be a worktree name: it starts with "-"/);
  await assert.rejects(client.launchThread(projectIdFor('repo-1'), 'x', [], { name: 'a/../b' }), /".."/);
  await assert.rejects(client.launchThread(projectIdFor('repo-1'), 'x', [], { baseBranch: '--upload-pack=x' }), /can't be a base branch/);
  await assert.rejects(client.launchThread(projectIdFor('repo-1'), 'x', [], { baseBranch: 'main@{1}' }), /can't be a base branch/);
  assert.equal(orca.callsOf('worktree.create').length, 0);
  await client.launchThread(projectIdFor('repo-1'), 'x', [], { name: 'feat/x', baseBranch: 'origin/main' });
  assert.equal(orca.callsOf('worktree.create').length, 1);
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
  await waitFor(() => orca.callsOf('agentActivity.setRead').length === 1);
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

// Orca marks agents read in its window and gives up after 10 s when that window doesn't
// answer (seen on a remote Orca whose window was away): visits must not wait for it.
test("visits don't wait for Orca's window to mark agents read, and its refusal is logged once", async (t) => {
  let answer = null;
  const { client, orca, logs } = await setup(t, (o) => {
    o.worktrees = [worktreeRow({ unread: true, agents: [agentRow({ state: 'done', stateStartedAt: Date.now() - 1000 })] })];
    o.handlers['agentActivity.setRead'] = () => new Promise((resolve, reject) => {
      answer = { resolve, reject };
    });
  });
  const id = only(client).id;
  const refusal = () => Object.assign(new Error('agent_activity_timeout'), { code: 'runtime_error' });
  const refusals = () => logs.filter((l) => /agent_activity_timeout/.test(l)).length;

  await client.visit(id); // returns while Orca still holds the read
  assert.equal(orca.callsOf('worktree.set').length, 1);
  await waitFor(() => answer);
  await client.visit(id);
  await client.settle(id);
  answer.reject(refusal());
  // The two later reads went out together once the first was answered.
  await waitFor(() => orca.callsOf('agentActivity.setRead').length === 2);
  assert.deepEqual(orca.callsOf('agentActivity.setRead')[1], { paneKeys: ['tab-1:leaf-1'], read: true });
  answer.reject(refusal());
  await waitFor(() => !client.sendingReads);
  assert.equal(refusals(), 1, 'logged once');

  // Once a read gets through, the next refusal is news again.
  client.markRead(client.ref(id));
  await waitFor(() => orca.callsOf('agentActivity.setRead').length === 3);
  answer.resolve({ applied: true });
  await waitFor(() => !client.sendingReads);
  client.markRead(client.ref(id));
  await waitFor(() => orca.callsOf('agentActivity.setRead').length === 4);
  answer.reject(refusal());
  await waitFor(() => refusals() === 2);
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

test("a runtime file left by an Orca that exited isn't connected to, even if its pipe answers", async (t) => {
  const dir = tempDir();
  const orca = new FakeOrca({ dir });
  await orca.start();
  // Rewrite the file as if a process that has since exited wrote it.
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  const meta = JSON.parse(fs.readFileSync(orca.runtimeFile, 'utf8'));
  fs.writeFileSync(orca.runtimeFile, JSON.stringify({ ...meta, pid: dead }));
  const client = new OrcaClient({ userDataDir: dir, retryMs: 50 });
  client.start();
  t.after(async () => {
    client.stop();
    await orca.stop().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitFor(() => client.state === 'offline');
  assert.equal(client.error, "Orca isn't running");
  assert.equal(orca.calls.length, 0, 'nothing was sent to the pipe');
  orca.writeRuntime(); // Orca running again
  await waitFor(() => client.state === 'connected');
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
