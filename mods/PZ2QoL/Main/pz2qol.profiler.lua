-----------------------------------------------------------------------
--  PZ2QoL.Profiler  (Script profiler)
--
--  Shows which game Lua scripts take time each frame, like an engine
--  profiler: per function the calls, total and self ms per frame, the
--  slowest call and the worst frame, over the last N frames, plus the
--  frame time seen from Lua (so the Lua share of a frame is visible).
--  Pure timing: nothing is sent to the game or Frontier's servers, no
--  game value is read or changed. Off by default; the player's Start
--  click turns it on, Stop (or closing the panel) restores every
--  function it replaced.
--
--  What it times (while on):
--   - every game module's per-frame entry points (Advance,
--     AdvanceWhileRunning, AdvancePreWorld, OnAdvance*, Update,
--     UpdateIsComplete): park and game managers, Lua components
--     (cameras, info popups, input, ModeHelper), modes and edit modes,
--     the world and game scripts, hub screens, objectives;
--   - Environment.OnPhase per environment and phase (all managers of a
--     phase together). The game environment's "Advance" phase marks the
--     frame (BaseGame.AdvancePreWorld runs it once a frame);
--   - every function of PZ2QoL's own modules (group "mod");
--   - "Deep": every function of the game's gameplay/UI modules, for more
--     detail (slower).
--  Managers: the environment caches each manager's phase methods
--  (Environment._ConstructPhaseFunctionList), so after wrapping the
--  profiler empties every known environment's tPhaseFunctionCache; the
--  lists are rebuilt on the next phase call and pick the wrappers up.
--  A function called more than nHotCalls times in one frame is unhooked
--  again (its time then counts as its caller's self time).
--  Optional "Lua sampler" (only when retail Lua has debug.sethook): a count
--  hook on the game's Lua threads tallies which function runs every
--  nSampleCount instructions (instruction share, not time).
--
--  It can't see native engine work (simulation, pathing, animation,
--  rendering, the GPU, the UI's native layout): that is the rest of the
--  frame.
--
--  JS -> Lua  PZ2QoL_ProfHello(), PZ2QoL_ProfStart(sOptsJson),
--             PZ2QoL_ProfStop(), PZ2QoL_ProfReset(), PZ2QoL_ProfSnapshot(),
--             PZ2QoL_ProfPing() every 2 s while running (no ping for
--             nPageTimeoutMs, e.g. the page went with the park: it stops)
--  Lua -> JS  PZ2QoL_ProfData(sJson) every nReportMs while on, and after
--             every command
-----------------------------------------------------------------------
local global       = _G
local api          = global.api
local pcall        = global.pcall
local type         = global.type
local tostring     = global.tostring
local tonumber     = global.tonumber
local pairs        = global.pairs
local ipairs       = global.ipairs
local next         = global.next
local rawget       = global.rawget
local rawset       = global.rawset
local setmetatable = global.setmetatable
local string       = global.string
local table        = global.table
local math         = global.math
local coroutine    = global.coroutine

local Profiler = module(...)

Profiler.nReportMs = 500      -- data to the page
Profiler.nScanMs = 2000       -- look for modules loaded since
Profiler.nHotCalls = 3000     -- calls in one frame before a hook is dropped
Profiler.nTop = 120           -- rows sent
Profiler.nWindowDefault = 120 -- frames in the rolling window
Profiler.nSampleCount = 1000  -- instructions between two samples
Profiler.nPageTimeoutMs = 15000 -- no ping from a page this long: stop (the page is gone)

-- the game calls these every frame (or every frame while a screen is up)
Profiler.tFrameNames = {
	Advance = true, AdvanceWhileRunning = true, AdvancePreWorld = true,
	OnAdvance = true, OnAdvanceWhileRunning = true, OnAdvancePreWorldScript = true,
	Update = true, UpdateIsComplete = true,
}
Profiler.tSkipModules = {
	["pz2qol.profiler"] = true, ["pz2qol.profcore"] = true,
	_g = true, api = true, string = true, table = true, math = true, coroutine = true,
	utf8 = true, package = true, debug = true, os = true, io = true, bit32 = true,
}
-- Deep mode leaves these alone: tiny helpers called thousands of times a
-- frame (vectors, tables, data lookups) and the module system itself
Profiler.tDeepSkip = {
	"^common%.", "^api%.", "^database%.", "^vector", "^quaternion", "^transform", "^matrix",
	"^environment%.", "^interfaces%.", "^game%.basegame", "^ui2%.", "^luacomponentmanagerbase",
}
Profiler.tSkipFns = {
	new = true, class = true, subclass = true, isa = true, call_on_super = true,
}

Profiler.tViews = {}
Profiler.tCaps = {}
Profiler.bDeep = false
Profiler.bSampler = false
Profiler.nWindow = 120
Profiler.nOverheadUs = 0
Profiler.nHooked = 0
Profiler.nUnhooked = 0
Profiler.sNote = ""
Profiler.sError = nil

-----------------------------------------------------------------------
-- The hot path (module upvalues, no table lookups beyond the stat)
-----------------------------------------------------------------------
local ProfCore = nil
local bOn = false
local st = nil          -- ProfCore state
local Add = nil         -- ProfCore.Add
local fnTimer = nil     -- api.time.GetPerformanceTimer
local elapsed = nil     -- (t1, t0) -> ms
local nDepth = 0
local tChild = {}       -- per depth: ms spent in timed children
local nLuaFrame = 0     -- ms of outermost timed calls in this frame
local nHotCalls = 3000
local tHot = {}
local tOurs = setmetatable({}, { __mode = "k" }) -- our wrappers

local function record(s, d, t0, f0, t1)
	if st.frame - f0 > 1 then
		return -- it yielded across frames: not a frame cost
	end
	local el = elapsed(t1, t0)
	local c = tChild[d] or 0
	if d > 1 then
		tChild[d - 1] = (tChild[d - 1] or 0) + el
	else
		nLuaFrame = nLuaFrame + el
	end
	if Add(st, s, el, el - c) > nHotCalls and not s.hot then
		s.hot = true
		tHot[#tHot + 1] = s
	end
end

local function finish(s, d, t0, f0, ...)
	local t1 = fnTimer()
	nDepth = d - 1
	if bOn then
		pcall(record, s, d, t0, f0, t1)
	end
	return ...
end

local function makeWrapper(s, fn)
	local w = function(...)
		if not bOn then
			return fn(...)
		end
		local d = nDepth + 1
		nDepth = d
		tChild[d] = 0
		return finish(s, d, fnTimer(), st.frame, fn(...))
	end
	tOurs[w] = true
	return w
end

-----------------------------------------------------------------------
-- Helpers
-----------------------------------------------------------------------
Profiler._Log = function(self, sEvent, tData)
	if self.Core then
		pcall(self.Core.Log, self.Core, "prof", sEvent, tData)
	end
end

Profiler._Mark = function(self, sName)
	if self.Core then
		pcall(self.Core.Checkpoint, self.Core, sName)
	end
end

Profiler.GroupOf = function(sLow)
	if string.find(sLow, "^pz2qol%.") then return "mod" end
	if string.find(sLow, "^managers%.") then return "manager" end
	if string.find(sLow, "^components%.ui%.") or string.find(sLow, "^ui%.") or string.find(sLow, "^windows%.") then return "ui" end
	if string.find(sLow, "^components%.") then return "component" end
	if string.find(sLow, "^editors%.") or string.find(sLow, "mode$") then return "mode" end
	if string.find(sLow, "^startscreen%.") then return "hub" end
	if string.find(sLow, "^objectives%.") or string.find(sLow, "^challenges%.") or string.find(sLow, "^events%.") then return "objective" end
	if string.find(sLow, "^world") or string.find(sLow, "^game%.") or string.find(sLow, "^environment%.") then return "world" end
	return "other"
end

Profiler._DeepOk = function(self, sLow)
	for _, sPat in ipairs(self.tDeepSkip) do
		if string.find(sLow, sPat) then
			return false
		end
	end
	return true
end

-- Picks how to turn two timer readings into ms; nil when the timer API is
-- missing or gives nonsense.
Profiler._PickTimer = function(self)
	local tTime = api and api.time
	if type(tTime) ~= "table" then
		return nil, "no api.time"
	end
	local fnT = tTime.GetPerformanceTimer
	local fnMs = tTime.PerformanceTimeToMilliseconds
	local fnDiff = tTime.DiffPerformanceTimers
	if type(fnT) ~= "function" or type(fnMs) ~= "function" then
		return nil, "no performance timer"
	end
	local t0 = fnT()
	local t1 = fnT()
	local tVariants = {}
	if type(fnDiff) == "function" then
		tVariants[#tVariants + 1] = { "diff", function(a, b) return fnMs(fnDiff(a, b)) end }
	end
	if math.type and math.type(t0) == "integer" then
		tVariants[#tVariants + 1] = { "sub", function(a, b) return fnMs(a - b) end }
	end
	tVariants[#tVariants + 1] = { "ms", function(a, b) return fnMs(a) - fnMs(b) end }
	for _, v in ipairs(tVariants) do
		local bOk, n = pcall(v[2], t1, t0)
		if bOk and type(n) == "number" and n >= 0 and n < 1000 then
			self.tCaps.timer = v[1]
			self.tCaps.timerType = math.type and tostring(math.type(t0)) or type(t0)
			return fnT, v[2]
		end
	end
	return nil, "timer gives no usable difference"
end

Profiler._ProbeCaps = function(self)
	local t = self.tCaps
	local dbg = rawget(global, "debug")
	t.debug = type(dbg) == "table"
	t.sethook = t.debug and type(dbg.sethook) == "function" or false
	t.getinfo = t.debug and type(dbg.getinfo) == "function" or false
	local bOk, n = pcall(function() return global.collectgarbage("count") end)
	t.gc = bOk and type(n) == "number" or false
	t.diff = type(api) == "table" and type(api.time) == "table" and type(api.time.DiffPerformanceTimers) == "function" or false
	return t
end

local function heapKB()
	local bOk, n = pcall(function() return global.collectgarbage("count") end)
	return (bOk and type(n) == "number") and n or nil
end

local function protoName(env)
	local s = rawget(env, "sPrototypeModule")
	if type(s) ~= "string" then
		return "?"
	end
	return string.match(s, "([^%.]+)$") or s
end

-----------------------------------------------------------------------
-- Hooks
-----------------------------------------------------------------------
Profiler._NewStat = function(self, sName, sGroup)
	local s = ProfCore.NewStat(st, sName, sGroup)
	self.tStats[#self.tStats + 1] = s
	return s
end

Profiler._Wrap = function(self, t, sKey, sName, sGroup)
	local tDone = self.tWrappedKeys[t]
	if tDone and tDone[sKey] then
		return false
	end
	local fn = rawget(t, sKey)
	if type(fn) ~= "function" or tOurs[fn] then
		return false
	end
	local s = self:_NewStat(sName, sGroup)
	local w = makeWrapper(s, fn)
	if not pcall(rawset, t, sKey, w) or rawget(t, sKey) ~= w then
		tOurs[w] = nil
		return false
	end
	if not tDone then
		tDone = {}
		self.tWrappedKeys[t] = tDone
	end
	tDone[sKey] = true
	local e = { t = t, k = sKey, f = fn, w = w, s = s }
	s.wrap = e
	self.tWraps[#self.tWraps + 1] = e
	self.nHooked = self.nHooked + 1
	return true
end

-- Wraps one module's functions; returns how many.
Profiler._WrapModule = function(self, t, sKey, sLow)
	local sDisp = rawget(t, "_NAME")
	if type(sDisp) ~= "string" then
		sDisp = sKey
	end
	local sGroup = self.GroupOf(sLow)
	local bAll = sGroup == "mod" or (self.bDeep and self:_DeepOk(sLow))
	local n = 0
	if bAll then
		local tKeys = {}
		for k, v in next, t do
			if type(k) == "string" and type(v) == "function" and not self.tSkipFns[k] and string.sub(k, 1, 2) ~= "__" then
				tKeys[#tKeys + 1] = k
			end
		end
		table.sort(tKeys)
		for _, k in ipairs(tKeys) do
			if self:_Wrap(t, k, sDisp .. ":" .. k, sGroup) then
				n = n + 1
			end
		end
	else
		for k in pairs(self.tFrameNames) do
			if type(rawget(t, k)) == "function" and self:_Wrap(t, k, sDisp .. ":" .. k, sGroup) then
				n = n + 1
			end
		end
	end
	return n
end

-- Every loaded module not seen yet. Managers loaded later (a park opened
-- while on) are picked up here; their environments' caches are emptied.
Profiler._Scan = function(self)
	local tLoaded = global.package and global.package.loaded
	if type(tLoaded) ~= "table" then
		return 0
	end
	local nNew = 0
	local tList = {}
	for sKey, t in pairs(tLoaded) do
		if type(sKey) == "string" and type(t) == "table" and not self.tSeenMods[t] then
			tList[#tList + 1] = { sKey, t }
		end
	end
	table.sort(tList, function(a, b) return a[1] < b[1] end)
	for _, p in ipairs(tList) do
		local sKey, t = p[1], p[2]
		if not self.tSeenMods[t] then
			self.tSeenMods[t] = true
			local sLow = string.lower(sKey)
			if not self.tSkipModules[sLow] and t ~= global and t ~= api then
				local bOk, n = pcall(self._WrapModule, self, t, sKey, sLow)
				if bOk then
					nNew = nNew + n
				end
			end
		end
	end
	if nNew > 0 then
		self:_ClearPhaseCaches()
	end
	return nNew
end

Profiler._ClearPhaseCache = function(self, env)
	pcall(function()
		if rawget(env, "bShutdownStarted") or rawget(env, "bShutdownComplete") then
			return
		end
		if type(rawget(env, "tPhaseFunctionCache")) == "table" then
			rawset(env, "tPhaseFunctionCache", {})
		end
	end)
end

Profiler._ClearPhaseCaches = function(self)
	for env in pairs(self.tEnvs) do
		self:_ClearPhaseCache(env)
	end
end

Profiler._KnownEnvs = function(self)
	pcall(function()
		local env = api.game.GetEnvironment()
		if type(env) == "table" then
			self.tEnvs[env] = true
		end
	end)
	pcall(function()
		local env = api.world.GetWorldAPIs().environment
		if type(env) == "table" then
			self.tEnvs[env] = true
			local p = rawget(env, "tParent")
			if type(p) == "table" then
				self.tEnvs[p] = true
			end
		end
	end)
end

-- Runs (in a pcall) before every Environment.OnPhase while on: the frame
-- mark, new environments, the sampler hook, the phase's stat.
Profiler._PhaseEnter = function(self, env, sPhase)
	if not self.tEnvs[env] then
		self.tEnvs[env] = true
		self:_ClearPhaseCache(env)
	end
	if sPhase == "Advance" and rawget(env, "tParent") == nil then
		if self.oAnchor == nil then
			self.oAnchor = env
		end
		if self.oAnchor == env then
			-- The anchor is always called from the same place, so the
			-- nesting there is fixed. A timed function that raised an
			-- error (or yielded) never closed its level: put it back.
			if self.nAnchorDepth == nil or nDepth < self.nAnchorDepth then
				self.nAnchorDepth = nDepth
			elseif nDepth > self.nAnchorDepth then
				self.nLeaks = self.nLeaks + 1
				nDepth = self.nAnchorDepth
			end
			self:_FrameTick()
		end
	end
	if self.bSamplerOn then
		self:_HookThread()
	end
	local tBy = self.tPhaseStats[env]
	if tBy == nil then
		tBy = {}
		self.tPhaseStats[env] = tBy
	end
	local s = tBy[sPhase]
	if s == nil then
		s = self:_NewStat("Phase " .. tostring(sPhase) .. ": " .. protoName(env), "world")
		tBy[sPhase] = s
	end
	return s
end

Profiler._HookEnvironment = function(self)
	local Env = global.package and global.package.loaded and global.package.loaded["environment.environment"]
	if type(Env) ~= "table" or type(rawget(Env, "OnPhase")) ~= "function" then
		self.sNote = "no Environment.OnPhase: no frame signal"
		return false
	end
	local fnOrig = rawget(Env, "OnPhase")
	if tOurs[fnOrig] then
		return true
	end
	local prof = self
	local fnEnter = self._PhaseEnter
	local w = function(env, sPhase, ...)
		if not bOn then
			return fnOrig(env, sPhase, ...)
		end
		local bOk, s = pcall(fnEnter, prof, env, sPhase)
		if not bOk or s == nil or not bOn then
			return fnOrig(env, sPhase, ...)
		end
		local d = nDepth + 1
		nDepth = d
		tChild[d] = 0
		return finish(s, d, fnTimer(), st.frame, fnOrig(env, sPhase, ...))
	end
	tOurs[w] = true
	if not pcall(rawset, Env, "OnPhase", w) then
		return false
	end
	self.tEnvHook = { t = Env, f = fnOrig, w = w }
	local tDone = self.tWrappedKeys[Env] or {}
	tDone.OnPhase = true
	self.tWrappedKeys[Env] = tDone
	return true
end

-----------------------------------------------------------------------
-- Frames and reports
-----------------------------------------------------------------------
Profiler._FrameTick = function(self)
	local t = fnTimer()
	local nWall = 0
	if self.tLastFrame ~= nil then
		nWall = elapsed(t, self.tLastFrame)
		ProfCore.EndFrame(st, nWall, nLuaFrame)
		self.nSinceReport = self.nSinceReport + nWall
		self.nSinceScan = self.nSinceScan + nWall
	end
	nLuaFrame = 0
	self.tLastFrame = t
	if #tHot > 0 then
		self:_UnhookHot()
	end
	if self.nSinceScan >= self.nScanMs then
		self.nSinceScan = 0
		pcall(self._Scan, self)
	end
	if self.nSinceReport >= self.nReportMs then
		self.nSinceReport = 0
		if self.tLastPing ~= nil and elapsed(t, self.tLastPing) > self.nPageTimeoutMs then
			self:_Log("stop_no_page", {})
			self:Stop()
			return
		end
		pcall(self._Push, self)
	end
	-- the profiler's own cost: its own row, and not the caller's self time
	local nOwn = elapsed(fnTimer(), t)
	Add(st, self.sOwnStat, nOwn, nOwn)
	if nDepth > 0 then
		tChild[nDepth] = (tChild[nDepth] or 0) + nOwn
	end
end

Profiler._UnhookHot = function(self)
	for i = #tHot, 1, -1 do
		local s = tHot[i]
		tHot[i] = nil
		local e = s.wrap
		if e and not s.unhooked then
			s.unhooked = true
			if rawget(e.t, e.k) == e.w then
				pcall(rawset, e.t, e.k, e.f)
			end
			self.nUnhooked = self.nUnhooked + 1
			self:_Log("unhooked", { name = s.name, calls = s.fc })
		end
	end
	self:_ClearPhaseCaches()
end

-- sampler -------------------------------------------------------------
local tSamples, tSamplesOld, nSamples = {}, {}, 0
local fnGetInfo = nil
local function sampleHook()
	local info = fnGetInfo(2, "f")
	if info ~= nil then
		local f = info.func
		if f ~= nil then
			tSamples[f] = (tSamples[f] or 0) + 1
			nSamples = nSamples + 1
		end
	end
end

Profiler._HookThread = function(self)
	local co = coroutine.running()
	if co ~= nil and not self.tHookedThreads[co] then
		self.tHookedThreads[co] = true
		pcall(global.debug.sethook, co, sampleHook, "", self.nSampleCount)
	end
end

Profiler._SamplerRows = function(self, nTop)
	if not self.bSamplerOn or fnGetInfo == nil then
		return nil
	end
	local tSum, nTotal = {}, 0
	for _, tSet in ipairs({ tSamplesOld, tSamples }) do
		for f, n in pairs(tSet) do
			tSum[f] = (tSum[f] or 0) + n
			nTotal = nTotal + n
		end
	end
	local tRows = {}
	for f, n in pairs(tSum) do
		local sName = "?"
		local bOk, info = pcall(fnGetInfo, f, "S")
		if bOk and type(info) == "table" then
			sName = tostring(info.short_src) .. ":" .. tostring(info.linedefined)
		end
		tRows[#tRows + 1] = { n = sName, k = n, p = nTotal > 0 and n * 100 / nTotal or 0 }
	end
	table.sort(tRows, function(a, b) return a.k > b.k end)
	while #tRows > (nTop or 40) do
		tRows[#tRows] = nil
	end
	return { total = nTotal, rows = tRows }
end

Profiler._State = function(self, nTop)
	local r
	if st ~= nil then
		r = ProfCore.Report(st, nTop or self.nTop, 120)
		r.strip.wall = ProfCore.Round1(r.strip.wall)
		r.strip.lua = ProfCore.Round1(r.strip.lua)
	else
		r = { frames = 0, rows = {}, strip = { wall = {}, lua = {} } }
	end
	r.on = bOn
	r.deep = self.bDeep
	r.sampler = self.bSamplerOn and true or false
	r.window = self.nWindow
	r.caps = self.tCaps
	r.hooked = self.nHooked
	r.unhooked = self.nUnhooked
	r.leaks = self.nLeaks
	r.overheadUs = self.nOverheadUs
	r.note = self.sNote or ""
	r.err = self.sError
	local nEnvs = 0
	for _ in pairs(self.tEnvs or {}) do
		nEnvs = nEnvs + 1
	end
	r.envs = nEnvs
	local nHeap = heapKB()
	if nHeap then
		r.heapKB = math.floor(nHeap)
		if self.nLastHeap and self.nLastHeapMs and self.nLastHeapMs > 0 then
			r.heapRate = (nHeap - self.nLastHeap) * 1000 / self.nLastHeapMs
		end
	end
	if bOn then
		r.samples = self:_SamplerRows(40)
	end
	return r
end

Profiler._Push = function(self)
	local r = self:_State()
	local nHeap = heapKB()
	self.nLastHeap = nHeap
	self.nLastHeapMs = self.nReportMs
	-- the sampler keeps the last two report periods x4 (about 2 s)
	self.nSamplerTurn = (self.nSamplerTurn or 0) + 1
	if self.nSamplerTurn >= 4 then
		self.nSamplerTurn = 0
		tSamplesOld = tSamples
		tSamples = {}
	end
	self:_Send("PZ2QoL_ProfData", ProfCore.Json(r))
end

Profiler._Send = function(self, sEvent, ...)
	for oUI in pairs(self.tViews) do
		local bOk = pcall(oUI.TriggerEventAtNextAdvance, oUI, sEvent, ...)
		if not bOk or oUI.view == nil then
			self.tViews[oUI] = nil
		end
	end
end

-----------------------------------------------------------------------
-- Start / stop
-----------------------------------------------------------------------
Profiler._Calibrate = function(self)
	local stReal = st
	st = ProfCore.NewState(1, 1000000)
	local function noop() end
	local w = makeWrapper(ProfCore.NewStat(st, "calibrate", "mod"), noop)
	local n = 2000
	bOn = true
	local t0 = fnTimer()
	for _ = 1, n do
		w()
	end
	local nWrapped = elapsed(fnTimer(), t0)
	bOn = false
	t0 = fnTimer()
	for _ = 1, n do
		noop()
	end
	local nRaw = elapsed(fnTimer(), t0)
	tOurs[w] = nil
	for i = #tHot, 1, -1 do
		tHot[i] = nil
	end
	nDepth = 0
	nLuaFrame = 0
	st = stReal
	self.nOverheadUs = math.max(0, (nWrapped - nRaw) * 1000 / n)
end

Profiler._ResetCounters = function(self)
	st = ProfCore.NewState(4, math.max(1, self.nWindow // 4))
	for _, s in ipairs(self.tStats or {}) do
		s.ff = -1
		s.fc, s.ft, s.fs, s.fm = 0, 0, 0, 0
		s.bg, s.bc, s.bt, s.bs, s.bm, s.bf = {}, {}, {}, {}, {}, {}
		s.act = false
	end
	self.tLastFrame = nil
	self.nSinceReport = 0
	self.nSinceScan = 0
	nLuaFrame = 0
	tSamples, tSamplesOld, nSamples = {}, {}, 0
end

Profiler._Start = function(self, tOpts)
	tOpts = tOpts or {}
	ProfCore = ProfCore or global.require("PZ2QoL.ProfCore")
	Add = ProfCore.Add
	local fnT, fnE = self:_PickTimer()
	if fnT == nil then
		error(fnE or "no timer")
	end
	fnTimer, elapsed = fnT, fnE
	self:_ProbeCaps()
	self.bDeep = tOpts.deep == true
	local nWindow = tonumber(tOpts.window) or self.nWindowDefault
	self.nWindow = math.max(20, math.min(600, math.floor(nWindow)))
	nHotCalls = self.nHotCalls
	self.sNote = ""
	self.sError = nil
	self.nHooked, self.nUnhooked = 0, 0
	self.tStats = {}
	self.tWraps = {}
	self.tWrappedKeys = setmetatable({}, { __mode = "k" })
	self.tSeenMods = setmetatable({}, { __mode = "k" })
	self.tEnvs = setmetatable({}, { __mode = "k" })
	self.tPhaseStats = setmetatable({}, { __mode = "k" })
	self.tHookedThreads = setmetatable({}, { __mode = "k" })
	self.oAnchor = nil
	self.nAnchorDepth = nil
	self.nLeaks = 0
	self:_Calibrate()
	self:_ResetCounters()
	self.sOwnStat = self:_NewStat("PZ2QoL.Profiler:FrameTick (own cost)", "mod")
	nDepth = 0
	for k in pairs(tChild) do
		tChild[k] = nil
	end
	local bFrames = self:_HookEnvironment()
	self:_KnownEnvs()
	self:_Scan()
	self:_ClearPhaseCaches()
	-- sampler
	self.bSamplerOn = false
	if tOpts.sampler == true and self.tCaps.sethook and self.tCaps.getinfo then
		fnGetInfo = global.debug.getinfo
		self.bSamplerOn = true
	end
	self.nLastHeap = heapKB()
	self.nLastHeapMs = 0
	self.tLastPing = fnTimer()
	bOn = true
	self:_Mark("prof_start")
	self:_Log("start", {
		deep = self.bDeep, sampler = self.bSamplerOn, window = self.nWindow, hooked = self.nHooked,
		frames = bFrames, overheadUs = self.nOverheadUs, timer = self.tCaps.timer, timerType = self.tCaps.timerType,
	})
end

Profiler._RestoreAll = function(self)
	for _, e in ipairs(self.tWraps or {}) do
		if rawget(e.t, e.k) == e.w then
			pcall(rawset, e.t, e.k, e.f)
		end
	end
	if self.tEnvHook then
		local e = self.tEnvHook
		if rawget(e.t, "OnPhase") == e.w then
			pcall(rawset, e.t, "OnPhase", e.f)
		end
		self.tEnvHook = nil
	end
	self.tWraps = {}
	self.tWrappedKeys = setmetatable({}, { __mode = "k" })
	if self.tEnvs then
		self:_ClearPhaseCaches()
	end
	if self.tHookedThreads then
		for co in pairs(self.tHookedThreads) do
			pcall(global.debug.sethook, co)
		end
		self.tHookedThreads = setmetatable({}, { __mode = "k" })
	end
	self.bSamplerOn = false
end

Profiler.Start = function(self, tOpts)
	if bOn then
		self:Stop(true)
	end
	local bOk, sErr = pcall(self._Start, self, tOpts)
	if not bOk then
		bOn = false
		pcall(self._RestoreAll, self)
		self.sError = tostring(sErr)
		self:_Mark("prof_failed")
		self:_Log("start_failed", { err = self.sError })
	end
	pcall(self._Push, self)
	return bOk
end

Profiler.Stop = function(self, bQuiet)
	local bWasOn = bOn
	bOn = false
	pcall(self._RestoreAll, self)
	if bWasOn then
		self:_Mark("prof_stop")
		local bOk, r = pcall(self._State, self, 5)
		if bOk then
			self:_Log("stop", { frames = r.frames, wallAvg = r.wallAvg, luaAvg = r.luaAvg, unhooked = self.nUnhooked })
		end
	end
	if not bQuiet then
		pcall(self._Push, self)
	end
end

Profiler.Reset = function(self)
	if st ~= nil then
		self:_ResetCounters()
	end
	pcall(self._Push, self)
end

Profiler.Ping = function(self)
	if bOn and fnTimer ~= nil then
		self.tLastPing = fnTimer()
	end
end

Profiler.IsOn = function(self)
	return bOn
end

local function fmt(n)
	if type(n) ~= "number" then
		return n
	end
	return math.floor(n * 1000 + 0.5) / 1000
end

-- The top rows into the debug log (` LOG ` lines, area prof).
Profiler.Snapshot = function(self, nTop)
	nTop = nTop or 25
	local bOk, r = pcall(self._State, self, nTop)
	if not bOk then
		self:_Log("snapshot_failed", { err = tostring(r) })
		return false
	end
	local nFps = (r.wallAvg or 0) > 0 and 1000 / r.wallAvg or 0
	self:_Log("snapshot", {
		on = bOn, frames = r.frames, fps = fmt(nFps), wallAvg = fmt(r.wallAvg), wallMax = fmt(r.wallMax),
		luaAvg = fmt(r.luaAvg), luaMax = fmt(r.luaMax), deep = self.bDeep, hooked = self.nHooked,
		unhooked = self.nUnhooked, overheadUs = fmt(self.nOverheadUs), callsPerFrame = fmt(r.callsPerFrame),
		heapKB = r.heapKB, envs = r.envs, note = r.note,
	})
	local tGroups = {}
	for g, n in pairs(r.groups or {}) do
		tGroups[g] = fmt(n)
	end
	self:_Log("groups", tGroups)
	for i, row in ipairs(r.rows or {}) do
		if i > nTop then
			break
		end
		self:_Log("row", {
			i = i, name = row.n, grp = row.g, self = fmt(row.s), tot = fmt(row.t), calls = fmt(row.c),
			avg = fmt(row.a), max = fmt(row.m), worst = fmt(row.x), unhooked = row.h,
		})
	end
	if r.samples and r.samples.rows then
		for i, row in ipairs(r.samples.rows) do
			if i > 15 then
				break
			end
			self:_Log("sample", { i = i, fn = row.n, pct = fmt(row.p), n = row.k })
		end
	end
	return true
end

-----------------------------------------------------------------------
-- Page events
-----------------------------------------------------------------------
Profiler.ParseOpts = function(sOpts)
	local t = {}
	if type(sOpts) ~= "string" then
		return t
	end
	t.deep = string.find(sOpts, '"deep"%s*:%s*true') ~= nil
	t.sampler = string.find(sOpts, '"sampler"%s*:%s*true') ~= nil
	t.window = tonumber(string.match(sOpts, '"window"%s*:%s*(%d+)'))
	return t
end

Profiler.Attach = function(self, oUI)
	if oUI == nil or self.tViews[oUI] then
		return
	end
	self.tViews[oUI] = true
	local function guard(fn)
		return function(_, ...)
			local bOk, sErr = pcall(fn, ...)
			if not bOk then
				self:_Log("event_failed", { err = tostring(sErr) })
			end
		end
	end
	pcall(function()
		oUI:AddEventListener("PZ2QoL_ProfHello", 0, guard(function() self:_Push() end), self)
		oUI:AddEventListener("PZ2QoL_ProfStart", 1, guard(function(sOpts) self:Start(self.ParseOpts(sOpts)) end), self)
		oUI:AddEventListener("PZ2QoL_ProfStop", 0, guard(function() self:Stop() end), self)
		oUI:AddEventListener("PZ2QoL_ProfReset", 0, guard(function() self:Reset() end), self)
		oUI:AddEventListener("PZ2QoL_ProfSnapshot", 0, guard(function() self:Snapshot(25) end), self)
		oUI:AddEventListener("PZ2QoL_ProfPing", 0, guard(function() self:Ping() end), self)
	end)
end

Profiler.Init = function(self, Core)
	self.Core = Core
	Core.Profiler = self
	pcall(function()
		ProfCore = global.require("PZ2QoL.ProfCore")
	end)
	pcall(self._ProbeCaps, self)
	-- once per boot: what retail Lua offers a profiler
	self:_Log("caps", self.tCaps)
end

-- tests only
Profiler._Internals = function()
	return { st = st, nDepth = nDepth, bOn = bOn, nLuaFrame = nLuaFrame, tOurs = tOurs }
end
