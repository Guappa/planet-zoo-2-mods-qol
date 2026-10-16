-----------------------------------------------------------------------
--  Database.PZ2HarnessLuaDatabase
--
--  Proof of concept: Database.Main calls
--  tryrequire("Database.<PackName>LuaDatabase") for every loaded content
--  pack, so this module runs inside the game's Lua state at database init.
--  It probes the sandbox and tries to load a native DLL via package.loadlib.
-----------------------------------------------------------------------
local global   = _G
local api      = global.api
local pcall    = global.pcall
local tostring = global.tostring
local type     = global.type
local table    = global.table

local PZ2Harness = module(...)

local function trace(sMsg)
	pcall(function() api.debug.Trace("[PZ2Harness] " .. sMsg) end)
end

local tProbe = {}
local function note(sKey, value)
	tProbe[#tProbe + 1] = sKey .. "=" .. tostring(value)
end

local package = global.package
note("_VERSION", global._VERSION)
note("package", type(package))
note("package.loadlib", package and type(package.loadlib))
note("package.cpath", package and package.cpath)
note("io", type(global.io))
note("os", type(global.os))
note("debug", type(global.debug))
note("loadresource", type(global.loadresource))
note("tryrequire", type(global.tryrequire))
note("api.debug.IsDebugAllowed", pcall(function() return api.debug.IsDebugAllowed() end))

-- Try the native probe from a few plausible working directories.
PZ2Harness.tNativeResults = {}
if package and package.loadlib then
	local tPaths = {
		".\\Win64\\ovldata\\PZ2Harness\\pz2h_native.dll",
		"Win64\\ovldata\\PZ2Harness\\pz2h_native.dll",
		"..\\Win64\\ovldata\\PZ2Harness\\pz2h_native.dll",
		".\\ovldata\\PZ2Harness\\pz2h_native.dll",
	}
	for _, sPath in global.ipairs(tPaths) do
		local fn, sErr, sWhere = package.loadlib(sPath, "pz2h_hello")
		note("loadlib " .. sPath, (fn and "ok") or (tostring(sWhere) .. ": " .. tostring(sErr)))
		if fn then
			pcall(fn)
			break
		end
	end
end

PZ2Harness.sProbe = table.concat(tProbe, "; ")
trace(PZ2Harness.sProbe)

-- Expose the probe so later code (or a debug console) can read it.
pcall(function() api.pz2harness = { sProbe = PZ2Harness.sProbe } end)

PZ2Harness.AddContentToCall = function(_tContentToCall)
	trace("AddContentToCall")
end
