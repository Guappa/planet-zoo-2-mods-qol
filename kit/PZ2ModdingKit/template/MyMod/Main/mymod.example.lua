-----------------------------------------------------------------------
--  MyMod.Example
--
--  Two patterns to copy:
--    1. Wrap a game function: call the original, keep its results, and
--       put anything of your own inside pcall so a mistake never breaks
--       the game.
--    2. A per-frame tick in a park: Managers.HeatMapManager is a park
--       manager whose Advance runs every frame.
--
--  Find functions worth wrapping in the decompiled scripts
--  (tools\pz2_unpack.py). Wrap by module and function name, never by
--  offset, and check the function exists first: game updates rename
--  things.
-----------------------------------------------------------------------
local global = _G
local pcall  = global.pcall
local type   = global.type
local table  = global.table

local Example = module(...)

Example.Init = function(self, Core)
	self.Core = Core
	Core:AddModulePatch("Managers.HeatMapManager", function(tModule)
		self:_WrapAdvance(tModule)
	end)
end

Example._WrapAdvance = function(self, tModule)
	local fnAdvance = tModule.Advance
	if type(fnAdvance) ~= "function" then
		self.Core:Mark("example_no_advance")
		return
	end
	local bFirst = true
	tModule.Advance = function(oManager, ...)
		local tResults = table.pack(fnAdvance(oManager, ...))
		if bFirst then
			bFirst = false
			pcall(self.Core.Mark, self.Core, "example_first_park_tick")
		end
		-- your per-frame park code goes here, inside pcall
		return table.unpack(tResults, 1, tResults.n)
	end
	self.Core:Mark("example_patched")
end
