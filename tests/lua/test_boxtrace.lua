-- Behaviour test for PZ2QoL.BoxTrace (debug-only boxing trace) against a
-- mock park: one aquarium with a lake, one land habitat. Run:
--   lua53 tests/lua/test_boxtrace.lua <path-to-mods/PZ2QoL/Main/>
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

-- clock and messaging
local nClock = 100
local tReceivers = {}
api = {
	time = {
		GetPerformanceTimer = function() return nClock end,
		PerformanceTimeToMilliseconds = function(n) return n * 1000 end,
	},
	messaging = {
		MsgType_AnimalBoxedMessage = 501,
		MsgType_AnimalUnboxedMessage = 502,
		MsgType_HabitatBoundaryUpdatedMessage = 503,
		MsgType_DatabaseErrorMessage = 9,
		RegisterGlobalReceiver = function(nType, fn) tReceivers[nType] = fn end,
	},
}

-- the park
local function V(x, y, z)
	return { GetX = function() return x end, GetY = function() return y end, GetZ = function() return z end }
end
local tAnimal = { [11] = { h = 1, boxed = false, y = 8.0, age = 0 }, [12] = { h = 1, boxed = false, y = 5.0, age = 1 }, [21] = { h = 2, boxed = false, y = 0, age = 1 } }
local animals = {
	IsAnimalBoxed = function(_, e) return tAnimal[e].boxed end,
	GetSpecies = function(_, e) return e < 20 and "Shark_SandTiger" or "Zebra" end,
	GetAnimalVisual = function(_, e) return 1000 + e end,
	GetAgeStatus = function(_, e) return tAnimal[e].age end,
	DoesAnimalSwim = function(_, e) return e < 20 end,
	DoesAnimalDeepSwim = function(_, e) return e < 20 end,
	IsAnimalRequestingBoxed = function() return false end,
	DoesAnimalWantToBeLetOutOfBox = function(_, e) return tAnimal[e].wantsOut == true end,
	IsAnimalUnboxableByPlayer = function() return true end,
	GetCurrentLocationType = function() return 1 end,
	GetAnimalTransportData = function() return { bHasTransportJob = false } end,
	IsBoxWaitingForNavMeshRebuild = function() error("native throws") end,
	EntityIDToAnimalGUID = function(_, e) return "G" .. e end,
}
local habitat = {
	GetHabitats = function() return { 1, 2 } end,
	GetAnimalsInHabitat = function(_, h)
		local t = {}
		for e, a in pairs(tAnimal) do
			if a.h == h then t[#t + 1] = e end
		end
		table.sort(t)
		return t
	end,
	IsAquarium = function(_, h) return h == 1 end,
	GetAquariumLake = function(_, h) return h == 1 and 77 or nil end,
	GetLakesInHabitat = function() return {} end,
	IsHabitatBoundaryComplete = function() return true end,
	IsAquariumGateBelowWaterLevel = function() return true end,
}
local tAPIs = {
	animals = animals,
	habitat = habitat,
	habitatboundary = { IsBoundaryBroken = function() return false end },
	gameterrain = {
		GetLakeSurfaceLevel = function() return 10.0 end,
		GetLakeAABB = function() return V(0, 0, 0), V(20, 10, 30) end,
	},
	transform = {
		GetTransform = function(_, nVisual)
			local a = tAnimal[nVisual - 1000]
			return { GetPos = function() return V(4, a.y, 15) end }
		end,
	},
	navigationworld = { LoadedOldMesh = function() return false end },
}

-- Core stand-in: captures Log lines
local tLog = {}
local Core = {
	bTrace = true,
	tPatches = {},
	Log = function(self, sArea, sEvent, tData) tLog[#tLog + 1] = { area = sArea, event = sEvent, data = tData or {} } end,
	Checkpoint = function() end,
	AddModulePatch = function(self, sName, fn) self.tPatches[sName] = fn end,
}

local function events(sEvent)
	local t = {}
	for _, l in ipairs(tLog) do
		if l.event == sEvent then t[#t + 1] = l end
	end
	return t
end

local BoxTrace = assert(loadfile(sModDir .. "pz2qol.boxtrace.lua"))("PZ2QoL.BoxTrace")
BoxTrace = package.loaded["pz2qol.boxtrace"]
check(BoxTrace.bSamplePositions == false, "position trails off by default")
BoxTrace.bSamplePositions = true

-- 1. A release build does nothing
local CoreOff = { bTrace = false, AddModulePatch = function() error("must not patch") end, Log = function() error("must not log") end }
check(pcall(BoxTrace.Init, BoxTrace, CoreOff), "release build: Init is a no-op")
check(next(tReceivers) == nil, "release build: no receivers")

-- 2. Debug build: receivers and the park tick
BoxTrace:Init(Core)
check(#tLog == 0, "Init only patches: no log at boot")
local HeatMap = { Advance = function() return "orig" end }
Core.tPatches["Managers.HeatMapManager"](HeatMap)
local oManager = { tWorldAPIs = tAPIs }
check(HeatMap.Advance(oManager) == "orig", "Advance still calls the game's")
check(next(tReceivers) == nil, "never registers a message receiver")
check(#events("on") == 1, "'on' line")
check(#events("park") == 1 and events("park")[1].data.aquariums == 1, "park line counts the aquarium")
check(#events("hab") == 1 and events("hab")[1].data.surface == 10, "one hab line, with the water surface")

-- 3. Three scans unboxed build a trail; then the shark near the surface is boxed
for i = 1, 3 do
	nClock = nClock + 2
	tAnimal[11].y = 8.0 + i * 0.5   -- rising: 1.5, 1.0, 0.5 m below the surface
	HeatMap.Advance(oManager)
end
check(#BoxTrace.tWatch[11].trail == 3, "trail of 3 samples for the aquarium shark")
check(BoxTrace.tWatch[21] == nil, "land animal not watched")
tAnimal[11].boxed = true
nClock = nClock + 2
HeatMap.Advance(oManager)
local tStart = events("start")
check(#tStart == 1, "one start line")
local d = tStart[1] and tStart[1].data or {}
check(d.e == 11 and d.species == "Shark_SandTiger" and d.aquarium == true and d.surface == 10, "start has animal and habitat facts")
check(d.navWait == nil and d.wantsOut == false and d.unboxable == true, "a throwing native read is just missing")
check(type(d.trail) == "string" and d.trail:find("0.5/", 1, true) ~= nil, "trail shows 0.5 m below the surface: " .. tostring(d.trail))

-- 4. No change: no line; wantsOut flips: change line; long wait: still line
nClock = nClock + 2
HeatMap.Advance(oManager)
check(#events("change") == 0, "no change, no line")
tAnimal[11].wantsOut = true
nClock = nClock + 2
HeatMap.Advance(oManager)
check(#events("change") == 1 and events("change")[1].data.wantsOut == true, "change line when it wants out")
nClock = nClock + 130
HeatMap.Advance(oManager)   -- > 30 s gap counts as a new park visit
check(#events("park") == 2, "a long gap restarts (hub trip)")
nClock = nClock + 2
HeatMap.Advance(oManager)
check(#events("start") == 2, "still boxed after the restart: logged as start again")
for i = 1, 62 do
	nClock = nClock + 2
	HeatMap.Advance(oManager)
end
check(#events("still") >= 1, "still line after 2 minutes")

-- 5. Age change of a watched animal
tAnimal[12].age = 2
nClock = nClock + 2
HeatMap.Advance(oManager)
check(#events("age") == 1 and events("age")[1].data.from == 1 and events("age")[1].data.to == 2, "age change logged")

-- 6. Unboxed: end line with how long
tAnimal[11].boxed = false
nClock = nClock + 2
HeatMap.Advance(oManager)
local tEnd = events("end")
check(#tEnd == 1 and type(tEnd[1].data.boxedFor) == "number" and tEnd[1].data.boxedFor > 100, "end line with boxedFor")
check(BoxTrace.tBoxed[11] == nil and #BoxTrace.tWatch[11].trail == 0, "state cleared, trail restarts")

-- 8. A park without world APIs is ignored
check(HeatMap.Advance({ tWorldAPIs = {} }) == "orig", "no park APIs: still the game's Advance")

print(string.format("boxtrace: %d passed, %d failed", nPassed, nFailed))
if nFailed > 0 then
	os.exit(1)
end
