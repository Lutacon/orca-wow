# Plan: WoW: Forever addon for Orca (Windows)

Fork of [ryanrhughes/t3code-wow](https://github.com/ryanrhughes/t3code-wow) v0.3.0 (MIT, © 2026 Ryan Hughes; remote `upstream`).
Goal: see and control [Orca](https://github.com/stablyai/orca) agents from inside WoW: Forever, on Windows.

## How the base works (unchanged)

A WoW addon can't use the network or read files, so a **bridge** (Node, no npm dependencies) runs next to the game:

| Direction | Mechanism | Code |
|---|---|---|
| Game → bridge | The addon draws a strip of colored cells (encrypted) in the top-left corner; the bridge captures it from the screen and decodes it | `addon/OrcaWow/Core/Codec.lua`, `Transport.lua` · `bridge/src/codec.js`, `capture.js`, `strip-crypto.js` |
| Bridge → game | The bridge writes `Inbox.lua` into *LoadOnDemand* addons (`T3Code_S001…S1200`, now `OrcaWow_S###`); the addon loads the next one with `LoadAddOn` | `bridge/src/slots.js`, `luaser.js` · `Transport.lua` |
| "There's data" signal | Silent WAVs that the bridge fills in; the addon checks which one is playing with `C_Sound.IsPlaying` | `slots.js`, `Transport.lua` |

Round trip ≈ 1.2 s. Limit: 1200 updates per UI session (then `/reload`). Full details in `docs/ARCHITECTURE.md`.

## How we talk to Orca

**Main path: local named pipe, unencrypted, request/response.**

- Discovery: `%APPDATA%\orca\orca-runtime.json` → `{ runtimeId, pid, transports:[{kind:'named-pipe', endpoint}], authToken }`. The pipe and the token change every time Orca starts: re-read the file on reconnect.
- Frames (NDJSON, one per line): `{"id","authToken","method","params"}` → `{"id","ok":true,"result"}` / `{"id","ok":false,"error":{code,message}}`; `{"_keepalive":true}` every 10 s on long polls.
- Server limits: 1 MB per frame, 32 connections, 30 s idle timeout. No subscriptions, so we poll.
- Methods we use:
  - Read: `status.get`, `repo.list`, `worktree.ps` (`afterSnapshotId`, `includeAgentWait`), `terminal.list`, `terminal.read` (`screen`, `cursor`), `terminal.agentStatus`.
  - Write: `terminal.send` (`agentPrompt:true`, `interrupt`), `agentSession.respondToApproval`, `agentSession.respondToQuestion`, `worktree.set`, `worktree.sleep`, `agent.launch`.
  - Create worktree + agent: first planned through the CLI (`orca.exe worktree create --name X --agent claude --prompt "…" --json`, which handles retries); phase 3 uses `worktree.create` on the pipe.
- Agent ↔ terminal join: `worktree.ps` → `agents[].paneKey` (`<tabId>:<leafId>`) = `tabId`/`leafId` from `terminal.list`.
- States: workspace `active|working|permission|done|inactive`; agent `working|blocked|waiting|done`.

**Orca on another computer (phase 4b): the mobile app's WebSocket** `ws://<host>:6768`, end-to-end encrypted, paired with an access link (`orca://pair?code=…`). It could also give push events (`notifications.subscribe`, phase 5). Note: `orca pair` opens the port to the whole network.

Both APIs are **internal** to Orca and can change between versions. What Orca documents is the CLI (`--json`) and the plugin API.

### T3 → Orca mapping

| Concept in the addon | T3 Code | Orca |
|---|---|---|
| Project | project | repo |
| Thread | thread | agent inside a worktree (`paneKey`) |
| State `working` | active run | agent `working` |
| State `input` | pending runtime request | agent `blocked`/`waiting` (permission/question) |
| State `open` (finished, unread) | finished run | agent `done` + `unread` |
| Transcript | projection messages | `prompt` + `lastAssistantMessage` + terminal tail (`terminal.read`) |
| Send message | `message.dispatch` | `terminal.send {agentPrompt:true}` |
| Stop | `run.interrupt` | `terminal.send {interrupt:true}` |
| Approve / decline | `runtime-request.respond` | `agentSession.respondToApproval` or keys to the terminal menu |
| Settle / archive | `thread.settle` / `thread.archive` | `worktree.set --workspace-status` / `worktree.sleep` |
| New thread | `orchestration.launchThread` | `orca worktree create … --agent … --prompt` |
| Model / effort | `thread.model-selection.set` | doesn't apply (the CLI agent decides) → removed |

## Phases

### Phase 1 — Bridge working on Windows (T3 untouched)

- [x] `capture.js`: `process.getuid()` and `which()` safe on Windows (they used to break loading the module).
- [x] Per-platform paths in `src/paths.js`: on Windows everything under `%LOCALAPPDATA%\t3code-wow\{config,state,app}` (now `orca-wow`).
- [x] `wow.js`: find the game on Windows: `product.db`, `Battle.net.config`, Program Files and the usual folders on each drive.
- [x] `wow.js`: detect a running `_forever_\Wow.exe` by PID + creation time (through the helper). `findWowProcess` becomes async.
- [x] **`windows` capture backend**: persistent helper `native/wowhelper.cs` (compiled with the `csc.exe` from .NET Framework 4, which ships with Windows) + `src/winhelper.js`. `BitBlt` of the corner when it's uncovered, `PrintWindow(PW_RENDERFULLCONTENT)` when something covers it. Tested against the real game: 3840×2160 at DPI 144, ~16 ms per capture, correct DirectX pixels.
- [x] Window screenshot for attachments (`StripCapture.screenshot`) on Windows (PNG).
- [x] Autostart: Task Scheduler task at sign-in (`src/winservice.js`, `conhost --headless`, restart on failure, log in `state\bridge.log`).
- [x] Tests on Windows: 52 pass, 0 fail, 10 skipped (Wine/Linux, and those that need `lua5.1` on PATH).
- [x] `install` no longer aborts when T3 is missing: it warns and carries on (the backend arrived in phase 2).
- [x] **Milestone:** install the addon in the game and restart WoW. Done: the window shows the MacBook's agents.
- [ ] Check the full round trip with `/orca selftest`.

### Phase 2 — Read-only Orca client ✅

- [x] `bridge/src/orca.js` (`OrcaClient`): persistent NDJSON connection to the named pipe; re-reads `orca-runtime.json` on every connection; reopens quietly if Orca closes it for inactivity; backoff from 1 to 15 s; "Orca isn't running" if the file is missing. The token never appears in logs.
- [x] Same interface as `Fleet` (T3) and data in T3's shape, so `threadStatus`, `pendingRequest`, `activityLabel` and the rest in `bridge.js` work unchanged. The bridge uses Orca by default; T3 is still available with `"backend": "t3"`.
- [x] `worktree.ps` polling with `afterSnapshotId` (2 s when there's activity, 6 s when not). `terminal.read` only for the agent being viewed or the active one.
- [x] One thread per main agent (`paneKey`); project = repo; short, stable ids (`o…`/`r…`); Orca's `unread` → unread in game; worktree `completed` → done.
- [x] Projection: last prompt, last reply and the last 40 lines of the terminal (no ANSI). Questions and permission menus are read from the terminal screen, because the pipe doesn't expose `interactivePrompt`.
- [x] Tests: `test/orca.test.js` (22) with a fake Orca on a real named pipe (`test/support/fake-orca.js`) + `test/orca-bridge.test.js` (whole bridge → snapshot → command).

### Phase 3 — Commands to Orca ✅

- [x] `send` → `terminal.send {agentPrompt:true}`, as the CLI does. If a permission menu is open, a clear error ("answer the approval first").
- [x] `stop` → Esc (like the Stop button in Orca's mobile app), not Ctrl+C.
- [x] `approve` → reads the menu from the screen and presses the "Yes" or "Yes, don't ask again" option; `decline` → Esc. `answer` → the same keys Orca uses (`buildAskAnswerKeys`).
- [x] `new` → `worktree.create {startupAgent, startupPrompt}`; returns the new agent's id so the game can open it.
- [x] `settle`/`unsettle` → `worktree.set workspaceStatus completed|in-progress`; `archive` → `worktree.sleep`; `read` → `agentActivity.setRead`.
- [x] Attached screenshots: saved as PNG in `state\shots`, and their path is added to the prompt.
- [x] `model` → an error that explains why (Orca's agents pick their own model).

### Phase 4 — Adapt the addon to Orca ✅

- [x] Orca mode in the addon based on the snapshot's `bridge.backend`: "Orca"/"agents" wording, no model/effort picker or usage tab, "Mark as done" / "Reopen" / "Sleep worktree" buttons and "Yes" / "Yes, don't ask again" / "No". Smoke test (`tools/smoke.lua`) with ~30 new checks.
- [x] Renamed: addon `OrcaWow`, slots `OrcaWow_S###`, `/orca`, CLI `orca-wow`, data in `%LOCALAPPDATA%\orca-wow`.
- [x] Voice on Windows (SAPI through PowerShell). Dictation: pending.
- [x] `install.ps1`: copies to `%LOCALAPPDATA%\orca-wow\app`, creates `orca-wow.cmd` and runs `orca-wow install`.
- [x] Own README with attribution.
- [ ] **Final milestone:** use it end to end from the game: message an agent, answer its permission prompts, start a worktree, mark it done.
- [ ] **Milestone:** test against a real Orca running on this PC (so far only the fake Orca and the MacBook's Orca).

### Phase 4b — Remote Orca and new worktrees ✅

- [x] **Remote Orca** through an access link (`orca://pair?code=…`, *runtime* scope): WebSocket with E2EE v2 (legacy framing only when allowed, see phase 6), like the Orca CLI's paired client; tweetnacl 1.0.3 vendored in `bridge/vendor/`, checked against Orca's test vectors. `src/orca-remote.js`.
- [x] `src/orca-fleet.js`: the local Orca and N remote ones at once (ids `e1~…`, computer label in game, commands go to the right computer). CLI: `orca-wow remote add|list|remove`, `orca-wow local on|off`. Secrets in `config\remotes\<id>.json`.
- [x] Fixed: after a reconnect, `poll()` sent the old `afterSnapshotId` and emptied the agent list.
- [x] **New worktree** from the game, picking the agent, worktree name and base branch (`new <project> <text> <agent> <name> <branch>`; snapshot with `agents`); `/orca new --agent … --name … --base … <text>`.
- [x] Test against the MacBook's real Orca: the window in game shows its agents.

### Phase 5 — Optional

- [ ] Push events over Orca's WebSocket (pairing + NaCl) instead of polling.
- [ ] Orca's `trusted-worker` plugin (documented API) as a stable alternative to the internal pipe.

### Phase 6 — Security hardening (in progress)

Changes from a security audit, being implemented now.

- [ ] Pairing: `orca-wow remote add <name>` asks for the access link with hidden input, or reads it from a pipe (`Get-Clipboard | orca-wow remote add MacBook`). A link passed as an argument still works but warns that it's in the shell's history and says how to remove it.
- [ ] Older encryption only on request: `remote add --allow-legacy` lets a new pairing use Orca's legacy framing (no replay protection), for old Orca versions. Once a host has connected over E2EE v2, the bridge records it and never falls back to legacy for it.
- [ ] `orca-wow remote remove <name>` reminds you to revoke the access on the other computer (Settings → Remote Orca Servers → Shared Server Access).
- [ ] Messages from the game that start with `!` (Claude Code runs them as shell commands without asking) are refused unless `config.orca.allowShell` is `true`.
- [ ] Workspace-trust and hooks-review prompts can only be accepted at the computer; from the game you can only decline them.
- [ ] An approval or answer from the game is refused, and nothing is pressed, if the question on screen changed since the game showed it.
- [ ] Windows: the installer restricts `OrcaWow` and `OrcaWow_S###` to the current user (plus SYSTEM and Administrators), because Blizzard's AddOns folder is writable by every user on the PC, and warns about parent folders other accounts can still change.
- [ ] Remove the `OrcaWow` global, so other addons can't reach the addon's namespace.
- [x] README and PLAN in English, with these changes.

## Risks

- **Capture on Windows** with the game in DX12 fullscreen: test `PrintWindow`/`BitBlt` on this machine before anything else. Windowed or borderless should work. (Done: see phase 1.)
- **Orca's internal API**: the pipe and its schemas can change without notice. Keep it all in `orca.js` and fail with clear messages.
- **Antivirus**: launching helper processes for capture can look suspicious; prefer a single persistent helper.
- **Slots**: 1200 updates per session; the publish pacing in `bridge.js` already handles it.
- **License**: keep `LICENSE` and the attribution. Orca's name and logo belong to Stably and are used only to identify the integration.

## Environment status (2026-11-10)

- Git 2.56, Node 26.13 and LuaJIT 2.1 (for the Lua tests) installed with winget. Git `user.name`/`user.email` not set.
- Orca installed (`%APPDATA%\orca`, `%LOCALAPPDATA%\Programs\Orca`).
- WoW in `C:\Program Files (x86)\World of Warcraft\` with `_forever_`.
- Bridge tests on Windows: 0 failures (the 5 skipped are Wine/Linux). Addon smoke test with LuaJIT: OK.
- This PC's Orca wasn't open during development: the local path is tested against the fake Orca, built from Orca's source code. The remote path has been checked in game against the MacBook's Orca.
