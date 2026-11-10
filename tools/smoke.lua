-- Headless smoke test: load the addon against tools/wowstub.lua and drive it.
--   lua5.1 tools/smoke.lua <addon dir> <snapshot.lua> [viewId]
local addonDir, snapshot, viewId = arg[1], arg[2], arg[3]
package.path = "./tools/?.lua;" .. package.path
local Stub = dofile("tools/wowstub.lua")
Stub.slotData.default = snapshot

local ns = {}
local function check(cond, msg)
	if not cond then for _, e in ipairs(ns.errors or {}) do print("RECORDED ERROR: " .. e.msg) end error("CHECK FAILED: " .. msg, 2) end
	print("ok - " .. msg)
end

-- Load files in TOC order.
for line in io.lines(addonDir .. "/OrcaWow.toc") do
	line = line:gsub("\r", "")
	if line ~= "" and not line:match("^#") and line:match("%.lua$") then
		local path = addonDir .. "/" .. line:gsub("\\", "/")
		local chunk = assert(loadfile(path))
		chunk("OrcaWow", ns)
	end
end
-- Other addons must not reach ns (ns.Transport:Send would let them type into agents).
check(OrcaWow == nil and _G.ns == nil, "namespace not exported")

Stub.Fire("ADDON_LOADED", "OrcaWow")
check(ns.db and ns.db.session and #ns.db.session == 8, "saved variables initialised")
Stub.Fire("PLAYER_LOGIN")
check(ns.Transport.slotCount == 600, "found 600 slots by binary search")
check(ns.Store.applied == 1, "bootstrap slot applied")
check(#ns.Store.data.threads > 0, "threads loaded: " .. #ns.Store.data.threads)
check(ns.Transport.stripShown, "hello strip shown")
check(ns.Transport:Encrypted(), "link keys loaded from the bootstrap slot")
check(OrcaWow_Inbox == nil, "slot global cleared after loading")
check(ns.Transport:BridgeState() == "connected", "bridge.orca = connected reads as connected: " .. ns.Transport:BridgeState())
do
	local drawn = WOWSTUB.StripCells()
	-- Header byte 3 (version) spans cells 6..8: bits 16..23 of the frame.
	local bits = {}
	for i = 1, 9 do local v = drawn[i] bits[#bits + 1] = math.floor(v / 4) % 2 bits[#bits + 1] = math.floor(v / 2) % 2 bits[#bits + 1] = v % 2 end
	local version = 0
	for i = 17, 24 do version = version * 2 + bits[i] end
	check(version == 2, "strip is drawn encrypted (frame version 2)")
end
local payload = ns.Transport:Payload()
check(payload:sub(1, 2) == "H\031", "payload starts with hello record")
do
	-- H proto session ui slot sig gen flags view version slots: "H" and 10 fields,
	-- with no model-list hash after the slot count.
	local hello = payload:match("^([^\030]*)")
	local fields = {}
	for f in (hello .. "\031"):gmatch("([^\031]*)\031") do fields[#fields + 1] = f end
	check(#fields == 11 and fields[11] == tostring(ns.Transport.slotCount), "hello ends with the slot count, no models field: " .. #fields .. " fields")
end

-- Strip encodes within capacity and the cells are valid.
local cells = ns.Codec.Encode(ns.Transport.stripSeq, payload)
check(#cells > 0, "strip cells: " .. #cells)

-- Simulate the bridge acknowledging the hello via the next slot.
Stub.validSounds = {}
ns.Transport.signals = "ok"
local sig = ns.db.sigNext
-- Patch the snapshot's ack to this UI session.
local chunk = assert(loadfile(snapshot))
chunk()
local data = OrcaWow_Inbox
OrcaWow_Inbox = nil
data.ack = { ui = ns.ui, seq = ns.Transport.stripSeq }
data.gen = data.gen + 1
data.nextSig = sig + 1
ns.Transport:Apply(data)
check(not ns.Transport.stripShown, "strip hidden after ack")

-- Open the window, select a thread, render.
ns.Main:Open()
check(ns.windowOpen, "window open")
check(ns.Transport.stripShown, "window open bumps the strip")
local firstThread = ns.Store.data.threads[1]
ns.Main:SelectThread(viewId ~= "" and viewId or firstThread.id)
check(ns.viewId ~= nil, "thread selected")
ns.Store:Apply(data) -- view arrives
local rows = ns.Transcript.scrollBox._rows or {}
check(#rows > 0, "transcript rendered " .. #rows .. " elements")
local listRows = ns.ThreadList.scrollBox._rows or {}
check(#listRows > 0, "thread list rendered " .. #listRows .. " rows")

-- Send a message: queued, echoed, and present in the strip payload.
ns.Main.composer._text = "Please run the tests"
ns.Main:Send()
check(#ns.Transport.queue >= 1, "command queued")
check(ns.Transport:Payload():find("Please run the tests", 1, true) ~= nil, "message in strip payload")
check(ns.Transport.queue[#ns.Transport.queue].args[3] == "steer", "follow-ups ask to steer by default")
ns.db.settings.steerFollowUps = false
ns.Main:Send("And the linter")
check(ns.Transport.queue[#ns.Transport.queue].args[3] == nil, "with steering off, a follow-up names no mode, so the bridge queues it")
ns.db.settings.steerFollowUps = true
check(ns.Transcript.echo[ns.viewId] ~= nil, "local echo shown")

-- Pages
ns.Main:ShowPage("settings")
ns.Main:ShowPage("threads")
check(true, "pages switch")
check(#ns.Main.frame.Tabs == 2 and ns.Main.frame.Tabs[1].tooltipText == "Agents", "two side tabs: Agents and Settings")
ns.Main:ShowPage("usage")
check(ns.Main.page == "threads", "there is no Usage page")

-- New agent flow
ns.Main:StartNewThread()
check(ns.Main.mode == "new" and ns.Main.newProject ~= nil, "new agent mode with project " .. tostring(ns.Main.newProject))
local hdr = ns.Main.frame.Pages.threads.Right.Header
check(hdr.Model == nil and hdr.Effort == nil, "no model or reasoning picker")
ns.Main.composer._text = "Build a thing"
ns.Main:Send()
check(ns.Transport:Payload():find("\031new\031", 1, true) ~= nil, "new-agent command in payload")
check(ns.Transport:Payload():find("\031new\031" .. ns.Store.data.projects[1].id .. "\031Build a thing\031claude", 1, true) ~= nil, "new carries the project, the text and the bridge's default agent")
ns.Transport:Apply({ gen = data.gen + 2, results = { { id = ns.Main.pendingNew, ok = true, open = firstThread.id } }, threads = data.threads, projects = data.projects, bridge = data.bridge, agents = data.agents, ack = { ui = ns.ui, seq = ns.Transport.stripSeq } })
check(ns.Main.mode == "thread" and ns.viewId == firstThread.id, "result opened the new agent")
check(#ns.Transport.queue == 0, "all commands acknowledged")
check(hdr.Action:GetText() == "Mark done", "an open agent offers Mark done: " .. hdr.Action:GetText())

-- Question / approval rendering
data.gen = data.gen + 10
data.view = data.view or { id = ns.viewId }
data.view.id = ns.viewId
data.view.pending = { id = "req1", kind = "question", questions = { { id = "q1", h = "Mode", q = "Which mode?", opts = { { l = "Fast", d = "quick", v = "fast" }, { l = "Careful", d = "slow", v = "careful" } } } } }
ns.Transport:Apply(data)
local optionRows = 0
for _, r in ipairs(ns.Transcript.scrollBox._rows) do if r.ed.kind == "option" then optionRows = optionRows + 1 end end
check(optionRows >= 2, "question options rendered: " .. optionRows)
for _, r in ipairs(ns.Transcript.scrollBox._rows) do
	if r.ed.kind == "option" and r.ed.label == "Fast" then r.frame:Click() break end
end
check(ns.Transport:Payload():find("answer\031" .. ns.viewId .. "\031req1\031q1\031fast", 1, true) ~= nil, "answer command queued")

-- Dictation result from the bridge lands in the message box
ns.Main.composer._text = "Hello"
data.gen = data.gen + 1
data.dict = { n = os.time() * 1000, state = "done", text = "run the tests" }
ns.Transport:Apply(data)
check(ns.Main.composer._text == "Hello run the tests", "dictated text typed into the box: " .. tostring(ns.Main.composer._text))
data.gen = data.gen + 1
ns.Transport:Apply(data)
check(ns.Main.composer._text == "Hello run the tests", "same dictation not typed twice")
ns.Main.composer._text = "already pasted words"
data.gen = data.gen + 1
data.dict = { n = os.time() * 1000 + 5, state = "done", text = "pasted words" }
ns.Transport:Apply(data)
check(ns.Main.composer._text == "already pasted words", "text the backend already pasted isn't added again")
ns.Main.composer._text = ""

-- An addon manager updated the addon but not the bridge: say so once, with the fix.
Stub.printed = {}
local sameVersion = data.bridge.version
data.bridge.version = "0.0.1"
data.gen = data.gen + 1
ns.Transport:Apply(data)
check(Stub.printed[1] and Stub.printed[1]:find("bridge on your computer is 0.0.1", 1, true) and Stub.printed[1]:find("releases", 1, true), "a bridge of another version is pointed out: " .. tostring(Stub.printed[1]))
data.gen = data.gen + 1
ns.Transport:Apply(data)
check(#Stub.printed == 1, "the version note isn't repeated")
data.bridge.version = sameVersion

-- A desktop with no dictation backend (macOS today): the mic says why and sends nothing.
data.bridge.dictation = nil
data.bridge.dictationHint = "Dictation isn't available on macOS yet."
data.gen = data.gen + 1
ns.Transport:Apply(data)
Stub.printed = {}
local queued = #ns.Transport.queue
ns.Main.dictating = false
ns.Main.dictNoteAt = nil
ns.Main:ToggleDictation()
check(not ns.Main.dictating and #ns.Transport.queue == queued, "no dictation backend: nothing is sent")
check(Stub.printed[1] and Stub.printed[1]:find("macOS", 1, true) ~= nil, "the mic explains why: " .. tostring(Stub.printed[1]))
ns.Main:ToggleDictation()
check(#Stub.printed == 1, "a repeated press doesn't repeat the note")
ns.Main:Open()
ns.Main:Refresh()
check(not ns.Main.frame.Bar.Mic:IsEnabled(), "the mic is dimmed while there is no backend")
data.bridge.dictation = "test backend"
data.bridge.dictationHint = nil
data.gen = data.gen + 1
ns.Transport:Apply(data)
ns.Main:Refresh()
check(ns.Main.frame.Bar.Mic:IsEnabled(), "the mic is ready again once a backend is reported")

-- A refused dictate command doesn't leave the mic stuck on.
ns.Main.dictating = false
ns.Main:ToggleDictation()
check(ns.Main.dictating, "dictation starts when a backend is reported")
data.gen = data.gen + 1
ns.Transport:Apply({ gen = data.gen, results = { { id = ns.Main.dictCmd, ok = false, msg = "no microphone" } }, threads = data.threads, projects = data.projects, bridge = data.bridge, agents = data.agents, ack = { ui = ns.ui, seq = ns.Transport.stripSeq } })
check(not ns.Main.dictating, "a refused dictate command puts the mic back")

-- Plan, approval details, run summary, queued note
data.gen = data.gen + 1
for _, th in ipairs(data.threads) do if th.id == ns.viewId then th.s = "plan" end end
data.view = data.view or {}
data.view.id = ns.viewId
data.view.pending = nil
data.view.plan = "|cffffd100Plan|r\n• step one"
data.view.sum = "Last run: 2 commands · 4m 12s"
data.view.queued = 1
ns.Transport:Apply(data)
local found = {}
for _, r in ipairs(ns.Transcript.scrollBox._rows) do
	if r.ed.text then
		if r.ed.text:find("step one", 1, true) then found.plan = true end
		if r.ed.text:find("Last run", 1, true) then found.sum = true end
		if r.ed.text:find("queued", 1, true) then found.queued = true end
	end
	if r.ed.label == "Read the plan aloud" then found.readPlan = true end
end
check(found.plan and found.readPlan, "plan text shown with a read-aloud option")
check(found.sum and found.queued, "run summary and queued follow-ups shown")
data.gen = data.gen + 1
for _, th in ipairs(data.threads) do if th.id == ns.viewId then th.s = "input" end end
data.view.plan, data.view.queued = nil, nil
data.view.pending = { id = "ap1", kind = "approval", what = "Change files", detail = "", files = { { f = "a.lua", a = 12, d = 3 } } }
ns.Transport:Apply(data)
found = {}
for _, r in ipairs(ns.Transcript.scrollBox._rows) do
	if r.ed.text and r.ed.text:find("a.lua", 1, true) and r.ed.text:find("+12", 1, true) then found.files = true end
	if r.ed.label == "Yes" then found.yes = r end
end
check(found.files, "approval lists the files with +/- counts")
found.yes.frame:Click()
check(ns.Transport:Payload():find("approve\031" .. ns.viewId .. "\031ap1\031accept", 1, true) ~= nil, "Yes sends accept")
data.gen = data.gen + 1
data.view.pending = nil
for _, th in ipairs(data.threads) do if th.id == ns.viewId then th.s = "open" end end
ns.Transport:Apply(data)

-- Notices wait during combat
_G.InCombatLockdown = function() return true end
local t1 = ns.Store.data.threads[2]
ns.Toasts.held = {}
ns:Fire("ThreadTransition", t1, "working", "open")
check(#ns.Toasts.held == 1, "notice held during combat")
_G.InCombatLockdown = function() return false end
ns:Fire("Combat", false)
check(#ns.Toasts.held == 0, "held notice shown after combat")

-- Search and machine filter
ns.ThreadList.query = "zzzz-no-match"
ns.ThreadList:Refresh(true)
local threadRows = 0
for _, r in ipairs(ns.ThreadList.scrollBox._rows) do if r.ed.thread then threadRows = threadRows + 1 end end
check(threadRows == 0, "search hides non-matching threads")
ns.ThreadList.query = nil
local groups = ns.Store:Groups("m:local")
check(#groups.working + #groups.open + #groups.settled > 0, "machine filter (this computer) keeps local threads")
groups = ns.Store:Groups("m:foundry")
check(#groups.working + #groups.open + #groups.settled == 0, "machine filter (foundry) excludes local threads")
ns.ThreadList:Refresh(true)

-- Report: diagnostics in the box + a screenshot request
ns.Main.composer._text = ""
ns.Main:Report("the list flickers")
check(ns.Main.composer._text:find("the list flickers", 1, true) and ns.Main.composer._text:find("diagnostics", 1, true), "report fills the message box")
check(ns.Transport:Payload():find("\031shot\031", 1, true) ~= nil, "report asks the bridge for a screenshot")
ns.Main.composer._text = ""

-- Attending flag: set while the window is in use, cleared after 90s idle
ns.Main:Open()
ns.Interacted()
Stub.Tick(0.1)
check(ns.Transport:Flags():find("a", 1, true) ~= nil, "attending while using the window")
Stub.now = Stub.now + 100
Stub.Tick(0.1)
check(ns.Transport:Flags():find("a", 1, true) == nil, "not attending after 90s idle")

-- Self-test runs
ns.SelfTest()
check(true, "self-test ran")

-- Window size
ns.db.settings.windowScale = "xlarge"
ns.Main:ApplyScale()
check(true, "window scale applied")
ns.db.settings.windowScale = "auto"

-- Resizing: the saved size stays between the default and the screen.
do
	local f = ns.Main.frame
	UIParent._w, UIParent._h = 1920, 1080
	ns.db.settings.windowSize = { 1200, 800 }
	ns.Main:ApplyScale()
	check(f:GetWidth() == 1200 and f:GetHeight() == 800, "a saved size is restored")
	ns.db.settings.windowSize = { 5000, 300 }
	ns.Main:ApplyScale()
	check(f:GetWidth() == 1920 and f:GetHeight() == 640, "a saved size is kept on screen and no smaller than the default: " .. f:GetWidth() .. "x" .. f:GetHeight())
	f.ResizeGrip._scripts.OnClick(f.ResizeGrip, "RightButton")
	check(ns.db.settings.windowSize == nil and f:GetWidth() == 940, "right-clicking the grip puts the default size back")
	UIParent._w, UIParent._h = nil, nil
end

-- Copying: the game has no clipboard, so the text goes in a box, without markup.
do
	local text = ns.CopyableText("|cffffffffbold|r and ||pipe |A:common-icon-checkmark:14:14|a|Tx:0|tdone")
	check(text == "bold and ||pipe done", "copied text loses colors and icons, keeps escaped bars: " .. text)
	local f = ns.UI.ShowCopy("|cff66bbffcode|r here")
	check(f:IsShown() and f.Box:GetInputText() == "code here" and f.Box:GetEditBox():HasFocus(), "the copy box opens with the plain text, focused")
	f.Box:GetEditBox()._scripts.OnTextChanged(f.Box:GetEditBox(), true)
	check(f.Box:GetEditBox():GetText() == "code here", "typing in the copy box puts the text back")
	f:Hide()
	local saved = ns.Store.View
	ns.Store.View = function() return { msgs = { { r = "a", t = "first reply" }, { r = "u", t = "a question" }, { r = "a", t = "|cffffffffthe answer|r" }, { r = "u", t = "thanks" } } } end
	ns.Main.frame.Bar.Copy:Click()
	ns.Store.View = saved
	check(f:IsShown() and f.Box:GetInputText() == "the answer", "the bar's copy button copies the latest reply: " .. f.Box:GetInputText())
	f:Hide()
end

-- Transitions -> toast
local t = ns.Store.data.threads[1]
local before = t.s
data.gen = data.gen + 1
for _, th in ipairs(data.threads) do if th.id == t.id then th.s = "working" end end
ns.Transport:Apply(data)
data.gen = data.gen + 1
for _, th in ipairs(data.threads) do if th.id == t.id then th.s = "open" th.un = true end end
ns.Transport:Apply(data)
local toastShown = ns.Toasts.frames[1] and ns.Toasts.frames[1]._shown
check(toastShown or (ns.windowOpen and ns.viewId == t.id), "finish transition produced a toast")

-- Tracker and tickers run
ns.Tracker:Refresh()
for _ = 1, 5 do Stub.Tick(1) end
check(true, "tickers ran")

-- Gamepad mode: the window captures the controller itself.
Stub.gamepad = true
ns.Main.frame:Hide()
ns.Main:Open()
local f = ns.Main.frame
check(ns.Gamepad.capturing, "window captures the controller in gamepad mode")
local down = f._scripts.OnGamePadButtonDown
check(down ~= nil and f._scripts.OnGamePadStick ~= nil, "button and stick handlers installed")
ns.Gamepad:SelectDefault()
check(ns.Gamepad.selected ~= nil, "cursor starts on a control")
check(down(f, "PADDDOWN") == false, "D-pad consumed (character doesn't move)")
check(f._scripts.OnGamePadStick(f, "Left", 0, -1) == false, "left stick consumed")
check(down(f, "PADFORWARD") == false and f._shown == false and not ns.Gamepad.capturing, "Start closes the window and gives the controller back")
ns.Main:Open()
check(ns.Gamepad.capturing, "reopened window takes the controller again")
check(down(f, "PADRSHOULDER") == false and ns.Main.page == "settings", "RB switched to settings")
down(f, "PADLSHOULDER")
check(ns.Main.page == "threads", "LB switched back")
down(f, "PAD4")
check(ns.Main.dictating, "Y starts dictation")
f._scripts.OnGamePadButtonUp(f, "PAD4")
check(not ns.Main.dictating, "Y release stops dictation")
-- A on a thread row opens it
for _, r in ipairs(ns.ThreadList.scrollBox._rows) do
	if r.ed.thread then ns.Gamepad:Highlight(r.frame) break end
end
ns.viewId = nil
down(f, "PAD1")
check(ns.viewId ~= nil, "A opened the highlighted thread")
-- D-pad routes between the list, the conversation and the message box
local function rowFor(id)
	for _, r in ipairs(ns.ThreadList.scrollBox._rows) do if r.ed.thread and r.ed.thread.id == id then return r.frame end end
end
data.gen = data.gen + 1
data.view = data.view or {}
data.view.id = ns.viewId
data.view.pending = nil
ns.Transport:Apply(data)
ns.Gamepad:Highlight(rowFor(ns.viewId) or ns.ThreadList.scrollBox._rows[2].frame)
down(f, "PADDRIGHT")
check(ns.Gamepad.selected == ns.Main.composer, "Right from the list goes to the message box")
down(f, "PADDDOWN")
check(ns.Gamepad.selected == f.Bar.Send, "Down from the message box goes to Send")
down(f, "PADDUP")
check(ns.Gamepad.selected == ns.Main.composer, "Up from Send goes back to the message box")
down(f, "PADDLEFT")
local sel = ns.Gamepad.selected
local onRow = false
for _, r in ipairs(ns.ThreadList.scrollBox._rows) do if r.frame == sel and r.ed.thread and r.ed.thread.id == ns.viewId then onRow = true end end
check(onRow, "Left from the conversation returns to the open thread's row")
data.gen = data.gen + 1
data.view.pending = { id = "req2", kind = "question", questions = { { id = "q", h = "Pick", q = "Which?", opts = { { l = "One", d = "", v = "1" }, { l = "Two", d = "", v = "2" } } } } }
ns.Transport:Apply(data)
down(f, "PADDRIGHT")
local selEd
for _, r in ipairs(ns.Transcript.scrollBox._rows) do if r.frame == ns.Gamepad.selected then selEd = r.ed end end
check(selEd and selEd.kind == "option" and selEd.label == "One", "Right goes straight to the first answer when the agent is asking")
down(f, "PADDDOWN")
for _, r in ipairs(ns.Transcript.scrollBox._rows) do if r.frame == ns.Gamepad.selected then selEd = r.ed end end
check(selEd and selEd.label == "Two", "Down steps to the next answer")
data.gen = data.gen + 1
data.view.pending = nil
ns.Transport:Apply(data)
-- A on the project dropdown opens a real list; the cursor moves inside it
ns.Gamepad:Highlight(ns.ThreadList.dropdown)
down(f, "PAD1")
local listFrame = ns.UI.ListOpen()
check(listFrame ~= nil, "A opens the project list")
local rows = listFrame.Box._rows or {}
check(#rows >= 2, "list shows the projects: " .. #rows)
local cands = ns.Gamepad:Candidates()
check(#cands == #rows, "cursor is confined to the list rows")
ns.Gamepad:SelectDefault()
check(ns.Gamepad.selected and ns.Gamepad.selected == rows[1].frame, "cursor starts on the current choice (All projects)")
ns.Gamepad:Highlight(rows[2].frame)
down(f, "PAD1")
check(ns.UI.ListOpen() == nil, "picking closes the list")
check(ns.db.settings.project == rows[2].ed.value, "picked project applied: " .. ns.db.settings.project)
ns.Gamepad:Highlight(ns.ThreadList.dropdown)
down(f, "PAD1")
down(f, "PAD2")
check(ns.UI.ListOpen() == nil and f._shown, "B closes the list, not the window")
ns.db.settings.project = "all"
-- Mouse: click opens, clicking a row picks
ns.ThreadList.dropdown._scripts.OnClick(ns.ThreadList.dropdown, "LeftButton")
check(ns.UI.ListOpen() ~= nil, "click opens the list")
ns.UI.ListOpen().Box._rows[2].frame:Click()
check(ns.db.settings.project ~= "all", "click on a row picks it")
ns.db.settings.project = "all"
-- B leaves the composer, then closes
ns.Main.composer._focus = true
down(f, "PAD2")
check(not ns.Main.composer._focus, "B leaves the message box")
down(f, "PAD2")
check(not f._shown, "B closes the window")
check(not ns.Gamepad.capturing, "controller released on close")

-- Launching without a keyboard
check(ns.Launcher.chord == "PADLTRIGGER-PADRTRIGGER-PADBACK", "controller shortcut: both triggers + Back")
check(next(Stub.overrides) == nil, "no key bindings overridden (Forever's controller mode ignores them)")
GameMenuFrame:InitButtons()
local entry
for _, b in ipairs(GameMenuFrame.buttons) do if b.text == "Orca" then entry = b end end
check(entry and entry.layoutIndex == 4.5, "game menu entry reads Orca and sits above Log Out")
_G.HideUIPanel = function() end
entry.cb()
check(f._shown, "game menu entry opens the window")
OrcaWow_Binding("toggle")
check(not f._shown, "shortcut toggles it closed")
check(#(ns.db.errors or {}) == 0, "no errors recorded")

-- Slash command
SlashCmdList.ORCAWOW("status")
check(#Stub.printed > 0, "status printed: " .. Stub.printed[#Stub.printed])

-- Self-test: the long control plays, the empty one doesn't -> bells usable
Stub.validSounds = { ["Interface\\AddOns\\OrcaWow\\Signals\\03999.wav"] = true }
ns.Transport.signals = "untested"
ns.Transport.testing = nil
ns.Transport:SelfTest()
check(ns.Transport.signals == "ok", "self-test passes when the long control plays: " .. ns.Transport.signals)
Stub.validSounds = {}
ns.Transport.testing = nil
ns.Transport:SelfTest()
check(ns.Transport.signals == "muted", "self-test fails when nothing really plays (Forever says willPlay=true anyway)")
ns.Transport.signals = "ok"

-- A bell rung a couple of numbers ahead is still heard; bells map onto 8 rotating
-- files. Only a fresh snapshot moves the bell position (to the bridge's nextSig).
local function BellPath(k) return string.format("Interface\\AddOns\\OrcaWow\\Signals\\%05d.wav", 3991 + (k - 1) % 8) end
local freshFile = os.tmpname()
do
	local fh = assert(io.open(freshFile, "w"))
	fh:write(string.format("dofile(%q) OrcaWow_Inbox.gen = 9e15 OrcaWow_Inbox.nextSig = 503\n", snapshot))
	fh:close()
end
ns.Transport.exhausted = nil
ns.Transport.bellProbe = nil
ns.Transport.ringCooldownUntil = nil
ns.db.sigNext = 500
Stub.slotData[ns.Transport.slotCursor] = freshFile
Stub.validSounds = { [BellPath(502)] = true }
local loadsBefore = Stub.loadCount or 0
Stub.Tick(0.6) -- starts listening
Stub.Tick(0.2) -- checks which bell is really playing
check((Stub.loadCount or 0) > loadsBefore, "loaded a slot when bell 502 rang")
check(ns.db.sigNext == 503, "took the bridge's next bell from the fresh snapshot: " .. ns.db.sigNext)

-- A bell that leads to old data is a false alarm: no moving ahead (which would
-- alias still-rung bells and run away), a short cooldown, and a fresh strip.
Stub.validSounds = { [BellPath(504)] = true }
local loads1 = Stub.loadCount
ns.Transport.bellProbe = nil
Stub.Tick(0.6)
Stub.Tick(0.2)
check(Stub.loadCount == loads1 + 1 and ns.db.sigNext == 503, "false ring: one slot loaded, position kept at " .. ns.db.sigNext)
check(ns.Transport.falseRings == 1 and ns.Transport.stripShown, "false ring counted and the strip redrawn")
Stub.Tick(0.6)
Stub.Tick(0.2)
check(Stub.loadCount == loads1 + 1, "cooldown: no slot burned by the same false alarm")

-- A laggy client: even the empty control still "plays" at check time. Wait it out
-- instead of trusting the bells.
Stub.now = Stub.now + 5
ns.Transport:HideStrip() -- (as if the bridge acknowledged it; isolates the bell check)
ns.Transport.lastLoadAt = Stub.now
ns.Transport.bellProbe = nil
Stub.validSounds = { [BellPath(503)] = true, ["Interface\\AddOns\\OrcaWow\\Signals\\04000.wav"] = true }
local loads2 = Stub.loadCount
for _ = 1, 12 do Stub.Tick(0.2) end
check(Stub.loadCount == loads2, "no slot loaded while the client is too slow to tell bells apart")
Stub.validSounds = {}
ns.Transport.bellProbe = nil
local loads3 = Stub.loadCount
Stub.Tick(0.6)
Stub.Tick(0.2)
check(Stub.loadCount == loads3, "no slot spent while no bell rings")
os.remove(freshFile)

-- Controller shortcut: hold both triggers, press Back. Read from the controller's
-- state only: the watcher must never take gamepad input (that breaks LT + RT action bars).
do
	local L = ns.Launcher
	L:SetupChord()
	check(L.chordText and L.chordText:find("Left trigger", 1, true) and L.chordText:find("Gamepad_Ltr_View", 1, true), "shortcut shown as the player's buttons: " .. tostring(L.chordText))
	check(not L.chordText:find("RT", 1, true), "no hard-coded Xbox names")
	local w = L.watcher
	check(w._scripts.OnGamePadButtonDown == nil and not w._gamepadEnabled, "the watcher never takes controller input")
	local function frame() w._scripts.OnUpdate(w, 0.016) end
	local wasOpen = ns.windowOpen
	WOWSTUB.padHeld = { PADLTRIGGER = true, PADRTRIGGER = true }
	frame()
	check(ns.windowOpen == wasOpen, "holding the triggers alone does nothing (LT + RT action bars stay the game's)")
	WOWSTUB.padHeld.PADBACK = true
	frame()
	check(ns.windowOpen ~= wasOpen, "triggers + Back toggles Orca")
	frame()
	frame()
	check(ns.windowOpen ~= wasOpen, "holding Back doesn't toggle it again")
	WOWSTUB.padHeld = { PADBACK = true }
	if ns.windowOpen ~= wasOpen then ns.Launcher:Open() end
	frame()
	WOWSTUB.padHeld = {}
	frame()
	WOWSTUB.padHeld = { PADBACK = true }
	frame()
	check(ns.windowOpen == wasOpen, "Back on its own is left to the game")
	WOWSTUB.padHeld = {}
	frame()
end

-- Tracker section follows the objective tracker, in the quest column.
do
	local f = ns.Tracker.frame
	local function anchoredTo(target)
		for _, pt in ipairs(f._points or {}) do if pt[2] == target then return true end end
		return false
	end
	WOWSTUB.Tick(0.3)
	check(ns.Tracker.attached == "below" and anchoredTo(ObjectiveTrackerFrame.NineSlice), "tracker section sits under the quests: " .. tostring(ns.Tracker.attached))
	check(f:GetWidth() == 280, "same width as the objective tracker")
	ObjectiveTrackerFrame.isCollapsed = true
	for _, t in ipairs(WOWSTUB.tickers) do t.fn() end
	check(ns.Tracker.attached == "header" and anchoredTo(ObjectiveTrackerFrame.Header), "under the header when All Objectives is collapsed")
	ObjectiveTrackerFrame.isCollapsed = nil
	ObjectiveTrackerFrame._shown = false
	for _, t in ipairs(WOWSTUB.tickers) do t.fn() end
	check(ns.Tracker.attached == "replace", "takes the tracker's place when it's empty")
	ObjectiveTrackerFrame._shown = true
	ns.db.settings.trackerPoint = { "CENTER", "CENTER", 10, 10 }
	for _, t in ipairs(WOWSTUB.tickers) do t.fn() end
	check(ns.Tracker.attached == "custom", "a dragged position is kept")
	ns.db.settings.trackerPoint = nil
	for _, t in ipairs(WOWSTUB.tickers) do t.fn() end
	check(ns.Tracker.attached == "below", "reset reattaches it")
end

-- Minimap button
do
	local mb = ns.MinimapButton.button
	check(mb ~= nil, "minimap button created")
	local wasOpen = ns.windowOpen
	mb._scripts.OnClick(mb, "LeftButton")
	check(ns.windowOpen ~= wasOpen, "minimap click toggles the window")
	mb._scripts.OnClick(mb, "LeftButton")
	mb._scripts.OnEnter(mb)
	mb._scripts.OnDragStart(mb)
	mb._scripts.OnDragStop(mb)
	check(type(ns.db.settings.minimapAngle) == "number", "minimap drag saves its position")
	ns.db.settings.minimapButton = false
	ns.MinimapButton:Refresh()
	check(mb._shown == false, "minimap button can be hidden")
	ns.db.settings.minimapButton = true
	ns.MinimapButton:Refresh()
end

-- Agents: Orca's words and the same commands underneath, the new-agent form,
-- approvals and the link status.
do
	local main, f = ns.Main, ns.Main.frame
	local hdr = f.Pages.threads.Right.Header
	local function Snapshot(bridge, extra)
		local s = { gen = ns.db.gen + 1, now = os.time(), threads = data.threads, projects = data.projects, bridge = bridge, ack = { ui = ns.ui, seq = ns.Transport.stripSeq } }
		for k, v in pairs(extra or {}) do s[k] = v end
		ns.Transport:Apply(s)
	end
	local orcaBridge = { version = "0.4.0", orca = "connected", dictation = "test backend" }
	-- An older bridge that offers no agents to pick from.
	Snapshot(orcaBridge, { view = { id = firstThread.id, msgs = data.view.msgs } })
	main:Open()
	main:SelectThread(firstThread.id)
	main:Refresh()
	check(hdr.Action:GetText() == "Mark done", "an open agent offers Mark done: " .. hdr.Action:GetText())
	hdr.Action:Click()
	check(ns.Transport.queue[#ns.Transport.queue].verb == "settle", "Mark done sends settle")
	check(f.Bar.New:GetText() == "New agent", "the new button reads New agent")
	-- A settled agent: Reopen, and Archive becomes Sleep worktree.
	local settled
	for _, th in ipairs(data.threads) do if th.s == "settled" then settled = th end end
	main:SelectThread(settled.id)
	check(hdr.Action:GetText() == "Reopen" and hdr.Archive:IsShown() and hdr.Archive:GetText() == "Sleep worktree", "a done agent offers Reopen and Sleep worktree")
	hdr.Archive:Click()
	check(ns.Transport.queue[#ns.Transport.queue].verb == "archive", "Sleep worktree still sends archive")
	local listed = {}
	for _, r in ipairs(ns.ThreadList.scrollBox._rows) do if r.ed.header then listed[r.ed.key] = r.ed.label end end
	check(listed.settled == "Done", "the Settled group reads Done")
	-- New agent on a bridge that offers no agents: no agent row, and Orca picks.
	local opts = f.Pages.threads.Right.NewOptions
	main:StartNewThread()
	check(f.Subtitle:GetText() == "New agent in " .. ns.Store:ProjectName(main.newProject) and hdr.Project:IsShown() and not opts:IsShown(), "a new agent asks only for the project: " .. f.Subtitle:GetText())
	main.composer._text = "Start an Orca agent"
	main:Send()
	local new = ns.Transport.queue[#ns.Transport.queue]
	check(new.verb == "new" and new.args[2] == "Start an Orca agent" and new.args[3] == nil and new.args[4] == nil, "the new command carries just the project and the text")
	main:Back()

	-- With the bridge's agent list: pick the agent, and optionally the worktree's name
	-- and base branch.
	local agentsSection = { d = "claude", o = { { i = "claude", l = "Claude" }, { i = "codex", l = "Codex" }, { i = "gemini", l = "Gemini" } } }
	Snapshot(orcaBridge, { agents = agentsSection })
	ns.db.lastAgent = nil
	main:StartNewThread()
	local project = main.newProject
	local projectName = ns.Store:ProjectName(project)
	check(opts:IsShown() and opts.Agent:IsVisible() and opts.Name:IsVisible() and opts.Branch:IsVisible(), "the new-agent form shows the agent picker and the two boxes")
	check(opts.Agent.value == "claude" and opts.Agent.Text:GetText() == "Claude" and #opts.Agent.options == 3, "the agent picker preselects the bridge's default: " .. opts.Agent.Text:GetText())
	check(opts.Name.Placeholder:IsShown() and opts.Name.Placeholder:GetText() == "auto" and opts.Branch.Placeholder:GetText() == "default branch", "empty boxes say what they default to")
	check(ns.Transcript.inset._points[1][2] == opts, "the conversation hangs under the options row, not over it")
	check(f.Subtitle:GetText() == "New Claude agent in " .. projectName, "the subtitle names the agent: " .. f.Subtitle:GetText())
	ns.UI.OpenList(opts.Agent)
	for _, r in ipairs(ns.UI.ListOpen().Box._rows) do if r.ed.value == "codex" then r.frame:Click() end end
	check(ns.UI.ListOpen() == nil and opts.Agent.value == "codex" and ns.db.lastAgent == "codex", "picking Codex from the list remembers it")
	check(f.Subtitle:GetText() == "New Codex agent in " .. projectName, "and the subtitle follows: " .. f.Subtitle:GetText())
	-- An invalid name is caught here, with the reason under the boxes, and nothing is sent.
	local queued = #ns.Transport.queue
	opts.Name:SetText("bad name!")
	main.composer._text = "Add dark mode"
	main:Send()
	check(#ns.Transport.queue == queued and main.composer._text == "Add dark mode" and main.mode == "new", "an invalid worktree name blocks the send")
	check(opts.Hint:GetText():find("only letters, digits", 1, true) ~= nil, "the hint says which characters work: " .. opts.Hint:GetText())
	opts.Name:SetText("dark-mode")
	opts.Branch:SetText(" develop ")
	main:Refresh()
	check(not opts.Hint:GetText():find("only letters", 1, true) and not opts.Name.Placeholder:IsShown(), "a valid name clears the hint")
	main:Send()
	new = ns.Transport.queue[#ns.Transport.queue]
	local function Args(cmd) local out = {} for i = 1, select("#", unpack(cmd.args)) do out[i] = tostring(cmd.args[i]) end return table.concat(out, "|") end
	check(new.verb == "new" and Args(new) == table.concat({ project, "Add dark mode", "codex", "dark-mode", "develop" }, "|"), "new sends project, text, agent, name, branch: " .. Args(new))
	check(opts.Name:GetText() == "" and opts.Branch:GetText() == "" and main:ChosenNewAgent() == "codex", "after sending, the boxes reset and the agent stays")
	-- Orca refuses it (the name is taken): what was typed comes back.
	Snapshot(orcaBridge, { agents = agentsSection, results = { { id = main.pendingNew, ok = false, msg = "There's already a worktree called \"dark-mode\". Pick another name." } } })
	check(opts.Name:GetText() == "dark-mode" and opts.Branch:GetText() == "develop" and main.composer._text == "Add dark mode", "a refused new agent puts the name, branch and task back")
	-- Extras left empty: just the agent; a branch without a name keeps the name's place.
	main:ClearNewWorktreeFields()
	main:PickAgent("claude")
	main.composer._text = "Plain one"
	main:Send()
	new = ns.Transport.queue[#ns.Transport.queue]
	check(Args(new) == table.concat({ project, "Plain one", "claude" }, "|"), "empty extras send project, text and agent only: " .. Args(new))
	opts.Branch:SetText("release/1.2")
	main.composer._text = "From release"
	main:Send()
	new = ns.Transport.queue[#ns.Transport.queue]
	check(Args(new) == table.concat({ project, "From release", "claude", "", "release/1.2" }, "|"), "a branch without a name sends an empty name: " .. Args(new))
	main:Back()
	check(not opts:IsShown() and ns.Transcript.inset._points[1][2] == hdr, "leaving the form hides the row and the conversation moves back up")
	-- The controller reaches the row: Down from the project, Left/Right along it.
	main:StartNewThread()
	ns.Gamepad:Highlight(hdr.Project)
	local down = f._scripts.OnGamePadButtonDown
	down(f, "PADDDOWN")
	check(ns.Gamepad.selected == opts.Agent, "Down from the project goes to the agent picker")
	down(f, "PADDRIGHT")
	check(ns.Gamepad.selected == opts.Name, "Right goes to the worktree name")
	down(f, "PADDRIGHT")
	check(ns.Gamepad.selected == opts.Branch, "and on to the base branch")
	down(f, "PADDLEFT")
	down(f, "PADDLEFT")
	check(ns.Gamepad.selected == opts.Agent, "Left goes back to the agent picker")
	down(f, "PAD1")
	check(ns.UI.ListOpen() and ns.UI.ListOpen().owner == opts.Agent, "A opens the agent list")
	down(f, "PAD2")
	check(ns.UI.ListOpen() == nil and ns.Gamepad.selected == opts.Agent, "B closes it, back on the picker")
	down(f, "PADDDOWN")
	check(ns.Gamepad.selected == main.composer, "Down from the row goes to the message box")
	down(f, "PADDUP")
	check(ns.Gamepad.selected == opts.Agent, "Up from the message box comes back to the row")
	down(f, "PADDUP")
	check(ns.Gamepad.selected == hdr.Project, "and Up again to the project")
	main:Back()
	-- /orca new: the remembered agent and Orca's defaults, or what the flags say.
	opts.Name:SetText("left-over")
	SlashCmdList.ORCAWOW("new Just the task")
	check(main.mode == "new" and opts.Agent.value == "claude" and opts.Name:GetText() == "" and opts.Branch:GetText() == "" and main.composer._text == "Just the task", "/orca new uses the remembered agent, an automatic name and the default branch")
	SlashCmdList.ORCAWOW("new --agent Codex --name feat/x --base=develop Fix the tracker")
	check(opts.Agent.value == "codex" and opts.Name:GetText() == "feat/x" and opts.Branch:GetText() == "develop" and main.composer._text == "Fix the tracker", "/orca new --agent --name --base fills the form")
	main:Send()
	new = ns.Transport.queue[#ns.Transport.queue]
	check(Args(new) == table.concat({ project, "Fix the tracker", "codex", "feat/x", "develop" }, "|"), "and sends it: " .. Args(new))
	Stub.printed = {}
	queued = #ns.Transport.queue
	SlashCmdList.ORCAWOW("new --agent nope Task")
	check(#ns.Transport.queue == queued and Stub.printed[1] and Stub.printed[1]:find("no agent called", 1, true), "/orca new with an unknown agent says so: " .. tostring(Stub.printed[1]))
	main:Back()
	-- Approval in Orca's words, with the same decisions underneath.
	main:SelectThread(firstThread.id)
	Snapshot(orcaBridge, { view = { id = firstThread.id, msgs = data.view.msgs, pending = { id = "ap9", kind = "approval", what = "Run a command", detail = "npm test" } } })
	local function Options()
		local labels, byLabel = {}, {}
		for _, r in ipairs(ns.Transcript.scrollBox._rows) do
			if r.ed.kind == "option" then table.insert(labels, r.ed.label) byLabel[r.ed.label] = r end
		end
		return table.concat(labels, "|"), byLabel
	end
	-- No "don't ask again" row on the agent's menu (no `al`): the bridge would refuse
	-- that press, so no generic button is offered.
	local got, byLabel = Options()
	check(got == "Yes|No", "a menu without the agent's own don't-ask-again row reads Yes / No: " .. got)
	byLabel["Yes"].frame:Click()
	check(ns.Transport:Payload():find("approve\031" .. firstThread.id .. "\031ap9\031accept", 1, true) ~= nil, "Yes sends accept")

	-- A yes row that says more than "Yes" (`yl`) is the Yes button's label, word for word.
	local ylLabel, autoLabel = "Yes, and manually approve edits", "Yes, and auto-accept edits"
	Snapshot(orcaBridge, { view = { id = firstThread.id, msgs = data.view.msgs, pending = { id = "ap10b", kind = "approval", what = "Change files", detail = "", yl = ylLabel, al = autoLabel } } })
	got, byLabel = Options()
	check(got == ylLabel .. "|" .. autoLabel .. "|No", "the Yes button shows the row it presses: " .. got)
	check(byLabel[ylLabel].ed.primary and byLabel[ylLabel].ed.desc ~= nil and byLabel[ylLabel].ed.height == byLabel["No"].ed.height, "it stays the primary option, one row high, with the whole label in its tooltip")
	byLabel[ylLabel].frame:Click()
	local ylCmd = ns.Transport.queue[#ns.Transport.queue]
	check(ylCmd.verb == "approve" and ylCmd.args[2] == "ap10b" and ylCmd.args[3] == "accept", "and sends accept")
	-- Requests the game can't approve say why (`pcw`).
	Snapshot(orcaBridge, { view = { id = firstThread.id, msgs = data.view.msgs, pending = { id = "ap10c", kind = "approval", what = "Run a command", detail = "opencode run", pc = true, pcw = "None of this prompt's options says yes, so the game can't approve it. You can still say No from here." } } })
	got = Options()
	local pcNote
	for _, r in ipairs(ns.Transcript.scrollBox._rows) do if r.ed.text and r.ed.text:find("None of this prompt's options says yes", 1, true) then pcNote = r.ed.text end end
	check(got == "No" and pcNote ~= nil, "a request without a yes row offers only No and says why: " .. got)
	-- The agent's own row, word for word (`al`), picks acceptForSession.
	local alLabel = "Yes, and don't ask again for npm test commands in C:\\src\\app"
	local alView = { id = firstThread.id, msgs = data.view.msgs, pending = { id = "ap11", kind = "approval", what = "Run a command", detail = "npm test", al = alLabel } }
	Snapshot(orcaBridge, { view = alView })
	got, byLabel = Options()
	check(got == "Yes|" .. alLabel .. "|No", "the agent's own don't-ask-again label replaces the generic buttons: " .. got)
	check(byLabel[alLabel].ed.desc ~= nil, "that option says it can allow more than this request")
	byLabel[alLabel].frame:Click()
	local sentCmd = ns.Transport.queue[#ns.Transport.queue]
	check(sentCmd.verb == "approve" and sentCmd.args[2] == "ap11" and sentCmd.args[3] == "acceptForSession", "the agent's own row sends acceptForSession")
	check(Options() == "", "the request is hidden once answered")
	-- The bridge refuses it (the menu changed, the screen couldn't be read): ask again.
	Snapshot(orcaBridge, { view = alView, results = { { id = sentCmd.id, ok = false, msg = "The question changed, so nothing was pressed. Look again." } } })
	check(Options():find("^Yes|") ~= nil, "a refused approval shows the request again: " .. Options())
	-- A refused answer to a question shows it again too.
	local qView = { id = firstThread.id, msgs = data.view.msgs, pending = { id = "q7", kind = "question", questions = { { id = "q1", h = "Pick", q = "Which?", opts = { { l = "One", d = "", v = "1" }, { l = "Two", d = "", v = "2" } } } } } }
	Snapshot(orcaBridge, { view = qView })
	got, byLabel = Options()
	byLabel["One"].frame:Click()
	sentCmd = ns.Transport.queue[#ns.Transport.queue]
	check(sentCmd.verb == "answer" and sentCmd.args[2] == "q7" and not Options():find("One", 1, true), "an answered question is hidden: " .. Options())
	Snapshot(orcaBridge, { view = qView, results = { { id = sentCmd.id, ok = false, msg = "Couldn't read the agent's screen, so nothing was pressed. Try again, or answer it in Orca." } } })
	check(Options():find("One", 1, true) ~= nil, "a refused answer shows the question again: " .. Options())
	-- Workspace trust and hooks reviews (`pc`): only No, and a note to answer at the computer.
	Snapshot(orcaBridge, { view = { id = firstThread.id, msgs = data.view.msgs, pending = { id = "ap12", kind = "approval", what = "Trust this folder", detail = "Do you trust the files in this folder?", pc = true, al = alLabel } } })
	got, byLabel = Options()
	check(got == "No", "a wait for the computer offers only No: " .. got)
	local noteText
	for _, r in ipairs(ns.Transcript.scrollBox._rows) do if r.ed.text and r.ed.text:find("answer this at the computer", 1, true) then noteText = r.ed.text end end
	check(noteText ~= nil, "and says to answer it at the computer")
	byLabel["No"].frame:Click()
	sentCmd = ns.Transport.queue[#ns.Transport.queue]
	check(sentCmd.verb == "approve" and sentCmd.args[2] == "ap12" and sentCmd.args[3] == "decline", "No declines it")
	-- Controller: the bumpers go between the two tabs.
	local down = f._scripts.OnGamePadButtonDown
	down(f, "PADRSHOULDER")
	check(main.page == "settings", "RB goes from the agents to Settings")
	down(f, "PADRSHOULDER")
	check(main.page == "threads", "and wraps back to the agents")
	-- Link status, tracker, minimap and settings when Orca is offline.
	Snapshot({ version = "0.4.0", orca = "offline", err = "Orca's pipe is closed" })
	local status = f.Status:GetText()
	check(status:find("Orca: offline", 1, true) and status:find("open Orca on your computer", 1, true), "offline status names Orca and what to do: " .. status)
	ns.Tracker:Refresh()
	check(ns.Tracker.frame.Header.Text:GetText() == "Orca", "the tracker section is headed Orca")
	local tipLines = {}
	local tip = { SetText = function(_, text) table.insert(tipLines, text) end, AddLine = function(_, text) table.insert(tipLines, text) end }
	ns.MinimapButton:Tooltip(tip)
	check(tipLines[1] == "Orca" and table.concat(tipLines, "\n"):find("Open Orca on your computer", 1, true), "the minimap tooltip names Orca and says it's offline")
	ns.Settings:Refresh()
	check(ns.Settings.info:GetText():find("Orca's pipe is closed", 1, true) ~= nil, "settings show the bridge's reason (bridge.err)")
	Snapshot({ version = "0.4.0", orca = "connecting" })
	check(f.Status:GetText():find("Orca: connecting", 1, true) ~= nil, "connecting reads as connecting: " .. f.Status:GetText())
	check(#(ns.db.errors or {}) == 0, "no errors recorded")
end

-- Exhaustion
Stub.now = Stub.now + 2
ns.Transport.slotCursor = ns.Transport.slotCount + 1
ns.Transport:LoadNextSlot("signal")
check(ns.Transport:BridgeState() == "exhausted", "slot exhaustion detected")
ns.Tracker:Refresh()

print("\nall smoke checks passed; slots loaded: " .. tostring(Stub.loadCount))
