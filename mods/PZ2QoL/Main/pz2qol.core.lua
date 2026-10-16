-----------------------------------------------------------------------
--  PZ2QoL.Core
--
--  Boots the mod once per Lua state. Installs a require hook so game
--  modules are patched the moment they are first loaded (ACSE style),
--  then hands off to the feature modules.
-----------------------------------------------------------------------
local global   = _G
local api      = global.api
local pcall    = global.pcall
local string   = global.string
local tostring = global.tostring
local type     = global.type
local ipairs   = global.ipairs

local Core = module(...)

Core.sVersion = "1.0.0"
Core.bBooted = false

-- lower-cased module name -> list of patch functions(tModule)
Core.tPatches = {}
Core.tPatched = {}

local function trace(sMsg)
	pcall(function() api.debug.Trace("[PZ2QoL] " .. sMsg) end)
end
Core.Trace = trace

-- Debug checkpoints. Only active in a debug build, which ships
-- dbg\cp_<name>.dll files; loading one appends its name to dbg\trace.log.
-- In a normal build loadlib finds nothing and this is a no-op.
Core.sTraceDir = ".\\Win64\\ovldata\\PZ2QoL\\dbg\\"
Core.bTrace = false
Core.tTraced = {}
Core.Checkpoint = function(self, sName)
	if not self.bTrace or self.tTraced[sName] then
		return
	end
	self.tTraced[sName] = true
	pcall(function() global.package.loadlib(self.sTraceDir .. "cp_" .. sName .. ".dll", "*") end)
end

-- Register fnPatch(tModule) to run once when sModuleName is loaded
-- (immediately if it already is).
-- Like Checkpoint, but logs every call (breadcrumbs for crash hunting).
-- The first call loads the DLL (DllMain logs it); later calls use its
-- exported "mark" function.
Core.tMarks = {}
-- Spells a short number into the trace (chr_0..chr_9, chr_minus, chr_dot,
-- then chr_end), for values that have no checkpoint name of their own.
Core.MarkNumber = function(self, sPrefix, n)
	if not self.bTrace then
		return
	end
	self:Mark(sPrefix)
	local s = tostring(n)
	for i = 1, global.math.min(#s, 12) do
		local c = string.sub(s, i, i)
		if c == "-" then
			self:Mark("chr_minus")
		elseif c == "." then
			self:Mark("chr_dot")
		elseif string.find(c, "%d") then
			self:Mark("chr_" .. c)
		end
	end
	self:Mark("chr_end")
end

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
	local tList = self.tPatches[sKey]
	if not tList then
		tList = {}
		self.tPatches[sKey] = tList
	end
	tList[#tList + 1] = fnPatch
	local tLoaded = global.package and global.package.loaded and global.package.loaded[sKey]
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
				trace("patch for " .. sKey .. " failed: " .. tostring(sErr))
				local Errors = global.package.loaded["pz2qol.errors"]
				if Errors then
					Errors:Report("mod", "Patch for " .. sKey .. " failed", tostring(sErr))
				end
			end
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

Core.Boot = function(self)
	if self.bBooted then
		return
	end
	self.bBooted = true
	pcall(function()
		self.bTrace = global.package.loadlib(self.sTraceDir .. "cp_boot.dll", "*") ~= nil
	end)
	self:_InstallRequireHook()
	self:Checkpoint("require_hook")
	for _, sFeature in ipairs({ "PZ2QoL.Errors", "PZ2QoL.Hub", "PZ2QoL.MarketPeek", "PZ2QoL.Kin" }) do
		local bOk, sErr = pcall(function()
			global.require(sFeature):Init(self)
		end)
		self:Checkpoint(bOk and ("init_ok_" .. string.lower(sFeature)) or ("init_fail_" .. string.lower(sFeature)))
		if not bOk then
			trace("feature " .. sFeature .. " failed to init: " .. tostring(sErr))
		end
	end
	self:Checkpoint("booted")
	trace("booted v" .. self.sVersion)
end
