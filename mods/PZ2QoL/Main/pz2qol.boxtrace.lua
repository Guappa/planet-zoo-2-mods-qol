-----------------------------------------------------------------------
--  PZ2QoL.BoxTrace
--
--  Debug builds only: why animals end up boxed in their own habitat
--  (aquariums first) and never come out (docs/RESEARCH-aquarium-boxing.md).
--  The boxing is native (AnimalSOSComponentManager); this only watches and
--  writes LOG lines to dbg\trace.log. It changes nothing in the game.
--
--  Every nScanSeconds on park frames (HeatMapManager.Advance):
--    - every animal in a habitat: IsAnimalBoxed;
--    - aquarium and swimming animals: a short trail of positions (height
--      below the water surface, distance to the lake's bounds) and their
--      age class, so a boxing shows where the animal was just before;
--    - a boxed animal: all the game's boxing reads, logged when it is
--      first seen boxed, whenever one of them changes, every
--      nStillSeconds while it stays boxed, and when it is out again.
--  Also a summary of the park's aquariums when a park opens. No message
--  receivers: registering one crashed the game twice (debugging.md).
--
--  Area "box" in the log:
--    box park     park opened: aquarium count, LoadedOldMesh
--    box hab      one line per aquarium / water habitat at park open
--    box start    first seen boxed (facts + trail)
--    box change   a boxing read changed while boxed
--    box still    still boxed (every nStillSeconds)
--    box end      no longer boxed (how long, last facts)
--    box age      a watched animal changed age class
-----------------------------------------------------------------------
local global   = _G
local api      = global.api
local pcall    = global.pcall
local type     = global.type
local tostring = global.tostring
local pairs    = global.pairs
local ipairs   = global.ipairs
local math     = global.math
local string   = global.string
local table    = global.table

local BoxTrace = module(...)

BoxTrace.nScanSeconds = 2
BoxTrace.nStillSeconds = 120
BoxTrace.nTrail = 8            -- positions kept per watched animal
-- Position trails (transform reads from the park tick, which runs on a
-- different worker thread each frame). Off after the game crashed during a
-- traced session on Y: (2026-10-19 15:24; cause not proven). The one
-- session with trails showed boxed aquarium turtles mid-water.
BoxTrace.bSamplePositions = false
BoxTrace.nLakeSeconds = 30     -- lake bounds and surface are re-read this often

BoxTrace.tWatch = {}    -- e -> { trail, age, species, swim, deep } for watched animals
BoxTrace.tBoxed = {}    -- e -> { since, sig, lastStill, facts }
BoxTrace.tSpecies = {}  -- e -> species (per park)
BoxTrace.tHab = {}      -- h -> { aquarium, lake, surface, min, max, at }
BoxTrace.oAPIs = nil
BoxTrace.nLastScan = 0
BoxTrace.nLastTick = nil

local function now()
	local bOk, n = pcall(function()
		return api.time.PerformanceTimeToMilliseconds(api.time.GetPerformanceTimer()) / 1000
	end)
	return bOk and n or 0
end

-- api_:sName(...) or nil; never throws
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

local function round(n, nPlaces)
	if type(n) ~= "number" then
		return nil
	end
	local f = 10 ^ (nPlaces or 1)
	return math.floor(n * f + 0.5) / f
end

local function vec(v)
	if v == nil then
		return nil
	end
	local bOk, x, y, z = pcall(function() return v:GetX(), v:GetY(), v:GetZ() end)
	if bOk and type(x) == "number" then
		return x, y, z
	end
	bOk, x, y, z = pcall(function() return v.x, v.y, v.z end)
	if bOk and type(x) == "number" then
		return x, y, z
	end
	return nil
end

BoxTrace._Log = function(self, sEvent, tData)
	pcall(self.Core.Log, self.Core, "box", sEvent, tData)
end

-----------------------------------------------------------------------
-- Habitats and lakes
-----------------------------------------------------------------------
BoxTrace._HabInfo = function(self, h, nNow)
	if h == nil or h == 0 then
		return nil
	end
	local t = self.tHab[h]
	if t and nNow - t.at < self.nLakeSeconds then
		return t
	end
	local habitat = self.oAPIs.habitat
	local terrain = self.oAPIs.gameterrain
	t = { at = nNow }
	t.aquarium = call(habitat, "IsAquarium", h) == true
	local nLake = nil
	if t.aquarium then
		nLake = call(habitat, "GetAquariumLake", h)
	else
		local tLakes = call(habitat, "GetLakesInHabitat", h)
		if type(tLakes) == "table" then
			t.lakes = #tLakes
			nLake = tLakes[1]
		end
	end
	t.lake = nLake
	if nLake ~= nil then
		t.surface = round(call(terrain, "GetLakeSurfaceLevel", nLake), 2)
		local vMin, vMax = call(terrain, "GetLakeAABB", nLake)
		local x0, y0, z0 = vec(vMin)
		local x1, y1, z1 = vec(vMax)
		if x0 then
			t.min = { x0, y0, z0 }
		end
		if x1 then
			t.max = { x1, y1, z1 }
		end
	end
	self.tHab[h] = t
	return t
end

BoxTrace._HabFacts = function(self, h)
	local habitat = self.oAPIs.habitat
	local boundary = self.oAPIs.habitatboundary
	local t = self.tHab[h] or {}
	return {
		hab = h,
		aquarium = t.aquarium,
		lake = t.lake,
		surface = t.surface,
		lakeMin = t.min and string.format("%.1f/%.1f/%.1f", t.min[1], t.min[2], t.min[3]) or nil,
		lakeMax = t.max and string.format("%.1f/%.1f/%.1f", t.max[1], t.max[2], t.max[3]) or nil,
		broken = call(boundary, "IsBoundaryBroken", h),
		complete = call(habitat, "IsHabitatBoundaryComplete", h),
		gateBelow = t.aquarium and call(habitat, "IsAquariumGateBelowWaterLevel", h) or nil,
	}
end

-----------------------------------------------------------------------
-- Animals
-----------------------------------------------------------------------
-- one position sample: height below the surface, distance inside the
-- lake's bounds (the nearest side, floor and surface counted)
BoxTrace._Sample = function(self, e, tHab, nNow)
	local animals = self.oAPIs.animals
	local nVisual = call(animals, "GetAnimalVisual", e)
	if nVisual == nil then
		return nil
	end
	local oTransform = call(self.oAPIs.transform, "GetTransform", nVisual)
	if oTransform == nil then
		return nil
	end
	local bOk, vPos = pcall(function() return oTransform:GetPos() end)
	local x, y, z = vec(bOk and vPos or nil)
	if x == nil then
		return nil
	end
	self.Core:Checkpoint("boxtrace_sample_ok")
	local s = { t = round(nNow, 1), x = round(x, 1), y = round(y, 2), z = round(z, 1) }
	if tHab and tHab.surface then
		s.below = round(tHab.surface - y, 2)
	end
	if tHab and tHab.min and tHab.max then
		s.floor = round(y - tHab.min[2], 2)
		s.side = round(math.min(x - tHab.min[1], tHab.max[1] - x, z - tHab.min[3], tHab.max[3] - z), 2)
	end
	return s
end

local function trailText(tTrail)
	if not tTrail then
		return nil
	end
	local tParts = {}
	for _, s in ipairs(tTrail) do
		tParts[#tParts + 1] = string.format("%s:%s/%s/%s", tostring(s.t), tostring(s.below or "?"), tostring(s.floor or "?"), tostring(s.side or "?"))
	end
	return table.concat(tParts, " ")
end

BoxTrace._Facts = function(self, e, h)
	local animals = self.oAPIs.animals
	local tTransport = call(animals, "GetAnimalTransportData", e)
	local t = {
		e = e,
		guid = call(animals, "EntityIDToAnimalGUID", e),
		species = self.tSpecies[e],
		gender = call(animals, "GetGender", e),
		age = call(animals, "GetAgeStatus", e),
		lt = call(animals, "GetCurrentLocationType", e),
		assigned = call(animals, "GetAssignedHabitatEntityID", e),
		inHab = call(animals, "IsInHabitat", e),
		escaped = call(animals, "IsEscaped", e),
		reqBox = call(animals, "IsAnimalRequestingBoxed", e),
		reqUnbox = call(animals, "IsAnimalRequestingUnboxed", e),
		claimed = call(animals, "IsBoxingClaimed", e),
		wantsOut = call(animals, "DoesAnimalWantToBeLetOutOfBox", e),
		unboxable = call(animals, "IsAnimalUnboxableByPlayer", e),
		navWait = call(animals, "IsBoxWaitingForNavMeshRebuild", e),
		animating = call(animals, "IsAnimalInBoxAndBoxAnimating", e),
		tranq = call(animals, "IsTranquillized", e),
		swim = call(animals, "DoesAnimalSwim", e),
		deep = call(animals, "DoesAnimalDeepSwim", e),
		depthReq = call(animals, "GetAnimalDepthRequirement", e),
		job = type(tTransport) == "table" and tTransport.bHasTransportJob or nil,
		jobTarget = type(tTransport) == "table" and tTransport.nTransportTargetEntity or nil,
		carried = type(tTransport) == "table" and tTransport.bIsBeingCarried or nil,
	}
	local w = self.tWatch[e]
	if w then
		t.ageChangedAgo = w.ageChangedAt and round(now() - w.ageChangedAt, 0) or nil
		t.trail = trailText(w.trail)
	end
	if h ~= nil then
		for k, v in pairs(self:_HabFacts(h)) do
			t[k] = v
		end
	end
	return t
end

-- the reads that matter for "why is it still boxed"
local function signature(t)
	return table.concat({
		tostring(t.lt), tostring(t.reqBox), tostring(t.reqUnbox), tostring(t.claimed),
		tostring(t.wantsOut), tostring(t.unboxable), tostring(t.navWait), tostring(t.job),
		tostring(t.inHab), tostring(t.escaped),
	}, ",")
end

BoxTrace._Animal = function(self, e, h, nNow)
	local animals = self.oAPIs.animals
	if self.tSpecies[e] == nil then
		self.tSpecies[e] = call(animals, "GetSpecies", e) or "?"
	end
	local tHab = self:_HabInfo(h, nNow)
	-- watch aquarium animals, and swimmers in a habitat with water
	local w = self.tWatch[e]
	if w == nil and tHab and (tHab.aquarium or (tHab.lake ~= nil and (call(animals, "DoesAnimalSwim", e) == true or call(animals, "DoesAnimalDeepSwim", e) == true))) then
		w = { trail = {} }
		self.tWatch[e] = w
	end
	local bBoxed = call(animals, "IsAnimalBoxed", e) == true
	if w then
		if not bBoxed and self.bSamplePositions then
			local s = self:_Sample(e, tHab, nNow)
			if s then
				local tTrail = w.trail
				tTrail[#tTrail + 1] = s
				if #tTrail > self.nTrail then
					table.remove(tTrail, 1)
				end
			end
		end
		local nAge = call(animals, "GetAgeStatus", e)
		if w.age ~= nil and nAge ~= w.age then
			w.ageChangedAt = nNow
			self:_Log("age", { e = e, species = self.tSpecies[e], from = w.age, to = nAge, hab = h, aquarium = tHab and tHab.aquarium })
		end
		w.age = nAge
	end
	local b = self.tBoxed[e]
	if bBoxed then
		local tFacts = self:_Facts(e, h)
		local sSig = signature(tFacts)
		if b == nil then
			self.tBoxed[e] = { since = nNow, sig = sSig, lastStill = nNow, facts = tFacts }
			self:_Log("start", tFacts)
		elseif b.sig ~= sSig then
			tFacts.boxedFor = round(nNow - b.since, 0)
			tFacts.trail = nil
			b.sig = sSig
			b.facts = tFacts
			self:_Log("change", tFacts)
		elseif nNow - b.lastStill >= self.nStillSeconds then
			b.lastStill = nNow
			self:_Log("still", { e = e, species = self.tSpecies[e], hab = h, boxedFor = round(nNow - b.since, 0), sig = sSig })
		end
	elseif b ~= nil then
		self.tBoxed[e] = nil
		local tFacts = self:_Facts(e, h)
		tFacts.trail = nil
		tFacts.boxedFor = round(nNow - b.since, 0)
		tFacts.lastSig = b.sig
		self:_Log("end", tFacts)
		if w then
			w.trail = {}
		end
	end
end

BoxTrace._Scan = function(self, nNow)
	local habitat = self.oAPIs.habitat
	local tHabitats = call(habitat, "GetHabitats")
	if type(tHabitats) ~= "table" then
		return
	end
	local tSeen = {}
	for _, h in ipairs(tHabitats) do
		local tAnimals = call(habitat, "GetAnimalsInHabitat", h)
		if type(tAnimals) == "table" then
			for _, e in ipairs(tAnimals) do
				if not tSeen[e] then
					tSeen[e] = true
					pcall(self._Animal, self, e, h, nNow)
				end
			end
		end
	end
	-- boxed animals no habitat lists any more (moved, sold, died): close them
	-- without asking the game about them. Reading IsAnimalBoxed for such an
	-- animal crashed the game (access violation in fTask, Y: 2026-10-19 15:24).
	for e, b in pairs(self.tBoxed) do
		if not tSeen[e] then
			self.tBoxed[e] = nil
			self:_Log("end", { e = e, species = self.tSpecies[e], boxedFor = round(nNow - b.since, 0), lastSig = b.sig, gone = true })
		end
	end
	for e in pairs(self.tWatch) do
		if not tSeen[e] then
			self.tWatch[e] = nil
		end
	end
end

-----------------------------------------------------------------------
-- Park open
-----------------------------------------------------------------------
BoxTrace._ParkOpened = function(self, nNow)
	self.tWatch = {}
	self.tBoxed = {}
	self.tSpecies = {}
	self.tHab = {}
	local nAquariums, nWater = 0, 0
	local tHabitats = call(self.oAPIs.habitat, "GetHabitats")
	if type(tHabitats) == "table" then
		for _, h in ipairs(tHabitats) do
			local t = self:_HabInfo(h, nNow)
			if t and (t.aquarium or t.lake ~= nil) then
				if t.aquarium then
					nAquariums = nAquariums + 1
				else
					nWater = nWater + 1
				end
				local tAnimals = call(self.oAPIs.habitat, "GetAnimalsInHabitat", h)
				local tFacts = self:_HabFacts(h)
				tFacts.animals = type(tAnimals) == "table" and #tAnimals or nil
				tFacts.lakes = t.lakes
				self:_Log("hab", tFacts)
			end
		end
	end
	self:_Log("park", {
		aquariums = nAquariums,
		waterHabs = nWater,
		oldMesh = call(self.oAPIs.navigationworld, "LoadedOldMesh"),
		parkBoxed = call(self.oAPIs.animals, "ParkContainsBoxedAnimals"),
	})
end

-----------------------------------------------------------------------
-- Tick
-----------------------------------------------------------------------
BoxTrace.Tick = function(self, oManager)
	local nNow = now()
	local oAPIs = oManager and oManager.tWorldAPIs
	if type(oAPIs) ~= "table" then
		local bOk, t = pcall(function() return api.world.GetWorldAPIs() end)
		oAPIs = bOk and t or nil
	end
	if type(oAPIs) ~= "table" or oAPIs.animals == nil or oAPIs.habitat == nil then
		return
	end
	-- a new park (or back from the hub after a long gap): start over
	local bNewPark = self.oAPIs == nil or oAPIs.animals ~= self.oAPIs.animals
	self.oAPIs = oAPIs
	if not self.bAnnounced then
		self.bAnnounced = true
		self:_Log("on", { scan = self.nScanSeconds })
	end
	if bNewPark or self.nLastTick == nil or nNow - self.nLastTick > 30 then
		self.nLastTick = nNow
		self.Core:Checkpoint("boxtrace_park_begin")
		self:_ParkOpened(nNow)
		self.Core:Checkpoint("boxtrace_park_done")
		self.nLastScan = nNow
		return
	end
	self.nLastTick = nNow
	if nNow - self.nLastScan < self.nScanSeconds then
		return
	end
	self.nLastScan = nNow
	self.Core:Checkpoint("boxtrace_scan_begin")
	self:_Scan(nNow)
	self.Core:Checkpoint("boxtrace_scan_done")
end

BoxTrace._PatchHeatMapManager = function(self, HeatMapManager)
	local fnAdvance = HeatMapManager.Advance
	if type(fnAdvance) ~= "function" then
		self:_Log("off", { why = "noAdvance" })
		return
	end
	HeatMapManager.Advance = function(oManager, ...)
		local bOk, sErr = pcall(self.Tick, self, oManager)
		if not bOk and not self.bTickErrorLogged then
			self.bTickErrorLogged = true
			self:_Log("error", { err = tostring(sErr) })
		end
		return fnAdvance(oManager, ...)
	end
end

-- Init only patches the park tick (see the header on message receivers).
BoxTrace.Init = function(self, Core)
	self.Core = Core
	if not Core.bTrace then
		return
	end
	Core:Checkpoint("boxtrace_init")
	Core:AddModulePatch("Managers.HeatMapManager", function(t) self:_PatchHeatMapManager(t) end)
	Core:Checkpoint("boxtrace_patched")
end
