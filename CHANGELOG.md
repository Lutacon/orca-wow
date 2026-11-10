# Changelog

## Unreleased

- Copy text: the copy button in the bottom bar copies the agent's latest reply, and each message has its own next to its time. The game doesn't let addons use the clipboard, so it opens the text already selected in a box: press Ctrl+C.
- Drag the window's bottom-right corner to make it bigger; right-click the corner for the default size. The size is remembered. The Settings option that made the whole window larger is now called "Window scale".

## 0.4.1

- The addon says once per session, and `/orca selftest` shows, when the bridge on your computer is a different version, with where to get the matching one.
- When an addon manager (the CurseForge app, WowUp) replaces the OrcaWow folder to update it, the bridge locks the new folder again and puts the update bells back, instead of stopping until you reinstall.
- The addon is on CurseForge too, as Orca Agents. The bridge still comes from the GitHub release.

## 0.4.0

The first release of this fork. It starts from [ryanrhughes/t3code-wow](https://github.com/ryanrhughes/t3code-wow) 0.3.0, which showed T3 Code threads on Linux and macOS, and turns it into an addon for Orca on Windows.

### Orca

- See your Orca agents in game, grouped by state, with each one's last prompt, last reply and the end of its terminal.
- Message an agent, stop it, and answer its permission prompts and multiple-choice questions. Yes and the agent's own "don't ask again" row are shown word for word.
- Start a new worktree with the agent, worktree name and base branch you pick. Mark a worktree done or put it to sleep.
- Orcas on other computers (a MacBook, say) through an Orca access link, over Orca's end-to-end encrypted connection, alongside or instead of this PC's Orca. `orca-wow remote add`, `remote list`, `remote remove` and `local on|off`.
- The T3 Code backend, its model picker and its usage meters are gone.

### Windows

- `install.ps1` installs the bridge and the addon and registers the bridge as a hidden task that starts when you sign in.
- A small capture helper, built with the C# compiler that ships with Windows, reads the game's corner even when another window covers it.
- The addon's folders in the game are locked to your Windows account, and the bridge refuses to start if another account changed them.

### Safety

- Approvals and answers are bound to the menu the player saw; nothing is pressed if it changed.
- Workspace-trust and hooks-review prompts can only be declined from the game.
- Messages from the game that start with `!` (shell commands) are refused unless you run `orca-wow shell on`.
- Remote Orcas that have used Orca's current encryption never fall back to the older one.

### Look

- Orca's logo for the minimap button, the window and the addon list. The 1200 data slots carry it too, with a title that says to leave them enabled.

Tested on one Windows 11 PC with an Orca on a MacBook. Not tested yet: Linux and macOS (they come from the original project), controller navigation, and answering approvals in game for every agent Orca runs. Reports are welcome.
