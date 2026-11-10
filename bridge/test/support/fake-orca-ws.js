// A stand-in for an Orca on another computer: a minimal WebSocket server (HTTP
// upgrade + RFC 6455 framing: text, binary, fragments, close, ping/pong; Node has no
// WebSocket server of its own) running the host side of Orca's paired E2EE handshake
// (src/main/runtime/rpc/e2ee-channel.ts: v2, or legacy for an "older" host), and
// answering requests from the same scriptable data and methods as the pipe fake
// (fake-orca.js), which it wraps: `fake.orca.worktrees = [...]` etc.

import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { nacl, encodeV2Transcript, deriveV2Keys, sealV2Frame, openV2Frame, sealLegacy, openLegacy, encodeAccessLink, decodeCanonical, COMPRESSED_FRAMES } from '../../src/orca-remote.js';
import { FakeOrca } from './fake-orca.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export class FakeOrcaWs {
  constructor({ orca = new FakeOrca({ dir: null }), deviceToken = randomBytes(24).toString('base64url'), legacyOnly = false, scope = 'runtime', protocolVersion = 3, minClientVersion = 2, compress = true, port = 0 } = {}) {
    this.orca = orca;
    this.deviceToken = deviceToken;
    this.legacyOnly = legacyOnly;
    this.scope = scope;
    this.protocolVersion = protocolVersion;
    this.minClientVersion = minClientVersion;
    this.compress = compress;
    this.port = port;
    this.keys = nacl.box.keyPair();
    this.server = null;
    this.conns = new Set();
    this.handshakes = []; // 'v2' | 'legacy' per authenticated socket
    this.authFailures = 0;
    this.pongs = 0;
    this.requests = []; // decrypted request envelopes (to check what goes on the wire)
    this.compressedReplies = 0;
    this.uploads = new Map();
  }

  get publicKeyB64() {
    return Buffer.from(this.keys.publicKey).toString('base64');
  }

  get endpoint() {
    return `ws://127.0.0.1:${this.port}`;
  }

  secret(over = {}) {
    return { endpoint: this.endpoint, deviceToken: this.deviceToken, publicKeyB64: this.publicKeyB64, ...over };
  }

  link(over = {}) {
    return encodeAccessLink({ v: 2, endpoint: this.endpoint, deviceToken: this.deviceToken, publicKeyB64: this.publicKeyB64, scope: this.scope, ...over });
  }

  async start() {
    this.server = http.createServer((req, res) => {
      res.writeHead(426, { 'content-type': 'text/plain' });
      res.end('websocket only');
    });
    this.server.on('upgrade', (req, socket) => this.onUpgrade(req, socket));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, '127.0.0.1', resolve);
    });
    this.port = this.server.address().port;
    return this;
  }

  // Gone at once, like a computer dropping off the network (sockets reset, no close).
  async stop() {
    for (const c of this.conns) c.socket.destroy();
    this.conns.clear();
    await new Promise((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server = null;
  }

  // ---- RFC 6455 -----------------------------------------------------------------

  onUpgrade(req, socket) {
    const key = req.headers['sec-websocket-key'];
    if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || !key || req.headers['sec-websocket-version'] !== '13') {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const conn = { socket, buf: Buffer.alloc(0), frags: [], fragOpcode: 0, state: 'awaiting_hello', framing: null, caps: [] };
    this.conns.add(conn);
    socket.on('data', (chunk) => {
      conn.buf = Buffer.concat([conn.buf, chunk]);
      this.parse(conn);
    });
    socket.on('close', () => this.conns.delete(conn));
    socket.on('error', () => socket.destroy());
  }

  parse(conn) {
    for (;;) {
      const b = conn.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        len = Number(b.readBigUInt64BE(2));
        off = 10;
      }
      if (!masked) return this.closeConn(conn, 1002, 'client frames must be masked');
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      conn.buf = b.subarray(off + 4 + len);
      if (opcode === 0x8) {
        this.sendFrame(conn, 0x8, payload.subarray(0, 2));
        conn.socket.end();
        return;
      }
      if (opcode === 0x9) {
        this.sendFrame(conn, 0xa, payload);
        continue;
      }
      if (opcode === 0xa) {
        this.pongs++;
        continue;
      }
      if (opcode === 0x1 || opcode === 0x2) {
        conn.fragOpcode = opcode;
        conn.frags = [payload];
      } else if (opcode === 0x0) {
        conn.frags.push(payload);
      } else {
        return this.closeConn(conn, 1002, 'bad opcode');
      }
      if (!fin) continue;
      const data = Buffer.concat(conn.frags);
      conn.frags = [];
      try {
        this.onMessage(conn, conn.fragOpcode === 0x1 ? data.toString('utf8') : new Uint8Array(data));
      } catch (err) {
        this.closeConn(conn, 1011, err.message.slice(0, 100));
      }
    }
  }

  sendFrame(conn, opcode, payload) {
    if (conn.socket.destroyed) return;
    const len = payload.length;
    const head = len < 126 ? Buffer.from([0x80 | opcode, len]) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
    if (len >= 126 && len < 65536) {
      head[0] = 0x80 | opcode;
      head[1] = 126;
      head.writeUInt16BE(len, 2);
    } else if (len >= 65536) {
      head[0] = 0x80 | opcode;
      head[1] = 127;
      head.writeBigUInt64BE(BigInt(len), 2);
    }
    conn.socket.write(Buffer.concat([head, payload]));
  }

  sendText(conn, text) {
    this.sendFrame(conn, 0x1, Buffer.from(text, 'utf8'));
  }

  closeConn(conn, code, reason = '') {
    const p = Buffer.alloc(2 + Buffer.byteLength(reason));
    p.writeUInt16BE(code, 0);
    p.write(reason, 2);
    this.sendFrame(conn, 0x8, p);
    conn.state = 'closed';
    setTimeout(() => conn.socket.destroy(), 50);
  }

  // ---- Orca's host side --------------------------------------------------------

  onMessage(conn, data) {
    if (conn.state === 'closed') return;
    if (conn.state === 'awaiting_hello') return this.onHello(conn, data);
    const text = this.open(conn, data);
    if (text === null) return this.closeConn(conn, 4001, conn.state === 'awaiting_auth' ? 'Unauthorized' : 'Too many decryption failures');
    if (conn.state === 'awaiting_auth') return this.onAuth(conn, text);
    this.onRequest(conn, text);
  }

  onHello(conn, data) {
    if (typeof data !== 'string') return this.closeConn(conn, 4001, 'Invalid handshake message');
    const hello = JSON.parse(data);
    const secret = this.keys.secretKey;
    if (hello.type === 'e2ee_hello' && hello.v === 2 && !this.legacyOnly) {
      const clientKey = decodeCanonical(hello.clientPublicKeyB64, 32);
      const clientNonce = decodeCanonical(hello.clientNonceB64, 32);
      if (!clientKey || !clientNonce || hello.context?.transport !== 'direct') return this.closeConn(conn, 4001, 'Invalid e2ee_hello v2');
      const desktopNonce = nacl.randomBytes(32);
      const ready = {
        type: 'e2ee_ready',
        v: 2,
        desktopPublicKeyB64: this.publicKeyB64,
        clientNonceB64: hello.clientNonceB64,
        desktopNonceB64: Buffer.from(desktopNonce).toString('base64'),
        selection: { framing: 2, payloadKinds: ['text', 'binary'] },
        context: hello.context,
      };
      conn.keys = deriveV2Keys({ sharedSecret: nacl.box.before(clientKey, secret), transcript: encodeV2Transcript(hello, ready), clientNonce, desktopNonce });
      conn.transcriptHashB64 = Buffer.from(conn.keys.transcriptHash).toString('base64');
      conn.inbound = 0n;
      conn.outbound = 0n;
      conn.framing = 'v2';
      conn.state = 'awaiting_auth';
      this.sendText(conn, JSON.stringify(ready));
      return;
    }
    // An older host reads a v2 hello as a legacy one without a key, and refuses it.
    if (hello.type !== 'e2ee_hello' || typeof hello.publicKeyB64 !== 'string') return this.closeConn(conn, 4001, 'Invalid e2ee_hello');
    const clientKey = Buffer.from(hello.publicKeyB64, 'base64');
    if (clientKey.length !== 32) return this.closeConn(conn, 4001, 'Invalid public key');
    conn.shared = nacl.box.before(new Uint8Array(clientKey), secret);
    conn.framing = 'legacy';
    conn.state = 'awaiting_auth';
    this.sendText(conn, JSON.stringify({ type: 'e2ee_ready' }));
  }

  open(conn, data) {
    if (conn.framing === 'v2') {
      const kind = typeof data === 'string' ? 'text' : 'binary';
      const frame = typeof data === 'string' ? decodeCanonical(data) : data;
      const p = frame && openV2Frame({ frame, key: conn.keys.mobileToDesktopKey, sessionId: conn.keys.sessionId, direction: 'mobile-to-desktop', kind, counter: conn.inbound });
      if (!p) return null;
      conn.inbound++;
      return kind === 'text' ? Buffer.from(p).toString('utf8') : null;
    }
    const bytes = typeof data === 'string' ? new Uint8Array(Buffer.from(data, 'base64')) : data;
    const p = openLegacy(bytes, conn.shared);
    return p ? Buffer.from(p).toString('utf8') : null;
  }

  seal(conn, text, { binary = false } = {}) {
    if (conn.framing === 'v2') {
      const payload = binary ? text : new Uint8Array(Buffer.from(text, 'utf8'));
      const frame = sealV2Frame({ payload, key: conn.keys.desktopToMobileKey, sessionId: conn.keys.sessionId, direction: 'desktop-to-mobile', kind: binary ? 'binary' : 'text', counter: conn.outbound });
      conn.outbound++;
      if (binary) this.sendFrame(conn, 0x2, Buffer.from(frame));
      else this.sendText(conn, Buffer.from(frame).toString('base64'));
      return;
    }
    this.sendText(conn, Buffer.from(sealLegacy(new Uint8Array(Buffer.from(text, 'utf8')), conn.shared)).toString('base64'));
  }

  onAuth(conn, text) {
    const auth = JSON.parse(text);
    const shapeOk = auth.type === 'e2ee_auth' && (conn.framing === 'v2' ? auth.v === 2 && auth.transcriptHashB64 === conn.transcriptHashB64 : auth.v === undefined);
    if (!shapeOk) {
      this.seal(conn, JSON.stringify({ type: 'e2ee_error', error: { code: 'bad_auth' } }));
      return this.closeConn(conn, 4001, 'Invalid e2ee_auth');
    }
    if (auth.deviceToken !== this.deviceToken) {
      this.authFailures++;
      this.seal(conn, JSON.stringify({ type: 'e2ee_error', error: { code: 'unauthorized' } }));
      return this.closeConn(conn, 4001, 'Unauthorized');
    }
    conn.caps = Array.isArray(auth.clientCapabilities) ? auth.clientCapabilities : [];
    conn.state = 'ready';
    this.handshakes.push(conn.framing);
    this.seal(conn, JSON.stringify(conn.framing === 'v2' ? { type: 'e2ee_authenticated', v: 2, transcriptHashB64: conn.transcriptHashB64 } : { type: 'e2ee_authenticated' }));
    // Orca's heartbeat pings every 15 s; the client must answer.
    this.sendFrame(conn, 0x9, Buffer.from('hb'));
  }

  async onRequest(conn, text) {
    const req = JSON.parse(text);
    this.requests.push(req);
    const meta = { runtimeId: this.orca.runtimeId };
    const reply = (obj) => {
      const json = JSON.stringify({ id: req.id, ...obj, _meta: meta });
      if (conn.framing === 'v2' && this.compress && conn.caps.includes(COMPRESSED_FRAMES) && json.length >= 1024) {
        const raw = Buffer.from(json, 'utf8');
        const gz = gzipSync(raw, { level: 1 });
        const head = Buffer.from([0x7a, 1, 0, 0, 0, 0]);
        head.writeUInt32LE(raw.length, 2);
        this.compressedReplies++;
        this.seal(conn, new Uint8Array(Buffer.concat([head, gz])), { binary: true });
      } else {
        this.seal(conn, json);
      }
    };
    if (req.deviceToken !== undefined && req.deviceToken !== this.deviceToken) return reply({ ok: false, error: { code: 'unauthorized', message: 'Device token mismatch' } });
    this.orca.calls.push({ method: req.method, params: req.params });
    this.seal(conn, '{"_keepalive":true}');
    try {
      const name = `m_${req.method.replace(/\./g, '_')}`;
      const [self, fn] = this.orca.handlers[req.method] ? [this.orca, this.orca.handlers[req.method]] : this[name] ? [this, this[name]] : [this.orca, this.orca[name]];
      if (!fn) return reply({ ok: false, error: { code: 'method_not_found', message: `Unknown method: ${req.method}` } });
      const result = await fn.call(self, req.params || {});
      reply({ ok: true, result });
    } catch (err) {
      reply({ ok: false, error: { code: err.code || 'runtime_error', message: err.message } });
    }
  }

  // ---- methods a paired host adds -------------------------------------------------

  m_status_get() {
    return { ...this.orca.m_status_get(), runtimeProtocolVersion: this.protocolVersion, minCompatibleRuntimeClientVersion: this.minClientVersion, deviceScope: this.scope };
  }

  m_clipboard_startImageUpload(params) {
    const uploadId = randomBytes(8).toString('hex');
    this.uploads.set(uploadId, { expected: params.expectedBase64Length, fileName: params.fileName, chunks: [], received: 0 });
    return { uploadId };
  }

  m_clipboard_appendImageUploadChunk(params) {
    const u = this.uploads.get(params.uploadId);
    if (!u) throw new Error('Clipboard image upload was not found');
    if (params.offset !== u.received) throw new Error('Clipboard image chunk offset is out of order');
    u.chunks.push(params.contentBase64);
    u.received += params.contentBase64.length;
    return { receivedBase64Length: u.received };
  }

  m_clipboard_commitImageUpload(params) {
    const u = this.uploads.get(params.uploadId);
    if (!u || u.received !== u.expected) throw new Error('Clipboard image upload is incomplete');
    u.bytes = Buffer.from(u.chunks.join(''), 'base64');
    u.path = `/var/folders/tmp/orca-paste-${params.uploadId}/${u.fileName || 'image.png'}`;
    return u.path;
  }

  m_clipboard_abortImageUpload(params) {
    this.uploads.delete(params.uploadId);
    return { aborted: true };
  }
}
