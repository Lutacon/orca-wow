// The bridge end to end against the fake Orca: what
// the game would receive in a snapshot, and a command from the game reaching Orca.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Bridge } from '../src/bridge.js';
import { threadIdFor } from '../src/orca.js';
import { FakeOrca, tempDir, worktreeRow, agentRow } from './support/fake-orca.js';

const MENU = [' Bash command', '', '   npm test', '', ' Do you want to proceed?', ' ❯ 1. Yes', "   2. Yes, and don't ask again for npm test commands", '   3. No (esc)'];

async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('Orca feeds the snapshot and runs commands from the game', async (t) => {
  const orcaDir = tempDir();
  const addonsDir = tempDir();
  const stateDir = tempDir();
  const orca = new FakeOrca({ dir: orcaDir });
  orca.worktrees = [
    worktreeRow({ agents: [agentRow({ state: 'blocked', toolName: 'Bash', toolInput: 'npm test' })] }),
    worktreeRow({
      worktreeId: 'repo-1::C:/src/app/docs',
      displayName: 'docs',
      branch: 'docs',
      unread: true,
      agents: [agentRow({ paneKey: 'tab-2:leaf-1', state: 'done', lastAssistantMessage: 'Docs updated.' })],
    }),
  ];
  orca.terminals = [
    { handle: 'h1', worktreeId: 'repo-1::C:/src/app/fix-login', tabId: 'tab-1', leafId: 'leaf-1' },
    { handle: 'h2', worktreeId: 'repo-1::C:/src/app/docs', tabId: 'tab-2', leafId: 'leaf-1' },
  ];
  orca.screens.h1 = MENU;
  orca.waits.h1 = { source: 'hook', reason: 'agent-approval-prompt' };
  orca.screens.h2 = ['Docs updated.', '> '];
  await orca.start();

  const b = new Bridge({ addonsDir, stateDir, log: () => {}, config: { slots: 10, orca: { userDataDir: orcaDir, stateDir, pollMs: 40, keyDelayMs: 1, retryMs: 50 } } });
  t.after(async () => {
    b.stop();
    await orca.stop().catch(() => {});
    for (const d of [orcaDir, addonsDir, stateDir]) fs.rmSync(d, { recursive: true, force: true });
  });
  // Just the Orca side of start(): no game process or screen capture in a test.
  b.agents.on('change', (ev) => b.onAgentsChange(ev));
  b.agents.start();
  await waitFor(() => b.agents.state === 'connected' && b.agents.threads.size === 2);

  const blocked = threadIdFor('repo-1::C:/src/app/fix-login', 'tab-1:leaf-1');
  const done = threadIdFor('repo-1::C:/src/app/docs', 'tab-2:leaf-1');
  b.client = { view: blocked, flags: 'o', session: 's', ui: 'u' };
  await b.refreshView(blocked, true);

  const snap = b.buildSnapshot();
  assert.equal(snap.bridge.orca, 'connected');
  const byId = Object.fromEntries(snap.threads.map((x) => [x.id, x]));
  assert.equal(byId[blocked].s, 'input');
  assert.equal(byId[blocked].l, 'Needs your approval');
  assert.equal(byId[done].s, 'open');
  assert.equal(byId[done].un, true, 'unread in Orca is unread in game');
  assert.match(byId[done].title, /docs/);
  assert.equal(snap.projects[0].name, 'app');
  assert.equal(snap.view.id, blocked);
  assert.equal(snap.view.pending.kind, 'approval');
  assert.equal(snap.view.pending.detail, 'npm test');

  // The game approves; the bridge presses the menu's "Yes" in the agent's terminal.
  await b.runCommand({ id: 1, verb: 'approve', args: [blocked, snap.view.pending.id, 'accept'] });
  const result = b.results.find((r) => r.id === 1);
  assert.equal(result.ok, true, result.msg);
  const sends = orca.callsOf('terminal.send').filter((p) => p.terminal === 'h1');
  assert.ok(sends.some((p) => p.text === '1'), 'pressed 1 for "Yes"');

  // The snapshot offers the agents a new worktree can start with.
  assert.equal(snap.agents.d, 'claude');
  assert.ok(snap.agents.o.some((a) => a.i === 'codex'));

  // A new worktree from the game with a chosen agent, name and base branch.
  await b.runCommand({ id: 3, verb: 'new', args: [snap.projects[0].id, 'Add dark mode', 'codex', 'dark-mode', 'develop'] });
  assert.equal(b.results.find((r) => r.id === 3)?.ok, true, b.results.find((r) => r.id === 3)?.msg);
  const create = orca.callsOf('worktree.create').at(-1);
  assert.equal(create.startupAgent, 'codex');
  assert.equal(create.name, 'dark-mode');
  assert.equal(create.baseBranch, 'develop');
  assert.equal(create.startupPrompt, 'Add dark mode');
  assert.equal(create.nameWasGenerated, undefined, 'a typed name is the user\'s');

  // Without the extras: Orca's defaults and a generated name.
  await b.runCommand({ id: 4, verb: 'new', args: [snap.projects[0].id, 'Fix flaky test'] });
  const plain = orca.callsOf('worktree.create').at(-1);
  assert.equal(plain.startupAgent, 'claude');
  assert.equal(plain.baseBranch, undefined);
  assert.equal(plain.nameWasGenerated, true);

  // An unknown agent is refused before Orca is asked.
  await b.runCommand({ id: 5, verb: 'new', args: [snap.projects[0].id, 'x', 'nope'] });
  assert.equal(b.results.find((r) => r.id === 5).ok, false);

  // A shell command for the agent is refused, and the game is told how to allow it.
  await b.runCommand({ id: 6, verb: 'send', args: [done, '!rm -rf build'] });
  const shell = b.results.find((r) => r.id === 6);
  assert.equal(shell.ok, false);
  assert.match(shell.msg, /To allow it, run orca-wow shell on at the computer\.$/, 'the whole message reaches the game');
  assert.ok(!orca.callsOf('terminal.send').some((p) => p.text.startsWith('!')));
});

// Orca reports when a wait starts, not what it shows: the thread doesn't change when the
// agent draws its menu after the hook fired, or when a resized window re-wraps a row.
// The game must still get the request it can answer.
test('a request the game saw before it changed on screen is refused once, then answered', async (t) => {
  const orcaDir = tempDir();
  const addonsDir = tempDir();
  const stateDir = tempDir();
  const orca = new FakeOrca({ dir: orcaDir });
  orca.worktrees = [worktreeRow({ agents: [agentRow({ state: 'blocked', toolName: 'Bash', toolInput: 'npm test' })] })];
  orca.terminals = [{ handle: 'h1', worktreeId: 'repo-1::C:/src/app/fix-login', tabId: 'tab-1', leafId: 'leaf-1' }];
  orca.screens.h1 = ['Thinking…']; // the hook said "waiting" before the menu was drawn
  orca.waits.h1 = { source: 'hook', reason: 'agent-approval-prompt' };
  await orca.start();
  const b = new Bridge({ addonsDir, stateDir, log: () => {}, config: { slots: 10, orca: { userDataDir: orcaDir, stateDir, pollMs: 40, keyDelayMs: 1, retryMs: 50 } } });
  t.after(async () => {
    b.stop();
    await orca.stop().catch(() => {});
    for (const d of [orcaDir, addonsDir, stateDir]) fs.rmSync(d, { recursive: true, force: true });
  });
  b.agents.on('change', (ev) => b.onAgentsChange(ev));
  b.agents.start();
  await waitFor(() => b.agents.state === 'connected' && b.agents.threads.size === 1);
  const id = threadIdFor('repo-1::C:/src/app/fix-login', 'tab-1:leaf-1');
  b.client = { view: id, flags: 'o', session: 's', ui: 'u' };
  await b.refreshView(id, true);
  const pending = () => b.buildSnapshot().view.pending;
  assert.equal(pending().pc, true, 'no menu yet: the game can only say No');

  // The menu appears; the thread row doesn't change. The periodic re-read picks it up.
  orca.screens.h1 = MENU;
  b.views.get(id).fetchedAt = 0;
  b.dirty.view = false;
  await b.recheckWait();
  assert.equal(pending().pc, undefined, 'now the game offers Yes');
  assert.equal(b.dirty.view, true, 'and a changed request is worth a publish');
  const seen = pending().id;
  // An unchanged request is re-read quietly: nothing new to publish.
  b.views.get(id).fetchedAt = 0;
  b.dirty.view = false;
  await b.recheckWait();
  assert.equal(pending().id, seen);
  assert.equal(b.dirty.view, false);

  // The window was resized and a row re-wrapped: the game's request is stale.
  orca.screens.h1 = [...MENU.slice(0, -2), "   2. Yes, and don't ask again for npm", '      test commands', '   3. No (esc)'];
  await b.runCommand({ id: 1, verb: 'approve', args: [id, seen, 'accept'] });
  const refused = b.results.find((r) => r.id === 1);
  assert.equal(refused.ok, false);
  assert.match(refused.msg, /question changed/);
  assert.equal(orca.callsOf('terminal.send').length, 0, 'nothing was pressed');
  // The result goes out with the current request, which the next try answers.
  const current = pending().id;
  assert.notEqual(current, seen);
  await b.runCommand({ id: 2, verb: 'approve', args: [id, current, 'accept'] });
  assert.equal(b.results.find((r) => r.id === 2).ok, true, b.results.find((r) => r.id === 2).msg);
  assert.deepEqual(orca.callsOf('terminal.send').map((s) => s.text), ['1']);
});
