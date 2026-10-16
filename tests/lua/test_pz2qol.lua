-- Behaviour test for the PZ2QoL Lua side against a mock of the game API.
-- Run: lua53 tests/lua/test_pz2qol.lua <path-to-mods/PZ2QoL/Main/>
local sModDir = arg[1] or "mods/PZ2QoL/Main/"

local nFailed, nPassed = 0, 0
local function check(bCond, sName)
	if bCond then
		nPassed = nPassed + 1
	else
		nFailed = nFailed + 1
		print("FAIL: " .. sName)
	end
end

-----------------------------------------------------------------------
-- Mock engine environment
-----------------------------------------------------------------------
local tCalls = {}
local function record(sName, ...)
	tCalls[#tCalls + 1] = { sName = sName, tArgs = table.pack(...) }
end
local function calls(sName)
	local t = {}
	for _, c in ipairs(tCalls) do
		if c.sName == sName then t[#t + 1] = c end
	end
	return t
end

-- Frontier's module(): returns (and registers) the module table.
function module(sName, tBase)
	local t = tBase or {}
	package.loaded[string.lower(sName)] = t
	return t
end

-- Case-insensitive loader for the mod's files (game resource names are lower case).
local fnOriginalRequire = require
table.insert(package.searchers, 2, function(sName)
	local sPath = sModDir .. string.lower(sName) .. ".lua"
	local f = io.open(sPath, "r")
	if not f then return nil end
	f:close()
	-- the game passes the module name as the chunk's `...` (used by module(...))
	return function(sModName) return assert(loadfile(sPath))(sModName) end, sPath
end)
require = function(sName)
	local sKey = string.lower(sName)
	if package.loaded[sKey] ~= nil then return package.loaded[sKey] end
	local tMod = fnOriginalRequire(sKey)
	-- module() already registered under the lower-case key
	return package.loaded[sKey] or tMod
end
tryrequire = function(sName)
	local bOk, t = pcall(require, sName)
	return bOk and t or nil
end

local tOverlayLoaded = {}
local bOverlayReady = true
local tReceivers = {}
local nViews = 0
api = {
	debug = {
		Trace = function(s) record("Trace", s) end,
		Error = function(s) record("NativeError", s) end,
		Assert = function(b, s) record("NativeAssert", b, s) end,
	},
	time = {
		GetPerformanceTimer = function() return os.clock() end,
		PerformanceTimeToMilliseconds = function(n) return n * 1000 end,
	},
	messaging = {
		MsgType_DatabaseErrorMessage = 77,
		RegisterGlobalReceiver = function(nType, fn) tReceivers[nType] = fn end,
	},
	ui2 = {
		LoadOverlay = function(sName, sPath) record("LoadOverlay", sName, sPath); tOverlayLoaded[sName] = bOverlayReady end,
		IsOverlayLoaded = function(sName) return tOverlayLoaded[sName] == true end,
		MapResources = function(sName) record("MapResources", sName) end,
	},
	world = {
		GetWorldAPIs = function()
			return { franchise = {
				DatabaseError_Ok = 0, DatabaseError_NotEnoughCC = 8, DatabaseError_DidNotGetResponse = 2,
				RequestType_CloseZooDryRun = 1,
			} }
		end,
	},
}

-- Minimal stand-ins for the game modules the mod patches.
local ViewWrapper = module("UI2.ViewWrapper")
ViewWrapper.new = function(self)
	return setmetatable({}, { __index = self })
end
ViewWrapper.Init = function(self, t)
	nViews = nViews + 1
	self.view = "view" .. nViews
	self.sViewAddress = t.sViewAddress
	self.fnReady = t.fnOnReadyCallback
	self.bReady = false
	record("ViewInit", t.sViewName, t.sViewAddress)
end
ViewWrapper.IsReady = function(self) return self.bReady end
ViewWrapper.TriggerEventAtNextAdvance = function(self, sName, ...) record("Trigger", sName, ...); tCalls[#tCalls].oView = self end
-- JS -> Lua listeners; tests fire them with fireUI(view, name, args...)
ViewWrapper.AddEventListener = function(self, sName, nArgs, fn, arg)
	self.tListeners = self.tListeners or {}
	self.tListeners[sName] = function(...) return fn(arg, ...) end
end
local function fireUI(oView, sName, ...)
	local fn = oView.tListeners and oView.tListeners[sName]
	assert(fn, "no listener " .. sName)
	return fn(...)
end
ViewWrapper.Shutdown = function(self) record("ViewShutdown", self.sViewAddress); self.view = nil end
local function makeReady(oView)
	oView.bReady = true
	if oView.fnReady then oView.fnReady() end
end

local FrontEndUI = setmetatable({}, { __index = ViewWrapper })
FrontEndUI.new = function(self, fnReady)
	local o = setmetatable({}, { __index = FrontEndUI })
	o:Init({ sViewName = "FrontEnd", sViewAddress = "coui://UIGameface/Frontend.html", fnOnReadyCallback = fnReady })
	return o
end
module("UI.Controllers.FrontEndUI", FrontEndUI)
package.loaded["ui.controllers.frontendui"] = nil -- loaded lazily through require below
local tFrontEndUIModule = FrontEndUI

-----------------------------------------------------------------------
-- 1. Boot through the database entry point
-----------------------------------------------------------------------
-- Like Database.Main.InitContentToCall: tryrequire inside a coroutine (the
-- require itself cannot yield), then AddContentToCall, which may yield.
bOverlayReady = false
local nFrame = 0
local co = coroutine.create(function()
	local db = tryrequire("Database.PZ2QoLLuaDatabase")
	assert(db and db.AddContentToCall, "database module missing")
	db.AddContentToCall({})
end)
local bOk, sErr = coroutine.resume(co)
while bOk and coroutine.status(co) ~= "dead" and nFrame < 1000 do
	nFrame = nFrame + 1
	-- the overlay finishes loading after a few frames, then the probe page
	if nFrame == 3 then tOverlayLoaded["PZ2QoLUI"] = true end
	local Hub = package.loaded["pz2qol.hub"]
	if nFrame >= 6 and Hub and Hub.oProbe and not Hub.oProbe.bReady then makeReady(Hub.oProbe) end
	bOk, sErr = coroutine.resume(co)
end
check(bOk and coroutine.status(co) == "dead", "boot ran without error: " .. tostring(sErr))
check(nFrame < 20, "waited only until ready (" .. nFrame .. " frames)")
local Core = package.loaded["pz2qol.core"]
check(Core and Core.bBooted, "core booted")
check(#calls("LoadOverlay") == 1 and calls("LoadOverlay")[1].tArgs[2] == "PZ2QoL/UI/PZ2QoLUI", "overlay loaded from PZ2QoL/UI/PZ2QoLUI")
check(#calls("MapResources") == 1, "overlay mapped")
local Hub = package.loaded["pz2qol.hub"]
for _, c in ipairs(calls("Trace")) do
	if string.find(tostring(c.tArgs[1]), "fail", 1, true) then print("  trace: " .. tostring(c.tArgs[1])) end
end
check(Hub.bProbeOk, "probe reported ready")

-----------------------------------------------------------------------
-- 2. FrontEnd view is redirected once FrontEndUI is required
-----------------------------------------------------------------------
package.loaded["ui.controllers.frontendui"] = nil
local fnPrevRequire = require
-- simulate the game loading the module for the first time through the hooked require
package.preload = package.preload or {}
local tLoaded = tFrontEndUIModule
require = Core and require or fnPrevRequire
local tFE = (function()
	-- the mod's require hook wraps the global require; emulate a first load
	package.loaded["ui.controllers.frontendui"] = tLoaded
	return require("UI.Controllers.FrontEndUI")
end)()
check(rawget(tFE, "Init") ~= nil, "FrontEndUI.Init patched")
local oFE = tFE:new(function() record("GameReady") end)
check(oFE.sViewAddress == "coui://UIGameface/PZ2QoLFrontend.html", "FrontEnd redirected to mod page (got " .. tostring(oFE.sViewAddress) .. ")")
makeReady(oFE)
check(#calls("GameReady") == 1, "game's own ready callback still runs")
local tHello = calls("Trigger")
check(#tHello >= 1 and tHello[1].tArgs[1] == "PZ2QoL_Hello", "mod UI greeted")
check(Hub.oProbe == nil, "probe view shut down")

-----------------------------------------------------------------------
-- 3. Server errors reach the UI with names and hints
-----------------------------------------------------------------------
tCalls = {}
local fnReceiver = tReceivers[api.messaging.MsgType_DatabaseErrorMessage]
check(fnReceiver ~= nil, "database error receiver registered")
fnReceiver({ { nError = 8, nRequestType = 1 }, { nError = 0, nRequestType = 1 } })
local tErr = calls("Trigger")
check(#tErr == 1, "one error forwarded (Ok ignored), got " .. #tErr)
if tErr[1] then
	check(tErr[1].tArgs[1] == "PZ2QoL_Error" and tErr[1].tArgs[2] == "server", "server error event")
	check(string.find(tErr[1].tArgs[3], "NotEnoughCC", 1, true) ~= nil, "error named: " .. tostring(tErr[1].tArgs[3]))
	check(string.find(tErr[1].tArgs[4], "CloseZooDryRun", 1, true) ~= nil, "request named: " .. tostring(tErr[1].tArgs[4]))
end
fnReceiver({ { nError = 8, nRequestType = 1 } })
check(#calls("Trigger") == 1, "duplicate error suppressed within 5s")

-----------------------------------------------------------------------
-- 4. Script errors in coroutines are reported, results unchanged
-----------------------------------------------------------------------
tCalls = {}
local coBad = coroutine.create(function() error("boom in hub mode") end)
local bRes, sMsg = coroutine.resume(coBad)
check(bRes == false and string.find(sMsg, "boom", 1, true), "resume still returns the error")
local tLua = calls("Trigger")
check(#tLua == 1 and tLua[1].tArgs[2] == "lua", "lua error forwarded")
local coDead = coroutine.create(function() end)
coroutine.resume(coDead)
tCalls = {}
coroutine.resume(coDead)
check(#calls("Trigger") == 0, "dead-coroutine resume not reported")
local coYield = coroutine.create(function(a) local b = coroutine.yield(a + 1); return b * 2 end)
local _, v1 = coroutine.resume(coYield, 1)
local _, v2 = coroutine.resume(coYield, 5)
check(v1 == 2 and v2 == 10, "values pass through resume wrapper")

-----------------------------------------------------------------------
-- 5. api.debug hooks
-----------------------------------------------------------------------
tCalls = {}
api.debug.Error("native said no")
check(#calls("NativeError") == 1, "original Error still called")
check(#calls("Trigger") == 1, "Error forwarded to UI")
api.debug.Assert(false, "minor")
check(#calls("NativeAssert") == 1, "original Assert still called")
check(#calls("Trigger") == 1, "failed Assert logged, not shown")

-----------------------------------------------------------------------
-- 6. Without a working overlay the vanilla page is used
-----------------------------------------------------------------------
Hub.bProbeOk = false
local oFE2 = tFE:new(function() end)
check(oFE2.sViewAddress == "coui://UIGameface/Frontend.html", "vanilla FrontEnd when probe failed")
check(Hub:GetModUI() == nil, "no mod UI reported for vanilla page")

-----------------------------------------------------------------------
-- 7. In-park HUD view is redirected to the mod's HUD page too
-----------------------------------------------------------------------
Hub.bProbeOk = true
local HUDUI = setmetatable({}, { __index = ViewWrapper })
HUDUI.Init = function(self, t)
	ViewWrapper.Init(self, t)
	self.bHUDOwnInit = true
end
HUDUI.new = function(self, fnReady)
	local o = setmetatable({}, { __index = HUDUI })
	o:Init({ sViewName = "HUD", sViewAddress = "coui://UIGameface/HUD.html", fnOnReadyCallback = fnReady })
	return o
end
package.loaded["ui.controllers.hudui"] = HUDUI
local tHUD = require("UI.Controllers.HUDUI")
local oHUD = tHUD:new(function() record("HUDReady") end)
check(oHUD.sViewAddress == "coui://UIGameface/PZ2QoLHUD.html", "HUD redirected to mod page (got " .. tostring(oHUD.sViewAddress) .. ")")
check(oHUD.bHUDOwnInit, "HUD's own Init still runs")
tCalls = {}
makeReady(oHUD)
check(#calls("HUDReady") == 1, "game's HUD ready callback still runs")
check(Hub:GetModUI() == oHUD, "errors go to the HUD view when it is up")
-- the hub page (storage lister) still hears about them, silently
local oSavedFE, bSavedFE = Hub.oFrontEndUI, Hub.bFrontEndIsModded
Hub.oFrontEndUI, Hub.bFrontEndIsModded = oFE, true -- section 6 left a vanilla page
tCalls = {}
fnReceiver({ { nError = 99, nRequestType = 1 } })
local tTo = calls("Trigger")
check(#tTo == 2, "server error sent to both modded views, got " .. #tTo)
if #tTo == 2 then
	local tByView = {}
	for _, c in ipairs(tTo) do tByView[c.oView] = c.tArgs end
	check(tByView[oHUD] and tByView[oHUD][5] == false, "HUD shows it")
	check(tByView[oFE] and tByView[oFE][5] == true, "hub page gets a silent copy")
	check(tByView[oFE] and string.find(tByView[oFE][3], "code 99", 1, true) ~= nil, "unknown code kept as a number")
end
Hub.oFrontEndUI, Hub.bFrontEndIsModded = oSavedFE, bSavedFE
Hub.bProbeOk = false
local oHUD2 = tHUD:new(function() end)
check(oHUD2.sViewAddress == "coui://UIGameface/HUD.html", "vanilla HUD when probe failed")

-----------------------------------------------------------------------
-- 8. On exit the mod's overlay is unmapped and unloaded, before the game's
-----------------------------------------------------------------------
tCalls = {}
Hub.sOverlayState = "mapped"
api.ui2.UnmapResources = function(s) record("Unmap", s) end
api.ui2.AreResourcesUnmapped = function(s) return true end
api.ui2.UnloadOverlay = function(s) record("Unload", s) end
local GameScript = { OnPrepareToShutdown = function(self) record("GameShutdown") end }
package.loaded["game.gamescript"] = GameScript
Core:AddModulePatch("Game.GameScript", function(t) Hub:_PatchGameScript(t) end)
local coExit = coroutine.create(function() GameScript.OnPrepareToShutdown({}) end)
local bExitOk, sExitErr = coroutine.resume(coExit)
check(bExitOk, "shutdown ran: " .. tostring(sExitErr))
local seq = {}
for _, c in ipairs(tCalls) do
	if c.sName == "Unmap" or c.sName == "Unload" or c.sName == "GameShutdown" then seq[#seq + 1] = c.sName .. (c.tArgs[1] and (":" .. c.tArgs[1]) or "") end
end
check(table.concat(seq, ",") == "Unmap:PZ2QoLUI,Unload:PZ2QoLUI,GameShutdown", "overlay unmapped+unloaded before the game's shutdown: " .. table.concat(seq, ","))

-----------------------------------------------------------------------
-- 9. Background market check from Animal Storage (PZ2QoL.MarketPeek)
-----------------------------------------------------------------------
local nClock = 0
api.time.GetPerformanceTimer = function() return nClock end
api.time.PerformanceTimeToMilliseconds = function(n) return n * 1000 end
local bPending = false
local tSavedSettings = { sort = "price", species = { 7 } }
api.planetHub = {
	AnimalMarketDisplay_None = 0, AnimalMarketDisplay_Market = 1, AnimalMarketDisplay_TradeHistory = 2,
	MarketFilterType_Currency = 5,
	MarketUISetDisplayType = function(n) record("Display", n) end,
	MarketUIGetSortFilterSettings = function() return tSavedSettings end,
	MarketUISetSortFilterSettings = function(t) record("RestoreSettings", t) end,
	MarketUIResetFiltersToDefault = function() record("ResetFilters") end,
	MarketUIClearFilterText = function() record("ClearText") end,
	MarketUIClearSourceFilter = function() record("ClearSource") end,
	MarketUISetSpeciesFilter = function(t) record("Species", t) end,
	MarketUISetFilterValue = function(nType, nValue) record("FilterValue", nType, nValue) end,
	MarketUIApplyFilters = function() record("Apply") end,
	MarketUIRequestData = function() record("Request"); bPending = true end,
	MarketUIHasPendingDataRequests = function() return bPending end,
	MarketUISetPage = function(n) record("SetPage", n); bPending = true end,
}
local MarketPeek = package.loaded["pz2qol.marketpeek"]
check(MarketPeek ~= nil, "market check module booted")
local StorageMode = {
	TransitionIn = function(self) record("StorageIn") end,
	TransitionOut = function(self) record("StorageOut") end,
	Advance = function(self, dt) record("StorageAdvance") end,
}
package.loaded["startscreen.globe.animalstoragehubmode"] = StorageMode
require("StartScreen.Globe.AnimalStorageHubMode")
local oStorage = setmetatable({}, { __index = StorageMode })
-- a modded hub page that is ready gets the listeners
Hub.bProbeOk = true
Hub.sOverlayState = "mapped" -- section 8 unloaded it
local oPage = tFE:new(function() end)
makeReady(oPage)
check(oPage.tListeners and oPage.tListeners["PZ2QoL_MarketPeek"] ~= nil, "market check listener on the hub page")
local function peekStates()
	local t = {}
	for _, c in ipairs(calls("Trigger")) do
		if c.tArgs[1] == "PZ2QoL_MarketPeekState" then t[#t + 1] = c.tArgs[2] end
	end
	return table.concat(t, ",")
end
local function frames(n)
	for _ = 1, n do
		nClock = nClock + 0.016
		oStorage:Advance(0.016)
	end
end

-- not in storage: refused, nothing touched
tCalls = {}
fireUI(oPage, "PZ2QoL_MarketPeek", 42)
check(peekStates() == "failed" and #calls("Display") == 0, "refused outside Animal Storage: " .. peekStates())

-- in storage: one request for the species, CC only, then ready, then restored
oStorage:TransitionIn()
tCalls = {}
fireUI(oPage, "PZ2QoL_MarketPeek", 42)
check(#calls("Display") == 1 and calls("Display")[1].tArgs[1] == 1, "market display switched on")
check(#calls("Species") == 1 and calls("Species")[1].tArgs[1][1] == 42, "filtered to the species")
local tCur = calls("FilterValue")[1]
check(tCur and tCur.tArgs[1] == 5 and tCur.tArgs[2] == 0, "Conservation Credits only")
check(#calls("Request") == 1, "one data request")
check(peekStates() == "loading", "page told: loading (" .. peekStates() .. ")")
fireUI(oPage, "PZ2QoL_MarketPeek", 42)
check(#calls("Request") == 1 and peekStates() == "loading,busy", "second click while running refused")
frames(30)
check(not string.find(peekStates(), "ready", 1, true), "not ready while the request is pending")
bPending = false
frames(30)
check(peekStates() == "loading,busy,ready", "ready once answered: " .. peekStates())
check(#calls("StorageAdvance") == 60, "storage's own Advance still runs")

-- paging: one page at a time, only after the last one was read, capped
tCalls = {}
fireUI(oPage, "PZ2QoL_MarketPeekPage", 20)
check(#calls("SetPage") == 0 and peekStates() == "failed" and MarketPeek.tPeek ~= nil, "page past the cap refused: " .. peekStates())
tCalls = {}
fireUI(oPage, "PZ2QoL_MarketPeekPage", 1)
check(#calls("SetPage") == 1 and calls("SetPage")[1].tArgs[1] == 1 and #calls("Request") == 0, "page 1 via SetPage, no new request")
fireUI(oPage, "PZ2QoL_MarketPeekPage", 2)
check(#calls("SetPage") == 1 and peekStates() == "loading,busy", "next page refused while one loads: " .. peekStates())
frames(30)
check(not string.find(peekStates(), "ready", 1, true), "page not ready while pending")
bPending = false
frames(30)
check(peekStates() == "loading,busy,ready", "page ready once answered: " .. peekStates())
fireUI(oPage, "PZ2QoL_MarketPeekPage", 2)
bPending = false
frames(30)
check(#calls("SetPage") == 2 and calls("SetPage")[2].tArgs[1] == 2, "page 2 after page 1 was read")

tCalls = {}
fireUI(oPage, "PZ2QoL_MarketPeekRelease")
check(#calls("SetPage") == 1 and calls("SetPage")[1].tArgs[1] == 0, "market back on its first page")
check(#calls("RestoreSettings") == 1 and calls("RestoreSettings")[1].tArgs[1] == tSavedSettings, "market filters restored")
check(#calls("Display") == 1 and calls("Display")[1].tArgs[1] == 0, "market display back to None")
check(MarketPeek.tPeek == nil, "check finished")

-- cooldown between clicks
tCalls = {}
fireUI(oPage, "PZ2QoL_MarketPeek", 42)
check(peekStates() == "busy" and #calls("Request") == 0, "cooldown between checks")

-- leaving storage mid-check restores the market before storage's own TransitionOut
nClock = nClock + 10
tCalls = {}
fireUI(oPage, "PZ2QoL_MarketPeek", 43)
oStorage:TransitionOut()
local seqOut = {}
for _, c in ipairs(tCalls) do
	if c.sName == "Display" or c.sName == "StorageOut" then seqOut[#seqOut + 1] = c.sName .. (c.tArgs[1] ~= nil and (":" .. tostring(c.tArgs[1])) or "") end
end
check(table.concat(seqOut, ",") == "Display:1,Display:0,StorageOut", "restored before leaving storage: " .. table.concat(seqOut, ","))
check(MarketPeek.tPeek == nil and MarketPeek.oStorageMode == nil, "no check left after leaving storage")

-- no answer from the server: gives up and restores
oStorage:TransitionIn()
nClock = nClock + 10
bPending = false
api.planetHub.MarketUIRequestData = function() record("Request"); bPending = true end
tCalls = {}
fireUI(oPage, "PZ2QoL_MarketPeek", 44)
frames(1400) -- ~22 s
check(peekStates() == "loading,failed" and calls("Display")[2] and calls("Display")[2].tArgs[1] == 0, "timeout restores: " .. peekStates())

-- the lister asks whether the game still waits on a franchise request
local function dbStates()
	local t = {}
	for _, c in ipairs(calls("Trigger")) do
		if c.tArgs[1] == "PZ2QoL_DbState" then
			t[#t + 1] = tostring(c.tArgs[2]) .. "/" .. tostring(c.tArgs[3]) .. "/" .. tostring(c.tArgs[4])
		end
	end
	return table.concat(t, ",")
end
check(oPage.tListeners["PZ2QoL_DbQuery"] ~= nil, "server state listener on the hub page")
local bDbBusy = true
oStorage.tWorldAPIs = { franchise = { IsDatabaseOperationInProgress = function(self) return bDbBusy, 42 end } }
tCalls = {}
fireUI(oPage, "PZ2QoL_DbQuery")
check(dbStates() == "true/true/42", "busy while a request runs: " .. dbStates())
bDbBusy = false
tCalls = {}
fireUI(oPage, "PZ2QoL_DbQuery")
check(dbStates() == "true/false/42", "idle: " .. dbStates())
oStorage.tWorldAPIs = { franchise = { IsDatabaseOperationInProgress = function() error("gone") end } }
tCalls = {}
fireUI(oPage, "PZ2QoL_DbQuery")
check(dbStates() == "false/false/-1", "unknown when the call fails: " .. dbStates())
oStorage:TransitionOut()
tCalls = {}
fireUI(oPage, "PZ2QoL_DbQuery")
check(dbStates() == "false/false/-1", "unknown outside storage: " .. dbStates())
oStorage:TransitionIn()
oStorage.tWorldAPIs = nil

-----------------------------------------------------------------------
-- 10. Relatedness data for the page (PZ2QoL.Kin)
-----------------------------------------------------------------------
-- minimal JSON decoder, enough for the snapshot
local function jsonDecode(s)
	local i = 1
	local function ws() i = string.find(s, "[^ \t\r\n]", i) or #s + 1 end
	local value
	local function str()
		local out = {}
		i = i + 1
		while true do
			local c = string.sub(s, i, i)
			if c == '"' then i = i + 1; break end
			if c == "\\" then
				local e = string.sub(s, i + 1, i + 1)
				if e == "u" then
					local n = tonumber(string.sub(s, i + 2, i + 5), 16)
					out[#out + 1] = n < 128 and string.char(n) or utf8.char(n)
					i = i + 6
				else
					out[#out + 1] = ({ n = "\n", t = "\t", r = "\r", b = "\b", f = "\f" })[e] or e
					i = i + 2
				end
			else
				out[#out + 1] = c
				i = i + 1
			end
		end
		return table.concat(out)
	end
	value = function()
		ws()
		local c = string.sub(s, i, i)
		if c == "{" then
			local t = {}
			i = i + 1; ws()
			if string.sub(s, i, i) == "}" then i = i + 1; return t end
			while true do
				ws(); local k = str(); ws(); i = i + 1 -- ':'
				t[k] = value(); ws()
				local d = string.sub(s, i, i); i = i + 1
				if d == "}" then return t end
			end
		elseif c == "[" then
			local t = {}
			i = i + 1; ws()
			if string.sub(s, i, i) == "]" then i = i + 1; return t end
			while true do
				t[#t + 1] = value(); ws()
				local d = string.sub(s, i, i); i = i + 1
				if d == "]" then return t end
			end
		elseif c == '"' then return str()
		elseif string.sub(s, i, i + 3) == "true" then i = i + 4; return true
		elseif string.sub(s, i, i + 4) == "false" then i = i + 5; return false
		elseif string.sub(s, i, i + 3) == "null" then i = i + 4; return nil
		else
			local num = string.match(s, "^-?[%d%.eE+-]+", i)
			i = i + #num
			return tonumber(num)
		end
	end
	return value()
end

local Kin = package.loaded["pz2qol.kin"]
check(Kin ~= nil, "kin module booted")
check(oHUD.tListeners and oHUD.tListeners["PZ2QoL_KinScan"] ~= nil, "kin listeners on the park HUD page")

local function genes(c1, c2)
	local t = {}
	for i = 1, 6 do t[i] = c1 end
	for i = 7, 12 do t[i] = c2 end
	return t
end
local tParkAnimals = {
	[1] = { sName = "Ama", sSpecies = "Lion", nGender = 0, nAgeGroup = 1, bAlive = true, sLocation = "Savannah Habitat", bAlpha = true },
	[2] = { sName = "Kito", sSpecies = "Lion", nGender = 0, nAgeGroup = 1, bAlive = true, sLocation = "Savannah Habitat" },
	[3] = { sName = "Zo\195\171", sSpecies = "Lion", nGender = 1, nAgeGroup = 1, bAlive = true, sLocation = "Savannah Habitat", nLocateEntity = 333 },
	[4] = { sName = "Bo \"Big\"", sSpecies = "Lion", nGender = 1, nAgeGroup = 0, bAlive = true, sLocation = "Savannah Habitat", bIsUsingContraceptive = true, bIsInfertile = true },
	[5] = { sName = "Away", sSpecies = "Lion", nGender = 1, nAgeGroup = 1, bAlive = true, sLocation = nil },
	[6] = { sName = "Gone", sSpecies = "Lion", nGender = 1, nAgeGroup = 1, bAlive = false },
}
local tGuids = { [1] = 1001, [2] = 1002, [3] = 1003, [4] = 1004, [5] = 1005, [6] = 1006 }
local tParentsOf = { [1001] = {}, [1002] = { 1001, 2000 }, [1003] = { 1001, 2000 }, [1004] = { "", 1001 }, [1005] = {}, [2000] = { 3000, 2001 }, [3000] = {} }
local nParentCalls = 0
local animalsAPI = {
	Juvenile = 0,
	EntityIDToAnimalGUID = function(self, e) return tGuids[e] or 0 end,
	GetParents = function(self, g)
		nParentCalls = nParentCalls + 1
		if g == 2001 then error("not known") end
		return tParentsOf[g] or {}
	end,
	GetGenes = function(self, e) return { tFertility = genes("A", "B"), tImmunity = genes("C", "C"), tSize = genes("A", "D"), tLongevity = genes("B", "B") } end,
	GetMateData = function(self, e) if e == 2 then return { bIsBeta = false, tMateData = { { nID = 3, sName = "Zoe" } } } end return nil end,
	GetUIAnimalListDataForIDs = function(self, tIDs)
		record("ListData", #tIDs)
		if #tIDs > 1 then
			for _, e in ipairs(tIDs) do
				if e == 99 then error("bad id") end
			end
		end
		local out = {}
		for _, e in ipairs(tIDs) do out[e] = tParkAnimals[e] end
		return out
	end,
	SetUsingContraceptive = function(self, e, b) record("Contracept", e, b) end,
	GetMarketAnimalGenes = function(self, id, nType) return { tFertility = genes("E", "F") } end,
}
local exhibitsAPI = {
	GetAllAnimalIDs = function(self) return { 77, 78 } end,
	GetUIAnimalListDataForIDs = function(self, tIDs)
		return { [77] = { sName = "Rex", sSpecies = "Gecko", nGender = 0, nAgeGroup = 1, bAlive = true, sLocation = "Reptile House" },
			[78] = { sName = "Rita", sSpecies = "Gecko", nGender = 1, nAgeGroup = 1, bAlive = true, sLocation = "Reptile House" } }
	end,
	GetAnimalFamilyMemberUID = function(self, uid, i) if uid == 78 and i == 0 then return 77 end return nil end,
	ExhibitAnimalUIDToEntityID = function(self, uid) return uid + 500 end,
	GetAnimalParentExhibit = function(self, e) return 900.0 end,
	GetMarketAnimalGenes = function(self, uid, n) return nil end,
	SetExhibitAnimalUsingContraceptiveUsingUID = function(self, uid, b) record("ExhibitContracept", uid, b) end,
}
local tParkAPIs = {
	animals = animalsAPI,
	exhibits = exhibitsAPI,
	habitat = {
		GetHabitats = function(self) return { 101, 102 } end,
		IsHabitat = function(self, h) return true end,
		GetAnimalsInHabitat = function(self, h) if h == 101 then return { 1, 2, 3, 4, 6 } end return {} end,
	},
	animalsDataHelpers = {
		AnimalListType_Habitat = 1,
		GetAllAnimalEntities = function(self, n) return { 1, 2, 3, 4, 5, 6, 99 } end,
	},
	CameraModeManager = { RequestMode = function(self, s, t) record("Camera", s, t.targetEntityID, t.bLocate) end },
	transform = { HasTransform = function(self, e) return e ~= 5 end },
	InfoPopUpComponent = {
		HasInfoPopUpComponent = function(self, e) return true end,
		CreateAndOpenInfoPopUpForEntity = function(self, e) record("InfoPopup", e) end,
	},
}
local fnSavedWorld = api.world.GetWorldAPIs
api.world.GetWorldAPIs = function() return tParkAPIs end

local function kinChunks(oView)
	local t = {}
	for _, c in ipairs(calls("Trigger")) do
		if c.tArgs[1] == "PZ2QoL_KinChunk" and (oView == nil or c.oView == oView) then t[#t + 1] = c.tArgs end
	end
	return t
end
local function kinStates()
	local t = {}
	for _, c in ipairs(calls("Trigger")) do
		if c.tArgs[1] == "PZ2QoL_KinState" then t[#t + 1] = c.tArgs[2] end
	end
	return table.concat(t, ",")
end
local function snapshotFrom(tChunks)
	local parts = {}
	for _, c in ipairs(tChunks) do parts[c[3]] = c[5] end
	local n = tChunks[1] and tChunks[1][4] or 0
	if n == 0 or #parts ~= n then return nil, "missing chunks" end
	return jsonDecode(table.concat(parts)), table.concat(parts)
end

-- No park running (the intro sequence, the start screen): nothing is touched.
-- In game, a scan there called exhibits:GetAllAnimalIDs in the wrong world
-- and crashed natively (2026-10-15).
tCalls = {}
fireUI(oHUD, "PZ2QoL_KinScan", "intro")
check(kinStates() == "nopark" and #calls("ListData") == 0, "no park running: no scan, no API calls (" .. kinStates() .. ")")
fireUI(oHUD, "PZ2QoL_KinContracept", "3", true)
check(#calls("Contracept") == 0, "no park running: no actions either")

-- frame hook (heat map manager's Advance): incremental, original still runs
local HeatMapManager = {
	Init = function(self) record("HMInit") end,
	Advance = function(self) record("HMAdvance") end,
	Shutdown = function(self) record("HMShutdown") end,
	ClaimViewModeRequest = function(self, n, s) record("HMClaim", n, s) end,
	SetCategory = function(self, s) record("HMCategory", s) end,
	ReleaseViewModeRequest = function(self) record("HMRelease") end,
	Hide = function(self) record("HMHide") end,
}
package.loaded["managers.heatmapmanager"] = HeatMapManager
require("Managers.HeatMapManager")
local oHM = setmetatable({ whiteWorldUIAPI = { VM_InbreedingRisk = 9 } }, { __index = HeatMapManager })
oHM.tWorldAPIs = tParkAPIs -- the manager's own world (HeatMapManager.Init sets it)
oHM:Init()
tCalls = {}
oHM:Advance()
check(#calls("HMAdvance") == 1, "heat map manager's own Advance still runs")

-- a scan in the running park: a few dozen animals per frame
local function scan(oView, sReason)
	fireUI(oView, "PZ2QoL_KinScan", sReason)
	local n = 0
	while Kin.tJob ~= nil and n < 200 do
		n = n + 1
		oHM:Advance()
	end
end
tCalls = {}
scan(oHUD, "test")
local tChunks = kinChunks(oHUD)
check(#tChunks >= 1, "snapshot sent (" .. #tChunks .. " chunks, states " .. kinStates() .. ")")
local tSnap, sJson = snapshotFrom(tChunks)
check(tSnap ~= nil and tSnap.scope == "park" and tSnap.v == 1, "snapshot decodes")
if tSnap then
	local byId = {}
	for _, a in ipairs(tSnap.animals) do byId[a.id] = a end
	check(byId["2"] and byId["2"].guid == "1002" and byId["2"].key == "animal_2", "ids, keys and guids as strings")
	check(byId["2"] and table.concat(byId["2"].par, ",") == "1001,2000", "parents from GetParents")
	check(byId["4"] and #byId["4"].par == 1 and byId["4"].par[1] == "1001", "unknown parent dropped")
	check(byId["4"] and byId["4"].juv == true and byId["4"].contra == true, "juvenile and contraception flags")
	check(byId["2"] and byId["2"].hab == "101" and byId["5"] and byId["5"].hab == "", "habitat membership; outside animals kept for lineage")
	check(byId["6"] == nil, "dead animals left out")
	check(byId["2"] and byId["2"].mates and byId["2"].mates[1] == "3", "current mates")
	check(byId["2"] and byId["2"].genes and byId["2"].genes.F == "AAAAAABBBBBB", "alleles as strings")
	check(byId["3"] and byId["3"].name == "Zo\195\171", "non-ASCII names survive")
	check(byId["4"] and byId["4"].name == "Bo \"Big\"", "quotes escaped")
	check(not string.find(sJson, "[\128-\255]"), "payload is pure ASCII")
	check(byId["x78"] and byId["x78"].par[1] == "x77" and byId["x78"].hab == "xe:900" and byId["x78"].exhibit, "exhibit animals with their parents, grouped by exhibit (" .. tostring(byId["x78"] and byId["x78"].hab) .. ")")
	check(tSnap.anc["2000"] and table.concat(tSnap.anc["2000"], ",") == "2001,3000", "parents of absent ancestors")
	check(tSnap.anc["3000"] ~= nil, "two generations up")
	check(tSnap.anc["2000"] and tSnap.anc["2000"][1] == "2001" and tSnap.anc["2001"] == nil and nParentCalls > 0, "failing GetParents tolerated (2001 asked, left out)")
	local tHabNames = {}
	for _, h in ipairs(tSnap.habitats) do tHabNames[h.id] = h.name end
	check(tHabNames["101"] == "Savannah Habitat" and tHabNames["xe:900"] == "Reptile House", "habitat names from the animals' locations")
end
-- unchanged: no resend
tCalls = {}
local nBefore = nParentCalls
scan(oHUD, "again")
check(#kinChunks(oHUD) == 0 and kinStates() == "same", "unchanged snapshot not resent: " .. kinStates())
check(nParentCalls - nBefore <= 3, "lineage cached between scans (" .. (nParentCalls - nBefore) .. " new GetParents calls)")

-- chunking
tCalls = {}
Kin.nChunkSize = 150
tParkAnimals[2].bIsUsingContraceptive = true
scan(oHUD, "chunks")
local tSmall = kinChunks(oHUD)
check(#tSmall > 3 and tSmall[1][4] == #tSmall, "split into " .. #tSmall .. " chunks")
local tSnap2 = snapshotFrom(tSmall)
check(tSnap2 and #tSnap2.animals == 7, "chunks reassemble")
Kin.nChunkSize = 12000

Kin.nPerFrame = 2
tParkAnimals[2].bIsUsingContraceptive = false
tCalls = {}
fireUI(oHUD, "PZ2QoL_KinScan", "ticked")
check(#kinChunks(oHUD) == 0 and Kin.tJob ~= nil, "scan waits for frames")
fireUI(oHUD, "PZ2QoL_KinScan", "double")
check(kinStates() == "busy", "second scan while one runs: busy")
local nFrames = 0
while Kin.tJob ~= nil and nFrames < 50 do
	nFrames = nFrames + 1
	oHM:Advance()
end
check(nFrames >= 3 and nFrames < 10, "spread over frames (" .. nFrames .. ")")
check(#kinChunks(oHUD) >= 1, "sent when done")
Kin.nPerFrame = 40

-- actions
tCalls = {}
fireUI(oHUD, "PZ2QoL_KinContracept", "3", true)
fireUI(oHUD, "PZ2QoL_KinContracept", "x78", false)
check(#calls("Contracept") == 1 and calls("Contracept")[1].tArgs[1] == 3 and calls("Contracept")[1].tArgs[2] == true, "contraception through the game's own setter")
check(#calls("ExhibitContracept") == 1 and calls("ExhibitContracept")[1].tArgs[1] == 78, "exhibit animals too")
check(kinStates() == "contracept,contracept", "page told: " .. kinStates())
tCalls = {}
fireUI(oHUD, "PZ2QoL_KinLocate", "3")
check(#calls("Camera") == 1 and calls("Camera")[1].tArgs[2] == 333 and #calls("InfoPopup") == 1, "locate: camera to the animal's locate entity, info panel opened")
tCalls = {}
fireUI(oHUD, "PZ2QoL_KinLocate", "5")
check(#calls("Camera") == 0 and kinStates() == "failed", "locate refused for an animal that is not in the world: " .. kinStates())
tCalls = {}
fireUI(oHUD, "PZ2QoL_KinLocate", "x78")
check(#calls("Camera") == 0 and kinStates() == "failed", "exhibit animals are not located")
check(Kin.IdString(77.0) == "77" and Kin.IdString(77) == "77" and Kin.IdString("a") == "a", "ids printed the same for floats and integers")
tCalls = {}
fireUI(oHUD, "PZ2QoL_KinHeatmap", true)
check(#calls("HMClaim") == 1 and calls("HMClaim")[1].tArgs[1] == 9 and #calls("HMCategory") == 1, "breeding heat map on")
fireUI(oHUD, "PZ2QoL_KinHeatmap", false)
check(#calls("HMRelease") == 1 and #calls("HMHide") == 1, "and off")

-- hub: Animal Storage lineage through the storage mode's background world
check(oPage.tListeners and oPage.tListeners["PZ2QoL_KinStorage"] ~= nil, "kin listeners on the hub page")
oStorage.backgroundWorldDataManager = { GetWorldAPIs = function() return { animals = animalsAPI } end }
oStorage:TransitionOut()
oStorage:TransitionIn()
api.planetHub.StorageGetIDAndAIDType = function(s)
	if s == "s9" then return 77, 1 end -- a listing, not a stored animal
	return ({ s1 = 1002, s2 = 1003 })[s], 2
end
tCalls = {}
fireUI(oPage, "PZ2QoL_KinStorage", "s1,s2,s9")
local tStore = snapshotFrom(kinChunks(oPage))
check(tStore and tStore.scope == "storage" and #tStore.animals == 2, "storage lineage for stored animals only")
check(tStore and tStore.animals[1].id == "s1" and tStore.animals[1].par[2] == "2000", "keyed by storage row id")
check(tStore and tStore.animals[1].genes and tStore.animals[1].genes.F == "EEEEEEFFFFFF", "storage genes via GetMarketAnimalGenes")
oStorage:TransitionOut()
tCalls = {}
fireUI(oPage, "PZ2QoL_KinStorage", "s1")
check(kinStates() == "nostorage", "outside storage: " .. kinStates())

-- leaving the park: the cache is cleared and nothing is scanned any more
oHM:Shutdown()
check(next(Kin.tStatic) == nil and Kin.oHeatMapManager == nil, "park shutdown clears the cache")
tCalls = {}
fireUI(oHUD, "PZ2QoL_KinScan", "hub")
check(kinStates() == "nopark" and #calls("ListData") == 0, "after the park: " .. kinStates())
api.world.GetWorldAPIs = fnSavedWorld

-----------------------------------------------------------------------
-- 11. Species board: snapshot extras, destinations, one move at a time
-----------------------------------------------------------------------
local tMoveCalls = {}
local function moveCalls(sName)
	local n = 0
	for _, c in ipairs(tMoveCalls) do if c == sName then n = n + 1 end end
	return n
end
local tJobs = { [2] = false }
animalsAPI.CurrentLocationType_Habitat = 1
animalsAPI.CurrentLocationType_TradeCentre = 2
animalsAPI.CurrentLocationType_BeingCarried = 3
tParkAnimals[5].nLocationType = 2 -- "Away" waits at the trade centre
animalsAPI.GetAnimalTransportData = function(self, e) return { bHasTransportJob = tJobs[e] == true } end
animalsAPI.GetSpecies = function(self, e) return tParkAnimals[e] and tParkAnimals[e].sSpecies end
animalsAPI.IsAlive = function(self, e) return e ~= 6 end
animalsAPI.IsEscaped = function(self, e) return false end
animalsAPI.IsBoxAnimating = function(self, e) return false end
animalsAPI.IsBoxingClaimed = function(self, e) return false end
animalsAPI.GetAssignedHabitatEntityID = function(self, e) return (e >= 1 and e <= 4) and 101 or nil end
animalsAPI.IsValidHabitatForAnimalsGUID = function(self, h, tGuids)
	table.insert(tMoveCalls, "IsValid")
	return h ~= 103 -- 103: wrong type for lions
end
animalsAPI.CanTransportToEntity = function(self, bExhibit, h) return h ~= 104, 7 end
animalsAPI.DoesTransportRequireStaff = function(self, e, h) return false end
animalsAPI.ClaimBoxing = function(self, e) table.insert(tMoveCalls, "Claim") end
animalsAPI.ReleaseBoxing = function(self, e) table.insert(tMoveCalls, "Release") end
local bRefuseTransport = false
animalsAPI.AttemptRequestToTransportAnimalToTarget = function(self, e, h, nType)
	table.insert(tMoveCalls, "Transport:" .. e .. ">" .. h .. "/" .. nType)
	if bRefuseTransport then return false end
	tJobs[e] = true
	return true
end
tParkAPIs.habitat.GetAllCompleteHabitats = function(self) return { 101, 102, 103, 104 } end
tParkAPIs.habitat.IsAquarium = function(self, h) return h == 102 end
tParkAPIs.habitat.IsAquariumGateBelowWaterLevel = function(self, h) return false end
tParkAPIs.staff = { CanStaffDeliverAnimalToFacility = function(self, e, h) return h ~= 105 end }
tParkAPIs.facilities = { GetTradeCentres = function(self) return { [555] = true } end }
tParkAPIs.franchise = { PlanetHubType_FranchiseOnline = 3, GetPlanetHubType = function(self) return 1 end }
api.ui2.GetEntityName = function(e) return ({ [101] = "Savannah Habitat", [102] = "Reef", [103] = "Pond", [104] = "Plains", [555] = "Trade Centre" })[e] end
api.world.GetWorldAPIs = function() return tParkAPIs end
-- a park again
oHM = setmetatable({ whiteWorldUIAPI = { VM_InbreedingRisk = 9 }, tWorldAPIs = tParkAPIs }, { __index = HeatMapManager })
oHM:Init()
oHM:Advance()

tCalls = {}
fireUI(oHUD, "PZ2QoL_KinForget")
scan(oHUD, "board")
local tBoard = snapshotFrom(kinChunks(oHUD))
check(tBoard ~= nil, "board snapshot sent (" .. kinStates() .. ")")
if tBoard then
	local byId = {}
	for _, a in ipairs(tBoard.animals) do byId[a.id] = a end
	check(byId["2"].lt == "habitat" and byId["5"].lt == "trade", "location kinds: habitat, trade centre")
	check(byId["2"].moving == false, "not on the move")
	check(tBoard.mode == "offline", "game mode: offline (got " .. tostring(tBoard.mode) .. ")")
	check(tBoard.tradeCentre and tBoard.tradeCentre.id == "555" and tBoard.tradeCentre.name == "Trade Centre", "trade centre in the snapshot")
end

-- destinations: the game's own checks per habitat
tCalls = {}
fireUI(oHUD, "PZ2QoL_KinDestinations", "r1", "2,3")
local tDestCall = calls("Trigger")[1]
check(tDestCall and tDestCall.tArgs[1] == "PZ2QoL_KinDestinationsResult" and tDestCall.tArgs[2] == "r1", "destinations answered with the request id")
local tDest = tDestCall and jsonDecode(tDestCall.tArgs[3])
if tDest then
	local d = tDest.bySpecies.Lion
	check(d and d["101"].ok and d["104"].ok, "suitable habitats ok")
	check(d and d["103"].ok == false and string.find(d["103"].reason, "does not allow", 1, true), "wrong habitat type refused with a reason")
	check(d and d["102"].ok == false and string.find(d["102"].reason, "gate", 1, true), "aquarium with the gate above water refused")
	check(#tDest.habitats == 4 and tDest.tradeCentre.id == "555", "habitat names and the trade centre")
end
check(moveCalls("IsValid") == 4, "one IsValidHabitatForAnimalsGUID per habitat for the species (" .. moveCalls("IsValid") .. ")")

-- one move: the game's own sequence
local function lastMoveResult()
	local r = nil
	for _, c in ipairs(calls("Trigger")) do
		if c.tArgs[1] == "PZ2QoL_KinMoveResult" then r = c.tArgs end
	end
	return r
end
tCalls = {}
tMoveCalls = {}
fireUI(oHUD, "PZ2QoL_KinMove", "m1", "3", "101")
local r = lastMoveResult()
check(r and r[2] == "m1" and r[3] == false and string.find(r[4], "already lives there", 1, true), "no move to its own habitat")
tCalls = {}
fireUI(oHUD, "PZ2QoL_KinMove", "m2", "3", "103")
r = lastMoveResult()
check(r and r[3] == false and moveCalls("Claim") == 0, "unsuitable habitat refused before anything is claimed")
tCalls = {}
tMoveCalls = {}
fireUI(oHUD, "PZ2QoL_KinMove", "m3", "3", "104")
r = lastMoveResult()
check(r and r[3] == false, "refused when the game cannot transport there")
check(moveCalls("Claim") == 0 and moveCalls("Release") == 0, "nothing claimed when the transport check fails")
tCalls = {}
tMoveCalls = {}
fireUI(oHUD, "PZ2QoL_KinMove", "m4", "3", "105")
r = lastMoveResult()
check(r and r[3] == false and string.find(r[4], "keeper", 1, true), "refused when keepers cannot reach it")
tCalls = {}
tMoveCalls = {}
bRefuseTransport = true
tParkAPIs.habitat.GetAllCompleteHabitats = function(self) return { 101, 106 } end
fireUI(oHUD, "PZ2QoL_KinMove", "m5", "3", "106")
r = lastMoveResult()
check(r and r[3] == false and moveCalls("Claim") == 1 and moveCalls("Release") == 1, "a refused transport releases the box claim")
bRefuseTransport = false
tCalls = {}
tMoveCalls = {}
fireUI(oHUD, "PZ2QoL_KinMove", "m6", "3", "106")
r = lastMoveResult()
check(r and r[2] == "m6" and r[3] == true, "move accepted")
check(moveCalls("Transport:3>106/7") == 1 and moveCalls("Claim") == 1, "one transport request with the game's transport type")
tCalls = {}
tMoveCalls = {}
fireUI(oHUD, "PZ2QoL_KinMove", "m7", "3", "106")
r = lastMoveResult()
check(r and r[3] == false and string.find(r[4], "already being moved", 1, true) and #tMoveCalls == 0, "an animal already on the move is left alone")
tCalls = {}
tMoveCalls = {}
fireUI(oHUD, "PZ2QoL_KinMove", "m8", "2", "trade:555")
r = lastMoveResult()
check(r and r[3] == true and moveCalls("Transport:2>555/7") == 1 and moveCalls("Claim") == 0, "to the trade centre (no box claim, like the game)")
tCalls = {}
fireUI(oHUD, "PZ2QoL_KinMove", "m9", "x78", "101")
r = lastMoveResult()
check(r and r[3] == false, "exhibit animals are not moved from here")
api.world.GetWorldAPIs = fnSavedWorld

print(string.format("%d passed, %d failed", nPassed, nFailed))
os.exit(nFailed == 0 and 0 or 1)
