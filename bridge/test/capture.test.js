import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickMacWindow, pickKwinWindow, StripCapture, SCREEN_PERMISSION_HELP } from '../src/capture.js';

const screens = [
  { x: 0, y: 0, width: 1512, height: 982, scale: 2 }, // built-in Retina, the primary
  { x: 1512, y: -100, width: 2560, height: 1440, scale: 1 }, // external, NSScreen's bottom-left origin
];
const win = (pid, X, Y, Width, Height, extra = {}) => ({ pid, layer: 0, onscreen: true, bounds: { X, Y, Width, Height }, ...extra });

test('a window on the Retina screen', () => {
  const w = pickMacWindow({ windows: [win(5, 0, 0, 1512, 982)], screens }, 5);
  assert.deepEqual([w.found, w.visible, w.scale], [true, true, 2]);
});

test('a windowed client on the external screen, found by pid over a same-named window', () => {
  const info = { windows: [win(9, 10, 10, 800, 600), win(5, 1600, -300, 1280, 748)], screens };
  const w = pickMacWindow(info, 5);
  assert.deepEqual([w.x, w.y, w.scale], [1600, -300, 1]);
});

test('ignores menus and tiny windows, and reports a window on another Space as hidden', () => {
  const info = { windows: [win(5, 0, 0, 1512, 30, { layer: 25 }), win(5, 0, 0, 40, 40), win(5, 0, 0, 1512, 982, { onscreen: false })], screens };
  const w = pickMacWindow(info, 5);
  assert.deepEqual([w.found, w.visible], [true, false]);
  assert.equal(pickMacWindow({ windows: [], screens }, 5).found, false);
});

// Without Screen Recording, screencapture can return the desktop without the game in
// it, so the bridge asks macOS first (without a prompt), and not before every capture.
test('macOS: no capture without Screen Recording, asked again at most every 5 seconds', async () => {
  let answer = false;
  let checks = 0;
  let captures = 0;
  const cap = new StripCapture({ backend: 'macos', screenAccess: async () => (checks++, answer) });
  let asked = 0;
  cap.requestScreenAccess = () => asked++;
  cap.macWindow = async () => ({ found: true, visible: true, x: 0, y: 0, width: 1512, height: 982, scale: 2 });
  cap.macCapture = async () => {
    captures++;
    throw new Error('captured');
  };
  for (let i = 0; i < 3; i++) assert.deepEqual(await cap.poll(5), { status: 'error', error: SCREEN_PERMISSION_HELP });
  assert.deepEqual([checks, captures], [1, 0]);
  assert.ok(asked > 0, 'shows the system prompt (macOS only does that once)');
  await assert.rejects(cap.screenshot(5), { message: SCREEN_PERMISSION_HELP });

  answer = true;
  cap.macAccess.at -= 5000;
  assert.equal((await cap.poll(5)).error, 'captured');
  assert.equal((await cap.poll(5)).error, 'captured');
  assert.deepEqual([checks, captures], [2, 2], 'a yes is kept');
});

test("macOS: captures when it can't tell whether Screen Recording is on", async () => {
  let checks = 0;
  const cap = new StripCapture({ backend: 'macos', screenAccess: async () => (checks++, null) });
  cap.macWindow = async () => ({ found: false });
  assert.equal((await cap.poll(5)).status, 'no-window');
  assert.equal((await cap.poll(5)).status, 'no-window');
  assert.equal(checks, 1);
});

const kwin = (pid, caption, extra = {}) => ({ pid, caption, uuid: `{${pid}}`, x: 10, y: 20, width: 1280, height: 720, minimized: false, desktops: ['d1'], ...extra });

test('KWin: the game by pid over a same-named window, else by caption', () => {
  const infos = [kwin(9, 'World of Warcraft'), kwin(5, 'World of Warcraft', { x: 300 })];
  assert.equal(pickKwinWindow(infos, 5, 'd1').x, 300);
  assert.equal(pickKwinWindow(infos, 77, 'd1').uuid, '{9}');
  assert.equal(pickKwinWindow([kwin(9, 'Battle.net')], 77, 'd1').found, false);
});

test('KWin: hidden when minimized or on another desktop, visible on all desktops', () => {
  assert.equal(pickKwinWindow([kwin(5, 'World of Warcraft', { minimized: true })], 5, 'd1').visible, false);
  assert.equal(pickKwinWindow([kwin(5, 'World of Warcraft')], 5, 'd2').visible, false);
  assert.equal(pickKwinWindow([kwin(5, 'World of Warcraft', { desktops: [] })], 5, 'd2').visible, true);
});
