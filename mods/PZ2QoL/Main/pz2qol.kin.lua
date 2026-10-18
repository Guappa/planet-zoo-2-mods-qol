-----------------------------------------------------------------------
--  PZ2QoL.Kin
--
--  Collects what the page needs to show relatedness and inbreeding risk:
--  for every animal its lineage (parents, via the game's own
--  animals:GetParents), habitat, sex, age, contraception, fertility,
--  current mates and alleles. The page (kin.js / kincore.js) works out
--  relations, risk and offspring genetics; this side only reads.
--
--  In the park the scan runs a few dozen animals per frame (driven by the
--  heat map manager's Advance, which runs every frame in a park), or all at
--  once if no frame hook is available. Lineage and genes never change, so
--  they are cached per animal. The result goes to the page as one JSON
--  string, split into chunks (PZ2QoL_KinChunk) so no single event is large.
--
--  In the hub, Animal Storage asks for the lineage of the stored animals
--  it shows (PZ2QoL_KinStorage), resolved through the storage hub mode's
--  background world, the same way the game's Compare Mates does it there.
--
--  Actions, each started by one click in the page and doing exactly what
--  the game's own buttons do:
--    PZ2QoL_KinContracept(id, on)  animals:SetUsingContraceptive (the
--                                  management list's own toggle)
--    PZ2QoL_KinLocate(id)          camera orbit + info panel (the
--                                  management list's own "locate")
--    PZ2QoL_KinHeatmap(on)         the game's own InbreedingRisk heat map
--    PZ2QoL_KinMove(req, id, to)   ONE animal to a habitat or the trade
--                                  centre, the game's own Move sequence
--                                  (AnimalMovementEditMode): checks, box
--                                  claim, AttemptRequestToTransportAnimalToTarget
--  and one query: PZ2QoL_KinDestinations(req, ids), the habitats the game
--  allows for those animals' species (IsValidHabitatForAnimalsGUID ...).
-----------------------------------------------------------------------
local global   = _G
local api      = global.api
local pcall    = global.pcall
local tostring = global.tostring
local tonumber = global.tonumber
local type     = global.type
local pairs    = global.pairs
local ipairs   = global.ipairs
local string   = global.string
local table    = global.table
local math     = global.math

local Kin = module(...)

Kin.nVersion = 1
Kin.nPerFrame = 40          -- animals per frame while ticking
Kin.nBondPerFrame = 200     -- GetMatingMonogamyIcon calls per frame (bond pass)
Kin.nBatch = 50             -- ids per GetUIAnimalListDataForIDs call (the game uses 50)
Kin.nChunkSize = 12000      -- characters per PZ2QoL_KinChunk event
Kin.nAncestorDepth = 4      -- generations above an absent parent
Kin.nTickFresh = 1.0        -- seconds: the frame hook counts as alive
Kin.nJobTimeout = 20        -- seconds: an unfinished job is dropped

Kin.tStatic = {}            -- entity key -> { sGuid, tPar, tGenes }
Kin.tAncestors = {}         -- guid -> { parent guids } or false
Kin.tViews = global.setmetatable({}, { __mode = "k" })
Kin.tLastSent = global.setmetatable({}, { __mode = "k" })
Kin.nSeq = 0
Kin.tJob = nil
Kin.nLastTick = nil
Kin.oHeatMapManager = nil
Kin.oStorageMode = nil

local function trace(sMsg)
	pcall(function() api.debug.Trace("[PZ2QoL] kin: " .. sMsg) end)
end

local function mark(sName)
	local Core = global.package.loaded["pz2qol.core"]
	if Core then
		Core:Mark(sName)
	end
end

local function now()
	local bOk, n = pcall(function()
		return api.time.PerformanceTimeToMilliseconds(api.time.GetPerformanceTimer()) / 1000
	end)
	return bOk and n or 0
end

-----------------------------------------------------------------------
-- JSON (ASCII only, so the string can be cut anywhere)
-----------------------------------------------------------------------
local ARRAY = {}
local function array(t)
	return global.setmetatable(t or {}, ARRAY)
end
Kin.Array = array

local tEscapes = { ['"'] = '\\"', ["\\"] = "\\\\", ["\b"] = "\\b", ["\f"] = "\\f", ["\n"] = "\\n", ["\r"] = "\\r", ["\t"] = "\\t" }

local function encodeString(s)
	s = tostring(s)
	-- most strings (keys, ids, allele letters) need no escaping at all
	if not string.find(s, '[%c"\\\128-\255]') then
		return '"' .. s .. '"'
	end
	local tOut = {}
	local bOk = pcall(function()
		for _, c in global.utf8.codes(s) do
			if c < 32 then
				tOut[#tOut + 1] = string.format("\\u%04x", c)
			elseif c < 128 then
				local ch = string.char(c)
				tOut[#tOut + 1] = tEscapes[ch] or ch
			elseif c < 0x10000 then
				tOut[#tOut + 1] = string.format("\\u%04x", c)
			else
				c = c - 0x10000
				tOut[#tOut + 1] = string.format("\\u%04x\\u%04x", 0xD800 + (c >> 10), 0xDC00 + (c & 0x3FF))
			end
		end
	end)
	if not bOk then
		-- not valid UTF-8 (or no utf8 library): keep printable ASCII only
		tOut = {}
		for i = 1, #s do
			local b = string.byte(s, i)
			local ch = string.char(b)
			if b < 32 or b > 126 then
				tOut[#tOut + 1] = "?"
			else
				tOut[#tOut + 1] = tEscapes[ch] or ch
			end
		end
	end
	return '"' .. table.concat(tOut) .. '"'
end

local encode
encode = function(v, tOut)
	local t = type(v)
	if v == nil then
		tOut[#tOut + 1] = "null"
	elseif t == "boolean" then
		tOut[#tOut + 1] = v and "true" or "false"
	elseif t == "number" then
		if v ~= v or v == math.huge or v == -math.huge then
			tOut[#tOut + 1] = "null"
		elseif math.type and math.type(v) == "integer" then
			tOut[#tOut + 1] = string.format("%d", v)
		else
			tOut[#tOut + 1] = string.format("%.6g", v)
		end
	elseif t == "string" then
		tOut[#tOut + 1] = encodeString(v)
	elseif t == "table" then
		if global.getmetatable(v) == ARRAY or (#v > 0 and v[1] ~= nil) then
			tOut[#tOut + 1] = "["
			for i = 1, #v do
				if i > 1 then tOut[#tOut + 1] = "," end
				encode(v[i], tOut)
			end
			tOut[#tOut + 1] = "]"
		else
			tOut[#tOut + 1] = "{"
			local bFirst = true
			for k, x in pairs(v) do
				if x ~= nil then
					if not bFirst then tOut[#tOut + 1] = "," end
					bFirst = false
					tOut[#tOut + 1] = encodeString(k)
					tOut[#tOut + 1] = ":"
					encode(x, tOut)
				end
			end
			tOut[#tOut + 1] = "}"
		end
	else
		tOut[#tOut + 1] = "null"
	end
end

Kin.Encode = function(v)
	local tOut = {}
	encode(v, tOut)
	return table.concat(tOut)
end

-----------------------------------------------------------------------
-- Helpers over the game's APIs
-----------------------------------------------------------------------
local function known(g)
	return g ~= nil and g ~= "" and g ~= 0 and g ~= "0"
end

-- Ids as strings, the same way everywhere: an integer-valued float
-- (77.0) prints like the integer (77), so ids from different APIs match.
local function idString(n)
	if type(n) == "number" and math.type and math.type(n) == "float" and n == math.floor(n) and math.abs(n) < 2 ^ 63 then
		return string.format("%d", n)
	end
	return tostring(n)
end
Kin.IdString = idString

local function guidString(g)
	if not known(g) then
		return ""
	end
	return idString(g)
end

-- {g1, g2} from whatever GetParents returns.
local function parentList(t, fnMap)
	local out = array()
	if type(t) ~= "table" then
		return out
	end
	for _, g in pairs(t) do
		if known(g) then
			out[#out + 1] = fnMap and fnMap(g) or guidString(g)
		end
	end
	table.sort(out)
	return out
end

-- Alleles of one stat as a 12 character string (or dotted when an allele
-- is longer than one character).
local function alleleString(t)
	if type(t) ~= "table" then
		return nil
	end
	local tParts = {}
	local bSingle = true
	for i = 1, 12 do
		local a = t[i]
		if a == nil then
			return nil
		end
		a = tostring(a)
		if #a ~= 1 then
			bSingle = false
		end
		tParts[i] = a
	end
	return table.concat(tParts, bSingle and "" or ".")
end

local function geneStrings(t)
	if type(t) ~= "table" then
		return nil
	end
	local tOut = {
		F = alleleString(t.tFertility),
		I = alleleString(t.tImmunity),
		S = alleleString(t.tSize),
		L = alleleString(t.tLongevity),
	}
	if tOut.F == nil and tOut.I == nil and tOut.S == nil and tOut.L == nil then
		return nil
	end
	return tOut
end

-- The park's world APIs, but ONLY while a park is really running: its heat
-- map manager exists (it is a park-only manager) and ticked within the last
-- second. Per-world APIs called in another world (the intro sequence, the
-- start screen) can crash natively, which pcall cannot catch (seen in game:
-- exhibits:GetAllAnimalIDs during the intro, 2026-10-15).
Kin._ParkWorld = function(self)
	local oHM = self.oHeatMapManager
	if oHM == nil or self.nLastTick == nil or now() - self.nLastTick > self.nTickFresh then
		return nil
	end
	local t = oHM.tWorldAPIs
	if type(t) ~= "table" then
		return nil
	end
	mark("kin_park_world")
	return t
end

Kin._ParkAPIs = function(self)
	local t = self:_ParkWorld()
	if t == nil or type(t.animals) ~= "table" and type(t.animals) ~= "userdata" then
		return nil
	end
	if t.habitat == nil then
		return nil
	end
	local bOk, tHabitats = pcall(function() return t.habitat:GetHabitats() end)
	if not bOk or type(tHabitats) ~= "table" then
		return nil
	end
	return t, tHabitats
end

-----------------------------------------------------------------------
-- Sending
-----------------------------------------------------------------------
Kin._SendState = function(self, oUI, sState, sDetail)
	if oUI ~= nil then
		pcall(oUI.TriggerEventAtNextAdvance, oUI, "PZ2QoL_KinState", sState, sDetail or "")
	end
end

Kin._SendSnapshot = function(self, oUI, tSnapshot)
	if oUI == nil then
		return
	end
	local sJson = Kin.Encode(tSnapshot)
	local sKey = tSnapshot.scope or "park"
	local tLast = self.tLastSent[oUI]
	-- the seq number differs every time; compare without it
	local sBody = string.gsub(sJson, '"seq":%d+,?', "", 1)
	if tLast ~= nil and tLast[sKey] == sBody then
		return self:_SendState(oUI, "same", sKey)
	end
	self.tLastSent[oUI] = tLast or {}
	self.tLastSent[oUI][sKey] = sBody
	local nParts = math.max(1, math.ceil(#sJson / self.nChunkSize))
	for i = 1, nParts do
		local sPart = string.sub(sJson, (i - 1) * self.nChunkSize + 1, i * self.nChunkSize)
		pcall(oUI.TriggerEventAtNextAdvance, oUI, "PZ2QoL_KinChunk", tSnapshot.seq, i, nParts, sPart)
	end
	mark("kin_sent")
end

-----------------------------------------------------------------------
-- Park scan
-----------------------------------------------------------------------
Kin._Static = function(self, animals, nEntity)
	local sKey = idString(nEntity)
	local bOk, guid = pcall(animals.EntityIDToAnimalGUID, animals, nEntity)
	local sGuid = bOk and guidString(guid) or ""
	local t = self.tStatic[sKey]
	if t ~= nil and t.sGuid == sGuid then
		return t
	end
	t = { sGuid = sGuid, tPar = array() }
	if sGuid ~= "" then
		local bP, tPar = pcall(animals.GetParents, animals, guid)
		if bP then
			t.tPar = parentList(tPar)
		end
	end
	local bG, tGenes = pcall(animals.GetGenes, animals, nEntity)
	if bG then
		t.tGenes = geneStrings(tGenes)
	end
	self.tStatic[sKey] = t
	return t
end

-- The animal's mates (ids), whether its species is monogamous, and the
-- first mate's entity: for a monogamous animal that is its bonded mate, the
-- one the info panel shows (it may be dead, moved or gone: the bond outlives
-- it while the animal mourns, AnimalInfoPopUp._UpdateBondedMateData).
local function mateIds(animals, nEntity)
	local out = array()
	local bMono, nFirst = false, nil
	local bOk, t = pcall(animals.GetMateData, animals, nEntity)
	if bOk and type(t) == "table" and not t.bIsBeta and type(t.tMateData) == "table" then
		bMono = t.bIsMonogamous == true
		for _, m in ipairs(t.tMateData) do
			if m.nID ~= nil then
				out[#out + 1] = idString(m.nID)
				if nFirst == nil then
					nFirst = m.nID
				end
			end
		end
	end
	return out, bMono, nFirst
end

Kin._StartPark = function(self, oUI, sReason)
	local tAPIs, tHabitats = self:_ParkAPIs()
	if tAPIs == nil then
		return self:_SendState(oUI, "nopark", "")
	end
	local animals = tAPIs.animals
	local habitat = tAPIs.habitat
	local tHabOf = {}
	local tIDs = {}
	local tSeen = {}
	local tAllHabs = {}
	for _, h in ipairs(tHabitats) do
		local bIs = true
		pcall(function() bIs = habitat:IsHabitat(h) ~= false end)
		if bIs then
			tAllHabs[#tAllHabs + 1] = h
			local bOk, tMembers = pcall(habitat.GetAnimalsInHabitat, habitat, h)
			if bOk and type(tMembers) == "table" then
				for _, e in ipairs(tMembers) do
					tHabOf[e] = h
					if not tSeen[e] then
						tSeen[e] = true
						tIDs[#tIDs + 1] = e
					end
				end
			end
		end
	end
	-- animals outside habitats too (trade centre, transit): they count
	-- for lineage, just not as pairs
	pcall(function()
		local helpers = tAPIs.animalsDataHelpers
		local tAll = helpers:GetAllAnimalEntities(helpers.AnimalListType_Habitat)
		for _, e in ipairs(tAll) do
			if not tSeen[e] then
				tSeen[e] = true
				tIDs[#tIDs + 1] = e
			end
		end
	end)
	-- animals waiting at the trade centre (bought, returned from storage, sent
	-- there) are NOT in the Habitat list; the game reads this second list for
	-- them (helpers.notificationtasks CheckNoStaffForDelivery)
	pcall(function()
		local helpers = tAPIs.animalsDataHelpers
		local nList = helpers.AnimalListType_HabitatInTradeCenterWithEntities
		if nList == nil then
			return
		end
		for _, e in ipairs(helpers:GetAllAnimalEntities(nList)) do
			if not tSeen[e] then
				tSeen[e] = true
				tIDs[#tIDs + 1] = e
			end
		end
	end)
	local tExhibitIDs = {}
	pcall(function()
		local tAll = tAPIs.exhibits:GetAllAnimalIDs()
		for _, uid in ipairs(tAll) do
			tExhibitIDs[#tExhibitIDs + 1] = uid
		end
	end)
	self.nSeq = self.nSeq + 1
	local nJuvenile = nil
	pcall(function() nJuvenile = animals.Juvenile end)
	self.tJob = {
		oUI = oUI,
		sReason = sReason,
		nSeq = self.nSeq,
		nStarted = now(),
		tAPIs = tAPIs,
		nJuvenile = nJuvenile,
		tHabOf = tHabOf,
		tAllHabs = tAllHabs,
		tIDs = tIDs,
		nIndex = 0,
		tExhibitIDs = tExhibitIDs,
		nExhibitIndex = 0,
		tAnimals = array(),
		tHabitatNames = {},
		tHabitatOrder = {},
		tExhibitNames = {},
		tPresent = {},
		tAdults = {},     -- { tRec, e }: adults in habitats (bond pass candidates)
		tBonded = {},     -- { tRec, e, nMate }: monogamous adults with a mate
	}
	mark("kin_scan_start")
end

Kin._HabitatName = function(self, tJob, h, sLocation)
	if h == nil or tJob.tHabitatNames[h] ~= nil then
		return
	end
	if type(sLocation) == "string" and sLocation ~= "" then
		tJob.tHabitatNames[h] = sLocation
		tJob.tHabitatOrder[#tJob.tHabitatOrder + 1] = h
	end
end

-- Processes up to nBudget animals. Returns true when the job is done.
Kin._Step = function(self, nBudget)
	local tJob = self.tJob
	local animals = tJob.tAPIs.animals
	local nDone = 0
	while nDone < nBudget and tJob.nIndex < #tJob.tIDs do
		local tSlice = {}
		for i = tJob.nIndex + 1, math.min(#tJob.tIDs, tJob.nIndex + self.nBatch, tJob.nIndex + (nBudget - nDone)) do
			tSlice[#tSlice + 1] = tJob.tIDs[i]
		end
		tJob.nIndex = tJob.nIndex + #tSlice
		nDone = nDone + #tSlice
		local bOk, tData = pcall(animals.GetUIAnimalListDataForIDs, animals, tSlice)
		if not bOk or type(tData) ~= "table" then
			-- one bad id must not hide the other 49 (they would come back as
			-- "new" risks on the next scan): ask one by one
			tData = {}
			for _, e in ipairs(tSlice) do
				local bOne, tOne = pcall(animals.GetUIAnimalListDataForIDs, animals, { e })
				if bOne and type(tOne) == "table" then
					tData[e] = tOne[e]
				end
			end
		end
		for _, e in ipairs(tSlice) do
			local t = tData[e]
			if type(t) == "table" and t.bAlive ~= false then
				self:_AddParkAnimal(tJob, animals, e, t)
			end
		end
	end
	local exhibits = tJob.tAPIs.exhibits
	while nDone < nBudget and tJob.nExhibitIndex < #tJob.tExhibitIDs do
		local tSlice = {}
		for i = tJob.nExhibitIndex + 1, math.min(#tJob.tExhibitIDs, tJob.nExhibitIndex + self.nBatch) do
			tSlice[#tSlice + 1] = tJob.tExhibitIDs[i]
		end
		tJob.nExhibitIndex = tJob.nExhibitIndex + #tSlice
		nDone = nDone + #tSlice
		local bOk, tData = pcall(exhibits.GetUIAnimalListDataForIDs, exhibits, tSlice)
		if bOk and type(tData) == "table" then
			for _, uid in ipairs(tSlice) do
				local t = tData[uid]
				if type(t) == "table" and t.bAlive ~= false then
					self:_AddExhibitAnimal(tJob, exhibits, uid, t)
				end
			end
		end
	end
	if tJob.nIndex < #tJob.tIDs or tJob.nExhibitIndex < #tJob.tExhibitIDs then
		return false
	end
	-- the bond pass never costs the scan: on an error, no bond data at all
	local bOk, bDone = pcall(self._BondStep, self, tJob, animals, self.nBondPerFrame)
	if not bOk then
		trace("bond pass failed: " .. tostring(bDone))
		tJob.bBondsOk = false
		for _, b in ipairs(tJob.tBonded) do
			b.tRec.bond = nil
		end
		return true
	end
	return bDone
end

-- The bond pass, after every animal is read. For each monogamous adult with
-- a mate, the game's own monogamy check against every other adult of its
-- species in its habitat: animals:GetMatingMonogamyIcon(self, other, 0) is
-- "ring" for its mate and "IconLock" when it has an existing mate (Compare
-- Mates: either way means no conception). The page holds a related pair
-- apart only on such a lock (kincore bondHold). Returns true when done.
local function compatibleSexes(a, b)
	return a.sex == 2 or b.sex == 2 or a.sex ~= b.sex
end

Kin._BondStep = function(self, tJob, animals, nBudget)
	if tJob.tBondJobs == nil then
		tJob.tBondJobs = {}
		tJob.nBondJob, tJob.nBondCand = 1, 0
		tJob.nBondCalls, tJob.nBondFails = 0, 0
		tJob.bBondsOk = true
		local bHas = false
		pcall(function() bHas = animals.GetMatingMonogamyIcon ~= nil end)
		if not bHas then
			tJob.bBondsOk = false
			return true
		end
		local tGroups = {}
		for _, x in ipairs(tJob.tAdults) do
			local sKey = tostring(x.tRec.hab) .. "|" .. tostring(x.tRec.species)
			tGroups[sKey] = tGroups[sKey] or {}
			local tList = tGroups[sKey]
			tList[#tList + 1] = x
		end
		for _, b in ipairs(tJob.tBonded) do
			local sMate = idString(b.nMate)
			local tCands = {}
			for _, o in ipairs(tGroups[tostring(b.tRec.hab) .. "|" .. tostring(b.tRec.species)] or {}) do
				if o.e ~= b.e and o.tRec.id ~= sMate and compatibleSexes(b.tRec, o.tRec) then
					tCands[#tCands + 1] = o
				end
			end
			b.tRec.bond = { mate = sMate, ring = false, lock = array() }
			tJob.tBondJobs[#tJob.tBondJobs + 1] = { b = b, tCands = tCands }
		end
	end
	local nDone = 0
	local function icon(e, nOther)
		tJob.nBondCalls = tJob.nBondCalls + 1
		local bOk, s = pcall(animals.GetMatingMonogamyIcon, animals, e, nOther, 0)
		if not bOk then
			tJob.nBondFails = tJob.nBondFails + 1
			return nil
		end
		return s
	end
	while nDone < nBudget and tJob.nBondJob <= #tJob.tBondJobs do
		local job = tJob.tBondJobs[tJob.nBondJob]
		local b = job.b
		if tJob.nBondCand == 0 then
			b.tRec.bond.ring = icon(b.e, b.nMate) == "ring"
			-- the mate still belongs to this habitat (alive, same assigned habitat),
			-- even while it is at the vet or in transport and so in no habitat list
			local bHere = false
			pcall(function()
				local hSelf = animals:GetAssignedHabitatEntityID(b.e)
				local hMate = animals:GetAssignedHabitatEntityID(b.nMate)
				bHere = hSelf ~= nil and hSelf == hMate and animals:IsInDeathState(b.nMate) ~= true
			end)
			b.tRec.bond.here = bHere
			local bOk, _, nMourn = pcall(animals.GetCurrentMournTimeForUI, animals, b.e)
			if bOk and type(nMourn) == "number" and nMourn > 0 then
				b.tRec.bond.mourn = nMourn
			end
			nDone = nDone + 1
			tJob.nBondCand = 1
		end
		while nDone < nBudget and tJob.nBondCand <= #job.tCands do
			local o = job.tCands[tJob.nBondCand]
			-- a failed call is not a lock: the pair stays a risk
			if icon(b.e, o.e) == "IconLock" then
				local tLock = b.tRec.bond.lock
				tLock[#tLock + 1] = o.tRec.id
			end
			nDone = nDone + 1
			tJob.nBondCand = tJob.nBondCand + 1
		end
		if tJob.nBondCand > #job.tCands then
			tJob.nBondJob = tJob.nBondJob + 1
			tJob.nBondCand = 0
		end
	end
	if tJob.nBondJob <= #tJob.tBondJobs then
		return false
	end
	-- every call failed: the game's check is not there (a patch?). No bond
	-- data at all then, so nothing is held and nothing looks like a broken bond
	if tJob.nBondCalls > 0 and tJob.nBondFails >= tJob.nBondCalls then
		tJob.bBondsOk = false
	end
	if not tJob.bBondsOk then
		for _, b in ipairs(tJob.tBonded) do
			b.tRec.bond = nil
		end
	end
	return true
end

-- 'habitat' | 'trade' | 'transit' | 'quarantine' | 'vet' | 'escaped' | 'other'
local function locationKind(animals, t)
	local n = t.nLocationType
	if n == nil then
		return "other"
	end
	local tKinds = {
		{ "CurrentLocationType_Habitat", "habitat" }, { "CurrentLocationType_TradeCentre", "trade" },
		{ "CurrentLocationType_VetSurgery", "vet" }, { "CurrentLocationType_Quarantine", "quarantine" },
		{ "CurrentLocationType_FreeRoaming", "escaped" }, { "CurrentLocationType_BeingCarried", "transit" },
	}
	for _, k in ipairs(tKinds) do
		local bOk, v = pcall(function() return animals[k[1]] end)
		if bOk and v ~= nil and v == n then
			return k[2]
		end
	end
	return "other"
end

-- the game's age quarter for the UI: 0 child, 1 young adult, 2 adult, 3 elderly
local function ageQuarter(animals, e)
	local bOk, n = pcall(animals.GetAgeQuarterForUI, animals, e)
	return bOk and type(n) == "number" and n or nil
end

local function hasTransportJob(animals, e)
	local bOk, t = pcall(animals.GetAnimalTransportData, animals, e)
	return bOk and type(t) == "table" and t.bHasTransportJob == true
end

Kin._AddParkAnimal = function(self, tJob, animals, e, t)
	local tStatic = self:_Static(animals, e)
	local h = tJob.tHabOf[e]
	self:_HabitatName(tJob, h, t.sLocation)
	local bJuvenile = tJob.nJuvenile ~= nil and t.nAgeGroup == tJob.nJuvenile
	local tRec = {
		id = idString(e),
		key = "animal_" .. idString(e),
		guid = tStatic.sGuid,
		name = t.sName,
		species = t.sSpecies,
		sex = t.nGender,
		juv = bJuvenile,
		contra = t.bIsUsingContraceptive == true,
		infertile = t.bIsInfertile == true,
		preg = t.bPregnant == true,
		alpha = t.bAlpha == true,
		age = type(t.nAge) == "number" and t.nAge or nil,
		ageQ = ageQuarter(animals, e),
		lt = h ~= nil and "habitat" or locationKind(animals, t),
		moving = hasTransportJob(animals, e),
		hab = h ~= nil and idString(h) or "",
		loc = type(t.sLocation) == "string" and t.sLocation or "",
		par = tStatic.tPar,
		genes = tStatic.tGenes,
	}
	if h ~= nil and not bJuvenile then
		local bMono, nMate
		tRec.mates, bMono, nMate = mateIds(animals, e)
		tJob.tAdults[#tJob.tAdults + 1] = { tRec = tRec, e = e }
		if bMono and nMate ~= nil then
			tJob.tBonded[#tJob.tBonded + 1] = { tRec = tRec, e = e, nMate = nMate }
		end
	end
	tJob.tAnimals[#tJob.tAnimals + 1] = tRec
	if tStatic.sGuid ~= "" then
		tJob.tPresent[tStatic.sGuid] = true
	end
end

Kin._AddExhibitAnimal = function(self, tJob, exhibits, uid, t)
	local sKey = "x" .. idString(uid)
	local tStatic = self.tStatic[sKey]
	if tStatic == nil then
		tStatic = { sGuid = sKey, tPar = array() }
		for i = 0, 1 do
			local bOk, p = pcall(exhibits.GetAnimalFamilyMemberUID, exhibits, uid, i)
			if bOk and known(p) then
				tStatic.tPar[#tStatic.tPar + 1] = "x" .. idString(p)
			end
		end
		table.sort(tStatic.tPar)
		local bG, tGenes = pcall(exhibits.GetMarketAnimalGenes, exhibits, uid, 4)
		if bG then
			tStatic.tGenes = geneStrings(tGenes)
		end
		self.tStatic[sKey] = tStatic
	end
	local sLocation = type(t.sLocation) == "string" and t.sLocation or ""
	-- the exhibit itself (two exhibits may share a name); its name as a fallback
	local sHab = ""
	pcall(function()
		local nEntity = exhibits:ExhibitAnimalUIDToEntityID(uid)
		local nExhibit = nEntity and exhibits:GetAnimalParentExhibit(nEntity)
		if known(nExhibit) then
			sHab = "xe:" .. idString(nExhibit)
		end
	end)
	if sHab == "" and sLocation ~= "" then
		sHab = "xh:" .. sLocation
	end
	if sHab ~= "" and tJob.tExhibitNames[sHab] == nil then
		tJob.tExhibitNames[sHab] = sLocation
		tJob.tHabitatOrder[#tJob.tHabitatOrder + 1] = sHab
	end
	local bJuvenile = tJob.nJuvenile ~= nil and t.nAgeGroup == tJob.nJuvenile
	tJob.tAnimals[#tJob.tAnimals + 1] = {
		id = sKey,
		key = "exhibit_animal_" .. idString(uid),
		guid = sKey,
		name = t.sName,
		species = t.sSpecies,
		sex = t.nGender,
		juv = bJuvenile,
		contra = t.bIsUsingContraceptive == true,
		infertile = t.bIsInfertile == true,
		preg = t.bPregnant == true,
		hab = sHab,
		loc = sLocation,
		exhibit = true,
		par = tStatic.tPar,
		genes = tStatic.tGenes,
	}
	tJob.tPresent[sKey] = true
end

-- Parents of ancestors who are not in the zoo, a few generations up. Uses
-- fnParents(guid) -> list, cached per guid.
Kin._Ancestors = function(self, tAnimals, tPresent, fnParents)
	local tAnc = {}
	local tFrontier = {}
	for _, a in ipairs(tAnimals) do
		for _, p in ipairs(a.par or {}) do
			if not tPresent[p] and tAnc[p] == nil then
				tAnc[p] = false
				tFrontier[#tFrontier + 1] = p
			end
		end
	end
	for _ = 1, self.nAncestorDepth do
		local tNext = {}
		for _, g in ipairs(tFrontier) do
			local tPar = self.tAncestors[g]
			if tPar == nil then
				tPar = fnParents(g) or false
				self.tAncestors[g] = tPar
			end
			-- a lookup that failed is left out (unknown), not sent as "no parents"
			tAnc[g] = tPar or false
			if tPar then
				for _, p in ipairs(tPar) do
					if not tPresent[p] and tAnc[p] == nil then
						tAnc[p] = false
						tNext[#tNext + 1] = p
					end
				end
			end
		end
		tFrontier = tNext
		if #tFrontier == 0 then
			break
		end
	end
	for g, v in pairs(tAnc) do
		if v == false then
			tAnc[g] = nil
		end
	end
	return tAnc
end

Kin._FinishPark = function(self)
	local tJob = self.tJob
	self.tJob = nil
	local animals = tJob.tAPIs.animals
	local exhibits = tJob.tAPIs.exhibits
	local tAnc = self:_Ancestors(tJob.tAnimals, tJob.tPresent, function(g)
		if string.sub(g, 1, 1) == "x" then
			local uid = tonumber(string.sub(g, 2))
			if uid == nil or exhibits == nil then
				return nil
			end
			local out = array()
			for i = 0, 1 do
				local bOk, p = pcall(exhibits.GetAnimalFamilyMemberUID, exhibits, uid, i)
				if bOk and known(p) then
					out[#out + 1] = "x" .. idString(p)
				end
			end
			return out
		end
		local bOk, tPar = pcall(animals.GetParents, animals, tonumber(g) or g)
		if bOk and type(tPar) == "table" then
			return parentList(tPar)
		end
		return nil
	end)
	local tHabitats = array()
	for _, h in ipairs(tJob.tHabitatOrder) do
		if type(h) == "string" and (string.sub(h, 1, 3) == "xh:" or string.sub(h, 1, 3) == "xe:") then
			tHabitats[#tHabitats + 1] = { id = h, name = tJob.tExhibitNames[h], kind = "exhibit" }
		else
			tHabitats[#tHabitats + 1] = { id = idString(h), name = tJob.tHabitatNames[h], kind = "habitat" }
		end
	end
	local tSnapshot = {
		v = self.nVersion,
		seq = tJob.nSeq,
		scope = "park",
		speciesFacts = self:_SpeciesFacts(tJob),
		mode = self:_GameMode(tJob.tAPIs),
		park = self:_ParkName(tJob.tAPIs),
		tradeCentre = self:_TradeCentre(tJob.tAPIs),
		habitats = tHabitats,
		habs = self:_HabitatPrints(tJob.tAPIs, tJob.tAllHabs),
		animals = tJob.tAnimals,
		anc = tAnc,
		bondsOk = tJob.bBondsOk == true,
	}
	-- the bond pass in the trace when its result changes (not every scan)
	local sBonds = string.format("bonds: %d bonded, %d calls, %d failed, ok=%s",
		#tJob.tBonded, tJob.nBondCalls or 0, tJob.nBondFails or 0, tostring(tJob.bBondsOk == true))
	if sBonds ~= self.sLastBonds then
		self.sLastBonds = sBonds
		trace(sBonds)
		-- debug builds log names only (tools/trace/checkpoints.txt): the outcome
		local nLocks = 0
		for _, b in ipairs(tJob.tBonded) do
			if b.tRec.bond then
				nLocks = nLocks + #b.tRec.bond.lock
			end
		end
		if tJob.bBondsOk ~= true then
			mark("kin_bonds_unavailable")
		elseif #tJob.tBonded == 0 then
			mark("kin_bonds_none")
		else
			mark((tJob.nBondFails or 0) > 0 and "kin_bonds_some_failed" or "kin_bonds_ok")
			mark(nLocks > 0 and "kin_bonds_locks" or "kin_bonds_no_locks")
		end
	end
	mark("kin_scan_done")
	self:_SendSnapshot(tJob.oUI, tSnapshot)
end

-- Per species in the scan: { maturity, infertility, life } in years, from
-- the game's fertility bounds (infertility above 900 = never infertile) and
-- longevity. Species data does not change in a session: asked once.
-- Shoals (boids) and colonies (butterflies, bees...) breed as one group: the
-- game's own checks, as its park rating uses them (ParkRatingManager).
-- nil when neither check answered (asked again next scan).
local function isCollective(tAPIs, sp)
	local bOk, b = pcall(function() return tAPIs.animals:IsSpeciesABoid(sp) end)
	if bOk and b == true then
		return true
	end
	local bOk2, b2 = pcall(function() return tAPIs.exhibits:IsColonySpecies(sp) end)
	if bOk2 and b2 == true then
		return true
	end
	if (bOk and b == false) or (bOk2 and b2 == false) then
		return false
	end
	return nil
end

Kin._SpeciesFacts = function(self, tJob)
	local animals = tJob.tAPIs.animals
	self.tSpeciesFacts = self.tSpeciesFacts or {}
	self.tCollective = self.tCollective or {}
	local tOut = {}
	for _, a in ipairs(tJob.tAnimals) do
		local sp = a.species
		if type(sp) == "string" and sp ~= "" and tOut[sp] == nil and self.tCollective[sp] == nil then
			self.tCollective[sp] = isCollective(tJob.tAPIs, sp)
		end
		if type(sp) == "string" and sp ~= "" and tOut[sp] == nil and self.tCollective[sp] then
			tOut[sp] = { collective = true }
		elseif type(sp) == "string" and sp ~= "" and tOut[sp] == nil and string.sub(a.id, 1, 1) ~= "x" then
			local t = self.tSpeciesFacts[sp]
			if t == nil then
				t = {}
				local bOk, nMat, nInf = pcall(animals.GetSpeciesFertilityBounds, animals, sp)
				if bOk and type(nMat) == "number" then
					t.maturity = nMat
					t.infertility = type(nInf) == "number" and nInf or nil
				end
				local bOk2, _, nLife = pcall(animals.GetSpeciesLongevity, animals, sp)
				if bOk2 and type(nLife) == "number" then
					t.life = nLife
				end
				if t.maturity ~= nil then
					self.tSpeciesFacts[sp] = t -- ask again next scan if the game had no answer
				end
			end
			tOut[sp] = t
		end
	end
	return tOut
end

-- 'franchise' (online Franchise zoo), 'offline' (Sandbox, Career,
-- Challenge...) or 'unknown'. The page only runs whole move plans in
-- 'offline' unless the player allows it.
Kin._GameMode = function(self, tAPIs)
	local sMode = "unknown"
	pcall(function()
		local franchise = tAPIs.franchise
		local n = franchise:GetPlanetHubType()
		if n ~= nil then
			sMode = (n == franchise.PlanetHubType_FranchiseOnline) and "franchise" or "offline"
		end
	end)
	return sMode
end

-- The park's name: the page keeps the player's habitat assignments per park.
Kin._ParkName = function(self, tAPIs)
	local bOk, s = pcall(function() return tAPIs.park:GetParkName() end)
	return (bOk and type(s) == "string") and s or ""
end

local function entityName(e)
	local bOk, s = pcall(function() return api.ui2.GetEntityName(e) end)
	if bOk and type(s) == "string" and s ~= "" then
		return s
	end
	return nil
end

-- The habitat's own id (habitat:GetHabitatIDFromEntityID), not its entity
-- id. Entity ids are handed out afresh when a zoo loads, so the page keeps
-- habitat assignments by name, residents and this id instead.
local function habitatKey(tAPIs, h)
	local bOk, n = pcall(function() return tAPIs.habitat:GetHabitatIDFromEntityID(h) end)
	if bOk and n ~= nil then
		return idString(n)
	end
	return nil
end

-- Every habitat in the park, empty ones too: { id, name, hid } (what the
-- page matches saved habitat assignments against after a reload).
Kin._HabitatPrints = function(self, tAPIs, tHabs)
	local tOut = array()
	for _, h in ipairs(tHabs or {}) do
		tOut[#tOut + 1] = { id = idString(h), name = entityName(h) or "", hid = habitatKey(tAPIs, h) }
	end
	return tOut
end

-- The first trade centre ({ id, name }) or nil, as the game's own
-- "send to trade centre" picks it.
Kin._TradeCentre = function(self, tAPIs)
	local tOut = nil
	pcall(function()
		local tCentres = tAPIs.facilities:GetTradeCentres()
		local nId = global.next(tCentres)
		if nId ~= nil then
			tOut = { id = idString(nId), name = entityName(nId) or "Trade centre" }
		end
	end)
	return tOut
end

-- One scan at a time. Runs incrementally when the frame hook is alive,
-- otherwise straight through.
Kin.Scan = function(self, oUI, sReason)
	if self.tJob ~= nil then
		if now() - self.tJob.nStarted < self.nJobTimeout then
			return self:_SendState(oUI, "busy", "")
		end
		self.tJob = nil
	end
	-- runs a few dozen animals per frame from the park's frame hook; outside
	-- a running park _StartPark answers "nopark"
	self:_StartPark(oUI, sReason)
end

-- Called every frame in a park (HeatMapManager.Advance).
Kin.Tick = function(self)
	if self.nLastTick == nil then
		local Core = global.package.loaded["pz2qol.core"]
		if Core then Core:Checkpoint("kin_first_tick") end
	end
	self.nLastTick = now()
	local bStore, sStoreErr = pcall(self._StoreTick, self)
	if not bStore then
		trace("store tick failed: " .. tostring(sStoreErr))
	end
	if self.tJob == nil then
		return
	end
	local bOk, bDone = pcall(self._Step, self, self.nPerFrame)
	if not bOk then
		local tJob = self.tJob
		self.tJob = nil
		trace("scan failed: " .. tostring(bDone))
		self:_SendState(tJob and tJob.oUI, "error", tostring(bDone))
		return
	end
	if bDone then
		local bFin, sErr = pcall(self._FinishPark, self)
		if not bFin then
			self.tJob = nil
			trace("scan finish failed: " .. tostring(sErr))
		end
	end
end

-----------------------------------------------------------------------
-- Hub: Animal Storage lineage
-----------------------------------------------------------------------
Kin._StorageAPIs = function(self)
	local oMode = self.oStorageMode
	if oMode == nil then
		return nil
	end
	local bOk, t = pcall(function() return oMode.backgroundWorldDataManager:GetWorldAPIs() end)
	if bOk and type(t) == "table" and t.animals ~= nil then
		return t
	end
	return nil
end

-- sIds: storage row ids, separated by commas.
Kin.Storage = function(self, oUI, sIds)
	local tAPIs = self:_StorageAPIs()
	local hub = api.planetHub
	if tAPIs == nil or type(hub) ~= "table" or type(hub.StorageGetIDAndAIDType) ~= "function" then
		return self:_SendState(oUI, "nostorage", "")
	end
	local animals = tAPIs.animals
	local tAnimals = array()
	local tPresent = {}
	for sID in string.gmatch(tostring(sIds or ""), "[^,]+") do
		local bOk, nID, nType = pcall(hub.StorageGetIDAndAIDType, sID)
		-- 2 = GUID (CompareMatesUIUtils.nGUID): what storage animals are
		if bOk and nID ~= nil and nType == 2 then
			local sGuid = guidString(nID)
			local tRec = { id = sID, guid = sGuid, par = array() }
			local bP, tPar = pcall(animals.GetParents, animals, nID)
			if bP then
				tRec.par = parentList(tPar)
			end
			local bG, tGenes = pcall(animals.GetMarketAnimalGenes, animals, nID, nType)
			if bG then
				tRec.genes = geneStrings(tGenes)
			end
			tAnimals[#tAnimals + 1] = tRec
			if sGuid ~= "" then
				tPresent[sGuid] = true
			end
		end
	end
	local tAnc = self:_Ancestors(tAnimals, tPresent, function(g)
		local bOk, tPar = pcall(animals.GetParents, animals, tonumber(g) or g)
		if bOk and type(tPar) == "table" then
			return parentList(tPar)
		end
		return nil
	end)
	self.nSeq = self.nSeq + 1
	self:_SendSnapshot(oUI, { v = self.nVersion, seq = self.nSeq, scope = "storage", habitats = array(), animals = tAnimals, anc = tAnc })
end

-----------------------------------------------------------------------
-- Actions (one per click)
-----------------------------------------------------------------------
local function entityOf(sId)
	sId = tostring(sId or "")
	if string.sub(sId, 1, 1) == "x" then
		return nil, tonumber(string.sub(sId, 2))
	end
	return tonumber(sId), nil
end

Kin.Contracept = function(self, oUI, sId, bOn)
	local tAPIs = self:_ParkWorld()
	if tAPIs == nil then
		return self:_SendState(oUI, "failed", "No park is loaded.")
	end
	local e, uid = entityOf(sId)
	local bOk, sErr
	if uid ~= nil then
		bOk, sErr = pcall(tAPIs.exhibits.SetExhibitAnimalUsingContraceptiveUsingUID, tAPIs.exhibits, uid, bOn == true)
	elseif e ~= nil then
		bOk, sErr = pcall(tAPIs.animals.SetUsingContraceptive, tAPIs.animals, e, bOn == true)
	else
		bOk, sErr = false, "bad animal id " .. tostring(sId)
	end
	if not bOk then
		return self:_SendState(oUI, "failed", "Contraception could not be changed: " .. tostring(sErr))
	end
	self:_SendState(oUI, "contracept", tostring(sId))
end

Kin.Locate = function(self, oUI, sId)
	local tAPIs = self:_ParkWorld()
	local e = entityOf(sId)
	if tAPIs == nil or e == nil then
		return self:_SendState(oUI, "failed", "This animal cannot be located.")
	end
	local nTarget = e
	pcall(function()
		local t = tAPIs.animals:GetUIAnimalListDataForIDs({ e })
		if t and t[e] and t[e].nLocateEntity then
			nTarget = t[e].nLocateEntity
		end
	end)
	-- the same checks as the Animals list's own locate: the animal must be
	-- in the world, and not underground (the game uses a special camera then)
	local bHasTransform = false
	pcall(function() bHasTransform = tAPIs.transform:HasTransform(nTarget) == true end)
	if not bHasTransform then
		return self:_SendState(oUI, "failed", "This animal is not out in the park right now (transport, trade centre or quarantine), so it cannot be located.")
	end
	local bUnderground = false
	pcall(function()
		bUnderground = tAPIs.animals:IsInBurrow(nTarget, false) == true or tAPIs.animals:IsInCavityNestUnderground(nTarget) == true
	end)
	if bUnderground then
		return self:_SendState(oUI, "failed", "This animal is underground; use the game's own Locate in the Animals list.")
	end
	local bOk, sErr = pcall(function()
		tAPIs.CameraModeManager:RequestMode("Orbit", { targetEntityID = nTarget, bLocate = true })
	end)
	pcall(function()
		local popups = tAPIs.InfoPopUpComponent
		if popups:HasInfoPopUpComponent(nTarget) then
			popups:CreateAndOpenInfoPopUpForEntity(nTarget)
		end
	end)
	if not bOk then
		return self:_SendState(oUI, "failed", "The camera could not move to the animal: " .. tostring(sErr))
	end
	self:_SendState(oUI, "located", tostring(sId))
end

Kin.Heatmap = function(self, oUI, bOn)
	local oHM = self.oHeatMapManager
	if oHM == nil then
		return self:_SendState(oUI, "failed", "The heat maps are not available here.")
	end
	local bOk, sErr = pcall(function()
		if bOn then
			oHM:ClaimViewModeRequest(oHM.whiteWorldUIAPI.VM_InbreedingRisk, "InbreedingRisk")
			oHM:SetCategory("InbreedingRisk")
		else
			oHM:ReleaseViewModeRequest()
			oHM:Hide()
		end
	end)
	if not bOk then
		return self:_SendState(oUI, "failed", "The breeding heat map could not be " .. (bOn and "shown" or "hidden") .. ": " .. tostring(sErr))
	end
	self:_SendState(oUI, bOn and "heatmap_on" or "heatmap_off", "")
end

-----------------------------------------------------------------------
-- Species board: destinations and moves
-----------------------------------------------------------------------
local function call(api_, sName, ...)
	if api_ == nil or type(api_[sName]) ~= "function" then
		return nil, "missing"
	end
	local tRes = table.pack(pcall(api_[sName], api_, ...))
	if not tRes[1] then
		return nil, tRes[2]
	end
	return table.unpack(tRes, 2, tRes.n)
end

-- Is habitat h a place these animals (GUIDs of one species) may go?
-- The same checks the game's Move mode makes (UpdateValidDestinations).
Kin._HabitatOk = function(self, tAPIs, h, tGuids)
	local editors = tAPIs.editors
	if editors ~= nil and type(editors.IsValidTutorialPlacement) == "function" then
		local b = call(editors, "IsValidTutorialPlacement", h, false)
		if b == false then
			return false, "Not available in this scenario."
		end
	end
	local animals = tAPIs.animals
	if type(animals.IsValidHabitatForAnimalsGUID) == "function" then
		local b = call(animals, "IsValidHabitatForAnimalsGUID", h, tGuids)
		if b == false then
			return false, "The game does not allow this species here (wrong habitat type)."
		end
	end
	local habitat = tAPIs.habitat
	if call(habitat, "IsAquarium", h) == true and call(habitat, "IsAquariumGateBelowWaterLevel", h) == false then
		return false, "The aquarium gate is above the water."
	end
	return true, nil
end

Kin.Destinations = function(self, oUI, sReq, sIds)
	local tAPIs = self:_ParkWorld()
	local function answer(t)
		pcall(oUI.TriggerEventAtNextAdvance, oUI, "PZ2QoL_KinDestinationsResult", sReq, Kin.Encode(t))
	end
	if tAPIs == nil or tAPIs.habitat == nil then
		return answer({ bySpecies = {}, habitats = array(), tradeCentre = nil })
	end
	local animals = tAPIs.animals
	-- the requested animals by species
	local tBySpecies = {}
	for sId in string.gmatch(tostring(sIds or ""), "[^,]+") do
		local e = tonumber(sId)
		if e ~= nil then
			local sSpecies = call(animals, "GetSpecies", e)
			local guid = call(animals, "EntityIDToAnimalGUID", e)
			if sSpecies ~= nil and known(guid) then
				tBySpecies[sSpecies] = tBySpecies[sSpecies] or {}
				local tList = tBySpecies[sSpecies]
				tList[#tList + 1] = guid
			end
		end
	end
	local tHabitats = call(tAPIs.habitat, "GetAllCompleteHabitats")
	if type(tHabitats) ~= "table" then
		tHabitats = call(tAPIs.habitat, "GetHabitats") or {}
	end
	local tOut = { bySpecies = {}, habitats = array(), tradeCentre = self:_TradeCentre(tAPIs) }
	local tNames = {}
	for _, h in pairs(tHabitats) do
		local sH = idString(h)
		if tNames[sH] == nil then
			tNames[sH] = entityName(h) or ("Habitat " .. sH)
			tOut.habitats[#tOut.habitats + 1] = { id = sH, name = tNames[sH], hid = habitatKey(tAPIs, h) }
		end
	end
	for sSpecies, tGuids in pairs(tBySpecies) do
		local tSpecies = {}
		for _, h in pairs(tHabitats) do
			local bOk, sReason = self:_HabitatOk(tAPIs, h, tGuids)
			tSpecies[idString(h)] = { ok = bOk, reason = sReason }
		end
		tOut.bySpecies[sSpecies] = tSpecies
	end
	answer(tOut)
end

-- ONE animal to a habitat (habitat entity id) or the trade centre
-- ("trade:<id>" / "trade:auto"): the game's own Move sequence, or its own
-- Send to Trade Centre. Never more than one.
Kin.Move = function(self, oUI, sReq, sId, sTo)
	local function answer(bOk, sDetail)
		mark(bOk and "kin_move_ok" or "kin_move_failed")
		pcall(oUI.TriggerEventAtNextAdvance, oUI, "PZ2QoL_KinMoveResult", sReq, bOk == true, sDetail or "")
	end
	local tAPIs = self:_ParkWorld()
	if tAPIs == nil or tAPIs.animals == nil then
		return answer(false, "No park is loaded.")
	end
	local animals = tAPIs.animals
	local e = entityOf(sId)
	if e == nil then
		return answer(false, "Only habitat animals can be moved from here (exhibit animals: use the game's own Move).")
	end
	sTo = tostring(sTo or "")
	local bTrade = string.sub(sTo, 1, 6) == "trade:"
	local nDest = tonumber(bTrade and string.sub(sTo, 7) or sTo)
	if bTrade and nDest == nil then
		-- "trade:auto": the first trade centre, as the game's own send does
		local tTC = self:_TradeCentre(tAPIs)
		nDest = tTC and tonumber(tTC.id)
		if nDest == nil then
			return answer(false, "There is no trade centre in this zoo.")
		end
	end
	if nDest == nil then
		return answer(false, "Unknown destination.")
	end
	-- the animal (AnimalMovementEditMode.VerifyHabitatAnimal, the info
	-- panel's Move button conditions)
	if call(animals, "IsAlive", e) == false then
		return answer(false, "This animal is no longer alive.")
	end
	if call(animals, "IsEscaped", e) == true and call(animals, "IsAnimalBoxed", e) ~= true then
		return answer(false, "This animal has escaped.")
	end
	if call(animals, "IsBoxAnimating", e) == true or call(animals, "IsBoxingClaimed", e) == true or hasTransportJob(animals, e) then
		return answer(false, "This animal is already being moved.")
	end
	if bTrade then
		-- the info panel's / habitat gate's Send to Trade Centre: the game picks
		-- the trade centre and books the keeper itself. (A plain transport
		-- request to the trade centre is accepted but never carried out.)
		local park = tAPIs.park
		local nMax, nNow = call(park, "GetTradeCentreMaxCapacity"), call(park, "GetNumberOfAnimalsInTradeCentre")
		if type(nMax) == "number" and type(nNow) == "number" and nNow >= nMax then
			return answer(false, "The trade centre is full (" .. nNow .. " of " .. nMax .. ").")
		end
		if call(animals, "CanSendAnimalToTradeCentre", e) == false then
			return answer(false, "The game won't send this animal to the trade centre right now.")
		end
		if call(animals, "AttemptToSendToTradeCentre", e) ~= true then
			return answer(false, "The game refused to send it to the trade centre.")
		end
		return answer(true, "")
	end
	if not bTrade then
		-- waiting at the trade centre: back to its own habitat is the trade
		-- centre panel's "Return to habitat"; to another habitat, the usual Move
		local bAtTrade = false
		pcall(function()
			bAtTrade = animals:GetCurrentLocationType(e) == animals.CurrentLocationType_TradeCentre
		end)
		if call(animals, "GetAssignedHabitatEntityID", e) == nDest then
			if not bAtTrade then
				return answer(false, "It already lives there.")
			end
			if call(tAPIs.staff, "CanStaffDeliverAnimalToFacility", e, nDest) == false then
				return answer(false, "No keeper can reach that habitat (check the paths and the gates).")
			end
			local bOk = pcall(animals.RequestTransportToAssignedHabitat, animals, e)
			if not bOk then
				return answer(false, "The game refused to return it to its habitat.")
			end
			return answer(true, "")
		end
		local guid = call(animals, "EntityIDToAnimalGUID", e)
		local bOk, sReason = self:_HabitatOk(tAPIs, nDest, { guid })
		if not bOk then
			return answer(false, sReason)
		end
		if call(tAPIs.staff, "CanStaffDeliverAnimalToFacility", e, nDest) == false then
			return answer(false, "No keeper can reach that habitat (check the paths and the gates).")
		end
	end
	local bCan, nType = call(animals, "CanTransportToEntity", false, nDest)
	if not bCan then
		return answer(false, "The game cannot transport animals there right now.")
	end
	local bClaimed = false
	if not bTrade and call(animals, "DoesTransportRequireStaff", e, nDest) == false then
		call(animals, "ClaimBoxing", e)
		bClaimed = true
	end
	local bMoved, sErr = call(animals, "AttemptRequestToTransportAnimalToTarget", e, nDest, nType)
	if bMoved ~= true then
		if bClaimed then
			call(animals, "ReleaseBoxing", e)
		end
		return answer(false, "The game refused the move" .. (sErr and sErr ~= "missing" and (": " .. tostring(sErr)) or "") .. ".")
	end
	answer(true, "")
end

-----------------------------------------------------------------------
-- Breeding programme: what one species needs (asked when planning)
-----------------------------------------------------------------------
local tAreaKeys = { nLandArea = "land", nWaterArea = "water", nClimbArea = "climb", nDeepSwimArea = "deepSwim", nFlyArea = "fly" }

local function areas(t)
	if type(t) ~= "table" then
		return nil
	end
	local out = {}
	local bAny = false
	for k, v in pairs(t) do
		local sKey = tAreaKeys[k]
		if sKey ~= nil and type(v) == "number" then
			out[sKey] = v
			bAny = true
		end
	end
	return bAny and out or nil
end

-- The mating rule's enum fields on the animals API (exe strings, 1.0.5:
-- Monogamy, Polygyny, Polyandre, Polygyandry; "Polyandry" in case of a
-- fix), in a fixed order for the trace.
local tMatingEnums = {
	{ "Monogamy", "monogamy" }, { "Polygyny", "polygyny" }, { "Polyandre", "polyandry" },
	{ "Polyandry", "polyandry" }, { "Polygyandry", "mixed" },
}
-- The rule as text, longest match first: the enum names, the Zoopedia's
-- words (animals.fdb Lifecycle_FertilityData.MatingType: Monogamous,
-- Polygynous, Polyandrous, Promiscuous) and the usual spellings.
local tMatingWords = {
	{ "polygyandr", "mixed" }, { "polygynandr", "mixed" }, { "promiscu", "mixed" },
	{ "polyandr", "polyandry" }, { "polygyn", "polygyny" }, { "monogam", "monogamy" },
}

-- A short, readable form of a value the mod did not understand (for the
-- page's message): a table shows its first few fields.
local function rawText(v)
	if type(v) ~= "table" then
		return tostring(v)
	end
	local tParts = {}
	for k, x in pairs(v) do
		if #tParts >= 4 then
			tParts[#tParts + 1] = "..."
			break
		end
		tParts[#tParts + 1] = tostring(k) .. "=" .. (type(x) == "table" and "{...}" or tostring(x))
	end
	return "{" .. table.concat(tParts, ", ") .. "}"
end

local function markNumber(sPrefix, n)
	local Core = global.package.loaded["pz2qol.core"]
	if Core and Core.MarkNumber then
		pcall(Core.MarkNumber, Core, sPrefix, n)
	end
end

-- 'monogamy' | 'polygyny' | 'polyandry' | 'mixed' | nil, and the raw rule
-- (as text) only when the mod could not read it (for the page's message).
-- 'mixed' is Polygyandry: both sexes take several mates (the Zoopedia's
-- "Promiscuous"; 31 of 85 species, solitary cats and bears among them).
-- Trace: kin_mating_<name>, or kin_mating_unknown with the value spelt out
-- (kin_mating_raw + digits for a number, kin_mating_raw_<type> otherwise)
-- and each enum value (kin_mating_enum + digits, or kin_mating_enum_missing),
-- kin_mating_none (no rule), kin_mating_bonds (read from mates instead).
Kin._MatingSystem = function(self, animals, sSpecies)
	local rule = call(animals, "GetMonogamyRule", sSpecies)
	if rule ~= nil then
		for _, t in ipairs(tMatingEnums) do
			local bOk, v = pcall(function() return animals[t[1]] end)
			if bOk and v ~= nil and v == rule then
				mark("kin_mating_" .. t[2])
				return t[2], nil
			end
		end
		-- the rule as text ("Polygyny", "MonogamyRule_Polygyny", "Promiscuous"...)
		if type(rule) == "string" then
			local sLow = string.lower(rule)
			for _, t in ipairs(tMatingWords) do
				if string.find(sLow, t[1], 1, true) then
					mark("kin_mating_" .. t[2])
					return t[2], nil
				end
			end
		end
		-- not understood: spell it and the enum values into the trace
		mark("kin_mating_unknown")
		if type(rule) == "number" then
			markNumber("kin_mating_raw", rule)
		else
			mark("kin_mating_raw_" .. type(rule))
		end
		for _, t in ipairs(tMatingEnums) do
			local bOk, v = pcall(function() return animals[t[1]] end)
			if bOk and type(v) == "number" then
				markNumber("kin_mating_enum", v)
			else
				mark("kin_mating_enum_missing")
			end
		end
	else
		mark("kin_mating_none")
	end
	local sRaw = rule ~= nil and rawText(rule) or nil
	-- fallback: the game marks mates of monogamous species
	local tSplit = call(animals, "GetAllAdultsOfSpeciesSplitByGender", sSpecies)
	if type(tSplit) == "table" then
		for _, tList in pairs(tSplit) do
			if type(tList) == "table" then
				for _, e in ipairs(tList) do
					local tMate = call(animals, "GetMateData", e)
					if type(tMate) == "table" and tMate.bIsMonogamous ~= nil then
						if tMate.bIsMonogamous then
							mark("kin_mating_bonds")
							return "monogamy", nil
						end
						return nil, sRaw
					end
				end
			end
		end
	end
	return nil, sRaw
end

-- The species' own social groups (the release groups: mixed group, breeding
-- partners...), each with its adults by sex, so the programme knows how many
-- males go with how many females. Offline (decompiled
-- editors.wildterritory.releasegroupstoragemode.lua,
-- events.eventactioncreatereleasegroup.lua): the wild-territory API's
-- GetTerritorySocialGroupsForSpecies(sSpecies) gives an array of
-- { nSocialGroupType, sNameSymbol, nMale, nFemale }; the type values are
-- fields on that API (SocialGroupType_<name>), and sNameSymbol is that same
-- <name> (the objectives match the two), so it names the kind when a value is
-- missing. Names here: what the page gets as `kind`.
local tGroupKinds = {
	MixedGroup = "mixed", MixedGroupLarge = "mixedLarge", BreedingPartners = "pair",
	MaleBachelor = "maleBachelor", FemaleBachelor = "femaleBachelor",
	MaleSolitary = "maleSolitary", FemaleSolitary = "femaleSolitary",
}
Kin.nGroupsMax = 12         -- social groups sent per species

-- array of { kind, m, f }, or nil; may raise (the caller pcalls)
local function socialGroups(tAPIs, sSpecies)
	local wild = tAPIs.wildterritory
	if wild == nil then
		return nil
	end
	local tList = call(wild, "GetTerritorySocialGroupsForSpecies", sSpecies)
	if type(tList) ~= "table" then
		return nil
	end
	-- type value -> kind (a value the API lacks is simply not known)
	local tByType = {}
	for sName, sKind in pairs(tGroupKinds) do
		local bOk, v = pcall(function() return wild["SocialGroupType_" .. sName] end)
		if bOk and v ~= nil then
			tByType[v] = sKind
		end
	end
	local out = array()
	for _, g in ipairs(tList) do
		if #out >= Kin.nGroupsMax then
			break
		end
		if type(g) == "table" and type(g.nMale) == "number" and type(g.nFemale) == "number" then
			local sKind = (g.nSocialGroupType ~= nil and tByType[g.nSocialGroupType]) or tGroupKinds[tostring(g.sNameSymbol)] or tostring(g.sNameSymbol)
			out[#out + 1] = { kind = sKind, m = g.nMale, f = g.nFemale }
		end
	end
	return #out > 0 and out or nil
end

-- The most adults of each sex per habitat (the Zoopedia's "max per sex").
-- Guess: the Zoopedia's maxMale / maxFemale are filled by the exe (no game
-- Lua sets them), so look for number fields named like max + male / female
-- in what the Lua API does give (GetSocialRequirements: nMin, nMax known;
-- GetSpeciesSocialityData: exe-only, its signature guessed), one nested
-- level deep. The first found wins: fields of t before nested tables.
local function sexMaxFrom(t, tSex, nDepth)
	if type(t) ~= "table" then
		return
	end
	local tNested = {}
	for k, v in pairs(t) do
		if type(v) == "number" and type(k) == "string" and v > 0 and v < math.huge then
			local s = string.lower(k)
			if string.find(s, "max", 1, true) then
				if string.find(s, "female", 1, true) then
					tSex.female = tSex.female or v
				elseif string.find(s, "male", 1, true) then
					tSex.male = tSex.male or v
				end
			end
		elseif type(v) == "table" and nDepth < 1 then
			tNested[#tNested + 1] = v
		end
	end
	for _, v in ipairs(tNested) do
		sexMaxFrom(v, tSex, nDepth + 1)
	end
end

-- sHabs: habitat ids (comma separated) to measure for this species.
Kin.SpeciesInfo = function(self, oUI, sReq, sSpecies, sHabs)
	local tAPIs = self:_ParkWorld()
	local function answer(t)
		pcall(oUI.TriggerEventAtNextAdvance, oUI, "PZ2QoL_KinSpeciesResult", sReq, Kin.Encode(t))
	end
	if tAPIs == nil or tAPIs.animals == nil then
		return answer({ error = "No park is loaded." })
	end
	local animals, habitat = tAPIs.animals, tAPIs.habitat
	sSpecies = tostring(sSpecies or "")
	local tOut = { species = sSpecies, habitats = {} }
	local tSocial = call(animals, "GetSocialRequirements", sSpecies)
	if type(tSocial) == "table" then
		tOut.social = { min = tSocial.nMin, max = tSocial.nMax }
	end
	local nMat, nInfert = call(animals, "GetSpeciesFertilityBounds", sSpecies)
	if type(nMat) == "number" then
		tOut.fertilityAges = { maturity = nMat, infertility = nInfert }
	end
	tOut.mating, tOut.matingRaw = self:_MatingSystem(animals, sSpecies)
	-- group make-up (males per female): the game's own social groups
	local bGroups, tGroups = pcall(socialGroups, tAPIs, sSpecies)
	if bGroups and tGroups ~= nil then
		tOut.groups = tGroups
		mark("kin_groups_found")
	else
		mark("kin_groups_none")
	end
	-- the most adults of each sex per habitat, if the Lua API carries it
	local tSex = {}
	pcall(sexMaxFrom, tSocial, tSex, 0)
	pcall(sexMaxFrom, (call(animals, "GetSpeciesSocialityData", sSpecies)), tSex, 0)
	if tSex.male ~= nil or tSex.female ~= nil then
		tOut.sexMax = tSex
		mark("kin_sexmax_found")
	else
		mark("kin_sexmax_none")
	end
	-- the game's conception chance by fertility grades (0..6 x 0..6), at full welfare
	local nSpeciesFert = call(animals, "GetAnimalSpeciesFertility", sSpecies)
	local nBonus = call(animals, "GetMatingResearchBonus", sSpecies) or 0
	if type(nSpeciesFert) == "number" and type(animals.CalculateProbabilityOfBreedingEvent) == "function" then
		local tTable = array()
		for fm = 0, 6 do
			local tRow = array()
			for ff = 0, 6 do
				-- (welfare mother, welfare father, fertility mother x6, fertility father x6, species, bonus)
				local p = call(animals, "CalculateProbabilityOfBreedingEvent", 1, 1, ff, fm, nSpeciesFert, nBonus)
				tRow[#tRow + 1] = type(p) == "number" and p or 0
			end
			tTable[#tTable + 1] = tRow
		end
		tOut.conception = tTable
	end
	for sHab in string.gmatch(tostring(sHabs or ""), "[^,]+") do
		local h = tonumber(sHab)
		if h ~= nil then
			local tH = {}
			local bCalc, tArea = call(habitat, "GetHabitatSpeciesOverallNavAreaData", h, sSpecies)
			if bCalc == false then
				tH.available = areas(tArea)
			elseif bCalc == true then
				tH.calculating = true
			end
			tH.required = areas(call(animals, "GetSpaceRequirementsInHabitatForSpecies", h, sSpecies))
			tH.adults = call(habitat, "GetNumberOfAdultsOfGivenSpecies", h, sSpecies)
			tOut.habitats[idString(h)] = tH
		end
	end
	answer(tOut)
end

-----------------------------------------------------------------------
-- The player's own data (habitat assignments...), kept on this device in
-- the game's player save (PZ2QoL.PlayerStore: tData.PZ2QoL.Assign, one
-- entry per zoo), in every zoo, Franchise included: that save is local
-- (Steam Cloud carries it to the player's other PCs) and is not the zoo's
-- online save. The game gives mods nothing else that outlasts a restart:
-- api.debug's file calls are retail stubs and the UI's localStorage is
-- memory only.
-- Each zoo is found by a stable key (_ZooKey): a Franchise zoo by its
-- planet hub and zoo GUIDs, any other park by its hub and name. The key is
-- worked out on the park tick (the save is loaded by then; the player
-- profile can be missing early on), and the views are told to read again
-- (PZ2QoL_StoreReset) once it is known.
-- The text is the UI's JSON (ASCII only), stored as it is.
--
-- Builds from 2026-10-16 kept offline parks' data in the park save as a
-- world serialisation client "PZ2QoL". That client stays registered in
-- offline parks so those saves load exactly as before, but it only reads:
-- what it finds moves to the player store (if this zoo has nothing there
-- yet) and nothing is written to the park save any more.
-----------------------------------------------------------------------
Kin.sSaveClient = "PZ2QoL"
Kin.nSaveVersion = 1
Kin.nStoreMax = 60000        -- characters of one zoo's text (the player store caps all zoos at 64 KB)
Kin.nStoreRetry = 1.0        -- seconds between tries to find the zoo and the player
Kin.nStoreModeWait = 10      -- seconds an unknown game mode is waited for (then: by park name)
Kin.nStorePlayerWait = 20    -- seconds before a missing player profile is reported
Kin.tStoreAPIs = nil         -- this park's world APIs, from the park start to its end
Kin.sZooKey = nil            -- this zoo's key in the player store, once known
Kin.sStoreOff = "nopark"     -- why there is no store yet: nopark | wait | noplayer
Kin.sLegacyData = nil        -- text from an old park save, waiting for the zoo key
Kin.oSaveAPI = nil           -- the park's worldserialisation, while the reader is registered

Kin._PlayerStore = function(self)
	local Core = self.Core or global.package.loaded["pz2qol.core"]
	return (Core and Core.PlayerStore) or global.package.loaded["pz2qol.playerstore"]
end

-- tells the open views to read the store again
Kin._StoreReset = function(self)
	for oUI in pairs(self.tViews) do
		pcall(oUI.TriggerEventAtNextAdvance, oUI, "PZ2QoL_StoreReset")
	end
end

local function keyPart(s, nMax)
	if type(s) ~= "string" then
		return ""
	end
	return string.sub((string.gsub(s, "[^%w%-]", "")), 1, nMax)
end

-- a short hash, so any park name gives a short ASCII key
local function hash(s)
	local h = 5381
	for i = 1, #s do
		h = (h * 33 + string.byte(s, i)) % 4294967296
	end
	return string.format("%08x", math.floor(h))
end

-- This zoo's key in the player store, or nil + why not yet ("wait").
--   Franchise: f_<planet hub GUID>_<zoo GUID>
--   any other: o_<planet hub GUID>_<name, letters only>_<hash of the name>
-- Offline parks are known by name: two parks with the same name share
-- their assignments, and renaming a park starts it afresh.
Kin._ZooKey = function(self, tAPIs, nWaited)
	local franchise = type(tAPIs) == "table" and tAPIs.franchise or nil
	local sHub, sZoo = nil, nil
	if franchise ~= nil then
		pcall(function() sZoo = franchise:GetCurrentZooGUID() end)
		pcall(function() sHub = franchise:GetPlanetHubGuid() end)
	end
	sHub = keyPart(sHub, 40)
	if type(sZoo) == "string" and keyPart(sZoo, 40) ~= "" then
		return "f_" .. sHub .. "_" .. keyPart(sZoo, 40)
	end
	local sMode = self:_GameMode(tAPIs or {})
	if sMode == "franchise" then
		return nil, "wait" -- a Franchise zoo whose GUID is not known yet
	end
	if sMode ~= "offline" and (nWaited or 0) < self.nStoreModeWait then
		return nil, "wait"
	end
	local sName = self:_ParkName(tAPIs or {})
	if sName == "" then
		return nil, "wait"
	end
	return "o_" .. sHub .. "_" .. keyPart(sName, 24) .. "_" .. hash(sName)
end

-- From the park tick (throttled) and from requests: finds the zoo's key
-- and checks the player store. Tells the views when the answer changes.
Kin._ResolveStore = function(self)
	local tAPIs = self.tStoreAPIs
	if tAPIs == nil or self.sZooKey ~= nil then
		return
	end
	local nNow = now()
	self.nStoreTried = nNow
	-- not before the first park tick: the park's save (and name) is loaded by then
	if self.nStoreFirstTick == nil then
		return
	end
	local nWaited = nNow - self.nStoreFirstTick
	local sWas = self.sStoreOff
	local sKey, sWhy = self:_ZooKey(tAPIs, nWaited)
	local Store = self:_PlayerStore()
	if sKey ~= nil and (Store == nil or not Store:Available()) then
		sKey = nil
		sWhy = (Store ~= nil and nWaited < self.nStorePlayerWait) and "wait" or "noplayer"
	end
	if sKey == nil then
		self.sStoreOff = sWhy or "wait"
		if self.sStoreOff == "noplayer" and sWas ~= "noplayer" then
			mark("assign_store_unavailable")
			self:_StoreReset()
		end
		return
	end
	self.sZooKey = sKey
	self.sStoreOff = nil
	mark(string.sub(sKey, 1, 2) == "f_" and "assign_store_franchise" or "assign_store_offline")
	-- data an old build kept in this park's save
	if self.sLegacyData ~= nil then
		local sOld = self.sLegacyData
		self.sLegacyData = nil
		local sHave = Store:Read(sKey)
		if sHave == "" then
			local bOk = Store:Write(sKey, sOld, nNow)
			mark(bOk and "assign_store_migrated" or "assign_store_migrate_failed")
		end
	end
	local sText = Store:Read(sKey)
	mark((type(sText) == "string" and sText ~= "") and "assign_store_loaded" or "assign_store_empty")
	self:_StoreReset()
end

-- from the park tick
Kin._StoreTick = function(self)
	if self.tStoreAPIs == nil then
		return
	end
	local nNow = now()
	if self.nStoreFirstTick == nil then
		self.nStoreFirstTick = nNow
		self:_ResolveStore()
	elseif self.sZooKey == nil and nNow - (self.nStoreTried or 0) >= self.nStoreRetry then
		self:_ResolveStore()
	end
	local Store = self:_PlayerStore()
	if Store ~= nil then
		Store:Tick(nNow)
	end
end

-- the old park-save client: reads only (see above)
Kin._LoadWorld = function(self, tLoad)
	local s = type(tLoad) == "table" and tLoad.sData or nil
	if type(s) == "string" and #s <= self.nStoreMax and string.sub(s, 1, 1) == "{" and s ~= "{}" then
		mark("store_world_loaded")
		local Store = self:_PlayerStore()
		if self.sZooKey ~= nil and Store ~= nil then
			if Store:Read(self.sZooKey) == "" then
				local bOk = Store:Write(self.sZooKey, s, now())
				mark(bOk and "assign_store_migrated" or "assign_store_migrate_failed")
				self:_StoreReset()
			end
		else
			self.sLegacyData = s
		end
	end
	return true
end

-- from the heat map manager's Init: a park world is starting, before its
-- save is loaded
Kin._ParkStoreStart = function(self, tAPIs)
	self:_ParkStoreEnd()
	self.tStoreAPIs = type(tAPIs) == "table" and tAPIs or {}
	self.sStoreOff = "wait"
	self:_RegisterReader(self.tStoreAPIs)
	self:_StoreReset()
end

Kin._RegisterReader = function(self, tAPIs)
	if self:_GameMode(tAPIs) ~= "offline" then
		return -- never in a Franchise zoo (or one that may be)
	end
	local oSave = tAPIs.worldserialisation
	if oSave == nil then
		return
	end
	local bOk, sErr = pcall(function()
		oSave:RegisterWorldSerialisationClient(self.sSaveClient, self.nSaveVersion,
			function(tSave)
				-- nothing is written to the park save any more
			end,
			function(tLoad, nVersion)
				local bLoaded, sWhy = pcall(self._LoadWorld, self, tLoad)
				if not bLoaded then
					trace("park load failed: " .. tostring(sWhy))
				end
				return true
			end,
			function(nOldVersion)
				return true
			end)
	end)
	if not bOk then
		trace("save client: " .. tostring(sErr))
		mark("store_park_off_failed")
		return
	end
	self.oSaveAPI = oSave
	mark("store_park_on")
end

-- the park ends: its key goes (the game saves the player when a park closes)
Kin._ParkStoreEnd = function(self)
	local oSave = self.oSaveAPI
	self.oSaveAPI = nil
	if oSave ~= nil then
		pcall(function() oSave:UnregisterWorldSerialisationClient(self.sSaveClient) end)
	end
	local bHad = self.tStoreAPIs ~= nil
	self.tStoreAPIs = nil
	self.sZooKey = nil
	self.sLegacyData = nil
	self.nStoreFirstTick = nil
	self.nStoreTried = nil
	self.sStoreOff = "nopark"
	local Store = self:_PlayerStore()
	if Store ~= nil then
		pcall(Store.Forget, Store)
	end
	if bHad then
		self:_StoreReset()
	end
end

-- answers PZ2QoL_StoreData(reqId, ok, part, parts, text): this zoo's data
-- in chunks, or ok = false with the reason as the text
-- (nopark | wait | noplayer: 'wait' is followed by PZ2QoL_StoreReset)
Kin.StoreLoad = function(self, oUI, sReq)
	if self.sZooKey == nil and self.nStoreFirstTick ~= nil then
		self:_ResolveStore()
	end
	local Store = self:_PlayerStore()
	local sText, sWhy = nil, self.sStoreOff or "nopark"
	if self.sZooKey ~= nil and Store ~= nil then
		sText, sWhy = Store:Read(self.sZooKey)
	end
	if type(sText) ~= "string" then
		pcall(oUI.TriggerEventAtNextAdvance, oUI, "PZ2QoL_StoreData", sReq, false, 1, 1, sWhy or "noplayer")
		return
	end
	local nParts = math.max(1, math.ceil(#sText / self.nChunkSize))
	for i = 1, nParts do
		local sPart = string.sub(sText, (i - 1) * self.nChunkSize + 1, i * self.nChunkSize)
		pcall(oUI.TriggerEventAtNextAdvance, oUI, "PZ2QoL_StoreData", sReq, true, i, nParts, sPart)
	end
end

-- PZ2QoL_StoreSave(reqId, text): replaces this zoo's data in the player
-- store (the game writes it to disk a few seconds later); answers
-- PZ2QoL_StoreSaved(reqId, ok)
Kin.StoreSave = function(self, oUI, sReq, sText)
	local bOk, sWhy = false, self.sStoreOff or "nopark"
	local Store = self:_PlayerStore()
	if self.sZooKey ~= nil and Store ~= nil then
		if type(sText) == "string" and #sText <= self.nStoreMax then
			bOk, sWhy = Store:Write(self.sZooKey, sText, now())
		else
			sWhy = "toobig"
		end
	end
	if not bOk then
		trace("store save refused: " .. tostring(sWhy))
		mark("assign_store_refused")
	end
	pcall(oUI.TriggerEventAtNextAdvance, oUI, "PZ2QoL_StoreSaved", sReq, bOk == true)
end

-----------------------------------------------------------------------
-- Wiring
-----------------------------------------------------------------------
Kin.Attach = function(self, oUI)
	if oUI == nil or self.tViews[oUI] then
		return
	end
	self.tViews[oUI] = true
	self.tLastSent[oUI] = nil
	local function guard(sName, fn)
		return function(_, ...)
			local bOk, sErr = pcall(fn, ...)
			if not bOk then
				trace(sName .. " failed: " .. tostring(sErr))
				self:_SendState(oUI, "error", sName .. ": " .. tostring(sErr))
			end
		end
	end
	local bOk, sErr = pcall(function()
		-- callbacks get (callbackArgument, eventArgs...)
		oUI:AddEventListener("PZ2QoL_KinScan", 1, guard("scan", function(sReason)
			self:Scan(oUI, sReason)
		end), self)
		oUI:AddEventListener("PZ2QoL_KinStorage", 1, guard("storage", function(sIds)
			self:Storage(oUI, sIds)
		end), self)
		oUI:AddEventListener("PZ2QoL_KinContracept", 2, guard("contracept", function(sId, bOn)
			self:Contracept(oUI, sId, bOn)
		end), self)
		oUI:AddEventListener("PZ2QoL_KinLocate", 1, guard("locate", function(sId)
			self:Locate(oUI, sId)
		end), self)
		oUI:AddEventListener("PZ2QoL_KinHeatmap", 1, guard("heatmap", function(bOn)
			self:Heatmap(oUI, bOn == true)
		end), self)
		oUI:AddEventListener("PZ2QoL_KinDestinations", 2, guard("destinations", function(sReq, sIds)
			self:Destinations(oUI, sReq, sIds)
		end), self)
		oUI:AddEventListener("PZ2QoL_KinMove", 3, guard("move", function(sReq, sId, sTo)
			self:Move(oUI, sReq, sId, sTo)
		end), self)
		oUI:AddEventListener("PZ2QoL_StoreLoad", 1, guard("store_load", function(sReq)
			self:StoreLoad(oUI, sReq)
		end), self)
		oUI:AddEventListener("PZ2QoL_StoreSave", 2, guard("store_save", function(sReq, sText)
			self:StoreSave(oUI, sReq, sText)
		end), self)
		oUI:AddEventListener("PZ2QoL_KinSpecies", 3, guard("species", function(sReq, sSpecies, sHabs)
			self:SpeciesInfo(oUI, sReq, sSpecies, sHabs)
		end), self)
		oUI:AddEventListener("PZ2QoL_KinForget", 0, guard("forget", function()
			self.tLastSent[oUI] = nil
		end), self)
	end)
	if not bOk then
		trace("listeners failed: " .. tostring(sErr))
	end
	mark(bOk and "kin_attached" or "kin_attach_failed")
end

Kin._PatchHeatMapManager = function(self, HeatMapManager)
	local fnInit = HeatMapManager.Init
	local fnAdvance = HeatMapManager.Advance
	local fnShutdown = HeatMapManager.Shutdown
	if type(fnAdvance) ~= "function" then
		trace("HeatMapManager has no Advance; scans run in one go")
		return
	end
	if type(fnInit) == "function" then
		HeatMapManager.Init = function(oManager, ...)
			self.oHeatMapManager = oManager
			local tResults = table.pack(fnInit(oManager, ...))
			-- the player's data for this zoo: found on the park tick; the
			-- old park-save reader registers before the save loads
			local bOk, sErr = pcall(function()
				local tAPIs = oManager.tWorldAPIs
				if type(tAPIs) ~= "table" then
					tAPIs = api.world.GetWorldAPIs()
				end
				self:_ParkStoreStart(tAPIs)
			end)
			if not bOk then
				trace("save client failed: " .. tostring(sErr))
			end
			return table.unpack(tResults, 1, tResults.n)
		end
	end
	HeatMapManager.Advance = function(oManager, ...)
		self.oHeatMapManager = oManager
		local bOk, sErr = pcall(self.Tick, self)
		if not bOk then
			self.tJob = nil
			trace("tick failed: " .. tostring(sErr))
		end
		return fnAdvance(oManager, ...)
	end
	if type(fnShutdown) == "function" then
		HeatMapManager.Shutdown = function(oManager, ...)
			mark("x_park_end")
			if self.oHeatMapManager == oManager then
				self.oHeatMapManager = nil
				self.nLastTick = nil
				self.tJob = nil
				-- entity ids are per park
				self.tStatic = {}
				self.tAncestors = {}
				pcall(self._ParkStoreEnd, self)
			end
			local tResults = table.pack(fnShutdown(oManager, ...))
			mark("x_park_end_done")
			return table.unpack(tResults, 1, tResults.n)
		end
	end
end

Kin._PatchStorageMode = function(self, StorageMode)
	local fnIn = StorageMode.TransitionIn
	local fnOut = StorageMode.TransitionOut
	if type(fnIn) ~= "function" or type(fnOut) ~= "function" then
		trace("AnimalStorageHubMode has changed; storage kin off")
		return
	end
	StorageMode.TransitionIn = function(oMode, ...)
		self.oStorageMode = oMode
		return fnIn(oMode, ...)
	end
	StorageMode.TransitionOut = function(oMode, ...)
		if self.oStorageMode == oMode then
			self.oStorageMode = nil
		end
		return fnOut(oMode, ...)
	end
end

Kin.Init = function(self, Core)
	self.Core = Core
	Core:AddModulePatch("Managers.HeatMapManager", function(t) self:_PatchHeatMapManager(t) end)
	Core:AddModulePatch("StartScreen.Globe.AnimalStorageHubMode", function(t) self:_PatchStorageMode(t) end)
end
