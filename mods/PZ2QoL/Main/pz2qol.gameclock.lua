-----------------------------------------------------------------------
--  PZ2QoL.GameClock  (game seconds: stops while paused, 2x / 5x faster
--  with the game's speed)
--
--  A clock counts seconds at 1x speed. Its source, in order:
--    "calendar"  the park calendar, the same reading Auto mode schedules
--                on (Kin's PZ2QoL_AutoGate): park:GetTimeOfMonth() months
--                times park:GetMonthDurationInSeconds();
--    "frame"     the scaled frame delta its owner passes in (SelectMode.
--                Advance's _nDeltaTime), while the calendar can't be read
--                or stands still although the frames say time runs;
--    "real"      real time, if neither is there.
--  The calendar is read at most every nReadSeconds (real). A calendar
--  step backwards or far faster than any game speed (a load, another
--  park) counts as no time ("jump"). Owners keep their own clock:
--  GameClock.New(), then clock:Advance(nDelta) once per frame.
-----------------------------------------------------------------------
local global   = _G
local api      = global.api
local pcall    = global.pcall
local type     = global.type
local math     = global.math
local table    = global.table
local setmetatable = global.setmetatable

local GameClock = module(...)

GameClock.nReadSeconds = 0.25  -- real seconds between two calendar reads
GameClock.nMaxRate = 10        -- game s per real s above this is a jump, not time (top speed is 5x)
GameClock.nMaxFrame = 5        -- one frame never counts for more (a long hitch is not time)
GameClock.nStaleSeconds = 60   -- calendar unchanged this long (frame time) while frames run: use the frames

local function realNow()
	local bOk, n = pcall(function()
		return api.time.PerformanceTimeToMilliseconds(api.time.GetPerformanceTimer()) / 1000
	end)
	return bOk and type(n) == "number" and n or 0
end

local function call(api_, sName, ...)
	if api_ == nil then
		return nil
	end
	local bOk, fn = pcall(function() return api_[sName] end)
	if not bOk or type(fn) ~= "function" then
		return nil
	end
	local tRes = table.pack(pcall(fn, api_, ...))
	if not tRes[1] then
		return nil
	end
	return table.unpack(tRes, 2, tRes.n)
end

local function isNum(n)
	return type(n) == "number" and n == n and n > -math.huge and n < math.huge
end

-- The park's date (year, month, part of the month) and the month's
-- length at 1x, or nil.
GameClock.ReadCalendar = function()
	local bOk, tAPIs = pcall(function() return api.world.GetWorldAPIs() end)
	if not bOk or type(tAPIs) ~= "table" or tAPIs.park == nil then
		return nil
	end
	local park = tAPIs.park
	local nMonthSec = call(park, "GetMonthDurationInSeconds")
	if not isNum(nMonthSec) or nMonthSec <= 0 then
		return nil
	end
	local oDate = call(park, "GetTimeOfMonth")
	if oDate == nil then
		return nil
	end
	local bRead, nY, nM, nP = pcall(function()
		if type(oDate.Valid) == "function" and oDate:Valid() == false then
			return nil
		end
		local y, m, p = oDate:Year(), oDate:Month(), oDate:Prop()
		if isNum(y) and isNum(m) and isNum(p) then
			return y, m, p
		end
		return nil
	end)
	if not bRead or nY == nil then
		return nil
	end
	return nY, nM, nP, nMonthSec
end

local Clock = {}
Clock.__index = Clock

GameClock.New = function()
	return setmetatable({
		nGame = 0,          -- game seconds so far
		sSource = nil,      -- what the last step came from
		nRealAt = nil,      -- real time of the last read
		nMonths = nil,      -- the calendar at its last change
		nChangedAt = nil,   -- real time of that change
		nSinceChange = 0,   -- frame time since that change
		nPending = 0,       -- frame time since the last read
		nBaseYear = nil,    -- the first calendar year read (months count from it)
		bFrames = false,    -- the owner passes frame deltas
	}, Clock)
end

Clock.Now = function(self)
	return self.nGame
end

-- Once per frame, with the frame's scaled delta (nil if unknown).
-- Returns the game seconds so far.
Clock.Advance = function(self, nDelta)
	if isNum(nDelta) and nDelta >= 0 then
		self.bFrames = true
		self.nPending = self.nPending + math.min(nDelta, GameClock.nMaxFrame)
	end
	local nReal = realNow()
	if self.nRealAt ~= nil and nReal - self.nRealAt < GameClock.nReadSeconds then
		return self.nGame
	end
	local nRealGap = self.nRealAt and math.max(0, nReal - self.nRealAt) or 0
	self.nRealAt = nReal
	local nPending = self.nPending
	self.nPending = 0
	local nY, nM, nP, nMonthSec = GameClock.ReadCalendar()
	local nMonths = nil
	if nY ~= nil then
		-- months since the first year seen: small numbers keep 32-bit floats fine
		self.nBaseYear = self.nBaseYear or nY
		nMonths = (nY - self.nBaseYear) * 12 + nM + nP
	end
	local nStep, sSource
	if nMonths == nil then
		self.nMonths = nil
		if self.bFrames then
			nStep, sSource = nPending, "frame"
		else
			nStep, sSource = nRealGap, "real"
		end
	elseif self.nMonths == nil then
		-- first reading: the calendar counts from the next change
		self.nMonths, self.nChangedAt, self.nSinceChange = nMonths, nReal, 0
		nStep, sSource = self.bFrames and nPending or 0, "calendar"
	elseif nMonths == self.nMonths then
		self.nSinceChange = self.nSinceChange + nPending
		if self.bFrames and self.nSinceChange > GameClock.nStaleSeconds then
			nStep, sSource = nPending, "frame"
		else
			nStep, sSource = 0, "calendar"   -- paused, or between two calendar steps
		end
	else
		local nGameStep = (nMonths - self.nMonths) * nMonthSec
		local nBound = (nReal - (self.nChangedAt or nReal)) * GameClock.nMaxRate + 1
		if self.bFrames and self.nSinceChange > GameClock.nStaleSeconds then
			nStep, sSource = nPending, "frame"  -- the frames counted the time since
		elseif nGameStep < 0 or nGameStep > nBound then
			nStep, sSource = 0, "jump"
		else
			nStep, sSource = nGameStep, "calendar"
		end
		self.nMonths, self.nChangedAt, self.nSinceChange = nMonths, nReal, 0
	end
	self.nGame = self.nGame + nStep
	self.sSource = sSource
	return self.nGame
end
