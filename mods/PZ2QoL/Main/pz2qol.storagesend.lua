-----------------------------------------------------------------------
--  PZ2QoL.StorageSend  ("Find a habitat")
--
--  Animal Storage's Send to Zoo (AnimalStorageHubMode.OnSendAnimalsToZoo
--  -> api.planetHub.StorageUISetAnimalsToBeSentToZoo(ids, false), then a
--  world transition back to the zoo) leaves the animals pending in the
--  park. The park's SelectMode then takes them
--  (park:GetAndClearPendingSendToZooEntityIDs) and opens the game's Move
--  screen for all of them at once: BaseUIMode.SetNewMode(
--  "AnimalMovementMode", { tSelectedAnimals = entity ids }), where one
--  click sends every animal to ONE destination.
--
--  When the player started it with the mod's "Find a habitat" button, this
--  module takes that one Move-screen request instead (the same state as the
--  player leaving the Move screen at once) and hands the animals to the
--  park page, which places them one at a time:
--    JS -> Lua  PZ2QoL_SendArm(nCount, bOnline)   (hub, before Send to Zoo)
--    JS -> Lua  PZ2QoL_SendDisarm()               (the game's own button)
--    Lua -> JS  PZ2QoL_SendArrived(nSeq, ids, bOnline)   (park HUD)
--    JS -> Lua  PZ2QoL_SendAck(nSeq) / PZ2QoL_SendHello()
--    JS -> Lua  PZ2QoL_SendFacts(req, id) -> PZ2QoL_SendFactsResult(req, json)
--    JS -> Lua  PZ2QoL_SendMove(req, id, habitat) -> PZ2QoL_SendMoveResult(req, ok, detail)
--  A move is PZ2QoL.Kin's Move: the game's own Move sequence for ONE animal.
--  Fail soft: anything unexpected leaves the game's own Move screen alone.
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

local StorageSend = module(...)

StorageSend.nArmSeconds = 600   -- an arm older than this is ignored
StorageSend.tArm = nil          -- { nCount, nTime, bOnline }
StorageSend.tArrived = nil      -- { nSeq, sIds, bOnline, bAcked }
StorageSend.nSeq = 0
StorageSend.tViews = global.setmetatable({}, { __mode = "k" })

local function trace(sMsg)
	pcall(function() api.debug.Trace("[PZ2QoL] send: " .. sMsg) end)
end

local function mark(sName)
	local Core = global.package.loaded["pz2qol.core"]
	if Core then
		pcall(Core.Mark, Core, sName)
	end
end

local function now()
	local bOk, n = pcall(function()
		return api.time.PerformanceTimeToMilliseconds(api.time.GetPerformanceTimer()) / 1000
	end)
	return bOk and n or 0
end

local function kin()
	return global.package.loaded["pz2qol.kin"]
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
	local tRes = table.pack(pcall(fn, o, ...))
	if not tRes[1] then
		return nil
	end
	return table.unpack(tRes, 2, tRes.n)
end

local function idString(n)
	local Kin = kin()
	if Kin and Kin.IdString then
		return Kin.IdString(n)
	end
	return tostring(n)
end

local function known(v)
	return v ~= nil and v ~= 0 and v ~= "" and v ~= "0"
end

local function entityName(e)
	local bOk, s = pcall(function() return api.ui2.GetEntityName(e) end)
	if bOk and type(s) == "string" and s ~= "" then
		return s
	end
	return nil
end

-- The modded park HUD, when loaded and ready.
StorageSend._ParkUI = function(self)
	local Hub = global.package.loaded["pz2qol.hub"]
	if Hub == nil or not Hub.bHUDIsModded or Hub.oHUDUI == nil then
		return nil
	end
	local oUI = Hub.oHUDUI
	local bOk, bReady = pcall(oUI.IsReady, oUI)
	if bOk and bReady then
		return oUI
	end
	return nil
end

-----------------------------------------------------------------------
-- Taking the game's Move screen request
-----------------------------------------------------------------------
StorageSend._GameMode = function(self)
	local Kin = kin()
	local sMode = "unknown"
	pcall(function()
		sMode = Kin:_GameMode(api.world.GetWorldAPIs())
	end)
	return sMode
end

-- true when this request is the animals the player sent with "Find a
-- habitat" and they are now the mod's to place.
StorageSend._TryTake = function(self, tParams)
	local tArm = self.tArm
	-- the first Move screen request after a send is the one for those
	-- animals; an arm is never used twice
	self.tArm = nil
	if tArm == nil or now() - tArm.nTime > self.nArmSeconds then
		return false
	end
	if type(tParams) ~= "table" or tParams.bIsExhibit or tParams.tReturnUIMode ~= nil or tParams.nReturnManagementScreen ~= nil then
		mark("send_not_ours")
		return false
	end
	local tIDs = tParams.tSelectedAnimals
	if type(tIDs) ~= "table" or #tIDs == 0 or #tIDs > tArm.nCount then
		mark("send_count_mismatch")
		return false
	end
	local tOut = {}
	for _, e in ipairs(tIDs) do
		if type(e) ~= "number" then
			mark("send_not_entities")
			return false
		end
		tOut[#tOut + 1] = idString(e)
	end
	-- Franchise (or unknown): online moves only with the player's consent
	if self:_GameMode() ~= "offline" and not tArm.bOnline then
		mark("send_online_not_allowed")
		return false
	end
	local oUI = self:_ParkUI()
	if oUI == nil or kin() == nil then
		mark("send_no_page")
		return false
	end
	self.nSeq = self.nSeq + 1
	self.tArrived = { nSeq = self.nSeq, sIds = table.concat(tOut, ","), bOnline = tArm.bOnline == true, bAcked = false }
	self:_Deliver(oUI)
	mark("send_taken")
	trace("took " .. #tOut .. " animals from the Move screen")
	return true
end

StorageSend._Deliver = function(self, oUI)
	local t = self.tArrived
	if t == nil or t.bAcked then
		return
	end
	oUI = oUI or self:_ParkUI()
	if oUI ~= nil then
		pcall(oUI.TriggerEventAtNextAdvance, oUI, "PZ2QoL_SendArrived", t.nSeq, t.sIds, t.bOnline)
	end
end

StorageSend._PatchBaseUIMode = function(self, BaseUIMode)
	local fnSetNewMode = BaseUIMode.SetNewMode
	if type(fnSetNewMode) ~= "function" then
		trace("BaseUIMode has no SetNewMode; Find a habitat off")
		mark("send_patch_missing")
		return
	end
	BaseUIMode.SetNewMode = function(sMode, tParams, ...)
		if sMode == "AnimalMovementMode" and self.tArm ~= nil then
			local bOk, bTaken = pcall(self._TryTake, self, tParams)
			if bOk and bTaken then
				return
			end
			if not bOk then
				trace("take failed: " .. tostring(bTaken))
			end
		end
		return fnSetNewMode(sMode, tParams, ...)
	end
	mark("send_patched")
end

-----------------------------------------------------------------------
-- One animal: what the page needs to pick a habitat
-----------------------------------------------------------------------
local function locationKind(animals, e)
	local n = call(animals, "GetCurrentLocationType", e)
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

StorageSend.Facts = function(self, oUI, sReq, sId)
	local Kin = kin()
	local function answer(t)
		pcall(oUI.TriggerEventAtNextAdvance, oUI, "PZ2QoL_SendFactsResult", sReq, Kin and Kin.Encode(t) or "null")
	end
	local tAPIs = Kin and Kin:_ParkWorld() or nil
	if tAPIs == nil or tAPIs.animals == nil then
		return answer({ id = tostring(sId), error = "nopark" })
	end
	local animals = tAPIs.animals
	local e = tonumber(sId)
	local tOut = { id = tostring(sId), mode = Kin:_GameMode(tAPIs) }
	local sSpecies = e and call(animals, "GetSpecies", e)
	local guid = e and call(animals, "EntityIDToAnimalGUID", e)
	if sSpecies == nil or not known(guid) then
		tOut.gone = true
		return answer(tOut)
	end
	tOut.species = sSpecies
	tOut.name = call(animals, "GetName", e) or ""
	tOut.alive = call(animals, "IsAlive", e) ~= false
	tOut.lt = locationKind(animals, e)
	local tTransport = call(animals, "GetAnimalTransportData", e)
	tOut.moving = type(tTransport) == "table" and tTransport.bHasTransportJob == true
	local nAssigned = call(animals, "GetAssignedHabitatEntityID", e)
	tOut.assigned = known(nAssigned) and idString(nAssigned) or ""
	-- the game is still waiting on a Franchise server request
	local bBusy = call(tAPIs.franchise, "IsDatabaseOperationInProgress")
	tOut.busy = bBusy == true
	-- where its parents live (a juvenile belongs with its mother)
	local tParentHabs = Kin.Array()
	local tParentSeen = {}
	local tParents = call(animals, "GetParents", guid)
	if type(tParents) == "table" then
		for _, pg in pairs(tParents) do
			if known(pg) then
				local pe = call(animals, "AnimalGUIDToEntityID", pg)
				if known(pe) and call(animals, "IsAlive", pe) ~= false then
					local ph = call(animals, "GetAssignedHabitatEntityID", pe)
					if known(ph) and not tParentSeen[idString(ph)] then
						tParentSeen[idString(ph)] = true
						tParentHabs[#tParentHabs + 1] = idString(ph)
					end
				end
			end
		end
	end
	tOut.parentHabs = tParentHabs
	-- every finished habitat: may it go there (the Move screen's own checks),
	-- can a keeper reach it, and who lives there
	local habitat = tAPIs.habitat
	local tHabitats = call(habitat, "GetAllCompleteHabitats")
	if type(tHabitats) ~= "table" then
		tHabitats = call(habitat, "GetHabitats") or {}
	end
	local tList = Kin.Array()
	local tSeen = {}
	for _, h in pairs(tHabitats) do
		local sH = idString(h)
		if not tSeen[sH] then
			tSeen[sH] = true
			local bOk, sReason = Kin:_HabitatOk(tAPIs, h, { guid })
			local tHab = { id = sH, name = entityName(h) or ("Habitat " .. sH), ok = bOk == true, reason = sReason }
			if bOk then
				tHab.reach = call(tAPIs.staff, "CanStaffDeliverAnimalToFacility", e, h) ~= false
				tHab.crowded = call(habitat, "IsHabitatTooCrowded", h) == true
				local tMembers = call(habitat, "GetAnimalsInHabitat", h)
				local nTotal, nSame = 0, 0
				if type(tMembers) == "table" then
					for _, m in ipairs(tMembers) do
						nTotal = nTotal + 1
						if call(animals, "GetSpecies", m) == sSpecies then
							nSame = nSame + 1
						end
					end
				end
				tHab.total = nTotal
				tHab.same = nSame
			end
			tList[#tList + 1] = tHab
		end
	end
	tOut.habitats = tList
	answer(tOut)
end

-- ONE move: PZ2QoL.Kin's Move (the game's own Move sequence for one animal).
StorageSend.Move = function(self, oUI, sReq, sId, sHab)
	local function answer(bOk, sDetail)
		mark(bOk and "send_move_ok" or "send_move_failed")
		pcall(oUI.TriggerEventAtNextAdvance, oUI, "PZ2QoL_SendMoveResult", sReq, bOk == true, sDetail or "")
	end
	local Kin = kin()
	if Kin == nil then
		return answer(false, "The mod's move code is not loaded.")
	end
	if tonumber(sHab) == nil then
		return answer(false, "Unknown habitat.")
	end
	local bAnswered = false
	local tProxy = {
		TriggerEventAtNextAdvance = function(_, _, _, bOk, sDetail)
			bAnswered = true
			answer(bOk == true, sDetail)
		end,
	}
	local bOk, sErr = pcall(Kin.Move, Kin, tProxy, sReq, tostring(sId), tostring(sHab))
	if not bAnswered then
		answer(false, bOk and "No answer from the move." or ("The move failed: " .. tostring(sErr)))
	end
end

-----------------------------------------------------------------------
-- Wiring
-----------------------------------------------------------------------
StorageSend.Attach = function(self, oUI)
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
		oUI:AddEventListener("PZ2QoL_SendArm", 2, guard("arm", function(nCount, bOnline)
			local n = tonumber(nCount)
			if n ~= nil and n > 0 then
				self.tArm = { nCount = n, nTime = now(), bOnline = bOnline == true }
				mark("send_armed")
			end
		end), self)
		oUI:AddEventListener("PZ2QoL_SendDisarm", 0, guard("disarm", function()
			self.tArm = nil
		end), self)
		oUI:AddEventListener("PZ2QoL_SendHello", 0, guard("hello", function()
			self:_Deliver(oUI)
		end), self)
		oUI:AddEventListener("PZ2QoL_SendAck", 1, guard("ack", function(nSeq)
			if self.tArrived ~= nil and tonumber(nSeq) == self.tArrived.nSeq then
				self.tArrived.bAcked = true
			end
		end), self)
		oUI:AddEventListener("PZ2QoL_SendFacts", 2, guard("facts", function(sReq, sId)
			self:Facts(oUI, sReq, sId)
		end), self)
		oUI:AddEventListener("PZ2QoL_SendMove", 3, guard("move", function(sReq, sId, sHab)
			self:Move(oUI, sReq, sId, sHab)
		end), self)
	end)
	if not bOk then
		trace("listeners failed: " .. tostring(sErr))
	end
	mark(bOk and "send_attached" or "send_attach_failed")
end

StorageSend.Init = function(self, Core)
	self.Core = Core
	Core:AddModulePatch("Editors.Shared.BaseUIMode", function(t) self:_PatchBaseUIMode(t) end)
end
