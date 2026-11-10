import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReplyParser, bgraToRgb, WinHelper } from '../src/winhelper.js';
import { taskArguments, taskXml } from '../src/winservice.js';

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

test('the logon task runs the bridge hidden and logs its output', () => {
  const args = taskArguments(['C:\\Program Files\\nodejs\\node.exe', 'C:\\x y\\orca-wow.js', 'run'], 'C:\\state\\bridge.log');
  assert.equal(args, '--headless cmd.exe /d /c ""C:\\Program Files\\nodejs\\node.exe" "C:\\x y\\orca-wow.js" "run" >> "C:\\state\\bridge.log" 2>&1"');
  const xml = taskXml(['node.exe', 'a&b.js', 'run'], 'C:\\log');
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(xml, /<RestartOnFailure>/);
  assert.match(xml, /a&amp;b\.js/);
  assert.match(xml, /conhost\.exe<\/Command>/);
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
