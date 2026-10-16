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

local function mateIds(animals, nEntity)
	local out = array()
	local bOk, t = pcall(animals.GetMateData, animals, nEntity)
	if bOk and type(t) == "table" and not t.bIsBeta and type(t.tMateData) == "table" then
		for _, m in ipairs(t.tMateData) do
			if m.nID ~= nil then
				out[#out + 1] = idString(m.nID)
			end
		end
	end
	return out
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
	for _, h in ipairs(tHabitats) do
		local bIs = true
		pcall(function() bIs = habitat:IsHabitat(h) ~= false end)
		if bIs then
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
		tIDs = tIDs,
		nIndex = 0,
		tExhibitIDs = tExhibitIDs,
		nExhibitIndex = 0,
		tAnimals = array(),
		tHabitatNames = {},
		tHabitatOrder = {},
		tExhibitNames = {},
		tPresent = {},
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
	return tJob.nIndex >= #tJob.tIDs and tJob.nExhibitIndex >= #tJob.tExhibitIDs
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
		tRec.mates = mateIds(animals, e)
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
		animals = tJob.tAnimals,
		anc = tAnc,
	}
	mark("kin_scan_done")
	self:_SendSnapshot(tJob.oUI, tSnapshot)
end

-- Per species in the scan: { maturity, infertility, life } in years, from
-- the game's fertility bounds (infertility above 900 = never infertile) and
-- longevity. Species data does not change in a session: asked once.
Kin._SpeciesFacts = function(self, tJob)
	local animals = tJob.tAPIs.animals
	self.tSpeciesFacts = self.tSpeciesFacts or {}
	local tOut = {}
	for _, a in ipairs(tJob.tAnimals) do
		local sp = a.species
		if type(sp) == "string" and sp ~= "" and tOut[sp] == nil and string.sub(a.id, 1, 1) ~= "x" then
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
			tOut.habitats[#tOut.habitats + 1] = { id = sH, name = tNames[sH] }
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

-- 'monogamy' | 'polygyny' | 'polyandry' | 'mixed' | nil
Kin._MatingSystem = function(self, animals, sSpecies)
	local tNames = { Monogamy = "monogamy", Polygyny = "polygyny", Polyandre = "polyandry", Polygyandry = "mixed" }
	local rule = call(animals, "GetMonogamyRule", sSpecies)
	if rule ~= nil then
		for sEnum, sName in pairs(tNames) do
			local bOk, v = pcall(function() return animals[sEnum] end)
			if bOk and v ~= nil and v == rule then
				return sName
			end
		end
	end
	-- fallback: the game marks mates of monogamous species
	local tSplit = call(animals, "GetAllAdultsOfSpeciesSplitByGender", sSpecies)
	if type(tSplit) == "table" then
		for _, tList in pairs(tSplit) do
			if type(tList) == "table" then
				for _, e in ipairs(tList) do
					local tMate = call(animals, "GetMateData", e)
					if type(tMate) == "table" and tMate.bIsMonogamous ~= nil then
						return tMate.bIsMonogamous and "monogamy" or nil
					end
				end
			end
		end
	end
	return nil
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
	tOut.mating = self:_MatingSystem(animals, sSpecies)
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
-- The player's own data (habitat assignments...), kept in ONE file in the
-- mod's folder: Win64\ovldata\PZ2QoL\userdata.json. Never in the save or
-- the profile; deleting the mod folder removes it. The UI's localStorage is
-- not written to disk by the game, so it is lost when the game closes.
-- The text is the UI's JSON (ASCII only), stored as it is.
-----------------------------------------------------------------------
-- The game's file calls take its virtual paths: "/run/" is the install
-- folder (the game reads "/run/Blueprints/..."), "/tmp/" a temp folder.
-- Plain OS paths come last, just in case.
Kin.tStorePaths = {
	"/run/Win64/ovldata/PZ2QoL/userdata.json",
	".\\Win64\\ovldata\\PZ2QoL\\userdata.json",
	"Win64/ovldata/PZ2QoL/userdata.json",
	"/tmp/PZ2QoL_userdata.json",
}
Kin.nStoreMax = 400000

local function trimmed(s)
	return (string.gsub(s, "%s+$", ""))
end

local function readFile(sPath)
	local bOk, bRead, sText = pcall(api.debug.ReadStringFromFile, sPath)
	if bOk and bRead and type(sText) == "string" then
		return sText
	end
	return nil
end

-- true, or false and why: 'err' (raised), 'false' (said no), 'diff' (reads back different)
local function writeFile(sPath, sText)
	local bOk, bWrote = pcall(api.debug.WriteStringToFile, sText, sPath)
	if not bOk then
		return false, "err"
	end
	if bWrote == false then
		return false, "false"
	end
	local sBack = readFile(sPath)
	if sBack == nil or trimmed(sBack) ~= trimmed(sText) then
		return false, "diff"
	end
	return true
end

-- The path that works here (found once per session): an existing file,
-- else the first one that writes and reads back. Each try leaves a trace
-- mark (store_p<N>_found / _created / _err / _false / _diff).
Kin._StorePath = function(self)
	if self.sStorePath ~= nil then
		return self.sStorePath or nil
	end
	if type(api.debug) ~= "table" or type(api.debug.ReadStringFromFile) ~= "function" or type(api.debug.WriteStringToFile) ~= "function" then
		self.sStorePath = false
		mark("store_no_api")
		mark("store_unavailable")
		return nil
	end
	for i, sPath in ipairs(self.tStorePaths) do
		if readFile(sPath) ~= nil then
			self.sStorePath = sPath
			mark("store_p" .. i .. "_found")
			mark("store_found")
			return sPath
		end
	end
	for i, sPath in ipairs(self.tStorePaths) do
		local bOk, sWhy = writeFile(sPath, "{}")
		if bOk then
			self.sStorePath = sPath
			mark("store_p" .. i .. "_created")
			mark("store_created")
			return sPath
		end
		mark("store_p" .. i .. "_" .. tostring(sWhy))
	end
	self.sStorePath = false
	mark("store_unavailable")
	return nil
end

-- answers PZ2QoL_StoreData(reqId, ok, part, parts, text): the file in chunks
Kin.StoreLoad = function(self, oUI, sReq)
	local sPath = self:_StorePath()
	local sText = sPath and readFile(sPath) or nil
	if sText == nil then
		pcall(oUI.TriggerEventAtNextAdvance, oUI, "PZ2QoL_StoreData", sReq, false, 1, 1, "")
		return
	end
	local nParts = math.max(1, math.ceil(#sText / self.nChunkSize))
	for i = 1, nParts do
		local sPart = string.sub(sText, (i - 1) * self.nChunkSize + 1, i * self.nChunkSize)
		pcall(oUI.TriggerEventAtNextAdvance, oUI, "PZ2QoL_StoreData", sReq, true, i, nParts, sPart)
	end
end

-- PZ2QoL_StoreSave(reqId, text): replaces the file; answers PZ2QoL_StoreSaved(reqId, ok)
Kin.StoreSave = function(self, oUI, sReq, sText)
	local bOk = false
	if type(sText) == "string" and #sText <= self.nStoreMax and string.sub(sText, 1, 1) == "{" and not string.find(sText, "[^\32-\126\t\r\n]") then
		local sPath = self:_StorePath()
		bOk = sPath ~= nil and writeFile(sPath, sText)
	end
	mark(bOk and "store_saved" or "store_save_failed")
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
			return fnInit(oManager, ...)
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
			if self.oHeatMapManager == oManager then
				self.oHeatMapManager = nil
				self.nLastTick = nil
				self.tJob = nil
				-- entity ids are per park
				self.tStatic = {}
				self.tAncestors = {}
			end
			return fnShutdown(oManager, ...)
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
	Core:AddModulePatch("Managers.HeatMapManager", function(t) self:_PatchHeatMapManager(t) end)
	Core:AddModulePatch("StartScreen.Globe.AnimalStorageHubMode", function(t) self:_PatchStorageMode(t) end)
end
