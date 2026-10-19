-- Behaviour test for PZ2QoL.BoxRelease (let out stuck aquarium animals)
-- against a mock park. Run:
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

local nClock = 1000
-- 11, 12: turtles in aquarium 1; 21: zebra boxed in land habitat 2;
-- 22: a deep swimmer (otter-like) in water habitat 2
local tA = {
	[11] = { h = 1, boxed = true, unboxable = true, deep = true },
	[12] = { h = 1, boxed = true, unboxable = true, deep = true, claimed = true },
	[21] = { h = 2, boxed = true, unboxable = true, deep = false },
	[22] = { h = 2, boxed = false, unboxable = true, deep = true },
}
local tCalls = {}
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
animals.UnboxAnimal = function(_, e) tCalls[#tCalls + 1] = "unbox" .. e; tA[e].boxed = false; tA[e].claimed = false end
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
local tWorld = { animals = animals, habitat = habitat }
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

local BoxRelease = assert(loadfile(sModDir .. "pz2qol.boxrelease.lua"))("PZ2QoL.BoxRelease")
BoxRelease = package.loaded["pz2qol.boxrelease"]
BoxRelease:Init(Core)
BoxRelease:Attach(oUI)
local Select = { Advance = function() return "orig" end }
Core.tPatches["Editors.Select.SelectMode"](Select)
check(Select.Advance({}) == "orig", "SelectMode.Advance still the game's")

local function run(nSeconds)
	for _ = 1, nSeconds do
		nClock = nClock + 1
		Select.Advance({})
	end
end

-- 1. Nothing before the wait; then the unclaimed turtle, as Claim + Unbox
run(20)
check(#tCalls == 0, "nothing released before 30 s")
run(15)
check(tCalls[1] == "claim11" and tCalls[2] == "unbox11", "turtle 11 claimed then unboxed: " .. table.concat(tCalls, ","))
check(not tA[11].boxed, "turtle 11 out")
check(#tEvents == 0, "a release sends nothing to the page")
-- claimed turtle (staff busy), boxed zebra (not aquatic) never touched
run(60)
local sCalls = table.concat(tCalls, ",")
check(not sCalls:find("12") and not sCalls:find("21"), "claimed and land animals untouched: " .. sCalls)

-- 2. Deep swimmer outside an aquarium counts too
tA[22].boxed = true
run(40)
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
run(35)
check(tCalls[2] == "unbox11", "released once the game is done with it")

-- 4. Boxed again quickly after each release: gives up after 3, rests, alerts
tCalls, tEvents = {}, {}
for i = 1, 3 do
	nClock = nClock + 5
	tA[11].boxed = true
	run(35)
end
local nGave = 0
for _, ev in ipairs(tEvents) do if ev.args[1] == "gaveup" then nGave = nGave + 1 end end
check(nGave == 1, "one gave-up alert after 3 quick re-boxings")
local nUnboxBefore = #tCalls
run(120)
check(#tCalls == nUnboxBefore and tA[11].boxed, "resting: not released for a while")
run(600)
check(not tA[11].boxed, "released again after the rest")

-- 5. Claim refused: no unbox
tCalls = {}
tA[11].boxed = true; tA[11].refuseClaim = true
nClock = nClock + 500
run(35)
check(#tCalls >= 1 and tCalls[1] == "claim11" and not table.concat(tCalls, ","):find("unbox11", 1, true), "refused claim: no unbox")
tA[11].refuseClaim = false

-- 6. Off: nothing; on again: works
tCalls = {}
oUI.tListeners["PZ2QoL_ReleaseSet"](nil, false)
run(60)
check(#tCalls == 0, "off: nothing")
oUI.tListeners["PZ2QoL_ReleaseSet"](nil, true)
run(35)
check(table.concat(tCalls, ","):find("unbox11", 1, true) ~= nil, "on again: released")

-- 7. Native reads throwing: no release, no error out of Advance
tCalls = {}
tA[12].claimed = false
bAnyThrows = true
check(pcall(run, 40) and #tCalls == 0, "throwing reads: nothing done, Advance safe")
bAnyThrows = false

-- 8. A new park (other animals API) starts over
tWorld = { animals = setmetatable({}, { __index = animals }), habitat = habitat }
BoxRelease.tStuck[12] = nClock - 100
run(3)
check(BoxRelease.tStuck[12] ~= nil and nClock - BoxRelease.tStuck[12] < 5, "new park: wait starts again")

print(string.format("boxrelease: %d passed, %d failed", nPassed, nFailed))
if nFailed > 0 then
	os.exit(1)
end
