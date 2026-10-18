-----------------------------------------------------------------------
--  MyMod.Core
--
--  Boots once. Installs a require hook (ACSE style) so a game module can
--  be patched the moment it is first loaded:
--
--      Core:AddModulePatch("Game.GameScript", function(tModule) ... end)
--
--  Two kinds of game module load with a private copy of require taken
--  before any mod runs, so the require hook alone misses them:
--    - park managers (Environment._LoadManagerModule), and
--    - world modes (GameHelpers.ModeHelper.SetModes).
--  Core hooks both, so AddModulePatch works for those too.
--
--  Logging: the retail game shows no Lua output (no io library, and
--  api.debug.Trace goes nowhere). Core:Mark("name") loads
--  dbg\cp_<name>.dll if it exists; that DLL appends a line to
--  dbg\trace.log (see trace\README.txt). Without a dbg folder every
--  Mark is a silent no-op, so release builds just leave it out.
-----------------------------------------------------------------------
local global   = _G
local api      = global.api
local pcall    = global.pcall
local string   = global.string
local tostring = global.tostring
local type     = global.type
local ipairs   = global.ipairs
local pairs    = global.pairs

local Core = module(...)

Core.bBooted = false
Core.tPatches = {}   -- lower-case module name -> { fnPatch(tModule), ... }
Core.tPatched = {}

-- The game's working directory is the install folder.
Core.sTraceDir = ".\\Win64\\ovldata\\MyMod\\dbg\\"
Core.bTrace = false
Core.tMarks = {}

Core.Trace = function(self, sMsg)
	pcall(function() api.debug.Trace("[MyMod] " .. tostring(sMsg)) end)
end

-- One line in dbg\trace.log per call. The first call for a name loads the
-- DLL (its DllMain logs); later calls use its exported "mark" function.
-- A name without a dbg\cp_<name>.dll logs nothing.
Core.Mark = function(self, sName)
	if not self.bTrace then
		return
	end
	local fn = self.tMarks[sName]
	if fn == nil then
		local bOk, f = pcall(global.package.loadlib, self.sTraceDir .. "cp_" .. sName .. ".dll", "mark")
		self.tMarks[sName] = (bOk and type(f) == "function") and f or false
		return
	end
	if fn then
		pcall(fn)
	end
end

Core.AddModulePatch = function(self, sModuleName, fnPatch)
	local sKey = string.lower(sModuleName)
	self.tPatches[sKey] = self.tPatches[sKey] or {}
	local tList = self.tPatches[sKey]
	tList[#tList + 1] = fnPatch
	local tLoaded = global.package.loaded[sKey]
	if type(tLoaded) == "table" then
		self:_ApplyPatches(sKey, tLoaded)
	end
end

Core._ApplyPatches = function(self, sKey, tModule)
	local tList = self.tPatches[sKey]
	if not tList or type(tModule) ~= "table" then
		return
	end
	self.tPatched[sKey] = self.tPatched[sKey] or {}
	for i, fnPatch in ipairs(tList) do
		if not self.tPatched[sKey][i] then
			self.tPatched[sKey][i] = true
			local bOk, sErr = pcall(fnPatch, tModule)
			if not bOk then
				self:Trace("patch for " .. sKey .. " failed: " .. tostring(sErr))
				self:Mark("patch_failed")
			end
		end
	end
end

Core.ApplyLoadedPatches = function(self)
	for sKey in pairs(self.tPatches) do
		local tModule = global.package.loaded[sKey]
		if type(tModule) == "table" then
			self:_ApplyPatches(sKey, tModule)
		end
	end
end

Core._InstallRequireHook = function(self)
	local fnRequire = global.require
	local fnTryRequire = global.tryrequire
	local function after(sName, tModule)
		if type(sName) == "string" and type(tModule) == "table" then
			local sKey = string.lower(sName)
			if self.tPatches[sKey] then
				self:_ApplyPatches(sKey, tModule)
			end
		end
		return tModule
	end
	global.require = function(sName, ...)
		return after(sName, fnRequire(sName, ...))
	end
	if fnTryRequire then
		global.tryrequire = function(sName, ...)
			return after(sName, fnTryRequire(sName, ...))
		end
	end
end

-- Park managers: patch them as each one loads, before its instance exists
-- (the environment caches each manager's Advance etc. when it creates it).
Core._PatchEnvironment = function(self, Environment)
	local fnLoad = Environment._LoadManagerModule
	if type(fnLoad) ~= "function" then
		return
	end
	Environment._LoadManagerModule = function(oEnv, sName, ...)
		local tModule = fnLoad(oEnv, sName, ...)
		if type(sName) == "string" and type(tModule) == "table" then
			self:_ApplyPatches(string.lower(sName), tModule)
		end
		return tModule
	end
end

-- World modes: require them through the hook and sweep, before the
-- first mode instance exists.
Core._PatchModeHelper = function(self, ModeHelper)
	local fnSetModes = ModeHelper.SetModes
	if type(fnSetModes) ~= "function" then
		return
	end
	ModeHelper.SetModes = function(oHelper, tModes, ...)
		if type(tModes) == "table" then
			for _, sModule in pairs(tModes) do
				if type(sModule) == "string" then
					pcall(global.require, sModule)
				end
			end
		end
		pcall(self.ApplyLoadedPatches, self)
		return fnSetModes(oHelper, tModes, ...)
	end
end

Core.Boot = function(self)
	if self.bBooted then
		return
	end
	self.bBooted = true
	pcall(function()
		self.bTrace = global.package.loadlib(self.sTraceDir .. "cp_boot.dll", "*") ~= nil
	end)
	self:_InstallRequireHook()
	self:AddModulePatch("Environment.Environment", function(t) self:_PatchEnvironment(t) end)
	self:AddModulePatch("GameHelpers.ModeHelper", function(t) self:_PatchModeHelper(t) end)
	for _, sFeature in ipairs({ "MyMod.Example" }) do
		local bOk, sErr = pcall(function() global.require(sFeature):Init(self) end)
		if not bOk then
			self:Trace("feature " .. sFeature .. " failed: " .. tostring(sErr))
			self:Mark("feature_failed")
		end
	end
	self:Mark("booted")
end
