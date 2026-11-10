// The Windows helper (native/wowhelper.cs): built once with the C# compiler that
// ships with Windows, then kept running and asked over stdin/stdout. See the .cs file
// for the request format.

import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATE_DIR } from './paths.js';

const SOURCE = fileURLToPath(new URL('../native/wowhelper.cs', import.meta.url));
const REQUEST_TIMEOUT_MS = 5000;

function findCsc() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  for (const fw of ['Framework64', 'Framework']) {
    const p = path.join(root, 'Microsoft.NET', fw, 'v4.0.30319', 'csc.exe');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// The built helper, named after the source's hash so an updated source gets rebuilt.
export function ensureHelperExe({ dir = path.join(STATE_DIR, 'bin') } = {}) {
  const src = fs.readFileSync(SOURCE);
  const hash = createHash('sha256').update(src).digest('hex').slice(0, 12);
  const exe = path.join(dir, `wowhelper-${hash}.exe`);
  if (fs.existsSync(exe)) return exe;
  const csc = findCsc();
  if (!csc) throw new Error("couldn't find the C# compiler that ships with Windows (.NET Framework 4, csc.exe) to build the capture helper");
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${exe}.tmp.exe`;
  try {
    execFileSync(csc, ['/nologo', '/optimize+', '/target:exe', '/platform:anycpu', `/out:${tmp}`, SOURCE], { windowsHide: true, stdio: 'pipe' });
  } catch (err) {
    throw new Error(`building the capture helper failed: ${(err.stdout?.toString() || err.message).trim()}`);
  }
  fs.renameSync(tmp, exe);
  // Old builds.
  for (const f of fs.readdirSync(dir)) {
    if (/^wowhelper-[0-9a-f]+\.exe$/.test(f) && path.join(dir, f) !== exe) fs.rmSync(path.join(dir, f), { force: true });
  }
  return exe;
}

// Splits the helper's stdout into replies: a text line, or "img w h n" followed by n
// bytes of BGRA pixels.
export class ReplyParser {
  constructor(onReply) {
    this.onReply = onReply;
    this.buf = Buffer.alloc(0);
    this.pendingImage = null;
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.pendingImage) {
        const { width, height, size } = this.pendingImage;
        if (this.buf.length < size) return;
        const bgra = this.buf.subarray(0, size);
        this.buf = this.buf.subarray(size);
        this.pendingImage = null;
        this.onReply({ type: 'img', image: bgraToRgb(bgra, width, height) });
        continue;
      }
      const nl = this.buf.indexOf(0x0a);
      if (nl < 0) return;
      const line = this.buf.subarray(0, nl).toString('utf8').replace(/\r$/, '');
      this.buf = this.buf.subarray(nl + 1);
      const m = /^img (\d+) (\d+) (\d+)$/.exec(line);
      if (m) {
        this.pendingImage = { width: Number(m[1]), height: Number(m[2]), size: Number(m[3]) };
        continue;
      }
      const sp = line.indexOf(' ');
      const type = sp < 0 ? line : line.slice(0, sp);
      const rest = sp < 0 ? '' : line.slice(sp + 1);
      if (type === 'json') this.onReply({ type, value: JSON.parse(rest) });
      else this.onReply({ type, message: rest });
    }
  }
}

// BGRA (what GDI gives) -> the { width, height, data: RGB } images codec.js reads.
export function bgraToRgb(bgra, width, height) {
  const data = Buffer.allocUnsafe(width * height * 3);
  for (let i = 0, o = 0; o < data.length; i += 4, o += 3) {
    data[o] = bgra[i + 2];
    data[o + 1] = bgra[i + 1];
    data[o + 2] = bgra[i];
  }
  return { width, height, data };
}

export class WinHelper {
  constructor({ exe = null, log = () => {} } = {}) {
    this.exe = exe;
    this.log = log;
    this.child = null;
    this.queue = [];
  }

  start() {
    if (this.child) return;
    const exe = this.exe || (this.exe = ensureHelperExe());
    const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const parser = new ReplyParser((reply) => {
      const req = this.queue.shift();
      if (!req) return;
      clearTimeout(req.timer);
      req.resolve(reply);
    });
    child.stdout.on('data', (d) => parser.push(d));
    child.stderr.on('data', (d) => this.log(`helper: ${d.toString().trim()}`));
    const fail = (err) => {
      if (this.child !== child) return;
      this.child = null;
      for (const req of this.queue.splice(0)) {
        clearTimeout(req.timer);
        req.reject(err);
      }
    };
    child.on('error', fail);
    child.on('exit', (code) => fail(new Error(`capture helper exited (${code})`)));
    child.stdin.on('error', () => {});
    // An idle helper mustn't keep a CLI command from exiting; a request's timer keeps
    // the process alive while it waits for the reply.
    child.unref();
    for (const s of [child.stdin, child.stdout, child.stderr]) s.unref?.();
    this.child = child;
  }

  request(line) {
    this.start();
    return new Promise((resolve, reject) => {
      const req = { resolve, reject };
      // Replies come in order, so a timed-out request must kill the helper: a late
      // reply would otherwise answer the next request.
      req.timer = setTimeout(() => {
        const child = this.child;
        this.child = null;
        for (const r of this.queue.splice(0)) {
          clearTimeout(r.timer);
          r.reject(new Error(`capture helper timed out on "${line.split(' ')[0]}"`));
        }
        child?.kill();
      }, REQUEST_TIMEOUT_MS);
      this.queue.push(req);
      this.child.stdin.write(`${line}\n`);
    }).then((reply) => {
      if (reply.type === 'err') throw new Error(reply.message);
      return reply;
    });
  }

  async processes() {
    return (await this.request('procs')).value;
  }

  async window(pid) {
    return (await this.request(`win ${pid >>> 0}`)).value;
  }

  // { status: 'ok', image } | { status: 'no-window' } | { status: 'hidden' }
  async grab(pid, width, height) {
    return toCapture(await this.request(`grab ${pid >>> 0} ${Math.round(width)} ${Math.round(height)}`));
  }

  async shot(pid) {
    return toCapture(await this.request(`shot ${pid >>> 0}`));
  }

  stop() {
    this.child?.kill();
    this.child = null;
  }
}

function toCapture(reply) {
  if (reply.type === 'img') return { status: 'ok', image: reply.image };
  if (reply.type === 'hidden') return { status: 'hidden' };
  return { status: 'no-window' };
}

let shared = null;
export function winHelper() {
  if (!shared) shared = new WinHelper();
  return shared;
}
