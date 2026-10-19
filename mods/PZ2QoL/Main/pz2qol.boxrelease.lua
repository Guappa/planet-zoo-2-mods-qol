-----------------------------------------------------------------------
--  PZ2QoL.BoxRelease  ("Let out stuck aquarium animals")
--
--  The game boxes aquarium animals by itself (native SOS code) and, unlike
--  land animals, never lets them out again: they sit in the box until the
--  player clicks Unbox, and their welfare drops meanwhile (proven on Y:
--  2026-10-19, docs/RESEARCH-aquarium-boxing.md). This module does that
--  click for the player, hands-free, Franchise included (developer's
--  decision 2026-10-19; on by default, a Kin setting turns it off).
--
--  What counts as stuck (all read in the same tick, from animals the
--  habitat lists right now; reading an animal kept from an earlier tick
--  can crash the game, debugging.md):
--    in an aquarium, or a deep swimmer in any habitat;
--    IsAnimalBoxed, IsAnimalUnboxableByPlayer;
--    not IsBoxingClaimed (no staff or move at work), no transport job,
--    not IsAnimalRequestingBoxed / IsAnimalRequestingUnboxed (the game is
--    still busy with it), not IsBoxWaitingForNavMeshRebuild, not escaped;
--    and it stayed like that for nWaitSeconds.
--  The release is the game's own Unbox button: ClaimBoxing, then
--  UnboxAnimal (components.ui.animalinfopopup.lua, HabitatUtils.
--  UnboxAllAnimalsInHabitat). One animal at a time, nGapSeconds apart,
--  from SelectMode.Advance (the park's main mode, where the game's own
--  buttons run; not the worker-thread manager tick).
--  An animal boxed again soon after each of nMaxQuick releases is left
--  alone for nRestSeconds and the page shows a Needs-you alert.
--
--  JS -> Lua  PZ2QoL_ReleaseSet(bOn)
--  Lua -> JS  PZ2QoL_ReleaseEvent(sKind, nId, sSpecies, nCount)
--             sKind "gaveup" only (a release itself shows nothing)
-----------------------------------------------------------------------
local global   = _G
local api      = global.api
local pcall    = global.pcall
local type     = global.type
local tostring = global.tostring
local pairs    = global.pairs
local ipairs   = global.ipairs
local math     = global.math
local table    = global.table

local BoxRelease = module(...)

BoxRelease.bOn = true
BoxRelease.nScanSeconds = 3
BoxRelease.nWaitSeconds = 30    -- stuck this long before the mod lets it out
BoxRelease.nGapSeconds = 2      -- between two releases
BoxRelease.nQuickSeconds = 120  -- boxed again within this after a release: "quick"
BoxRelease.nMaxQuick = 3        -- quick re-boxings before the mod gives up for a while
BoxRelease.nRestSeconds = 600

BoxRelease.tStuck = {}     -- e -> first time seen stuck (cleared when not)
BoxRelease.tHistory = {}   -- e -> { at = last release, quick = n, restUntil = t }
BoxRelease.tViews = {}
BoxRelease.nLastScan = 0
BoxRelease.nLastRelease = -1e9
BoxRelease.oAnimals = nil  -- the park's animals API at the last scan (a new park clears the state)

local function now()
	local bOk, n = pcall(function()
		return api.time.PerformanceTimeToMilliseconds(api.time.GetPerformanceTimer()) / 1000
	end)
	return bOk and n or 0
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

BoxRelease._Mark = function(self, sName)
	if self.Core then
		pcall(self.Core.Mark, self.Core, sName)
	end
end

BoxRelease._Log = function(self, sEvent, tData)
	if self.Core then
		pcall(self.Core.Log, self.Core, "release", sEvent, tData)
	end
end

BoxRelease._Send = function(self, sKind, e, sSpecies, n)
	for oUI in pairs(self.tViews) do
		local bOk = pcall(oUI.TriggerEventAtNextAdvance, oUI, "PZ2QoL_ReleaseEvent", sKind, e, sSpecies or "", n or 0)
		if not bOk or oUI.view == nil then
			self.tViews[oUI] = nil
		end
	end
end

-- Is e (listed in habitat h this tick) boxed and left there by the game?
BoxRelease._IsStuck = function(self, animals, e, bAquarium)
	if call(animals, "IsAnimalBoxed", e) ~= true then
		return false
	end
	if not bAquarium and call(animals, "DoesAnimalDeepSwim", e) ~= true then
		return false
	end
	if call(animals, "IsBoxingClaimed", e) == true
		or call(animals, "IsAnimalRequestingBoxed", e) == true
		or call(animals, "IsAnimalRequestingUnboxed", e) == true
		or call(animals, "IsBoxWaitingForNavMeshRebuild", e) == true
		or call(animals, "IsEscaped", e) == true then
		return false
	end
	local tTransport = call(animals, "GetAnimalTransportData", e)
	if type(tTransport) == "table" and tTransport.bHasTransportJob == true then
		return false
	end
	return call(animals, "IsAnimalUnboxableByPlayer", e) == true
end

-- The game's own Unbox button: claim, then unbox.
BoxRelease._Release = function(self, animals, e, sSpecies, nNow)
	if call(animals, "ClaimBoxing", e) ~= true then
		self:_Log("claim_refused", { e = e, species = sSpecies })
		return false
	end
	local bOk = pcall(animals.UnboxAnimal, animals, e)
	if not bOk then
		pcall(animals.ReleaseBoxing, animals, e)
		self:_Log("unbox_failed", { e = e, species = sSpecies })
		return false
	end
	local tHist = self.tHistory[e] or { quick = 0 }
	self.tHistory[e] = tHist
	tHist.at = nNow
	self.nLastRelease = nNow
	self:_Mark("release_unboxed")
	-- no notice for a release (developer, 2026-10-19): only the trace logs it
	self:_Log("unboxed", { e = e, species = sSpecies, quick = tHist.quick })
	return true
end

BoxRelease._Scan = function(self, nNow)
	local bOk, tAPIs = pcall(function() return api.world.GetWorldAPIs() end)
	if not bOk or type(tAPIs) ~= "table" then
		return
	end
	local animals, habitat = tAPIs.animals, tAPIs.habitat
	if animals == nil or habitat == nil then
		return
	end
	if animals ~= self.oAnimals then
		-- a new park: entity ids mean other animals now
		self.oAnimals = animals
		self.tStuck = {}
		self.tHistory = {}
	end
	local tHabitats = call(habitat, "GetHabitats")
	if type(tHabitats) ~= "table" then
		return
	end
	local tSeen = {}
	local tDue = nil
	for _, h in ipairs(tHabitats) do
		local bAquarium = call(habitat, "IsAquarium", h) == true
		local tAnimals = call(habitat, "GetAnimalsInHabitat", h)
		if type(tAnimals) == "table" then
			for _, e in ipairs(tAnimals) do
				if not tSeen[e] and self:_IsStuck(animals, e, bAquarium) then
					tSeen[e] = true
					local nFirst = self.tStuck[e]
					if nFirst == nil then
						nFirst = nNow
						self.tStuck[e] = nNow
						-- boxed again soon after our release
						local tHist = self.tHistory[e]
						if tHist and tHist.at and nNow - tHist.at < self.nQuickSeconds then
							tHist.quick = tHist.quick + 1
							if tHist.quick >= self.nMaxQuick then
								tHist.restUntil = nNow + self.nRestSeconds
								tHist.quick = 0
								local sSpecies = call(animals, "GetSpecies", e)
								self:_Mark("release_gave_up")
								self:_Log("gave_up", { e = e, species = sSpecies, rest = self.nRestSeconds })
								self:_Send("gaveup", e, sSpecies, self.nMaxQuick)
							end
						end
					end
					local tHist = self.tHistory[e]
					local bResting = tHist and tHist.restUntil and nNow < tHist.restUntil
					if not bResting and tDue == nil and nNow - nFirst >= self.nWaitSeconds then
						tDue = e
					end
				end
			end
		end
	end
	for e in pairs(self.tStuck) do
		if not tSeen[e] then
			self.tStuck[e] = nil
		end
	end
	if tDue ~= nil and nNow - self.nLastRelease >= self.nGapSeconds then
		-- still listed and stuck this tick: release it now
		local sSpecies = call(animals, "GetSpecies", tDue)
		if self:_Release(animals, tDue, sSpecies, nNow) then
			self.tStuck[tDue] = nil
		end
	end
end

BoxRelease.Tick = function(self)
	if not self.bOn then
		return
	end
	local nNow = now()
	if nNow - self.nLastScan < self.nScanSeconds then
		return
	end
	self.nLastScan = nNow
	self:_Scan(nNow)
end

BoxRelease._PatchSelectMode = function(self, SelectMode)
	local fnAdvance = SelectMode.Advance
	if type(fnAdvance) ~= "function" then
		self:_Mark("release_no_tick")
		return
	end
	SelectMode.Advance = function(oMode, ...)
		local tRes = table.pack(fnAdvance(oMode, ...))
		local bOk, sErr = pcall(self.Tick, self)
		if not bOk and not self.bTickErrorLogged then
			self.bTickErrorLogged = true
			self:_Log("error", { err = tostring(sErr) })
		end
		return table.unpack(tRes, 1, tRes.n)
	end
	self:_Mark("release_patched")
end

BoxRelease.Set = function(self, bOn)
	self.bOn = bOn ~= false
	self.tStuck = {}
	self:_Mark(self.bOn and "release_on" or "release_off")
	self:_Log("set", { on = self.bOn })
end

BoxRelease.Attach = function(self, oUI)
	if oUI == nil or self.tViews[oUI] then
		return
	end
	self.tViews[oUI] = true
	pcall(function()
		oUI:AddEventListener("PZ2QoL_ReleaseSet", 1, function(_, bOn)
			pcall(self.Set, self, bOn)
		end, self)
	end)
end

BoxRelease.Init = function(self, Core)
	self.Core = Core
	Core:AddModulePatch("Editors.Select.SelectMode", function(t) self:_PatchSelectMode(t) end)
end
