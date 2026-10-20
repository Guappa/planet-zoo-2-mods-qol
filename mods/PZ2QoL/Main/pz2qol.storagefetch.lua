-----------------------------------------------------------------------
--  PZ2QoL.StorageFetch  ("Bring to the trade centre": Species board ->
--  every stored animal of one species -> this zoo's trade centre)
--
--  The park can't take animals out of Animal Storage (no such call; decompiled
--  1.0.5, see docs/PLAN-storage-to-trade-centre.md), so one click on the
--  Species board:
--    1. here: checks the zoo (park, trade centre, room), keeps the request and
--       the zoo it was made in, and opens the hub on Animal Storage the way
--       the game's own buttons do (PZ2QoL.TradeJump._OpenHub);
--    2. the hub page asks for it (hello), ticks the species' rows and presses
--       the game's own Send to Zoo once, armed for "trade"
--       (PZ2QoL.StorageSend, which reads tLastClick for the zoo);
--    3. back in the zoo PZ2QoL.StorageSend takes the game's Move-screen
--       request and the park page sends each arrival to the trade centre,
--       one at a time.
--  The request is handed over with fresh = true ONCE: a later hello (page
--  reloaded, Storage opened again) gets fresh = false, and the page then
--  waits for a click instead of counting down.
--    JS -> Lua  PZ2QoL_FetchStart(req, species, exclude) -> PZ2QoL_FetchStartResult(req, ok, detail, room)
--    JS -> Lua  PZ2QoL_FetchHello()                    (hub page, on load / Storage shown)
--    Lua -> JS  PZ2QoL_FetchPending(seq, species, room, exclude, fresh)
--    JS -> Lua  PZ2QoL_FetchAck(seq)                   (sent, or cancelled: dropped)
--  Fail soft: every call in pcall.
-----------------------------------------------------------------------
local global   = _G
local api      = global.api
local pcall    = global.pcall
local tostring = global.tostring
local tonumber = global.tonumber
local type     = global.type
local string   = global.string

local Fetch = module(...)

Fetch.nPendingSeconds = 600 -- a request older than this is dropped
Fetch.nMaxExclude = 16000   -- characters of the exclude list ("Bring all": the whole zoo)
Fetch.sAllSpecies = "*"     -- "Bring all": every species in storage (the page's ALL_SPECIES)
Fetch.tPending = nil        -- { nSeq, sSpecies, nRoom, sExclude, nTime, bDelivered }
Fetch.tLastClick = nil      -- { sZoo, sMode, nTime }: read by StorageSend's arm
Fetch.nSeq = 0
Fetch.tViews = global.setmetatable({}, { __mode = "k" })

local function trace(sMsg)
	pcall(function() api.debug.Trace("[PZ2QoL] fetch: " .. sMsg) end)
end

local function mark(sName)
	local Core = Fetch.Core or global.package.loaded["pz2qol.core"]
	if Core then
		pcall(Core.Mark, Core, sName)
	end
end

local function log(sEvent, tData)
	local Core = Fetch.Core or global.package.loaded["pz2qol.core"]
	if Core and Core.Log then
		pcall(Core.Log, Core, "fetch", sEvent, tData)
	end
end

local function now()
	local bOk, n = pcall(function()
		return api.time.PerformanceTimeToMilliseconds(api.time.GetPerformanceTimer()) / 1000
	end)
	return bOk and n or 0
end

local function kin()
	local Core = Fetch.Core
	return (Core and Core.Kin) or global.package.loaded["pz2qol.kin"]
end

local function tradeJump()
	local Core = Fetch.Core
	return (Core and Core.TradeJump) or global.package.loaded["pz2qol.tradejump"]
end

local function call(o, sName, ...)
	if o == nil then
		return nil
	end
	local fn = nil
	pcall(function() fn = o[sName] end)
	if type(fn) ~= "function" then
		return nil
	end
	local bOk, v = pcall(fn, o, ...)
	if not bOk then
		return nil
	end
	return v
end

-- The exclude list from the page: park animals of the species as "g:<guid>"
-- and "n:<sex>:<name>" items, comma separated. Kept as text (the hub page
-- matches it); only printable ASCII, no quotes, capped.
local function cleanExclude(s)
	s = tostring(s or "")
	s = string.gsub(s, "[^%w_:%-%.,%s]", "")
	if #s > Fetch.nMaxExclude then
		s = string.sub(s, 1, Fetch.nMaxExclude)
		-- never a half item
		s = string.gsub(s, ",[^,]*$", "")
	end
	return s
end

-----------------------------------------------------------------------
-- The click (park)
-----------------------------------------------------------------------
Fetch.Start = function(self, oUI, sReq, sSpecies, sExclude)
	local function answer(bOk, sDetail, nRoom)
		mark(bOk and "fetch_start_ok" or ("fetch_start_fail_" .. tostring(sDetail)))
		log("start", { ok = bOk == true, detail = sDetail, room = nRoom })
		pcall(oUI.TriggerEventAtNextAdvance, oUI, "PZ2QoL_FetchStartResult", sReq, bOk == true, sDetail or "", nRoom or -1)
	end
	local TJ = tradeJump()
	local Kin = kin()
	if TJ == nil or Kin == nil then
		return answer(false, "nohub")
	end
	local sp = nil
	if tostring(sSpecies or "") == self.sAllSpecies then
		sp = self.sAllSpecies
	else
		sp = TJ.CleanSpecies(sSpecies)
	end
	if sp == nil then
		return answer(false, "badspecies")
	end
	local tAPIs = Kin:_ParkWorld()
	if tAPIs == nil then
		return answer(false, "nopark")
	end
	local tTC = nil
	pcall(function() tTC = Kin:_TradeCentre(tAPIs) end)
	if tTC == nil then
		return answer(false, "notradecentre")
	end
	local nRoom = -1
	local nMax, nNow = call(tAPIs.park, "GetTradeCentreMaxCapacity"), call(tAPIs.park, "GetNumberOfAnimalsInTradeCentre")
	if type(nMax) == "number" and type(nNow) == "number" then
		nRoom = nMax - nNow
		if nRoom <= 0 then
			return answer(false, "full", 0)
		end
	end
	local sMode = Kin:_GameMode(tAPIs)
	local sZoo = nil
	pcall(function() sZoo = Kin:_ZooKey(tAPIs, 1e9) end)
	local sEx = cleanExclude(sExclude)
	local bOk, sDetail = TJ:_OpenHub("storage", sp, function()
		self.nSeq = self.nSeq + 1
		self.tPending = { nSeq = self.nSeq, sSpecies = sp, nRoom = nRoom, sExclude = sEx, nTime = now(), bDelivered = false }
		self.tLastClick = { sZoo = sZoo, sMode = sMode, nTime = now() }
	end)
	if not bOk then
		-- the hub did not open: nothing may arrive for it later
		self.tPending = nil
		return answer(false, sDetail, nRoom)
	end
	trace("bringing " .. sp .. " (room " .. tostring(nRoom) .. ")")
	answer(true, "", nRoom)
end

-----------------------------------------------------------------------
-- The hub page: the request, fresh only once
-----------------------------------------------------------------------
Fetch.Hello = function(self, oUI)
	local t = self.tPending
	if t == nil then
		return
	end
	if now() - t.nTime > self.nPendingSeconds then
		self.tPending = nil
		mark("fetch_expired")
		return
	end
	local bFresh = not t.bDelivered
	t.bDelivered = true
	pcall(oUI.TriggerEventAtNextAdvance, oUI, "PZ2QoL_FetchPending", t.nSeq, t.sSpecies, t.nRoom, t.sExclude, bFresh)
	mark(bFresh and "fetch_pending_fresh" or "fetch_pending_again")
	log("pending", { seq = t.nSeq, fresh = bFresh })
end

Fetch.Ack = function(self, nSeq)
	if self.tPending ~= nil and tonumber(nSeq) == self.tPending.nSeq then
		self.tPending = nil
		mark("fetch_acked")
	end
end

-----------------------------------------------------------------------
-- Wiring
-----------------------------------------------------------------------
Fetch.Attach = function(self, oUI)
	if oUI == nil or self.tViews[oUI] then
		return
	end
	self.tViews[oUI] = true
	local function guard(sName, fn)
		return function(_, ...)
			local bOk, sErr = pcall(fn, ...)
			if not bOk then
				trace(sName .. " failed: " .. tostring(sErr))
			end
		end
	end
	local bOk, sErr = pcall(function()
		oUI:AddEventListener("PZ2QoL_FetchStart", 3, guard("start", function(sReq, sSpecies, sExclude)
			self:Start(oUI, sReq, sSpecies, sExclude)
		end), self)
		oUI:AddEventListener("PZ2QoL_FetchHello", 0, guard("hello", function()
			self:Hello(oUI)
		end), self)
		oUI:AddEventListener("PZ2QoL_FetchAck", 1, guard("ack", function(nSeq)
			self:Ack(nSeq)
		end), self)
	end)
	if not bOk then
		trace("listeners failed: " .. tostring(sErr))
	end
	mark(bOk and "fetch_attached" or "fetch_attach_failed")
end

Fetch.Init = function(self, Core)
	self.Core = Core
	Core.StorageFetch = self
end
