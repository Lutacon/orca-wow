-- A hand-made slot snapshot for the headless tests, for when no backend is running
-- to build a real one with tools/snapshot.mjs:
--   luajit tools/smoke.lua addon/OrcaWow tools/fixture_snapshot.lua
-- It has what tools/smoke.lua drives: two providers with reasoning levels, a thread
-- per group, an open view, usage and link keys. No `bridge.backend`, like an older
-- bridge: the addon treats that as T3 Code.
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
		t3 = "connected",
		server = "fixture",
		host = "desktop",
		tts = "spd-say",
		dictation = "test backend",
		slots = 600,
	},
	projects = {
		{ id = "p1", name = "wow-addon", act = true, dm = "codex\tgpt-5", de = "medium" },
		{ id = "p2", name = "website", act = true },
	},
	threads = {
		{ id = "t1", title = "Fix the tracker", p = "p1", s = "open", l = "Finished", u = now - 120, st = now - 400, mi = "codex", m = "gpt-5", re = "medium", br = "fix/tracker", last = "Done: the tracker follows quests." },
		{ id = "t2", title = "Write the docs", p = "p2", s = "working", l = "Editing README.md", st = now - 60, mi = "claude", m = "opus", re = "high" },
		{ id = "t3", title = "Old cleanup", p = "p1", s = "settled", l = "Settled", u = now - 86400, mi = "codex", m = "gpt-5" },
	},
	view = {
		id = "t1",
		msgs = {
			{ r = "u", t = "Fix the tracker, please.", at = now - 400, n = 1 },
			{ r = "a", t = "Done: the tracker follows quests.", at = now - 120, n = 2 },
		},
	},
	usage = {
		{ name = "Codex", plan = "Pro", windows = { { label = "Weekly", used = 18, resets = now + 3 * 86400 } } },
	},
	models = {
		h = "fx000001",
		g = {
			{
				e = "",
				x = { { k = "effort", d = "medium", o = { { i = "low", l = "Low" }, { i = "medium", l = "Medium" }, { i = "high", l = "High" } } } },
				p = {
					{ i = "codex", n = "Codex", m = { { s = "gpt-5", l = "GPT-5", r = 1 }, { s = "gpt-5-mini", l = "GPT-5 mini", r = 1 } } },
					{ i = "claude", n = "Claude", m = { { s = "opus", l = "Opus", r = 1 }, { s = "sonnet", l = "Sonnet" } } },
				},
			},
		},
	},
	results = {},
}
