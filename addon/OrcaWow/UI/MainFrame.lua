-- The T3 Code window: a standard portrait frame with the thread list on the left,
-- the selected thread on the right, and side tabs for usage and settings.

local _, ns = ...
local UI = ns.UI

local M = {}
ns.Main = M

local WIDTH, HEIGHT = 940, 640
local LIST_W = 300
local COMPOSER_H = 92

M.page = "threads"
M.mode = "thread" -- "thread" | "new"

---------------------------------------------------------------------------
-- Frame

local function CreateSideTab(f, index, icon, tooltip, page)
	local tab = CreateFrame("Frame", nil, f, "LargeSideTabButtonTemplate")
	tab.Icon:SetTexture(icon)
	tab:SetFillToInterior(true, 40)
	tab.tooltipText = tooltip
	tab:SetPoint("TOPLEFT", f, "TOPRIGHT", 0, -36 - (index - 1) * 48)
	tab:SetCustomOnMouseUpHandler(function(_, button, upInside)
		if button == "LeftButton" and upInside then M:ShowPage(page) end
	end)
	tab:EnableMouse(true)
	tab.page = page
	return tab
end

function M:Create()
	if self.frame then return self.frame end
	local f = CreateFrame("Frame", "OrcaWowFrame", UIParent, "ButtonFrameTemplate")
	self.frame = f
	f:SetSize(WIDTH, HEIGHT)
	f:SetPoint("CENTER", 0, 20)
	f:SetFrameStrata("HIGH")
	f:SetToplevel(true)
	f:SetMovable(true)
	f:SetClampedToScreen(true)
	f:EnableMouse(true)
	f:Hide()
	f:SetTitle("T3 Code")
	f:SetPortraitToAsset(ns.media .. "portrait")
	tinsert(UISpecialFrames, "OrcaWowFrame")

	-- Drag by the title bar.
	local drag = CreateFrame("Frame", nil, f)
	drag:SetPoint("TOPLEFT", 60, 0)
	drag:SetPoint("TOPRIGHT", -30, 0)
	drag:SetHeight(24)
	drag:EnableMouse(true)
	drag:RegisterForDrag("LeftButton")
	drag:SetScript("OnDragStart", function() f:StartMoving() end)
	drag:SetScript("OnDragStop", function()
		f:StopMovingOrSizing()
		local point, _, rel, x, y = f:GetPoint()
		ns.db.settings.windowPoint = { point, rel, x, y }
	end)
	local wp = ns.db.settings.windowPoint
	if wp then
		f:ClearAllPoints()
		f:SetPoint(wp[1], UIParent, wp[2], wp[3], wp[4])
	end

	-- Subtitle: the thread you're looking at, and the link status under it.
	f.Subtitle = UI.Text(f, "GameFontNormalLarge", "CENTER")
	f.Subtitle:SetPoint("TOP", 20, -30)
	f.Subtitle:SetWidth(WIDTH - 220)
	f.Subtitle:SetWordWrap(false)
	f.Status = UI.Text(f, "GameFontGreenSmall", "CENTER")
	f.Status:SetPoint("TOP", f.Subtitle, "BOTTOM", 0, -2)
	f.Status:SetWidth(WIDTH - 220)

	-- Collapse the thread list (arrow under the close button).
	f.SidebarToggle = UI.IconButton(f, "common-icon-backarrow", 24, function()
		return ns.Store:IsOrca() and "Hide the agent list" or "Hide the thread list"
	end, function() M:ToggleSidebar() end)
	if not f.SidebarToggle.Icon:GetAtlas() then f.SidebarToggle.Icon:SetAtlas("common-dropdown-icon-back") end
	f.SidebarToggle:SetPoint("TOPRIGHT", -10, -32)

	-- Shown when the session's live updates are running low: a reload frees them.
	f.RefreshSlots = UI.Button(f, "Refresh live updates", 170, function() ReloadUI() end)
	f.RefreshSlots:SetPoint("TOPRIGHT", f.SidebarToggle, "TOPLEFT", -8, 0)
	f.RefreshSlots:Hide()
	UI.Tooltip(f.RefreshSlots, "Refresh live updates", "Reloads the interface (a couple of seconds) to free a fresh set of live updates.")

	-- Pages live inside the inset.
	f.Pages = {}
	f.Pages.threads = CreateFrame("Frame", nil, f.Inset)
	f.Pages.threads:SetAllPoints()
	self:CreateThreadsPage(f.Pages.threads)
	f.Pages.usage = CreateFrame("Frame", nil, f.Inset)
	f.Pages.usage:SetAllPoints()
	f.Pages.settings = CreateFrame("Frame", nil, f.Inset)
	f.Pages.settings:SetAllPoints()

	-- Bottom button bar.
	self:CreateButtonBar(f)

	-- Side tabs.
	f.Tabs = {
		CreateSideTab(f, 1, ns.media .. "icon", "Threads", "threads"),
		CreateSideTab(f, 2, "Interface\\Icons\\INV_Scroll_08", "Usage limits", "usage"),
		CreateSideTab(f, 3, "Interface\\Icons\\INV_Misc_Gear_01", "Settings", "settings"),
	}

	f:SetScript("OnShow", ns.Safe(function()
		PlaySound(SOUNDKIT.IG_CHARACTER_INFO_OPEN)
		ns.windowOpen = true
		ns.Interacted()
		ns.Transport:Touch()
		M:Refresh()
		ns:Fire("WindowShown", f)
	end))
	f:SetScript("OnHide", ns.Safe(function()
		PlaySound(SOUNDKIT.IG_CHARACTER_INFO_CLOSE)
		M:SaveDraft()
		ns.windowOpen = false
		ns.Transport:Touch()
		ns:Fire("WindowHidden", f)
	end))

	self:ApplyScale()
	ns.Usage:Create(f.Pages.usage)
	ns.Settings:Create(f.Pages.settings)
	self:ShowPage("threads")
	return f
end

function M:CreateThreadsPage(page)
	-- Left: project filter + thread list.
	local left = CreateFrame("Frame", nil, page)
	left:SetPoint("TOPLEFT")
	left:SetPoint("BOTTOMLEFT")
	left:SetWidth(LIST_W)
	page.Left = left

	local divider = page:CreateTexture(nil, "ARTWORK")
	divider:SetAtlas("UI-Frame-Divider-Vertical") -- harmless if missing
	if not divider:GetAtlas() then
		divider:SetColorTexture(0.45, 0.36, 0.2, 0.6)
		divider:SetWidth(2)
	end
	divider:SetPoint("TOPLEFT", left, "TOPRIGHT", 0, -2)
	divider:SetPoint("BOTTOMLEFT", left, "BOTTOMRIGHT", 0, 2)
	page.Divider = divider

	ns.ThreadList:Create(left)

	-- Right: header bar, transcript, composer.
	local right = CreateFrame("Frame", nil, page)
	right:SetPoint("TOPLEFT", left, "TOPRIGHT", 4, 0)
	right:SetPoint("BOTTOMRIGHT")
	page.Right = right

	local header = CreateFrame("Frame", nil, right)
	header:SetPoint("TOPLEFT", 4, -4)
	header:SetPoint("TOPRIGHT", -4, -4)
	header:SetHeight(30)
	local hbg = header:CreateTexture(nil, "BACKGROUND")
	hbg:SetAtlas("common-button-list-collapseExpand")
	hbg:SetAllPoints()
	header.Text = UI.Text(header, "GameFontHighlight", "CENTER")
	header.Text:SetPoint("LEFT", 12, 0)
	header.Text:SetPoint("RIGHT", -110, 0)
	header.Text:SetWordWrap(false)
	header.Action = UI.Button(header, "Settle", 96, function() M:HeaderAction() end)
	header.Action:SetPoint("RIGHT", -4, 0)
	header.Archive = UI.Button(header, "Archive", 86, function()
		if ns.viewId then
			ns.Transport:Send("archive", ns.viewId)
			PlaySound(SOUNDKIT.IG_MAINMENU_OPTION_CHECKBOX_OFF)
		end
	end)
	header.Archive:SetPoint("RIGHT", header.Action, "LEFT", -4, 0)
	header.Archive:Hide()
	UI.Tooltip(header.Archive, function()
		return ns.Store:IsOrca() and "Sleep worktree" or "Archive"
	end, function()
		if ns.Store:IsOrca() then
			return "Stops the terminals in this agent's worktree in Orca, the agent included. The worktree and its branch stay."
		end
		return "Hide this thread from the list (it stays in T3 Code's archive)."
	end)
	header.Project = UI.Dropdown(header, 176, function(value)
		M.newProject = value
		M.newModel, M.newEffort = nil, nil
		M:Refresh()
	end)
	header.Project:SetPoint("RIGHT", -6, 0)
	header.Project:Hide()
	-- The model: for the new thread, or the open thread's next runs. Only a deliberate
	-- pick from the list changes it (no wheel or right-click stepping), because each
	-- change on a thread is a command to T3.
	local function ListOnly(dd)
		dd:SetScript("OnClick", function(self) UI.OpenList(self) end)
		dd:EnableMouseWheel(false)
		dd:SetScript("OnMouseWheel", nil)
		dd:Hide()
		return dd
	end
	header.Model = ListOnly(UI.Dropdown(header, 176, function(value) M:PickModel(value) end))
	header.Model.listWidth = 300 -- room for "Model · Provider" rows
	-- How hard the model reasons, when it has levels to pick from.
	header.Effort = ListOnly(UI.Dropdown(header, 92, function(value) M:PickEffort(value) end))
	right.Header = header
	right.NewOptions = self:CreateNewOptions(right, header)

	local composer = UI.Inset(right)
	composer:SetPoint("BOTTOMLEFT", 2, 2)
	composer:SetPoint("BOTTOMRIGHT", -2, 2)
	composer:SetHeight(COMPOSER_H)
	right.ComposerInset = composer

	local box = CreateFrame("Frame", nil, composer, "OrcaWowComposerTemplate")
	box:SetPoint("TOPLEFT", 8, -6)
	box:SetPoint("BOTTOMRIGHT", -8, 18)
	box:RegisterCallback("OnEnterPressed", function()
		if IsShiftKeyDown() then
			box:Insert("\n")
		else
			M:Send()
		end
	end, M)
	box:RegisterCallback("OnTextChanged", function() M:UpdateCounter() ns.Interacted() end, M)
	box:RegisterCallback("OnEscapePressed", function() box:ClearFocus() end, M)
	right.Composer = box
	self.composer = box
	self:SetPlaceholder("Message the agent  (Shift+Enter for a new line)")

	local counter = UI.Text(composer, "GameFontDisableSmall", "RIGHT")
	counter:SetPoint("BOTTOMRIGHT", -8, 5)
	right.Counter = counter

	local hint = UI.Text(composer, "GameFontDisableSmall", "LEFT")
	hint:SetPoint("BOTTOMLEFT", 10, 5)
	right.Hint = hint

	ns.Transcript:Create(right, header, composer)
end

-- Orca's new-agent options, a row under the header: the agent, the worktree's name
-- and the branch it starts from. Shown only when the bridge offers agents.
local NAME_MAX, BRANCH_MAX = 80, 120

function M:CreateNewOptions(right, header)
	local o = CreateFrame("Frame", nil, right)
	o:SetPoint("TOPLEFT", header, "BOTTOMLEFT", 0, -4)
	o:SetPoint("TOPRIGHT", header, "BOTTOMRIGHT", 0, -4)
	o:SetHeight(46)
	o:Hide()
	local row = CreateFrame("Frame", nil, o)
	row:SetPoint("TOPLEFT")
	row:SetPoint("TOPRIGHT")
	row:SetHeight(26)
	o.Row = row

	o.AgentLabel = UI.Text(row, "GameFontNormalSmall", "LEFT")
	o.AgentLabel:SetPoint("LEFT", 8, 0)
	o.AgentLabel:SetText("Agent")
	o.Agent = UI.Dropdown(row, 130, function(value) M:PickAgent(value) end)
	o.Agent:SetPoint("LEFT", o.AgentLabel, "RIGHT", 6, 0)
	o.Agent.tipBody = "The coding agent Orca starts in the new worktree. It's remembered for next time."

	local function Box(placeholder, maxLetters)
		local e = UI.EditBox(row, 140, placeholder, maxLetters)
		e:HookScript("OnTextChanged", function() M:UpdateNewOptions() ns.Interacted() end)
		-- Enter moves on: name -> branch -> the message box (which starts it).
		e:HookScript("OnEnterPressed", function(self)
			if self == o.Name then o.Branch:SetFocus() else M.composer:SetFocus() end
		end)
		e:HookScript("OnTabPressed", function(self)
			if self == o.Name then o.Branch:SetFocus() else M.composer:SetFocus() end
		end)
		return e
	end
	o.NameLabel = UI.Text(row, "GameFontNormalSmall", "LEFT")
	o.NameLabel:SetPoint("LEFT", o.Agent, "RIGHT", 16, 0)
	o.NameLabel:SetText("Worktree")
	o.Name = Box("auto", NAME_MAX)
	o.Name:SetPoint("LEFT", o.NameLabel, "RIGHT", 10, 0) -- the box's border sits 5px outside it
	UI.Tooltip(o.Name, "Worktree name", "Optional. Letters, digits and . - _ / only. Leave it empty and Orca names the worktree after the task.")

	o.BranchLabel = UI.Text(row, "GameFontNormalSmall", "LEFT")
	o.BranchLabel:SetPoint("LEFT", o.Name, "RIGHT", 16, 0)
	o.BranchLabel:SetText("Base branch")
	o.Branch = Box("default branch", BRANCH_MAX)
	o.Branch:SetPoint("LEFT", o.BranchLabel, "RIGHT", 10, 0)
	o.Branch:SetPoint("RIGHT", row, "RIGHT", -10, 0)
	UI.Tooltip(o.Branch, "Base branch", "Optional. The branch the new worktree starts from. Leave it empty for the repo's default branch.")

	o.Hint = UI.Text(o, "GameFontDisableSmall", "LEFT")
	o.Hint:SetPoint("TOPLEFT", row, "BOTTOMLEFT", 8, -3)
	o.Hint:SetPoint("TOPRIGHT", row, "BOTTOMRIGHT", -8, -3)
	o.Hint:SetWordWrap(false)
	return o
end

function M:NewOptionsFrame()
	return self.frame and self.frame.Pages.threads.Right.NewOptions
end

-- The typed worktree name and base branch, trimmed ("" when left at the default).
function M:NewWorktreeFields()
	local o = self:NewOptionsFrame()
	if not o then return "", "" end
	return strtrim(o.Name:GetText() or ""), strtrim(o.Branch:GetText() or "")
end

function M:ClearNewWorktreeFields()
	local o = self:NewOptionsFrame()
	if not o then return end
	o.Name:SetText("")
	o.Branch:SetText("")
	o.Name:ClearFocus()
	o.Branch:ClearFocus()
	self:UpdateNewOptions()
end

-- One of the option boxes has the keyboard (so the controller's B leaves it first).
function M:FocusedOptionBox()
	local o = self:NewOptionsFrame()
	if not o or not o:IsShown() then return nil end
	if o.Name:HasFocus() then return o.Name end
	if o.Branch:HasFocus() then return o.Branch end
end

local NAME_RULE = "Worktree names can use only letters, digits and . - _ /"

-- Placeholders, and the line under the row: what the empty fields mean, or what's
-- wrong with the name as typed.
function M:UpdateNewOptions()
	local o = self:NewOptionsFrame()
	if not o then return end
	o.Name:UpdatePlaceholder()
	o.Branch:UpdatePlaceholder()
	local name = self:NewWorktreeFields()
	if ns.Store.ValidWorktreeName(name) then
		o.NameLabel:SetTextColor(NORMAL_FONT_COLOR:GetRGB())
		o.Hint:SetText(ns.Color("grey", "Empty fields use Orca's defaults: a name from the task, and the repo's default branch."))
	else
		o.NameLabel:SetTextColor(1, 0.25, 0.25)
		o.Hint:SetText(ns.Color("red", NAME_RULE .. " (or leave it empty)."))
	end
end

-- Show the options row (or not) and hang the conversation under whatever is lowest.
function M:LayoutNewOptions(show)
	local right = self.frame.Pages.threads.Right
	local o = right.NewOptions
	o:SetShown(show)
	if self.optionsShown == show then return end
	self.optionsShown = show
	local inset = ns.Transcript.inset
	if not inset then return end
	inset:ClearAllPoints()
	inset:SetPoint("TOPLEFT", show and o or right.Header, "BOTTOMLEFT", -2, -4)
	inset:SetPoint("BOTTOMRIGHT", right.ComposerInset, "TOPRIGHT", 0, 4)
	ns.Transcript:Relayout()
end

function M:CreateButtonBar(f)
	local bar = {}
	bar.Refresh = UI.Button(f, "Refresh", 110, function()
		ns.Transport:Send("ping")
		PlaySound(SOUNDKIT.IG_MAINMENU_OPTION_CHECKBOX_ON)
	end)
	bar.Refresh:SetPoint("BOTTOMLEFT", 6, 4)
	UI.Tooltip(bar.Refresh, "Refresh", "Ask the bridge for a fresh update now.")

	bar.New = UI.Button(f, "New Thread", 130, function() M:StartNewThread() end)
	bar.New:SetPoint("LEFT", bar.Refresh, "RIGHT", 60, 0)

	bar.Back = UI.Button(f, "Back", 110, function() M:Back() end)
	bar.Back:SetPoint("BOTTOMLEFT", f, "BOTTOMLEFT", LIST_W + 18, 4)

	bar.Stop = UI.IconButton(f, "common-icon-redx", 26, "Stop the agent", function()
		if ns.viewId then
			ns.Transport:Send("stop", ns.viewId)
			PlaySound(SOUNDKIT.IG_MAINMENU_OPTION_CHECKBOX_OFF)
		end
	end)
	bar.Stop:SetPoint("LEFT", bar.Back, "RIGHT", 18, 0)

	bar.Mic = UI.IconButton(f, "voicechat-icon-mic", 26, "Dictate", function() M:ToggleDictation() end)
	bar.Mic:SetPoint("LEFT", bar.Stop, "RIGHT", 6, 0)
	UI.Tooltip(bar.Mic, nil, function()
		local b = ns.Store.data.bridge or {}
		if b.dictationHint then return b.dictationHint end
		if not b.dictation then return "No dictation backend found on the desktop." end
		return "Click, speak, click again: your words are typed into the message box (" .. b.dictation .. " on your desktop). On a controller, hold Y."
	end)

	bar.Speak = UI.IconButton(f, "voicechat-icon-speaker", 26, "Read aloud", function()
		local v = ns.Store:View()
		local last
		if v and v.msgs then
			for i = #v.msgs, 1, -1 do
				if v.msgs[i].r == "a" then last = v.msgs[i] break end
			end
		end
		if last then ns.Speak(last.t, ns.viewId, last.n) end
	end)
	bar.Speak:SetPoint("LEFT", bar.Mic, "RIGHT", 6, 0)

	bar.Shot = UI.IconButton(f, "Interface\\Icons\\INV_Misc_Spyglass_03", 26, nil, nil)
	bar.Shot:SetPoint("LEFT", bar.Speak, "RIGHT", 6, 0)
	bar.Shot:RegisterForClicks("LeftButtonUp", "RightButtonUp")
	bar.Shot:SetScript("OnClick", function(_, button)
		if button == "RightButton" then M:RemoveScreenshots() else M:AttachScreenshot() end
	end)
	UI.Tooltip(bar.Shot, "Attach a screenshot", "Adds a screenshot of the game to your next message. Right-click to remove it. /orca report also adds diagnostics.")
	UI.Tooltip(bar.Speak, nil, "Read the latest reply aloud.")

	bar.Send = UI.Button(f, "Send", 110, function() M:Send() end)
	bar.Send:SetPoint("BOTTOMRIGHT", -6, 4)
	f.Bar = bar
end

---------------------------------------------------------------------------
-- Pages, sidebar

function M:ShowPage(page)
	local f = self.frame
	if page == "usage" and ns.Store:IsOrca() then page = "threads" end -- Orca reports no usage
	self.page = page
	for name, p in pairs(f.Pages) do p:SetShown(name == page) end
	for _, tab in ipairs(f.Tabs) do tab:SetChecked(tab.page == page) end
	local threads = page == "threads"
	for _, key in ipairs({ "Back", "Stop", "Mic", "Speak", "Shot", "Send" }) do f.Bar[key]:SetShown(threads) end
	f.SidebarToggle:SetShown(threads)
	if page == "usage" then ns.Usage:Refresh() end
	if page == "settings" then ns.Settings:Refresh() end
	self:Refresh()
	ns:Fire("PageChanged", page)
end

-- Orca reports no usage limits: drop that tab and move Settings up into its place.
function M:UpdateTabs()
	local f = self.frame
	local orca = ns.Store:IsOrca()
	f.Tabs[1].tooltipText = orca and "Agents" or "Threads"
	if self.tabsOrca == orca then return end
	self.tabsOrca = orca
	f.Tabs[2]:SetShown(not orca)
	f.Tabs[3]:ClearAllPoints()
	f.Tabs[3]:SetPoint("TOPLEFT", f, "TOPRIGHT", 0, -36 - (orca and 1 or 2) * 48)
	if orca and self.page == "usage" then self:ShowPage("threads") end
end

function M:ToggleSidebar(show)
	local page = self.frame.Pages.threads
	if show == nil then show = not page.Left:IsShown() end
	page.Left:SetShown(show)
	page.Divider:SetShown(show)
	page.Right:ClearAllPoints()
	if show then
		page.Right:SetPoint("TOPLEFT", page.Left, "TOPRIGHT", 4, 0)
	else
		page.Right:SetPoint("TOPLEFT", 0, 0)
	end
	page.Right:SetPoint("BOTTOMRIGHT")
	self.frame.Bar.Refresh:SetShown(show)
	self.frame.Bar.New:SetShown(show)
	self.frame.Bar.Back:ClearAllPoints()
	if show then
		self.frame.Bar.Back:SetPoint("BOTTOMLEFT", self.frame, "BOTTOMLEFT", LIST_W + 18, 4)
	else
		self.frame.Bar.Back:SetPoint("BOTTOMLEFT", self.frame, "BOTTOMLEFT", 6, 4)
	end
	self.frame.SidebarToggle.Icon:SetRotation(show and 0 or math.pi)
	ns.Transcript:Relayout()
end

---------------------------------------------------------------------------
-- Selecting threads, drafts

function M:SaveDraft()
	if not self.composer then return end
	local key = self.mode == "new" and "__new" or ns.viewId
	if key then
		local text = self.composer:GetInputText()
		ns.db.drafts[key] = (text and text ~= "") and text or nil
	end
end

function M:LoadDraft()
	local key = self.mode == "new" and "__new" or ns.viewId
	self.composer:SetText(key and ns.db.drafts[key] or "")
	self:UpdateCounter()
end

function M:SelectThread(id, opts)
	self:Create()
	if id == ns.viewId and self.mode == "thread" then
		if opts and opts.show then self:Open() end
		return
	end
	self:SaveDraft()
	self.mode = "thread"
	self.previous = ns.viewId
	ns.viewId = id
	local t = ns.Store:Thread(id)
	if t and t.un then ns.Transport:Send("read", id) end
	ns.Transport:Touch()
	self:LoadDraft()
	if opts and opts.show then self:Open() end
	if self.page ~= "threads" then self:ShowPage("threads") end
	self:Refresh()
	ns:Fire("ViewSelected", id)
end

function M:Back()
	if self.mode == "new" then
		self.mode = "thread"
		self:LoadDraft()
		self:Refresh()
		return
	end
	if not self.frame.Pages.threads.Left:IsShown() then
		self:ToggleSidebar(true)
		return
	end
	self:SaveDraft()
	ns.viewId = nil
	ns.Transport:Touch()
	self:LoadDraft()
	self:Refresh()
	ns:Fire("ViewSelected", nil)
end

function M:StartNewThread(projectId)
	self:Create()
	self:SaveDraft()
	self.mode = "new"
	self.newModel, self.newEffort, self.newAgent = nil, nil, nil
	local filter = ns.db.settings.project
	self.newProject = projectId or (filter ~= "all" and filter) or ns.db.settings.lastProject
	if not ns.Store.projectsById[self.newProject or ""] then
		local first = ns.Store.data.projects[1]
		self.newProject = first and first.id
	end
	self:LoadDraft()
	if self.page ~= "threads" then self:ShowPage("threads") end
	self:Open()
	self:Refresh()
	self.composer:SetFocus()
end

function M:HeaderAction()
	local t = ns.Store:Thread(ns.viewId)
	if not t then return end
	if t.s == "settled" then
		ns.Transport:Send("unsettle", t.id)
		PlaySound(SOUNDKIT.IG_MAINMENU_OPTION_CHECKBOX_ON)
	else
		ns.Transport:Send("settle", t.id)
		PlaySound(SOUNDKIT.IG_QUEST_LIST_COMPLETE or SOUNDKIT.IG_MAINMENU_OPTION_CHECKBOX_ON)
	end
end

---------------------------------------------------------------------------
-- Sending

function M:UpdateCounter()
	local right = self.frame and self.frame.Pages.threads.Right
	if not right then return end
	local text = self.composer:GetInputText() or ""
	right.Counter:SetText(2000 - strlenutf8(text))
end

function M:Send(textOverride)
	local text = textOverride or self.composer:GetInputText() or ""
	text = strtrim(text)
	if text == "" then return end
	if #text > 2300 then
		ns.Print("That message is too long to send from the game (max ~2,000 characters).")
		return
	end
	if self.mode == "new" then
		if not self.newProject then
			ns.Print(ns.Store:IsOrca() and "Pick a project for the new agent first." or "Pick a project for the new thread first.")
			return
		end
		local agent = self:ChosenNewAgent()
		if agent then
			-- Orca: new <project> <text> <agent> [<worktree name> [<base branch>]],
			-- with "" for a name left empty before a branch, and no trailing empties.
			local name, branch = self:NewWorktreeFields()
			if not ns.Store.ValidWorktreeName(name) then
				self:UpdateNewOptions()
				ns.Print(ns.Color("red", NAME_RULE .. ". Change the name, or leave it empty for an automatic one."))
				PlaySound(SOUNDKIT.IG_MAINMENU_OPTION_CHECKBOX_OFF)
				if not ns.Gamepad:IsActive() then self:NewOptionsFrame().Name:SetFocus() end
				return
			end
			if #text + #name + #branch > 2300 then
				ns.Print("That message is too long to send from the game (max ~2,000 characters).")
				return
			end
			ns.db.settings.lastProject = self.newProject
			ns.db.lastAgent = agent
			local args = { self.newProject, text, agent }
			if name ~= "" or branch ~= "" then args[4] = name end
			if branch ~= "" then args[5] = branch end
			self.pendingNew = ns.Transport:Send("new", unpack(args, 1, #args))
			self.pendingNewFields = { text = text, name = name, branch = branch }
			self:ClearNewWorktreeFields()
		else
			ns.db.settings.lastProject = self.newProject
			local instanceId, slug = ns.Store.SplitModelKey(self:ChosenNewModel())
			local effort = self:ChosenNewEffort()
			if effort then
				-- An empty model means T3 Code's default, at this level.
				self.pendingNew = ns.Transport:Send("new", self.newProject, text, instanceId or "", slug or "", effort)
			else
				self.pendingNew = ns.Transport:Send("new", self.newProject, text, instanceId, slug)
			end
			self.pendingNewFields = nil
		end
		ns.db.drafts.__new = nil
	elseif ns.viewId and not textOverride and ns.Transcript:CustomAnswer(text) then
		ns.db.drafts[ns.viewId] = nil
	elseif ns.viewId then
		if ns.db.settings.steerFollowUps then
			ns.Transport:Send("send", ns.viewId, text, "steer")
		else
			ns.Transport:Send("send", ns.viewId, text)
		end
		ns.Transcript:AddLocalEcho(ns.viewId, text)
		ns.db.drafts[ns.viewId] = nil
	else
		ns.Print(ns.Store:IsOrca() and "Pick an agent, or start a new one." or "Pick a thread, or start a new one.")
		return
	end
	if not textOverride then
		self.composer:SetText("")
		self.composer:ClearFocus()
	end
	PlaySound(SOUNDKIT.TELL_MESSAGE or SOUNDKIT.IG_MAINMENU_OPTION_CHECKBOX_ON)
	self:Refresh()
end

---------------------------------------------------------------------------
-- Screenshots and reports

function M:ShotKey()
	if self.mode == "new" then return "new" end
	return ns.viewId
end

function M:ShotCount()
	if self.mode == "new" then return ns.Store.data.newShots or 0 end
	local v = ns.Store:View()
	return v and v.shots or 0
end

function M:ShotHint()
	local n = self:ShotCount()
	if n > 0 then
		return ns.Color("gold", string.format("%d screenshot%s attached", n, n == 1 and "" or "s")) .. ns.Color("grey", " (right-click the spyglass to remove)")
	end
end

function M:AttachScreenshot()
	local key = self:ShotKey()
	if not key then
		ns.Print(ns.Store:IsOrca() and "Open an agent (or start a new one) first, then attach the screenshot."
			or "Open a thread (or start a new one) first, then attach the screenshot.")
		return
	end
	ns.Transport:Send("shot", key)
	PlaySound(SOUNDKIT.IG_MAINMENU_OPTION_CHECKBOX_ON)
end

function M:RemoveScreenshots()
	local key = self:ShotKey()
	if key then ns.Transport:Send("unshot", key) end
end

-- Fill the message box with diagnostics (and attach a screenshot) for a bug report.
function M:Report(note)
	self:Open()
	if not ns.viewId and self.mode ~= "new" then self:StartNewThread() end
	local T = ns.Transport
	local b = ns.Store.data.bridge or {}
	local lines = { "--- " .. ns.AppName() .. " for World of Warcraft diagnostics ---" }
	table.insert(lines, string.format("addon %s, bridge %s, %s %s (%s)", ns.version, b.version or "?", ns.Store:IsOrca() and "Orca" or "T3", b.t3 or "?", b.server or "?"))
	table.insert(lines, string.format("link %s, signals %s via %s, live updates left %d/%d, queued %d", T:BridgeState(), T.signals, tostring(T.channel), T:SlotsLeft(), T.slotCount, #T.queue))
	if b.envs then
		local m = {}
		for _, e in ipairs(b.envs) do table.insert(m, e.label .. "=" .. e.state) end
		table.insert(lines, "machines " .. table.concat(m, ", "))
	end
	table.insert(lines, string.format("page %s, mode %s, gamepad %s, window scale %.2f", self.page, self.mode, tostring(ns.Gamepad:IsActive()), self.frame:GetScale() or 1))
	local errs = ns.db.errors or {}
	for i = math.max(1, #errs - 2), #errs do
		table.insert(lines, "error " .. date("%H:%M:%S", errs[i].t) .. ": " .. errs[i].msg)
	end
	local text = table.concat(lines, "\n")
	if note and note ~= "" then text = note .. "\n\n" .. text end
	local current = self.composer:GetInputText() or ""
	self.composer:SetText(current ~= "" and (current .. "\n\n" .. text) or text)
	self:AttachScreenshot()
	self.composer:SetFocus()
end

local SCALES = { normal = 1, large = 1.15, xlarge = 1.3 }

function M:ApplyScale()
	if not self.frame then return end
	local pref = ns.db.settings.windowScale or "auto"
	local scale = SCALES[pref] or ((ns.Gamepad and ns.Gamepad:IsActive()) and 1.15 or 1)
	self.frame:SetScale(scale)
end

function M:ToggleDictation()
	if self.dictating then
		self.dictating = false
		ns.Transport:Send("dictate", "stop")
	else
		local b = ns.Store.data.bridge
		if b and b.dictationHint then
			-- Push-to-talk repeats while the key is held; say this once, not every time.
			local now = GetTime()
			if not self.dictNoteAt or now - self.dictNoteAt > 5 then
				self.dictNoteAt = now
				ns.Print(b.dictationHint)
			end
			return
		end
		self.dictating = true
		self:Open()
		self.composer:SetFocus()
		self.dictCmd = ns.Transport:Send("dictate", "start")
	end
	self:Refresh()
end

---------------------------------------------------------------------------
-- Status line and refresh

local LINK_TEXT = {
	connected = { "green", "Connected" },
	waiting = { "orange", "Waiting for the bridge… (run orca-wow install on your desktop)" },
	stale = { "red", "Bridge not responding — is orca-wow running?" },
	t3offline = { "red", "Bridge connected, but T3 Code is offline" },
	exhausted = { "orange", "Live updates paused — /reload to resume" },
}

function M:StatusLine()
	local T = ns.Transport
	if T.slotError == "MISSING" then
		return ns.Color("red", "Live-update files missing — run orca-wow install, then restart WoW")
	end
	local state = T:BridgeState()
	local entry = LINK_TEXT[state] or LINK_TEXT.waiting
	local text = ns.Color(entry[1], entry[2])
	if state == "t3offline" and ns.Store:IsOrca() then
		if ns.Store.data.bridge.t3 == "connecting" then
			text = ns.Color("orange", "Orca: connecting…")
		else
			text = ns.Color("red", "Orca: offline") .. ns.Color("grey", " — open Orca on your computer")
		end
	end
	if #T.queue > 0 then
		text = text .. ns.Color("grey", "  ·  sending…")
	end
	local left = T:SlotsLeft()
	if state == "connected" and left > 0 and left < math.max(40, T.slotCount * 0.15) then
		text = text .. ns.Color("orange", string.format("  ·  %d live updates left", left))
	end
	if self.dictating then
		text = text .. ns.Color("orange", "  ·  listening… release to finish")
	elseif self.dictState == "transcribing" then
		text = text .. ns.Color("orange", "  ·  transcribing…")
	end
	return text
end

function M:UpdateRefreshButton()
	local f = self.frame
	if not f then return end
	local T = ns.Transport
	local low = T.exhausted or (T.slotCount > 0 and T:SlotsLeft() < T.slotCount * 0.15)
	f.RefreshSlots:SetShown(low and not InCombatLockdown())
end

-- Blizzard's edit box keeps a shown placeholder as the box's text, and only swaps
-- it while the box is empty. Changed in place, the old placeholder stayed behind as
-- text that focusing no longer cleared, so typing went after it. Set it again on an
-- empty box so the new one replaces the old.
function M:SetPlaceholder(text)
	if self.placeholder == text then return end
	self.placeholder = text
	self.composer:SetDefaultText(text)
	if self.composer:GetInputText() == "" then self.composer:SetText("") end
end

function M:Refresh()
	local f = self.frame
	if not f or not f:IsShown() then return end
	f.Status:SetText(self:StatusLine())
	self:UpdateRefreshButton()
	local orca = ns.Store:IsOrca()
	f:SetTitle(ns.AppName())
	self:UpdateTabs()
	f.Bar.New:SetText(orca and "New agent" or "New Thread")

	local right = f.Pages.threads.Right
	local header = right.Header
	local t = ns.Store:Thread(ns.viewId)
	if self.mode == "new" then
		local agent = self:SetupAgentDropdown()
		self:LayoutNewOptions(agent ~= nil)
		if agent then self:UpdateNewOptions() end
		if orca then
			local project = ns.Store:ProjectName(self.newProject)
			local what = agent and ("New " .. ns.Store:AgentLabel(agent) .. " agent") or "New agent"
			f.Subtitle:SetText(project ~= "" and (what .. " in " .. project) or what)
		else
			f.Subtitle:SetText("New Thread")
		end
		header.Text:SetText(ns.Color("gold", orca and "New agent in" or "New thread in"))
		header.Action:Hide()
		header.Archive:Hide()
		header.Project:Show()
		self:SetupProjectDropdown()
		local withModel = self:SetupModelDropdown()
		local withEffort = withModel and self:SetupEffortDropdown()
		if not withEffort then header.Effort:Hide() end
		header.Model.tipBody = "The model the new thread starts on. It's remembered for this project."
		header.Effort.tipBody = "How hard the model reasons on the new thread. It's remembered for this project."
		header.Effort:ClearAllPoints()
		header.Effort:SetPoint("RIGHT", -6, 0)
		header.Model:ClearAllPoints()
		header.Model:SetPoint("RIGHT", withEffort and header.Effort or header, withEffort and "LEFT" or "RIGHT", withEffort and -4 or -6, 0)
		header.Project:ClearAllPoints()
		if withModel then
			header.Project:SetPoint("RIGHT", header.Model, "LEFT", -6, 0)
		else
			header.Project:SetPoint("RIGHT", -6, 0)
		end
		header.Text:ClearAllPoints()
		header.Text:SetPoint("LEFT", 12, 0)
		header.Text:SetPoint("RIGHT", header.Project, "LEFT", -8, 0)
		header.Text:SetJustifyH("RIGHT")
		self:SetPlaceholder("Describe what the agent should do  (Shift+Enter for a new line)")
		right.Hint:SetText(self:ShotHint() or "")
		f.Bar.Send:SetText("Start")
	else
		self:LayoutNewOptions(false)
		header.Text:ClearAllPoints()
		header.Text:SetPoint("LEFT", 12, 0)
		header.Text:SetPoint("RIGHT", -110, 0)
		header.Text:SetJustifyH("CENTER")
		header.Project:Hide()
		f.Bar.Send:SetText("Send")
		if t then
			f.Subtitle:SetText(t.title)
			local status = ns.Color(ns.Store.StatusColor(t.s), ns.Store.StatusText(t.s))
			local age = (t.s == "working" and t.st) and ns.Duration(time() - t.st) or ns.Ago(t.u)
			header.Text:SetText(string.format("%s  ·  %s  ·  %s", status, ns.Store:ProjectName(t.p), age))
			header.Action:SetShown(true)
			header.Action:SetText(t.s == "settled" and "Reopen" or (orca and "Mark done" or "Settle"))
			header.Archive:SetText(orca and "Sleep worktree" or "Archive")
			header.Archive:SetWidth(orca and 124 or 86)
			header.Archive:SetShown(t.s == "settled")
			local withModel = self:SetupModelDropdown()
			local withEffort = withModel and self:SetupEffortDropdown()
			if not withEffort then header.Effort:Hide() end
			header.Model.tipBody = "The model for this thread. A change applies from the next reply on."
			header.Effort.tipBody = "How hard the model reasons on this thread. A change applies from the next reply on."
			local anchor = t.s == "settled" and header.Archive or header.Action
			header.Effort:ClearAllPoints()
			header.Effort:SetPoint("RIGHT", anchor, "LEFT", -4, 0)
			header.Model:ClearAllPoints()
			header.Model:SetPoint("RIGHT", withEffort and header.Effort or anchor, "LEFT", -4, 0)
			local pickers = (withModel and header.Model:GetWidth() + 4 or 0) + (withEffort and header.Effort:GetWidth() + 4 or 0)
			header.Text:SetPoint("RIGHT", (t.s == "settled" and -(114 + header.Archive:GetWidth()) or -110) - pickers, 0)
			local busy = ns.db.settings.steerFollowUps and "Steer the agent" or "Queue a follow-up"
			if orca then
				-- Orca types into the agent's terminal: now, or once it's idle.
				busy = ns.db.settings.steerFollowUps and "Type to the agent now" or "Send when the agent is idle"
			end
			self:SetPlaceholder((t.s == "working" and busy or "Message the agent") .. "  (Shift+Enter for a new line)")
		else
			f.Subtitle:SetText(ns.Color("grey", orca and "No agent selected" or "No thread selected"))
			header.Text:SetText(ns.Color("grey", orca and "Pick an agent on the left, or start a new one" or "Pick a thread on the left, or start a new one"))
			header.Action:Hide()
			header.Archive:Hide()
			header.Model:Hide()
			header.Effort:Hide()
		end
		right.Hint:SetText(self:ShotHint() or (ns.Gamepad and ns.Gamepad:IsActive() and ns.Gamepad:HintText()) or "")
	end
	f.Bar.Stop:SetEnabled(t ~= nil and t.s == "working" and self.mode ~= "new")
	f.Bar.Stop.Icon:SetDesaturated(not f.Bar.Stop:IsEnabled())
	local bridge = ns.Store.data.bridge
	local canDictate = self.dictating or not (bridge and bridge.dictationHint)
	f.Bar.Mic:SetEnabled(canDictate)
	f.Bar.Mic.Icon:SetDesaturated(not canDictate)
	f.Bar.Mic.Icon:SetVertexColor(self.dictating and 1 or 1, self.dictating and 0.3 or 1, self.dictating and 0.3 or 1)
	f.Bar.Back:SetEnabled(self.mode == "new" or ns.viewId ~= nil or not f.Pages.threads.Left:IsShown())
	self:UpdateCounter()
	ns.ThreadList:Refresh()
	ns.Transcript:Refresh()
end

---------------------------------------------------------------------------
-- Model picker

-- The model the player picked for the new thread, now or last time in this project.
-- Nil means T3 Code picks when the thread starts.
function M:ChosenNewModel()
	if ns.Store:IsOrca() then return nil end -- Orca's agents choose their own model
	if self.newModel then return self.newModel end
	local saved = self.newProject and ns.db.models[self.newProject]
	if ns.Store:Offers(ns.Store.EnvOf(self.newProject), saved) then return saved end
end

-- What the picker shows: the chosen model, else T3 Code's default for the project.
function M:NewThreadModel()
	local chosen = self:ChosenNewModel()
	if chosen then return chosen end
	local env = ns.Store.EnvOf(self.newProject)
	local p = ns.Store.projectsById[self.newProject or ""]
	if p and p.dm then return p.dm end
	for _, o in ipairs(ns.Store:ModelOptions(env) or {}) do
		if not o.header then return o.value end
	end
end

-- The open thread's model, or the one just picked for it until T3 confirms it.
function M:ThreadModel(t)
	local current = ns.Store.ModelKey(t.mi, t.m)
	local pending = self.pendingModel
	if pending and pending.thread == t.id then
		if pending.value == current or GetTime() - pending.at > 30 then
			self.pendingModel = nil
		else
			return pending.value
		end
	end
	return current
end

-- Fill the model dropdown for what's on screen. Returns whether it's shown.
function M:SetupModelDropdown()
	local dd = self.frame.Pages.threads.Right.Header.Model
	-- Orca's agents choose their own model (and a list from an earlier T3 bridge may
	-- still be held), so no picker there.
	if ns.Store:IsOrca() then
		dd:Hide()
		return false
	end
	local env, current
	if self.mode == "new" then
		env, current = ns.Store.EnvOf(self.newProject), self:NewThreadModel()
	else
		local t = ns.Store:Thread(ns.viewId)
		if t then env, current = ns.Store.EnvOf(t.id), self:ThreadModel(t) end
	end
	local options = env and ns.Store:ModelOptions(env, current)
	if not options or (self.mode ~= "new" and not current) then
		dd:Hide()
		return false
	end
	dd.value = current
	dd:SetOptions(options)
	-- Wide enough for "Model · Provider" where it fits, so the provider isn't cut off.
	local textW = dd.Text:GetUnboundedStringWidth() or 0
	dd:SetWidth(math.min(self.mode == "new" and 200 or 220, math.max(150, math.ceil(textW) + 40)))
	dd:Show()
	return true
end

-- The reasoning level picked for the new thread, now or last time in this project,
-- when the model it starts on offers it. Nil means the model's own.
function M:ChosenNewEffort()
	if ns.Store:IsOrca() then return nil end
	local options = ns.Store:EffortOptions(ns.Store.EnvOf(self.newProject), self:NewThreadModel())
	if ns.Store.HasOption(options, self.newEffort) then return self.newEffort end
	local saved = self.newProject and ns.db.efforts[self.newProject]
	if ns.Store.HasOption(options, saved) then return saved end
end

-- The open thread's reasoning level, or the one just picked for it until T3 confirms it.
function M:ThreadEffort(t)
	local pending = self.pendingEffort
	if pending and pending.thread == t.id then
		if pending.value == t.re or GetTime() - pending.at > 30 then
			self.pendingEffort = nil
		else
			return pending.value
		end
	end
	return t.re
end

-- Fill the reasoning dropdown for the model on screen. Returns whether it's shown.
function M:SetupEffortDropdown()
	local dd = self.frame.Pages.threads.Right.Header.Effort
	local env, model, current
	if self.mode == "new" then
		env, model = ns.Store.EnvOf(self.newProject), self:NewThreadModel()
		current = self:ChosenNewEffort()
		local p = ns.Store.projectsById[self.newProject or ""]
		if not current then
			-- What the bridge would carry over: T3's own pick when it's this model,
			-- else the level last used with the model.
			if p and p.dm == model then current = p.de else current = ns.Store:LastEffort(env, model) end
		end
	else
		local t = ns.Store:Thread(ns.viewId)
		if t then
			env, model, current = ns.Store.EnvOf(t.id), self:ThreadModel(t), self:ThreadEffort(t)
			-- Just switched to another model: it brings the level last used with it.
			if model ~= ns.Store.ModelKey(t.mi, t.m) and not (self.pendingEffort and self.pendingEffort.thread == t.id) then
				current = ns.Store:LastEffort(env, model)
			end
		end
	end
	local options, default = ns.Store:EffortOptions(env, model)
	if not options then
		dd:Hide()
		return false
	end
	-- A level the model doesn't have (after a model switch, say) shows as its default.
	dd.value = ns.Store.HasOption(options, current) and current or default
	dd:SetOptions(options)
	dd:Show()
	return true
end

function M:PickEffort(value)
	if self.mode == "new" then
		self.newEffort = value
		if self.newProject then ns.db.efforts[self.newProject] = value end
	else
		local t = ns.Store:Thread(ns.viewId)
		if not t or value == self:ThreadEffort(t) then return end
		local instanceId, slug = ns.Store.SplitModelKey(self:ThreadModel(t))
		if not instanceId then return end
		self.pendingEffort = { thread = t.id, value = value, at = GetTime(), cmd = ns.Transport:Send("model", t.id, instanceId, slug, value) }
	end
	self:Refresh()
end

function M:PickModel(value)
	if self.mode == "new" then
		self.newModel = value
		if self.newProject then ns.db.models[self.newProject] = value end
	else
		local t = ns.Store:Thread(ns.viewId)
		if not t or value == self:ThreadModel(t) then return end
		local instanceId, slug = ns.Store.SplitModelKey(value)
		if not instanceId then return end
		self.pendingModel = { thread = t.id, value = value, at = GetTime(), cmd = ns.Transport:Send("model", t.id, instanceId, slug) }
	end
	self:Refresh()
end

---------------------------------------------------------------------------
-- Agent picker (Orca)

-- The agent the new worktree starts with: picked now, else last time, else the one
-- Orca preselects. Nil when the bridge offers no agents (T3 Code, older bridges).
function M:ChosenNewAgent()
	if not ns.Store:IsOrca() then return nil end
	local options, default = ns.Store:AgentOptions()
	if not options then return nil end
	for _, id in ipairs({ self.newAgent or false, ns.db.lastAgent or false, default or false }) do
		if id and ns.Store.HasOption(options, id) then return id end
	end
	return options[1].value
end

-- Fill the agent dropdown; returns the agent shown, or nil when there's no picker.
function M:SetupAgentDropdown()
	local agent = self:ChosenNewAgent()
	if not agent then return nil end
	self:NewOptionsFrame().Agent:SetOptions((ns.Store:AgentOptions()), agent)
	return agent
end

function M:PickAgent(value)
	self.newAgent = value
	ns.db.lastAgent = value
	self:Refresh()
end

function M:SetupProjectDropdown()
	local options = {}
	for _, p in ipairs(ns.Store.data.projects) do table.insert(options, { value = p.id, label = p.name }) end
	self.frame.Pages.threads.Right.Header.Project:SetOptions(options, M.newProject)
end

---------------------------------------------------------------------------

function M:Open()
	self:Create()
	if not self.frame:IsShown() then self.frame:Show() end
end

function M:Toggle()
	self:Create()
	self.frame:SetShown(not self.frame:IsShown())
end

ns:On("Login", function()
	M:Create()
end)
-- Dictation results arrive in the snapshot; type them into the message box.
function M:HandleDictation(d)
	if type(d) ~= "table" or type(d.n) ~= "number" then return end
	if d.n <= (ns.db.lastDictN or 0) then return end
	ns.db.lastDictN = d.n
	if time() - math.floor(d.n / 1000) > 90 then return end -- left over from before a /reload
	-- A failed start (no backend, the bridge dropped it) must not leave the mic stuck
	-- "on", or the next press sends stop instead of start.
	if d.state ~= "listening" and d.state ~= "transcribing" then self.dictating = false end
	self.dictState = d.state
	if d.state == "done" and d.text and d.text ~= "" then
		self:Create()
		local box = self.composer
		local current = (box:GetInputText() or ""):gsub("%s+$", "")
		-- The backend also sends a paste keystroke; if that did land, don't add it twice.
		if not current:find(d.text, 1, true) then
			box:SetText(current ~= "" and (current .. " " .. d.text) or d.text)
		end
		self.dictState = nil
		PlaySound(SOUNDKIT.TELL_MESSAGE or SOUNDKIT.IG_MAINMENU_OPTION_CHECKBOX_ON)
		if ns.db.settings.dictateSend then
			self:Send()
		elseif ns.Gamepad.capturing then
			ns.Gamepad:Highlight(box) -- A sends it
			box:SetFocus()
		else
			box:SetFocus()
		end
	elseif d.state == "empty" then
		self.dictState = nil
		ns.Print("Didn't catch anything — hold to talk and try again.")
	elseif d.state == "error" then
		self.dictState = nil
		ns.Print(ns.Color("red", "Dictation: " .. (d.err or "failed")))
	elseif d.state == "cancelled" then
		self.dictState = nil
	end
	if self.frame and self.frame:IsShown() then self.frame.Status:SetText(self:StatusLine()) end
end

ns:On("DataChanged", function()
	M:HandleDictation(ns.Store.data.dict)
end)

ns:On("DataChanged", function()
	if M.frame and M.frame:IsShown() then M:Refresh() end
end)
ns:On("LinkChanged", function()
	if M.frame and M.frame:IsShown() then
		M.frame.Status:SetText(M:StatusLine())
		M:UpdateRefreshButton()
	end
end)
ns:On("CommandResult", function(r)
	if r.ok == false and r.id == M.dictCmd then
		-- The start was refused before the bridge sent a dictation state; put the
		-- mic back so the next press starts instead of sending stop.
		M.dictCmd = nil
		M.dictating = false
		if M.frame and M.frame:IsShown() then M:Refresh() end
	end
	if r.ok == false and r.msg then
		ns.Print(ns.Color("red", r.msg))
		if UIErrorsFrame then UIErrorsFrame:AddMessage(ns.AppName() .. ": " .. r.msg, 1, 0.2, 0.2) end
	end
	if r.ok == false then
		local refused
		if M.pendingModel and r.id == M.pendingModel.cmd then M.pendingModel, refused = nil, true end
		if M.pendingEffort and r.id == M.pendingEffort.cmd then M.pendingEffort, refused = nil, true end
		if refused and M.frame and M.frame:IsShown() then M:Refresh() end
	end
	if r.id == M.pendingNew then
		M.pendingNew = nil
		local sent = M.pendingNewFields
		M.pendingNewFields = nil
		if r.ok == false and sent and M.mode == "new" then
			-- Orca refused it (a taken name, a missing branch): put back what was typed
			-- so the player can fix it instead of typing it all again.
			local o = M:NewOptionsFrame()
			local name, branch = M:NewWorktreeFields()
			if name == "" and branch == "" then
				o.Name:SetText(sent.name)
				o.Branch:SetText(sent.branch)
			end
			if (M.composer:GetInputText() or "") == "" then M.composer:SetText(sent.text) end
			M:UpdateNewOptions()
			if M.frame:IsShown() then M:Refresh() end
		end
		if r.ok and r.open then
			M.mode = "thread"
			M:SelectThread(r.open)
		end
	end
end)

-- Live elapsed timers in the header.
C_Timer.NewTicker(1, ns.Safe(function()
	if M.frame and M.frame:IsShown() and M.page == "threads" then
		local t = ns.Store:Thread(ns.viewId)
		if t and t.s == "working" and M.mode == "thread" then M:Refresh() end
	end
end))
