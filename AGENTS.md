# Agents guide

Read [CONTRIBUTING.md](CONTRIBUTING.md) for how changes are reviewed, and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the addon and bridge talk. This file lists what you must not break and how to check your work.

## Layout

- `addon/OrcaWow/`: the WoW: Forever addon (Lua 5.1, Blizzard UI templates). `Core/` holds the link to the bridge (`Transport.lua`, `Codec.lua`, `Crypto.lua`) and state; `UI/` holds the window, tracker, notices, controller support and minimap button.
- `bridge/`: the Node bridge (`orca-wow`), with no npm dependencies. `src/bridge.js` handles commands, pacing and snapshots, `src/slots.js` writes slots and bells, `src/capture.js` reads the strip, `src/wow.js` finds the game.
  - Orca backend (the default): `src/orca.js` (this PC's Orca over its named pipe, agents as threads, approvals and answers as keystrokes), `src/orca-remote.js` (access links and the E2EE WebSocket to an Orca on another computer), `src/orca-fleet.js` (several Orcas behind one client). `vendor/tweetnacl/` is vendored (NaCl boxes for that WebSocket), not an npm dependency.
  - T3 Code backend (`"backend": "t3"`): `src/t3.js` and `src/fleet.js`.
  - Windows: `native/wowhelper.cs` and `src/winhelper.js` (capture helper), `src/winservice.js` (logon task), `src/winacl.js` (locks OrcaWow's folders in the game to your account).
- `tools/`: the WoW API stub and headless addon tests.
- `install.ps1` (Windows) and `install.sh` (Linux, macOS): copy the bridge and addon to the user's data folder, then run `orca-wow install`.

## Platforms

Windows 10/11 with Orca is the setup this fork tests. Linux (Omarchy, and CachyOS with KDE Plasma, the game under Proton) and macOS (the native client) come from upstream and aren't tested here. Keep platform differences inside the module that owns them: `wow.js` (install folders and the running client: Wine prefixes, including those Faugus Launcher and Lutris record, and `/proc` on Linux; Battle.net's records and `ps` on macOS; Battle.net's `product.db` and config, Program Files and a drive scan on Windows, where a Forever folder must contain `Wow.exe`), `capture.js` (`grim` on Hyprland, KWin's D-Bus API through `busctl` on KDE Plasma, `import` on X11; CoreGraphics' window list through JXA and `screencapture` on macOS, which needs the Screen Recording permission; the `wowhelper` process on Windows, BitBlt or PrintWindow), `voice.js` (`spd-say`/`espeak-ng`, `say`, or SAPI through PowerShell), `envs.js` (the Tailscale CLI inside `Tailscale.app` on macOS), `paths.js` (XDG folders, or `%LOCALAPPDATA%\orca-wow`) and the service in `bin/orca-wow.js` (a systemd user unit, a launchd agent, or the logon task in `winservice.js`). Use only tools that ship with the system: on macOS nothing to compile or install; on KDE Plasma only what Plasma and systemd ship; on Windows only what Windows ships (the helper is built with .NET Framework 4's `csc.exe`; `icacls`, `schtasks`, Windows PowerShell 5.1).

## Measured limits of the game client

These come from measurements on live Forever clients. They look like bugs or workarounds; they aren't.

- **No sockets or file reads in addons.** The addon talks out through the pixel strip and in through load-on-demand slot addons and "bell" sounds. Don't propose a different channel without measuring it in game.
- **The client indexes addon folders at launch.** New slot folders and new addons need a full game restart. New files inside `OrcaWow/` and changed TOCs do load on `/reload`.
- **Each slot loads once per UI session.** Every publish costs a slot, which is why the bridge paces updates.
- **`PlaySoundFile` always reports `willPlay = true`.** Whether a bell rang is judged by `C_Sound.IsPlaying(handle)` a moment later. Bells are over the cacheable sound size, so the client re-reads them on every play.
- **Bell positions.** There are 8 rotating bells. The addon moves its bell position only from a fresh snapshot's `nextSig`, never from "the bell I heard", and the bridge never rings ahead of its own counter. Breaking either rule makes the addon alias still-rung bells and burn every slot.
- **Taint.** Don't use Blizzard's `Menu` API (it caused "blocked action" errors), don't call the gamepad binding-group APIs, and don't register anything into the objective tracker (the T3 Code section only anchors to it). Keep insecure code out of secure call paths.
- **Controller mode.** In Forever's controller mode the triggers are action-bar modifiers, Back is the game's "focus interface" binding, and the keybinding screen can't record controller chords, so key bindings can't open the window from a controller. The shortcut reads `C_GamePad.GetDeviceMappedState()` (button indexes from `ButtonBindingToIndex` are 0-based; `state.buttons` is 1-based) and only takes gamepad input while both triggers are held. Never take controller input outside the T3 window: an addon frame that receives gamepad buttons breaks the LT + RT action bars (face buttons and D-pad) even when its handler returns `true` to pass them on, so the shortcut only reads `GetDeviceMappedState` and lets the game see Back too. The window takes the controller only while it's open, and gives it back when combat starts (`PLAYER_REGEN_DISABLED`, before lockdown) because `EnableGamePadButton` is protected.

## Security invariants

- The strip is encrypted and authenticated (`Crypto.lua` ↔ `bridge/src/strip-crypto.js`). Keys stay in file-local variables in `Transport.lua`, never on `ns` or in SavedVariables.
- `ns` is not exported as a global, so other addons and WeakAuras can't just call `ns.Transport:Send`. Key bindings and the addon compartment use the few `OrcaWow_*` functions in `Slash.lua`; don't add a global that leads back to `ns`. This only stops casual calls: any addon can load a slot and read the keys from `OrcaWow_Inbox`. The guards that hold against a malicious addon are in the bridge: `allowShell`, approvals bound to the menu on screen, and the prompts only the computer can approve (below).
- The bridge never runs commands from an unencrypted frame, and drops frames that fail authentication. Once it has seen a sealed frame from this game process, a plaintext hello changes nothing (a new UI session only gets slots 1-3 rewritten with the keys).
- The game never approves workspace-trust or hooks-review prompts (`COMPUTER_ONLY` in `orca.js`, `pc` in the snapshot); it may only decline them. Requests the game can't approve anyway (no numbered menu, no yes row, sign-in and model prompts) are shown the same way, so the game never offers a Yes that would be refused.
- Approvals and answers are bound to what the player saw: the request id carries a hash of the tool, its input and the menu, and the bridge reads the terminal again before pressing anything. If the id doesn't match, the menu can't be read, or the row isn't there (no "don't ask again" row, no yes row), nothing is pressed, the bridge reads the request again and the game shows the current one. The only blind key is Escape for No, which only needs the agent to still be in the same wait.
- Messages from the game with a line that starts with `!` (a shell command in Claude Code and Codex) are refused unless `orca-wow shell on` (`config.orca.allowShell`). Control characters other than line breaks and tabs are removed from text from the game before it's typed (`gameText` in `orca.js`).
- A remote Orca that has used E2EE v2 is marked in its pairing file and never falls back to the legacy framing; new pairings get legacy only with `--allow-legacy`.
- On Windows, the `OrcaWow` and `OrcaWow_S###` folders get an owner-only DACL (you, SYSTEM, Administrators). Install replaces folders another account created; the bridge refuses to start if they were changed (exit code 78, which the logon task doesn't restart), and stops publishing if one is moved or replaced while it runs (`SlotBank.pin`). Writes into the game go through `atomicWrite` and `checkFolder`, never through a link. On a FAT or exFAT drive there are no permissions to set; install and the bridge warn instead.
- The bridge's T3 Code session is scoped to reading and running threads. Don't widen it without a reason stated in the PR.
- Never commit tokens, keys, hostnames or personal paths.

## Slot manifests

Every `OrcaWow_S###` folder has an identical TOC with no `## Dependencies`, and loads `Inbox.lua` through `Slot.xml` with `<Script file="Inbox.lua"></Script>`. Addon managers fingerprint folders against all of CurseForge. This layout keeps all slots on one fixed fingerprint that matches nothing, and keeps them out of WowUp's list. Any change to the slot TOC or `Slot.xml` text changes that fingerprint: check it against WowUp (a rescan should list only "Orca") before shipping.

## T3 Code Nightly API

The bridge uses T3 Code's own WebSocket RPC, which changes between nightlies. When a command fails with a schema error ("Missing key …"), check the running server's definitions instead of guessing. For example, `thread.unsettle` needs `reason: "user"`, and projects are created with the `projects.mutate` RPC, not `dispatchCommand`.

## Testing

Run what covers your change, once, and read the output:

- `cd bridge && npm test` (or `node --test`) for anything in `bridge/`, including protocol and crypto. The crypto tests run the addon's Lua under `lua5.1` (with `tools/bitstub.lua`, unsigned like WoW) and `luajit` (signed), and must agree with Node. The tests use whichever of the two is on PATH, so `luajit` alone works where `lua5.1` is missing (as on Windows).
- `lua5.1 tools/smoke.lua …` and/or `luajit tools/smoke.lua …` (see CONTRIBUTING.md) for anything in `addon/`.
- Bridge tests must pass a temporary `stateDir`; never let a test touch `~/.local/state/orca-wow` or `%LOCALAPPDATA%\orca-wow`.
- The stub's widget methods come from the client's API documentation. If a real method is missing, add it to the stub; don't call methods the client doesn't have.

When to add a test: only for logic that could regress unnoticed (parsing, the bell rules, crypto agreement, a controller edge case). Don't add tests that restate a string or config value.

## Verifying UI changes

Tests don't show what the player sees. Anything visible must be checked in game: `install.ps1` (Windows) or `./install.sh` from the checkout, `/reload`, then look. (`orca-wow sync` re-copies the installed addon, not your edits.) On Windows, don't link the game's `OrcaWow` folder to your checkout: the bridge refuses to start when it finds a link (junction) there. Use the controller too when navigation is involved. Attach screenshots or a short recording to the PR, as CONTRIBUTING.md describes. `orca-wow probe` captures the strip corner when the link itself is in question.

## Style

- Lua: tabs. JavaScript: two spaces, ES modules, Node built-ins only.
- In Markdown, write full lines with no hard wrapping.
- Text people see is plain and specific: say what happened and what to do.
- Commits are atomic, with short messages that describe the change.
