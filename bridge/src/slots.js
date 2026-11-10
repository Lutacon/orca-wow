// The inbound channel (bridge -> game).
//
// WoW addons can't read files at runtime, with two exceptions this relies on, both
// measured on live Forever clients (see docs/ARCHITECTURE.md):
//
//  * C_AddOns.LoadAddOn reads a load-on-demand addon's Lua from disk when it is
//    loaded. Each slot addon (OrcaWow_S001...) can be loaded once per UI session, and
//    /reload unloads them all. We write a snapshot into the next few slots the addon
//    will load.
//  * Sound files bigger than the client's cacheable size (Sound_MaxCacheableSizeInBytes,
//    174,762 bytes here) are streamed from disk and re-opened on every play (measured
//    on this client with inotify). So a large silent .wav is a reusable "bell": the
//    bridge fills it to announce a new snapshot, and the addon plays it and checks
//    C_Sound.IsPlaying a moment later (empty files never play). PlaySoundFile's own
//    "willPlay" answer is useless on Forever: it says true even for empty files.
//    Eight bells rotate so back-to-back updates can't be missed; they live at fixed
//    names inside the Signals folder that already existed when the client started.
//
// Files have to exist when the client starts: the game only indexes them at launch.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { luaAssignment } from './luaser.js';

export const ADDON = 'OrcaWow';
export const INTERFACE = '16001';

export function slotName(i) {
  return `${ADDON}_S${String(i).padStart(3, '0')}`;
}

// Bells reuse signal files that were created at install time (the client only knows
// files that existed at launch) and were never raised, so they've never been cached.
export const BELL_BASE = 3991;
export const BELLS = 8;
export const CTL_LONG = 3999; // always a long valid sound: the addon's self-test
export const CTL_EMPTY = 4000; // always empty

export function sigName(k) {
  return String(k).padStart(5, '0') + '.wav';
}

// 10 s of 16-bit mono silence at 22.05 kHz: ~441 KB, comfortably over the cacheable
// size, so the client streams (and re-reads) it on every play.
export const LONG_SILENT_WAV = (() => {
  const data = 22050 * 2 * 10;
  const b = Buffer.alloc(44 + data);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + data, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(22050, 24);
  b.writeUInt32LE(22050 * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(data, 40);
  return b;
})();

// On Windows a file another process has open can't be replaced, and the client keeps a
// bell open while it plays it (each poll of the addon's look-ahead window holds one for
// a fraction of a second). So a refused rename is retried briefly before giving up.
const RENAME_TRIES = process.platform === 'win32' ? 40 : 1;
const RENAME_WAIT_MS = 20;
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// The temporary name is random and created exclusively ('wx'), so nothing planted in
// advance under a guessable name (a link, say) is written through. The rename replaces
// the directory entry: a link or hard link at `file` is replaced, never written into.
export function atomicWrite(file, content, { tries = RENAME_TRIES, rename = fs.renameSync } = {}) {
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, content, { flag: 'wx' });
  for (let i = 1; ; i++) {
    try {
      rename(tmp, file);
      return;
    } catch (err) {
      if (i >= tries || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) {
        fs.rmSync(tmp, { force: true });
        throw err;
      }
      pause(RENAME_WAIT_MS);
    }
  }
}

// Bells on Windows. The client keeps a bell it is polling open for seconds at a time
// without letting it be replaced (measured: renames refused for ~4 s in a row), but it
// does let it be written. So after a few quick rename tries the bell is rewritten in
// place: the body first and the header last, so a half-written fill never looks like a
// complete sound, then truncated to size. Only a plain file with a single link is
// written in place (the Signals folder itself is pinned and owner-only on Windows).
const BELL_RENAME_TRIES = 5;
const BELL_RENAME_WAIT_MS = 10;

export function writeBell(file, content, { rename = fs.renameSync } = {}) {
  if (process.platform !== 'win32') return atomicWrite(file, content, { rename });
  try {
    return atomicWrite(file, content, { tries: BELL_RENAME_TRIES, rename });
  } catch (err) {
    if (!['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err;
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.nlink !== 1) throw err;
    const fd = fs.openSync(file, 'r+');
    try {
      const body = Buffer.from(content);
      if (body.length > 44) fs.writeSync(fd, body, 44, body.length - 44, 44);
      if (body.length) fs.writeSync(fd, body, 0, Math.min(44, body.length), 0);
      fs.ftruncateSync(fd, body.length);
    } finally {
      fs.closeSync(fd);
    }
  }
}

// The only names install ever prunes from Signals.
const SIGNAL_FILE = /^\d{5}\.wav$/;
// What atomicWrite leaves behind if the bridge dies between its write and its rename.
const TEMP_FILE = /\.[0-9a-f]{12}\.tmp$/;

// A folder the bridge writes into was moved or replaced since it started.
export class FolderChangedError extends Error {
  constructor(dir) {
    const again = process.platform === 'win32' ? 'run install.ps1 again' : 'run the install again';
    super(`${dir} was moved or replaced while the bridge was running (on a shared PC, another account may have done it), so the bridge stopped sending updates to the game. To fix it, ${again}, then restart the game.`);
    this.code = 'FOLDER_CHANGED';
  }
}

// A folder's identity: its volume and file id, or null when it's missing. A folder
// put in place of ours (or a link to one) has another id.
function folderId(dir) {
  try {
    const st = fs.lstatSync(dir, { bigint: true });
    return `${st.isDirectory() && !st.isSymbolicLink() ? 'd' : 'x'}:${st.dev}:${st.ino}`;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// A folder OrcaWow writes into must be a real folder inside the AddOns folder. On
// Windows, Blizzard lets every account on the PC create folders in AddOns, and a link
// planted under one of our names (Node reports junctions as symbolic links) would make
// the install write, or prune, somewhere else. Returns false if `dir` doesn't exist.
export function checkFolder(addonsDir, dir, base = fs.realpathSync.native(addonsDir)) {
  let st;
  try {
    st = fs.lstatSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
  const refuse = (what) => new Error(`${dir} is ${what}, so OrcaWow won't write there. Delete it, then run the install again.`);
  if (st.isSymbolicLink()) throw refuse('a link to another place');
  if (!st.isDirectory()) throw refuse('not a folder');
  const rel = path.relative(base, fs.realpathSync.native(dir));
  if (!rel || rel.split(path.sep)[0] === '..' || path.isAbsolute(rel)) throw refuse(`outside ${addonsDir}`);
  return true;
}

export class SlotBank {
  constructor(addonsDir, { slots = 600 } = {}) {
    this.addonsDir = addonsDir;
    this.slots = slots;
    this.sigDir = path.join(addonsDir, ADDON, 'Signals');
    this.pinned = null; // dir -> folderId, once pin() ran
  }

  // Remember which folders the bridge writes into (OrcaWow, Signals and every slot), so
  // each write can check it still writes into the same ones. The bridge checks them at
  // start (on Windows, that only your account can change them), but the AddOns folder
  // above them stays writable by every account: another could move one aside while the
  // bridge runs and put its own folder, or a link, in its place.
  pin() {
    this.pinned = new Map();
    for (const dir of [path.join(this.addonsDir, ADDON), this.sigDir]) this.pinned.set(dir, folderId(dir));
    for (let i = 1; i <= this.slots; i++) {
      const dir = path.dirname(this.slotFile(i));
      this.pinned.set(dir, folderId(dir));
    }
  }

  // One lstat per folder; throws FolderChangedError if it isn't the pinned one.
  checkPinned(dir) {
    if (!this.pinned) return;
    const was = this.pinned.get(dir);
    const now = folderId(dir);
    if (was === undefined || now !== was || !now?.startsWith('d:')) throw new FolderChangedError(dir);
  }

  checkSignals() {
    this.checkPinned(path.join(this.addonsDir, ADDON));
    this.checkPinned(this.sigDir);
  }

  slotFile(i) {
    const name = slotName(i);
    return path.join(this.addonsDir, name, 'Inbox.lua');
  }

  sigFile(k) {
    return path.join(this.sigDir, sigName(k));
  }

  // Every slot's TOC is identical, and it loads Inbox.lua through a static Slot.xml.
  //
  // Addon managers (WowUp, the CurseForge app) identify folders by a 32-bit hash of the
  // .toc plus the files it lists, looked up against all of CurseForge. Inbox.lua changes
  // with every update, so listing it directly meant hundreds of fresh hashes per scan,
  // and one did collide (WowUp took a slot for a Minecraft modpack, and an "update"
  // would have replaced it). Their scanners follow only self-closing <Script file/>
  // tags, so with `<Script file="Inbox.lua"></Script>` every slot hashes the same two
  // unchanging files: one fixed fingerprint, checked against CurseForge once.
  //
  // No `## Dependencies` either: WowUp hides an unrecognised load-on-demand folder only
  // when all its dependencies are recognised, and OrcaWow isn't on its sites, so a
  // dependency on it listed every slot as an unknown addon. The game doesn't need it.
  slotToc() {
    return [
      `## Interface: ${INTERFACE}`,
      '## Title: Orca data slot (leave enabled)',
      '## Notes: Carries live updates from the orca-wow bridge into the game. Orca stops updating if these are turned off.',
      '## Author: Lutacon, Ryan Hughes',
      `## IconTexture: Interface\\AddOns\\${ADDON}\\Media\\icon`,
      '## LoadOnDemand: 1',
      `## Group: ${ADDON}`,
      '',
      'Slot.xml',
      '',
    ].join('\n');
  }

  slotXml() {
    return [
      '<Ui xmlns="http://www.blizzard.com/wow/ui/">',
      '\t<Script file="Inbox.lua"></Script>',
      '</Ui>',
      '',
    ].join('\n');
  }

  // Create every slot and bell that doesn't exist yet, refresh slot TOCs that differ,
  // and remove signal files older versions created but nothing uses. Returns counts.
  //
  // Every folder it writes into must be a real folder inside the AddOns folder (see
  // checkFolder), and files are replaced with atomicWrite, so a link planted under one
  // of our names is never written through or pruned through.
  install() {
    let made = 0;
    let kept = 0;
    const base = fs.realpathSync.native(this.addonsDir);
    const folder = (dir) => {
      if (checkFolder(this.addonsDir, dir, base)) return;
      fs.mkdirSync(dir);
      checkFolder(this.addonsDir, dir, base);
    };
    const ensure = (file, content, { refresh = false } = {}) => {
      let st = null;
      try {
        st = fs.lstatSync(file);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      if (st && !st.isFile() && !st.isSymbolicLink()) throw new Error(`${file} is not a file, so OrcaWow can't use it. Delete it, then run the install again.`);
      if (st?.isFile() && !(refresh && fs.readFileSync(file, 'utf8') !== content)) {
        kept++;
        return;
      }
      atomicWrite(file, content);
      made++;
    };
    folder(path.join(this.addonsDir, ADDON));
    folder(this.sigDir);
    for (let i = 1; i <= this.slots; i++) {
      const name = slotName(i);
      folder(path.join(this.addonsDir, name));
      ensure(path.join(this.addonsDir, name, `${name}.toc`), this.slotToc(), { refresh: true });
      ensure(path.join(this.addonsDir, name, 'Slot.xml'), this.slotXml(), { refresh: true });
      ensure(this.slotFile(i), 'OrcaWow_Inbox = nil\n');
    }
    // Only the bells and the two self-test controls are ever played.
    for (let k = BELL_BASE; k < BELL_BASE + BELLS; k++) ensure(this.sigFile(k), '');
    ensure(this.sigFile(CTL_LONG), LONG_SILENT_WAV);
    ensure(this.sigFile(CTL_EMPTY), '');
    const keep = new Set([...Array(BELLS).keys()].map((i) => sigName(BELL_BASE + i)).concat(sigName(CTL_LONG), sigName(CTL_EMPTY)));
    let pruned = 0;
    // Removes a regular file only: a link (or anything else) under that name stays.
    const removeFile = (file) => {
      try {
        if (!fs.lstatSync(file).isFile()) return false;
        fs.rmSync(file, { force: true });
        return true;
      } catch {
        return false;
      }
    };
    for (const f of fs.readdirSync(this.sigDir)) {
      if (keep.has(f) || !SIGNAL_FILE.test(f)) continue;
      if (removeFile(path.join(this.sigDir, f))) pruned++;
    }
    // Temporary files a bridge that stopped mid-write left behind (atomicWrite's names).
    let temps = 0;
    for (const dir of [this.sigDir, ...Array.from({ length: this.slots }, (_, i) => path.join(this.addonsDir, slotName(i + 1)))]) {
      for (const f of fs.readdirSync(dir)) {
        if (TEMP_FILE.test(f) && removeFile(path.join(dir, f))) temps++;
      }
    }
    return { made, kept, pruned, temps };
  }

  // Remove slot addons beyond `keep` (used by uninstall and when shrinking the bank).
  removeSlots(keep = 0) {
    let removed = 0;
    for (const d of fs.readdirSync(this.addonsDir)) {
      const m = /^OrcaWow_S(\d+)$/.exec(d);
      if (m && Number(m[1]) > keep) {
        fs.rmSync(path.join(this.addonsDir, d), { recursive: true, force: true });
        removed++;
      }
    }
    return removed;
  }

  installedSlotCount() {
    let n = 0;
    while (n < 10000 && fs.existsSync(this.slotFile(n + 1))) n++;
    return n;
  }

  write(slotIndexes, value) {
    const content = luaAssignment('OrcaWow_Inbox', value);
    for (const i of slotIndexes) {
      if (i < 1 || i > this.slots) continue;
      const file = this.slotFile(i);
      this.checkPinned(path.dirname(file));
      atomicWrite(file, content);
    }
    return content.length;
  }

  bellFile(k) {
    return this.sigFile(BELL_BASE + ((((k - 1) % BELLS) + BELLS) % BELLS));
  }

  // Fill bell k and empty the one four behind it, so the addon's look-ahead window
  // (k .. k+3) only ever sees bells raised after it last loaded.
  raise(k) {
    this.checkSignals();
    writeBell(this.bellFile(k), LONG_SILENT_WAV);
    writeBell(this.bellFile(k - 4), '');
    return true;
  }

  // The self-test controls and empty bells; safe to call at every start.
  prepareBells() {
    this.checkSignals();
    const long = this.sigFile(CTL_LONG);
    try {
      if (fs.statSync(long).size !== LONG_SILENT_WAV.length) atomicWrite(long, LONG_SILENT_WAV);
    } catch {
      atomicWrite(long, LONG_SILENT_WAV);
    }
    atomicWrite(this.sigFile(CTL_EMPTY), '');
  }

  // Bells are re-read on every play, so at a client restart we only need them empty.
  resetSignals() {
    this.checkSignals();
    for (let i = 0; i < BELLS; i++) {
      try {
        writeBell(this.sigFile(BELL_BASE + i), '');
      } catch {}
    }
  }
}
