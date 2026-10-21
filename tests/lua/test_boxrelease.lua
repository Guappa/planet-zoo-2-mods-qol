-- Behaviour test for PZ2QoL.BoxRelease (let out stuck aquarium animals)
-- and its clock PZ2QoL.GameClock against a mock park whose calendar runs
-- at the game's speed. Run:
--   lua53 tests/lua/test_boxrelease.lua <path-to-mods/PZ2QoL/Main/>
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
local fnRequire = require
require = function(sName)
	local sKey = string.lower(sName)
	if package.loaded[sKey] ~= nil then return package.loaded[sKey] end
	assert(loadfile(sModDir .. sKey .. ".lua"))(sName)
	return package.loaded[sKey]
end

-- real time (performance timer) and the park's game time, both in seconds
local nClock = 1000
local nGameTrue = 2026 * 12 * 100 + 50   -- year 2026, a month is 100 s at 1x
local nMonthSec = 100
local nTicksPerMonth = nil            -- a quantised calendar (nil: smooth)
local bCalendar = true
local function calMonths()
	local m = nGameTrue / nMonthSec
	if nTicksPerMonth then
		m = math.floor(m * nTicksPerMonth) / nTicksPerMonth
	end
	return m
end
local park = {
	GetMonthDurationInSeconds = function() return nMonthSec end,
	GetTimeOfMonth = function()
		if not bCalendar then error("no calendar") end
		local m = calMonths()
		local nY = math.floor(m / 12)
		local nM = math.floor(m - nY * 12)
		return {
			Valid = function() return true end,
			Year = function() return nY end,
			Month = function() return nM end,
			Prop = function() return m - nY * 12 - nM end,
		}
	end,
}

-- 11, 12: turtles in aquarium 1; 21: zebra boxed in land habitat 2;
-- 22: a deep swimmer (otter-like) in water habitat 2; 13: a second turtle
local tA = {
	[11] = { h = 1, boxed = true, unboxable = true, deep = true },
	[12] = { h = 1, boxed = true, unboxable = true, deep = true, claimed = true },
	[21] = { h = 2, boxed = true, unboxable = true, deep = false },
	[22] = { h = 2, boxed = false, unboxable = true, deep = true },
}
local tCalls = {}
local tCallReal = {}
local bAnyThrows = false
local animals = {}
local function flag(k) return function(_, e) if bAnyThrows then error("boom") end return tA[e][k] == true end end
animals.IsAnimalBoxed = flag("boxed")
animals.IsAnimalUnboxableByPlayer = flag("unboxable")
animals.DoesAnimalDeepSwim = flag("deep")
animals.IsBoxingClaimed = flag("claimed")
animals.IsAnimalRequestingBoxed = flag("reqBox")
animals.IsAnimalRequestingUnboxed = flag("reqUnbox")
animals.IsBoxWaitingForNavMeshRebuild = flag("navWait")
animals.IsEscaped = flag("escaped")
animals.GetAnimalTransportData = function(_, e) return { bHasTransportJob = tA[e].job == true } end
animals.GetSpecies = function(_, e) return e < 20 and "Turtle_Hawksbill" or "Zebra" end
animals.ClaimBoxing = function(_, e) tCalls[#tCalls + 1] = "claim" .. e; if tA[e].refuseClaim then return false end tA[e].claimed = true return true end
animals.UnboxAnimal = function(_, e) tCalls[#tCalls + 1] = "unbox" .. e; tCallReal[#tCallReal + 1] = nClock; tA[e].boxed = false; tA[e].claimed = false end
animals.ReleaseBoxing = function(_, e) tCalls[#tCalls + 1] = "releaseclaim" .. e end
local habitat = {
	GetHabitats = function() return { 1, 2 } end,
	IsAquarium = function(_, h) return h == 1 end,
	GetAnimalsInHabitat = function(_, h)
		local t = {}
		for e, a in pairs(tA) do if a.h == h then t[#t + 1] = e end end
		table.sort(t)
		return t
	end,
}
local tWorld = { animals = animals, habitat = habitat, park = park }
api = {
	time = { GetPerformanceTimer = function() return nClock end, PerformanceTimeToMilliseconds = function(n) return n * 1000 end },
	world = { GetWorldAPIs = function() return tWorld end },
}

local tLog, tMarks, tEvents = {}, {}, {}
local Core = {
	tPatches = {},
	Log = function(self, a, e, d) tLog[#tLog + 1] = { event = e, data = d or {} } end,
	Mark = function(self, s) tMarks[#tMarks + 1] = s end,
	AddModulePatch = function(self, s, fn) self.tPatches[s] = fn end,
}
local oUI = {
	view = true,
	tListeners = {},
	AddEventListener = function(self, s, n, fn) self.tListeners[s] = fn end,
	TriggerEventAtNextAdvance = function(self, s, ...) tEvents[#tEvents + 1] = { name = s, args = { ... } } end,
}

-----------------------------------------------------------------------
-- 0. GameClock on its own
local GameClock = require("PZ2QoL.GameClock")
do
	local c = GameClock.New()
	local function step(nReal, nSpeed, bFrame)
		for _ = 1, nReal * 4 do
			nClock = nClock + 0.25
			nGameTrue = nGameTrue + 0.25 * nSpeed
			c:Advance(bFrame ~= false and 0.25 * nSpeed or nil)
		end
	end
	step(10, 1)
	check(math.abs(c:Now() - 10) < 0.6 and c.sSource == "calendar", "clock: 10 s at 1x from the calendar (" .. c:Now() .. ")")
	local n0 = c:Now()
	step(10, 5)
	check(math.abs(c:Now() - n0 - 50) < 1.5, "clock: 10 real s at 5x = 50 game s (" .. (c:Now() - n0) .. ")")
	n0 = c:Now()
	step(30, 0)
	check(c:Now() == n0, "clock: stands still while paused")
	-- a load / another park: the calendar goes back, then far ahead
	nGameTrue = nGameTrue - 5000
	step(1, 1)
	nGameTrue = nGameTrue + 100000
	n0 = c:Now()
	step(1, 1)
	check(c:Now() - n0 < 2, "clock: calendar jumps are not time (" .. (c:Now() - n0) .. ")")
	-- quantised calendar (5 game s per tick): still counts at 1x and 5x
	nTicksPerMonth = 20
	step(1, 1)
	n0 = c:Now()
	step(20, 1)
	check(math.abs(c:Now() - n0 - 20) <= 5.5, "clock: quantised calendar at 1x (" .. (c:Now() - n0) .. ")")
	n0 = c:Now()
	step(20, 5)
	check(math.abs(c:Now() - n0 - 100) <= 5.5, "clock: quantised calendar at 5x (" .. (c:Now() - n0) .. ")")
	nTicksPerMonth = nil
	-- no calendar: the frames' scaled delta
	bCalendar = false
	n0 = c:Now()
	step(10, 5)
	check(math.abs(c:Now() - n0 - 50) < 1.5 and c.sSource == "frame", "clock: no calendar, frame time at 5x (" .. (c:Now() - n0) .. ")")
	n0 = c:Now()
	step(10, 0)
	check(c:Now() == n0, "clock: no calendar, paused frames stand still")
	-- calendar back: counts again from its next change
	bCalendar = true
	step(1, 1)
	n0 = c:Now()
	step(10, 1)
	check(math.abs(c:Now() - n0 - 10) < 0.6 and c.sSource == "calendar", "clock: calendar again")
	-- calendar frozen while frames run: frame time after nStaleSeconds
	local nFrozen = nGameTrue
	n0 = c:Now()
	for _ = 1, 120 * 4 do
		nClock = nClock + 0.25
		c:Advance(0.25)
	end
	check(c.sSource == "frame" and c:Now() - n0 > 50, "clock: frozen calendar, frames take over (" .. (c:Now() - n0) .. ")")
	nGameTrue = nFrozen + 120
	n0 = c:Now()
	step(1, 1)
	check(c:Now() - n0 < 2, "clock: the calendar's catch-up step is not counted twice")
	-- neither calendar nor frames: real time
	local c2 = GameClock.New()
	bCalendar = false
	for _ = 1, 40 do
		nClock = nClock + 0.25
		c2:Advance(nil)
	end
	check(math.abs(c2:Now() - 9.75) < 0.6 and c2.sSource == "real", "clock: real time as the last resort (" .. c2:Now() .. ")")
	bCalendar = true
end

-----------------------------------------------------------------------
local BoxRelease = assert(loadfile(sModDir .. "pz2qol.boxrelease.lua"))("PZ2QoL.BoxRelease")
BoxRelease = package.loaded["pz2qol.boxrelease"]
BoxRelease:Init(Core)
BoxRelease:Attach(oUI)
check(BoxRelease.oClock ~= nil, "BoxRelease has a game clock")
local Select = { Advance = function() return "orig" end }
Core.tPatches["Editors.Select.SelectMode"](Select)
check(Select.Advance({}, 0, 0) == "orig", "SelectMode.Advance still the game's")

-- nSeconds of real time at nSpeed (0 = paused), a frame every 0.25 s
local nSpeedNow = 1
local function run(nSeconds, nSpeed)
	nSpeed = nSpeed or nSpeedNow
	for _ = 1, nSeconds * 4 do
		nClock = nClock + 0.25
		nGameTrue = nGameTrue + 0.25 * nSpeed
		Select.Advance({}, 0.25 * nSpeed, 0.25)
	end
end

-- 1. Nothing before the wait; then the unclaimed turtle, as Claim + Unbox
run(15)
check(#tCalls == 0, "nothing released before 20 s")
run(10)
check(tCalls[1] == "claim11" and tCalls[2] == "unbox11", "turtle 11 claimed then unboxed: " .. table.concat(tCalls, ","))
check(not tA[11].boxed, "turtle 11 out")
check(#tEvents == 0, "a release sends nothing to the page")
-- claimed turtle (staff busy), boxed zebra (not aquatic) never touched
run(60)
local sCalls = table.concat(tCalls, ",")
check(not sCalls:find("12") and not sCalls:find("21"), "claimed and land animals untouched: " .. sCalls)
local bClockLogged = false
for _, l in ipairs(tLog) do if l.event == "clock" and l.data.source == "calendar" then bClockLogged = true end end
check(bClockLogged, "the trace logs the clock's source")

-- 2. Deep swimmer outside an aquarium counts too
tA[22].boxed = true
run(30)
check(table.concat(tCalls, ","):find("unbox22", 1, true) ~= nil, "deep swimmer in a water habitat let out")

-- 3. Game still busy: requested unboxed / navmesh / transport job -> wait
tCalls = {}
tA[11].boxed = true; tA[11].reqUnbox = true
run(40)
check(#tCalls == 0, "the game's own unbox pending: left alone")
tA[11].reqUnbox = false; tA[11].navWait = true
run(40)
check(#tCalls == 0, "waiting for the navmesh: left alone")
tA[11].navWait = false; tA[11].job = true
run(40)
check(#tCalls == 0, "transport job: left alone")
tA[11].job = false
run(25)
check(tCalls[2] == "unbox11", "released once the game is done with it")

-- 4. Boxed again quickly after each release: gives up after 3, rests, alerts
tCalls, tEvents = {}, {}
for i = 1, 3 do
	run(5)
	tA[11].boxed = true
	run(25)
end
local nGave = 0
for _, ev in ipairs(tEvents) do if ev.args[1] == "gaveup" then nGave = nGave + 1 end end
check(nGave == 1, "one gave-up alert after 3 quick re-boxings")
local nUnboxBefore = #tCalls
run(120)
check(#tCalls == nUnboxBefore and tA[11].boxed, "resting: not released for a while")
-- the rest is game time too: 600 game s pass in 120 real s at 5x
run(120, 5)
check(not tA[11].boxed, "released again after the rest (game time)")

-- 5. Claim refused: no unbox
tCalls = {}
run(500)
tA[11].boxed = true; tA[11].refuseClaim = true
run(25)
check(#tCalls >= 1 and tCalls[1] == "claim11" and not table.concat(tCalls, ","):find("unbox11", 1, true), "refused claim: no unbox")
tA[11].refuseClaim = false

-- 6. Off: nothing; on again: works
tCalls = {}
oUI.tListeners["PZ2QoL_ReleaseSet"](nil, false)
run(60)
check(#tCalls == 0, "off: nothing")
oUI.tListeners["PZ2QoL_ReleaseSet"](nil, true)
run(25)
check(table.concat(tCalls, ","):find("unbox11", 1, true) ~= nil, "on again: released")

-- 7. Native reads throwing: no release, no error out of Advance
tCalls = {}
tA[12].claimed = false
bAnyThrows = true
check(pcall(run, 40) and #tCalls == 0, "throwing reads: nothing done, Advance safe")
bAnyThrows = false
run(25)
tA[12].claimed = true

-- 8. Game speed: at 5x a stuck turtle is out within ~5 real seconds
-- (8-11 re-box turtle 11 often: forget its quick re-boxings each time)
tCalls = {}
BoxRelease.tHistory = {}
tA[11].boxed = true
run(3, 1)
check(#tCalls == 0, "1x: still waiting after 3 s")
run(5, 5)
check(table.concat(tCalls, ","):find("unbox11", 1, true) ~= nil, "5x: released ~8 real s after boxing (" .. table.concat(tCalls, ",") .. ")")

-- 9. Paused: the wait stands still and nothing is released
tCalls = {}
BoxRelease.tHistory = {}
tA[11].boxed = true
run(10, 1)
run(300, 0)
check(#tCalls == 0, "paused: nothing released however long")
run(15, 1)
check(table.concat(tCalls, ","):find("unbox11", 1, true) ~= nil, "unpaused: released once 20 game s passed")

-- 10. Two stuck turtles at 5x: one at a time, at least nMinGapReal apart
tCalls, tCallReal = {}, {}
BoxRelease.tHistory = {}
tA[13] = { h = 1, boxed = true, unboxable = true, deep = true }
tA[11].boxed = true
run(8, 5)
check(tA[11].boxed == false and tA[13].boxed == false, "5x: both turtles out")
check(#tCallReal == 2 and tCallReal[2] - tCallReal[1] >= BoxRelease.nMinGapReal, "5x: releases at least the real gap apart")

-- 11. No calendar: the frames' scaled delta keeps it game time
bCalendar = false
tCalls = {}
BoxRelease.tHistory = {}
tA[11].boxed = true
run(10, 0)
check(#tCalls == 0, "no calendar, paused: nothing")
run(6, 5)
check(table.concat(tCalls, ","):find("unbox11", 1, true) ~= nil, "no calendar, 5x: released by frame time")
bCalendar = true

-- 12. A different animals API table is not a new park (the game may hand
-- out a fresh table per call): the wait goes on; the HUD's Set starts over
tA[12].claimed = false; tA[12].boxed = true
BoxRelease.tHistory = {}
BoxRelease.tStuck = {}
tCalls = {}
run(8)
tWorld = { animals = setmetatable({}, { __index = animals }), habitat = habitat, park = park }
run(15)
check(table.concat(tCalls, ","):find("unbox12", 1, true) ~= nil, "new API table: wait kept, released on time")
tA[12].boxed = true
run(10)
oUI.tListeners["PZ2QoL_ReleaseSet"](nil, true)
check(next(BoxRelease.tStuck) == nil, "Set (every park's HUD): wait starts again")

-- 13. Loading another save (calendar far ahead): not counted as waiting
tCalls = {}
tA[12].boxed = true
BoxRelease.tStuck = {}
BoxRelease.tHistory = {}
run(3)
nGameTrue = nGameTrue + 50000
run(3)
check(#tCalls == 0, "calendar jump: not counted as time stuck")
run(25)

-- 14. A fresh world-API table on every call: still released
local tRealWorld = tWorld
api.world.GetWorldAPIs = function()
	return { animals = setmetatable({}, { __index = animals }), habitat = habitat, park = park }
end
tCalls = {}
BoxRelease.tHistory = {}
tA[11].boxed = true
run(25)
check(table.concat(tCalls, ","):find("unbox11", 1, true) ~= nil, "fresh API table per call: released")
api.world.GetWorldAPIs = function() return tWorld end

-- 15. The park world's tick alone (Select not the current mode): released
check(type(Core.tPatches["Worlds.DarwinWorld"]) == "function", "DarwinWorld patch registered")
local World = { OnAdvanceWhileRunning = function() return "world" end }
Core.tPatches["Worlds.DarwinWorld"](World)
check(World.OnAdvanceWhileRunning({}, 0.25) == "world", "DarwinWorld.OnAdvanceWhileRunning still the game's")
local function runWorld(nSeconds, nSpeed)
	for _ = 1, nSeconds * 4 do
		nClock = nClock + 0.25
		nGameTrue = nGameTrue + 0.25 * nSpeed
		World.OnAdvanceWhileRunning({}, 0.25)
	end
end
oUI.tListeners["PZ2QoL_ReleaseSet"](nil, true)
tLog, tCalls = {}, {}
tA[11].boxed = true
runWorld(3, 5)
check(#tCalls == 0, "world tick: waits")
runWorld(4, 5)
check(table.concat(tCalls, ","):find("unbox11", 1, true) ~= nil, "world tick alone at 5x: released by game time")
local bTickLog, bScanLog = false, false
for _, l in ipairs(tLog) do
	if l.event == "tick" and l.data.src == "world" then bTickLog = true end
	if l.event == "scan" and l.data.habs == 2 and l.data.aquariums == 1 then bScanLog = true end
end
check(bTickLog, "trace: first world tick after Set")
check(bScanLog, "trace: a scan summary after Set")
runWorld(10, 0)
tCalls = {}
tA[11].boxed = true
runWorld(5, 0)
check(#tCalls == 0, "world tick, paused: nothing")
runWorld(25, 1)
check(table.concat(tCalls, ","):find("unbox11", 1, true) ~= nil, "world tick at 1x: released")

-- 15b. Between the park's OnDeactivate and its unload: the world tick stops
check(type(World.OnDeactivate) ~= "function", "mock world had no OnActivate/OnDeactivate")
local World2 = { OnAdvanceWhileRunning = function() end, OnActivate = function() return "act" end, OnDeactivate = function() return "deact" end }
Core.tPatches["Worlds.DarwinWorld"](World2)
check(World2.OnDeactivate({}) == "deact" and BoxRelease.bWorldActive == false, "OnDeactivate seen")
tCalls = {}
tA[11].boxed = true
for _ = 1, 40 * 4 do nClock = nClock + 0.25; nGameTrue = nGameTrue + 0.25; World2.OnAdvanceWhileRunning({}) end
check(#tCalls == 0, "deactivated park world: nothing")
check(World2.OnActivate({}) == "act" and BoxRelease.bWorldActive == true, "OnActivate seen")
for _ = 1, 25 * 4 do nClock = nClock + 0.25; nGameTrue = nGameTrue + 0.25; World2.OnAdvanceWhileRunning({}) end
check(table.concat(tCalls, ","):find("unbox11", 1, true) ~= nil, "active again: released")

-- 16. The hub's start screen up: no park call at all
package.loaded["pz2qol.kin"] = { bStartScreen = true }
BoxRelease.tHistory = {}
local nReads = 0
local fnBoxed = animals.IsAnimalBoxed
animals.IsAnimalBoxed = function(...) nReads = nReads + 1 return fnBoxed(...) end
tCalls = {}
tA[11].boxed = true
runWorld(40, 1)
run(40)
check(#tCalls == 0 and nReads == 0, "start screen up: nothing read, nothing released")
package.loaded["pz2qol.kin"].bStartScreen = false
runWorld(25, 1)
check(table.concat(tCalls, ","):find("unbox11", 1, true) ~= nil, "start screen gone: released")
animals.IsAnimalBoxed = fnBoxed

print(string.format("boxrelease: %d passed, %d failed", nPassed, nFailed))
if nFailed > 0 then
	os.exit(1)
end
