-- A hand-made slot snapshot for the headless tests, for when Orca isn't running to
-- build a real one with tools/snapshot.mjs:
--   luajit tools/smoke.lua addon/OrcaWow tools/fixture_snapshot.lua
-- It has what tools/smoke.lua drives: an agent per group, an open view, the agents a
-- new worktree can start with, and link keys.
local now = os.time()
OrcaWow_Inbox = {
	v = 1,
	gen = now * 1000,
	now = now,
	nextSig = 2,
	ack = { ui = "fixture", seq = 1 },
	key = string.rep("0123456789abcdef", 8),
	bridge = {
		version = "0.3.0",
		orca = "connected",
		host = "desktop",
		tts = "spd-say",
		dictation = "test backend",
		slots = 600,
	},
	projects = {
		{ id = "p1", name = "wow-addon", act = true },
		{ id = "p2", name = "website", act = true },
	},
	threads = {
		{ id = "t1", title = "Fix the tracker", p = "p1", s = "open", l = "Finished", u = now - 120, st = now - 400, br = "fix/tracker", last = "Done: the tracker follows quests." },
		{ id = "t2", title = "Write the docs", p = "p2", s = "working", l = "Editing README.md", st = now - 60 },
		{ id = "t9", title = "Old cleanup", p = "p1", s = "settled", l = "Done", u = now - 86400 },
	},
	view = {
		id = "t1",
		msgs = {
			{ r = "u", t = "Fix the tracker, please.", at = now - 400, n = 1 },
			{ r = "a", t = "Done: the tracker follows quests.", at = now - 120, n = 2 },
		},
	},
	agents = { d = "claude", o = { { i = "claude", l = "Claude" }, { i = "codex", l = "Codex" }, { i = "gemini", l = "Gemini" } } },
	results = {},
}
