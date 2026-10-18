-----------------------------------------------------------------------
--  PZ2QoL.Autosave
--
--  More reliable autosaves. The game autosaves every 10 minutes, but it
--  cancels the pending autosave whenever the park world closes (a trip to
--  the hub: Animal Storage, Market) and starts a fresh 10 minutes on the
--  way back (DarwinWorld.OnDeactivate / OnActivate), so a player who goes
--  back and forth gets no autosaves at all.
--
--  This module keeps its own clock: time spent in the park since the zoo
--  was last saved (any save: the game's autosave, ours, or a manual save).
--  The clock keeps running across hub trips. When it reaches the chosen
--  interval it asks the game for an autosave with the game's own call,
--  api.save.RequestAutosave(player, "zooauto") (used by the game's own
--  modes and scenario events). The game then writes its usual rotating
--  autosave slots and arms the next one; the mod writes no file itself.
--
--  Setting: off (the game's own behaviour) or every 2..60 minutes; 2 is
--  the minimum. Default 5. The setting lasts for the game session (the
--  UI cannot keep files).
--
--  JS -> Lua: PZ2QoL_AutosaveSet(minutes), PZ2QoL_AutosaveNow(),
--             PZ2QoL_AutosaveGet()
--  Lua -> JS: PZ2QoL_AutosaveState(json)
-----------------------------------------------------------------------
local global   = _G
local api      = global.api
local pcall    = global.pcall
local type     = global.type
local tostring = global.tostring
local math     = global.math
local string   = global.string
local ipairs   = global.ipairs

local Autosave = module(...)

Autosave.nMinMinutes = 2
Autosave.nMaxMinutes = 60
Autosave.nDefaultMinutes = 5
Autosave.nSettleSeconds = 30   -- after the park opens, before a due save
Autosave.nRetrySeconds = 60    -- after a request that failed or got no answer
Autosave.nAnswerSeconds = 90   -- how long a request may take
Autosave.nPushSeconds = 10     -- state to the UI while in the park

Autosave.nMinutes = Autosave.nDefaultMinutes
Autosave.nElapsed = 0          -- seconds in the park since the zoo was saved
Autosave.bArmed = false        -- the game has an autosave set up (park open)
Autosave.nArmedAt = nil
Autosave.nPendingSince = nil   -- our request waits for the game's answer
Autosave.bPendingManual = false
Autosave.nRetryAt = 0
Autosave.nLastTick = nil
Autosave.nLastPush = 0
Autosave.nSavedAt = nil        -- clock time of the last save of the zoo
Autosave.sLastKind = ""        -- 'game' | 'mod' | 'manual'
Autosave.sLastError = ""
Autosave.tShown = {}
Autosave.tViews = {}

local function now()
	local bOk, n = pcall(function()
		return api.time.PerformanceTimeToMilliseconds(api.time.GetPerformanceTimer()) / 1000
	end)
	return bOk and n or 0
end

-- 0 (off) or a whole number of minutes in [2, 60]
Autosave.ClampMinutes = function(self, n)
	n = global.tonumber(n)
	if n == nil or n <= 0 then
		return 0
	end
	n = math.floor(n + 0.5)
	return math.max(self.nMinMinutes, math.min(self.nMaxMinutes, n))
end

Autosave._Mark = function(self, sName)
	if self.Core then
		pcall(self.Core.Mark, self.Core, sName)
	end
end

-----------------------------------------------------------------------
-- What the game does (wrapped, originals always called)
-----------------------------------------------------------------------
Autosave._Saved = function(self, sKind)
	self.nElapsed = 0
	self.nSavedAt = now()
	self.sLastKind = sKind
	self.sLastError = ""
	self.nRetryAt = 0
	self:_Mark("autosave_saved_" .. sKind)
	self:Push()
end

Autosave._Failed = function(self, sWhy)
	self.nPendingSince = nil
	self.bPendingManual = false
	self.nRetryAt = now() + self.nRetrySeconds
	self.sLastError = tostring(sWhy)
	self:_Mark("autosave_failed")
	local Errors = global.package.loaded["pz2qol.errors"]
	if Errors then
		-- shown once per reason and session, logged every time
		local bShow = not self.tShown[self.sLastError]
		self.tShown[self.sLastError] = true
		pcall(Errors.Report, Errors, "mod", "Autosave failed", self.sLastError .. " The mod tries again in a minute.", bShow)
	end
	self:Push()
end

-- the game's callback after an autosave was written (or failed)
Autosave._OnAutosaveComplete = function(self, tDetails)
	if tDetails == nil then
		return -- the game arming its first autosave, not a write
	end
	-- the game re-arms the next slot right after this; wait for it
	self.bArmed = false
	local bOurs = self.nPendingSince ~= nil
	self.nPendingSince = nil
	self.bPendingManual = false
	if type(tDetails) == "table" and tDetails.exception ~= nil then
		self:_Failed("The game could not write the autosave (" .. tostring(tDetails.exception) .. ").")
		return
	end
	if bOurs then
		-- keep the game's own 10-minute timer from adding a save right after ours
		pcall(function() api.save.ResetAutosaveTimer(api.player.GetGameOwner(), self.sAutoIdent) end)
	end
	self:_Saved(bOurs and "mod" or "game")
end

Autosave._PatchManager = function(self, tModule)
	local fn = tModule.OnAutosaveComplete
	if type(fn) ~= "function" then
		self:_Mark("autosave_no_callback")
		return
	end
	tModule.OnAutosaveComplete = function(oMgr, tDetails, ...)
		pcall(self._OnAutosaveComplete, self, tDetails)
		return fn(oMgr, tDetails, ...)
	end
end

Autosave._PatchSaveAPI = function(self)
	local tSave = api.save
	if type(tSave) ~= "table" then
		self:_Mark("autosave_no_api")
		return false
	end
	pcall(function() self.sZooIdent = tSave.GetIdentForSaveID(tSave.ID_Zoo) end)
	pcall(function() self.sAutoIdent = tSave.GetIdentForSaveID(tSave.ID_ZooAutosave) end)
	self.sZooIdent = type(self.sZooIdent) == "string" and self.sZooIdent or "zoo"
	self.sAutoIdent = type(self.sAutoIdent) == "string" and self.sAutoIdent or "zooauto"
	local function after(sName, fnAfter)
		local fn = tSave[sName]
		if type(fn) ~= "function" then
			return
		end
		pcall(function()
			tSave[sName] = function(...)
				local t = global.table.pack(fn(...))
				pcall(fnAfter, ...)
				return global.table.unpack(t, 1, t.n)
			end
		end)
	end
	local function armed()
		if not self.bArmed then
			self.bArmed = true
			self.nArmedAt = now()
			self:Push()
		end
	end
	after("SetAutosave", armed)
	after("SetNewAutosave", armed)
	after("UnsetAutosave", function()
		-- the park world closed (hub trip, quit): the clock pauses
		self.bArmed = false
		self.nPendingSince = nil
		self.bPendingManual = false
	end)
	-- a manual save of the zoo (ParkLoadSaveManager.SaveParkToSaveToken)
	after("RequestSave", function(_, tInfo)
		if type(tInfo) == "table" and tInfo.type == self.sZooIdent then
			self:_Saved("manual")
		end
	end)
	return true
end

-----------------------------------------------------------------------
-- The clock (park frames only)
-----------------------------------------------------------------------
Autosave._Request = function(self, bManual)
	local nNow = now()
	local bOk, r = pcall(function()
		return api.save.RequestAutosave(api.player.GetGameOwner(), self.sAutoIdent)
	end)
	if not bOk or r == false then
		self:_Failed("The game refused the autosave request" .. (bOk and "." or (": " .. tostring(r) .. ".")))
		return false
	end
	self.nPendingSince = nNow
	self.bPendingManual = bManual == true
	self:_Mark(bManual and "autosave_request_now" or "autosave_request")
	self:Push()
	return true
end

-- Runs on park frames only (HeatMapManager is a park manager), so the
-- clock counts time in the park and pauses on hub trips. Saving waits
-- until the game has an autosave slot set up (bArmed).
Autosave.Tick = function(self)
	local nNow = now()
	local nDelta = self.nLastTick and (nNow - self.nLastTick) or 0
	self.nLastTick = nNow
	-- a long frame (loading, a hitch, the hub in between) counts as one second at most
	self.nElapsed = self.nElapsed + math.max(0, math.min(nDelta, 1))
	if nNow - self.nLastPush >= self.nPushSeconds then
		self:Push()
	end
	if not self.bArmed then
		return
	end
	if self.nPendingSince ~= nil then
		if nNow - self.nPendingSince > self.nAnswerSeconds then
			self:_Failed("The game did not answer the autosave request.")
		end
		return
	end
	if self.nMinutes <= 0 or nNow < self.nRetryAt then
		return
	end
	if self.nArmedAt ~= nil and nNow - self.nArmedAt < self.nSettleSeconds then
		return
	end
	if self.nElapsed >= self.nMinutes * 60 then
		self:_Request(false)
	end
end

Autosave._PatchHeatMapManager = function(self, HeatMapManager)
	local fnAdvance = HeatMapManager.Advance
	if type(fnAdvance) ~= "function" then
		self:_Mark("autosave_no_tick")
		return
	end
	HeatMapManager.Advance = function(oManager, ...)
		pcall(self.Tick, self)
		return fnAdvance(oManager, ...)
	end
end

-----------------------------------------------------------------------
-- UI
-----------------------------------------------------------------------
Autosave.State = function(self)
	local nNow = now()
	return {
		minutes = self.nMinutes,
		minMinutes = self.nMinMinutes,
		available = self.bAvailable,
		inPark = self.nLastTick ~= nil and nNow - self.nLastTick < 2,
		armed = self.bArmed,
		pending = self.nPendingSince ~= nil,
		elapsed = math.floor(self.nElapsed),
		retryIn = math.max(0, math.ceil(self.nRetryAt - nNow)),
		sinceSave = self.nSavedAt and math.floor(nNow - self.nSavedAt) or -1,
		lastKind = self.sLastKind,
		lastError = self.sLastError,
	}
end

local function jsonString(s)
	return '"' .. string.gsub(tostring(s), '[%c"\\\128-\255]', function(c)
		return string.format("\\u%04x", string.byte(c))
	end) .. '"'
end

Autosave.StateJson = function(self)
	local t = self:State()
	local tParts = {}
	for _, k in ipairs({ "minutes", "minMinutes", "available", "inPark", "armed", "pending", "elapsed", "retryIn", "sinceSave", "lastKind", "lastError" }) do
		local v = t[k]
		local sValue = type(v) == "string" and jsonString(v) or tostring(v)
		tParts[#tParts + 1] = '"' .. k .. '":' .. sValue
	end
	return "{" .. global.table.concat(tParts, ",") .. "}"
end

Autosave.Push = function(self)
	self.nLastPush = now()
	local sJson = self:StateJson()
	for oUI in global.pairs(self.tViews) do
		local bOk = pcall(oUI.TriggerEventAtNextAdvance, oUI, "PZ2QoL_AutosaveState", sJson)
		if not bOk or oUI.view == nil then
			self.tViews[oUI] = nil
		end
	end
end

Autosave.Set = function(self, nMinutes)
	self.nMinutes = self:ClampMinutes(nMinutes)
	self.nRetryAt = 0
	self:_Mark(self.nMinutes > 0 and "autosave_set" or "autosave_off")
	self:Push()
end

Autosave.SaveNow = function(self)
	if not self.bAvailable then
		return
	end
	if not self.bArmed then
		self.sLastError = "The game has no autosave ready yet (open a park, or wait a moment)."
		self:Push()
		return
	end
	if self.nPendingSince ~= nil then
		return
	end
	self:_Request(true)
end

Autosave.Attach = function(self, oUI)
	if oUI == nil or self.tViews[oUI] then
		return
	end
	self.tViews[oUI] = true
	local function guard(fn)
		return function(_, ...)
			local bOk, sErr = pcall(fn, ...)
			if not bOk and self.Core then
				self.Core.Trace("autosave event failed: " .. tostring(sErr))
			end
		end
	end
	pcall(function()
		oUI:AddEventListener("PZ2QoL_AutosaveSet", 1, guard(function(n) self:Set(n) end), self)
		oUI:AddEventListener("PZ2QoL_AutosaveNow", 0, guard(function() self:SaveNow() end), self)
		oUI:AddEventListener("PZ2QoL_AutosaveGet", 0, guard(function() self:Push() end), self)
	end)
	self:Push()
end

Autosave.bAvailable = false

Autosave.Init = function(self, Core)
	self.Core = Core
	if type(api.save) ~= "table" or type(api.save.RequestAutosave) ~= "function" then
		-- without the game's own call there is nothing safe to do: game default
		self.nMinutes = 0
		self:_Mark("autosave_unavailable")
		return
	end
	if not self:_PatchSaveAPI() then
		self.nMinutes = 0
		return
	end
	self.bAvailable = true
	self.nMinutes = self.nDefaultMinutes
	Core:AddModulePatch("Managers.ParkLoadSaveManager", function(t) self:_PatchManager(t) end)
	Core:AddModulePatch("Managers.HeatMapManager", function(t) self:_PatchHeatMapManager(t) end)
end
