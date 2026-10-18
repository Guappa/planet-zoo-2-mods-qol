-----------------------------------------------------------------------
--  Database.MyModLuaDatabase
--
--  Entry point. For every content pack in Win64\ovldata, the game's
--  Database.Main calls tryrequire("Database.<PackName>LuaDatabase").
--  The file name must be database.<packname>luadatabase.lua (lower case).
--
--  Code at module load runs inside require: it must not yield.
--  AddContentToCall runs on the game's startup coroutine: it may yield.
-----------------------------------------------------------------------
local global  = _G
local api     = global.api
local pcall   = global.pcall
local require = global.require

local MyModLuaDatabase = module(...)

local bOk, sErr = pcall(function()
	require("MyMod.Core"):Boot()
end)
if not bOk then
	pcall(function() api.debug.Trace("[MyMod] boot failed: " .. global.tostring(sErr)) end)
end

MyModLuaDatabase.AddContentToCall = function(_tContentToCall)
	local Core = global.package.loaded["mymod.core"]
	if Core then
		Core:Mark("add_content_to_call")
	end
end
