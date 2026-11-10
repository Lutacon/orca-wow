import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ReplyParser, bgraToRgb, WinHelper } from '../src/winhelper.js';
import { taskArguments, taskScript, taskXml, NO_RESTART_EXIT } from '../src/winservice.js';
import { atomicWrite, writeBell, LONG_SILENT_WAV, SlotBank } from '../src/slots.js';

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

// The game holds a bell open while it plays it, and Windows refuses to replace an open
// file: the write waits for the game to let go instead of failing the publish.
test('a bell write waits out a file the game has open, and gives up cleanly', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-bell-'));
  try {
    const file = path.join(dir, '03993.wav');
    const busy = (n) => {
      let left = n;
      return (from, to) => {
        if (left-- > 0) throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
        fs.renameSync(from, to);
      };
    };
    atomicWrite(file, 'rung', { tries: 5, rename: busy(3) });
    assert.equal(fs.readFileSync(file, 'utf8'), 'rung');
    assert.throws(() => atomicWrite(file, 'again', { tries: 5, rename: busy(10) }), { code: 'EPERM' });
    assert.equal(fs.readFileSync(file, 'utf8'), 'rung');
    assert.deepEqual(fs.readdirSync(dir), ['03993.wav'], 'no temp file left behind');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Measured in game: the client can refuse a bell's rename for seconds while it polls it,
// but lets it be written. A bell that can't be replaced is rewritten in place instead.
test('a bell the game won\'t let go of is rewritten in place, never through a hard link', { skip: !WIN && 'Windows only' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-bell-'));
  try {
    const file = path.join(dir, '03992.wav');
    fs.writeFileSync(file, '');
    const never = () => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    };
    writeBell(file, LONG_SILENT_WAV, { rename: never });
    assert.ok(fs.readFileSync(file).equals(LONG_SILENT_WAV), 'filled in place');
    writeBell(file, '', { rename: never });
    assert.equal(fs.statSync(file).size, 0, 'emptied in place');
    assert.deepEqual(fs.readdirSync(dir), ['03992.wav'], 'no temp file left behind');
    const other = path.join(dir, 'elsewhere.txt');
    fs.writeFileSync(other, 'keep');
    fs.rmSync(file);
    fs.linkSync(other, file);
    assert.throws(() => writeBell(file, LONG_SILENT_WAV, { rename: never }), { code: 'EPERM' });
    assert.equal(fs.readFileSync(other, 'utf8'), 'keep');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// AddOns is writable by every account on a Windows PC, so one could plant a link (a
// junction) under one of our folder names; install used to prune and write through it.
test('install never writes or prunes through a link planted under one of its folder names', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-slots-'));
  try {
    const addons = path.join(dir, 'AddOns');
    const victim = path.join(dir, 'victim');
    fs.mkdirSync(path.join(addons, 'OrcaWow'), { recursive: true });
    fs.mkdirSync(victim);
    fs.writeFileSync(path.join(victim, '00001.wav'), 'keep');
    const sig = path.join(addons, 'OrcaWow', 'Signals');
    fs.symlinkSync(victim, sig, 'junction');
    assert.throws(() => new SlotBank(addons, { slots: 2 }).install(), /Signals is a link/);
    assert.deepEqual(fs.readdirSync(victim), ['00001.wav']);

    fs.rmSync(sig, { recursive: true }); // the link only
    fs.symlinkSync(victim, path.join(addons, 'OrcaWow_S002'), 'junction');
    assert.throws(() => new SlotBank(addons, { slots: 2 }).install(), /OrcaWow_S002 is a link/);
    assert.deepEqual(fs.readdirSync(victim), ['00001.wav']);

    // Real folders: only stale signal files are pruned.
    fs.rmSync(path.join(addons, 'OrcaWow_S002'), { recursive: true });
    fs.writeFileSync(path.join(sig, '00001.wav'), '');
    fs.writeFileSync(path.join(sig, 'notes.txt'), 'mine');
    assert.equal(new SlotBank(addons, { slots: 2 }).install().pruned, 1);
    assert.ok(fs.existsSync(path.join(sig, 'notes.txt')));
    assert.ok(fs.existsSync(path.join(addons, 'OrcaWow_S002', 'Inbox.lua')));
    assert.deepEqual(fs.readdirSync(victim), ['00001.wav']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the logon task XML runs its script hidden, from its own folder', () => {
  const xml = taskXml('C:\\a&b\\orca-wow-task.cmd');
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(xml, /conhost\.exe<\/Command>/);
  assert.match(xml, /<Arguments>--headless cmd\.exe \/d \/c \.\\orca-wow-task\.cmd<\/Arguments>/);
  assert.match(xml, /<WorkingDirectory>C:\\a&amp;b<\/WorkingDirectory>/);
});

// conhost re-quotes its arguments; a quoted cmd /c line used to reach cmd broken, and the
// bridge never started while the task reported success. A profile path with & ^ or % in
// it broke the full-path line too. Run the real thing from such a folder.
test('the logon task script runs the bridge and logs its output under conhost --headless', { skip: !WIN && 'Windows only' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca wow & %x% ^ é '));
  try {
    const js = path.join(dir, 'fake bridge.js');
    fs.writeFileSync(js, 'console.log("out", process.argv.slice(2).join("|")); console.error("err")');
    const log = path.join(dir, 'bridge.log');
    const script = path.join(dir, 'orca-wow-task.cmd');
    fs.writeFileSync(script, taskScript([process.execPath, js, 'run'], log));
    // Start conhost the way Task Scheduler does: <Arguments> as its command line, in
    // <WorkingDirectory>. (Node's own spawn of conhost --headless runs nothing, so it
    // can't stand in.) The folder goes through the environment, untouched by quoting.
    const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
    const lit = (s) => `'${s.replace(/'/g, "''")}'`;
    spawnSync(path.join(sys, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath ${lit(path.join(sys, 'conhost.exe'))} -ArgumentList ${lit(taskArguments(script))} -WorkingDirectory $env:ORCAWOW_TEST_DIR -Wait`], { timeout: 20000, env: { ...process.env, ORCAWOW_TEST_DIR: dir } });
    // conhost returns before the script is done.
    for (let i = 0; i < 100 && !/err/.test(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''); i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(fs.readFileSync(log, 'utf8').replace(/\r\n/g, '\n'), 'out run\nerr\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A bridge that refused to start (OrcaWow's folders were changed) would only fail again:
// the script must stop there instead of rerunning icacls and PowerShell every 30 s.
test('the logon task script does not restart a bridge that refused to start', { skip: !WIN && 'Windows only' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-task-'));
  try {
    const js = path.join(dir, 'refuse.js');
    fs.writeFileSync(js, `console.error('refused'); process.exit(${NO_RESTART_EXIT})`);
    const log = path.join(dir, 'bridge.log');
    const script = path.join(dir, 'orca-wow-task.cmd');
    fs.writeFileSync(script, taskScript([process.execPath, js], log));
    const started = Date.now();
    const r = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', `.\\${path.basename(script)}`], { cwd: dir, timeout: 20000, windowsHide: true });
    assert.equal(r.status, NO_RESTART_EXIT);
    assert.ok(Date.now() - started < 15000, 'no 30-second wait to restart');
    const text = fs.readFileSync(log, 'utf8');
    assert.equal(text.match(/refused/g).length, 1, 'ran once');
    assert.match(text, /won't start until you run install\.ps1 again/);
    assert.doesNotMatch(text, /restarting in 30 seconds/);
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
