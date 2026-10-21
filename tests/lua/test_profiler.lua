-- Behaviour test for the script profiler: PZ2QoL.ProfCore (the numbers)
-- and PZ2QoL.Profiler (hooks) against a mock game with environments,
-- cached phase lists, managers, a component and a PZ2QoL module. Run:
--   lua53 tests/lua/test_profiler.lua <path-to-mods/PZ2QoL/Main/>
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
local function near(a, b, eps)
	return type(a) == "number" and math.abs(a - b) <= (eps or 1e-6)
end

function module(sName, tBase)
	local t = tBase or {}
	t._NAME = sName
	package.loaded[string.lower(sName)] = t
	return t
end
local fnRequire = require
require = function(sName)
	local sKey = string.lower(sName)
	if package.loaded[sKey] ~= nil then return package.loaded[sKey] end
	local sPath = sModDir .. sKey .. ".lua"
	assert(loadfile(sPath))(sName)
	return package.loaded[sKey]
end

-----------------------------------------------------------------------
-- 1. ProfCore: per-frame maths and the rolling window
-----------------------------------------------------------------------
local P = require("PZ2QoL.ProfCore")
local st = P.NewState(2, 3) -- 2 buckets x 3 frames = a 6-frame window
local sA = P.NewStat(st, "A", "manager")
local sB = P.NewStat(st, "B", "mod")
-- frames 0..5: A 2 calls of 1 ms (self 0.5) each; B 1 call of 3 ms in even frames
for f = 0, 5 do
	P.Add(st, sA, 1, 0.5)
	P.Add(st, sA, 1, 0.5)
	if f % 2 == 0 then P.Add(st, sB, 3, 3) end
	P.EndFrame(st, 16, 2 + (f % 2 == 0 and 3 or 0))
end
local r = P.Report(st, 10)
check(r.frames == 6, "6 frames in the window: " .. tostring(r.frames))
check(near(r.wallAvg, 16) and near(r.wallMax, 16), "wall avg/max 16")
check(near(r.luaAvg, 3.5) and near(r.luaMax, 5), "lua avg 3.5, max 5: " .. tostring(r.luaAvg))
local tBy = {}
for _, row in ipairs(r.rows) do tBy[row.n] = row end
check(tBy.A and near(tBy.A.c, 2) and near(tBy.A.t, 2) and near(tBy.A.s, 1), "A: 2 calls, 2 ms, 1 ms self per frame")
check(tBy.A and near(tBy.A.a, 1) and near(tBy.A.m, 1) and near(tBy.A.x, 2), "A: 1 ms a call, max 1, worst frame 2")
check(tBy.B and near(tBy.B.c, 0.5) and near(tBy.B.t, 1.5) and near(tBy.B.x, 3) and tBy.B.k == 3, "B: half a call, 1.5 ms per frame, worst 3")
check(r.rows[1].n == "B" or near(r.rows[1].s, 1.5), "rows sorted by self time")
check(near(r.groups.manager, 1) and near(r.groups.mod, 1.5), "self per group")
check(#r.strip.wall == 6 and r.strip.lua[1] == 5 and r.strip.lua[2] == 2, "strip oldest first")
-- frames 6..8 replace bucket 0 (frames 0..2); A stops being called
for _ = 6, 8 do
	P.Add(st, sB, 1, 1)
	P.EndFrame(st, 10, 1)
end
r = P.Report(st, 10)
tBy = {}
for _, row in ipairs(r.rows) do tBy[row.n] = row end
check(r.frames == 6 and near(r.wallAvg, 13), "window rolled: 6 frames, avg (3x16+3x10)/6 = 13: " .. tostring(r.wallAvg))
check(tBy.A and near(tBy.A.t, 1) and near(tBy.A.c, 1), "A: only frames 3..5 left (6 ms over 6 frames)")
check(tBy.B and near(tBy.B.t, (3 + 3) / 6), "B: frame 4 (3 ms) + frames 6..8 (3 ms)")
for _ = 9, 14 do
	P.EndFrame(st, 10, 0)
end
r = P.Report(st, 10)
check(#r.rows == 0 and #st.tActive == 0, "stats with nothing in the window leave the active list")
check(P.Add(st, sA, 1, 1) == 1 and #st.tActive == 1, "a stat comes back on its next call")
-- spikes and call leaders are sent even when the total is small
local st2 = P.NewState(1, 10)
for i = 1, 200 do
	local s = P.NewStat(st2, "s" .. i, "other")
	P.Add(st2, s, i == 7 and 0 or 1, 0.5)
end
local sSpike = P.NewStat(st2, "spike", "other")
P.Add(st2, sSpike, 0.001, 0.001)
st2.tActive[#st2.tActive].fm = 0.001
P.EndFrame(st2, 20, 5)
r = P.Report(st2, 20)
check(#r.rows >= 20 and #r.rows <= 20 + 25 + 25 + 15, "top rows capped: " .. #r.rows)
check(r.active == 201, "active count")
-- negative self time is clamped
local st3 = P.NewState(1, 5)
local sN = P.NewStat(st3, "neg", "other")
P.Add(st3, sN, 1, -0.2)
P.EndFrame(st3, 5, 1)
check(near(P.Report(st3).rows[1].s, 0), "negative self clamped to 0")
-- JSON
local sJson = P.Json({ a = 1, b = "x\"y", c = { 1, 2.5, true }, d = {}, e = 0.125, f = "\200" })
check(sJson == '{"a":1,"b":"x\\u0022y","c":[1,2.5,true],"d":[],"e":0.125,"f":"\\u00c8"}', "json: " .. sJson)

-----------------------------------------------------------------------
-- 2. Profiler against a mock game
-----------------------------------------------------------------------
local nClock = 0 -- microseconds
api = {
	time = {
		GetPerformanceTimer = function() return nClock end,
		DiffPerformanceTimers = function(a, b) return a - b end,
		PerformanceTimeToMilliseconds = function(n) return n / 1000 end,
	},
}

-- the game's Environment: OnPhase runs a cached list of manager methods
-- (like Environment._ConstructPhaseFunctionList, which captures the method)
local Env = module("Environment.Environment")
Env.OnPhase = function(self, sPhase, bCache, ...)
	local t = self.tPhaseFunctionCache[sPhase]
	if t == nil then
		t = {}
		for _, m in ipairs(self.tManagers) do
			local fn = m[sPhase]
			if fn ~= nil then
				t[#t + 1] = function(...) fn(m, ...) end
			end
		end
		if bCache then self.tPhaseFunctionCache[sPhase] = t end
	end
	for _, fn in ipairs(t) do fn(...) end
end
local function newEnv(sProto, tParent, tManagers)
	return setmetatable({ sPrototypeModule = sProto, tParent = tParent, tManagers = tManagers, tPhaseFunctionCache = {} }, { __index = Env })
end

local Mod = module("PZ2QoL.TestMod")
Mod.Work = function(self) nClock = nClock + 500 end
Mod.Tiny = function(self) end
Mod.Boom = function(self) error("boom") end
local GameMgr = module("Managers.GameThing")
GameMgr.Advance = function(self) nClock = nClock + 1000 end
local Mgr = module("Managers.FakeManager")
Mgr.Advance = function(self) nClock = nClock + 1500; Mod:Work() end
Mgr.Helper = function(self) return "not per-frame" end
local Comp = module("Components.Thing")
Comp.Advance = function(self) nClock = nClock + 300 end
Comp.Other = function(self) return 1 end

local oGameMgr = setmetatable({}, { __index = GameMgr })
local oMgr = setmetatable({}, { __index = Mgr })
local oComp = setmetatable({}, { __index = Comp })
local gameEnv = newEnv("Game.GameEnvironment", nil, { oGameMgr })
local worldEnv = newEnv("Environments.DarwinEnvironment", gameEnv, { oMgr })
api.game = { GetEnvironment = function() return gameEnv end }
api.world = { GetWorldAPIs = function() return { environment = worldEnv } end }

local bTinyStorm = false
local function frame()
	gameEnv:OnPhase("Advance", true, 0.016)
	worldEnv:OnPhase("Advance", true, 0.016)
	oComp:Advance()
	if bTinyStorm then
		for _ = 1, 60 do Mod:Tiny() end
	end
	nClock = nClock + 10000 -- native work
end
-- the game has run a while: the phase lists are cached with the originals
frame()
check(type(worldEnv.tPhaseFunctionCache.Advance) == "table", "phase list cached before the profiler")

local tLog, tMarks, tEvents = {}, {}, {}
local Core = {
	Log = function(self, a, e, d) tLog[#tLog + 1] = { area = a, event = e, data = d or {} } end,
	Checkpoint = function(self, s) tMarks[#tMarks + 1] = s end,
}
local oUI = {
	view = true,
	tListeners = {},
	AddEventListener = function(self, s, n, fn, arg) self.tListeners[s] = function(...) return fn(arg, ...) end end,
	TriggerEventAtNextAdvance = function(self, s, ...) tEvents[#tEvents + 1] = { name = s, args = { ... } } end,
}
local function lastData()
	for i = #tEvents, 1, -1 do
		if tEvents[i].name == "PZ2QoL_ProfData" then return tEvents[i].args[1] end
	end
end
local function logged(sEvent)
	local t = {}
	for _, e in ipairs(tLog) do if e.event == sEvent then t[#t + 1] = e.data end end
	return t
end

local Prof = require("PZ2QoL.Profiler")
Prof:Init(Core)
check(Core.Profiler == Prof, "registered on Core")
check(#logged("caps") == 1 and logged("caps")[1].debug == true, "caps logged once at boot")
Prof:Attach(oUI)
local fnMgrAdvance, fnOnPhase, fnWork = Mgr.Advance, Env.OnPhase, Mod.Work

-- off: nothing is replaced
check(rawget(Mgr, "Advance") == fnMgrAdvance and Env.OnPhase == fnOnPhase, "off by default: nothing hooked")
oUI.tListeners.PZ2QoL_ProfHello()
check(lastData() and lastData():find('"on":false', 1, true), "hello answers off")

oUI.tListeners.PZ2QoL_ProfStart('{"deep":false,"window":20,"sampler":false}')
check(Prof:IsOn(), "started")
check(rawget(Mgr, "Advance") ~= fnMgrAdvance and rawget(Comp, "Advance") ~= Comp.Other, "per-frame methods wrapped")
check(rawget(Mgr, "Helper") ~= nil and Mgr.Helper(oMgr) == "not per-frame", "other game functions untouched")
check(rawget(Mod, "Work") ~= fnWork, "PZ2QoL functions wrapped")
check(Env.OnPhase ~= fnOnPhase, "Environment.OnPhase wrapped")
check(worldEnv.tPhaseFunctionCache.Advance == nil, "cached phase lists emptied")
check(Prof.nWindow == 20, "window from the options")
check(tMarks[#tMarks] == "prof_start", "prof_start mark")

for _ = 1, 60 do frame() end
-- 60 frames of 13.3 ms: at least one push
local sData = lastData()
check(sData and sData:find('"on":true', 1, true), "data pushed while on")
check(sData and sData:find('"n":"Managers.FakeManager:Advance"', 1, true) ~= nil, "manager row sent (via the rebuilt phase list)")
local r2 = Prof:_State(50)
local tRows = {}
for _, row in ipairs(r2.rows) do tRows[row.n] = row end
check(near(r2.wallAvg, 13.3, 1e-3), "frame wall 13.3 ms: " .. tostring(r2.wallAvg))
check(near(r2.luaAvg, 3.3, 1e-3), "Lua 3.3 ms of it: " .. tostring(r2.luaAvg))
local rM = tRows["Managers.FakeManager:Advance"]
check(rM and near(rM.t, 2) and near(rM.s, 1.5) and near(rM.c, 1), "manager: 2 ms total, 1.5 self, 1 call/frame")
local rW = tRows["PZ2QoL.TestMod:Work"]
check(rW and rW.g == "mod" and near(rW.t, 0.5) and near(rW.s, 0.5), "PZ2QoL work: 0.5 ms, group mod")
local rE = tRows["Phase Advance: DarwinEnvironment"]
check(rE and rE.g == "world" and near(rE.t, 2) and near(rE.s, 0), "world environment phase: 2 ms, no self")
local rG = tRows["Phase Advance: GameEnvironment"]
check(rG and near(rG.t, 1), "game environment phase: 1 ms")
check(tRows["Components.Thing:Advance"] and tRows["Components.Thing:Advance"].g == "component", "component row")
check(r2.frames >= 16 and r2.frames <= 20, "rolling window of 16..20 frames: " .. tostring(r2.frames))

-- errors pass through unchanged and the nesting recovers
local bOk, sErr = pcall(Mod.Boom, Mod)
check(not bOk and tostring(sErr):find("boom", 1, true), "an error in a timed function reaches the caller")
for _ = 1, 3 do frame() end
check(Prof._Internals().nDepth == 0 and Prof.nLeaks == 1, "nesting back to 0 after an error (one leak repaired)")
r2 = Prof:_State(50)
tRows = {}
for _, row in ipairs(r2.rows) do tRows[row.n] = row end
check(near(tRows["Managers.FakeManager:Advance"].s, 1.5), "self times right after an error")

-- a function called too often is unhooked again
Prof.nHotCalls = 50
oUI.tListeners.PZ2QoL_ProfStart('{"window":20}')
local fnTinyWrapped = rawget(Mod, "Tiny")
bTinyStorm = true
frame()
frame()
check(rawget(Mod, "Tiny") ~= fnTinyWrapped, "hot function unhooked: " .. tostring(Prof.nUnhooked))
check(#logged("unhooked") >= 1, "unhook logged")
bTinyStorm = false
Prof.nHotCalls = 3000

-- a manager module loaded while on is picked up by the next scan
local Late = module("Managers.LateManager")
Late.Advance = function(self) nClock = nClock + 200 end
local fnLate = Late.Advance
table.insert(worldEnv.tManagers, setmetatable({}, { __index = Late }))
for _ = 1, 200 do frame() end
check(rawget(Late, "Advance") ~= fnLate, "late manager wrapped by the rescan")
r2 = Prof:_State(80)
tRows = {}
for _, row in ipairs(r2.rows) do tRows[row.n] = row end
check(tRows["Managers.LateManager:Advance"] and near(tRows["Managers.LateManager:Advance"].t, 0.2), "late manager timed")

-- snapshot into the log
oUI.tListeners.PZ2QoL_ProfSnapshot()
check(#logged("snapshot") == 1 and #logged("row") >= 5, "snapshot: header and rows logged")
check(logged("row")[1].i == 1 and type(logged("row")[1].self) == "number", "row fields")

-- pings keep it on; a page gone quiet for nPageTimeoutMs stops it
oUI.tListeners.PZ2QoL_ProfPing()
for _ = 1, 600 do frame() end -- ~8 s
check(Prof:IsOn(), "still on 8 s after a ping")
oUI.tListeners.PZ2QoL_ProfPing()
for _ = 1, 600 do frame() end
check(Prof:IsOn(), "pings keep it on")
for _ = 1, 1300 do frame() end -- ~17 s without a ping
check(not Prof:IsOn(), "no page for 15 s: stopped")
check(#logged("stop_no_page") == 1 and rawget(Mgr, "Advance") == fnMgrAdvance, "stopped and restored")
oUI.tListeners.PZ2QoL_ProfStart('{"window":20}')
for _ = 1, 3 do frame() end

-- reset clears the numbers
oUI.tListeners.PZ2QoL_ProfReset()
check(Prof:_State(10).frames == 0, "reset: no frames")
frame(); frame()
check(Prof:_State(10).frames == 1, "counting again after reset")

-- stop restores every original and empties the caches again
local tCacheBefore = worldEnv.tPhaseFunctionCache.Advance
oUI.tListeners.PZ2QoL_ProfStop()
check(not Prof:IsOn(), "stopped")
check(rawget(Mgr, "Advance") == fnMgrAdvance and rawget(Mod, "Work") == fnWork and rawget(Late, "Advance") == fnLate, "originals restored")
check(Env.OnPhase == fnOnPhase, "Environment.OnPhase restored")
check(worldEnv.tPhaseFunctionCache.Advance == nil and tCacheBefore ~= nil, "phase caches emptied on stop")
check(tMarks[#tMarks] == "prof_stop", "prof_stop mark")
check(lastData():find('"on":false', 1, true), "final data says off")
nClock = 0
frame()
check(nClock == 13500, "game runs as before after stop (13.3 ms + the late manager): " .. nClock)

-- deep mode wraps every function of gameplay modules, not common helpers
local Common = module("Common.TablePlus")
Common.copy = function(t) return t end
oUI.tListeners.PZ2QoL_ProfStart('{"deep":true}')
check(Prof.bDeep and Prof.nHooked > 8, "deep: more hooks: " .. Prof.nHooked)
check(rawget(Common, "copy") == Common.copy and debug.getinfo(Common.copy, "S").short_src ~= nil, "deep leaves Common.* alone")
check(Mgr.Helper(oMgr) == "not per-frame", "deep wrappers return values")
oUI.tListeners.PZ2QoL_ProfStop()

-- no timer: start fails soft, nothing hooked
local tTime = api.time
api.time = nil
check(Prof:Start({}) == false and not Prof:IsOn(), "no timer: start refused")
check(rawget(Mgr, "Advance") == fnMgrAdvance and Env.OnPhase == fnOnPhase, "no timer: nothing hooked")
check(#logged("start_failed") == 1, "start failure logged")
api.time = tTime

-- sampler (needs debug.sethook, present in the test Lua)
oUI.tListeners.PZ2QoL_ProfStart('{"sampler":true}')
check(Prof.bSamplerOn, "sampler on when debug.sethook exists")
local function busy() local n = 0 for i = 1, 20000 do n = n + i end return n end
Mgr.Advance = (function(f) return function(self) busy() return f(self) end end)(rawget(Mgr, "Advance"))
worldEnv.tPhaseFunctionCache = {}
for _ = 1, 40 do frame() end
local rS = Prof:_State(10)
check(rS.samples and rS.samples.total > 0 and #rS.samples.rows > 0, "sampler counted instructions: " .. tostring(rS.samples and rS.samples.total))
oUI.tListeners.PZ2QoL_ProfStop()
check(debug.gethook() == nil, "sampler hook removed on stop")

print(string.format("profiler: %d passed, %d failed", nPassed, nFailed))
if nFailed > 0 then os.exit(1) end
