-----------------------------------------------------------------------
--  Database.PZ2QoLLuaDatabase
--
--  Entry point. Database.Main calls tryrequire("Database.<Pack>LuaDatabase")
--  for every loaded content pack; this module boots PZ2QoL once.
-----------------------------------------------------------------------
local global  = _G
local api     = global.api
local pcall   = global.pcall
local require = global.require

local PZ2QoLLuaDatabase = module(...)

local bOk, sErr = pcall(function()
	require("PZ2QoL.Core"):Boot()
end)
if not bOk then
	pcall(function() api.debug.Trace("[PZ2QoL] boot failed: " .. global.tostring(sErr)) end)
end

-- Runs on the game's startup coroutine, so the UI overlay can be awaited here.
PZ2QoLLuaDatabase.AddContentToCall = function(_tContentToCall)
	local Hub = global.package.loaded["pz2qol.hub"]
	local Core = global.package.loaded["pz2qol.core"]
	if Core then
		Core:Checkpoint("add_content_to_call")
	end
	if Hub then
		local bOk, sErr = pcall(Hub.WaitUntilReady, Hub)
		if not bOk then
			pcall(function() api.debug.Trace("[PZ2QoL] WaitUntilReady failed: " .. global.tostring(sErr)) end)
		end
	end
end
