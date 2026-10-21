-----------------------------------------------------------------------
--  PZ2QoL.ProfCore  (Script profiler: the numbers)
--
--  Pure aggregation for PZ2QoL.Profiler, no game API, so the maths is
--  tested on its own (tests/lua/test_profiler.lua).
--
--  A stat is one timed function. Samples land in the current frame; a
--  finished frame is folded into one of nBuckets ring buckets of
--  nPerBucket frames each, so a report covers the last
--  nBuckets * nPerBucket frames (rolling, the oldest bucket drops out
--  whole). Per stat and bucket: calls, total ms, self ms (total minus
--  timed children), the slowest single call and the worst frame (the
--  most ms it took in one frame).
--
--  State fields used by the profiler's hot path: st.frame (the current
--  frame id). Everything else is private.
-----------------------------------------------------------------------
local global   = _G
local type     = global.type
local tostring = global.tostring
local pairs    = global.pairs
local ipairs   = global.ipairs
local next     = global.next
local string   = global.string
local table    = global.table
local math     = global.math

local ProfCore = module(...)

ProfCore.nRing = 240 -- frames kept for the frame strip

ProfCore.NewState = function(nBuckets, nPerBucket)
	local st = {
		B = math.max(1, math.floor(nBuckets or 4)),
		M = math.max(1, math.floor(nPerBucket or 30)),
		frame = 0,
		-- frame buckets: generation, frames, wall sum, lua sum, wall max, lua max
		fg = {}, fn = {}, fw = {}, fl = {}, fx = {}, flx = {},
		ringW = {}, ringL = {}, ringPos = 1, ringN = 0,
		tActive = {},
		nStats = 0,
	}
	return st
end

ProfCore.NewStat = function(st, sName, sGroup)
	st.nStats = st.nStats + 1
	return {
		name = sName, group = sGroup or "other",
		ff = -1, fc = 0, ft = 0, fs = 0, fm = 0,
		bg = {}, bc = {}, bt = {}, bs = {}, bm = {}, bf = {},
		act = false,
	}
end

local function bucketOf(st, nFrame)
	local g = nFrame // st.M
	return g, g % st.B + 1
end

-- folds the stat's pending frame (s.ff) into its bucket
local function flush(st, s)
	local f = s.ff
	if f < 0 then
		return
	end
	local g, k = bucketOf(st, f)
	if s.bg[k] ~= g then
		s.bg[k] = g
		s.bc[k] = 0
		s.bt[k] = 0
		s.bs[k] = 0
		s.bm[k] = 0
		s.bf[k] = 0
	end
	s.bc[k] = s.bc[k] + s.fc
	s.bt[k] = s.bt[k] + s.ft
	s.bs[k] = s.bs[k] + s.fs
	if s.fm > s.bm[k] then
		s.bm[k] = s.fm
	end
	if s.ft > s.bf[k] then
		s.bf[k] = s.ft
	end
	s.ff = -1
end
ProfCore._Flush = flush

-- One finished call: nMs in all, nSelfMs of it outside timed children.
-- Returns the stat's calls in this frame (the profiler drops hooks on
-- functions called too often).
ProfCore.Add = function(st, s, nMs, nSelfMs)
	local f = st.frame
	if s.ff ~= f then
		if s.ff >= 0 then
			flush(st, s)
		end
		s.ff = f
		s.fc = 0
		s.ft = 0
		s.fs = 0
		s.fm = 0
		if not s.act then
			s.act = true
			local t = st.tActive
			t[#t + 1] = s
		end
	end
	local c = s.fc + 1
	s.fc = c
	s.ft = s.ft + nMs
	if nSelfMs < 0 then
		nSelfMs = 0
	end
	s.fs = s.fs + nSelfMs
	if nMs > s.fm then
		s.fm = nMs
	end
	return c
end

-- Closes the current frame: its wall time (frame start to frame start)
-- and the Lua time seen in it (outermost timed calls).
ProfCore.EndFrame = function(st, nWallMs, nLuaMs)
	local g, k = bucketOf(st, st.frame)
	if st.fg[k] ~= g then
		st.fg[k] = g
		st.fn[k] = 0
		st.fw[k] = 0
		st.fl[k] = 0
		st.fx[k] = 0
		st.flx[k] = 0
	end
	st.fn[k] = st.fn[k] + 1
	st.fw[k] = st.fw[k] + nWallMs
	st.fl[k] = st.fl[k] + nLuaMs
	if nWallMs > st.fx[k] then
		st.fx[k] = nWallMs
	end
	if nLuaMs > st.flx[k] then
		st.flx[k] = nLuaMs
	end
	st.ringW[st.ringPos] = nWallMs
	st.ringL[st.ringPos] = nLuaMs
	st.ringPos = st.ringPos % ProfCore.nRing + 1
	if st.ringN < ProfCore.nRing then
		st.ringN = st.ringN + 1
	end
	st.frame = st.frame + 1
end

-- is generation g inside the window that ends with the last finished frame?
local function inWindow(st, g)
	if st.frame <= 0 then
		return false
	end
	local gNow = (st.frame - 1) // st.M
	return g ~= nil and g <= gNow and g > gNow - st.B
end

-- The frame side of the window: frames, wall and Lua sums and maxima.
ProfCore.FrameSummary = function(st)
	local n, w, l, x, lx = 0, 0, 0, 0, 0
	for k = 1, st.B do
		if inWindow(st, st.fg[k]) then
			n = n + st.fn[k]
			w = w + st.fw[k]
			l = l + st.fl[k]
			if st.fx[k] > x then x = st.fx[k] end
			if st.flx[k] > lx then lx = st.flx[k] end
		end
	end
	return {
		frames = n,
		wallAvg = n > 0 and w / n or 0,
		wallMax = x,
		luaAvg = n > 0 and l / n or 0,
		luaMax = lx,
	}
end

-- The last nMax frames, oldest first: { wall = {...}, lua = {...} }.
ProfCore.Strip = function(st, nMax)
	local nRing = ProfCore.nRing
	local n = math.min(st.ringN, nMax or nRing)
	local tW, tL = {}, {}
	local pos = st.ringPos - n
	for i = 1, n do
		local k = (pos + i - 2) % nRing + 1
		tW[i] = st.ringW[k] or 0
		tL[i] = st.ringL[k] or 0
	end
	return { wall = tW, lua = tL }
end

-- One stat over the window, per frame. nil when it had no calls in it.
ProfCore.StatRow = function(st, s, nFrames)
	local c, t, sf, m, x = 0, 0, 0, 0, 0
	for k = 1, st.B do
		if inWindow(st, s.bg[k]) then
			c = c + s.bc[k]
			t = t + s.bt[k]
			sf = sf + s.bs[k]
			if s.bm[k] > m then m = s.bm[k] end
			if s.bf[k] > x then x = s.bf[k] end
		end
	end
	if c <= 0 then
		return nil
	end
	local n = (nFrames and nFrames > 0) and nFrames or 1
	return {
		n = s.name, g = s.group,
		c = c / n,          -- calls per frame
		t = t / n,          -- total ms per frame
		s = sf / n,         -- self ms per frame
		a = t / c,          -- ms per call
		m = m,              -- slowest call (ms)
		x = x,              -- worst frame (ms in one frame)
		k = c,              -- calls in the window
		h = s.unhooked and 1 or nil,
	}
end

local function byTotal(a, b) return a.t > b.t end
local function bySelf(a, b) return a.s > b.s end
local function byMax(a, b) return a.m > b.m end
local function byCalls(a, b) return a.c > b.c end

-- The report: frame summary, the frame strip and up to nTop rows (the
-- biggest totals, plus the biggest self times, spikes and call counts so a
-- sort by any column in the panel shows the real leaders). Flushes
-- finished frames and drops stats that left the window from the active
-- list.
ProfCore.Report = function(st, nTop, nStrip)
	nTop = nTop or 120
	local tSum = ProfCore.FrameSummary(st)
	local tRows, tKeep = {}, {}
	for _, s in ipairs(st.tActive) do
		if s.ff >= 0 and s.ff < st.frame then
			flush(st, s)
		end
		local r = ProfCore.StatRow(st, s, tSum.frames)
		if r ~= nil then
			tRows[#tRows + 1] = r
			tKeep[#tKeep + 1] = s
		elseif s.ff >= 0 then
			-- calls in the frame still running: keep it
			tKeep[#tKeep + 1] = s
		else
			s.act = false
		end
	end
	st.tActive = tKeep
	local nAll = #tRows
	local tSelfSum, tCallSum = 0, 0
	local tGroups = {}
	for _, r in ipairs(tRows) do
		tSelfSum = tSelfSum + r.s
		tCallSum = tCallSum + r.c
		tGroups[r.g] = (tGroups[r.g] or 0) + r.s
	end
	local tOut, tSeen = {}, {}
	local function take(fnSort, n)
		table.sort(tRows, fnSort)
		for i = 1, math.min(n, #tRows) do
			local r = tRows[i]
			if not tSeen[r] then
				tSeen[r] = true
				tOut[#tOut + 1] = r
			end
		end
	end
	if #tRows > 0 then
		take(byTotal, nTop)
		take(bySelf, 25)
		take(byMax, 25)
		take(byCalls, 15)
	end
	table.sort(tOut, bySelf)
	tSum.rows = tOut
	tSum.active = nAll
	tSum.selfSum = tSelfSum
	tSum.callsPerFrame = tCallSum
	tSum.groups = tGroups
	tSum.strip = ProfCore.Strip(st, nStrip or 120)
	return tSum
end

-----------------------------------------------------------------------
-- JSON (ASCII; non-ASCII and control bytes as \u00XX)
-----------------------------------------------------------------------
local function jsonString(s)
	return '"' .. string.gsub(tostring(s), '[%c"\\\128-\255]', function(c)
		return string.format("\\u%04x", string.byte(c))
	end) .. '"'
end

local function jsonNumber(n)
	if n ~= n or n == math.huge or n == -math.huge then
		return "0"
	end
	if math.type(n) == "integer" then
		return string.format("%d", n)
	end
	if n == math.floor(n) and math.abs(n) < 1e9 then
		return string.format("%d", math.floor(n))
	end
	local s = string.format("%.4f", n)
	s = string.gsub(s, "0+$", "")
	s = string.gsub(s, "%.$", "")
	return s
end

local encode
encode = function(v, nDepth)
	local t = type(v)
	if t == "number" then
		return jsonNumber(v)
	elseif t == "string" then
		return jsonString(v)
	elseif t == "boolean" then
		return v and "true" or "false"
	elseif t ~= "table" or (nDepth or 0) > 6 then
		return "null"
	end
	local d = (nDepth or 0) + 1
	if #v > 0 or next(v) == nil then
		local tParts = {}
		for i = 1, #v do
			tParts[i] = encode(v[i], d)
		end
		return "[" .. table.concat(tParts, ",") .. "]"
	end
	local tKeys = {}
	for k in pairs(v) do
		if type(k) == "string" then
			tKeys[#tKeys + 1] = k
		end
	end
	table.sort(tKeys)
	local tParts = {}
	for _, k in ipairs(tKeys) do
		tParts[#tParts + 1] = jsonString(k) .. ":" .. encode(v[k], d)
	end
	return "{" .. table.concat(tParts, ",") .. "}"
end
ProfCore.Json = function(v)
	return encode(v, 0)
end

-- Rounds a list of ms values to 0.1 ms (smaller frame strips in the JSON).
ProfCore.Round1 = function(t)
	local tOut = {}
	for i, n in ipairs(t) do
		tOut[i] = math.floor(n * 10 + 0.5) / 10
	end
	return tOut
end
