// Remote Orca over its paired, end-to-end encrypted WebSocket: the access link, the
// handshake (checked against Orca's own test vectors), a whole client over it, and a
// fleet of this PC's Orca (pipe) plus another computer's (WebSocket).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { OrcaClient, threadIdFor, projectIdFor } from '../src/orca.js';
import { OrcaFleet } from '../src/orca-fleet.js';
import { Bridge } from '../src/bridge.js';
import {
  nacl,
  parseAccessLink,
  encodeAccessLink,
  checkAccessLink,
  PairedTransport,
  createClientHandshake,
  sharedKey,
  sealLegacy,
  encodeV2Transcript,
  deriveV2Keys,
  sealV2Frame,
  openV2Frame,
  saveRemoteSecret,
  readRemoteSecret,
  remoteIdFor,
} from '../src/orca-remote.js';
import { FakeOrca, tempDir, worktreeRow, agentRow } from './support/fake-orca.js';
import { FakeOrcaWs } from './support/fake-orca-ws.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const hex = (b) => Buffer.from(b).toString('hex');
const fill = (n) => new Uint8Array(32).fill(n);
const b64fill = (n) => Buffer.from(fill(n)).toString('base64');

async function waitFor(fn, ms = 6000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const MAC_ROW = worktreeRow({ worktreeId: 'mac-repo::/Users/me/src/game/wow-ui', repoId: 'mac-repo', repo: 'game', path: '/Users/me/src/game/wow-ui', displayName: 'wow-ui', branch: 'wow-ui', agents: [agentRow({ paneKey: 'tab-9:leaf-1', state: 'working', prompt: 'Polish the UI' })] });

function macOrca(over = {}) {
  const orca = new FakeOrca({ dir: null });
  orca.repos = [{ id: 'mac-repo', path: '/Users/me/src/game', displayName: 'game' }];
  orca.worktrees = [structuredClone(MAC_ROW)];
  orca.terminals = [{ handle: 'mh1', worktreeId: MAC_ROW.worktreeId, tabId: 'tab-9', leafId: 'leaf-1' }];
  orca.screens.mh1 = ['> Polishing the UI', '  Reading files...'];
  return new FakeOrcaWs({ orca, ...over });
}

// ---- Orca's own test vectors ---------------------------------------------------

test('the E2EE primitives reproduce Orca\'s legacy and v2 test vectors', () => {
  // src/shared/remote-runtime/e2ee/mobile-e2ee-legacy-fixtures.ts
  const server = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(1));
  const client = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(2));
  assert.equal(Buffer.from(server.publicKey).toString('base64'), 'pOCSkrZRwni5dyxWn1+puxPZBrRqtoyd+dwrRAn4ogk=');
  const key = sharedKey(client.secretKey, server.publicKey);
  assert.equal(hex(key), '18a99320f3488fa18a04239715d8ee738065e65c3d4b2898522d6c3d4ead588c');
  const hs = createClientHandshake({ framing: 'legacy', hostPublicKeyB64: 'pOCSkrZRwni5dyxWn1+puxPZBrRqtoyd+dwrRAn4ogk=', clientKeyPair: client });
  assert.equal(hs.helloText(), '{"type":"e2ee_hello","publicKeyB64":"zo060cy2M+x7cMF4FKXHbs0CloUFDTRHRboFhw5YfVk="}');
  assert.equal(hs.authText('legacy-token'), '{"type":"e2ee_auth","deviceToken":"legacy-token"}');
  const auth = sealLegacy(new Uint8Array(Buffer.from(hs.authText('legacy-token'))), key, new Uint8Array(24).fill(6));
  assert.equal(Buffer.from(auth).toString('base64'), 'BgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGTxV8uZ+DG8yRMwrsAYDOGAHUylsq9vpyPLHIz5lrt+vb8AFA6SXELR72fhVZpQiC5tDhn3RUuo0CNefKVy/njNg=');
  assert.equal(hex(sealLegacy(new Uint8Array([0, 1, 2, 127, 128, 255]), key, new Uint8Array(24).fill(6))), '060606060606060606060606060606060606060606060606200be03dc6f8c733e1b85657d9a52dfe7af7bc5dda6c');

  // src/shared/remote-runtime/e2ee/mobile-e2ee-v2-fixtures.ts
  const context = { protocol: 'orca-mobile-e2ee', initiator: 'mobile', responder: 'desktop', transport: 'relay', relayHostId: 'AbCdEf0123_-xyZ9' };
  const hello = { type: 'e2ee_hello', v: 2, clientPublicKeyB64: b64fill(1), clientNonceB64: b64fill(2), capabilities: { framing: [2], payloadKinds: ['text', 'binary'] }, context };
  const ready = { type: 'e2ee_ready', v: 2, desktopPublicKeyB64: b64fill(3), clientNonceB64: b64fill(2), desktopNonceB64: b64fill(4), selection: { framing: 2, payloadKinds: ['text', 'binary'] }, context };
  const transcript = encodeV2Transcript(hello, ready);
  assert.equal(transcript.length, 1347);
  const keys = deriveV2Keys({ sharedSecret: fill(5), transcript, clientNonce: fill(2), desktopNonce: fill(4) });
  assert.equal(hex(keys.transcriptHash), 'ca6385f8bbf64a223fdd59587bfb67e2373891ce9e6d85ab41df8b7a20a168e3');
  assert.equal(hex(keys.mobileToDesktopKey), 'df17ff534df77fd3a30999f4e6200c8fcedefbb15d369301ca62c3cdfea9559a');
  assert.equal(hex(keys.desktopToMobileKey), '71365fcf8212a6d63caf909ee28de3c8f689682ef298a374136055e0ab1cde4a');
  assert.equal(hex(keys.sessionId), '339ae1f2bdff63481857d2813c2f19dd1f5aa4824705d5e5daeb25dae7b9196e');

  // Frames bind direction, kind and counter: a replayed or reordered frame won't open.
  const args = { key: keys.mobileToDesktopKey, sessionId: keys.sessionId, direction: 'mobile-to-desktop', kind: 'text' };
  const frame = sealV2Frame({ ...args, payload: new Uint8Array(Buffer.from('hi')), counter: 0n });
  assert.equal(Buffer.from(openV2Frame({ ...args, frame, counter: 0n })).toString(), 'hi');
  assert.equal(openV2Frame({ ...args, frame, counter: 1n }), null);
  assert.equal(openV2Frame({ ...args, frame, counter: 0n, kind: 'binary' }), null);
  assert.equal(openV2Frame({ ...args, frame, counter: 0n, direction: 'desktop-to-mobile' }), null);
});

// ---- the access link ---------------------------------------------------------------

test('access links: the orca:// link, the bare code, and what is refused', () => {
  const key = Buffer.from(nacl.box.keyPair().publicKey).toString('base64');
  const offer = { v: 2, endpoint: 'ws://192.168.1.20:6768/', deviceToken: 'tok-123', publicKeyB64: key, scope: 'runtime' };
  const link = encodeAccessLink(offer);
  assert.match(link, /^orca:\/\/pair\?code=[A-Za-z0-9_-]+$/);
  assert.deepEqual(parseAccessLink(link), offer);
  // The address is kept normalised, so the link's author can't smuggle terminal codes in.
  assert.equal(parseAccessLink(encodeAccessLink({ ...offer, endpoint: 'WS://192.168.1.20:6768' })).endpoint, 'ws://192.168.1.20:6768/');
  assert.doesNotMatch(parseAccessLink(encodeAccessLink({ ...offer, endpoint: 'ws://192.168.1.20:6768/\x1b]52;c;eA==\x07\n' })).endpoint, /[\x00-\x1f\x7f]/);
  assert.deepEqual(parseAccessLink(`  ${link}\n`), offer, 'surrounding whitespace from a paste');
  assert.deepEqual(parseAccessLink(link.split('code=')[1]), offer, 'the bare code');
  assert.deepEqual(parseAccessLink(link.replace('?code=', '#')), offer, 'the code in the fragment');
  assert.deepEqual(checkAccessLink(offer), {});

  const bad = (input, re) => assert.throws(() => parseAccessLink(input), (err) => err.code === 'invalid_link' && re.test(err.message) && !err.message.includes('tok-123'));
  bad('', /No access link/);
  bad('https://orca.example/pair?code=abc', /web address/);
  bad(link.replace('orca://pair', 'orca://pairing'), /isn't an Orca access link/);
  bad(link.replace('orca://pair', 'orca://pair/x'), /isn't an Orca access link/);
  bad(link.slice(0, -12), /incomplete or garbled/);
  bad(encodeAccessLink({ ...offer, v: 1 }), /version/);
  bad(encodeAccessLink({ ...offer, deviceToken: '' }), /no access token/);
  bad(encodeAccessLink({ ...offer, publicKeyB64: 'AAAA' }), /host key/);
  bad(encodeAccessLink({ ...offer, endpoint: 'http://192.168.1.20:6768' }), /ws:\/\//);
  bad(encodeAccessLink({ ...offer, scope: 'admin' }), /scope/);
  // A phone link with a Relay invite expires after 10 minutes.
  const relay = { v: 1, directorUrl: 'https://d.example', cellUrl: 'https://c.example', assignmentEpoch: 1, relayHostId: 'AbCdEf0123_-xyZ9', inviteToken: 'x'.repeat(43), e2eeFraming: 2 };
  bad(encodeAccessLink({ ...offer, scope: 'mobile', relay: { ...relay, inviteExpiresAt: Date.now() - 1000 } }), /expired/);
  bad(encodeAccessLink({ ...offer, scope: 'runtime', relay: { ...relay, inviteExpiresAt: Date.now() + 60000 } }), /Relay/);

  // Usable but not for the bridge: a phone pairing can't call terminal.show.
  assert.match(checkAccessLink({ ...offer, scope: 'mobile' }).error, /phone pairing/);
  assert.match(checkAccessLink({ ...offer, endpoint: 'ws://127.0.0.1:6768' }).warning, /LAN address/);
  assert.equal(remoteIdFor(offer), remoteIdFor({ ...offer, deviceToken: 'other' }), 'one id per host key');
});

// ---- the handshake ------------------------------------------------------------------

test('handshake: E2EE v2 with an Orca that speaks it, legacy with an older one', async (t) => {
  const mac = await macOrca().start();
  const old = await macOrca({ legacyOnly: true }).start();
  t.after(() => Promise.all([mac.stop(), old.stop()]));

  const v2 = new PairedTransport({ ...mac.secret(), label: 'MacBook' });
  const { conn, status, origin, runtimeId } = await v2.open();
  assert.equal(v2.framing, 'v2');
  assert.deepEqual(mac.handshakes, ['v2']);
  assert.equal(status.appVersion, '1.4.300');
  assert.equal(runtimeId, mac.orca.runtimeId);
  assert.equal(origin, mac.endpoint);
  // Requests are the CLI's envelope: the device token rides inside the encryption.
  const reply = await conn.call('repo.list', {});
  assert.equal(reply.repos[0].id, 'mac-repo');
  assert.deepEqual(Object.keys(mac.requests.at(-1)).sort(), ['deviceToken', 'id', 'method', 'params']);
  await waitFor(() => mac.pongs > 0); // answers Orca's heartbeat ping
  conn.close();

  const legacy = new PairedTransport({ ...old.secret(), label: 'Old Mac' });
  const opened = await legacy.open();
  assert.equal(legacy.framing, 'legacy', 'redialed with the legacy framing after the v2 hello was refused');
  assert.deepEqual(old.handshakes, ['legacy']);
  assert.equal((await opened.conn.call('worktree.ps', {})).worktrees.length, 1);
  opened.conn.close();
  // Remembered: the next dial goes straight to legacy.
  const again = await legacy.open();
  again.conn.close();
  assert.deepEqual(old.handshakes, ['legacy', 'legacy']);
});

test('handshake failures say what to do and never show the token', async (t) => {
  const mac = await macOrca().start();
  const phone = await macOrca({ scope: 'mobile' }).start();
  const future = await macOrca({ minClientVersion: 9 }).start();
  t.after(() => Promise.all([mac.stop(), phone.stop(), future.stop()]));

  const wrong = new PairedTransport({ ...mac.secret(), deviceToken: 'not-the-token-xyz', label: 'MacBook' });
  const err = await wrong.open().then(() => null, (e) => e);
  assert.equal(err?.code, 'unauthorized');
  assert.equal(mac.authFailures, 1);
  const msg = wrong.describeFailure(err);
  assert.match(msg, /MacBook no longer accepts this PC/);
  assert.match(msg, /orca-wow remote add "MacBook"/);
  assert.ok(!msg.includes('not-the-token-xyz') && !msg.includes(mac.deviceToken));

  // A link whose pinned key isn't this host's: refused at the ready, before any token is sent.
  const imposter = new PairedTransport({ ...mac.secret(), publicKeyB64: Buffer.from(nacl.box.keyPair().publicKey).toString('base64'), label: 'MacBook' });
  const idErr = await imposter.open().then(() => null, (e) => e);
  assert.equal(idErr?.code, 'host_identity');
  assert.equal(mac.authFailures, 1, 'no auth was attempted');

  const p = new PairedTransport({ ...phone.secret(), label: 'Phone pairing' });
  const scopeErr = await p.open().then(() => null, (e) => e);
  assert.equal(scopeErr?.code, 'mobile_scope');
  assert.match(p.describeFailure(scopeErr), /terminal\.show/);

  const f = new PairedTransport({ ...future.secret(), label: 'Future' });
  const verErr = await f.open().then(() => null, (e) => e);
  assert.equal(verErr?.code, 'incompatible');
  assert.match(f.describeFailure(verErr), /Update orca-wow/);

  // Nothing listening: "Can't reach".
  const port = mac.port;
  await mac.stop();
  const gone = new PairedTransport({ ...mac.secret(), endpoint: `ws://127.0.0.1:${port}`, label: 'MacBook', timeoutMs: 3000 });
  const goneErr = await gone.open().then(() => null, (e) => e);
  assert.equal(gone.describeFailure(goneErr), "Can't reach Orca on MacBook");
});

test('a host that spoke E2EE v2 never gets the legacy framing again, across restarts', async (t) => {
  const mac = await macOrca().start();
  const secretsDir = tempDir();
  const fleets = [];
  t.after(async () => {
    for (const f of fleets) f.stop();
    await mac.stop();
    fs.rmSync(secretsDir, { recursive: true, force: true });
  });
  const id = remoteIdFor(mac.secret());
  // A pairing saved before the latch existed: no e2ee, no allowLegacy.
  saveRemoteSecret({ id, label: 'MacBook', ...mac.secret() }, secretsDir);
  const remotes = [{ code: 'e1', label: 'MacBook', id, endpoint: mac.endpoint }];
  const fleet = (logs = []) => {
    const f = new OrcaFleet({ local: false, secretsDir, pollMs: 40, retryMs: 50, remotes, log: (l) => logs.push(l) });
    fleets.push(f);
    f.start();
    return f;
  };

  const first = fleet();
  await waitFor(() => first.envs[0].client.state === 'connected');
  first.stop();
  const saved = readRemoteSecret(id, secretsDir);
  assert.equal(saved.e2ee, 'v2', 'remembered on disk');
  assert.equal(saved.deviceToken, mac.deviceToken);

  // Now something on the network refuses every v2 hello (close 4001 before the ready).
  mac.legacyOnly = true;
  const logs = [];
  const second = fleet(logs);
  await waitFor(() => second.envs[0].client.state === 'offline' && mac.hellos.length >= 3);
  second.stop();
  // A fresh transport built from the file (as `orca-wow remote list` does) holds too.
  const probe = new PairedTransport({ ...readRemoteSecret(id, secretsDir), label: 'MacBook' });
  assert.equal((await probe.open().then(() => null, (e) => e))?.code, 'downgrade');
  assert.ok(!mac.hellos.includes('legacy'), 'never offered the legacy framing');
  assert.deepEqual(mac.handshakes, ['v2']);
});

test('a new pairing gets the legacy framing only when allowed, or when the pinned host itself asks', async (t) => {
  const old = await macOrca({ legacyOnly: true }).start();
  const between = await macOrca({ oldV2Auth: true }).start();
  t.after(() => Promise.all([old.stop(), between.stop()]));

  const strict = new PairedTransport({ ...old.secret(), allowLegacy: false, label: 'Old Mac' });
  assert.equal((await strict.open().then(() => null, (e) => e))?.code, 'legacy_refused');
  assert.deepEqual(old.hellos, ['v2'], 'an unauthenticated refusal is not enough');

  const logs = [];
  const allowed = new PairedTransport({ ...old.secret(), allowLegacy: true, label: 'Old Mac', log: (l) => logs.push(l) });
  for (let i = 0; i < 2; i++) (await allowed.open()).conn.close();
  assert.equal(allowed.framing, 'legacy');
  assert.equal(logs.length, 2, 'every legacy connection is logged');

  // A sealed bad_auth comes from the host the link pins: the fallback is its own choice.
  const latched = [];
  const tr = new PairedTransport({ ...between.secret(), allowLegacy: false, label: 'Mac', onLatch: () => latched.push(1) });
  (await tr.open()).conn.close();
  assert.equal(tr.framing, 'legacy');
  assert.deepEqual(between.hellos, ['v2', 'legacy']);
  assert.equal(latched.length, 0, 'not remembered as a v2 host');
});

// ---- a whole client over the WebSocket --------------------------------------------

test('an OrcaClient over the paired WebSocket: threads, terminal reads, commands, screenshots', async (t) => {
  const mac = macOrca();
  // Enough rows that worktree.ps comes back as a compressed frame.
  for (let i = 0; i < 12; i++) mac.orca.worktrees.push(worktreeRow({ worktreeId: `mac-repo::/Users/me/src/game/w${i}`, repoId: 'mac-repo', displayName: `w${i}`, agents: [] }));
  mac.orca.worktrees.push(worktreeRow({ worktreeId: 'mac-repo::/Users/me/src/game/ask', repoId: 'mac-repo', displayName: 'ask', agents: [agentRow({ paneKey: 'tab-5:leaf-1', state: 'blocked', toolName: 'Bash', toolInput: 'npm test' })] }));
  mac.orca.terminals.push({ handle: 'mh2', worktreeId: 'mac-repo::/Users/me/src/game/ask', tabId: 'tab-5', leafId: 'leaf-1' });
  mac.orca.screens.mh2 = [' Do you want to proceed?', ' ❯ 1. Yes', '   2. No (esc)'];
  mac.orca.waits.mh2 = { source: 'hook', reason: 'agent-approval-prompt' };
  await mac.start();
  const logs = [];
  const stateDir = tempDir();
  const client = new OrcaClient({ transport: new PairedTransport({ ...mac.secret(), label: 'MacBook' }), stateDir, pollMs: 40, keyDelayMs: 1, retryMs: 50, log: (...a) => logs.push(a.join(' ')) });
  client.start();
  t.after(async () => {
    client.stop();
    await mac.stop();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
  await waitFor(() => client.state === 'connected' && client.threads.size === 2);
  assert.ok(mac.compressedReplies > 0, 'read a gzip-compressed reply');
  const id = threadIdFor(MAC_ROW.worktreeId, 'tab-9:leaf-1');
  assert.equal(client.threads.get(id).projectId, projectIdFor('mac-repo'));
  assert.equal(client.config.environment.serverVersion, '1.4.300');

  const proj = await client.threadProjection(id);
  assert.match(proj.messages.at(-1).text, /Polishing the UI/);
  await client.sendMessage(id, 'Also fix the minimap');
  const send = mac.orca.callsOf('terminal.send').at(-1);
  assert.equal(send.terminal, 'mh1');
  assert.equal(send.text, 'Also fix the minimap');
  assert.equal(send.enter, true);
  assert.ok(mac.requests.every((r) => r.authToken === undefined && r.deviceToken === mac.deviceToken));

  const ask = threadIdFor('mac-repo::/Users/me/src/game/ask', 'tab-5:leaf-1');
  const askProj = await client.threadProjection(ask);
  assert.equal(askProj.runtimeRequests[0].kind, 'command');
  await client.respondApproval(ask, askProj.runtimeRequests[0].id, 'accept');
  assert.equal(mac.orca.callsOf('terminal.send').at(-1).text, '1');

  // A screenshot travels to the Mac (in chunks) and the prompt names the Mac's path.
  const png = Buffer.alloc(700 * 1024, 7);
  const att = await client.uploadImage(id, png, 'shot.png', 'image/png');
  assert.match(att.path, /^\/var\/folders\/tmp\/orca-paste-[0-9a-f]+\/shot\.png$/);
  assert.equal(mac.orca.callsOf('clipboard.appendImageUploadChunk').length, 2);
  assert.ok([...mac.uploads.values()].some((u) => u.bytes?.equals(png)));
  await client.sendMessage(id, 'Look at this', 'auto', [att]);
  assert.match(mac.orca.callsOf('terminal.send').at(-1).text, new RegExp(att.path.replace(/[/.]/g, '\\$&')));

  const all = logs.join('\n');
  assert.match(all, /connected to ws:\/\/127\.0\.0\.1/);
  assert.ok(!all.includes(mac.deviceToken) && !all.includes(mac.publicKeyB64), 'no secrets in the log');
});

// ---- a fleet: this PC's Orca and a Mac's -----------------------------------------

async function fleetSetup(t, { macOver = {}, remotes } = {}) {
  const dir = tempDir();
  const local = new FakeOrca({ dir });
  local.worktrees = [worktreeRow({ agents: [agentRow({ state: 'done', lastAssistantMessage: 'Fixed.' })] })];
  local.terminals = [{ handle: 'h1', worktreeId: 'repo-1::C:/src/app/fix-login', tabId: 'tab-1', leafId: 'leaf-1' }];
  local.screens.h1 = ['Fixed.'];
  await local.start();
  const mac = await macOrca(macOver).start();
  const secretsDir = tempDir();
  const stateDir = tempDir();
  const id = remoteIdFor(mac.secret());
  saveRemoteSecret({ id, label: 'MacBook', ...mac.secret() }, secretsDir);
  const fleet = new OrcaFleet({ userDataDir: dir, stateDir, secretsDir, pollMs: 40, keyDelayMs: 1, retryMs: 50, remotes: remotes || [{ code: 'e1', label: 'MacBook', id, endpoint: mac.endpoint }] });
  const events = [];
  fleet.on('change', (ev) => events.push(ev));
  fleet.start();
  t.after(async () => {
    fleet.stop();
    await local.stop().catch(() => {});
    await mac.stop().catch(() => {});
    for (const d of [dir, secretsDir, stateDir]) fs.rmSync(d, { recursive: true, force: true });
  });
  return { fleet, local, mac, events, id, secretsDir, stateDir, dir };
}

test('a fleet shows this PC\'s Orca and the Mac\'s, and routes commands to the right one', async (t) => {
  const { fleet, local, mac } = await fleetSetup(t);
  await waitFor(() => fleet.envs.every((e) => e.client.state === 'connected') && fleet.threads.size === 2);
  const localId = threadIdFor('repo-1::C:/src/app/fix-login', 'tab-1:leaf-1');
  const macId = `e1~${threadIdFor(MAC_ROW.worktreeId, 'tab-9:leaf-1')}`;
  assert.deepEqual([...fleet.threads.keys()].sort(), [localId, macId].sort());
  assert.deepEqual(fleet.threads.get(macId)._env, { code: 'e1', label: 'MacBook', local: false });
  assert.equal(fleet.threads.get(localId)._env.local, true);
  assert.equal(fleet.threads.get(macId).projectId, `e1~${projectIdFor('mac-repo')}`);
  assert.ok(fleet.projects.has(`e1~${projectIdFor('mac-repo')}`) && fleet.projects.has(projectIdFor('repo-1')));
  assert.equal(fleet.state, 'connected');
  assert.equal(fleet.error, null);
  assert.deepEqual(fleet.environments().map((e) => [e.code, e.label, e.state, e.threads]), [['', 'This PC', 'connected', 1], ['e1', 'MacBook', 'connected', 1]]);

  // Writes go to the machine named by the id.
  await fleet.sendMessage(macId, 'Hello Mac');
  assert.equal(mac.orca.callsOf('terminal.send').at(-1).text, 'Hello Mac');
  assert.equal(local.callsOf('terminal.send').length, 0);
  await fleet.sendMessage(localId, 'Hello PC');
  assert.equal(local.callsOf('terminal.send').at(-1).text, 'Hello PC');
  assert.equal(mac.orca.callsOf('terminal.send').length, 1);
  const proj = await fleet.threadProjection(macId);
  assert.match(proj.messages.at(-1).text, /Polishing/);

  const res = await fleet.launchThread(`e1~${projectIdFor('mac-repo')}`, 'Add a minimap', [], { agent: 'codex', name: 'minimap' });
  assert.match(res.threadId, /^e1~o/);
  const create = mac.orca.callsOf('worktree.create').at(-1);
  assert.equal(create.repo, 'id:mac-repo');
  assert.equal(create.startupAgent, 'codex');
  assert.equal(local.callsOf('worktree.create').length, 0);
  assert.ok(fleet.threads.has(res.threadId), 'the new agent shows (starting) under its prefixed id');

  await assert.rejects(fleet.sendMessage('e7~nope', 'x'), /gone/);
  assert.deepEqual(fleet.agentChoices().default, 'claude');
});

test('an unreachable Mac is offline while this PC stays connected, and reconnects when it is back', async (t) => {
  const { fleet, mac } = await fleetSetup(t);
  await waitFor(() => fleet.threads.size === 2);
  const port = mac.port;
  await mac.stop();
  await waitFor(() => fleet.envs[1].client.state === 'offline');
  assert.equal(fleet.envs[1].client.error, "Can't reach Orca on MacBook");
  assert.equal(fleet.state, 'connected');
  assert.equal(fleet.error, null, 'no error while any Orca is connected');
  assert.equal(fleet.threads.size, 1, "the Mac's agents leave with it");
  assert.ok([...fleet.threads.values()].every((th) => th._env.local));
  assert.equal(fleet.environments()[1].error, "Can't reach Orca on MacBook");

  // Back on the same address: the bridge reconnects (re-running the handshake) by itself.
  const back = macOrca({ port, deviceToken: mac.deviceToken });
  back.keys = mac.keys;
  await back.start();
  t.after(() => back.stop());
  await waitFor(() => fleet.envs[1].client.state === 'connected' && fleet.threads.size === 2, 10000);
  assert.deepEqual(back.handshakes, ['v2']);
});

test('only remotes: an unreachable one is the error the game shows', async (t) => {
  const mac = await macOrca().start();
  const secretsDir = tempDir();
  const id = remoteIdFor(mac.secret());
  saveRemoteSecret({ id, label: 'MacBook', ...mac.secret() }, secretsDir);
  assert.equal(readRemoteSecret(id, secretsDir).deviceToken, mac.deviceToken);
  await mac.stop();
  const fleet = new OrcaFleet({ local: false, secretsDir, retryMs: 50, remotes: [{ code: 'e1', label: 'MacBook', id, endpoint: mac.endpoint }, { code: 'e2', label: 'Studio', id: 'mmissing', endpoint: 'ws://10.0.0.9:6768' }] });
  fleet.start();
  t.after(() => {
    fleet.stop();
    fs.rmSync(secretsDir, { recursive: true, force: true });
  });
  await waitFor(() => fleet.envs.every((e) => e.client.state === 'offline'));
  assert.equal(fleet.state, 'offline');
  assert.match(fleet.error, /Can't reach Orca on MacBook/);
  assert.match(fleet.error, /Studio's pairing is missing/);
  assert.equal(fleet.config.environment.label, undefined, 'no connected machine to name');
  await assert.rejects(fleet.sendMessage('plain-id', 'x'), /gone/, 'no local Orca to route an unprefixed id to');
});

test('the bridge labels the Mac\'s agents and projects with its name', async (t) => {
  const dir = tempDir();
  const local = new FakeOrca({ dir });
  local.worktrees = [worktreeRow({ agents: [agentRow({ state: 'done' })] })];
  await local.start();
  const mac = await macOrca().start();
  const secretsDir = tempDir();
  const stateDir = tempDir();
  const addonsDir = tempDir();
  const id = remoteIdFor(mac.secret());
  saveRemoteSecret({ id, label: 'MacBook', ...mac.secret() }, secretsDir);
  const b = new Bridge({ addonsDir, stateDir, log: () => {}, config: { slots: 10, orca: { userDataDir: dir, secretsDir, pollMs: 40, retryMs: 50, remotes: [{ code: 'e1', label: 'MacBook', id, endpoint: mac.endpoint }] } } });
  t.after(async () => {
    b.stop();
    await local.stop().catch(() => {});
    await mac.stop().catch(() => {});
    for (const d of [dir, secretsDir, stateDir, addonsDir]) fs.rmSync(d, { recursive: true, force: true });
  });
  b.agents.on('change', (ev) => b.onAgentsChange(ev));
  b.agents.start();
  await waitFor(() => b.agents.state === 'connected' && b.agents.threads.size === 2);
  const snap = b.buildSnapshot();
  const macThread = snap.threads.find((x) => x.id.startsWith('e1~'));
  assert.equal(macThread.env, 'MacBook');
  assert.equal(snap.threads.find((x) => !x.id.startsWith('e1~')).env, undefined);
  assert.ok(snap.projects.some((p) => p.env === 'MacBook' && /game · MacBook/.test(p.name)));
  assert.deepEqual(snap.bridge.envs.map((e) => [e.label, e.state, e.n]), [['This PC', 'connected', 1], ['MacBook', 'connected', 1]]);
  // The remote's archive bookkeeping lives apart from this PC's.
  await b.runCommand({ id: 9, verb: 'archive', args: [macThread.id] });
  assert.equal(b.results.find((r) => r.id === 9)?.ok, true, b.results.find((r) => r.id === 9)?.msg);
  assert.ok(fs.existsSync(path.join(stateDir, 'remotes', id, 'orca-archived.json')));
  assert.ok(!fs.existsSync(path.join(stateDir, 'orca-archived.json')));
});

// ---- the CLI ---------------------------------------------------------------------------

function cli(args, env, input = '') {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [path.join(HERE, '..', 'bin', 'orca-wow.js'), ...args], { env, timeout: 30000 }, (err, stdout, stderr) => resolve({ code: err ? err.code ?? 1 : 0, out: stdout + stderr }));
    child.stdin.end(input);
  });
}

test('orca-wow remote add/list/remove and local on|off keep secrets out of config.json', async (t) => {
  const mac = await macOrca().start();
  const home = tempDir();
  // Point every per-user folder at a temp dir, so this never touches the real install.
  const env = { ...process.env, LOCALAPPDATA: home, APPDATA: home, XDG_CONFIG_HOME: path.join(home, 'cfg'), XDG_STATE_HOME: path.join(home, 'state'), XDG_DATA_HOME: path.join(home, 'data'), HOME: home, USERPROFILE: home };
  const configDir = process.platform === 'win32' ? path.join(home, 'orca-wow', 'config') : path.join(home, 'cfg', 'orca-wow');
  t.after(async () => {
    await mac.stop();
    fs.rmSync(home, { recursive: true, force: true });
  });

  const phone = await cli(['remote', 'add', 'Phone', mac.link({ scope: 'mobile' })], env);
  assert.notEqual(phone.code, 0);
  assert.match(phone.out, /phone pairing/);

  const bad = await cli(['remote', 'add', 'MacBook', mac.link({ deviceToken: 'wrong-token-abc' })], env);
  assert.notEqual(bad.code, 0);
  assert.match(bad.out, /no longer accepts/);
  assert.ok(!fs.existsSync(path.join(configDir, 'config.json')), 'nothing saved for a refused link');

  // The link comes in on stdin (pasted, or piped from the clipboard), not as an argument.
  const add = await cli(['remote', 'add', 'MacBook'], env, `${mac.link()}\r\n`);
  assert.equal(add.code, 0, add.out);
  assert.match(add.out, /Connected to Orca 1\.4\.300 on MacBook/);
  const raw = fs.readFileSync(path.join(configDir, 'config.json'), 'utf8');
  const cfg = JSON.parse(raw);
  const id = remoteIdFor(mac.secret());
  assert.deepEqual(cfg.orca.remotes, [{ code: 'e1', label: 'MacBook', id, endpoint: `${mac.endpoint}/` }]);
  assert.ok(!raw.includes(mac.deviceToken) && !raw.includes(mac.publicKeyB64), 'no secrets in config.json');
  const secret = JSON.parse(fs.readFileSync(path.join(configDir, 'remotes', `${id}.json`), 'utf8'));
  assert.equal(secret.deviceToken, mac.deviceToken);
  assert.equal(secret.publicKeyB64, mac.publicKeyB64);
  assert.equal(secret.e2ee, 'v2', 'the probe recorded that this host speaks E2EE v2');
  assert.equal(secret.allowLegacy, false);

  const list = await cli(['remote', 'list'], env);
  assert.match(list.out, /MacBook.*online \(Orca 1\.4\.300\)/);

  assert.equal((await cli(['local', 'off'], env)).code, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8')).orca.local, false);
  assert.match((await cli(['local'], env)).out, /hidden/);
  assert.equal((await cli(['local', 'on'], env)).code, 0);

  const rm = await cli(['remote', 'remove', 'macbook'], env);
  assert.equal(rm.code, 0, rm.out);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8')).orca.remotes, []);
  assert.ok(!fs.existsSync(path.join(configDir, 'remotes', `${id}.json`)));
  assert.match((await cli(['help'], env)).out, /remote add <name>/);
});

test('the CLI prints another computer\'s text without terminal control codes', async (t) => {
  // An Orca (or a link's author) that answers with ESC/OSC sequences: OSC 52 writes the clipboard.
  const evil = await macOrca({ appVersion: '1.4\x1b]52;c;ZXZpbA==\x07\x1b[2J‮' }).start();
  const home = tempDir();
  const env = { ...process.env, LOCALAPPDATA: home, APPDATA: home, XDG_CONFIG_HOME: path.join(home, 'cfg'), XDG_STATE_HOME: path.join(home, 'state'), XDG_DATA_HOME: path.join(home, 'data'), HOME: home, USERPROFILE: home };
  t.after(async () => {
    await evil.stop();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const controls = /[\x00-\x09\x0b-\x1f\x7f-\x9f‪-‮]/;
  const add = await cli(['remote', 'add', 'Evil', evil.link()], env);
  assert.equal(add.code, 0, add.out);
  assert.doesNotMatch(add.out.replace(/\r?\n/g, ''), controls);
  const list = await cli(['remote', 'list'], env);
  assert.match(list.out, /Evil.*online/);
  assert.doesNotMatch(list.out.replace(/\r?\n/g, ''), controls);
  // Refused requests: the host's error text is plain by the time anyone logs or shows it.
  evil.orca.handlers['repo.list'] = () => {
    throw new Error('nope\x1b]52;c;ZXZpbA==\x07');
  };
  const tr = new PairedTransport({ ...evil.secret(), label: 'Evil' });
  const { conn, status } = await tr.open();
  t.after(() => conn.close());
  assert.doesNotMatch(status.appVersion, controls);
  const err = await conn.call('repo.list', {}).then(() => null, (e) => e);
  assert.equal(err?.message, 'nope]52;c;ZXZpbA==');
});
