-----------------------------------------------------------------------
--  PZ2QoL.Guards
--
--  Fail-soft guards for crashes in the game's own Lua. Each guard wraps
--  one game function by name, turns a state the game does not handle
--  into one it does, and then calls the original.
--
--  * The game's Move screen (Editors.Animal.AnimalMovementEditMode):
--    SetupAnimalMovementContext counts the selected animals by species,
--    tSpeciesCounts[animals:GetSpeciesFromGUID(guid)]. A selected animal
--    the game no longer knows (moved or sent away while still selected)
--    has no species, and the game dies with "table index is nil"
--    (1.0.4 and 1.0.5, crash 2026-10-16 10:40). The guard marks such a
--    selection as failed verification, the game's own path for animals
--    that can't be moved: it shows "Move failed" and leaves the mode.
-----------------------------------------------------------------------
local global   = _G
local pcall    = global.pcall
local pairs    = global.pairs
local type     = global.type

local Guards = module(...)

-- false when a selected animal has no species any more
local function selectionKnown(oMode)
	local animals = oMode.animalsAPI
	local tSelected = oMode.tSelectedAnimals
	if animals == nil or type(tSelected) ~= "table" then
		return true -- nothing to judge; leave it to the game
	end
	for _, guid in pairs(tSelected) do
		local bOk, sSpecies = pcall(animals.GetSpeciesFromGUID, animals, guid)
		if not bOk or sSpecies == nil then
			return false
		end
	end
	return true
end

Guards._PatchMoveMode = function(self, tModule)
	local fnSetup = tModule.SetupAnimalMovementContext
	if type(fnSetup) ~= "function" then
		self:_Mark("guard_move_missing")
		return
	end
	tModule.SetupAnimalMovementContext = function(oMode, ...)
		if not oMode.bFailedToVerify then
			local bOk, bKnown = pcall(selectionKnown, oMode)
			if bOk and bKnown == false then
				oMode.bFailedToVerify = true
				self:_Stopped()
			end
		end
		return fnSetup(oMode, ...)
	end
	self:_Mark("guard_move_patched")
end

Guards._Stopped = function(self)
	self:_Mark("guard_move_stale")
	local Errors = global.package.loaded["pz2qol.errors"]
	if Errors then
		pcall(Errors.Report, Errors, "mod", "Move cancelled to prevent a crash",
			"One of the selected animals is no longer in the zoo (moved or sent away while it was still selected), "
			.. "which crashes the game's Move screen. Select the animals again and retry.")
	end
end

Guards._Mark = function(self, sName)
	if self.Core then
		pcall(self.Core.Mark, self.Core, sName)
	end
end

Guards.Init = function(self, Core)
	self.Core = Core
	Core:AddModulePatch("Editors.Animal.AnimalMovementEditMode", function(t) self:_PatchMoveMode(t) end)
end
