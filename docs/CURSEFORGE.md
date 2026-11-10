# Publishing on CurseForge

CurseForge hosts the addon only: the `OrcaWow` folder. The bridge, which the addon needs to do anything, comes from the GitHub release, and its installer puts the same addon in the game. CurseForge is there so people can find the addon and keep it up to date with the CurseForge app.

What keeps the two in step:

- Every release uploads the addon to CurseForge from the same tag as the GitHub zip (`.github/workflows/release.yml`), so the two versions match.
- The addon says in chat, once per session, when the bridge is a different version, and where to get the matching one. `/orca selftest` shows both versions.
- The CurseForge app replaces the `OrcaWow` folder when it updates the addon, which also removes the update bells in `OrcaWow\Signals`. The bridge notices, checks that the new folder is this account's, locks it again and puts the bells back.

## One-time setup

1. **Create the project** at [authors.curseforge.com](https://authors.curseforge.com) → Create a Project → World of Warcraft → Addon.
   - **Name:** CurseForge doesn't allow the game's name in a project name, so not "Orca for World of Warcraft". For example: Orca Agents.
   - **Summary:** See and control your Orca coding agents from inside the game.
   - **Category:** whichever of CurseForge's comes closest (Miscellaneous if none does).
   - **License:** MIT. **Source:** https://github.com/Lutacon/orca-wow
   - **Logo:** [media/curseforge-logo.png](media/curseforge-logo.png), a terminal prompt drawn for this project. CurseForge doesn't accept trademarked images there, so not Orca's logo (the name and logo belong to Stably).
   - **Description:** the text below.
2. **Wait for approval.** CurseForge reviews new projects before they're listed.
3. **Make an API token** in your CurseForge account settings (API tokens).
4. **Give it to GitHub.** In a terminal, with the project's numeric ID from its page (not its URL name):
   ```bash
   gh secret set CF_API_KEY --repo Lutacon/orca-wow
   ```
   ```bash
   gh variable set CF_PROJECT_ID --repo Lutacon/orca-wow --body 123456
   ```
   The first command asks for the token, so it never ends up in your shell history.
5. **Release.** The next tag uploads the addon to CurseForge after the GitHub release. The file is marked for game version 1.60.1 (WoW: Forever), worked out from `## Interface: 16001` in the TOC.

## Description for the project page

> **Orca Agents** shows the coding agents running in [Orca](https://github.com/stablyai/orca) (Claude Code, Codex and others, each in its own git worktree) inside World of Warcraft: Forever, and lets you answer them without leaving the game.
>
> - See every agent: working, waiting for you, or done, with its last prompt, last reply and the end of its terminal.
> - Send messages, stop an agent, approve or decline its permission prompts and answer its questions.
> - Start a new worktree with the agent, name and branch you choose.
> - Notices, sounds and a tracker section when an agent finishes or needs you. Controller support.
> - Orcas on other computers on your network too, such as a MacBook.
>
> **This addon needs the orca-wow bridge on your computer.** An addon can't use the network, so a small program reads an encrypted strip of pixels the addon draws and writes updates back through load-on-demand files. Install it with the release from GitHub, which also installs this addon: https://github.com/Lutacon/orca-wow. It runs on Windows 10 and 11 and needs Node.js 22 or newer.
>
> Under Orca in your addon list you'll see 1200 "Orca data slot" entries. They carry the updates; leave them enabled.
>
> Experimental: Orca's internal APIs can change between versions. Not affiliated with Blizzard Entertainment or Stably (Orca).
