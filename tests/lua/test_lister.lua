-- Behaviour test for PZ2QoL.Lister (the Market desk's listing engine)
-- against a mock of the game: api.planetHub, the hub DataStore, the
-- franchise API and MsgType_DatabaseErrorMessage. Run:
--   lua53 tests/lua/test_lister.lua <path-to-mods/PZ2QoL/Main/>
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

function module(sName, tBase)
	local t = tBase or {}
	package.loaded[string.lower(sName)] = t
	return t
end
local fnOriginalRequire = require
table.insert(package.searchers, 2, function(sName)
	local sPath = sModDir .. string.lower(sName) .. ".lua"
	local f = io.open(sPath, "r")
	if not f then return nil end
	f:close()
	return function(sModName) return assert(loadfile(sPath))(sModName) end, sPath
end)
require = function(sName)
	local sKey = string.lower(sName)
	if package.loaded[sKey] ~= nil then return package.loaded[sKey] end
	local tMod = fnOriginalRequire(sKey)
	return package.loaded[sKey] or tMod
end

-----------------------------------------------------------------------
-- A small JSON decoder (null -> JNULL, so a present null can be checked)
-----------------------------------------------------------------------
local JNULL = setmetatable({}, { __tostring = function() return "null" end })
local function decode(s)
	local pos = 1
	local function ws() pos = string.find(s, "[^ \t\r\n]", pos) or #s + 1 end
	local function str()
		local out = {}
		pos = pos + 1
		while true do
			local c = string.sub(s, pos, pos)
			if c == '"' then
				pos = pos + 1
				return table.concat(out)
			elseif c == "\\" then
				local e = string.sub(s, pos + 1, pos + 1)
				if e == "u" then
					out[#out + 1] = utf8.char(tonumber(string.sub(s, pos + 2, pos + 5), 16))
					pos = pos + 6
				else
					out[#out + 1] = ({ n = "\n", t = "\t", r = "\r", b = "\b", f = "\f" })[e] or e
					pos = pos + 2
				end
			elseif c == "" then
				error("unterminated string")
			else
				out[#out + 1] = c
				pos = pos + 1
			end
		end
	end
	local value
	value = function()
		ws()
		local c = string.sub(s, pos, pos)
		if c == "{" then
			pos = pos + 1
			local t = {}
			ws()
			if string.sub(s, pos, pos) == "}" then pos = pos + 1 return t end
			while true do
				ws()
				local k = str()
				ws()
				assert(string.sub(s, pos, pos) == ":", "expected : at " .. pos)
				pos = pos + 1
				t[k] = value()
				ws()
				local d = string.sub(s, pos, pos)
				pos = pos + 1
				if d == "}" then return t end
				assert(d == ",", "bad object at " .. pos)
			end
		elseif c == "[" then
			pos = pos + 1
			local t = {}
			ws()
			if string.sub(s, pos, pos) == "]" then pos = pos + 1 return t end
			while true do
				t[#t + 1] = value()
				ws()
				local d = string.sub(s, pos, pos)
				pos = pos + 1
				if d == "]" then return t end
				assert(d == ",", "bad array at " .. pos)
			end
		elseif c == '"' then
			return str()
		elseif string.sub(s, pos, pos + 3) == "true" then
			pos = pos + 4
			return true
		elseif string.sub(s, pos, pos + 4) == "false" then
			pos = pos + 5
			return false
		elseif string.sub(s, pos, pos + 3) == "null" then
			pos = pos + 4
			return JNULL
		end
		local n = string.match(s, "^-?%d+%.?%d*[eE]?[-+]?%d*", pos)
		assert(n and n ~= "", "bad value at " .. pos .. " in " .. s)
		pos = pos + #n
		return math.tointeger(tonumber(n)) or tonumber(n)
	end
	local v = value()
	ws()
	assert(pos > #s, "trailing data")
	return v
end

-----------------------------------------------------------------------
-- Mock game
-----------------------------------------------------------------------
local nClock = 1000
local DT = 0.05
local tCalls = {}
local function record(sName, ...) tCalls[#tCalls + 1] = { sName = sName, t = nClock, tArgs = table.pack(...) } end
local function calls(sName)
	local t = {}
	for _, c in ipairs(tCalls) do if c.sName == sName then t[#t + 1] = c end end
	return t
end

-- The storage: tOrder[i] is the GUID behind row key animal_<i> (keys are
-- positions); tAnimals[guid] the row and what the native does for it.
local tAnimals, tOrder = {}, {}
local function keyOf(g)
	for i, x in ipairs(tOrder) do if x == g then return "animal_" .. i end end
	return nil
end
local function guidAt(sKey)
	local i = tonumber(string.match(tostring(sKey), "^animal_(%d+)$") or "")
	return i and tOrder[i] or nil
end
local function gs(g)
	if math.type(g) == "float" then return string.format("%d", g) end
	return tostring(g)
end
local function reshuffle(tNew) tOrder = tNew end

local tNative
-- what the native's per-animal calls make of an id
local function guidForNative(sId)
	if tNative and tNative.bIdOther then
		local g = tonumber(string.match(tostring(sId), "^id_(%d+)$") or "")
		if g ~= nil then
			for _, x in ipairs(tOrder) do if x == g then return x end end
			return nil
		end
		-- a row key passed as an id: another animal (the next one along)
		local i = tonumber(string.match(tostring(sId), "^animal_(%d+)$") or "")
		if i == nil or #tOrder == 0 then return nil end
		return tOrder[i % #tOrder + 1]
	end
	return guidAt(sId)
end
local tTimers = {}
local function after(nDelay, fn) tTimers[#tTimers + 1] = { at = nClock + nDelay, fn = fn, n = #tTimers } end
local function nativeFrame()
	local tDue, tKeep = {}, {}
	for _, x in ipairs(tTimers) do
		if x.at <= nClock + 1e-9 then tDue[#tDue + 1] = x else tKeep[#tKeep + 1] = x end
	end
	tTimers = tKeep
	table.sort(tDue, function(a, b) if a.at ~= b.at then return a.at < b.at end return a.n < b.n end)
	for _, x in ipairs(tDue) do x.fn() end
end

local function defaultLimits()
	return { tradePriceMin = 100, tradePriceMax = 5000, tradePriceDefault = 800, tradeDurationMin = 1, tradeDurationMax = 12, tradeDurationDefault = 6 }
end
local function copy(t)
	local o = {}
	for k, v in pairs(t or {}) do o[k] = v end
	return o
end

local function addAnimal(g, t)
	t = t or {}
	tAnimals[g] = {
		timer = t.timer or -1, isMoving = t.isMoving == true, maturity = t.maturity or 2,
		tradeAllowed = t.tradeAllowed ~= false, reason = t.reason, limits = t.limits or defaultLimits(),
		noSelect = t.noSelect, selectError = t.selectError, sendError = t.sendError,
		outcome = t.outcome, onSelect = t.onSelect, aidType = t.aidType,
	}
	tOrder[#tOrder + 1] = g
end

local tReceivers = {}
local MSG_DB_ERROR = 77
local function serverError(nError, nRequestType)
	tReceivers[MSG_DB_ERROR]({ { nError = nError, nRequestType = nRequestType } })
end
local function errorAt(nDelay, nError, nRequestType)
	after(nDelay, function() serverError(nError, nRequestType) end)
end
local function listNow(g, nHours)
	tAnimals[g].timer = (nHours or 12) * 3600
	-- the native clears the selection on success (inferred from the UI)
	tNative.tSelection = {}
end
local function listAt(nDelay)
	return function(g, nHours) after(nDelay, function() listNow(g, nHours) end) end
end
local function never() return function() end end

local function resetNative()
	tNative = {
		tSelection = {}, tActions = {}, tLimits = {},
		bConnecting = false, bLoading = false, bDbBusy = false, vRequests = 0, nHubType = 2,
		nSelectDelay = 0.15, nDataDelay = 0.25, nListDelay = 0.5,
		bSelUnreadable = false, bListUnreadable = false, bRowCtxUnreadable = false,
		-- in game: selectedAnimalIDs read from Lua stays empty, the row's
		-- own `selected` flag is right (Y: 2026-10-17)
		bSelArrayEmpty = false, bNoRowFlag = false,
		-- the row id differs from the row key (as in game): SelectItem
		-- takes the id (a key there selects another animal),
		-- GetIDAndAIDType the key (an id finds nothing)
		bIdOther = false,
		-- Lua's own reads broken in other ways (the page still sees the truth):
		-- the flag nil and the array empty; the flag always false; tradeAllowed
		-- and the limits nil
		bLuaSelBroken = false, bLuaFlagFalse = false, bLuaDataBroken = false,
	}
end
resetNative()

local tAuctions = {}
local planetHub = {
	StorageGetIDAndAIDType = function(sKey)
		local g = guidAt(sKey)
		if g ~= nil then return g, (tAnimals[g] and tAnimals[g].aidType) or 2 end
		return 0, 0
	end,
	StorageUIClearSelectedItems = function()
		record("Clear")
		tNative.tSelection = {}
	end,
	StorageUISelectItem = function(sId)
		local g = guidForNative(sId)
		-- the selection holds the row key of the animal selected
		local sKey = g and keyOf(g) or sId
		record("Select", sKey, g)
		local a = g and tAnimals[g]
		if a and a.selectError then error("select blew up") end
		if a == nil or a.noSelect then return end
		-- the selection, then its data, a few frames later; until then the
		-- previous animal's data stays (the worst case)
		after(tNative.nSelectDelay, function() tNative.tSelection = { sKey } end)
		after(tNative.nDataDelay, function()
			tNative.tActions = { tradeAllowed = a.tradeAllowed, tradeDisallowedReason = a.reason }
			tNative.tLimits = copy(a.limits)
		end)
		if a.onSelect then a.onSelect(sKey, g) end
	end,
	StorageUIStartAnimalAuction = function(sKey, nPrice, nHours)
		local g = guidAt(sKey)
		tAuctions[#tAuctions + 1] = { key = sKey, price = nPrice, hours = nHours, guid = g, t = nClock }
		record("Auction", sKey, nPrice, nHours)
		local a = g and tAnimals[g]
		if a and a.sendError then error("auction call blew up") end
		local fn = a and a.outcome or listAt(tNative.nListDelay)
		fn(g, nHours)
	end,
}

-- DataStore: contexts are { sPath }; only the ones the native made exist.
local tRoots = {
	["hubAnimalsData"] = true, ["hubAnimalsData/animalStorageData"] = true,
	["hubAnimalsData/animalStorageData/list"] = true, ["hubAnimalsData/animalStorageData/actions"] = true,
	["hubAnimalsData/network"] = true, ["animalTradeListingData"] = true,
}
local function exists(sPath)
	if tRoots[sPath] then return true end
	local sKey = string.match(sPath, "^hubAnimalsData/animalStorageData/list/(animal_%d+)$")
	return sKey ~= nil and guidAt(sKey) ~= nil and not tNative.bRowCtxUnreadable
end
local function rowTable(sKey)
	local a = tAnimals[guidAt(sKey)]
	local bSelected = nil
	if not tNative.bNoRowFlag and not tNative.bLuaSelBroken then
		bSelected = false
		for _, k in ipairs(tNative.tSelection) do if k == sKey then bSelected = true end end
		if tNative.bLuaFlagFalse then bSelected = false end
	end
	return { id = tNative.bIdOther and ("id_" .. gs(guidAt(sKey))) or sKey, auctionTimerSeconds = a.timer, isMoving = a.isMoving, maturity = a.maturity, name = "Animal", selected = bSelected }
end
local ui2 = {
	GetNoCreateDataStoreContext = function(a, ...)
		local tParts = { type(a) == "table" and a.sPath or a }
		for _, s in ipairs({ ... }) do tParts[#tParts + 1] = s end
		local sPath = table.concat(tParts, "/")
		if exists(sPath) then return { sPath = sPath } end
		return nil
	end,
	GetDataStoreContext = function(...) record("CreateContext", ...) return { sPath = table.concat({ ... }, "/") } end,
	GetDataStoreElement = function(ctx, sName)
		local p = ctx.sPath
		if p == "hubAnimalsData/animalStorageData" and sName == "selectedAnimalIDs" then
			if tNative.bSelUnreadable then return nil end
			if tNative.bSelArrayEmpty or tNative.bLuaSelBroken or tNative.bLuaFlagFalse then return {} end
			return copy(tNative.tSelection)
		elseif p == "hubAnimalsData/animalStorageData/actions" then
			if tNative.bLuaDataBroken then return nil end
			return tNative.tActions[sName]
		elseif p == "animalTradeListingData" then
			if tNative.bLuaDataBroken then return nil end
			return tNative.tLimits[sName]
		elseif p == "hubAnimalsData/network" then
			if sName == "connectingAction" then return tNative.bConnecting end
			if sName == "loadingItems" then return tNative.bLoading end
		else
			local sKey = string.match(p, "^hubAnimalsData/animalStorageData/list/(animal_%d+)$")
			if sKey and guidAt(sKey) then return rowTable(sKey)[sName] end
		end
		return nil
	end,
	GetDataStoreContextAsTable = function(ctx)
		if ctx.sPath == "hubAnimalsData/animalStorageData/list" then
			if tNative.bListUnreadable then error("not a table") end
			local t = {}
			for i in ipairs(tOrder) do t["animal_" .. i] = rowTable("animal_" .. i) end
			return t
		end
		return nil
	end,
}

local franchise = {
	PlanetHubType_FranchiseOnline = 2,
	DatabaseError_Ok = 0, DatabaseError_Unknown = 255, DatabaseError_DidNotGetResponse = 2,
	DatabaseError_NotAllowed = 5, DatabaseError_NotEnoughCC = 8,
	GetPlanetHubType = function(self) return tNative.nHubType end,
	IsDatabaseOperationInProgress = function(self) return tNative.bDbBusy, 42 end,
	RequestsInProgress = function(self) return tNative.vRequests end,
}

api = {
	debug = { Trace = function(s) record("Trace", s) end },
	time = {
		GetPerformanceTimer = function() return nClock end,
		PerformanceTimeToMilliseconds = function(n) return n * 1000 end,
	},
	messaging = {
		MsgType_DatabaseErrorMessage = MSG_DB_ERROR,
		RegisterGlobalReceiver = function(nType, fn) tReceivers[nType] = fn end,
	},
	planetHub = planetHub,
	ui2 = ui2,
	world = { GetWorldAPIs = function() return { franchise = franchise } end },
}

-- the hub page: records Lua -> JS events (with the game time), fires JS -> Lua
local oView = { tListeners = {}, tSent = {} }
function oView:AddEventListener(sName, nArgs, fn, arg) self.tListeners[sName] = function(...) return fn(arg, ...) end end
function oView:TriggerEventAtNextAdvance(sName, ...) self.tSent[#self.tSent + 1] = { sName = sName, t = nClock, tArgs = table.pack(...) } end
function oView:IsReady() return true end
local function fire(sName, ...) return assert(oView.tListeners[sName], "no listener " .. sName)(...) end

package.loaded["pz2qol.hub"] = {
	bFrontEndIsModded = true, oFrontEndUI = oView,
	GetModUI = function() return nil end, GetModUIs = function() return {} end,
}
local tPatches = {}
local tMarks = {}
local Core = {
	AddModulePatch = function(_, sName, fn) tPatches[string.lower(sName)] = fn end,
	Mark = function(_, s) tMarks[#tMarks + 1] = s end,
	MarkNumber = function() end,
	Checkpoint = function() end,
	Trace = function() end,
}
package.loaded["pz2qol.core"] = Core

local Errors = require("PZ2QoL.Errors")
Errors:Init(Core)
check(type(Errors.AddServerErrorListener) == "function", "errors: listener list")
local Lister = require("PZ2QoL.Lister")
Lister:Init(Core)
check(#Errors.tServerErrorListeners == 1, "lister listens to server errors")
check(tPatches["startscreen.globe.animalstoragehubmode"] ~= nil, "patches AnimalStorageHubMode")

local StorageMode = {
	TransitionIn = function(self) record("StorageIn") end,
	TransitionOut = function(self) record("StorageOut") end,
	Advance = function(self) record("StorageAdvance") end,
}
tPatches["startscreen.globe.animalstoragehubmode"](StorageMode)
local oStorage = setmetatable({ tWorldAPIs = { franchise = franchise } }, { __index = StorageMode })

Lister:Attach(oView)
for _, s in ipairs({ "PZ2QoL_ListerHello", "PZ2QoL_ListerResolve", "PZ2QoL_ListerStart", "PZ2QoL_ListerStop", "PZ2QoL_ListerPace" }) do
	check(oView.tListeners[s] ~= nil, "listener " .. s)
end

-----------------------------------------------------------------------
-- Helpers
-----------------------------------------------------------------------
local fnPageFrame = nil -- the page's own frame (set by the page-assisted tests)
local function tick(n)
	for _ = 1, n or 1 do
		nClock = nClock + DT
		nativeFrame()
		oStorage:Advance(DT)
		if fnPageFrame then fnPageFrame() end
	end
end
local function seconds(s) tick(math.floor(s / DT + 0.5)) end
local function tickUntil(fn, nMax)
	local nEnd = nClock + (nMax or 60)
	while not fn() and nClock < nEnd do tick(1) end
	return fn()
end
local function runToEnd(nMax)
	return tickUntil(function() return Lister.tRun == nil end, nMax or 200)
end

local function sent(sName, nFrom)
	local t = {}
	for i = (nFrom or 0) + 1, #oView.tSent do
		local x = oView.tSent[i]
		if x.sName == sName then t[#t + 1] = x end
	end
	return t
end
-- decoded states sent after position nFrom (each with its game time in _t)
local function states(nFrom)
	local t = {}
	for _, x in ipairs(sent("PZ2QoL_ListerState", nFrom)) do
		local s = decode(x.tArgs[1])
		s._t = x.t
		t[#t + 1] = s
	end
	return t
end
local function lastState()
	local t = sent("PZ2QoL_ListerState")
	return t[#t] and decode(t[#t].tArgs[1]) or nil
end
-- when result i (1-based) first showed a final status
local function resultTime(tStates, i)
	for _, s in ipairs(tStates) do
		local r = s.results and s.results[i]
		if r and r.status ~= "pending" and r.status ~= "working" then return s._t, r end
	end
	return nil
end
local function stepsSeen(tStates)
	local t = {}
	for _, s in ipairs(tStates) do t[s.step] = true end
	return t
end
local function countMarks(sName)
	local n = 0
	for _, s in ipairs(tMarks) do if s == sName then n = n + 1 end end
	return n
end
local function job(nPace, tLines) return "v1 " .. nPace .. "\n" .. table.concat(tLines, "\n") end
local function line(g, sPrice, sHours, sKey) return gs(g) .. " " .. (sKey or keyOf(g) or "-") .. " " .. sPrice .. " " .. sHours end

local nReq = 0
local function reset()
	if Lister.tRun ~= nil then fire("PZ2QoL_ListerStop") end
	tAnimals, tOrder, tAuctions, tTimers, tCalls, tMarks = {}, {}, {}, {}, {}, {}
	oView.tSent = {}
	resetNative()
	Lister.nLastServer = nil
	-- far enough on that no pause is still running
	nClock = nClock + 100
end
local function start(sJob)
	nReq = nReq + 1
	local sReq = "req" .. nReq
	local nFrom = #oView.tSent
	fire("PZ2QoL_ListerStart", sReq, sJob)
	return sReq, nFrom
end

-----------------------------------------------------------------------
-- 1. Hello -> Caps
-----------------------------------------------------------------------
reset()
addAnimal(4400000000001)
addAnimal(12345.0) -- a float GUID (game Lua numbers are 32-bit floats: keep it exact)
addAnimal(77)
fire("PZ2QoL_ListerHello", "h1")
local tCaps = sent("PZ2QoL_ListerCaps")
check(#tCaps == 1 and tCaps[1].tArgs[1] == "h1", "caps answered with the request id")
local c = decode(tCaps[1].tArgs[2])
check(c.ok == true and #c.missing == 0 and c.storage == false and c.running == false and c.version == 1, "caps outside storage")
check(c.rows == JNULL and c.online == JNULL, "caps outside storage: rows and online unknown")
oStorage:TransitionIn()
fire("PZ2QoL_ListerHello", "h2")
c = decode(sent("PZ2QoL_ListerCaps")[2].tArgs[2])
check(c.ok == true and c.storage == true and c.rows == 3 and c.online == true, "caps in storage: rows " .. tostring(c.rows))
local fnSavedAuction = planetHub.StorageUIStartAnimalAuction
planetHub.StorageUIStartAnimalAuction = nil
fire("PZ2QoL_ListerHello", "h3")
c = decode(sent("PZ2QoL_ListerCaps")[3].tArgs[2])
check(c.ok == false and c.missing[1] == "api.planetHub.StorageUIStartAnimalAuction", "caps name a missing call")
planetHub.StorageUIStartAnimalAuction = fnSavedAuction
tNative.bListUnreadable = true
fire("PZ2QoL_ListerHello", "h4")
c = decode(sent("PZ2QoL_ListerCaps")[4].tArgs[2])
check(c.ok == false and c.missing[1] == "storageList" and c.rows == JNULL, "caps: unreadable list")
check(countMarks("lister_hello") == 4 and countMarks("lister_list_unreadable") == 1, "hello marks")
tNative.bListUnreadable = false

-----------------------------------------------------------------------
-- 2. Resolve: row keys -> exact GUID strings
-----------------------------------------------------------------------
fire("PZ2QoL_ListerResolve", "k1", "animal_1,animal_2, animal_3,animal_9")
local tIds = sent("PZ2QoL_ListerIds")
check(#tIds == 1 and tIds[1].tArgs[1] == "k1", "ids answered with the request id")
local r = decode(tIds[1].tArgs[2])
check(r.ids.animal_1 == "4400000000001" and r.ids.animal_2 == "12345" and r.ids.animal_3 == "77", "exact GUID strings (float GUID without .0)")
check(#r.failed == 1 and r.failed[1] == "animal_9", "unknown key failed")
oStorage:TransitionOut()
fire("PZ2QoL_ListerResolve", "k2", "animal_1")
r = decode(sent("PZ2QoL_ListerIds")[2].tArgs[2])
check(next(r.ids) == nil and r.failed[1] == "animal_1", "keys mean nothing outside storage")

-----------------------------------------------------------------------
-- 3. Refused starts
-----------------------------------------------------------------------
local _, nFrom = start(job(3000, { line(77, "500", "max") }))
local s = states(nFrom)[1]
check(s and s.refused == true and s.run == 0 and s.phase == "closed" and s.req == "req1", "refused outside storage")
check(#calls("Select") == 0 and Lister.tRun == nil, "nothing selected when refused")
oStorage:TransitionIn()
_, nFrom = start("v2 3000\n77 animal_3 500 max")
s = states(nFrom)[1]
check(s.refused == true and string.find(s.message, "v1", 1, true) ~= nil, "unknown job format refused")
_, nFrom = start("v1 3000\n77 animal_3 lots max")
check(states(nFrom)[1].refused == true, "bad price refused")
_, nFrom = start("v1 3000\n7;7 animal_3 500 max")
check(states(nFrom)[1].refused == true, "bad GUID refused")
_, nFrom = start("v1 3000\n")
check(states(nFrom)[1].refused == true, "empty job refused")
tNative.nHubType = 1
_, nFrom = start(job(3000, { line(77, "500", "max") }))
check(states(nFrom)[1].refused == true and Lister.tRun == nil, "refused outside online Franchise")
tNative.nHubType = 2
check(countMarks("lister_start_refused") == 6, "refusals marked")
oStorage:TransitionOut()

-----------------------------------------------------------------------
-- 4. A normal run: prices, clamps, integer arguments, pace
-----------------------------------------------------------------------
reset()
oStorage:TransitionIn()
addAnimal(101)
addAnimal(102)
addAnimal(103)
addAnimal(104)
addAnimal(105)
local sReq
sReq, nFrom = start(job(2000, {
	line(101, "1234", "max"),
	line(102, "99999", "default"),
	line(103, "-", "20"),
	line(104, "10", "0"),
	line(105, "1500.6", "3"),
}))
s = states(nFrom)[1]
check(s.phase == "running" and s.req == sReq and s.run >= 1 and s.total == 5 and s.index == 0 and s.paceMs == 2000, "run started")
check(s.results[1].status == "working" and s.results[2].status == "pending" and s.results[1].guid == "101", "first animal working")
check(s.results[2].capped == JNULL and s.results[2].kind == JNULL and s.results[2].usedDefault == false, "null fields present")
check(runToEnd(60), "run finished")
local tAll = states(nFrom)
s = tAll[#tAll]
check(s.phase == "done" and s.index == 5 and s.step == "", "done: " .. tostring(s.phase))
check(#tAuctions == 5, "five listings sent")
local tExpect = {
	{ 101, 1234, 12, JNULL, false }, { 102, 5000, 6, "max", false }, { 103, 800, 12, JNULL, true },
	{ 104, 100, 1, "min", false }, { 105, 1501, 3, JNULL, false },
}
for i, e in ipairs(tExpect) do
	local a = tAuctions[i]
	check(a and a.guid == e[1] and a.price == e[2] and a.hours == e[3], "listing " .. i .. ": " .. tostring(a and a.price) .. " CC " .. tostring(a and a.hours) .. " h")
	check(a and math.type(a.price) == "integer" and math.type(a.hours) == "integer", "listing " .. i .. ": integer arguments")
	local rr = s.results[i]
	check(rr.status == "listed" and rr.price == e[2] and rr.hours == e[3] and rr.capped == e[4] and rr.usedDefault == e[5], "result " .. i)
end
for i = 2, #tAuctions do
	check(tAuctions[i].t - tAuctions[i - 1].t >= 2.5, "pace between listings " .. (i - 1) .. "-" .. i .. ": " .. string.format("%.2f", tAuctions[i].t - tAuctions[i - 1].t))
end
local tSel = calls("Select")
check(#tSel == 5, "selected once each")
for i, a in ipairs(tAuctions) do
	check(a.t - tSel[i].t >= (i == 1 and 0.25 or 0.15) + 0.3 - 1e-3, "listing " .. i .. " waited for the selection and the settle")
end
local tSteps = stepsSeen(tAll)
check(tSteps.server and tSteps.select and tSteps.selected and tSteps.confirm and tSteps.pause, "steps reported")
check(countMarks("lister_run_start") == 1 and countMarks("lister_send") == 5 and countMarks("lister_listed") == 5 and countMarks("lister_run_end") == 1, "run marks")
check(s.message == "Listed 5 of 5.", "summary: " .. s.message)
check(#calls("CreateContext") == 0, "no DataStore context created")

-----------------------------------------------------------------------
-- 5. Skips before anything is selected: no pause between them
-----------------------------------------------------------------------
reset()
oStorage:TransitionIn()
addAnimal(201, { timer = 3600 })
addAnimal(202, { isMoving = true })
addAnimal(203, { maturity = 6 })
addAnimal(204, { maturity = 0 })
addAnimal(205)
local nStart = nClock
sReq, nFrom = start(job(3000, {
	"299 animal_9 500 max", line(201, "500", "max"), line(202, "500", "max"),
	line(203, "500", "max"), line(204, "500", "max"), line(205, "500", "max"),
}))
check(runToEnd(60), "skip run finished")
s = lastState()
local tKinds = { "gone", "listed", "moving", "elderly", "juvenile" }
for i, k in ipairs(tKinds) do
	check(s.results[i].status == "skipped" and s.results[i].kind == k, "skip " .. k .. ": " .. tostring(s.results[i].kind))
end
check(s.results[6].status == "listed", "the sellable one listed")
check(#tAuctions == 1 and tAuctions[1].guid == 205, "only the sellable one sent")
check(tAuctions[1].t - nStart < 1.5, "no pause after local skips")
check(#calls("Select") == 1, "skipped animals never selected")
check(countMarks("lister_skip") == 5, "skips marked")

-----------------------------------------------------------------------
-- 6. untradeable (after a tradeable one: its data is still there for a
--    moment), unselectable, noprice
-----------------------------------------------------------------------
reset()
oStorage:TransitionIn()
addAnimal(301)
addAnimal(302, { tradeAllowed = false, reason = "[AnimalList_Problem_Pregnant]" })
addAnimal(303, { noSelect = true })
local tNoDefault = defaultLimits()
tNoDefault.tradePriceDefault = 0
addAnimal(304, { limits = tNoDefault })
addAnimal(305)
sReq, nFrom = start(job(1000, { line(301, "500", "max"), line(302, "500", "max"), line(303, "500", "max"), line(304, "-", "max"), line(305, "0", "max") }))
check(runToEnd(60), "run finished")
tAll = states(nFrom)
s = tAll[#tAll]
check(s.results[1].status == "listed", "tradeable listed")
check(s.results[2].kind == "untradeable" and s.results[2].detail == "[AnimalList_Problem_Pregnant]", "untradeable with the game's reason: " .. tostring(s.results[2].detail))
check(s.results[3].kind == "unselectable", "unselectable")
local t2 = resultTime(tAll, 2)
local t3 = resultTime(tAll, 3)
check(t3 - t2 >= 5 and t3 - t2 < 5.5, "unselectable after 5 s: " .. string.format("%.2f", t3 - t2))
check(s.results[4].kind == "noprice" and s.results[4].usedDefault == true, "no price and no default")
check(s.results[5].kind == "noprice" and s.results[5].usedDefault == false, "zero price")
check(#tAuctions == 1, "only the tradeable one sent")
check(countMarks("lister_unsel_selection") == 1 and string.find(s.results[3].detail, "select", 1, true), "unselectable: the selection never came")

-- tradeable but the price limits never come: says so
reset()
oStorage:TransitionIn()
addAnimal(311, { limits = { tradeDurationMax = 12 } })
sReq, nFrom = start(job(1000, { line(311, "500", "max") }))
check(runToEnd(30), "run finished")
s = lastState()
check(s.results[1].kind == "unselectable" and string.find(s.results[1].detail, "limits", 1, true), "no limits: " .. s.results[1].detail)
check(countMarks("lister_unsel_limits") == 1 and #tAuctions == 0, "no limits: marked, not sent")

-----------------------------------------------------------------------
-- 7. Busy: wait for the server, give up after 10 s
-----------------------------------------------------------------------
reset()
oStorage:TransitionIn()
addAnimal(401)
tNative.bDbBusy = true
after(3, function() tNative.bDbBusy = false end)
nStart = nClock
sReq, nFrom = start(job(1000, { line(401, "500", "max") }))
check(runToEnd(30), "run finished")
tAll = states(nFrom)
check(tAll[#tAll].results[1].status == "listed", "listed once the server was free")
check(tAuctions[1].t - nStart >= 3, "nothing sent while busy")
local nMaxWaited, nServerStates = 0, 0
for _, x in ipairs(tAll) do
	if x.step == "server" then
		nServerStates = nServerStates + 1
		nMaxWaited = math.max(nMaxWaited, x.waited)
	end
end
check(nServerStates >= 3 and nMaxWaited >= 2, "state about once a second while waiting (" .. nServerStates .. " states, waited " .. nMaxWaited .. ")")
check(countMarks("lister_busy_db") == 1, "busy reason marked once")

-- RequestsInProgress alone: waited on for 2 s only (it may count background
-- polls), then the listing goes ahead and the run marks it once
reset()
oStorage:TransitionIn()
addAnimal(404)
tNative.vRequests = 2
sReq, nFrom = start(job(1000, { line(404, "500", "max") }))
check(runToEnd(30), "run finished")
tAll = states(nFrom)
check(lastState().results[1].status == "listed" and #tAuctions == 1, "requests alone: listed after the short wait")
check(tAuctions[1] and tAuctions[1].t - tAll[1]._t >= 2 and tAuctions[1].t - tAll[1]._t < 3, "requests alone: sent after about 2 s")
check(countMarks("lister_busy_requests") == 1 and countMarks("lister_busy_requests_ignored") == 1, "requests alone: marked waited, then ignored")
tNative.vRequests = nil

-- connectingAction, loadingItems: each keeps it waiting
for _, tCase in ipairs({ { "bConnecting", true, "connecting" }, { "bLoading", true, "loading" } }) do
	reset()
	oStorage:TransitionIn()
	addAnimal(402)
	tNative[tCase[1]] = tCase[2]
	sReq, nFrom = start(job(1000, { line(402, "500", "max") }))
	check(runToEnd(30), "run finished")
	tAll = states(nFrom)
	local t1, rr = resultTime(tAll, 1)
	check(rr and rr.kind == "busy" and #tAuctions == 0, tCase[3] .. ": skipped busy")
	check(t1 and t1 - tAll[1]._t >= 10 and t1 - tAll[1]._t < 10.5, tCase[3] .. ": after 10 s")
	check(countMarks("lister_busy_" .. tCase[3]) == 1, tCase[3] .. ": marked")
end

-- busy again after the selection: the send waits (bounded)
reset()
oStorage:TransitionIn()
addAnimal(403, { onSelect = function()
	after(0.4, function() tNative.bDbBusy = true end)
	after(2.4, function() tNative.bDbBusy = false end)
end })
sReq, nFrom = start(job(1000, { line(403, "500", "max") }))
check(runToEnd(30), "run finished")
check(lastState().results[1].status == "listed" and tAuctions[1].t - calls("Select")[1].t >= 2.4, "send waited for the server")
check(stepsSeen(states(nFrom)).send, "send step reported while waiting")

-----------------------------------------------------------------------
-- 8. Server answers
-----------------------------------------------------------------------
reset()
oStorage:TransitionIn()
local function outcome(tSteps_)
	return function(g, nHours)
		for _, x in ipairs(tSteps_) do
			if x[1] == "list" then
				after(x[2], function() listNow(g, nHours) end)
			else
				errorAt(x[2], x[3], x[4])
			end
		end
	end
end
addAnimal(501, { outcome = outcome({ { "err", 0.1, 8, 28 }, { "list", 0.5 }, { "err", 1.0, 5, 42 } }) }) -- other request type; a late error
addAnimal(502, { outcome = outcome({ { "err", 0.2, 5, 42 } }) })     -- NotAllowed
addAnimal(503, { outcome = outcome({ { "err", 0.2, 255, 42 } }) })   -- Unknown, never listed
addAnimal(504, { outcome = outcome({ { "err", 0.2, 255, 42 }, { "list", 2 } }) }) -- Unknown, listed after all
addAnimal(505, { outcome = outcome({ { "err", 0.2, 77, 42 } }) })    -- unnamed code
addAnimal(506, { outcome = outcome({ { "err", 1, 2, 42 }, { "list", 6 } }) }) -- DidNotGetResponse, late listing
addAnimal(507, { outcome = outcome({ { "err", 1, 2, 42 } }) })       -- DidNotGetResponse, never
addAnimal(508, { outcome = never() })                                  -- no answer at all
local tJob = {}
for g = 501, 508 do tJob[#tJob + 1] = line(g, "500", "max") end
sReq, nFrom = start(job(1000, tJob))
check(runToEnd(200), "run finished")
tAll = states(nFrom)
s = tAll[#tAll]
local function sentAt(g)
	for _, a in ipairs(tAuctions) do if a.guid == g then return a.t end end
end
local function after_(i, g) return (resultTime(tAll, i)) - sentAt(g) end
check(s.results[1].status == "listed", "other request types ignored")
check(s.results[2].status == "refused" and s.results[2].kind == "refused" and string.find(s.results[2].detail, "NotAllowed", 1, true), "named refusal: " .. s.results[2].detail)
check(after_(2, 502) < 0.6, "named refusal at once: " .. string.format("%.2f", after_(2, 502)))
check(s.results[3].status == "refused" and after_(3, 503) >= 3.2 and after_(3, 503) < 3.8, "Unknown refused after the grace: " .. string.format("%.2f", after_(3, 503)))
check(s.results[4].status == "listed", "Unknown but listed within the grace")
check(s.results[5].status == "refused" and string.find(s.results[5].detail, "code 77", 1, true), "unnamed code refused: " .. s.results[5].detail)
check(after_(5, 505) >= 3.2, "unnamed code got the grace")
check(s.results[6].status == "listed", "DidNotGetResponse then a late listing")
check(s.results[7].status == "timeout" and s.results[7].kind == "timeout" and after_(7, 507) >= 9 and after_(7, 507) < 9.5, "DidNotGetResponse: 8 s more: " .. string.format("%.2f", after_(7, 507)))
check(s.results[8].status == "timeout" and after_(8, 508) >= 30 and after_(8, 508) < 30.5, "no answer: 30 s: " .. string.format("%.2f", after_(8, 508)))
check(sentAt(503) - (resultTime(tAll, 2)) >= 1, "pause after a refusal")
check(#tAuctions == 8, "each sent once")
check(countMarks("lister_refused") == 3 and countMarks("lister_timeout") == 2, "refused/timeout marked")

-----------------------------------------------------------------------
-- 9. Stop at each step
-----------------------------------------------------------------------
local function stopCase(sName, fnSetup, fnWhen, fnCheck)
	reset()
	oStorage:TransitionIn()
	addAnimal(601)
	addAnimal(602)
	if fnSetup then fnSetup() end
	sReq, nFrom = start(job(1000, { line(601, "500", "max"), line(602, "500", "max") }))
	check(tickUntil(fnWhen, 40), sName .. ": reached")
	local nAuctions, nSelects = #tAuctions, #calls("Select")
	fire("PZ2QoL_ListerStop")
	check(Lister.tRun == nil, sName .. ": run ended at once")
	s = lastState()
	check(s.phase == "stopped" and s.step == "" and s.message == "Stopped by you.", sName .. ": phase stopped")
	seconds(5)
	check(#tAuctions == nAuctions and #calls("Select") == nSelects, sName .. ": nothing more sent or selected")
	fnCheck(s)
end
stopCase("stop while waiting for the server", function() tNative.bDbBusy = true end,
	function() return lastState().waited >= 1 end,
	function(x) check(x.results[1].status == "pending" and x.results[2].status == "pending" and x.index == 0 and #tAuctions == 0, "server: both still to do") end)
stopCase("stop while selecting", function() tAnimals[601].noSelect = true end,
	function() return Lister.tRun.sStep == "select" end,
	function(x) check(x.results[1].status == "pending" and #tAuctions == 0, "select: still to do") end)
stopCase("stop while settling", nil,
	function() return Lister.tRun.sStep == "selected" end,
	function(x) check(x.results[1].status == "pending" and x.results[1].price == JNULL and #tAuctions == 0, "selected: still to do") end)
stopCase("stop while the send waits", function()
		tAnimals[601].onSelect = function() after(0.3, function() tNative.bDbBusy = true end) end
	end,
	function() return Lister.tRun.sStep == "send" end,
	function(x) check(x.results[1].status == "pending" and #tAuctions == 0, "send: still to do") end)
stopCase("stop while confirming", function() tAnimals[601].outcome = never() end,
	function() return Lister.tRun.sStep == "confirm" end,
	function(x)
		check(x.results[1].status == "stopped" and x.results[1].kind == "stopped" and string.find(x.results[1].detail, "may still appear", 1, true), "confirm: stopped, may still appear")
		check(x.results[2].status == "pending" and x.index == 1 and #tAuctions == 1, "confirm: next still to do")
	end)
stopCase("stop while confirming, already listed", function() tAnimals[601].outcome = listAt(0.1) end,
	function() return Lister.tRun.sStep == "confirm" and tAnimals[601].timer > 0 end,
	function(x) check(x.results[1].status == "listed", "confirm: a last look finds it listed") end)
stopCase("stop while pausing", nil,
	function() return Lister.tRun.sStep == "pause" end,
	function(x) check(x.results[1].status == "listed" and x.results[2].status == "pending" and x.index == 1, "pause: first listed, second to do") end)
check(countMarks("lister_stop") == 1, "stop marked")
-- Stop without a run: the page gets the last state again
local nBefore = #sent("PZ2QoL_ListerState")
fire("PZ2QoL_ListerStop")
check(#sent("PZ2QoL_ListerState") == nBefore + 1 and lastState().phase == "stopped", "stop without a run re-sends the last state")

-----------------------------------------------------------------------
-- 10. Leaving Animal Storage ends the run
-----------------------------------------------------------------------
reset()
oStorage:TransitionIn()
addAnimal(701, { outcome = never() })
addAnimal(702)
sReq, nFrom = start(job(1000, { line(701, "500", "max"), line(702, "500", "max") }))
tickUntil(function() return Lister.tRun.sStep == "confirm" end)
oStorage:TransitionOut()
s = lastState()
check(Lister.tRun == nil and s.phase == "closed", "closed")
check(s.results[1].status == "stopped" and string.find(s.results[1].detail, "closed", 1, true), "closed while confirming: may still appear")
check(s.results[2].status == "pending", "closed: the rest still to do")
local tOut = calls("StorageOut")
check(#tOut == 1, "storage's own TransitionOut still runs")
check(countMarks("lister_closed") == 1, "closed marked")
_, nFrom = start(job(1000, { line(702, "500", "max") }))
check(states(nFrom)[1].refused == true and states(nFrom)[1].phase == "closed", "no run with storage closed")
-- closed while selecting: that animal stays to do
oStorage:TransitionIn()
tAnimals[702].noSelect = true
sReq, nFrom = start(job(1000, { line(702, "500", "max") }))
tickUntil(function() return Lister.tRun.sStep == "select" end)
oStorage:TransitionOut()
check(lastState().phase == "closed" and lastState().results[1].status == "pending", "closed while selecting: still to do")

-----------------------------------------------------------------------
-- 11. Keys change under the run
-----------------------------------------------------------------------
-- between two animals (and between Resolve and Start): found again by GUID
reset()
oStorage:TransitionIn()
addAnimal(801)
addAnimal(802)
addAnimal(803)
addAnimal(804)
local sJob = job(1000, { line(801, "500", "max"), line(802, "600", "max"), line(803, "700", "max") })
reshuffle({ 804, 803, 802, 801 }) -- after the page resolved its keys
sReq, nFrom = start(sJob)
tickUntil(function() return #tAuctions == 1 end)
reshuffle({ 802, 801, 804, 803 })
check(runToEnd(60), "run finished")
check(#tAuctions == 3, "three listings")
for i, g in ipairs({ 801, 802, 803 }) do
	check(tAuctions[i] and tAuctions[i].guid == g and tAuctions[i].price == 400 + 100 * i, "listing " .. i .. " is the right animal (" .. tostring(tAuctions[i] and tAuctions[i].guid) .. ")")
end
check(tAuctions[1].key == "animal_4" and tAuctions[2].key == "animal_1", "listed under the keys of the moment")
s = lastState()
check(s.results[1].status == "listed" and s.results[2].status == "listed" and s.results[3].status == "listed", "listed though the first one's key moved while confirming")

-- between the selection and the send: never the wrong animal
reset()
oStorage:TransitionIn()
addAnimal(811, { onSelect = function() after(0.35, function() reshuffle({ 812, 811, 813 }) end) end })
addAnimal(812)
addAnimal(813)
sReq, nFrom = start(job(1000, { line(811, "500", "max") }))
check(runToEnd(30), "run finished")
s = lastState()
check(s.results[1].status == "skipped" and s.results[1].kind == "changed", "changed: " .. tostring(s.results[1].kind))
check(#tAuctions == 0, "the animal now at that key was not listed")

-- the player selects another row while it settles
reset()
oStorage:TransitionIn()
addAnimal(821, { onSelect = function() after(0.3, function() tNative.tSelection = { "animal_2" } end) end })
addAnimal(822)
sReq, nFrom = start(job(1000, { line(821, "500", "max") }))
check(runToEnd(30), "run finished")
check(#tAuctions == 0 and lastState().results[1].kind ~= "listed", "another selection: not sent (" .. tostring(lastState().results[1].kind) .. ")")

-- ... or while the send waits for the server: checked again at the send
reset()
oStorage:TransitionIn()
addAnimal(831, { onSelect = function()
	after(0.3, function() tNative.bDbBusy = true end)
	after(1.0, function() tNative.tSelection = { "animal_2" } end)
	after(1.5, function() tNative.bDbBusy = false end)
end })
addAnimal(832)
sReq, nFrom = start(job(1000, { line(831, "500", "max") }))
check(runToEnd(30), "run finished")
check(#tAuctions == 0 and lastState().results[1].kind == "changed", "selection changed before the send: changed (" .. tostring(lastState().results[1].kind) .. ")")

-----------------------------------------------------------------------
-- 12. Unreadable selection or list
-----------------------------------------------------------------------
reset()
oStorage:TransitionIn()
addAnimal(901)
addAnimal(902)
-- neither the array nor the row flag readable
tNative.bSelUnreadable, tNative.bNoRowFlag = true, true
sReq, nFrom = start(job(1000, { line(901, "500", "max"), line(902, "600", "max") }))
check(runToEnd(30), "run finished")
check(#tAuctions == 2 and tAuctions[1].guid == 901 and tAuctions[2].guid == 902, "selection unreadable: limits and settle")
check(countMarks("lister_sel_unknown") == 2, "selection unknown marked per animal")

reset()
oStorage:TransitionIn()
addAnimal(911)
addAnimal(912)
tNative.bListUnreadable = true
sReq, nFrom = start(job(1000, { line(911, "500", "max"), gs(912) .. " animal_1 600 max" }))
check(runToEnd(30), "run finished")
s = lastState()
check(s.results[1].status == "listed", "list unreadable: found by its key, confirmed by its row")
check(s.results[2].kind == "gone" and string.find(s.results[2].detail, "could not be read", 1, true), "list unreadable and a stale key: gone")
check(#tAuctions == 1 and tAuctions[1].guid == 911, "only the right one sent")
check(countMarks("lister_list_unreadable") >= 2, "unreadable list marked")

-----------------------------------------------------------------------
-- 13. A Lua error in one animal's step skips it; the run carries on
-----------------------------------------------------------------------
reset()
oStorage:TransitionIn()
addAnimal(1001, { selectError = true })
addAnimal(1002, { sendError = true })
addAnimal(1003)
sReq, nFrom = start(job(1500, { line(1001, "500", "max"), line(1002, "500", "max"), line(1003, "500", "max") }))
check(runToEnd(30), "run finished")
tAll = states(nFrom)
s = tAll[#tAll]
check(s.results[1].kind == "error" and string.find(s.results[1].detail, "select blew up", 1, true), "error in select: skipped")
check(s.results[2].kind == "error", "error in the send: skipped")
check(s.results[3].status == "listed", "the run carried on")
check(sentAt(1003) - (resultTime(tAll, 2)) >= 1.5, "a failed send still gets the pause")
check(countMarks("lister_error") == 2, "errors marked")

-----------------------------------------------------------------------
-- 14. Pace: changed during a run, clamped, kept between runs
-----------------------------------------------------------------------
reset()
oStorage:TransitionIn()
addAnimal(1101)
addAnimal(1102)
addAnimal(1103)
sReq, nFrom = start(job(1000, { line(1101, "500", "max"), line(1102, "500", "max"), line(1103, "500", "max") }))
tickUntil(function() return Lister.tRun.sStep == "pause" end)
fire("PZ2QoL_ListerPace", 5000)
check(lastState().paceMs == 5000, "pace change reported")
tickUntil(function() return #tAuctions == 2 end)
fire("PZ2QoL_ListerPace", 200)
check(lastState().paceMs == 1000, "pace at least 1 s")
check(runToEnd(60), "run finished")
check(tAuctions[2].t - tAuctions[1].t >= 5.5, "the longer pause applied mid-pause")
check(tAuctions[3].t - tAuctions[2].t >= 1.5 and tAuctions[3].t - tAuctions[2].t < 4, "then the shorter one (plus the same-data settle)")
fire("PZ2QoL_ListerPace", 99999)
check(Lister.nPaceMs == 10000, "pace at most 10 s")
fire("PZ2QoL_ListerPace", "junk")
check(Lister.nPaceMs == 10000, "junk pace ignored")
_, nFrom = start("v1 50\n" .. line(1101, "500", "max"))
check(states(nFrom)[1].paceMs == 1000, "job pace clamped too")
fire("PZ2QoL_ListerStop")

-- a new run right after one: the pause still applies to its first listing
reset()
oStorage:TransitionIn()
addAnimal(1201)
addAnimal(1202)
sReq, nFrom = start(job(3000, { line(1201, "500", "max") }))
check(runToEnd(30), "first run finished")
local tFirst = states(nFrom)
local nResult = resultTime(tFirst, 1)
sReq, nFrom = start(job(3000, { line(1202, "500", "max") }))
check(states(nFrom)[1].step == "pause", "second run starts with the pause")
check(runToEnd(30), "second run finished")
check(tAuctions[2].t - nResult >= 3, "pace kept across runs: " .. string.format("%.2f", tAuctions[2].t - nResult))

-----------------------------------------------------------------------
-- 15. One run at a time; a page that reloads picks the run up
-----------------------------------------------------------------------
reset()
oStorage:TransitionIn()
addAnimal(1301)
addAnimal(1302)
addAnimal(1303)
sReq, nFrom = start(job(1000, { line(1301, "500", "max"), line(1302, "500", "max"), line(1303, "500", "max") .. "\n" .. line(1301, "900", "max") }))
check(states(nFrom)[1].total == 3, "a GUID listed twice counts once")
local nRun = Lister.tRun.nId
local sReq2, nFrom2 = start(job(1000, { line(1302, "500", "max") }))
local tTwo = states(nFrom2)
check(#tTwo == 2 and tTwo[1].refused == true and tTwo[1].req == sReq2 and tTwo[2].run == nRun and tTwo[2].phase == "running", "second start refused, current state re-sent")
fire("PZ2QoL_ListerHello", "h9")
c = decode(sent("PZ2QoL_ListerCaps")[1].tArgs[2])
check(c.running == true, "caps: running")
check(runToEnd(60), "run finished")
check(#tAuctions == 3 and lastState().run == nRun, "the first run went on")

-----------------------------------------------------------------------
-- 15b. The previous animal's data must not pass for this one's: the
-- selection shows at once, the data 0.9 s later, and Clear leaves the old
-- data (the worst case)
-----------------------------------------------------------------------
do
	reset()
	oStorage:TransitionIn()
	tNative.nSelectDelay, tNative.nDataDelay = 0.05, 0.9
	addAnimal(1501)                                            -- tradeable
	addAnimal(1502, { tradeAllowed = false, reason = "[AnimalList_Problem_Pregnant]" })
	local sR, nF = start(job(1000, { line(1501, "500", "max"), line(1502, "500", "max") }))
	check(runToEnd(60), "stale: run finished")
	local tLast = lastState()
	check(#tAuctions == 1 and tAuctions[1].guid == 1501, "stale: only the tradeable one was sent (" .. #tAuctions .. ")")
	check(tLast.results[2].status == "skipped" and tLast.results[2].kind == "untradeable", "stale: the untradeable one skipped on its own data")
	check(countMarks("lister_data_same") >= 1, "stale: waited while the data was unchanged")
	-- same data for both: the second still goes, after the longer wait
	reset()
	oStorage:TransitionIn()
	tNative.nSelectDelay, tNative.nDataDelay = 0.05, 0.9
	addAnimal(1503)
	addAnimal(1504)
	sR, nF = start(job(1000, { line(1503, "500", "max"), line(1504, "700", "max") }))
	check(runToEnd(60), "same data: run finished")
	local tSel = calls("Select")
	check(#tAuctions == 2 and tAuctions[2].guid == 1504 and tAuctions[2].price == 700, "same data: both sent, the second at its own price")
	check(tSel[2] and tAuctions[2].t - tSel[2].t >= 1.5, "same data: the second waited for the longer settle")
	resetNative()
end

-----------------------------------------------------------------------
-- 16. Hours fallbacks; every mark name is in checkpoints.txt
-----------------------------------------------------------------------
reset()
oStorage:TransitionIn()
local tNoMax = defaultLimits()
tNoMax.tradeDurationMax = nil
addAnimal(1401, { limits = tNoMax })
local tNoHours = defaultLimits()
tNoHours.tradeDurationMax, tNoHours.tradeDurationDefault, tNoHours.tradeDurationMin = nil, nil, nil
addAnimal(1402, { limits = tNoHours })
sReq, nFrom = start(job(1000, { line(1401, "500", "max"), line(1402, "500", "default") }))
check(runToEnd(30), "run finished")
check(#tAuctions == 1 and tAuctions[1].hours == 6, "hours: no max -> the game's default (" .. tostring(tAuctions[1] and tAuctions[1].hours) .. ")")
-- no duration limits at all: never sent (it would go out for 1 h)
check(lastState().results[2].status == "skipped" and lastState().results[2].kind == "unselectable", "no duration limits: skipped, not sent")

-----------------------------------------------------------------------
-- The selection as the game shows it to Lua: selectedAnimalIDs empty, the
-- row's own flag right (Y: 2026-10-17, every animal was "unselectable")
-----------------------------------------------------------------------
reset()
oStorage:TransitionIn()
tNative.bSelArrayEmpty = true
addAnimal(1501)
addAnimal(1502)
sReq, nFrom = start(job(1000, { line(1501, "500", "max"), line(1502, "600", "max") }))
check(runToEnd(30), "array empty: run finished")
check(#tAuctions == 2 and lastState().results[1].status == "listed" and lastState().results[2].status == "listed", "array empty: listed by the row flag")
check(countMarks("lister_sel_array_empty") == 1 and countMarks("lister_sel_array_ok") == 0 and countMarks("lister_unsel_selection") == 0, "array empty: marked once, nothing unselectable")

-- the array readable: marked ok (read after selecting, not after the Clear)
reset()
oStorage:TransitionIn()
addAnimal(1505)
sReq, nFrom = start(job(1000, { line(1505, "500", "max") }))
check(runToEnd(30), "array ok: run finished")
check(countMarks("lister_sel_array_ok") == 1 and countMarks("lister_sel_array_empty") == 0, "array readable: marked ok")

-- neither the array nor the flag: listed on the data alone (as before)
reset()
oStorage:TransitionIn()
tNative.bSelArrayEmpty, tNative.bNoRowFlag = true, true
addAnimal(1511)
sReq, nFrom = start(job(1000, { line(1511, "500", "max") }))
check(runToEnd(30), "no flag: run finished")
check(#tAuctions == 1 and lastState().results[1].status == "listed", "no flag, empty array: listed on the data")

-- the selection does not take (flag stays false): unselectable, never sent
reset()
oStorage:TransitionIn()
tNative.bSelArrayEmpty = true
addAnimal(1521, { noSelect = true })
addAnimal(1522)
sReq, nFrom = start(job(1000, { line(1521, "500", "max"), line(1522, "500", "max") }))
check(runToEnd(30), "flag false: run finished")
check(#tAuctions == 1 and tAuctions[1].guid == 1522, "flag false: only the second sent")
check(lastState().results[1].kind == "unselectable" and countMarks("lister_unsel_selection") == 1, "flag false: unselectable")

-- another animal ticked as well just before sending: not sent
reset()
oStorage:TransitionIn()
addAnimal(1531, { onSelect = function(sKey)
	after(0.3, function() tNative.tSelection = { sKey, keyOf(1532) } end)
end })
addAnimal(1532)
sReq, nFrom = start(job(1000, { line(1531, "500", "max") }))
check(runToEnd(30), "multi: run finished")
check(#tAuctions == 0 and lastState().results[1].status ~= "listed", "multi-selection: not sent (" .. tostring(lastState().results[1].kind) .. ")")
check(countMarks("lister_sel_other") >= 1, "multi-selection marked")

-----------------------------------------------------------------------
-- 17. Page-assisted reads: the page reports the selection, tradeAllowed
-- and the limits (PZ2QoL_ListerWatch -> PZ2QoL_ListerSeen) while Lua's own
-- reads of them are broken (Y: 2026-10-17, every animal "unselectable")
-----------------------------------------------------------------------
check(oView.tListeners["PZ2QoL_ListerSeen"] ~= nil, "listener PZ2QoL_ListerSeen")

-- the page's text, exactly as listercore.js encodeSeen writes it
local p = Lister.ParseSeen("v1|animal_3|animal_3|1|100,5000,812.5,1,12,6|")
check(p and p.sKey == "animal_3" and #p.tSel == 1 and p.tSel[1] == "animal_3" and p.bAllowed == true and p.sReason == "", "parse: selected, allowed")
check(p and p.tLimits.nPriceMin == 100 and p.tLimits.nPriceMax == 5000 and p.tLimits.nPriceDefault == 812.5 and p.tLimits.nHoursMax == 12 and p.tLimits.nHoursDefault == 6, "parse: limits")
p = Lister.ParseSeen("v1|animal_3||0|-,-,-,-,-,-|[STRING_LITERAL:Value=|Pregnant|] ")
check(p and #p.tSel == 0 and p.bAllowed == false and p.tLimits.nPriceMin == nil and p.sReason == "[STRING_LITERAL:Value=|Pregnant|] ", "parse: empty selection, a reason with pipes")
p = Lister.ParseSeen("v1|animal_3|?|-|-,-,-,-,-,-|")
check(p and p.tSel == nil and p.bAllowed == nil, "parse: unreadable selection")
check(Lister.ParseSeen("v2|animal_3|||||") == nil and Lister.ParseSeen(nil) == nil and Lister.ParseSeen("v1||a|1|1|") == nil, "parse: junk refused")

-- the fake page: gets Lua's events a frame late, reports every 0.1 s what
-- the game really shows (tNative), not what Lua's broken reads give
local tPage
local function pageReset(t)
	tPage = { bOn = true, nIdx = 0, sReq = nil, sKey = nil, nNext = 0, nReports = 0, nWatches = 0, nStops = 0 }
	for k, v in pairs(t or {}) do tPage[k] = v end
end
local function pageText()
	local tSel = tPage.fnSel and tPage.fnSel() or tNative.tSelection
	local a = tNative.tActions.tradeAllowed
	local tN = {}
	for _, sName in ipairs({ "tradePriceMin", "tradePriceMax", "tradePriceDefault", "tradeDurationMin", "tradeDurationMax", "tradeDurationDefault" }) do
		local n = tNative.tLimits[sName]
		tN[#tN + 1] = type(n) == "number" and tostring(n) or "-"
	end
	return table.concat({ "v1", tPage.sKey, table.concat(tSel, ","), a == true and "1" or a == false and "0" or "-",
		table.concat(tN, ","), tNative.tActions.tradeDisallowedReason or "" }, "|")
end
fnPageFrame = function()
	if tPage == nil or not tPage.bOn then return end
	if tPage.nIdx > #oView.tSent then tPage.nIdx = 0 end
	while tPage.nIdx < #oView.tSent and oView.tSent[tPage.nIdx + 1].t < nClock do
		tPage.nIdx = tPage.nIdx + 1
		local x = oView.tSent[tPage.nIdx]
		if x.sName == "PZ2QoL_ListerWatch" then
			local sWReq, sKey = x.tArgs[1], x.tArgs[2]
			if sWReq == "" or sKey == "" then
				tPage.sReq, tPage.nStops = nil, tPage.nStops + 1
			elseif sWReq ~= tPage.sReq then
				tPage.sReq, tPage.sKey, tPage.nNext, tPage.nWatches = sWReq, sKey, nClock, tPage.nWatches + 1
				tPage.nThis = 0
			end
		end
	end
	if tPage.sReq ~= nil and nClock >= tPage.nNext - 1e-9 and (tPage.nMax == nil or tPage.nThis < tPage.nMax) then
		tPage.nNext = nClock + 0.1
		tPage.nReports = tPage.nReports + 1
		tPage.nThis = tPage.nThis + 1
		fire("PZ2QoL_ListerSeen", tPage.sFixedReq or tPage.sReq, pageText())
	end
end
local function pageRun(tSetup, tSpec, sLabel)
	reset()
	oStorage:TransitionIn()
	for k, v in pairs(tSetup.native or {}) do tNative[k] = v end
	pageReset(tSetup.page)
	for _, a in ipairs(tSpec) do addAnimal(a[1], a[2]) end
	local tLines = {}
	for _, a in ipairs(tSpec) do tLines[#tLines + 1] = line(a[1], a[3] or "500", "max") end
	sReq, nFrom = start(job(1000, tLines))
	check(runToEnd(90), sLabel .. ": run finished")
	return lastState()
end

-- every Lua read broken (flag nil, array empty, tradeAllowed and limits nil):
-- listed on the page's reports, at their own prices
local tOwn = defaultLimits()
tOwn.tradePriceMax = 4000
s = pageRun({ native = { bLuaSelBroken = true, bLuaDataBroken = true } }, { { 1601 }, { 1602, { limits = tOwn }, "99999" }, { 1603, nil, "-" } }, "page")
check(#tAuctions == 3 and s.results[1].status == "listed" and s.results[2].status == "listed" and s.results[3].status == "listed", "page: all listed (" .. #tAuctions .. ")")
check(tAuctions[3] and tAuctions[1].price == 500 and tAuctions[2].price == 4000 and tAuctions[3].price == 800 and tAuctions[1].hours == 12, "page: the page's limits clamp and default")
check(countMarks("lister_page_seen") == 1 and countMarks("lister_unsel_selection") == 0, "page: seen marked once, nothing unselectable")
check(countMarks("lister_diag_flag_nil") == 1 and countMarks("lister_diag_arr_empty") == 1 and countMarks("lister_diag_allowed_nil") == 1 and countMarks("lister_diag_limits_none") == 1, "page: Lua's own reads diagnosed once per run")
check(tPage.nWatches == 6 and tPage.nStops >= 3 and tPage.sReq == nil, "page: watched at each clear and select, stopped after (" .. tPage.nWatches .. " watches, " .. tPage.nStops .. " stops)")
local tSelCalls = calls("Select")
for i, a in ipairs(tAuctions) do
	check(tSelCalls[i] and a.t - tSelCalls[i].t >= 0.25 + 0.6 - 1e-3, "page: listing " .. i .. " waited for the data and the settle")
end
check(tSelCalls[2] and tAuctions[2] and tAuctions[2].t - tSelCalls[2].t < 1.5, "page: the second (its own data) compared like with like: no extra settle")

-- the flag always false, the rest of Lua's reads fine: the page decides
s = pageRun({ native = { bLuaFlagFalse = true } }, { { 1611 } }, "flag false")
check(#tAuctions == 1 and s.results[1].status == "listed", "flag false: listed on the page's report")
check(countMarks("lister_diag_flag_false") == 1 and countMarks("lister_diag_allowed_bool") == 1 and countMarks("lister_diag_limits_ok") == 1, "flag false: diagnosed")

-- the page shows another animal selected: never sent
s = pageRun({ native = { bLuaSelBroken = true, bLuaDataBroken = true }, page = { fnSel = function() return { "animal_9" } end } }, { { 1621 }, { 1622 } }, "other")
check(#tAuctions == 0 and s.results[1].kind == "unselectable" and s.results[2].kind == "unselectable", "other: nothing sent")
check(countMarks("lister_page_sel_other") == 2, "other: the page's view marked")

-- right at first, then another one selected before the send (while it waits for the server)
s = pageRun({ native = { bLuaSelBroken = true, bLuaDataBroken = true } }, { { 1631, { onSelect = function()
	after(0.4, function() tNative.bDbBusy = true end)
	after(2.5, function() tPage.fnSel = function() return { "animal_2" } end end)
	after(3.5, function() tNative.bDbBusy = false end)
end } }, { 1632 } }, "other at send")
local bSent1631 = false
for _, a in ipairs(tAuctions) do if a.guid == 1631 then bSent1631 = true end end
check(not bSent1631 and s.results[1].kind == "changed", "other at send: not sent, changed (" .. tostring(s.results[1].kind) .. ")")

-- the page's limits missing: never sent without them
s = pageRun({ native = { bLuaSelBroken = true } }, { { 1641, { limits = { tradeDurationMax = 12 } } } }, "no limits")
check(#tAuctions == 0 and s.results[1].kind == "unselectable" and countMarks("lister_unsel_limits") == 1 and countMarks("lister_page_sel_key") == 1, "page limits missing: not sent")

-- not tradeable, by the page: skipped with the game's reason
s = pageRun({ native = { bLuaSelBroken = true, bLuaDataBroken = true } }, { { 1651, { tradeAllowed = false, reason = "[AnimalList_Problem_Pregnant]" } } }, "untradeable")
check(#tAuctions == 0 and s.results[1].kind == "untradeable" and s.results[1].detail == "[AnimalList_Problem_Pregnant]", "page untradeable: the reason (" .. tostring(s.results[1].detail) .. ")")

-- no page reports at all and Lua's reads broken: as before, unselectable
s = pageRun({ native = { bLuaSelBroken = true, bLuaDataBroken = true }, page = { bOn = false } }, { { 1661 } }, "no page")
check(#tAuctions == 0 and s.results[1].kind == "unselectable" and countMarks("lister_page_none") == 1 and countMarks("lister_page_seen") == 0, "no page: unselectable, marked")

-- stale reports: the page answers a few times per watch, then goes quiet
s = pageRun({ native = { bLuaSelBroken = true, bLuaDataBroken = true }, page = { nMax = 3 } }, { { 1671 } }, "stale")
check(#tAuctions == 0 and s.results[1].kind == "unselectable", "stale reports: not used, not sent")
-- ... with Lua's own reads working, the fallback lists as before
s = pageRun({ page = { nMax = 3 } }, { { 1672 } }, "stale, Lua fine")
check(#tAuctions == 1 and s.results[1].status == "listed", "stale reports, Lua's reads fine: listed on Lua's reads")

-- reports for an older watch never count
s = pageRun({ native = { bLuaSelBroken = true, bLuaDataBroken = true }, page = { sFixedReq = "w0_1" } }, { { 1681 } }, "old req")
check(#tAuctions == 0 and s.results[1].kind == "unselectable" and countMarks("lister_page_seen") == 0, "old watch id: ignored")

-- the key moves to another animal after the select: the same-tick check still holds
s = pageRun({ native = { bLuaSelBroken = true, bLuaDataBroken = true } }, { { 1691, { onSelect = function()
	after(0.35, function() reshuffle({ 1692, 1691 }) end)
end } }, { 1692, { noSelect = true } } }, "reshuffle")
check(#tAuctions == 0, "page + reshuffle: never the wrong animal (" .. #tAuctions .. ")")
check(s.results[1].kind == "changed" or s.results[1].kind == "unselectable", "page + reshuffle: skipped (" .. tostring(s.results[1].kind) .. ")")

-- a page that misses its watch is asked again
s = pageRun({ native = { bLuaSelBroken = true, bLuaDataBroken = true }, page = { bOn = false } }, { { 1697, { noSelect = true } } }, "resend")
local nWatchSends = #sent("PZ2QoL_ListerWatch")
check(nWatchSends >= 5, "watch asked again while nothing reports (" .. nWatchSends .. ")")

-- the page in a working game: Lua's reads fine too, still listed
s = pageRun({}, { { 1695 }, { 1696 } }, "both")
check(#tAuctions == 2 and countMarks("lister_diag_flag_true") == 1 and countMarks("lister_diag_arr_key") == 1, "both readable: listed, diagnosed")
fnPageFrame = nil

-----------------------------------------------------------------------
-- Row id != row key (proven in game, 2026-10-17, lister_id_differs):
-- SelectItem takes the row's id (a key there is another animal),
-- GetIDAndAIDType and the listing call take the key. The engine selects
-- by id, resolves and lists by key.
-----------------------------------------------------------------------
reset()
oStorage:TransitionIn()
tNative.bIdOther = true
addAnimal(1601)
addAnimal(1602)
addAnimal(1603)
sReq, nFrom = start(job(1000, { line(1602, "500", "max"), line(1603, "600", "max") }))
check(runToEnd(30), "id != key: run finished")
check(#tAuctions == 2 and tAuctions[1].guid == 1602 and tAuctions[2].guid == 1603, "id != key: the right animals listed (" .. tostring(tAuctions[1] and tAuctions[1].guid) .. ", " .. tostring(tAuctions[2] and tAuctions[2].guid) .. ")")
check(tAuctions[1] and tAuctions[1].key == keyOf(1602), "id != key: listed by the row key")
local tSelId = calls("Select")
check(#tSelId == 2 and tSelId[1].tArgs[2] == 1602 and tSelId[2].tArgs[2] == 1603, "id != key: selected the right animals")
check(countMarks("lister_id_differs") >= 1, "id != key: marked")

-----------------------------------------------------------------------
-- Other id types (exhibit animals: 4): identified and listed by key
-----------------------------------------------------------------------
reset()
oStorage:TransitionIn()
addAnimal(1701, { aidType = 4 })
addAnimal(1702)
fire("PZ2QoL_ListerResolve", "r17", keyOf(1701) .. "," .. keyOf(1702))
local tIdsMsg = sent("PZ2QoL_ListerIds")
local tIdsAns = decode(tIdsMsg[#tIdsMsg].tArgs[2])
check(tIdsAns.ids[keyOf(1701)] == "t4_1701" and tIdsAns.ids[keyOf(1702)] == "1702", "type 4 resolved as t4_<id> (" .. tostring(tIdsAns.ids[keyOf(1701)]) .. ")")
sReq, nFrom = start(job(1000, { "t4_1701 " .. keyOf(1701) .. " 500 max", line(1702, "600", "max") }))
check(runToEnd(30), "type 4: run finished")
check(#tAuctions == 2 and tAuctions[1].guid == 1701 and tAuctions[2].guid == 1702, "type 4: both listed")
check(countMarks("lister_idtype_4") == 1, "type 4 traced")
-- a skip says why
reset()
oStorage:TransitionIn()
addAnimal(1711, { tradeAllowed = false })
sReq, nFrom = start(job(1000, { line(1711, "500", "max") }))
check(runToEnd(30), "untradeable: run finished")
check(countMarks("lister_skip_untradeable") == 1, "skip kind traced")

local tKnown = {}
local f = io.open(sModDir .. "../../../tools/trace/checkpoints.txt", "r")
check(f ~= nil, "checkpoints.txt found")
if f then
	for l in f:lines() do tKnown[(string.gsub(l, "%s+$", ""))] = true end
	f:close()
end
local fSrc = assert(io.open(sModDir .. "pz2qol.lister.lua", "r"))
local sSrc = fSrc:read("a")
fSrc:close()
local tUsed = {}
for sName in string.gmatch(sSrc, 'mark%("([%w_]+)"%)') do tUsed[sName] = true end
for sName in string.gmatch(sSrc, '"(lister_[%w_]+)"') do tUsed[sName] = true end
for _, sWhy in ipairs({ "db", "requests", "connecting", "loading", "peek" }) do tUsed["lister_busy_" .. sWhy] = true end
for _, sWhy in ipairs({ "selection", "allowed", "limits" }) do tUsed["lister_unsel_" .. sWhy] = true end
for sName in pairs(tUsed) do
	-- prefixes of names built at run time end with "_"
	if string.sub(sName, -1) ~= "_" then
		check(tKnown[sName], "checkpoints.txt has " .. sName)
	end
end
check(tKnown["init_ok_pz2qol.lister"] and tKnown["init_fail_pz2qol.lister"], "checkpoints.txt has the init names")
check(#calls("CreateContext") == 0, "still no DataStore context created")

print(string.format("%d passed, %d failed", nPassed, nFailed))
if nFailed > 0 then os.exit(1) end
