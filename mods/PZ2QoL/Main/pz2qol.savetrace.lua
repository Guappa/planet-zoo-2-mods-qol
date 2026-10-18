-----------------------------------------------------------------------
--  PZ2QoL.SaveTrace
--
--  Debug builds only: breadcrumbs for the game's autosave chain, to find
--  out why only the first autosave of a session is written (2026-10-16).
--
--  The chain (GameMain Managers.ParkLoadSaveManager):
--    SelectAppropriateAutosaveSlot   registers the engine's autosave
--                                    callback, then OnAutosaveComplete()
--    OnAutosaveComplete(tDetails)    the engine callback after a write;
--                                    starts autosaveCoroutine only if
--                                    none is still alive
--    _SelectAppropriateAutosaveSlot  (in that coroutine) enumerates the
--                                    autosaves and arms the next one with
--                                    api.save.SetAutosave / SetNewAutosave
--  Every wrap calls the original unchanged; nothing is wrapped in a
--  release build.
-----------------------------------------------------------------------
local global = _G
local api    = global.api
local pcall  = global.pcall
local type   = global.type

local SaveTrace = module(...)

SaveTrace._Mark = function(self, sName)
	pcall(self.Core.Mark, self.Core, sName)
end

SaveTrace._PatchManager = function(self, tModule)
	local function wrap(sMethod, fnBefore, fnAfter)
		local fn = tModule[sMethod]
		if type(fn) ~= "function" then
			self:_Mark("save_missing_method")
			return
		end
		tModule[sMethod] = function(oMgr, ...)
			pcall(fnBefore, oMgr, ...)
			local t = global.table.pack(fn(oMgr, ...))
			if fnAfter then
				pcall(fnAfter, oMgr)
			end
			return global.table.unpack(t, 1, t.n)
		end
	end
	wrap("SelectAppropriateAutosaveSlot", function(oMgr)
		self:_Mark("save_arm")
		pcall(self.Core.MarkNumber, self.Core, "save_interval", oMgr.nAutoSaveInterval or -1)
	end)
	wrap("OnAutosaveComplete", function(oMgr, tDetails)
		if tDetails ~= nil then
			self:_Mark(type(tDetails) == "table" and tDetails.exception and "save_cb_error" or "save_cb")
		end
		if oMgr.autosaveCoroutine then
			-- the next autosave will not be armed by this call
			self:_Mark("save_cb_busy")
		end
	end)
	wrap("_SelectAppropriateAutosaveSlot", function()
		self:_Mark("save_select_begin")
	end, function()
		self:_Mark("save_select_end")
	end)
	wrap("ClearAutosaveSlot", function()
		self:_Mark("save_clear")
	end)
	self:_Mark("save_patched")
end

SaveTrace._PatchSaveAPI = function(self)
	local tSave = api.save
	if type(tSave) ~= "table" then
		self:_Mark("save_api_missing")
		return
	end
	local function wrap(sName, sMark, bNumber)
		local fn = tSave[sName]
		if type(fn) ~= "function" then
			return
		end
		pcall(function()
			tSave[sName] = function(...)
				local t = global.table.pack(fn(...))
				if bNumber then
					pcall(self.Core.MarkNumber, self.Core, sMark, t[1])
				else
					self:_Mark(sMark)
				end
				return global.table.unpack(t, 1, t.n)
			end
		end)
	end
	wrap("SetAutosave", "save_api_set")
	wrap("SetNewAutosave", "save_api_setnew")
	wrap("UnsetAutosave", "save_api_unset")
	wrap("ResetAutosaveTimer", "save_api_reset")
	wrap("RequestSave", "save_api_request")
	wrap("GetNumAutosaveSlotsForType", "save_slots", true)
	-- _SelectAppropriateAutosaveSlot gives up with only this trace line
	local tDebug = api.debug
	local fnTrace = tDebug and tDebug.Trace
	if type(fnTrace) == "function" then
		tDebug.Trace = function(sMsg, ...)
			if sMsg == "Failed to enumerate autosaves!" then
				self:_Mark("save_enum_failed")
			end
			return fnTrace(sMsg, ...)
		end
	end
end

SaveTrace.Init = function(self, Core)
	self.Core = Core
	if not Core.bTrace then
		return
	end
	self:_PatchSaveAPI()
	-- does the game see the launch option ParkLoadSaveManager reads?
	pcall(function()
		local tGame = api.game
		self:_Mark(tGame.HasCommandLineArgument("-autosaveinterval") and "save_arg_has" or "save_arg_none")
		local sValue = tGame.GetCommandLineArgument("-autosaveinterval")
		Core:MarkNumber("save_arg", sValue == nil and -1 or (global.tonumber(sValue) or -2))
	end)
	Core:AddModulePatch("Managers.ParkLoadSaveManager", function(t) self:_PatchManager(t) end)
end
