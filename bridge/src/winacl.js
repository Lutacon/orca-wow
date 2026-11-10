// Windows: keep other accounts on this PC out of OrcaWow's folders in the game.
//
// Blizzard's installer gives BUILTIN\Users and INTERACTIVE full control of the game
// folder, AddOns included, so any other account on the PC could edit the addon's Lua, or
// the slot files that carry the strip key and snapshots, and get code run in your game
// with the real link keys. OrcaWow's own folders (OrcaWow and every OrcaWow_S###) get a
// protected DACL instead: inheritance off; you, SYSTEM and Administrators with full
// control; nobody else. The game runs as you, so it still reads them.
//
// Blizzard's folders are left alone. While AddOns stays writable by others, they can
// still add addons of their own, or move one of our folders aside and put another in its
// place. So install and every bridge start check the folders: each must be owned by you
// (or SYSTEM or Administrators), carry exactly the DACL above, and not be a link; and
// everything inside must be owned the same way and only inherit its permissions.
// Anything another account owned is reported as "foreign": its permissions are fixed,
// but its contents can't be trusted.

import { spawnSync } from 'node:child_process';
import path from 'node:path';

const SYSTEM32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const ICACLS = path.join(SYSTEM32, 'icacls.exe');
const POWERSHELL = path.join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const SYSTEM_SID = 'S-1-5-18';
const ADMINS_SID = 'S-1-5-32-544';

export function currentUserSid() {
  const r = spawnSync(path.join(SYSTEM32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  const m = /"(S-1-[\d-]+)"\s*$/m.exec(r.stdout || '');
  if (!m) throw new Error(`couldn't read your account's SID from whoami (${(r.stderr || r.error?.message || 'no output').trim()})`);
  return m[1];
}

// The protected DACL as icacls arguments. /l acts on a link itself, never its target.
export function protectArgs(target, sid) {
  return [target, '/inheritance:r', '/grant:r', ...[sid, SYSTEM_SID, ADMINS_SID].map((s) => `*${s}:(OI)(CI)F`), '/l', '/c', '/q'];
}

// Checks and repairs OrcaWow's folders under $env:ORCAWOW_ADDONS without following
// links, and reports which of $env:ORCAWOW_PARENTS other accounts can change. Prints one
// tab-separated line per finding (fixed | foreign | link | error | open), then "done".
// On a drive without permissions (FAT, exFAT) it only says "noacl" and the format.
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
$sid = $env:ORCAWOW_SID
$keep = @($sid, 'S-1-5-18', 'S-1-5-32-544')
$grant = @($keep | ForEach-Object { "*$($_):(OI)(CI)F" })
$icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
$SidType = [Security.Principal.SecurityIdentifier]
$script:n = 0
function Say($kind, $p, $detail) { [Console]::Out.WriteLine((($kind, $p, $detail) -join [char]9) -replace '[\r\n]+', ' ') }
function Icacls($p, [string[]]$a) {
  $out = & $icacls $p @a /l /c /q 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { throw ($out.Trim() -replace '\s+', ' ') }
}
function OwnerOk($acl) { $keep -contains $acl.GetOwner($SidType).Value }
function TopOk($acl) {
  if (-not (OwnerOk $acl) -or -not $acl.AreAccessRulesProtected) { return $false }
  $rules = @($acl.GetAccessRules($true, $true, $SidType))
  if ($rules.Count -ne 3 -or @($rules | ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique).Count -ne 3) { return $false }
  foreach ($r in $rules) {
    if ($r.IsInherited -or $r.AccessControlType -ne 'Allow' -or $keep -notcontains $r.IdentityReference.Value -or $r.FileSystemRights -ne 'FullControl' -or $r.InheritanceFlags -ne 'ContainerInherit, ObjectInherit' -or $r.PropagationFlags -ne 'None') { return $false }
  }
  $true
}
function ChildOk($acl) { (OwnerOk $acl) -and -not $acl.AreAccessRulesProtected -and @($acl.GetAccessRules($true, $false, $SidType)).Count -eq 0 }
function Walk($item, $top, $deep) {
  $p = $item.FullName
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Say 'link' $p ''; return }
  $script:n++
  try {
    $foreign = $false
    try { $acl = $item.GetAccessControl('Owner,Access') } catch {
      # Not even allowed to read its permissions: someone else owns it.
      $foreign = $true
      Icacls $p @('/setowner', "*$sid")
      $acl = $item.GetAccessControl('Owner,Access')
    }
    $ok = if ($top) { TopOk $acl } else { ChildOk $acl }
    if (-not $ok) {
      if (-not (OwnerOk $acl)) {
        $foreign = $true
        Icacls $p @('/setowner', "*$sid")
      }
      if ($top) {
        Icacls $p (@('/inheritance:r', '/grant:r') + $grant)
        foreach ($r in @($acl.GetAccessRules($true, $false, $SidType))) {
          $x = $r.IdentityReference.Value
          if ($keep -notcontains $x) { Icacls $p @('/remove', "*$x") }
          elseif ($r.AccessControlType -ne 'Allow') { Icacls $p @('/remove:d', "*$x") }
        }
      } else {
        Icacls $p @('/reset')
      }
      $item.Refresh()
      $acl = $item.GetAccessControl('Owner,Access')
      $ok = if ($top) { TopOk $acl } else { ChildOk $acl }
      if (-not $ok) { throw 'its permissions still let other accounts in after the change' }
      if (-not $foreign) { Say 'fixed' $p '' }
      # Someone had a hand in this folder: check everything in it too.
      $deep = $true
    }
    if ($foreign) { Say 'foreign' $p '' }
    if ($deep -and $item.PSIsContainer) { foreach ($c in @(Get-ChildItem -LiteralPath $p -Force)) { Walk $c $false $true } }
  } catch { Say 'error' $p $_.Exception.Message }
}
$root = $env:ORCAWOW_ADDONS
# FAT and exFAT drives keep no permissions at all: nothing to lock or check there.
$format = ''
try { $format = ([IO.DriveInfo]::new([IO.Path]::GetPathRoot($root))).DriveFormat } catch {}
if ($format -match '^(FAT|FAT12|FAT16|FAT32|exFAT)$') { Say 'noacl' $root $format; Say 'done' 0 ''; exit 0 }
if ($root -and (Test-Path -LiteralPath $root -PathType Container)) {
  foreach ($folder in @(Get-ChildItem -LiteralPath $root -Force | Where-Object { $_.Name -eq 'OrcaWow' -or $_.Name -match '^OrcaWow_S\d+$' })) { Walk $folder $true ($env:ORCAWOW_DEEP -eq '1') }
}
$trusted = $keep + @('S-1-3-0', 'S-1-3-4', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
$write = 0x2 -bor 0x4 -bor 0x10 -bor 0x40 -bor 0x100 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x10000000 -bor 0x40000000
foreach ($d in @(($env:ORCAWOW_PARENTS + '') -split [char]10 | Where-Object { $_ })) {
  try {
    $acl = (Get-Item -LiteralPath $d -Force).GetAccessControl('Access')
    $who = @($acl.GetAccessRules($true, $true, $SidType) | Where-Object { $_.AccessControlType -eq 'Allow' -and $trusted -notcontains $_.IdentityReference.Value -and ([int64]$_.FileSystemRights -band $write) } | ForEach-Object { try { $_.IdentityReference.Translate([Security.Principal.NTAccount]).Value } catch { $_.IdentityReference.Value } } | Sort-Object -Unique)
    if ($who.Count) { Say 'open' $d ($who -join ', ') }
  } catch {}
}
Say 'done' $script:n ''
`;

function powershell(script, env) {
  return spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 180000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

// Lock OrcaWow's folders under `addonsDir` to this account and repair what other
// accounts could change. Every folder's DACL is first set with one icacls call per name
// pattern (about half a second for 1200 folders, and a no-op when nothing changed); then
// the folders are checked, plus everything inside any folder that needed a repair. With
// `full` (install) everything inside every folder is checked too (a few seconds).
// `parents` are folders to report when other accounts can change them.
//
// Returns { checked, fixed, foreign, links, errors: [{ path, detail }], open: [{ path, who }],
// noAcl, failed }. `noAcl` names the drive's format (FAT32, exFAT) when it keeps no
// permissions, so there was nothing to lock: callers warn instead of refusing.
export function secureAddonFolders(addonsDir, { sid, full = false, parents = [] } = {}) {
  const out = { checked: 0, fixed: [], foreign: [], links: [], errors: [], open: [], noAcl: null, failed: null };
  try {
    sid = sid || currentUserSid();
  } catch (err) {
    out.failed = err.message;
    return out;
  }
  for (const name of ['OrcaWow', 'OrcaWow_S*']) {
    spawnSync(ICACLS, protectArgs(path.join(addonsDir, name), sid), { windowsHide: true, timeout: 120000, stdio: 'ignore' });
  }
  const r = powershell(SCRIPT, { ORCAWOW_ADDONS: addonsDir, ORCAWOW_SID: sid, ORCAWOW_DEEP: full ? '1' : '', ORCAWOW_PARENTS: parents.join('\n') });
  let done = false;
  for (const line of (r.stdout || '').split(/\r?\n/)) {
    const [kind, p, detail] = line.split('\t');
    if (kind === 'fixed') out.fixed.push(p);
    else if (kind === 'foreign') out.foreign.push(p);
    else if (kind === 'link') out.links.push(p);
    else if (kind === 'error') out.errors.push({ path: p, detail });
    else if (kind === 'open') out.open.push({ path: p, who: detail });
    else if (kind === 'noacl') out.noAcl = detail || 'FAT';
    else if (kind === 'done') {
      out.checked = Number(p) || 0;
      done = true;
    }
  }
  if (!done) out.failed = (r.stderr || r.error?.message || `PowerShell exited with ${r.status}`).trim().split(/\r?\n/)[0];
  return out;
}

// What a check found that the bridge must not work with: links, and anything another
// account created or that couldn't be checked. Folders this account owns that only
// needed their permissions locked again ("fixed") aren't problems.
export function folderProblems(r) {
  return [
    ...r.links.map((p) => `${p} is a link to another place`),
    ...r.foreign.map((p) => `${p} was created by another account on this PC`),
    ...r.errors.map((e) => `${e.path}: ${e.detail}`),
  ];
}

// The top-level OrcaWow folder each problem path belongs to (to replace it as a whole).
export function topFolders(addonsDir, paths) {
  const tops = new Set();
  for (const p of paths) {
    const first = path.relative(addonsDir, p).split(path.sep)[0];
    if (/^OrcaWow(_S\d+)?$/i.test(first)) tops.add(path.join(addonsDir, first));
  }
  return [...tops];
}