-- Behaviour test for PZ2QoL.StorageSend ("Find a habitat") against a mock
-- of the game API. Run:
--   lua53 tests/lua/test_storagesend.lua <path-to-mods/PZ2QoL/Main/>
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
-- Mock game
-----------------------------------------------------------------------
local nClock = 100
local sHubType = "offline"
local tCalls = {}
local function record(sName, ...) tCalls[#tCalls + 1] = { sName = sName, tArgs = table.pack(...) } end
local function count(sName)
	local n = 0
	for _, c in ipairs(tCalls) do if c.sName == sName then n = n + 1 end end
	return n
end

local franchise = {
	PlanetHubType_FranchiseOnline = 2,
	GetPlanetHubType = function() return sHubType == "franchise" and 2 or 1 end,
	IsDatabaseOperationInProgress = function() return false end,
}

-- animals 101 (lion cub, parents 1 and 2), 102 (tiger), 1/2 lion parents in habitat 500
local tSpecies = { [101] = "Lion", [102] = "Tiger", [1] = "Lion", [2] = "Lion", [3] = "Lion", [9] = "Zebra" }
local tHabOf = { [1] = 500, [2] = 500, [3] = 501, [9] = 502 }
local animals = {
	CurrentLocationType_Habitat = 1, CurrentLocationType_TradeCentre = 2, CurrentLocationType_FreeRoaming = 5,
	GetSpecies = function(_, e) return tSpecies[e] end,
	EntityIDToAnimalGUID = function(_, e) return tSpecies[e] and ("g" .. e) or 0 end,
	AnimalGUIDToEntityID = function(_, g) return tonumber(string.sub(g, 2)) or 0 end,
	GetName = function(_, e) return "Animal" .. e end,
	IsAlive = function() return true end,
	IsEscaped = function() return false end,
	IsBoxAnimating = function() return false end,
	IsBoxingClaimed = function() return false end,
	GetCurrentLocationType = function(_, e) return tHabOf[e] and 1 or 2 end,
	GetAnimalTransportData = function(_, e) return { bHasTransportJob = false } end,
	GetAssignedHabitatEntityID = function(_, e) return tHabOf[e] or 0 end,
	GetParents = function(_, g) if g == "g101" then return { "g1", "g2" } end return { "", "" } end,
	IsValidHabitatForAnimalsGUID = function(_, h, tGuids)
		local sp = tSpecies[tonumber(string.sub(tGuids[1], 2))]
		if sp == "Lion" then return h == 500 or h == 501 end
		if sp == "Tiger" then return h == 501 end
		return false
	end,
	CanTransportToEntity = function() return true, 3 end,
	DoesTransportRequireStaff = function() return true end,
	AttemptRequestToTransportAnimalToTarget = function(_, e, h, n) record("Transport", e, h, n) return true end,
}
local habitat = {
	GetAllCompleteHabitats = function() return { 500, 501, 502 } end,
	GetAnimalsInHabitat = function(_, h)
		local t = {}
		for e, hh in pairs(tHabOf) do if hh == h then t[#t + 1] = e end end
		table.sort(t)
		return t
	end,
	IsAquarium = function() return false end,
	IsHabitatTooCrowded = function() return false end,
}
local tWorld = {
	franchise = franchise, animals = animals, habitat = habitat,
	staff = { CanStaffDeliverAnimalToFacility = function() return true end },
	editors = { IsValidTutorialPlacement = function() return true end },
	park = {},
	facilities = { GetTradeCentres = function() return {} end },
}
api = {
	debug = { Trace = function() end },
	time = {
		GetPerformanceTimer = function() return nClock end,
		PerformanceTimeToMilliseconds = function(n) return n * 1000 end,
	},
	ui2 = { GetEntityName = function(e) return "Hab" .. tostring(e) end },
	world = { GetWorldAPIs = function() return tWorld end },
}

-- a view: records Lua -> JS events, fires JS -> Lua listeners
local oView = { tListeners = {}, tSent = {} }
function oView:AddEventListener(sName, nArgs, fn, arg) self.tListeners[sName] = function(...) return fn(arg, ...) end end
function oView:TriggerEventAtNextAdvance(sName, ...) self.tSent[#self.tSent + 1] = { sName = sName, tArgs = table.pack(...) } end
function oView:IsReady() return true end
local function fire(sName, ...) return assert(oView.tListeners[sName], "no listener " .. sName)(...) end
local function lastSent(sName)
	for i = #oView.tSent, 1, -1 do
		if oView.tSent[i].sName == sName then return oView.tSent[i] end
	end
end

package.loaded["pz2qol.hub"] = { bHUDIsModded = true, oHUDUI = oView }

local tPatches = {}
local Core = { AddModulePatch = function(_, sName, fn) tPatches[string.lower(sName)] = fn end, Mark = function() end }

local Kin = require("PZ2QoL.Kin")
local StorageSend = require("PZ2QoL.StorageSend")
StorageSend:Init(Core)
check(tPatches["editors.shared.baseuimode"] ~= nil, "patches BaseUIMode")

local tOriginal = {}
local BaseUIMode = { SetNewMode = function(sMode, tParams) tOriginal[#tOriginal + 1] = { sMode = sMode, tParams = tParams } end }
tPatches["editors.shared.baseuimode"](BaseUIMode)
StorageSend:Attach(oView)
for _, s in ipairs({ "PZ2QoL_SendArm", "PZ2QoL_SendDisarm", "PZ2QoL_SendHello", "PZ2QoL_SendAck", "PZ2QoL_SendFacts", "PZ2QoL_SendMove" }) do
	check(oView.tListeners[s] ~= nil, "listener " .. s)
end

-----------------------------------------------------------------------
-- 1. Taking the Move screen request
-----------------------------------------------------------------------
-- not armed: the game's Move screen opens
BaseUIMode.SetNewMode("AnimalMovementMode", { tSelectedAnimals = { 101, 102 } })
check(#tOriginal == 1, "unarmed: vanilla Move screen")

-- armed (offline zoo): taken, handed to the park page, not opened
fire("PZ2QoL_SendArm", 2, false)
BaseUIMode.SetNewMode("AnimalMovementMode", { tSelectedAnimals = { 101, 102 } })
check(#tOriginal == 1, "armed: Move screen not opened")
local tArrived = lastSent("PZ2QoL_SendArrived")
check(tArrived ~= nil and tArrived.tArgs[2] == "101,102", "arrived ids sent to the page")
check(tArrived ~= nil and tArrived.tArgs[3] == false, "online consent passed on")
-- other modes pass through untouched
BaseUIMode.SetNewMode("Select")
check(#tOriginal == 2 and tOriginal[2].sMode == "Select", "other modes untouched")
-- the arm is used once
BaseUIMode.SetNewMode("AnimalMovementMode", { tSelectedAnimals = { 101 } })
check(#tOriginal == 3, "arm used only once")
-- hello re-sends until acked
local nBefore = #oView.tSent
fire("PZ2QoL_SendHello")
check(#oView.tSent == nBefore + 1, "hello re-sends the arrival")
fire("PZ2QoL_SendAck", tArrived.tArgs[1])
fire("PZ2QoL_SendHello")
check(#oView.tSent == nBefore + 1, "no re-send after ack")

-- more animals than armed, exhibits, or a disarm: vanilla
fire("PZ2QoL_SendArm", 1, false)
BaseUIMode.SetNewMode("AnimalMovementMode", { tSelectedAnimals = { 101, 102 } })
check(#tOriginal == 4, "count mismatch: vanilla")
fire("PZ2QoL_SendArm", 5, false)
BaseUIMode.SetNewMode("AnimalMovementMode", { tSelectedAnimals = { "g1" }, bIsExhibit = true })
check(#tOriginal == 5, "exhibit animals: vanilla")
fire("PZ2QoL_SendArm", 5, false)
fire("PZ2QoL_SendDisarm")
BaseUIMode.SetNewMode("AnimalMovementMode", { tSelectedAnimals = { 101 } })
check(#tOriginal == 6, "disarmed: vanilla")
-- an old arm expires
fire("PZ2QoL_SendArm", 5, false)
nClock = nClock + 601
BaseUIMode.SetNewMode("AnimalMovementMode", { tSelectedAnimals = { 101 } })
check(#tOriginal == 7, "expired arm: vanilla")

-- Franchise: only with the player's consent
sHubType = "franchise"
fire("PZ2QoL_SendArm", 2, false)
BaseUIMode.SetNewMode("AnimalMovementMode", { tSelectedAnimals = { 101 } })
check(#tOriginal == 8, "franchise without consent: vanilla")
fire("PZ2QoL_SendArm", 2, true)
BaseUIMode.SetNewMode("AnimalMovementMode", { tSelectedAnimals = { 101 } })
check(#tOriginal == 8, "franchise with consent: taken")
sHubType = "offline"

-- no modded park page: vanilla
package.loaded["pz2qol.hub"].bHUDIsModded = false
fire("PZ2QoL_SendArm", 2, false)
BaseUIMode.SetNewMode("AnimalMovementMode", { tSelectedAnimals = { 101 } })
check(#tOriginal == 9, "no mod page: vanilla")
package.loaded["pz2qol.hub"].bHUDIsModded = true

-----------------------------------------------------------------------
-- 2. Facts for one animal
-----------------------------------------------------------------------
Kin.oHeatMapManager = { tWorldAPIs = tWorld }
Kin.nLastTick = nClock
fire("PZ2QoL_SendFacts", "ss1", "101")
local tFacts = lastSent("PZ2QoL_SendFactsResult")
check(tFacts ~= nil and tFacts.tArgs[1] == "ss1", "facts answered")
local sJson = tFacts and tFacts.tArgs[2] or ""
check(string.find(sJson, '"species":"Lion"', 1, true) ~= nil, "facts: species")
check(string.find(sJson, '"parentHabs":["500"]', 1, true) ~= nil, "facts: parents' habitat (once) " .. sJson)
check(string.find(sJson, '"mode":"offline"', 1, true) ~= nil, "facts: mode")
local function habJson(sId)
	for sObj in string.gmatch(sJson, "{[^{}]*}") do
		if string.find(sObj, '"id":"' .. sId .. '"', 1, true) then return sObj end
	end
	return ""
end
check(string.find(habJson("500"), '"ok":true', 1, true) ~= nil, "facts: habitat 500 allowed")
check(string.find(habJson("500"), '"same":2', 1, true) ~= nil, "facts: same-species count")
check(string.find(habJson("502"), '"ok":false', 1, true) ~= nil, "facts: habitat 502 refused")
fire("PZ2QoL_SendFacts", "ss2", "999")
check(string.find(lastSent("PZ2QoL_SendFactsResult").tArgs[2], '"gone":true', 1, true) ~= nil, "facts: unknown animal is gone")
Kin.nLastTick = nil
fire("PZ2QoL_SendFacts", "ss3", "101")
check(string.find(lastSent("PZ2QoL_SendFactsResult").tArgs[2], '"error":"nopark"', 1, true) ~= nil, "facts: no park")
Kin.nLastTick = nClock

-----------------------------------------------------------------------
-- 3. One move (Kin's Move: the game's own sequence)
-----------------------------------------------------------------------
fire("PZ2QoL_SendMove", "ss4", "101", "500")
local tMove = lastSent("PZ2QoL_SendMoveResult")
check(tMove ~= nil and tMove.tArgs[1] == "ss4" and tMove.tArgs[2] == true, "move ok")
check(count("Transport") == 1, "exactly one transport request")
fire("PZ2QoL_SendMove", "ss5", "102", "500") -- tigers are not allowed in 500
tMove = lastSent("PZ2QoL_SendMoveResult")
check(tMove.tArgs[2] == false and tMove.tArgs[3] ~= "", "refused move answered with a reason")
check(count("Transport") == 1, "no transport for a refused move")
fire("PZ2QoL_SendMove", "ss6", "101", "trade:auto")
check(lastSent("PZ2QoL_SendMoveResult").tArgs[2] == false, "only habitats")

print(string.format("%d passed, %d failed", nPassed, nFailed))
if nFailed > 0 then os.exit(1) end
