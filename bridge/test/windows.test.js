import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ReplyParser, bgraToRgb, WinHelper } from '../src/winhelper.js';
import { taskArguments, taskScript, taskXml } from '../src/winservice.js';

const WIN = process.platform === 'win32';

test('splits helper replies into text lines and images, across chunk boundaries', () => {
  const replies = [];
  const p = new ReplyParser((r) => replies.push(r));
  // Two pixels: BGRA (1,2,3,255) and (4,5,6,255).
  const pixels = Buffer.from([1, 2, 3, 255, 4, 5, 6, 255]);
  const stream = Buffer.concat([
    Buffer.from('pong\njson [{"pid":7,"start":1,"path":"C:\\\\Wow.exe"}]\nimg 2 1 8\n'),
    pixels,
    Buffer.from('hidden\nerr boom\n'),
  ]);
  for (let i = 0; i < stream.length; i += 5) p.push(stream.subarray(i, i + 5));
  assert.deepEqual(replies.map((r) => r.type), ['pong', 'json', 'img', 'hidden', 'err']);
  assert.deepEqual(replies[1].value, [{ pid: 7, start: 1, path: 'C:\\Wow.exe' }]);
  assert.deepEqual([...replies[2].image.data], [3, 2, 1, 6, 5, 4]);
  assert.equal(replies[2].image.width, 2);
  assert.equal(replies[4].message, 'boom');
});

test('converts BGRA to the RGB buffers codec.js reads', () => {
  const img = bgraToRgb(Buffer.from([10, 20, 30, 0]), 1, 1);
  assert.ok(Buffer.isBuffer(img.data));
  assert.deepEqual([...img.data], [30, 20, 10]);
});

test('the logon task XML runs its script hidden', () => {
  const xml = taskXml('C:\\a&b\\orca-wow-task.cmd');
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(xml, /conhost\.exe<\/Command>/);
  assert.match(xml, /cmd\.exe \/d \/c &quot;C:\\a&amp;b\\orca-wow-task\.cmd&quot;/);
});

// conhost re-quotes its arguments; a quoted cmd /c line used to reach cmd broken, and the
// bridge never started while the task reported success. Run the real thing.
test('the logon task script runs the bridge and logs its output under conhost --headless', { skip: !WIN && 'Windows only' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca wow %x% '));
  try {
    const js = path.join(dir, 'fake bridge.js');
    fs.writeFileSync(js, 'console.log("out", process.argv.slice(2).join("|")); console.error("err")');
    const log = path.join(dir, 'bridge.log');
    const script = path.join(dir, 'orca-wow-task.cmd');
    fs.writeFileSync(script, taskScript([process.execPath, js, 'run'], log));
    // Start conhost the way Task Scheduler does, with <Arguments> as its command line.
    // (Node's own spawn of conhost --headless runs nothing, so it can't stand in.)
    const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
    const lit = (s) => `'${s.replace(/'/g, "''")}'`;
    spawnSync(path.join(sys, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath ${lit(path.join(sys, 'conhost.exe'))} -ArgumentList ${lit(taskArguments(script))} -Wait`], { timeout: 20000 });
    // conhost returns before the script is done.
    for (let i = 0; i < 100 && !/err/.test(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''); i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(fs.readFileSync(log, 'utf8').replace(/\r\n/g, '\n'), 'out run\nerr\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the real helper builds, answers, and lists processes', { skip: !WIN && 'Windows only' }, async () => {
  const h = new WinHelper();
  try {
    assert.equal((await h.request('ping')).type, 'pong');
    const procs = await h.processes();
    assert.ok(Array.isArray(procs));
    assert.deepEqual(await h.grab(0x7ffffff0, 10, 10), { status: 'no-window' });
    await assert.rejects(h.request('nonsense'), /unknown request/);
  } finally {
    h.stop();
  }
});
