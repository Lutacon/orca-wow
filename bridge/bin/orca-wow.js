#!/usr/bin/env node
// orca-wow: install and run the OrcaWow bridge for World of Warcraft: Forever.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Bridge, STATE_DIR, VERSION } from '../src/bridge.js';
import { findWowInstalls, addonsDir as addonsDirOf, findWowProcess } from '../src/wow.js';
import { SlotBank, ADDON, CTL_LONG, atomicWrite, checkFolder } from '../src/slots.js';
import { StripCapture, SCREEN_PERMISSION_HELP } from '../src/capture.js';
import { decodeImage } from '../src/codec.js';
import { CONFIG_DIR, DATA_DIR, WINDOWS } from '../src/paths.js';
import { windowsStartup, NO_RESTART_EXIT } from '../src/winservice.js';
import { secureAddonFolders, topFolders } from '../src/winacl.js';
import { readRuntime as readOrcaRuntime } from '../src/orca.js';
import { parseAccessLink, checkAccessLink, remoteIdFor, saveRemoteSecret, readRemoteSecret, removeRemoteSecret, remoteSecretFile, probeRemote, markRemoteV2, plainText } from '../src/orca-remote.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_ROOT = path.resolve(HERE, '..');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const MAC = process.platform === 'darwin';
const BIN_LINK = WINDOWS ? null : path.join(os.homedir(), '.local/bin/orca-wow');
const DEFAULT_SLOTS = 1200;

const C = process.stdout.isTTY
  ? { b: (s) => `\x1b[1m${s}\x1b[0m`, g: (s) => `\x1b[32m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m` }
  : { b: String, g: String, y: String, r: String, d: String };

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) out[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
}

// The addon ships next to the bridge (repo layout) or inside it (installed layout).
function addonSource() {
  for (const p of [path.join(BRIDGE_ROOT, '..', 'addon', ADDON), path.join(BRIDGE_ROOT, 'addon', ADDON)]) {
    if (fs.existsSync(path.join(p, `${ADDON}.toc`))) return p;
  }
  throw new Error('could not find the addon sources next to the bridge');
}

// A folder in the game we write into: it must be a real folder inside AddOns, never a
// link someone else planted under our name (see checkFolder).
function gameFolder(addonsDir, dir) {
  if (checkFolder(addonsDir, dir)) return;
  fs.mkdirSync(dir);
  checkFolder(addonsDir, dir);
}

// Files are replaced (atomicWrite), not written into, so a link is never followed.
function copyDir(src, dst, addonsDir) {
  gameFolder(addonsDir, dst);
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d, addonsDir);
    else atomicWrite(d, fs.readFileSync(s));
  }
}

function resolveWowDir(args, cfg) {
  if (args.wow) {
    const dir = path.resolve(String(args.wow));
    if (fs.existsSync(path.join(dir, '_forever_'))) return path.join(dir, '_forever_');
    return dir;
  }
  if (cfg.wowDir && fs.existsSync(cfg.wowDir)) return cfg.wowDir;
  const { forever, wowOnly, prefixes, origin = {} } = findWowInstalls();
  if (forever.length > 1) console.log(C.y(`Found several WoW: Forever installs, using the first (pick one with --wow):\n  ${forever.join('\n  ')}`));
  else if (origin[forever[0]] === 'scan' || origin[forever[0]] === 'records') {
    // Found by searching the drives, or in Battle.net's product.db (which every account on
    // a Windows PC can change): say which folder, so a planted one doesn't go unnoticed.
    const how = origin[forever[0]] === 'scan' ? 'by searching the drives' : "in Battle.net's list of installs";
    console.log(C.y(`Using the WoW: Forever install found ${how}: ${forever[0]}\nIf that isn't the game you play, run the install again with --wow and your game's folder.`));
  }
  if (forever.length) return forever[0];
  const where = '\nIf it\'s somewhere else, pass --wow "/path/to/World of Warcraft".';
  if (wowOnly.length) {
    throw new Error(`found World of Warcraft at ${wowOnly[0]}, but not WoW: Forever. Install Forever from Battle.net (it's a separate game version), launch it once, then run ./install.sh again.${where}`);
  }
  if (prefixes.length) {
    throw new Error(`found Battle.net (${prefixes[0]}) but no World of Warcraft. Install WoW: Forever from Battle.net, launch it once, then run ./install.sh again.${where}`);
  }
  if (MAC || WINDOWS) throw new Error(`couldn't find World of Warcraft. Install Battle.net from blizzard.com, install WoW: Forever from it and launch it once, then run the install again.${where}`);
  throw new Error(`couldn't find Battle.net. On Omarchy, install it with omarchy-install-gaming-battlenet; on CachyOS, add Battle.net to Faugus Launcher or Lutris. Then install WoW: Forever from it, launch it once, and run ./install.sh again.${where}`);
}

// The bridge runs as a systemd user service on Linux and a launchd agent on macOS.
// Commands are quiet unless they fail (enabling prints "Created symlink …", which isn't news).
function quiet(cmd, args, { warn = true } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0 && warn) process.stderr.write(r.stderr || `${cmd} ${args.join(' ')} failed\n`);
  return r.status === 0;
}

// On macOS, the launch agent runs the `node` found on PATH, such as Homebrew's
// /opt/homebrew/bin/node, rather than the versioned folder that link points to.
// `brew upgrade node` deletes the old versioned folder, and the agent would then fail
// to start at the next login.
function bridgeCommand() {
  const linked = (process.env.PATH || '').split(path.delimiter).map((dir) => path.join(dir, 'node')).find((p) => {
    try {
      return fs.realpathSync(p) === process.execPath;
    } catch {
      return false;
    }
  });
  return [(MAC && linked) || process.execPath, path.join(BRIDGE_ROOT, 'bin', 'orca-wow.js'), 'run'];
}

// Windows: the logon task runs the bridge from the folder this command runs from. Only
// the copy install.ps1 keeps in %LOCALAPPDATA%\orca-wow\app is safe for that: a clone
// elsewhere (under C:\, say) may be writable by other accounts on the PC, whose code
// would then run at your logon.
function installedCopy() {
  const real = (p) => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return path.resolve(p);
    }
  };
  return path.relative(real(path.join(DATA_DIR, 'bridge')), real(BRIDGE_ROOT)) === '';
}

const systemd = {
  name: 'orca-wow.service',
  file: path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd/user', 'orca-wow.service'),
  kind: 'user service',
  install() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, [
      '[Unit]',
      'Description=OrcaWow bridge for World of Warcraft',
      'After=graphical-session.target',
      '',
      '[Service]',
      `ExecStart=${bridgeCommand().join(' ')}`,
      'Restart=always',
      'RestartSec=3',
      `Environment=PATH=${process.env.PATH}`,
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n'));
    quiet('systemctl', ['--user', 'daemon-reload']);
    quiet('systemctl', ['--user', 'enable', this.name]);
    return quiet('systemctl', ['--user', 'restart', this.name]);
  },
  restart() {
    quiet('systemctl', ['--user', 'restart', this.name]);
  },
  remove() {
    quiet('systemctl', ['--user', 'disable', '--now', this.name], { warn: false });
    fs.rmSync(this.file, { force: true });
    quiet('systemctl', ['--user', 'daemon-reload'], { warn: false });
  },
};

const launchd = {
  name: 'orca-wow',
  file: path.join(os.homedir(), 'Library/LaunchAgents/orca-wow.plist'),
  kind: 'launch agent',
  target: () => `gui/${process.getuid()}`,
  install() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const str = (v) => `<string>${String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</string>`;
    fs.writeFileSync(this.file, [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      `  <key>Label</key>${str(this.name)}`,
      `  <key>ProgramArguments</key><array>${bridgeCommand().map(str).join('')}</array>`,
      `  <key>EnvironmentVariables</key><dict><key>PATH</key>${str(process.env.PATH)}</dict>`,
      '  <key>RunAtLoad</key><true/>',
      '  <key>KeepAlive</key><true/>',
      '  <key>ThrottleInterval</key><integer>3</integer>',
      '  <key>ProcessType</key><string>Interactive</string>',
      `  <key>StandardOutPath</key>${str(path.join(STATE_DIR, 'bridge.log'))}`,
      `  <key>StandardErrorPath</key>${str(path.join(STATE_DIR, 'bridge.log'))}`,
      '</dict>',
      '</plist>',
      '',
    ].join('\n'));
    // Reload so a changed plist (a new node path, say) takes effect.
    quiet('launchctl', ['bootout', `${this.target()}/${this.name}`], { warn: false });
    if (quiet('launchctl', ['bootstrap', this.target(), this.file], { warn: false })) return true;
    // bootout can still be finishing ("Bootstrap failed: 5"); only the retry's error is worth showing.
    spawnSync('sleep', ['1']);
    return quiet('launchctl', ['bootstrap', this.target(), this.file]);
  },
  restart() {
    quiet('launchctl', ['kickstart', '-k', `${this.target()}/${this.name}`]);
  },
  remove() {
    quiet('launchctl', ['bootout', `${this.target()}/${this.name}`], { warn: false });
    fs.rmSync(this.file, { force: true });
  },
};

const service = WINDOWS ? windowsStartup(bridgeCommand) : MAC ? launchd : systemd;

// Copy just the addon code (leaving Signals/ and generated media alone).
function syncAddon(addonsDir) {
  const src = addonSource();
  const dst = path.join(addonsDir, ADDON);
  gameFolder(addonsDir, dst);
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === 'Signals') continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d, addonsDir);
    else atomicWrite(d, fs.readFileSync(s));
  }
  return dst;
}

// Windows (see winacl.js): what the check of OrcaWow's folders found that the bridge
// must not work with.
function folderProblems(r) {
  return [
    ...r.links.map((p) => `${p} is a link to another place`),
    ...r.foreign.map((p) => `${p} was created by another account on this PC`),
    ...r.errors.map((e) => `${e.path}: ${e.detail}`),
  ];
}

// Before writing into the game: replace any OrcaWow folder another account created or
// changed (its permissions get fixed, but its contents can't be trusted).
function replaceForeignFolders(addonsDir) {
  const r = secureAddonFolders(addonsDir, { full: true });
  if (r.failed || r.noAcl) return;
  if (r.links.length) throw new Error(`${r.links.join(', ')} ${r.links.length > 1 ? 'are links' : 'is a link'} to another place, so OrcaWow won't write there. Delete ${r.links.length > 1 ? 'them' : 'it'}, then run the install again.`);
  const tops = topFolders(addonsDir, [...r.foreign, ...r.errors.map((e) => e.path)]);
  for (const dir of tops) {
    fs.rmSync(dir, { recursive: true, force: true });
    if (fs.existsSync(dir)) throw new Error(`another account on this PC owns ${dir} and keeps you out of it. Ask an administrator to delete that folder, then run the install again.`);
  }
  if (tops.length) console.log(`${C.y('!')} Removed ${tops.length} OrcaWow folder${tops.length > 1 ? 's' : ''} another account on this PC had created or changed; fresh copies are going in.`);
}

// After writing: lock OrcaWow's folders to this account, and say plainly if the game's
// own folders still let other accounts in.
function lockAddonFolders(addonsDir, wowDir) {
  const parents = [addonsDir, path.dirname(addonsDir), wowDir, path.dirname(wowDir)];
  const r = secureAddonFolders(addonsDir, { parents });
  if (r.failed) {
    console.log(`${C.y('!')} Couldn't lock OrcaWow's folders in the game to your account (${r.failed}). Other accounts on this PC may be able to change them.`);
    return;
  }
  if (r.noAcl) {
    console.log(`${C.y('!')} The game is on a ${r.noAcl} drive, which keeps no file permissions, so OrcaWow's folders in the game can't be locked to your account. Every account on this PC can change them. If other people use this PC, move the game to an NTFS drive.`);
    return;
  }
  const problems = folderProblems(r);
  if (problems.length) throw new Error(`OrcaWow's folders in the game couldn't be locked to your account:\n  ${problems.join('\n  ')}\nDelete those folders (ask an administrator if Windows refuses), then run the install again.`);
  console.log(`${C.g('✓')} OrcaWow's folders in the game are locked to your account ${C.d(`(${r.checked} checked)`)}`);
  if (r.open.length) {
    console.log(`${C.y('!')} Other accounts on this PC can change these game folders (Blizzard's installer sets them up that way):`);
    for (const o of r.open) console.log(`    ${o.path} ${C.d(`(${o.who})`)}`);
    console.log(`  They can't change OrcaWow's own folders now, but they can still add addons of their own, which run in your game, or move OrcaWow's folders aside and put others in their place (the bridge then refuses to start until you run the install again). If other people have accounts on this PC, ask an administrator to remove their write access to ${path.dirname(wowDir)}.`);
  }
}

async function cmdInstall(args) {
  if (WINDOWS && !args['no-service'] && !installedCopy()) {
    throw new Error(`this copy of orca-wow is in ${BRIDGE_ROOT}, and its logon task would run the bridge from there, where other accounts on this PC may be able to change it. Run install.ps1 instead (powershell -ExecutionPolicy Bypass -File .\\install.ps1 from the repository folder): it copies the bridge to ${path.join(DATA_DIR, 'bridge')}, which only your account can change. Or add --no-service to install just the addon.`);
  }
  const cfg = readConfig();
  const wowDir = resolveWowDir(args, cfg);
  const addonsDir = addonsDirOf(wowDir);
  console.log(`${C.b('World of Warcraft:')} ${wowDir}`);
  fs.mkdirSync(addonsDir, { recursive: true });
  if (WINDOWS) replaceForeignFolders(addonsDir);

  // The game only discovers new addon folders and sound files when it starts.
  const freshAddon = !fs.existsSync(path.join(addonsDir, ADDON, `${ADDON}.toc`));
  const dst = syncAddon(addonsDir);
  console.log(`${C.g('✓')} Addon installed to ${dst}`);

  const slots = Number(args.slots || cfg.slots || DEFAULT_SLOTS);
  const bank = new SlotBank(addonsDir, { slots });
  const had = bank.installedSlotCount();
  const bellsMissing = !fs.existsSync(bank.sigFile(CTL_LONG));
  const { made, pruned, temps } = bank.install();
  if (had > slots) bank.removeSlots(slots);
  console.log(`${C.g('✓')} ${slots} live-update slots ready ${C.d(`(${made} files written${pruned ? `, ${pruned} unused signal files removed` : ''}${temps ? `, ${temps} leftover temporary files removed` : ''})`)}`);
  if (WINDOWS) lockAddonFolders(addonsDir, wowDir);

  // Settings older versions kept, which nothing reads any more.
  const { signals: _signals, backend: _backend, environments: _environments, ...rest } = cfg;
  const next = { ...rest, wowDir, addonsDir, slots };
  writeConfig(next);

  // Orca needs no session token: the bridge reads Orca's own runtime file (pipe +
  // token) each time it connects.
  let running = false;
  try {
    readOrcaRuntime();
    running = true;
  } catch {}
  console.log(running
    ? `${C.g('✓')} Orca is running; the bridge will show its agents`
    : `${C.y('!')} Orca isn't running right now; the bridge connects as soon as you open it`);

  if (!args['no-service']) {
    if (!service.install()) {
      console.log(C.r(`✗ The bridge's ${service.kind} didn't start (the error is above). Fix that, then run \`orca-wow install\` again.`));
      process.exitCode = 1;
      return;
    }
    console.log(`${C.g('✓')} Bridge running as the ${service.name} ${service.kind}`);
    if (MAC) console.log(`${C.y('!')} The bridge reads the game's pixels, so macOS asks for Screen Recording permission the first time.`);
  }

  console.log('');
  await firstLaunch({
    restart: freshAddon || had < slots || bellsMissing,
    running: !!(await findWowProcess()),
    waiting: !args['no-service'] && process.stdin.isTTY && process.stdout.isTTY,
    since: Date.now(),
  });
}

function readStatus() {
  try {
    return JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'status.json'), 'utf8'));
  } catch {
    return null;
  }
}

// After installing: say exactly what to do in the game, then wait (Enter skips) until
// the addon checks in, so you know it works before you go looking for it.
async function firstLaunch({ restart, running, waiting, since }) {
  let step;
  if (restart) step = running ? 'Quit World of Warcraft completely and start it again, then log in to a character.' : 'Start World of Warcraft: Forever and log in to a character.';
  else step = running ? 'Type /reload in game.' : 'Start World of Warcraft: Forever and log in to a character.';
  console.log(`${C.b('Next:')} ${step}`);
  if (restart && running) console.log(C.d('  The game only finds new addon files when it starts, so a /reload isn\'t enough this time.'));

  let connected = null;
  if (waiting) {
    let skipped = false;
    process.stdin.resume();
    process.stdin.once('data', () => {
      skipped = true;
    });
    let shown = '';
    const until = Date.now() + 20 * 60 * 1000;
    while (!skipped && Date.now() < until) {
      const st = readStatus();
      if (st?.addon && st.addon.lastSeen >= since) {
        connected = st;
        break;
      }
      const blocked = st?.capture?.state === 'error' && st.capture.lastError === SCREEN_PERMISSION_HELP;
      const msg = blocked
        ? 'Waiting for Screen Recording permission (see above)… (Enter to skip)'
        : st?.wow ? 'World of Warcraft is running. Waiting for you to log in… (Enter to skip)' : 'Waiting for World of Warcraft to start… (Enter to skip)';
      if (msg !== shown) {
        if (blocked) process.stdout.write(`\r\x1b[2K${C.y(SCREEN_PERMISSION_HELP)}\n`);
        process.stdout.write(`\r\x1b[2K${C.d(msg)}`);
        shown = msg;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    process.stdin.pause();
    process.stdout.write('\r\x1b[2K');
    if (connected) {
      // The first hello can arrive before the addon has its link keys; give it a moment.
      for (let i = 0; i < 8 && !readStatus()?.addon?.encrypted; i++) await new Promise((r) => setTimeout(r, 1000));
      const enc = readStatus()?.addon?.encrypted;
      console.log(`${C.g('✓')} Connected: the game and the bridge are talking${enc ? ' over an encrypted link' : ''}.`);
    } else if (!skipped) {
      console.log(C.y('The game hasn\'t checked in yet. Once you\'re in, `orca-wow status` shows whether it connected.'));
    }
  }
  console.log(`
${C.b('In game')}
  /orca                     open or close the window (or click its minimap button)
  both triggers + Back      open it from a controller
  /orca selftest            check the link step by step if something seems off

${C.b('From here')}
  orca-wow remote add <name>  show another computer's Orca agents too
                              (paste its access link when asked)
  orca-wow status             what the bridge sees
  rerun the install command   update
  orca-wow uninstall          remove everything`);
}

function cmdSync(args) {
  const cfg = readConfig();
  const addonsDir = cfg.addonsDir || addonsDirOf(resolveWowDir(args, cfg));
  // The game only discovers new addon folders and sound files when it starts.
  const freshAddon = !fs.existsSync(path.join(addonsDir, ADDON, `${ADDON}.toc`));
  const dst = syncAddon(addonsDir);
  console.log(`${C.g('✓')} Addon code copied to ${dst}. Type /reload in game.`);
}

async function cmdRun(args) {
  const cfg = readConfig();
  const addonsDir = cfg.addonsDir || addonsDirOf(resolveWowDir(args, cfg));
  if (WINDOWS) {
    // The bridge writes the strip key into the slot folders: first make sure no other
    // account on this PC can read or change them (see winacl.js).
    const r = secureAddonFolders(addonsDir);
    const problems = folderProblems(r);
    if (problems.length) {
      const why = `The bridge didn't start: another account on this PC may have changed OrcaWow's folders in the game:\n  ${problems.join('\n  ')}\nRun the install again (install.ps1) to replace them, then restart the game.`;
      console.error(why);
      // The logon task doesn't restart this exit code (it would only fail again), and
      // `orca-wow status` shows why.
      writeStoppedStatus(why);
      process.exitCode = NO_RESTART_EXIT;
      return;
    }
    if (r.noAcl) console.log(`The game is on a ${r.noAcl} drive, which keeps no file permissions, so OrcaWow's folders can't be locked to this account.`);
    else if (r.failed) console.error(`Couldn't check who else can change OrcaWow's folders in the game (${r.failed}).`);
    else if (r.fixed.length) console.log(`Locked ${r.fixed.length} of OrcaWow's files and folders in the game to this account again.`);
  }
  const bridge = new Bridge({ addonsDir, config: { ...cfg, verbose: args.verbose || cfg.verbose } });
  const stop = () => {
    bridge.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await bridge.start();
}

// What `orca-wow status` shows when the bridge refused to start.
function writeStoppedStatus(reason) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(STATE_DIR, 'status.json'), JSON.stringify({ version: VERSION, pid: process.pid, at: new Date().toISOString(), stopped: reason }, null, 1));
  } catch {}
}

function ago(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
}

function cmdStatus(args) {
  let st;
  try {
    st = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'status.json'), 'utf8'));
  } catch {
    console.log(C.r('The bridge has not run yet.'), 'Start it with `orca-wow install` or `orca-wow run`.');
    process.exitCode = 1;
    return;
  }
  if (args.json) return console.log(JSON.stringify(st, null, 2));
  const age = Date.now() - Date.parse(st.at);
  const alive = age < 10000;
  const ok = (b) => (b ? C.g('●') : C.r('●'));
  if (st.stopped) {
    console.log(`${ok(false)} Bridge ${st.version} not running: it refused to start ${ago(age)}.`);
    console.log(C.y(plainText(st.stopped, { lines: true })));
    process.exitCode = 1;
    return;
  }
  console.log(`${ok(alive)} Bridge ${st.version} ${alive ? `running (pid ${st.pid})` : `not running (last seen ${ago(age)})`}`);
  if (st.halted) console.log(`${ok(false)} ${C.y(plainText(st.halted))}`);
  const envs = st.orca.environments || [];
  if (envs.length > 1 || envs.some((e) => !e.local)) {
    // One line per Orca: this PC's and each paired with `orca-wow remote add`.
    // Errors and addresses can carry another computer's text: print it plain.
    for (const e of envs) {
      const where = e.local ? 'this PC' : plainText(e.origin || 'remote');
      const label = plainText(e.label);
      console.log(`${ok(e.state === 'connected')} Orca ${e.local ? '' : `on ${label}`}${e.local ? `(${label})` : ''}: ${plainText(e.state)}${e.error ? ` — ${plainText(e.error)}` : ''} ${C.d(`(${e.threads} agents, ${where})`)}`);
    }
  } else {
    console.log(`${ok(st.orca.state === 'connected')} Orca: ${plainText(st.orca.state)}${st.orca.error ? ` — ${plainText(st.orca.error)}` : ''} ${C.d(`(${st.orca.threads} agents, ${plainText(st.orca.origin || '?')})`)}`);
  }
  if (!envs.some((e) => e.local)) console.log(C.d("  This PC's own Orca is hidden (orca-wow local on shows it again)."));
  console.log(`${ok(!!st.wow)} WoW: ${st.wow ? `running (pid ${st.wow.pid})` : 'not running'}`);
  console.log(`${ok(st.capture.state === 'ok' || st.capture.state === 'idle')} Screen link: ${st.capture.state} via ${st.capture.backend} ${C.d(`(${st.capture.decoded} frames read, ${st.capture.rejected} rejected)`)}${st.capture.lastError ? `\n    ${C.y(st.capture.lastError)}` : ''}`);
  if (st.addon) {
    console.log(`${ok(true)} Addon ${st.addon.version}: last heard ${ago(Date.now() - st.addon.lastSeen)}; window ${st.addon.flags.includes('o') ? 'open' : 'closed'}`);
    console.log(`${ok(st.addon.encrypted)} Link ${st.addon.encrypted ? 'encrypted' : 'not encrypted yet (waiting for the addon to load its keys)'}${st.rejected?.forged ? C.d(` · ${st.rejected.forged} unauthenticated frames ignored`) : ''}`);
  } else {
    console.log(`${ok(false)} Addon: not heard from yet ${C.d('(log in, then /orca)')}`);
  }
  console.log(`  Live updates left this session: ${st.slots.remaining}/${st.slots.total} ${C.d(`· ${st.publishes} updates sent · update bell #${st.signals.next}`)}`);
  console.log(`  Speech: ${st.voice.tts || C.y('none')} · Dictation: ${st.voice.dictation || C.y('none')}`);
  if (st.voice.hint) console.log(`    ${C.d(st.voice.hint)}`);
  if (args.log || args.v) {
    console.log('');
    for (const l of st.log) console.log(C.d(plainText(l)));
  }
}

async function cmdProbe() {
  const proc = await findWowProcess();
  const cap = new StripCapture({});
  console.log(`backend: ${cap.resolveBackend()}; WoW pid: ${proc?.pid ?? 'not running'}`);
  const res = await cap.grab(proc?.pid);
  if (res.status !== 'ok') return console.log(`capture: ${res.status}`);
  const out = path.join(os.tmpdir(), 'orca-wow-probe.ppm');
  const img = res.image;
  fs.writeFileSync(out, Buffer.concat([Buffer.from(`P6\n${img.width} ${img.height}\n255\n`), Buffer.from(img.data)]));
  let png = out;
  try {
    execFileSync('magick', [out, out.replace(/\.ppm$/, '.png')]);
    png = out.replace(/\.ppm$/, '.png');
  } catch {}
  const dec = decodeImage(img, null, { searchY: res.searchY });
  console.log(`captured ${img.width}x${img.height} -> ${png}`);
  if (!dec) console.log('no strip visible (open the OrcaWow window in game, or send something)');
  else if (dec.error) console.log(`strip found but unreadable: ${dec.error} (cell ${dec.geo.cell}px at ${dec.geo.ox},${dec.geo.oy})`);
  else console.log(`strip decoded: seq ${dec.seq}, ${dec.payload.length} bytes, cell ${dec.geo.cell}px at ${dec.geo.ox},${dec.geo.oy}`);
}

async function ask(question) {
  if (!process.stdin.isTTY) return false;
  const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

// Remove everything install put on this computer.
async function cmdUninstall(args) {
  const cfg = readConfig();
  if (!args.yes) {
    console.log('This removes OrcaWow: the addon and its update folders, its settings in the game,');
    console.log('the bridge service, its pairings with other computers\' Orcas, and its files.');
    if (!(await ask('Remove it? [y/N] '))) {
      console.log(process.stdin.isTTY ? 'Nothing removed.' : 'Nothing removed. Run `orca-wow uninstall --yes` to remove without asking.');
      return;
    }
  }
  const done = (msg) => console.log(`${C.g('✓')} ${msg}`);
  const warn = (msg) => console.log(`${C.y('!')} ${msg}`);

  if (fs.existsSync(service.file)) {
    service.remove();
    done('Stopped and removed the bridge service');
  }

  let wowDir = cfg.wowDir;
  if (!wowDir) {
    try {
      wowDir = findWowInstalls().forever[0];
    } catch {}
  }
  const addonsDir = cfg.addonsDir || (wowDir && addonsDirOf(wowDir));
  if (addonsDir && fs.existsSync(addonsDir)) {
    const n = new SlotBank(addonsDir).removeSlots(0);
    fs.rmSync(path.join(addonsDir, ADDON), { recursive: true, force: true });
    done(`Removed the addon and ${n} update folders from the game`);
  }
  if (wowDir) {
    // The addon's saved settings (account-wide SavedVariables).
    let removed = 0;
    const accounts = path.join(wowDir, 'WTF', 'Account');
    try {
      for (const acct of fs.readdirSync(accounts)) {
        for (const f of [`${ADDON}.lua`, `${ADDON}.lua.bak`]) {
          const p = path.join(accounts, acct, 'SavedVariables', f);
          if (fs.existsSync(p)) {
            fs.rmSync(p);
            removed++;
          }
        }
      }
    } catch {}
    if (removed) done('Removed its saved settings from the game');
  }

  // An access link stays valid on the computer that made it until it's revoked there.
  for (const r of cfg.orca?.remotes || []) {
    warn(`Revoke this PC's access on ${plainText(String(r.label || r.code))}: in its Orca, Settings → Remote Orca Servers → Shared Server Access.`);
  }

  fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
  fs.rmSync(STATE_DIR, { recursive: true, force: true });
  done('Removed the bridge\'s settings and state');

  try {
    if (BIN_LINK && fs.lstatSync(BIN_LINK).isSymbolicLink() && fs.readlinkSync(BIN_LINK).startsWith(DATA_DIR)) fs.rmSync(BIN_LINK);
  } catch {}
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  if (WINDOWS) removeLauncher();
  done('Removed the orca-wow command and its files');

  if (await findWowProcess()) console.log(`\nWorld of Warcraft is running: ${C.b('/reload')} or restart it to finish unloading OrcaWow.`);
}

// Windows: the launcher install.ps1 writes, %LOCALAPPDATA%\orca-wow\orca-wow.cmd. This
// command usually runs from it, and cmd reads a batch file line by line while it runs,
// so it's deleted a moment after cmd is done with it.
function removeLauncher() {
  const launcher = path.join(path.dirname(DATA_DIR), 'orca-wow.cmd');
  try {
    if (!fs.lstatSync(launcher).isFile()) return;
  } catch {
    return;
  }
  const now = () => fs.rmSync(launcher, { force: true });
  try {
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"ping -n 3 127.0.0.1 >nul & del /f /q "${launcher}""`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
    child.on('error', now);
    child.unref();
  } catch {
    now();
  }
}

// ---- Orcas on other computers (Orca's own pairing: an access link) ----------------

const PAIR_HELP = `On the other computer's Orca: Settings > Remote Orca Servers > New Link, pick its LAN address
(not 127.0.0.1), Generate Access Link, and copy the orca://pair?code=... link under "Pair another
Orca client". Or run there: orca pair --address <its LAN IP>`;

function orcaConfig(cfg) {
  cfg.orca = cfg.orca && typeof cfg.orca === 'object' ? cfg.orca : {};
  cfg.orca.remotes = Array.isArray(cfg.orca.remotes) ? cfg.orca.remotes : [];
  return cfg.orca;
}

function findRemote(remotes, name) {
  const n = String(name || '').toLowerCase();
  return remotes.find((r) => String(r.label).toLowerCase() === n || r.id === name || r.code === name);
}

function restartBridge() {
  if (fs.existsSync(service.file)) {
    service.restart();
    return true;
  }
  return false;
}

// The other computer's version and errors are its text: print them plain.
function describeProbe(p) {
  return p.ok ? C.g(`online${p.status?.appVersion ? ` (Orca ${plainText(p.status.appVersion)}` : ' ('}${p.framing === 'legacy' ? ', older encryption' : ''})`) : C.r(plainText(p.error));
}

// The access link from stdin, not the command line, where the shell's history file and
// the process list would keep it: pasted without echo at a terminal, or piped in
// (Get-Clipboard | orca-wow remote add MacBook).
async function readLink() {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    // A pipe that never sends a line or closes would otherwise wait silently forever.
    process.stderr.write('Reading the access link from standard input…\n');
    return new Promise((resolve, reject) => {
      let text = '';
      const firstLine = () => text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
      const finish = (err) => {
        clearTimeout(timer);
        stdin.off('data', onData);
        stdin.off('end', onEnd);
        stdin.off('error', finish);
        stdin.destroy();
        if (err) reject(err);
        else resolve(firstLine());
      };
      const onData = (chunk) => {
        text += chunk;
        // The link is the first line; don't wait for the rest of a pipe that stays open.
        const lineDone = text.split(/\r?\n/).slice(0, -1).some((l) => l.trim());
        if (lineDone || text.length > 256 * 1024) finish();
      };
      const onEnd = () => finish();
      const timer = setTimeout(() => finish(new Error('No access link arrived on standard input within 60 seconds. Pipe it in (Get-Clipboard | orca-wow remote add <name>), or run the command in a terminal and paste it when asked.')), 60000);
      stdin.setEncoding('utf8');
      stdin.on('data', onData);
      stdin.on('end', onEnd);
      stdin.on('error', finish);
      stdin.resume();
    });
  }
  process.stdout.write('Paste the access link (orca://pair?code=...) and press Enter. It stays hidden while you paste: ');
  if (typeof stdin.setRawMode !== 'function') {
    const rl = (await import('node:readline/promises')).createInterface({ input: stdin, output: process.stdout });
    const answer = await rl.question('');
    rl.close();
    return answer.trim();
  }
  return new Promise((resolve, reject) => {
    let text = '';
    let escape = false;
    const finish = (err) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write(err ? '\n' : `${text ? `(${text.trim().length} characters)` : ''}\n`);
      if (err) reject(err);
      else resolve(text.trim());
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (escape) {
          // Skip a key's escape sequence (arrows, bracketed paste markers).
          if (/[A-Za-z~]/.test(ch)) escape = false;
        } else if (ch === '\x1b') escape = true;
        else if (ch === '\r' || ch === '\n') return finish();
        else if (ch === '\x03' || (ch === '\x04' && !text)) return finish(new Error('Cancelled. Nothing was saved.'));
        else if (ch === '\x7f' || ch === '\b') text = text.slice(0, -1);
        else if (ch >= ' ' && ch <= '~') text += ch;
      }
    };
    stdin.setEncoding('utf8');
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

function warnLinkInHistory() {
  const clear = WINDOWS
    ? 'To remove it from PowerShell\'s history, delete that line from the file that (Get-PSReadLineOption).HistorySavePath names, then close this window.'
    : 'To remove it: in bash, find its number with `history | tail`, then run `history -d <number>` and `history -w`; in zsh, close this shell, then delete that line from ~/.zsh_history (or $HISTFILE).';
  console.log(C.y(`! The access link is now in your shell's history, where anything that can read your files can use it. ${clear} Next time, leave the link out: orca-wow remote add <name> asks for it.`));
}

async function cmdRemote(args) {
  const sub = args._[1] || 'list';
  const cfg = readConfig();
  const orca = orcaConfig(cfg);
  if (sub === 'list') {
    console.log(`${C.b('This PC')} ${orca.local === false ? C.d('hidden (orca-wow local on)') : C.d('shown')}`);
    if (!orca.remotes.length) {
      console.log(C.d(`No other computers yet. Add one with orca-wow remote add <name>, and paste its access link when asked.\n${PAIR_HELP}`));
      return;
    }
    const rows = await Promise.all(
      orca.remotes.map(async (r) => {
        const secret = readRemoteSecret(r.id);
        if (!secret) return [r, { ok: false, error: `its pairing is missing; run orca-wow remote add "${r.label}" and paste a new access link` }];
        // A host that answers over E2EE v2 is remembered, so nothing can downgrade it later.
        return [r, await probeRemote(secret, { label: r.label, timeoutMs: Number(args.timeout) || 6000, onLatch: () => markRemoteV2(r.id) })];
      }),
    );
    for (const [r, p] of rows) console.log(`${C.b(plainText(r.label))} ${describeProbe(p)} ${C.d(`· ${plainText(r.endpoint)} · ids ${plainText(r.code)}~`)}`);
    return;
  }
  if (sub === 'add') {
    const name = args._[2];
    if (!name) throw new Error(`usage: orca-wow remote add <name> [--allow-legacy] [--no-check], then paste the access link when asked\n${PAIR_HELP}`);
    if (!/^[\w .'-]{1,32}$/.test(name)) throw new Error('Use a short name (letters, digits, spaces, . _ \' -), like MacBook.');
    let link = args._[3];
    if (link) warnLinkInHistory();
    else link = await readLink();
    let offer;
    try {
      offer = parseAccessLink(link);
    } catch (err) {
      throw new Error(err.message);
    }
    const check = checkAccessLink(offer);
    if (check.error) throw new Error(check.error);
    if (check.warning) console.log(C.y(`! ${check.warning}`));
    const id = remoteIdFor(offer);
    // Legacy framing (no replay protection) only when asked for. A host already seen
    // speaking E2EE v2 stays that way under a new link, unless legacy is asked for.
    const allowLegacy = !!args['allow-legacy'];
    const secret = { id, label: name, endpoint: offer.endpoint, deviceToken: offer.deviceToken, publicKeyB64: offer.publicKeyB64, scope: offer.scope, pairedDeviceId: offer.pairedDeviceId, allowLegacy, addedAt: new Date().toISOString() };
    if (!allowLegacy && readRemoteSecret(id)?.e2ee === 'v2') secret.e2ee = 'v2';
    if (!args['no-check']) {
      if (process.stdout.isTTY) process.stdout.write(`… Connecting to Orca at ${new URL(offer.endpoint).host}\r`);
      const p = await probeRemote(secret, { label: name, timeoutMs: Number(args.timeout) || 10000 });
      if (process.stdout.isTTY) process.stdout.write('\r\x1b[2K');
      if (!p.ok) {
        const hints =
          p.code === 'unreachable' || p.code === 'timeout' || p.code === 'closed'
            ? `\nCheck that the other computer is awake with Orca open, on the same network as this PC, and that its firewall lets Orca accept incoming connections (macOS asks the first time; System Settings > Network > Firewall > Options). Nothing was saved; add --no-check to save it anyway.`
            : '\nNothing was saved.';
        throw new Error(`${plainText(p.error)}${hints}`);
      }
      if (p.framing === 'v2') secret.e2ee = 'v2';
      console.log(`${C.g('✓')} Connected to Orca${p.status?.appVersion ? ` ${plainText(p.status.appVersion)}` : ''} on ${name}`);
      if (p.framing === 'legacy') console.log(C.y(`! ${name}'s Orca only speaks the older encryption, which doesn't stop someone on the network from replaying commands. Update Orca there; the bridge switches to E2EE v2 by itself, and for good, once it can.`));
    }
    saveRemoteSecret(secret);
    const existing = orca.remotes.find((r) => r.id === id) || findRemote(orca.remotes, name);
    const used = new Set(orca.remotes.filter((r) => r !== existing).map((r) => r.code));
    let code = existing?.code && !used.has(existing.code) ? existing.code : null;
    for (let n = 1; !code; n++) if (!used.has(`e${n}`)) code = `e${n}`;
    if (existing && existing.id !== id) removeRemoteSecret(existing.id);
    orca.remotes = orca.remotes.filter((r) => r !== existing).concat({ code, label: name, id, endpoint: offer.endpoint });
    writeConfig(cfg);
    console.log(`${C.g('✓')} Saved ${C.b(name)} ${C.d(`(pairing in ${remoteSecretFile(id)})`)}`);
    console.log(restartBridge() ? `${C.g('✓')} ${name}'s agents will show in game within a few seconds.` : C.d('Start the bridge (orca-wow run, or orca-wow install) to see them in game.'));
    return;
  }
  if (sub === 'remove') {
    const name = args._[2];
    if (!name) throw new Error('usage: orca-wow remote remove <name>');
    const r = findRemote(orca.remotes, name);
    if (!r) throw new Error(`No other computer called ${name}; see orca-wow remote list`);
    removeRemoteSecret(r.id);
    orca.remotes = orca.remotes.filter((x) => x !== r);
    writeConfig(cfg);
    restartBridge();
    const label = plainText(r.label);
    console.log(`${C.g('✓')} Removed ${label} from this PC.`);
    console.log(C.y(`! Its access link still works until you revoke it on ${label}: in its Orca, Settings > Remote Orca Servers > Shared Server Access.`));
    return;
  }
  throw new Error('usage: orca-wow remote [list|add <name>|remove <name>]');
}

function cmdLocal(args) {
  const sub = args._[1];
  const cfg = readConfig();
  const orca = orcaConfig(cfg);
  if (!sub) {
    console.log(`This PC's Orca is ${orca.local === false ? 'hidden' : 'shown'} in game ${C.d('(orca-wow local on|off)')}`);
    return;
  }
  if (sub !== 'on' && sub !== 'off') throw new Error('usage: orca-wow local on|off');
  orca.local = sub === 'on';
  if (!orca.local && !orca.remotes.length) console.log(C.y('! No other computer is added yet, so the game will show no agents. Add one with orca-wow remote add.'));
  writeConfig(cfg);
  restartBridge();
  console.log(`${C.g('✓')} This PC's Orca is ${orca.local ? 'shown' : 'hidden'} in game.`);
}

// Claude Code and Codex run a message that starts with "!" as a shell command, without
// asking. The bridge refuses those from the game unless they're turned on here.
function cmdShell(args) {
  const sub = args._[1];
  const cfg = readConfig();
  const orca = orcaConfig(cfg);
  if (!sub) {
    console.log(`Messages from the game that start with "!" are ${orca.allowShell === true ? 'sent to the agents' : 'refused'} ${C.d('(orca-wow shell on|off)')}`);
    return;
  }
  if (sub !== 'on' && sub !== 'off') throw new Error('usage: orca-wow shell on|off');
  orca.allowShell = sub === 'on';
  writeConfig(cfg);
  restartBridge();
  if (orca.allowShell) {
    console.log(`${C.g('✓')} Messages from the game that start with "!" now go to the agents, which run them as shell commands without asking.`);
    console.log(C.y('! Other addons in your game could send such messages too. Turn it off again with orca-wow shell off.'));
  } else {
    console.log(`${C.g('✓')} Messages from the game that start with "!" are refused again.`);
  }
}

function help() {
  console.log(`${C.b('orca-wow')} ${VERSION} — Orca's coding agents inside World of Warcraft: Forever

  orca-wow install [--wow DIR] [--slots N] [--no-service]
                     Install the addon, its live-update slots and the bridge service
  orca-wow status [--log] [--json]
                     Show what the bridge sees
  orca-wow sync          Re-copy the installed addon into the game (to update, rerun the install command)
  orca-wow run [--verbose]
                     Run the bridge in the foreground (the service runs this)
  orca-wow remote [list]  Other computers' Orcas shown in game, and whether they answer
  orca-wow remote add <name> [--no-check] [--allow-legacy]
                     Show another computer's Orca too. Paste its access link
                     (orca://pair?code=...) when asked, or pipe it in:
                     Get-Clipboard | orca-wow remote add MacBook (pbpaste on macOS,
                     wl-paste on Linux).
                     The link comes from that Orca: Settings > Remote Orca Servers >
                     New Link > Generate Access Link, or \`orca pair --address <its LAN IP>\`.
                     --allow-legacy accepts an old Orca's older encryption, which
                     doesn't stop replayed commands; only use it on a network you trust
  orca-wow remote remove <name>
                     Stop showing that computer's Orca and forget its pairing (then
                     revoke it there: Settings > Remote Orca Servers > Shared Server Access)
  orca-wow local on|off  Show this PC's own Orca in game too (on by default)
  orca-wow shell on|off  Let messages from the game that start with "!" reach the agents,
                     which run them as shell commands without asking (off by default)
  orca-wow probe         Capture the corner of the game window and try to read the strip
  orca-wow uninstall [--yes]
                     Remove the addon, its settings, the service, the pairings
                     with other computers' Orcas and its files`);
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
const commands = { remote: cmdRemote, local: cmdLocal, shell: cmdShell, install: cmdInstall, run: cmdRun, status: cmdStatus, sync: cmdSync, probe: cmdProbe, uninstall: cmdUninstall };
if (!cmd || args.help || !commands[cmd]) {
  help();
  if (cmd && !commands[cmd]) process.exitCode = 1;
} else {
  // Through a promise, so a synchronous command's error is reported the same way.
  Promise.resolve()
    .then(() => commands[cmd](args))
    .catch((err) => {
      // Messages can quote another computer's text; keep line breaks, drop control codes.
      console.error(C.r(`✗ ${plainText(err.message, { lines: true })}`));
      process.exitCode = 1;
    });
}
