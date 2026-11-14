# Orca for World of Warcraft

See and control your [Orca](https://github.com/stablyai/orca) agents (Claude Code, Codex and others, each in its own git worktree) without leaving **World of Warcraft: Forever**, on Windows (and on a Mac, not yet tested with the game running).

This is a fork of [ryanrhughes/t3code-wow](https://github.com/ryanrhughes/t3code-wow). This fork adds Windows support and connects the addon to Orca.

> Experimental. The Orca APIs it uses (the local named pipe, and the encrypted WebSocket for other computers) are internal to Orca and can change between versions.

## What it does

- A window in the game (`/orca`) with your Orca agents grouped by state: working, waiting for you, or done. Each one shows its last prompt, its last reply and the end of its terminal.
- **Message** an agent, **stop** it (Esc) and **answer its permission prompts**: Yes, No, or the agent's own "don't ask again" option, word for word, when its menu has one. You can also answer its multiple-choice questions.
- **Start a new worktree** in any Orca repo, picking the agent (Claude, Codex, OpenCode and others), the worktree name and the base branch, with your prompt. **Mark as done** or **sleep** its worktree.
- **Several Orcas at once**: the one on this PC and those on other computers on your network, such as a MacBook. See "Orca on another computer" below.
- Notices when an agent finishes or asks for something: a toast, a sound, a line in chat and a section in the objective tracker. They wait until you leave combat.
- Replies read aloud with the system voice. Controller support.

## Getting started

You need Windows 10 or 11 and **World of Warcraft: Forever** installed from Battle.net. Windowed and borderless fullscreen both work. You don't need to be an administrator for any of these steps.

1. **Install Node.js 22 or newer.** In a terminal: `winget install OpenJS.NodeJS.LTS`. Nothing else is needed: the screen capture helper is compiled with the C# compiler that ships with Windows.
2. **Install [Orca](https://github.com/stablyai/orca) and open it**, on this PC or on another computer on your network (for that, also follow "Orca on another computer" below). Add a repository in Orca and start an agent, so there's something to see in game.
3. **Download the latest `orca-wow-v….zip`** from [Releases](https://github.com/Lutacon/orca-wow/releases/latest) and extract it.
4. **Close the game** and run the installer from the extracted folder, in your own terminal:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install.ps1
   ```
   It puts the addon in the game, starts the bridge and tells you what to do next. If it can't find the game, add `--wow "D:\Games\World of Warcraft"` (the folder that contains `_forever_`).
5. **Start World of Warcraft: Forever.** At character select, open **AddOns** and check that **Orca** is enabled. Under it are 1200 "Orca data slot" entries, which carry the updates from the bridge; leave them enabled. If Orca is listed as out of date, tick **Load out of date AddOns**.
6. **Log in to a character.** The installer, still waiting in your terminal, says "Connected" when the game and the bridge talk to each other.
7. In game, type `/orca` or click the Orca button on the minimap. From a controller, hold both triggers and press Back. `/orca selftest` checks the link step by step if something seems off.

The bridge then starts by itself each time you sign in to Windows, so from now on you only need Orca open and the game running.

### If it doesn't connect

- `orca-wow status` (see "Using it" for where the command is) says what the bridge sees: Orca, the game, the capture and the addon. `orca-wow status --log` adds its recent log.
- The game window must be on screen, not minimized. Other windows covering it are fine.
- After installing for the first time, or after an update that added folders or sounds, quit the game completely and start it again: `/reload` isn't enough, because the game only finds new addon folders when it starts.
- If Orca runs on this PC, it must be open. `orca-wow status` says so when it can't reach it.

## What the installer does

1. Copies the bridge and the addon to `%LOCALAPPDATA%\orca-wow\app`, and creates the `orca-wow` command at `%LOCALAPPDATA%\orca-wow\orca-wow.cmd`.
2. Installs the addon and its 1200 update folders (`OrcaWow_S###`) in `_forever_\Interface\AddOns`.
3. Restricts the addon's folders (`OrcaWow` and every `OrcaWow_S###`) to your Windows account, plus SYSTEM and Administrators. Blizzard's installer lets every user on the PC write to the game's AddOns folder, so another account could otherwise change the addon's code. If a folder above them is still writable by other accounts, the installer says which one. The bridge checks the addon's folders again each time it starts, and won't start if another account changed them: run `install.ps1` again to replace them.
4. Registers the bridge as a task that starts when you sign in, with no window, and restarts it if it fails. Its log goes to `%LOCALAPPDATA%\orca-wow\state\bridge.log`.
5. Waits for you to enter the game.

Options: `--wow "D:\Games\World of Warcraft"`, `--slots N` and `--no-service` (then start the bridge yourself with `orca-wow run`).

**Update:** download the new release (or `git pull` in a clone) and run its `install.ps1`. What changed in each version is in [CHANGELOG.md](CHANGELOG.md). If only the addon's code changed, `/reload` in game is enough. If there are new folders or sounds, restart the game.

**Uninstall:** `orca-wow uninstall`.

Linux: the original project's `./install.sh` is still here, but this fork hasn't tested it there. For a Mac, see the next section.

## On a Mac (not yet tested with the game)

The bridge and the addon also run on macOS, with the game's native Mac client and Orca on the same Mac. This part comes from the original project and was brought up to date for Orca. On a Mac (macOS 26), the installer, the bridge's link to Orca and the Screen Recording permission have been checked, but not yet with the game running: if you play this way, please report what happened.

You need macOS 11 or newer, **World of Warcraft: Forever** installed from Battle.net, and Orca open on the same Mac.

1. **Install Node.js 22 or newer**, for example with `brew install node`.
2. **Install [Orca](https://github.com/stablyai/orca) and open it.** The bridge finds it by itself: Orca writes where to reach it to `~/Library/Application Support/orca/orca-runtime.json` each time it starts.
3. **Close the game** and run this in Terminal:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/Lutacon/orca-wow/main/install.sh | bash
   ```
   Or run `./install.sh` from a clone. It copies the bridge and the addon to `~/.local/share/orca-wow`, links `orca-wow` into `~/.local/bin`, installs the addon in `_forever_/Interface/AddOns`, and starts the bridge as a launch agent (`~/Library/LaunchAgents/orca-wow.plist`) that starts again each time you log in. If it can't find the game, add `--wow "/Applications/World of Warcraft"` (when piping from curl: `| bash -s -- --wow "/Applications/World of Warcraft"`).
4. **Allow Screen Recording.** The bridge reads the game's pixels, so macOS asks whether `node` may record the screen. Turn it on in **System Settings → Privacy & Security → Screen & System Audio Recording** (Screen Recording before macOS 15). If you missed the prompt, `orca-wow status` says which `node` to turn on. Then restart the bridge:
   ```bash
   launchctl kickstart -k gui/$(id -u)/orca-wow
   ```
   The permission belongs to that copy of Node, so after `brew upgrade node` macOS may ask again. If you run the bridge yourself in Terminal (`orca-wow run`), macOS asks about Terminal instead.
5. **Start the game and log in.** Everything in game works as on Windows.

What's different from Windows:

- The bridge's settings are in `~/.config/orca-wow`, and its log in `~/.local/state/orca-wow/bridge.log`.
- The installer doesn't lock the addon's folders to your account, as it does on Windows. If other people have accounts on this Mac, check that they can't write to the game's AddOns folder.
- The game window must be on screen, in the Space you're in. A minimized game, or one in another Space, can't be read.
- In the copy box, press Cmd+C. Replies are read aloud with macOS's `say`. Dictation isn't available.
- If `~/.local/bin` isn't on your PATH, run the commands as `~/.local/bin/orca-wow`.

## Orca on another computer (for example a MacBook)

The bridge can show the agents of one or more Orcas on other computers on your network (or your Tailscale network), alongside this PC's Orca or instead of it. It uses the same end-to-end encrypted connection as Orca's mobile app.

1. On the Mac, in Orca, go to **Settings → Remote Orca Servers → Advertise this app as a server → New Link**. Under **Connection address**, pick the Mac's local network IP (not `127.0.0.1`) and click **Generate Access Link**. Copy the `orca://pair?code=…` link shown under "Pair another Orca client".
   - Or, in a terminal on the Mac: `orca pair --address <the Mac's IP>`. It has to be a **desktop** link: mobile links (`--mobile`) don't work.
2. On the PC, run this and paste the link when it asks. The link stays hidden while you paste it:
   ```powershell
   & "$env:LOCALAPPDATA\orca-wow\orca-wow.cmd" remote add MacBook
   ```
   Or pipe it in from the clipboard:
   ```powershell
   Get-Clipboard | & "$env:LOCALAPPDATA\orca-wow\orca-wow.cmd" remote add MacBook
   ```
   In Command Prompt, the first one is `%LOCALAPPDATA%\orca-wow\orca-wow.cmd remote add MacBook`. The command checks the connection before saving it, then restarts the bridge.

   Don't put the link on the command line: your shell keeps it in its history file, where anything that can read your files can use it. It still works, but the command warns you and tells you how to remove it from the history.
3. If the Mac's firewall is on, allow Orca to accept incoming connections. By default it uses port 6768.

Encryption: the bridge uses Orca's current encryption (E2EE v2). Older Orca versions only speak an older one, which doesn't stop someone on the network from replaying commands. A new pairing only accepts the older encryption if you add `--allow-legacy` to `remote add`; use it only for an old Orca on a network you trust, and update Orca there when you can. Once a computer has connected with E2EE v2, the bridge never falls back to the older encryption for that pairing.

Other commands:
- `orca-wow remote list` shows the other computers' Orcas and whether they answer.
- `orca-wow remote remove MacBook` removes one from this PC. Its access link keeps working until you revoke it on the other computer: in its Orca, **Settings → Remote Orca Servers → Shared Server Access**.
- `orca-wow local off` stops showing this PC's Orca (`orca-wow local on` shows it again).

In game, each computer's agents carry its name, and you can filter by computer. The secrets from the link (the device token and the Mac's key) are kept separately, in `%LOCALAPPDATA%\orca-wow\config\remotes\`, never in `config.json` or in the logs.

## Using it

In the commands below, `orca-wow` stands for `%LOCALAPPDATA%\orca-wow\orca-wow.cmd`. Add `%LOCALAPPDATA%\orca-wow` to your PATH to type just `orca-wow`.

| In game | |
|---|---|
| `/orca` | open or close the window (or click the minimap button) |
| both triggers + Back | open the window from a controller |
| `/orca new <text>` | start a new agent (options: `--agent codex --name my-branch --base develop`) |
| `/orca selftest` | check the link step by step, with the round-trip time |
| `/orca status` | the state of the bridge and of Orca |

| On the computer | |
|---|---|
| `orca-wow status [--log]` | what the bridge sees (Orca, the game, capture, the addon) |
| `orca-wow probe` | capture the corner of the game window and try to read the strip |
| `orca-wow run --verbose` | run the bridge in the foreground |
| `orca-wow shell on\|off` | let messages from the game that start with `!` reach the agents (off by default) |

## What the game can't do

The game shares one Lua environment with every other addon you run, so the bridge treats what comes from the game with some care:

- **Shell commands.** Claude Code runs a message that starts with `!` as a shell command, without asking. The bridge refuses those from the game. To allow them, run `orca-wow shell on` (it restarts the bridge); `orca-wow shell off` turns it off again. Messages that start with `/` (the agent's own commands, such as `/clear`) are sent as usual.
- **Workspace trust and hooks review.** When an agent asks whether to trust a folder or to approve its hooks, accept at the computer. The game only shows one line of those prompts; you can still answer No from the game.
- **Stale questions.** If the question on the agent's screen changed after the game showed it, an approval or answer from the game is refused and nothing is pressed. The game then shows the current question; answer again.
- **Prompts without a yes.** When the bridge can't find a numbered menu with a row that says yes (some agents draw their own prompts), or the agent wants you to sign in or pick a model, the game says to answer at the computer and only offers No.
- **Text from the game.** Control characters are removed before a message is typed, and the `!` rule applies to every line.
- **Other addons.** This addon has no global variable that other addons can call, but that only stops casual use: every addon runs in the same Lua environment, and a malicious one could read the link's keys. It could then do what you can from the game, within the limits above. Only install addons you trust.

## How it works

A WoW addon can't use the network or read files. The bridge connects them like this:

- **Game to bridge:** the addon draws an encrypted strip of colored cells in the top-left corner. A native helper (`bridge/native/wowhelper.cs`) copies it from the screen in about 16 ms. If another window covers it, the helper uses `PrintWindow`.
- **Bridge to game:** the bridge writes the data into *LoadOnDemand* addons (`OrcaWow_S###`), and the addon loads the next one when a silent sound file "plays".
- **Bridge to Orca:** it uses Orca's local named pipe (`%APPDATA%\orca\orca-runtime.json` gives the path and the token). It polls `worktree.ps` every 2 to 6 seconds, reads terminals with `terminal.read` and writes to them with `terminal.send`, as Orca's CLI and mobile app do. Orcas on other computers are reached over Orca's encrypted WebSocket, with the same requests.

The details of the link with the game are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Limitations

- The game window has to be on screen (not minimized) for the bridge to read the strip.
- There are 1200 updates per UI session. When they run out, type `/reload`.
- Messages are limited to about 2000 characters. The history is cut down to the last prompt, the last reply and the end of the terminal.
- Questions and permission menus are read from the agent's terminal screen. Agents in Orca's chat mode are read-only.
- "Mark as done", "Reopen" and "Sleep" apply to the whole worktree.
- Voice dictation isn't available on Windows yet.

## Contributing

Bug reports, ideas and pull requests are welcome: [CONTRIBUTING.md](CONTRIBUTING.md) says what to include and how to test a change. Report security problems privately, through [GitHub's security advisories](https://github.com/Lutacon/orca-wow/security/advisories/new), not in a public issue.

## Credits

- [ryanrhughes/t3code-wow](https://github.com/ryanrhughes/t3code-wow) (MIT, © 2026 Ryan Hughes): the addon, the strip link, slots and bells, and the bridge this fork starts from.
- [DSilence/t3wow](https://github.com/DSilence/t3wow): reference for Windows.
- The icons use the [Orca](https://github.com/stablyai/orca) logo (MIT, `resources/logo.svg`). `tools/make-icons.mjs` generates the icons from it.
- [wow-ai](https://github.com/chelinho139/wow-ai) and [wow-forever-codex](https://github.com/0xinuarashi/wow-forever-codex), whose measurements of the Forever client the strip and slot technique rests on.

## License

[MIT](LICENSE). A fan project, not affiliated with Blizzard Entertainment or Stably (Orca). World of Warcraft is a trademark of Blizzard Entertainment. Orca's name and logo belong to Stably and are used here only to identify the integration.
