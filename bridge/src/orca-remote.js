// A paired connection to an Orca on another computer: the access link it hands out,
// and the end-to-end encrypted WebSocket its CLI, desktop clients and phone app use.
//
// The link. Orca's "access link" (Settings > Remote Orca Servers > New Link >
// Generate Access Link, or `orca pair --address <ip>`) is `orca://pair?code=<base64url
// JSON>`, the JSON being { v: 2, endpoint: 'ws://host:6768', deviceToken,
// publicKeyB64, scope: 'runtime' | 'mobile', pairedDeviceId?, relay?, hostDescriptor? }
// (src/shared/remote-runtime/pairing/pairing.ts, mobile-relay-pairing-offer.ts). The
// device token is this PC's revocable grant and the public key pins the host's
// Curve25519 key, so both are secrets kept out of config.json.
//
// The socket. Every paired client opens the WebSocket, sends a plaintext hello, gets a
// plaintext ready, then sends an encrypted auth carrying the device token; after
// "authenticated" every frame is sealed. Orca's CLI dials E2EE v2 first and redials
// with the legacy framing only when an unproven host refuses the v2 hello (close 4001
// before its ready) or answers v2 token auth with bad_auth (hosts that predate
// capabilities on it): src/shared/remote-runtime/remote-runtime-client-framing.ts.
// We do the same, but stricter (see PairedTransport): a host that already spoke v2 to
// us is remembered on disk and never gets legacy again, and new pairings get legacy
// only when the user opted in.
//   v2 (mobile-e2ee-v2-contract.ts, paired-e2ee-v2-client-session.ts,
//       mobile-e2ee-v2-framing.ts, mobile-e2ee-v2-node-key-schedule.ts):
//     hello  {type:'e2ee_hello', v:2, clientPublicKeyB64, clientNonceB64,
//             capabilities:{framing:[2], payloadKinds:['text','binary']},
//             context:{protocol:'orca-mobile-e2ee', initiator:'mobile',
//                      responder:'desktop', transport:'direct'}}
//     ready  {type:'e2ee_ready', v:2, desktopPublicKeyB64, clientNonceB64,
//             desktopNonceB64, selection:{framing:2, payloadKinds:[...]}, context}
//     keys   HKDF-SHA256(box.before(desktopPub, clientSecret), salt =
//            sha256("orca-mobile-e2ee/v2/salt\0" | nonces), info =
//            "orca-mobile-e2ee/v2/session\0" | sha256(transcript)) -> 96 bytes:
//            mobile->desktop key | desktop->mobile key | session id
//     frame  nonce(24) | secretbox(header(42) | payload); the nonce and header carry
//            the session id, direction, payload kind and a per-direction counter.
//            Text frames travel base64 in text messages, binary ones raw.
//     auth   {type:'e2ee_auth', v:2, transcriptHashB64, deviceToken, clientCapabilities}
//            -> {type:'e2ee_authenticated', v:2, transcriptHashB64}
//   legacy (paired-e2ee-client-handshake.ts, node/e2ee-crypto.ts):
//     hello {type:'e2ee_hello', publicKeyB64} -> {type:'e2ee_ready'}; every frame is
//     base64(nonce24 | box.after(plaintext, nonce, box.before(desktopPub, ours)));
//     auth {type:'e2ee_auth', deviceToken, clientCapabilities} -> {type:'e2ee_authenticated'}.
// A refused token comes back sealed as {type:'e2ee_error', error:{code:'unauthorized'}}
// followed by close 4001 (src/main/runtime/rpc/e2ee-channel.ts).
//
// Requests are then the CLI's envelope {id, deviceToken, method, params} (the host
// checks the token against the one the socket authenticated with) and replies the
// usual {id, ok, result | error, _meta}; `{_keepalive:true}` means "still working".
// We advertise transport.compressed-frames.v1, so large replies may come as a sealed
// binary frame holding 0x7a | kind | u32le length | gzip (paired-e2ee-compressed-frame.ts).
//
// Scope: a phone ("mobile") pairing only reaches the methods on Orca's phone allowlist
// (src/main/runtime/rpc/server/runtime-rpc-mobile-method-routing.ts), which lacks
// terminal.show, so the bridge needs a "runtime" access link (another Orca's).
// Protocol: we are a runtime protocol 3 client and need a host of protocol >= 2
// (src/shared/protocol-version.ts, the CLI's remote-runtime-compat-gate.ts).

import { createRequire } from 'node:module';
import { createHash, hkdfSync, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { OrcaRpcError } from './orca.js';
import { CONFIG_DIR, THIS_COMPUTER } from './paths.js';

const nacl = createRequire(import.meta.url)('../vendor/tweetnacl/nacl-fast.js');
export { nacl };

export const RUNTIME_PROTOCOL_VERSION = 3;
export const MIN_SERVER_PROTOCOL_VERSION = 2;
export const COMPRESSED_FRAMES = 'transport.compressed-frames.v1';
export const DEFAULT_SECRETS_DIR = path.join(CONFIG_DIR, 'remotes');

// mobile-pairing-protocol-limits.ts
const CODE_MAX = 128 * 1024;
const INPUT_MAX = CODE_MAX + 1024;
const ENDPOINT_MAX = 16 * 1024;
const TOKEN_MAX = 64 * 1024;
const KEY_MAX = 4 * 1024;
const INVITE_TTL_MS = 10 * 60 * 1000 + 30 * 1000;
// A host closes a socket on a client frame over 1 MB; sealing inflates JSON by 4/3
// plus the nonce/MAC/header (remote-runtime-memory-limits.ts).
const MAX_REQUEST_JSON = Math.floor((1024 * 1024) / 4) * 3 - 128;
const MAX_INFLATED = 4 * 1024 * 1024;
// remote-runtime-client-framing.ts: try v2 again this long after a host refused it.
const V2_REFUSAL_MEMORY_MS = 30 * 60 * 1000;

const V2_PROTOCOL = 'orca-mobile-e2ee';
const TRANSCRIPT_DOMAIN = 'orca-mobile-e2ee/v2/transcript';
const SALT_LABEL = Buffer.from('orca-mobile-e2ee/v2/salt\0');
const INFO_LABEL = Buffer.from('orca-mobile-e2ee/v2/session\0');
const NONCE_LEN = 24;
const SESSION_ID_LEN = 32;
const HEADER_LEN = SESSION_ID_LEN + 1 + 1 + 8;
const FRAME_VERSION = 2;

export class RemoteError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const remoteError = (code, message) => new RemoteError(code, message);

// Text that came from a link or another computer, safe to print or log: no C0/C1
// controls (so no ESC/OSC sequences: colours, cursor moves, OSC 52 clipboard writes)
// and no bidi overrides. Line breaks and tabs become spaces unless `lines` keeps \n.
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;
export function plainText(value, { lines = false } = {}) {
  let s = String(value ?? '');
  s = lines ? s.replace(/\r\n?/g, '\n').replace(/\t/g, ' ') : s.replace(/[\r\n\t]+/g, ' ');
  return s.replace(CONTROLS, '');
}

// ---- the access link -----------------------------------------------------------

export class PairingLinkError extends Error {
  constructor(message) {
    super(message);
    this.code = 'invalid_link';
  }
}

const WHERE = "On the other computer, open Orca's Settings > Remote Orca Servers, click New Link, pick its network address and click Generate Access Link (or run `orca pair --address <its LAN IP>` there), then copy the orca://pair?code=... link.";

function decodeBase64Url(code) {
  if (!code || code.length > CODE_MAX || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(code)) return null;
  const b64 = code.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (b64.length % 4 === 1) return null;
  return Buffer.from(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='), 'base64').toString('utf8');
}

function decodeKey(b64) {
  if (typeof b64 !== 'string' || !b64 || b64.length > 44) return null;
  const key = Buffer.from(b64, 'base64');
  return key.length === 32 ? new Uint8Array(key) : null;
}

// An access link (orca://pair?code=... or the bare code) as the offer it carries.
// Throws PairingLinkError with a message for a person; never echoes the link.
export function parseAccessLink(input, { now = Date.now() } = {}) {
  const text = String(input ?? '').trim();
  if (!text) throw new PairingLinkError(`No access link given. ${WHERE}`);
  if (text.length > INPUT_MAX) throw new PairingLinkError("That's too long to be an Orca access link.");
  let code;
  if (/^orca:/i.test(text)) {
    let url;
    try {
      url = new URL(text);
    } catch {
      url = null;
    }
    // The exact host, so orca://pairing or orca://pair/x can't pass for a pairing.
    if (!url || url.protocol !== 'orca:' || url.hostname !== 'pair' || (url.pathname !== '' && url.pathname !== '/')) {
      throw new PairingLinkError(`That isn't an Orca access link (expected orca://pair?code=...). ${WHERE}`);
    }
    code = url.searchParams.get('code') || (url.hash ? url.hash.slice(1) : '');
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(text)) {
    throw new PairingLinkError(`That's a web address, not an access link. Copy the orca://pair?code=... link instead. ${WHERE}`);
  } else {
    code = text;
  }
  const json = decodeBase64Url(code);
  let offer;
  try {
    offer = json && JSON.parse(json);
  } catch {
    offer = null;
  }
  if (!offer || typeof offer !== 'object' || Array.isArray(offer)) {
    throw new PairingLinkError(`That access link is incomplete or garbled (copy all of it). ${WHERE}`);
  }
  if (offer.v !== 2) throw new PairingLinkError(`That access link comes from an Orca version this bridge doesn't know (offer version ${JSON.stringify(offer.v)}). Update Orca and orca-wow.`);
  if (typeof offer.endpoint !== 'string' || !offer.endpoint || offer.endpoint.length > ENDPOINT_MAX) throw new PairingLinkError('That access link has no address to connect to.');
  let endpoint;
  try {
    endpoint = new URL(offer.endpoint);
  } catch {
    endpoint = null;
  }
  if (!endpoint || (endpoint.protocol !== 'ws:' && endpoint.protocol !== 'wss:')) throw new PairingLinkError("That access link's address isn't a ws:// or wss:// address.");
  if (typeof offer.deviceToken !== 'string' || !offer.deviceToken || offer.deviceToken.length > TOKEN_MAX) throw new PairingLinkError('That access link carries no access token.');
  if (typeof offer.publicKeyB64 !== 'string' || offer.publicKeyB64.length > KEY_MAX || !decodeKey(offer.publicKeyB64)) throw new PairingLinkError("That access link's host key is malformed.");
  if (offer.scope !== undefined && offer.scope !== 'mobile' && offer.scope !== 'runtime') throw new PairingLinkError(`That access link has an unknown scope (${JSON.stringify(offer.scope)}).`);
  if (offer.pairedDeviceId !== undefined && (typeof offer.pairedDeviceId !== 'string' || !offer.pairedDeviceId || offer.pairedDeviceId.length > 128)) throw new PairingLinkError('That access link is malformed (pairedDeviceId).');
  if (offer.relay !== undefined) {
    // Orca's schema: Relay is phone-only, and its invite lasts 10 minutes.
    if (offer.scope === 'runtime') throw new PairingLinkError('That access link is malformed (a Relay invite on a runtime link).');
    const exp = offer.relay?.inviteExpiresAt;
    if (!Number.isInteger(exp) || exp <= now || exp > now + INVITE_TTL_MS) throw new PairingLinkError(`That pairing link has expired. Make a new one. ${WHERE}`);
  }
  // The normalised form: WHATWG URL parsing drops or percent-encodes control characters.
  const out = { v: 2, endpoint: endpoint.href, deviceToken: offer.deviceToken, publicKeyB64: offer.publicKeyB64 };
  if (offer.scope) out.scope = offer.scope;
  if (offer.pairedDeviceId) out.pairedDeviceId = offer.pairedDeviceId;
  if (offer.hostDescriptor && typeof offer.hostDescriptor === 'object') out.hostDescriptor = offer.hostDescriptor;
  return out;
}

export function encodeAccessLink(offer) {
  return `orca://pair?code=${Buffer.from(JSON.stringify(offer)).toString('base64url')}`;
}

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|::1)$/i;

// Problems with a parsed link that make it useless to the bridge: { error } refuses it,
// { warning } only needs saying.
export function checkAccessLink(offer) {
  if (offer.scope === 'mobile') {
    return { error: `That's a phone pairing (Orca Mobile). Phones can't use terminal.show, which the bridge needs, so make an access link for another Orca instead. ${WHERE} (Without --mobile.)` };
  }
  const host = new URL(offer.endpoint).hostname;
  if (LOOPBACK.test(host)) {
    return { warning: `That link points at ${host}, which is the other computer itself. Unless you tunnel it here, make the link with its LAN address instead.` };
  }
  return {};
}

// A stable id for a paired host: its pinned key, so a new link to the same Orca
// replaces the old pairing instead of adding a second machine.
export function remoteIdFor(offer) {
  return 'm' + createHash('sha256').update(String(offer.publicKeyB64)).digest('hex').slice(0, 12);
}

// ---- secrets on disk -------------------------------------------------------------

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/i;

export function remoteSecretFile(id, dir = DEFAULT_SECRETS_DIR) {
  if (!ID_RE.test(String(id))) throw new Error(`bad remote id ${JSON.stringify(id)}`);
  return path.join(dir, `${id}.json`);
}

// { id, label, endpoint, deviceToken, publicKeyB64, scope?, pairedDeviceId?, addedAt,
//   allowLegacy?, e2ee? }. allowLegacy: the user opted in to the legacy framing
// (`remote add --allow-legacy`); records saved before that option existed lack it.
// e2ee: 'v2' once this host authenticated us over E2EE v2, after which the bridge
// never falls back to legacy for it, across restarts.
export function saveRemoteSecret(record, dir = DEFAULT_SECRETS_DIR) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = remoteSecretFile(record.id, dir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

export function readRemoteSecret(id, dir = DEFAULT_SECRETS_DIR) {
  try {
    const rec = JSON.parse(fs.readFileSync(remoteSecretFile(id, dir), 'utf8'));
    return rec && typeof rec.deviceToken === 'string' && typeof rec.publicKeyB64 === 'string' && typeof rec.endpoint === 'string' ? rec : null;
  } catch {
    return null;
  }
}

// Record that this host spoke E2EE v2 (see saveRemoteSecret). A removed pairing stays
// removed. Returns whether the file now says so.
export function markRemoteV2(id, dir = DEFAULT_SECRETS_DIR) {
  const rec = readRemoteSecret(id, dir);
  if (!rec) return false;
  if (rec.e2ee !== 'v2') saveRemoteSecret({ ...rec, e2ee: 'v2' }, dir);
  return true;
}

export function removeRemoteSecret(id, dir = DEFAULT_SECRETS_DIR) {
  fs.rmSync(remoteSecretFile(id, dir), { force: true });
}

// ---- E2EE primitives -------------------------------------------------------------

const utf8 = (s) => new Uint8Array(Buffer.from(s, 'utf8'));
const b64 = (bytes) => Buffer.from(bytes).toString('base64');

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function uint32(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, false);
  return b;
}

function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

// Canonical base64 of exactly `length` bytes, or null (mobile-e2ee-v2-contract.ts).
export function decodeCanonical(value, length) {
  if (typeof value !== 'string') return null;
  if (length !== undefined && value.length !== Math.ceil(length / 3) * 4) return null;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || (length !== undefined && bytes.length !== length)) return null;
  return new Uint8Array(bytes);
}

export function sha256(bytes) {
  return new Uint8Array(createHash('sha256').update(bytes).digest());
}

// box.before(peerPublic, ourSecret): the key both legacy framing and v2's HKDF start from.
export function sharedKey(ourSecretKey, peerPublicKey) {
  return nacl.box.before(peerPublicKey, ourSecretKey);
}

export function sealLegacy(plaintext, key, nonce = nacl.randomBytes(NONCE_LEN)) {
  return concat([nonce, nacl.box.after(plaintext, nonce, key)]);
}

export function openLegacy(bundle, key) {
  if (bundle.length < NONCE_LEN + nacl.box.overheadLength) return null;
  return nacl.box.open.after(bundle.subarray(NONCE_LEN), bundle.subarray(0, NONCE_LEN), key);
}

const STR_LIST = (list) => concat([uint32(list.length), ...list.map((s) => concat([uint32(utf8(s).length), utf8(s)]))]);
const NUM_LIST = (list) => concat([uint32(list.length), ...list.map(uint32)]);

// The length-prefixed transcript both peers hash (encodeMobileE2EEV2Transcript).
export function encodeV2Transcript(hello, ready) {
  const fields = [
    ['domain', utf8(TRANSCRIPT_DOMAIN)],
    ['mobile-to-desktop.type', utf8(hello.type)],
    ['mobile-to-desktop.version', uint32(hello.v)],
    ['mobile-to-desktop.client-public-key', decodeCanonical(hello.clientPublicKeyB64, 32)],
    ['mobile-to-desktop.client-nonce', decodeCanonical(hello.clientNonceB64, 32)],
    ['mobile-to-desktop.capabilities.framing', NUM_LIST(hello.capabilities.framing)],
    ['mobile-to-desktop.capabilities.payload-kinds', STR_LIST(hello.capabilities.payloadKinds)],
    ['mobile-to-desktop.context.protocol', utf8(hello.context.protocol)],
    ['mobile-to-desktop.context.initiator', utf8(hello.context.initiator)],
    ['mobile-to-desktop.context.responder', utf8(hello.context.responder)],
    ['mobile-to-desktop.context.transport', utf8(hello.context.transport)],
    ['mobile-to-desktop.context.relay-host-id', utf8(hello.context.relayHostId ?? '')],
    ['desktop-to-mobile.type', utf8(ready.type)],
    ['desktop-to-mobile.version', uint32(ready.v)],
    ['desktop-to-mobile.desktop-public-key', decodeCanonical(ready.desktopPublicKeyB64, 32)],
    ['desktop-to-mobile.client-nonce-echo', decodeCanonical(hello.clientNonceB64, 32)],
    ['desktop-to-mobile.desktop-nonce', decodeCanonical(ready.desktopNonceB64, 32)],
    ['desktop-to-mobile.selection.framing', uint32(ready.selection.framing)],
    ['desktop-to-mobile.selection.payload-kinds', STR_LIST(ready.selection.payloadKinds)],
    ['desktop-to-mobile.context.protocol', utf8(ready.context.protocol)],
    ['desktop-to-mobile.context.initiator', utf8(ready.context.initiator)],
    ['desktop-to-mobile.context.responder', utf8(ready.context.responder)],
    ['desktop-to-mobile.context.transport', utf8(ready.context.transport)],
    ['desktop-to-mobile.context.relay-host-id', utf8(ready.context.relayHostId ?? '')],
  ];
  return concat(fields.map(([name, value]) => concat([uint32(utf8(name).length), utf8(name), uint32(value.length), value])));
}

export function deriveV2Keys({ sharedSecret, transcript, clientNonce, desktopNonce }) {
  const transcriptHash = sha256(transcript);
  const salt = sha256(concat([SALT_LABEL, clientNonce, desktopNonce]));
  const info = concat([INFO_LABEL, transcriptHash]);
  const out = new Uint8Array(hkdfSync('sha256', sharedSecret, salt, info, 96));
  return { mobileToDesktopKey: out.slice(0, 32), desktopToMobileKey: out.slice(32, 64), sessionId: out.slice(64, 96), transcriptHash };
}

function writeU64(target, offset, value) {
  let v = value;
  for (let i = 7; i >= 0; i--) {
    target[offset + i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

const DIRS = { 'mobile-to-desktop': 0, 'desktop-to-mobile': 1 };
const KINDS = { text: 0, binary: 1 };

function v2Nonce(sessionId, direction, kind, counter) {
  const n = new Uint8Array(NONCE_LEN);
  n.set(sessionId.subarray(0, 12), 0);
  n[12] = FRAME_VERSION;
  n[13] = DIRS[direction];
  n[14] = KINDS[kind];
  writeU64(n, 16, counter);
  return n;
}

function v2Header(sessionId, direction, kind, counter) {
  const h = new Uint8Array(HEADER_LEN);
  h.set(sessionId, 0);
  h[SESSION_ID_LEN] = DIRS[direction];
  h[SESSION_ID_LEN + 1] = KINDS[kind];
  writeU64(h, SESSION_ID_LEN + 2, counter);
  return h;
}

export function sealV2Frame({ payload, key, sessionId, direction, kind, counter }) {
  const nonce = v2Nonce(sessionId, direction, kind, counter);
  return concat([nonce, nacl.secretbox(concat([v2Header(sessionId, direction, kind, counter), payload]), nonce, key)]);
}

export function openV2Frame({ frame, key, sessionId, direction, kind, counter }) {
  if (frame.length < NONCE_LEN + nacl.secretbox.overheadLength + HEADER_LEN) return null;
  const nonce = v2Nonce(sessionId, direction, kind, counter);
  if (!equalBytes(frame.subarray(0, NONCE_LEN), nonce)) return null;
  const plain = nacl.secretbox.open(frame.subarray(NONCE_LEN), nonce, key);
  if (!plain || !equalBytes(plain.subarray(0, HEADER_LEN), v2Header(sessionId, direction, kind, counter))) return null;
  return plain.slice(HEADER_LEN);
}

// A sealed-binary payload that is a compressed frame: its text, or null for any other
// binary frame. Throws on a corrupt one.
export function inflateFrame(bytes) {
  if (bytes.length < 6 || bytes[0] !== 0x7a || (bytes[1] !== 1 && bytes[1] !== 2)) return null;
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(2, true);
  if (length > MAX_INFLATED) throw new Error(`compressed frame claims ${length} bytes`);
  const out = gunzipSync(bytes.subarray(6), { maxOutputLength: length + 1 });
  if (out.length !== length) throw new Error('compressed frame inflated to an unexpected length');
  return bytes[1] === 1 ? { kind: 'text', text: out.toString('utf8') } : { kind: 'binary', bytes: new Uint8Array(out) };
}

function isExact(obj, keys) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const a = Object.keys(obj).sort();
  const b = [...keys].sort();
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

function sameContext(a, b) {
  const keys = a?.transport === 'relay' ? ['protocol', 'initiator', 'responder', 'transport', 'relayHostId'] : ['protocol', 'initiator', 'responder', 'transport'];
  return isExact(a, keys) && isExact(b, keys) && keys.every((k) => a[k] === b[k]);
}

// The client side of one paired socket's handshake and framing ('v2' or 'legacy').
// clientKeyPair/clientNonce are for test vectors.
export function createClientHandshake({ framing, hostPublicKeyB64, clientKeyPair = nacl.box.keyPair(), clientNonce = nacl.randomBytes(32), transport = 'direct' }) {
  const pinned = decodeKey(hostPublicKeyB64);
  if (!pinned) throw remoteError('invalid_link', "The access link's host key is malformed.");
  const shared = sharedKey(clientKeyPair.secretKey, pinned);
  if (framing === 'legacy') {
    return {
      framing,
      helloText: () => JSON.stringify({ type: 'e2ee_hello', publicKeyB64: b64(clientKeyPair.publicKey) }),
      acceptReady(text) {
        try {
          return JSON.parse(text)?.type === 'e2ee_ready';
        } catch {
          return false;
        }
      },
      authText: (deviceToken, clientCapabilities) => JSON.stringify({ type: 'e2ee_auth', deviceToken, clientCapabilities }),
      isAuthenticated: (reply) => reply?.type === 'e2ee_authenticated',
      sealText: (text) => b64(sealLegacy(utf8(text), shared)),
      open(data) {
        if (typeof data === 'string') {
          if (data.length > 6 * 1024 * 1024) return null;
          const p = openLegacy(new Uint8Array(Buffer.from(data, 'base64')), shared);
          return p ? { kind: 'text', text: Buffer.from(p).toString('utf8') } : null;
        }
        const p = openLegacy(data, shared);
        return p ? { kind: 'binary', bytes: p } : null;
      },
    };
  }
  const hello = {
    type: 'e2ee_hello',
    v: 2,
    clientPublicKeyB64: b64(clientKeyPair.publicKey),
    clientNonceB64: b64(clientNonce),
    capabilities: { framing: [2], payloadKinds: ['text', 'binary'] },
    context: { protocol: V2_PROTOCOL, initiator: 'mobile', responder: 'desktop', transport },
  };
  let keys = null;
  let transcriptHashB64 = null;
  let sent = 0n;
  let received = 0n;
  const open = (frame, kind) => {
    if (!keys) return null;
    const p = openV2Frame({ frame, key: keys.desktopToMobileKey, sessionId: keys.sessionId, direction: 'desktop-to-mobile', kind, counter: received });
    if (p) received++;
    return p;
  };
  return {
    framing: 'v2',
    hello,
    helloText: () => JSON.stringify(hello),
    // validateMobileE2EEV2Handshake plus the pinned-key check.
    acceptReady(text) {
      let ready;
      try {
        ready = JSON.parse(text);
      } catch {
        return false;
      }
      if (!isExact(ready, ['type', 'v', 'desktopPublicKeyB64', 'clientNonceB64', 'desktopNonceB64', 'selection', 'context'])) return false;
      if (ready.type !== 'e2ee_ready' || ready.v !== 2 || ready.clientNonceB64 !== hello.clientNonceB64) return false;
      const sel = ready.selection;
      if (!isExact(sel, ['framing', 'payloadKinds']) || sel.framing !== 2 || !Array.isArray(sel.payloadKinds) || sel.payloadKinds.length !== 2 || sel.payloadKinds[0] !== 'text' || sel.payloadKinds[1] !== 'binary') return false;
      if (!sameContext(hello.context, ready.context)) return false;
      const desktopKey = decodeCanonical(ready.desktopPublicKeyB64, 32);
      const desktopNonce = decodeCanonical(ready.desktopNonceB64, 32);
      if (!desktopKey || !desktopNonce || !equalBytes(desktopKey, pinned)) return false;
      keys = deriveV2Keys({ sharedSecret: shared, transcript: encodeV2Transcript(hello, ready), clientNonce, desktopNonce });
      transcriptHashB64 = b64(keys.transcriptHash);
      return true;
    },
    authText: (deviceToken, clientCapabilities) => JSON.stringify({ type: 'e2ee_auth', v: 2, transcriptHashB64, deviceToken, clientCapabilities }),
    isAuthenticated: (reply) => isExact(reply, ['type', 'v', 'transcriptHashB64']) && reply.type === 'e2ee_authenticated' && reply.v === 2 && reply.transcriptHashB64 === transcriptHashB64,
    sealText(text) {
      const frame = sealV2Frame({ payload: utf8(text), key: keys.mobileToDesktopKey, sessionId: keys.sessionId, direction: 'mobile-to-desktop', kind: 'text', counter: sent });
      sent++;
      return b64(frame);
    },
    open(data) {
      if (typeof data === 'string') {
        const frame = decodeCanonical(data);
        const p = frame && open(frame, 'text');
        return p ? { kind: 'text', text: Buffer.from(p).toString('utf8') } : null;
      }
      const p = open(data, 'binary');
      if (!p) return null;
      return inflateFrame(p) || { kind: 'binary', bytes: p };
    },
    get transcriptHashB64() {
      return transcriptHashB64;
    },
  };
}

// ---- one paired socket -----------------------------------------------------------

// The RpcPipe interface (orca.js) over a paired WebSocket: open() runs the handshake,
// call() multiplexes requests by id.
export class PairedSocket {
  constructor({ endpoint, deviceToken, publicKeyB64, framing = 'v2', label = 'the other computer', timeoutMs = 12000, clientCapabilities = [COMPRESSED_FRAMES], WebSocketImpl = globalThis.WebSocket }) {
    this.endpoint = endpoint;
    this.deviceToken = deviceToken;
    this.label = label;
    this.timeoutMs = timeoutMs;
    this.clientCapabilities = clientCapabilities;
    this.WebSocketImpl = WebSocketImpl;
    this.hs = createClientHandshake({ framing, hostPublicKeyB64: publicKeyB64 });
    this.framing = this.hs.framing;
    this.stage = 'connect'; // connect -> ready-wait -> auth-wait -> open
    this.pending = new Map();
    this.closed = false;
    this.ws = null;
    this.lastRuntimeId = null;
  }

  open() {
    if (!this.WebSocketImpl) return Promise.reject(remoteError('unsupported', 'This Node.js has no WebSocket client; update Node.js to 22 or newer.'));
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          this.closed = true;
          try {
            this.ws?.close();
          } catch {}
          reject(err);
        } else {
          resolve();
        }
      };
      this.finishOpen = finish;
      const timer = setTimeout(() => {
        finish(remoteError(this.stage === 'connect' ? 'unreachable' : 'timeout', this.stage === 'connect' ? `Can't reach Orca on ${this.label}` : `Orca on ${this.label} didn't finish the encrypted handshake`));
      }, this.timeoutMs);
      let ws;
      try {
        ws = new this.WebSocketImpl(this.endpoint);
      } catch {
        return finish(remoteError('invalid_link', `The access link's address isn't usable (${safeEndpoint(this.endpoint)}).`));
      }
      this.ws = ws;
      ws.binaryType = 'arraybuffer';
      ws.addEventListener('open', () => {
        this.stage = 'ready-wait';
        ws.send(this.hs.helloText());
      });
      ws.addEventListener('message', (ev) => {
        try {
          this.onFrame(typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data));
        } catch (err) {
          this.fail(err instanceof RemoteError ? err : remoteError('protocol', `Orca on ${this.label} sent something unreadable (${plainText(err.message).slice(0, 200)})`));
        }
      });
      // A close event with the code usually follows, but Node 22's WebSocket sends only
      // the error when nothing listens at the address: without this, an Orca that's off
      // looked like one that was slow to answer until the 12 s timeout.
      ws.addEventListener('error', () => {
        if (this.stage === 'connect') finish(remoteError('unreachable', `Can't reach Orca on ${this.label}`));
      });
      ws.addEventListener('close', (ev) => this.onClose(ev.code, String(ev.reason || '')));
    });
  }

  fail(err) {
    if (this.stage !== 'open') this.finishOpen?.(err);
    this.close();
  }

  onFrame(data) {
    if (this.closed) return;
    if (this.stage === 'ready-wait') {
      // The ready is plaintext JSON; anything else is not the Orca this link pins.
      if (typeof data !== 'string' || !this.hs.acceptReady(data)) {
        throw remoteError('host_identity', `Orca on ${this.label} answered with a different identity than its access link pins (its key changed?). Make a new access link there and add it again.`);
      }
      this.stage = 'auth-wait';
      this.ws.send(this.hs.sealText(this.hs.authText(this.deviceToken, this.clientCapabilities)));
      return;
    }
    const opened = this.hs.open(data);
    if (!opened) throw remoteError('protocol', `Orca on ${this.label} sent a frame that doesn't decrypt`);
    if (opened.kind !== 'text') return; // terminal/screencast streams: not ours
    if (this.stage === 'auth-wait') {
      let reply;
      try {
        reply = JSON.parse(opened.text);
      } catch {
        reply = null;
      }
      if (this.hs.isAuthenticated(reply)) {
        this.stage = 'open';
        this.finishOpen(null);
        return;
      }
      const code = reply?.type === 'e2ee_error' ? reply.error?.code : null;
      if (code === 'unauthorized' || code === 'device_revoked') throw remoteError('unauthorized', `Orca on ${this.label} no longer accepts ${THIS_COMPUTER}'s access link`);
      // Hosts that predate capabilities on v2 token auth answer bad_auth. That answer
      // is sealed with keys only the pinned host has, so the host itself asked for
      // legacy (unlike a close before the ready, which anyone on the path can send).
      if (code === 'bad_auth' && this.framing === 'v2') {
        const err = remoteError('v2_refused', 'v2 token auth refused');
        err.attested = true;
        throw err;
      }
      throw remoteError('protocol', `Orca on ${this.label} refused the handshake${code ? ` (${plainText(code).slice(0, 64)})` : ''}`);
    }
    let msg;
    try {
      msg = JSON.parse(opened.text);
    } catch {
      return;
    }
    if (msg?._keepalive) {
      for (const p of this.pending.values()) p.timer.refresh();
      return;
    }
    const p = this.pending.get(msg?.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg._meta?.runtimeId) this.lastRuntimeId = msg._meta.runtimeId;
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new OrcaRpcError(plainText(msg.error?.code || 'error').slice(0, 64), plainText(msg.error?.message || 'Orca refused the request').slice(0, 1000), msg.error?.data));
  }

  onClose(code, reason) {
    const stage = this.stage;
    this.closed = true;
    const err = remoteError('closed', 'Orca closed the connection');
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    if (stage === 'open') return;
    if (stage === 'connect') return this.finishOpen?.(remoteError('unreachable', `Can't reach Orca on ${this.label}`));
    if (code === 4001 && stage === 'ready-wait' && this.framing === 'v2') return this.finishOpen?.(remoteError('v2_refused', 'v2 hello refused'));
    if (code === 4001 && stage === 'auth-wait') return this.finishOpen?.(remoteError('unauthorized', `Orca on ${this.label} no longer accepts ${THIS_COMPUTER}'s access link`));
    if (code === 1013) return this.finishOpen?.(remoteError('busy', `Orca on ${this.label} has too many connections open`));
    this.finishOpen?.(remoteError('unreachable', `Orca on ${this.label} closed the connection during the handshake${code && code !== 1005 && code !== 1006 ? ` (${code}${reason ? `: ${plainText(reason).slice(0, 123)}` : ''})` : ''}`));
  }

  close() {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {}
  }

  call(method, params, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (this.closed || this.stage !== 'open') return reject(remoteError('closed', 'not connected to Orca'));
      const id = randomUUID();
      // The CLI's envelope; the host checks the token against the socket's own.
      const json = JSON.stringify({ id, deviceToken: this.deviceToken, method, params });
      if (Buffer.byteLength(json, 'utf8') > MAX_REQUEST_JSON) return reject(new Error('That is too long to send to Orca in one go.'));
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(remoteError('timeout', `${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(this.hs.sealText(json));
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(remoteError('closed', `couldn't send to Orca (${err.message})`));
      }
    });
  }
}

function safeEndpoint(endpoint) {
  try {
    const u = new URL(endpoint);
    return `${u.protocol}//${u.host}`;
  } catch {
    return 'the paired address';
  }
}

// ---- the transport OrcaClient opens connections through -------------------------

// What OrcaClient needs from a way to reach Orca (see LocalTransport in orca.js):
// open() -> { conn, origin, runtimeId, status }, describeFailure(err).
//
// Legacy framing has no counters, so anyone on the network path who can force it can
// replay frames inside a socket. So: once a host authenticated us over v2 (e2ee: 'v2',
// persisted through onLatch) we never dial legacy for it again; before that, a refused
// v2 hello (an unauthenticated close) falls back only when allowLegacy isn't false
// (false for pairings made without --allow-legacy; undefined for records older than
// that option). A bad_auth sealed by the pinned host may always fall back.
export class PairedTransport {
  constructor({ endpoint, deviceToken, publicKeyB64, label = 'the other computer', timeoutMs = 12000, WebSocketImpl, e2ee, allowLegacy, onLatch, log = () => {} } = {}) {
    if (!endpoint || !deviceToken || !publicKeyB64) throw new Error('PairedTransport needs endpoint, deviceToken and publicKeyB64');
    this.endpoint = endpoint;
    this.deviceToken = deviceToken;
    this.publicKeyB64 = publicKeyB64;
    this.label = label;
    this.timeoutMs = timeoutMs;
    this.WebSocketImpl = WebSocketImpl;
    this.remote = true;
    this.latched = e2ee === 'v2'; // this host authenticated us over v2: never downgrade
    this.allowLegacy = allowLegacy !== false;
    this.onLatch = onLatch;
    this.log = log;
    this.v2RefusedAt = 0;
    this.framing = null; // what the last connection used
  }

  get origin() {
    return safeEndpoint(this.endpoint);
  }

  nextFraming() {
    if (this.latched) return 'v2';
    return this.v2RefusedAt && Date.now() - this.v2RefusedAt < V2_REFUSAL_MEMORY_MS ? 'legacy' : 'v2';
  }

  async dial(framing) {
    const sock = new PairedSocket({ endpoint: this.endpoint, deviceToken: this.deviceToken, publicKeyB64: this.publicKeyB64, framing, label: this.label, timeoutMs: this.timeoutMs, WebSocketImpl: this.WebSocketImpl });
    await sock.open();
    return sock;
  }

  async open() {
    const framing = this.nextFraming();
    let sock;
    try {
      sock = await this.dial(framing);
    } catch (err) {
      if (err?.code !== 'v2_refused') throw err;
      if (this.latched) throw remoteError('downgrade', `Orca on ${this.label} used newer encryption (E2EE v2) before and now refuses it. Update Orca there; if it is up to date, something on the network is interfering.`);
      if (!err.attested && !this.allowLegacy) {
        throw remoteError('legacy_refused', `Orca on ${this.label} refused the current encryption (E2EE v2), and the older one is off for this pairing. Update Orca there. If something on the network may be interfering, don't connect; if it's an old Orca you trust on a trusted network, run orca-wow remote add "${this.label}" --allow-legacy and paste a new access link.`);
      }
      // An older Orca: it speaks only the legacy framing.
      this.v2RefusedAt = Date.now();
      sock = await this.dial('legacy');
    }
    if (sock.framing === 'v2' && !this.latched) {
      this.latched = true;
      try {
        this.onLatch?.();
      } catch (err) {
        this.log(`Orca: couldn't record that ${this.label} uses E2EE v2 (${plainText(err.message)})`);
      }
    }
    if (sock.framing === 'legacy') this.log(`Orca: warning: connected to ${this.label} with the older encryption (legacy framing, no replay protection). Update Orca there.`);
    this.framing = sock.framing;
    let status;
    try {
      status = await sock.call('status.get', {});
      checkStatus(status, this.label);
    } catch (err) {
      sock.close();
      throw err;
    }
    if (status && typeof status.appVersion === 'string') status = { ...status, appVersion: plainText(status.appVersion).slice(0, 64) };
    return { conn: sock, origin: this.origin, runtimeId: status?.runtimeId || sock.lastRuntimeId || undefined, status };
  }

  describeFailure(err) {
    switch (err?.code) {
      case 'unreachable':
      case 'timeout':
      case 'closed':
      case 'busy':
        return `Can't reach Orca on ${this.label}`;
      case 'unauthorized':
        return `Orca on ${this.label} no longer accepts ${THIS_COMPUTER} (its access link was revoked or replaced). Make a new access link there, run orca-wow remote add "${this.label}" and paste it.`;
      default:
        return plainText(String(err?.message || err).split('\n')[0]);
    }
  }
}

// The checks Orca's CLI runs on a paired host's status (remote-runtime-compat-gate.ts),
// plus the scope the bridge needs.
export function checkStatus(status, label = 'the other computer') {
  const server = status?.runtimeProtocolVersion ?? status?.protocolVersion ?? 0;
  const minClient = status?.minCompatibleRuntimeClientVersion ?? status?.minCompatibleMobileVersion ?? 0;
  if (RUNTIME_PROTOCOL_VERSION < minClient) {
    throw remoteError('incompatible', `Orca on ${label} needs a newer client (protocol ${minClient}; orca-wow speaks ${RUNTIME_PROTOCOL_VERSION}). Update orca-wow.`);
  }
  if (server < MIN_SERVER_PROTOCOL_VERSION) {
    throw remoteError('incompatible', `Orca on ${label} is too old (protocol ${server}; orca-wow needs ${MIN_SERVER_PROTOCOL_VERSION}). Update Orca there.`);
  }
  if (status?.deviceScope === 'mobile') {
    throw remoteError('mobile_scope', `Orca on ${label} paired ${THIS_COMPUTER} as a phone, which can't use terminal.show. Make an access link for another Orca there (not --mobile) and run orca-wow remote add again.`);
  }
}

// One connection attempt for the CLI: { ok, status, framing } or { ok: false, error, code }.
// onLatch runs when the host authenticated us over v2 for the first time.
export async function probeRemote(secret, { label = secret.label, timeoutMs = 8000, onLatch } = {}) {
  const t = new PairedTransport({ ...secret, label, timeoutMs, onLatch });
  try {
    const { conn, status } = await t.open();
    conn.close();
    return { ok: true, status, framing: t.framing };
  } catch (err) {
    return { ok: false, code: err?.code, error: t.describeFailure(err) };
  }
}
