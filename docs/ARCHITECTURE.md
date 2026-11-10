# Architecture

```
 WoW: Forever (Windows, Wine or macOS)                 orca-wow bridge (Node, logon task or user service)
 ┌──────────────────────────────┐   pixels   ┌──────────────────────────────────────────────┐
 │ OrcaWow addon                │──────────▶│ capture.js    wowhelper, grim, KWin, macOS   │
 │  Transport.lua  strip, queue │            │ bridge.js     commands, pacing, snapshots    │
 │  Store.lua      snapshot     │◀──────────│ slots.js      Inbox.lua into OrcaWow_S###    │
 │  UI/*           window,      │   files    │               Signals/NNNNN.wav              │
 │                 tracker, pad │            │ orca.js       named pipe ────────────────────┼─▶ Orca on this PC
 └──────────────────────────────┘            │ orca-remote   E2EE WebSocket ────────────────┼─▶ Orca on other computers
                                             │ voice.js      speech, dictation              │
                                             └──────────────────────────────────────────────┘
```

The bridge shows the coding agents of one or more Orca apps: this PC's over its named pipe, others over Orca's end-to-end encrypted WebSocket.

## Constraints this is built around

Measured on live Forever 1.60.1 clients (TOC 16001) by [wow-forever-codex](https://github.com/0xinuarashi/wow-forever-codex) and [wow-ai](https://github.com/chelinho139/wow-ai). The approach here builds on that work:

1. Addons can't use sockets or read files. They can draw pixels.
2. The client indexes addon files **at launch**. Files that exist then can be loaded later. `LoadAddOn` reads a load-on-demand addon's Lua from disk when it loads, and each addon loads once per UI session (`/reload` resets that). New files need a full restart.
3. `PlaySoundFile` returns whether a file will play. A file that has never loaded is read fresh every time. Once one plays, the result is cached until the process exits.
4. SavedVariables are only written on `/reload` or logout, and `ReloadUI()` needs a key press or click.

## Game → bridge: the strip

`Codec.lua` and `codec.js` share one frame format:

```
'O' 'W' version  seq(2)  len(2)  payload…  fletcher16(2)
```

**Encryption.** The strip is on screen, so streams and recordings capture it. Version 2 frames (all of them, once the addon has its keys) carry

```
nonce(12)  ChaCha20(records)  HMAC-SHA-256(version, seq, nonce, ciphertext)[0..8]
```

- The bridge makes a random master key per install (`strip.key` in its state folder: `~/.local/state/orca-wow`, mode 0600, or `%LOCALAPPDATA%\orca-wow\state` on Windows) and derives an encryption key and a MAC key from it. Both go into every snapshot it writes to the slots. Slot files are never on screen.
- The addon keeps the keys in file-local variables in `Transport.lua`. They aren't saved, and the addon's namespace (`ns`) isn't exported as a global, so other addons can't just call `ns.Transport:Send`. The slot global is cleared on load. This only stops casual calls; see [Security](#security) for what holds against a malicious addon.
- Nonces are a per-load prefix (time and random bytes) plus a counter, and a frame is re-sealed only when its content changes.
- Version 1 (plaintext) frames are only ever a bare hello with no thread id. The addon sends one before it has keys, and the bridge answers it with a snapshot carrying them. The bridge never runs commands from a plaintext frame and drops any encrypted frame that fails the tag. Once it has seen a sealed frame from the running game, a plaintext hello changes nothing: one from a new UI session (a `/reload` that hasn't loaded a slot yet) only gets slots 1–3 rewritten with the keys, at most every 30 s.
- A hello's numbers are clamped to what a real addon sends, and the bridge moves its bell counter at most 8 past its own, so a bad frame can't stall publishing or burn the slots.
- Replays are harmless: the bridge only runs command ids above the last one it ran for that session.
- `Crypto.lua` implements ChaCha20 and SHA-256 on the client's `bit` library; the bridge uses Node's. `bridge/test/crypto.test.js` checks they agree under both signed (LuaJIT) and unsigned (WoW-style) `bit` results, and that a strip the addon draws decrypts only with the right keys. Cost in game: about 0.2 ms per frame, a few ms for a full 2,000-character message.

What this does and doesn't protect is under [Security](#security).

The frame is packed into 3-bit cells. Each cell is a 3×3-pixel square with R, G and B each fully on or off. The strip is 160 cells per row and up to 40 rows (about 2.4 KB), scaled so one UI unit is one physical pixel. It is anchored at the top-left of `UIParent` on the TOOLTIP strata. The bridge searches cell sizes 2–8 and small offsets, so a border or scaling quirk doesn't break it.

The payload is records separated by `RS` (0x1E), with fields separated by `US` (0x1F):

```
H  1  session  ui  nextSlot  sigNext  gen  flags  viewThreadId  addonVersion  slotCount
C  id  verb  args…                      (one per queued command)
```

- `session` is persistent (SavedVariables). `ui` is new every load, so the bridge can tell a `/reload` happened.
- `flags`:
  - `o`: window open
  - `t`: tracker on
  - `g`: gamepad UI
  - `r`: read finished replies with the desktop voice
  - `s`: sound signals unavailable
- Verbs:
  - `send`, `new`, `stop`. `new` takes `agent [name [baseBranch]]` after its text; empty fields mean Orca's defaults.
  - `settle`, `unsettle`, `archive`, `read`
  - `approve`, `answer`
  - `speak`, `say`, `hush`, `dictate`
  - `ping`

Commands for one thread run one after another, so an answer's keystrokes can't interleave with a message for the same agent; other threads don't wait. Stop doesn't wait in that line either: it's one Escape the player expects at once, while a message can take Orca up to 30 s to type. It still waits for an answer's keys or an approval's read-and-press on that pane to finish (`withKeyLock` in `orca.js`), since an Escape in the middle would close the selector and the rest would be typed into the prompt box.

The strip is drawn only while something is unacknowledged. "Something" means a status change such as opening the window or switching threads, or a queued command. It is redrawn when content changes and hidden as soon as a snapshot acknowledges its sequence number, usually in under a second. If nothing answers for 20 s, it hides and retries with backoff.

**Windows.** A small helper (`bridge/native/wowhelper.cs`), built on first use with the C# compiler that ships with Windows (.NET Framework 4's `csc.exe`), stays running and answers the bridge over stdin/stdout, so a capture costs a pipe round trip instead of a process launch. It finds the game's process and window, is per-monitor DPI aware so it works in physical pixels, and copies the corner with `BitBlt` from the screen when it's uncovered, or with `PrintWindow` (`PW_RENDERFULLCONTENT`, which renders DirectX content too) when another window covers it. `winhelper.js` builds and drives it.

**macOS.** The bridge finds the game window in CoreGraphics' window list (through a JXA script run by `osascript`, so there's nothing to compile) and captures the corner with `screencapture -R`, which returns physical pixels on a Retina display. The strip can start below the window's top: under a windowed game's title bar, or below the notch of a MacBook display in fullscreen. So the decoder searches 40 extra points down instead of guessing either height. Both tools run as the bridge, which needs the Screen Recording permission; the bridge asks for it when it starts.

**KDE Plasma.** KWin doesn't implement wlroots' screencopy, so `grim` can't read it. The bridge uses KWin's D-Bus API through `busctl` (part of systemd): `org.kde.krunner1.Match` on `/WindowsRunner` lists windows captioned "World of Warcraft", `getWindowInfo` gives each one's frame geometry, pid, desktops and minimized state, and `org.kde.KWin.ScreenShot2.CaptureArea` writes the corner's raw pixels (a QImage format KWin names in its reply) into a pipe the bridge passes as fd 3. It asks for native resolution so the cells aren't resampled on a scaled display, and searches 40 pixels down for a windowed game's title bar, as on macOS. Screenshots use `CaptureWindow`, which renders the window even while it's covered. On KWin 6.8 these calls work without the `X-KDE-DBUS-Restricted-Interfaces` grant that Spectacle's desktop file carries; if a later KWin refuses them, the error shows in `orca-wow status`.

## Bridge → game: slots and signals

`OrcaWow_S001…S1200` (1,200 by default) are load-on-demand addons grouped under OrcaWow in the addon list (`## Group`). They deliberately have no `## Dependencies`: WowUp hides an unrecognised load-on-demand folder only when all its dependencies are recognised, and OrcaWow isn't on CurseForge, so a dependency on it made every slot its own "Unknown" row (1,200 rows, measured with WowUp 2.24). Without it WowUp shows one "Orca" entry.

Addon managers also fingerprint each folder (a 32-bit hash of the `.toc` and the files it lists) and look it up across all of CurseForge. A slot that listed `Inbox.lua` directly produced a fresh hash with every update, and one collided: WowUp took a slot for a Minecraft modpack, which an "update" would have installed over it. So every slot's TOC is identical and lists a static `Slot.xml`, which loads `Inbox.lua` with `<Script file="Inbox.lua"></Script>`. The scanners only follow self-closing `<Script/>` tags, so all slots share one fixed fingerprint that matches nothing on CurseForge (checked with WowUp's own hashing code and a rescan).

Each contains `Inbox.lua`, which assigns `OrcaWow_Inbox = { … }`. The bridge serializes plain data with `luaser.js`, so thread text can never become code. All text is escaped for WoW markup (`|` → `||`), then markdown is turned into colors and bullets. Files are written to a random temporary name and renamed into place, and every folder written into must be a real folder inside AddOns (`checkFolder` in `slots.js`), so a link planted under one of OrcaWow's names is never written through.

A publish works like this:

1. Build the snapshot: threads (one per agent), projects (one per repo), the viewed thread's messages, pending question or approval, the agents a new worktree can start with, bridge status, command results and the ack.
2. Write it to the slots the addon will load next (from its last confirmed position to a little past the bridge's prediction) and to slots 1–3 (what a `/reload` bootstraps from).
3. Ring the next **bell**.

**Bells (the "new update" signal).** Measured on this client:

- `PlaySoundFile` returns `willPlay = true` for *every* file, even empty or garbage ones, so its answer is useless.
- `C_Sound.IsPlaying(handle)` a fraction of a second later is reliable: real sounds play and empty files don't.
- Sound files bigger than `Sound_MaxCacheableSizeInBytes` (174,762 bytes here) are streamed and re-opened from disk on every play (confirmed by watching file access), so they're never stuck in the cache.

So a bell is a 10-second silent WAV (441 KB), and those ten files are all of `Signals/`. The bridge rings bell `k` by writing that sound and empties bell `k-4`. The addon plays bells `sigNext … sigNext+3` every 0.5 s, checks which is really playing 0.15 s later, stops them all, and loads one slot if one rang. Eight bells rotate forever, with no per-session limit. They live at `Signals/03991–03998.wav`; `03999` (always long) and `04000` (always empty) are the self-test controls. These names already existed when the client started, which matters because the client only knows files that existed at launch.

If game sound is entirely off, the self-test fails and the addon falls back to loading a slot on a timer (3 s while you're using the window, 20 s open, 90 s closed).

Measured in game: a 1.2 s round trip from strip to update, 1 slot per 2 idle minutes with the window closed, and 2 per minute with it open.

**Pacing.** Each publish costs one slot, so the bridge paces by what you're doing:

| Situation | Interval |
| --- | --- |
| Acks and command results | ~0.5 s |
| Viewing a working thread | 2 s |
| Window open | 1.5–3 s |
| Window closed, status changes | 3 s |
| Window closed, minor changes | 20 s |
| Heartbeat (window open / closed) | 90 s / 240 s |

When few slots remain, intervals stretch 2–4×. When they run out, the addon offers `/reload`.

## Orca side

`orca.js` speaks the RPC the `orca` CLI uses, and hands the bridge one thread per agent; `threads.js` turns a thread into the state the game shows. `orca-fleet.js` puts several Orcas behind that one interface.

**This PC.** Orca writes `orca-runtime.json` into its user-data folder (`%APPDATA%\orca` on Windows) with its named pipe's address (a unix socket elsewhere) and an auth token, both new on every launch. The bridge re-reads the file whenever it connects, and treats it as stale when the process it names has exited, so it never talks to whatever took over the pipe's name. Requests are NDJSON over the pipe. Streaming methods are refused there, so the bridge polls `worktree.ps`: quickly while an agent works or waits, slower when all are idle.

**Other computers.** `orca-wow remote add <name>` reads the other Orca's access link (`orca://pair?code=…`, a desktop link from Settings → Remote Orca Servers, or `orca pair` there) from a hidden prompt or stdin, never the command line, where shell history would keep it. It checks the connection before saving. The device token and the host's public key go to `config/remotes/<id>.json`, never `config.json` or the logs. The bridge then opens the WebSocket Orca's own clients use (`orca-remote.js`): a plaintext hello and ready, an encrypted auth with the device token, then every frame sealed with NaCl (`vendor/tweetnacl`) and per-direction counters (E2EE v2). The RPC on top is the same as over the pipe.

- Orca's own client falls back to the older legacy framing, which has no counters and so no replay protection, when a host refuses the v2 hello. The bridge is stricter: once a host has authenticated it over v2, that's recorded in its pairing file and the bridge never dials legacy for it again; a new pairing gets legacy only with `--allow-legacy`. A `bad_auth` sealed by the pinned host (an old Orca) may still fall back.
- Text that comes from the other computer (errors, versions, labels) has its control characters removed before it is printed or logged.
- Agents on another computer get a short prefix on their ids (`e1~…`) and carry its name, so the game can filter by computer.

**Agents as threads.** One thread per agent pane (`<tabId>:<leafId>`) in a worktree, with an id hashed from the worktree and the pane; one project per Orca repo. Commands map onto Orca like this:

| Game | Orca |
| --- | --- |
| `send` | `terminal.send` with the text and Enter, as `orca terminal send --text --enter` does |
| `stop` | Escape, the key Orca's phone app sends for Stop |
| `new` | `worktree.create` with the agent and the prompt; a typed worktree name or base branch is checked against git's ref-name rules first |
| `settle`, `unsettle` | `worktree.set` `workspaceStatus` (`completed`, `in-progress`) |
| `archive` | `worktree.sleep` |
| `read` | `agentActivity.setRead` and `worktree.set isUnread: false` |

The transcript is the agent's last prompt, its last reply and the end of its terminal (`terminal.read`).

**Approvals and questions.** Orca doesn't hand out an agent's prompts as data. The bridge reads the terminal (`terminal.read`) and Orca's reason for the wait (`terminal.show` → `agentWait`), parses the menu at the bottom of the screen, and answers with the keys Orca's phone app sends: the row's digit to allow, Escape for No, and the selector's keys for a question (the option's on-screen digit, or the "Type something" row plus text). Since the game answers what it was shown, the bridge binds every answer to it:

- The request id is the wait's start time plus a hash of the tool, its input, the wait reason and the menu rows. Before pressing anything, the bridge reads the screen again and recomputes the id. If it differs, the question changed and nothing is pressed.
- Orca reports when a wait starts, not what it shows, so the thread doesn't change when the agent draws its menu a moment later or a resized window re-wraps a row. While the player looks at a waiting agent, the bridge reads it again every 3 s and publishes when its request changed. After refusing an answer, it reads the request again before the result goes out, so the game shows the current one.
- Nothing is pressed when the screen or the menu can't be read, or when no row says yes. Escape (No) is the only key sent without reading the menu; it only needs the agent to be in the same wait.
- Yes presses the first row that says yes and doesn't allow more than this request. When that row says more than "Yes" ("Yes, proceed"), the game shows it word for word on the button (`yl`).
- "Don't ask again" presses only the agent's own row, whose label the game shows word for word (`al` in the snapshot), because it can allow more than the one request. Rows that switch on a mode ("auto-accept edits", "bypass permissions") count as such rows. A menu without one gets no such button, and the bridge refuses that press.
- Workspace-trust and hooks-review prompts (Claude Code's and Codex's) are never approved from the game: it sees one line of a prompt that grants a lot. The game shows them as needing the computer (`pc`) and can only say No. So do requests it couldn't approve anyway: a prompt that isn't a numbered menu (OpenCode's, say), a menu without a yes row, and sign-in and model-migration prompts. `pcw` says which.
- When the bridge refuses an approval or answer, the command result says why and the game shows the request again.
- Messages and free-text answers with a line that starts with `!` run a shell command in Claude Code and Codex without asking. The bridge refuses them unless `orca-wow shell on` sets `allowShell` under `orca` in `config.json`. Slash commands (`/clear`) go through. Control characters (other than line breaks and tabs) are removed from the game's text first, so DEL or Ctrl+U can't edit a line into one that starts with `!`.

## Running on Windows

`install.ps1` copies the bridge and addon to `%LOCALAPPDATA%\orca-wow\app`, writes the `orca-wow.cmd` launcher next to it and runs `orca-wow install`. Install registers the bridge only from that copy, which only your account can change: a clone elsewhere (under `C:\`, say) may be writable by other accounts, whose code would then run at your logon.

The bridge runs as a Task Scheduler task at logon, in your interactive session, because it reads the game's pixels from the desktop (a service in session 0 can't). `conhost --headless` keeps the console hidden and runs a small `.cmd` script from its own folder (the task's working directory, so cmd never parses a profile path with `&`, `^` or `%` in it). conhost always exits 0, so the script restarts the bridge itself after a crash. The log goes to `%LOCALAPPDATA%\orca-wow\state\bridge.log`.

**OrcaWow's folders in the game.** Blizzard's installer gives every account on the PC write access to the game folder, AddOns included, so another account could edit the addon's Lua or the slot files that carry the strip key. `winacl.js` gives `OrcaWow` and every `OrcaWow_S###` a protected DACL: inheritance off, full control for you, SYSTEM and Administrators, nobody else. The game runs as you, so it still reads them. Install replaces any of these folders another account created or changed, and refuses links. Each bridge start checks them again (owner, DACL, no links, nothing inside owned by another account) and refuses to start if one was changed, with exit code 78, which the logon task doesn't restart; `orca-wow status` shows why. While it runs, the bridge checks before every write that each folder it writes into is still the one it started with (its volume and file id, one `lstat`), and stops publishing for good if one was moved or replaced. On a FAT or exFAT drive, which keeps no permissions, install and the bridge only warn. Install also says which of the game's own folders above them other accounts can still write to. `wow.js` only accepts a Forever folder that contains the game (`Wow.exe`), and says which folder it picked when it found it by scanning drives or in Battle.net's `product.db`, which every account can change.

## Controller

While the window is open it takes the gamepad itself (`EnableGamePadButton` / `EnableGamePadStick`), so the character doesn't move and B closes the window. The D-pad moves between controls by position, with explicit routes where position isn't enough (thread list → message box, for example). Blizzard's `SmartNavigationPointerTemplate` draws the cursor.

The addon never touches the binding-group APIs, which would taint the gamepad action bars, and avoids Blizzard's `Menu` (it caused "blocked action" errors). LB/RB switch tabs, X reads aloud, Y dictates, and the right stick scrolls the transcript. Forever has no on-screen keyboard, so text input uses dictation, quick replies and option buttons. The game menu gets an Orca button, and a controller chord opens the window.

## Security

What the design protects:

- **Viewers and recordings.** The strip is encrypted and authenticated, so streams, recordings and anything else that can only see or draw on the screen can neither read what you send nor make the bridge run anything.
- **Casual calls from other addons.** The addon's namespace isn't a global and the keys are file-local, so another addon or a WeakAura can't just call `ns.Transport:Send`. This isn't a boundary against a malicious addon (see below).
- **What the game can make the agents do.** These are the guards that hold even against an addon with the keys: approvals are bound to the menu the player saw and nothing is pressed blind; workspace trust and hooks reviews are answered at the computer; `!` shell commands are off unless `orca-wow shell on`.
- **The network.** A remote Orca is reached over E2EE v2 with the host's key pinned from the access link; a host that has used v2 never gets the legacy framing again.
- **Other accounts on the same Windows PC.** OrcaWow's folders in the game are locked to your account, the bridge refuses to start if they were changed, and the logon task runs only the copy of the bridge in `%LOCALAPPDATA%`.

What it doesn't:

- **The game's own folders.** On Windows, the AddOns folder and the folders above it usually stay writable by every account on the PC (Blizzard sets them up that way; install lists them). Another account can't change OrcaWow's folders, but can add addons of its own, which run in your game, or move OrcaWow's folders aside (the bridge then stops writing into them, and refuses to start until you run the install again). Ask an administrator to remove that write access if other people use the PC.
- **Addons you install.** Every addon shares one Lua state with OrcaWow. Removing the global raises the bar but isn't a sandbox: a malicious addon can load a slot itself, read the keys from the `OrcaWow_Inbox` it assigns, and draw its own strip. With the keys it can do what the player can from the game: send messages, start agents, and answer approvals the game shows, though not `!` shell commands (unless turned on) or workspace-trust and hooks prompts. Only install addons you trust.
- **The computer itself.** Anything running as your account can read the strip key, the pairing secrets and Orca's own token. The bridge doesn't try to defend against that.
