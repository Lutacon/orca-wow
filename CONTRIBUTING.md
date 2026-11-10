# Contributing

Contributions are welcome. This is an early, experimental release, so bug reports from real use are just as valuable as code.

This repository is [Lutacon/orca-wow](https://github.com/Lutacon/orca-wow), a fork of [ryanrhughes/t3code-wow](https://github.com/ryanrhughes/t3code-wow) by Ryan Hughes, which built the addon, the strip link, the slots and bells, and the bridge this fork starts from. The fork adds Windows and connects the addon to Orca.

The tested setup is **Windows 10 or 11**, **Orca** (on the same PC, or on another computer through an access link) and **World of Warcraft: Forever** from Battle.net. Linux (Omarchy, CachyOS with KDE Plasma, the game under Proton) and macOS come from upstream and are kept, but aren't tested here. Changes that make other setups work are welcome, as long as they don't break Windows.

## Issues

Open an issue for a bug you can reproduce, or for a specific idea. Keep it detailed but straightforward: say what happened, plainly, and leave out the essay.

For a bug, include:

- **Versions**: Windows (`winver`), Orca (its About screen; on every computer involved), orca-wow (`orca-wow status`), and your controller if it's involved. On Linux or macOS, the OS version (`omarchy-version`, `sw_vers`).
- **What you did, what you expected, what happened instead.** Steps to reproduce if you have them.
- **`orca-wow status --log`** output, and the text from `/orca report` in game. Check it for paths and machine names you'd rather not share.
- **A screenshot or short video** for anything you can see: a layout problem, a wrong state, a notice that didn't appear. It's often the fastest way to explain the problem.

One problem per issue. If you're not sure it's a bug, say so and describe what you saw.

## Pull requests

- **One problem per PR.** Small, focused changes get reviewed and merged faster.
- **Say what changes and why**, in plain terms. Link the issue if there is one.
- **Say how you verified it**: the tests you ran and what you checked in game, with what you saw. Mention anything you couldn't check. "Tests pass" alone isn't enough.
- **Show UI changes.** Anything you can see in game needs before and after screenshots, and a short recording when motion, timing, controller navigation or interaction is part of the change. Drag them into the PR description so GitHub hosts them; never commit screenshots or recordings to the repo. If nothing visible changes, one line saying why is enough.
- **Add a line to [CHANGELOG.md](CHANGELOG.md)** under `## Unreleased` (create it at the top if it isn't there) for anything a player or user would notice, written for them. Internal changes don't need one.
- **The tests run on every PR** (`.github/workflows/tests.yml`): the bridge on Windows, the addon's Lua on Linux. Run them locally first (see below); a red check needs fixing before review.
- **Commits** should be atomic, with short messages that describe the change.
- AI-assisted contributions are fine. You're responsible for having read, run and checked the result, the same as any other change.

## Development

On Windows, in PowerShell, with the game closed:

```powershell
git clone https://github.com/Lutacon/orca-wow
cd orca-wow
powershell -ExecutionPolicy Bypass -File .\install.ps1   # installs the addon and the bridge from your checkout
```

On Linux or macOS, run `./install.sh` from the checkout instead.

After editing, run the installer from your checkout again, then `/reload` in game. It copies your checkout over the installed copy (`%LOCALAPPDATA%\orca-wow\app` on Windows), puts the addon into the game and restarts the bridge. (`orca-wow sync` only re-copies the *installed* addon, so it won't pick up your edits.) New files inside the addon load on `/reload`; new addon folders (such as live-update slots) need a full game restart. Don't link (junction) the game's `OrcaWow` folder to your checkout instead: on Windows the bridge refuses to start when it finds a link among OrcaWow's folders in the game. Run `install.ps1` from the checkout after each change.

Tests, from the repository folder:

```powershell
cd bridge; node --test; cd ..                                   # bridge, protocol, crypto, Lua/Node agreement
luajit tools/smoke.lua addon/OrcaWow tools/fixture_snapshot.lua  # drive the addon headlessly
lua5.1 tools/smoke.lua addon/OrcaWow tools/fixture_snapshot.lua  # same, with unsigned bit ops like WoW (where Lua 5.1 is installed)
```

The bridge tests need `lua5.1` or `luajit` on PATH for the Lua/Node agreement checks, and use whichever they find. On Windows, LuaJIT is the practical one (any build on PATH); on macOS, `brew install luajit`. Homebrew doesn't package Lua 5.1, so the `lua5.1` runs need it built from source.

To drive the addon with your own agents instead of the fixture, `node tools/snapshot.mjs <out.lua>` writes a snapshot from your running Orca, and a `.view` file next to it naming the thread it shows; pass the snapshot to `tools/smoke.lua`, with the contents of the `.view` file as a third argument.

`tools/wowstub.lua` stands in for the WoW API. Its widget methods come from the client's own API documentation, so calling a method that doesn't exist fails in tests the way it would in game.

Before changing how the addon and bridge talk, read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [AGENTS.md](AGENTS.md): several things that look like workarounds are deliberate, measured limits of the game client, and AGENTS.md lists the security rules a change must keep.

## Style

- Lua: tabs. JavaScript: two spaces, ES modules, no dependencies beyond Node itself (`bridge/vendor/tweetnacl` is vendored, not installed).
- Text people see (in game, in the CLI, in docs) is plain and specific: say what happened and what to do, without jargon.

## Security

If you find a security problem, such as a way to send commands to someone's agents or read what they're sending, please report it privately through [GitHub's security advisories](https://github.com/Lutacon/orca-wow/security/advisories/new) rather than a public issue. If it also affects upstream's code, say so; upstream is [ryanrhughes/t3code-wow](https://github.com/ryanrhughes/t3code-wow).
