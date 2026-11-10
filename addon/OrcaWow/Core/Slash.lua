-- Slash commands, key bindings and the addon compartment entry.

local _, ns = ...

BINDING_HEADER_ORCAWOW = "Orca"
BINDING_NAME_ORCAWOW_TOGGLE = "Open or close Orca"
BINDING_NAME_ORCAWOW_NEW = "Start a new agent"
BINDING_NAME_ORCAWOW_TALK = "Push to talk (dictation)"
BINDING_NAME_ORCAWOW_READ = "Read the latest reply aloud"
BINDING_NAME_ORCAWOW_HUSH = "Stop reading aloud"

function OrcaWow_Binding(action, keystate)
	if action == "toggle" then
		ns.Launcher:Open()
	elseif action == "new" then
		ns.Main:StartNewThread()
	elseif action == "talk" then
		if keystate == "down" and not ns.Main.dictating then
			ns.Main:ToggleDictation()
		elseif keystate == "up" and ns.Main.dictating then
			ns.Main:ToggleDictation()
		end
	elseif action == "read" then
		local id = ns.viewId
		if not id then
			local active = ns.Store.data.threads[1]
			id = active and active.id
		end
		local t = ns.Store:Thread(id)
		if id then ns.Speak(t and (t.last or t.title) or "", id, "last") end
	elseif action == "hush" then
		ns.Hush()
	end
end

function OrcaWow_OnAddonCompartmentClick(_, button)
	if button == "RightButton" then
		ns.Main:Open()
		ns.Main:ShowPage("settings")
	else
		ns.Main:Toggle()
	end
end

function OrcaWow_OnAddonCompartmentEnter(_, menuButtonFrame)
	GameTooltip:SetOwner(menuButtonFrame, "ANCHOR_LEFT")
	GameTooltip:SetText("Orca", 1, 0.82, 0)
	local active = ns.Store:Active()
	GameTooltip:AddLine(#active > 0 and (#active .. " active agent" .. (#active == 1 and "" or "s")) or "Nothing running", 1, 1, 1)
	GameTooltip:AddLine("Click to open, right-click for settings", 0.6, 0.6, 0.6)
	GameTooltip:Show()
end

function OrcaWow_OnAddonCompartmentLeave()
	GameTooltip:Hide()
end

-- Step-by-step check of everything between the game and Orca.
function ns.SelfTest()
	local T = ns.Transport
	local b = ns.Store.data.bridge or {}
	-- The game font has no check/cross characters; use the game's own icons.
	local ok, bad = CreateAtlasMarkup("common-icon-checkmark", 14, 14), CreateAtlasMarkup("common-icon-redx", 14, 14)
	local function line(pass, text, fix)
		ns.Print((pass and ok or bad) .. " " .. text .. ((not pass and fix) and ns.Color("grey", " — " .. fix) or ""))
	end
	ns.Print(ns.Color("gold", "Self-test"))
	line(T.slotCount > 0, string.format("live-update files: %d found", T.slotCount), "run orca-wow install, then fully restart the game")
	T:SelfTest(function(result)
		line(result == "ok", "update bells: " .. result .. (result == "ok" and (" (" .. tostring(T.channel) .. " channel)") or ""),
			"turn game sound on; the addon falls back to slower polling until then")
	end)
	local age = T.bridgeNow and (time() - T.bridgeNow) or nil
	line(age ~= nil and age < 300, "bridge: " .. (b.version and ("orca-wow " .. b.version) or "not heard from") .. (age and string.format(", last update %ds ago", age) or ""),
		"check `orca-wow status` on your desktop")
	if b.version then
		line(b.version == ns.version or ns.version == "dev", string.format("versions: addon %s, bridge %s", ns.version, b.version),
			"install the matching release from " .. ns.RELEASES)
	end
	line(b.orca == "connected", "Orca on this computer: " .. tostring(b.orca), b.err or "open Orca on your computer")
	for _, e in ipairs(b.envs or {}) do
		if not e["local"] then line(e.state == "connected", "Orca on " .. e.label .. ": " .. tostring(e.state), "check that machine is on and reachable") end
	end
	line(T:SlotsLeft() > 40, string.format("live updates left: %d of %d", T:SlotsLeft(), T.slotCount), "/reload to free a fresh set")
	local errs = ns.db.errors or {}
	line(#errs == 0, string.format("addon errors recorded: %d", #errs), "/orca errors to see them")
	-- Round trip: show the strip and time the bridge's acknowledgement.
	T:Touch()
	local seq, started = T.stripSeq, GetTime()
	local ticker
	ticker = C_Timer.NewTicker(0.1, function()
		local elapsed = GetTime() - started
		if T.ackedSeq >= seq then
			ticker:Cancel()
			line(true, string.format("round trip to the bridge: %.1fs", elapsed))
		elseif elapsed > 8 then
			ticker:Cancel()
			line(false, "round trip to the bridge: no answer in 8s",
				"is the game window visible on screen? `orca-wow status --log` shows what the bridge sees")
		end
	end)
end

local function Status()
	local T = ns.Transport
	local b = ns.Store.data.bridge or {}
	ns.Print(string.format("link %s · Orca %s · %d agents · live updates left %d/%d · signals %s · queued %d",
		T:BridgeState(), b.orca or "?", #ns.Store.data.threads, T:SlotsLeft(), T.slotCount, T.signals .. " (" .. tostring(T.channel) .. ", " .. tostring(T.selfTests or 0) .. " tests)", #T.queue))
end

-- "--agent codex --name x --base develop the task" -> { agent, name, base }, "the
-- task". Flags come first; "--flag=value" works too, and "--" ends them.
local NEW_FLAGS = { agent = "agent", name = "name", base = "base", branch = "base" }

local function ParseNewFlags(rest)
	local opts = {}
	rest = rest or ""
	while true do
		local flag, after = rest:match("^%-%-(%S*)%s*(.-)$")
		if not flag then break end
		if flag == "" then
			rest = after
			break
		end
		local key, value = flag:match("^([^=]+)=(.*)$")
		if key then
			rest = after
		else
			key = flag
			value, rest = after:match("^(%S*)%s*(.-)$")
		end
		key = NEW_FLAGS[key:lower()]
		if not key then return nil, nil, "Unknown option --" .. flag .. "." end
		if not value or value == "" then return nil, nil, "--" .. flag .. " needs a value." end
		opts[key] = value
	end
	return opts, rest
end

SLASH_ORCAWOW1 = "/orca"
SLASH_ORCAWOW2 = "/orcawow"
SlashCmdList.ORCAWOW = function(msg)
	msg = strtrim(msg or "")
	local cmd, rest = msg:match("^(%S*)%s*(.-)$")
	cmd = (cmd or ""):lower()
	if cmd == "" then
		ns.Main:Toggle()
	elseif cmd == "new" then
		local opts, text, err = ParseNewFlags(rest)
		if err then
			ns.Print(ns.Color("red", err))
			ns.Print("/orca new [--agent <id>] [--name <worktree>] [--base <branch>] [text]")
			return
		end
		local agents = ns.Store:AgentOptions()
		if (opts.agent or opts.name or opts.base) and not agents then
			ns.Print("This bridge doesn't offer a choice of agent, worktree name or base branch yet. Update orca-wow.")
			return
		end
		if opts.agent then
			local wanted = opts.agent:lower()
			local found
			for _, o in ipairs(agents) do
				if o.value:lower() == wanted or o.label:lower() == wanted then found = o.value end
			end
			if not found then
				local ids = {}
				for _, o in ipairs(agents) do table.insert(ids, o.value) end
				ns.Print(ns.Color("red", "Orca has no agent called \"" .. opts.agent .. "\".") .. " Pick one of: " .. table.concat(ids, ", "))
				return
			end
			opts.agent = found
		end
		ns.Main:StartNewThread()
		if agents then
			-- A plain /orca new gets the remembered agent, an automatic name and the
			-- default branch, whatever was left in the boxes before.
			ns.Main.newAgent = opts.agent
			local o = ns.Main:NewOptionsFrame()
			o.Name:SetText(opts.name or "")
			o.Branch:SetText(opts.base or "")
			ns.Main:Refresh()
		end
		if text ~= "" then ns.Main.composer:SetText(text) end
	elseif cmd == "settings" or cmd == "options" then
		ns.Main:Open()
		ns.Main:ShowPage("settings")
	elseif cmd == "status" then
		Status()
	elseif cmd == "tracker" then
		ns.db.settings.tracker = not ns.db.settings.tracker
		ns.Tracker:Refresh()
		ns.Print("Tracker " .. (ns.db.settings.tracker and "shown" or "hidden"))
	elseif cmd == "unlock" or cmd == "lock" then
		ns.db.settings.trackerLocked = cmd == "lock"
		ns.Print("Tracker " .. (cmd == "lock" and "locked" or "unlocked — drag its header to move it"))
	elseif cmd == "say" and rest ~= "" then
		ns.Speak(rest)
	elseif cmd == "hush" then
		ns.Hush()
	elseif cmd == "selftest" or cmd == "test" then
		ns.SelfTest()
	elseif cmd == "report" then
		ns.Main:ShowPage("threads")
		ns.Main:Report(rest)
	elseif cmd == "shot" or cmd == "screenshot" then
		ns.Main:Open()
		ns.Main:AttachScreenshot()
	elseif cmd == "errors" then
		local list = ns.db.errors or {}
		if rest == "clear" then
			ns.db.errors = {}
			ns.errors = {}
			ns.Print("Cleared.")
		elseif #list == 0 then
			ns.Print("No errors recorded.")
		else
			for i = math.max(1, #list - 4), #list do
				local e = list[i]
				ns.Print(ns.Color("grey", date("%H:%M:%S", e.t)) .. " " .. ns.Color("red", e.msg))
			end
			ns.Print(ns.Color("grey", "(/orca errors clear to reset. They're also saved with the addon's data on /reload.)"))
		end
	else
		ns.Print("/orca — open the window")
		ns.Print("/orca new [text] — start a new agent")
		if ns.Store:AgentOptions() then
			ns.Print("/orca new --agent codex --name <worktree> --base <branch> [text] — the same, with those filled in")
		end
		ns.Print("/orca report [what went wrong] — diagnostics + screenshot into the message box")
		ns.Print("/orca shot — attach a screenshot to your next message")
		ns.Print("/orca selftest | settings | status | tracker | unlock | lock | hush | errors")
	end
end
