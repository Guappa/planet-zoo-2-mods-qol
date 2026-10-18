-----------------------------------------------------------------------
--  PZ2QoL.Lister  (the Market desk's listing engine)
--
--  Lists storage animals on the Franchise market one at a time, sending
--  exactly what the game's own Trade -> Confirm sends: that event,
--  AnimalStorage_AddToMarket(key, price, hours), is a one-line pass-through
--  to api.planetHub.StorageUIStartAnimalAuction(key, price, hours)
--  (animalstoragehubmode.lua, 1.0.5). Storage row keys (animal_<n>) are
--  positions the native reassigns on rebuilds, so the engine works on
--  GUIDs (StorageGetIDAndAIDType(key) -> guid, 2) and checks key -> GUID
--  in the same Lua tick as the call: a rebuilt list can never make it list
--  another animal.
--
--  Per animal, a per-frame state machine in AnimalStorageHubMode.Advance:
--    server    wait until the game has no server request running (10 s)
--    resolve   the animal's current key; skip gone/listed/moving/elderly/juvenile
--    select    select it natively (local) and wait for the game's data (5 s)
--    selected  settle 0.3 s, then tradeAllowed, price and hours
--    send      not busy, key -> GUID and selection again, then the game's call
--    confirm   the row's auctionTimerSeconds > 0, or a request-42 server error
--    pause     the player's pace after every animal that reached the server
--  Only ever started by the player's click (PZ2QoL_ListerStart). A step
--  that fails skips that animal and the run carries on; only the player's
--  Stop (or leaving Animal Storage) ends a run early.
--  The selection and its data (tradeAllowed, limits) are read by the page
--  while the engine selects (PZ2QoL_ListerWatch -> PZ2QoL_ListerSeen): in
--  game, Lua's own DataStore reads never saw the selection (Y: 2026-10-17).
--  Lua's reads stay the fallback when the page does not report.
--  Protocol: docs/DESIGN-market-desk.md. Offline: the DataStore shapes read
--  here come from the decompiled game and its UI code; the trace marks
--  lister_* are there to prove them in game.
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
local math     = global.math

local Lister = module(...)

Lister.nVersion = 1          -- protocol version (the job's "v1")
Lister.nListingRequest = 42  -- request type of a listing (seen in game)
Lister.nGuidType = 2         -- StorageGetIDAndAIDType's type for most storage animals
Lister.tTypeMarked = {}       -- other id types seen (traced once each)
Lister.nServerTimeout = 10   -- s to wait for the game's other server requests
Lister.nRequestsGrace = 2    -- s RequestsInProgress alone is waited on (it may count background polls; guess)
Lister.nSelectTimeout = 5    -- s to wait for the selection's data
Lister.nSettle = 0.6         -- s after the selection's data appears (the native may write it in parts)
Lister.nClearWait = 1        -- s to wait for the cleared selection to show empty
Lister.nResettles = 3        -- times the data may change under a send before the animal is skipped
Lister.nSameSettle = 1.5     -- s to wait when the data still equals what was there before selecting
Lister.nQuiet = 3            -- s the server must stay idle after a timed-out listing (late errors)
Lister.nConfirmTimeout = 30  -- s to wait for the listing to show
Lister.nConfirmPoll = 0.25   -- s between two looks at the row
Lister.nLateConfirm = 8      -- s more after DidNotGetResponse
Lister.nRejectGrace = 3      -- s more after Unknown or an unnamed code
Lister.nStateInterval = 1    -- s between state updates while waiting
Lister.nPageFresh = 0.6      -- s a page report of the selection counts (the page reads every ~0.1 s)
Lister.nWatchResend = 1      -- s without a report before the watch is asked for again
Lister.nPaceMin = 1000       -- ms: the pause after every server request
Lister.nPaceMax = 10000
Lister.nPaceDefault = 3000
Lister.nMaxKeys = 5000       -- per Resolve

Lister.oStorageMode = nil    -- the active AnimalStorageHubMode, if any
Lister.tRun = nil            -- the run in progress
Lister.tLast = nil           -- the last run that ended
Lister.nRuns = 0
Lister.nPaceMs = Lister.nPaceDefault
Lister.nLastServer = nil     -- when the last listing's outcome came (the pace runs from there)
Lister.tViews = global.setmetatable({}, { __mode = "k" })

local function trace(sMsg)
	pcall(function() api.debug.Trace("[PZ2QoL] lister: " .. sMsg) end)
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

-- tonumber(nil) raises in Lua 5.3
local function toNumber(v)
	local n = nil
	if type(v) == "number" then
		n = v
	elseif type(v) == "string" then
		n = tonumber(v)
	end
	if n == nil or n ~= n or n == math.huge or n == -math.huge then
		return nil
	end
	return n
end

local function toInteger(n)
	n = math.floor(n)
	return math.tointeger(n) or n
end

-----------------------------------------------------------------------
-- JSON (a copy of Kin's small encoder, plus an explicit null)
-----------------------------------------------------------------------
local ARRAY = {}
local function array(t)
	return global.setmetatable(t or {}, ARRAY)
end
local NULL = global.setmetatable({}, {})

local tEscapes = { ['"'] = '\\"', ["\\"] = "\\\\", ["\b"] = "\\b", ["\f"] = "\\f", ["\n"] = "\\n", ["\r"] = "\\r", ["\t"] = "\\t" }

local function encodeString(s)
	s = tostring(s)
	if not string.find(s, '[%c"\\\128-\255]') then
		return '"' .. s .. '"'
	end
	local tOut = {}
	local bOk = pcall(function()
		for _, c in global.utf8.codes(s) do
			if c < 32 then
				tOut[#tOut + 1] = string.format("\\u%04x", c)
			elseif c < 128 then
				local ch = string.char(c)
				tOut[#tOut + 1] = tEscapes[ch] or ch
			elseif c < 0x10000 then
				tOut[#tOut + 1] = string.format("\\u%04x", c)
			else
				c = c - 0x10000
				tOut[#tOut + 1] = string.format("\\u%04x\\u%04x", 0xD800 + (c >> 10), 0xDC00 + (c & 0x3FF))
			end
		end
	end)
	if not bOk then
		-- not valid UTF-8: keep printable ASCII only
		tOut = {}
		for i = 1, #s do
			local b = string.byte(s, i)
			local ch = string.char(b)
			if b < 32 or b > 126 then
				tOut[#tOut + 1] = "?"
			else
				tOut[#tOut + 1] = tEscapes[ch] or ch
			end
		end
	end
	return '"' .. table.concat(tOut) .. '"'
end

local encode
encode = function(v, tOut)
	local t = type(v)
	if v == nil or v == NULL then
		tOut[#tOut + 1] = "null"
	elseif t == "boolean" then
		tOut[#tOut + 1] = v and "true" or "false"
	elseif t == "number" then
		if v ~= v or v == math.huge or v == -math.huge then
			tOut[#tOut + 1] = "null"
		elseif math.type(v) == "integer" then
			tOut[#tOut + 1] = string.format("%d", v)
		else
			tOut[#tOut + 1] = string.format("%.6g", v)
		end
	elseif t == "string" then
		tOut[#tOut + 1] = encodeString(v)
	elseif t == "table" then
		if global.getmetatable(v) == ARRAY or (#v > 0 and v[1] ~= nil) then
			tOut[#tOut + 1] = "["
			for i = 1, #v do
				if i > 1 then tOut[#tOut + 1] = "," end
				encode(v[i], tOut)
			end
			tOut[#tOut + 1] = "]"
		else
			tOut[#tOut + 1] = "{"
			local bFirst = true
			for k, x in pairs(v) do
				if not bFirst then tOut[#tOut + 1] = "," end
				bFirst = false
				tOut[#tOut + 1] = encodeString(k)
				tOut[#tOut + 1] = ":"
				encode(x, tOut)
			end
			tOut[#tOut + 1] = "}"
		end
	else
		tOut[#tOut + 1] = "null"
	end
end

local function toJson(v)
	local tOut = {}
	encode(v, tOut)
	return table.concat(tOut)
end
Lister.Encode = toJson

-- Ids as strings, the same way as Kin: an integer-valued float (77.0)
-- prints like the integer (77), so GUIDs from different calls match.
local function idString(n)
	if type(n) == "number" and math.type(n) == "float" and n == math.floor(n) and math.abs(n) < 2 ^ 63 then
		return string.format("%d", n)
	end
	return tostring(n)
end

-----------------------------------------------------------------------
-- The game's calls and data
-----------------------------------------------------------------------
local function hubFn(sName)
	local hub = api.planetHub
	if type(hub) ~= "table" then
		return nil
	end
	local fn = hub[sName]
	return type(fn) == "function" and fn or nil
end

local function ui2Fn(sName)
	local ui2 = api.ui2
	if type(ui2) ~= "table" then
		return nil
	end
	local fn = ui2[sName]
	return type(fn) == "function" and fn or nil
end

-- The calls the engine cannot run without.
local tNeeded = {
	{ "planetHub", "StorageGetIDAndAIDType" }, { "planetHub", "StorageUIStartAnimalAuction" },
	{ "planetHub", "StorageUISelectItem" }, { "planetHub", "StorageUIClearSelectedItems" },
	{ "ui2", "GetNoCreateDataStoreContext" }, { "ui2", "GetDataStoreElement" }, { "ui2", "GetDataStoreContextAsTable" },
}

-- A DataStore context only if the game made it: the mod never creates one.
-- The (root, child, ...) form is what MainHUD uses; if a build refuses it,
-- the root by name (the hub page always has hubAnimalsData and
-- animalTradeListingData) and each child without creating it, the form
-- GenealogyPopup uses.
local function context(sRoot, ...)
	local fnNoCreate = ui2Fn("GetNoCreateDataStoreContext")
	if fnNoCreate == nil then
		return nil
	end
	local bOk, c = pcall(fnNoCreate, sRoot, ...)
	if bOk and c ~= nil then
		return c
	end
	-- refused, or no context by that path form: the root by name (the
	-- native makes these two on the hub page), then each child without
	-- creating it
	local fnGet = ui2Fn("GetDataStoreContext")
	if fnGet == nil then
		return nil
	end
	bOk, c = pcall(fnGet, sRoot)
	if not bOk or c == nil then
		return nil
	end
	for _, sChild in ipairs({ ... }) do
		bOk, c = pcall(fnNoCreate, c, sChild)
		if not bOk or c == nil then
			return nil
		end
	end
	return c
end

local function element(ctx, sName)
	local fn = ui2Fn("GetDataStoreElement")
	if ctx == nil or fn == nil then
		return nil
	end
	local bOk, v = pcall(fn, ctx, sName)
	if bOk then
		return v
	end
	return nil
end

local function asTable(ctx)
	local fn = ui2Fn("GetDataStoreContextAsTable")
	if ctx == nil or fn == nil then
		return nil
	end
	local bOk, t = pcall(fn, ctx)
	if bOk and type(t) == "table" then
		return t
	end
	return nil
end

-- The id StorageUISelectItem takes for a storage row: the row's own `id`
-- field (what a click on the row sends with ItemSelected), else the row key.
-- In game the two differ (Y: 2026-10-17, lister_id_differs): selecting by
-- the row key selected another animal (lister_page_sel_other), as the old
-- page lister's select-by-id never did. StorageGetIDAndAIDType, the listing
-- call and selectedAnimalIDs take the row key (by id the GUID lookup found
-- nothing in game: "Nothing to list").
local function nativeId(sKey)
	if sKey == nil then
		return nil
	end
	local fn = ui2Fn("GetDataStoreElement")
	local fnCtx = ui2Fn("GetNoCreateDataStoreContext")
	if fn ~= nil and fnCtx ~= nil then
		local bOk, ctx = pcall(fnCtx, "hubAnimalsData", "animalStorageData", "list", sKey)
		if bOk and ctx ~= nil then
			local bOk2, v = pcall(fn, ctx, "id")
			if bOk2 and (type(v) == "string" or type(v) == "number") then
				local s = idString(v)
				if s ~= "" then
					if s ~= sKey and not Lister.bIdMarked then
						Lister.bIdMarked = true
						mark("lister_id_differs")
					end
					return s
				end
			end
		end
	end
	return sKey
end

-- The animal behind a storage row key, as a stable token: its GUID as an
-- exact decimal string (type 2, most animals), else "t<type>_<id>" for the
-- other id types StorageGetIDAndAIDType gives (CompareMatesUIUtils: 4
-- exhibit animal GUID, 5 exhibit listing UID, 6 exchange id, ...). In game
-- only type 2 was accepted and some animals could never be identified
-- ("Nothing to list", js_lister_nothing_noid, Y: 2026-10-17). The token is
-- only the run's identity anchor: listing still goes by the row key.
local function guidOf(sKey)
	local fn = hubFn("StorageGetIDAndAIDType")
	if fn == nil or sKey == nil then
		return nil
	end
	local bOk, nID, nType = pcall(fn, sKey)
	if not bOk or nID == nil then
		return nil
	end
	local s = idString(nID)
	if s == "" or s == "0" or not string.match(s, "^%-?%d+$") then
		return nil
	end
	if nType == Lister.nGuidType then
		return s
	end
	local n = toNumber(nType)
	if n == nil then
		return nil
	end
	if not Lister.tTypeMarked[n] then
		Lister.tTypeMarked[n] = true
		mark(n >= 0 and n <= 7 and ("lister_idtype_" .. string.format("%d", n)) or "lister_idtype_other")
	end
	return "t" .. string.format("%d", n) .. "_" .. s
end

-- A list entry's row key: the table key, or the row's id if the list came
-- back as an array (guess: the game's tables are keyed by child name).
local function rowKey(k, tRow)
	if type(k) == "string" then
		return k
	end
	if type(tRow) == "table" and type(tRow.id) == "string" then
		return tRow.id
	end
	return nil
end

local tRowFields = { "auctionTimerSeconds", "isMoving", "maturity", "name", "species", "gender", "selected" }

-- One row's fields: from the list table if there is one, else from the
-- row's own context (cheap; used while confirming).
local function rowOf(sKey, tList)
	if tList ~= nil then
		local tRow = tList[sKey]
		if type(tRow) == "table" then
			return tRow
		end
		for k, t in pairs(tList) do
			if type(t) == "table" and rowKey(k, t) == sKey then
				return t
			end
		end
		return nil
	end
	local ctx = context("hubAnimalsData", "animalStorageData", "list", sKey)
	if ctx == nil then
		return nil
	end
	local tRow, bAny = {}, false
	for _, s in ipairs(tRowFields) do
		tRow[s] = element(ctx, s)
		bAny = bAny or tRow[s] ~= nil
	end
	return bAny and tRow or nil
end

-- The game's own "on the market" test (MarketAnimalListItem.isOnMarket).
local function isListed(tRow)
	local n = tRow and toNumber(tRow.auctionTimerSeconds)
	return n ~= nil and n > 0
end

local function onlySelected(tSel, sKey)
	return tSel ~= nil and #tSel == 1 and tSel[1] == sKey
end

Lister._List = function(self)
	return asTable(context("hubAnimalsData", "animalStorageData", "list"))
end

-- The storage selection as a list of row keys, or nil when it can't be read.
Lister._Selection = function(self)
	local v = element(context("hubAnimalsData", "animalStorageData"), "selectedAnimalIDs")
	if type(v) ~= "table" then
		v = asTable(context("hubAnimalsData", "animalStorageData", "selectedAnimalIDs"))
	end
	if type(v) ~= "table" then
		return nil
	end
	local tOut = {}
	for _, x in pairs(v) do
		if type(x) == "string" or type(x) == "number" then
			tOut[#tOut + 1] = idString(x)
		end
	end
	return tOut
end

-- Whether this row is the selection: true / false, or nil when the game's
-- data can't tell. The row's own `selected` flag (what draws its highlight)
-- comes first: in game selectedAnimalIDs read from Lua stayed empty while the
-- animal was selected on screen (Y: trace 2026-10-17, every animal skipped
-- "unselectable"). selectedAnimalIDs is the fallback, and also says when
-- another animal is selected too.
Lister._SelState = function(self, sKey, bMark)
	local tSel = self:_Selection()
	local bOther = false
	if tSel ~= nil then
		for _, s in ipairs(tSel) do
			if s ~= sKey then
				bOther = true
			end
		end
	end
	local bFlag = element(context("hubAnimalsData", "animalStorageData", "list", sKey), "selected")
	if type(bFlag) == "boolean" then
		-- once the flag says selected: did the array say so too?
		if bMark and bFlag and not self.bFlagMarked then
			self.bFlagMarked = true
			mark(tSel ~= nil and #tSel > 0 and "lister_sel_array_ok" or "lister_sel_array_empty")
		end
		if bFlag and bOther then
			-- the array names another animal too: a multi-selection
			mark("lister_sel_other")
			return false
		end
		return bFlag
	end
	if tSel == nil then
		return nil
	end
	if #tSel == 0 then
		return nil
	end
	return onlySelected(tSel, sKey)
end

-- The native's limits for the selected animal.
Lister._Limits = function(self)
	local ctx = context("animalTradeListingData")
	return {
		nPriceMin = toNumber(element(ctx, "tradePriceMin")),
		nPriceMax = toNumber(element(ctx, "tradePriceMax")),
		nPriceDefault = toNumber(element(ctx, "tradePriceDefault")),
		nHoursMin = toNumber(element(ctx, "tradeDurationMin")),
		nHoursMax = toNumber(element(ctx, "tradeDurationMax")),
		nHoursDefault = toNumber(element(ctx, "tradeDurationDefault")),
	}
end

-----------------------------------------------------------------------
-- Page-assisted reads: while the engine selects, the page (listerlua.js)
-- reads the selection, tradeAllowed and the limits from its DataStore and
-- reports them. The format is plain text (the mod's Lua has no JSON
-- decoder; listercore.js encodeSeen):
--   v1|<key>|<selected keys, comma-separated, or ?>|<allowed 1/0/->|
--   <priceMin,priceMax,priceDefault,hoursMin,hoursMax,hoursDefault, - for
--   none>|<reason, the rest of the text>
-----------------------------------------------------------------------
local function parseSeen(s)
	if type(s) ~= "string" then
		return nil
	end
	local sKey, sSel, sAllowed, sLimits, sReason = string.match(s, "^v1|([^|]*)|([^|]*)|([^|]*)|([^|]*)|(.*)$")
	if sKey == nil or sKey == "" then
		return nil
	end
	local tSel = nil
	if sSel ~= "?" then
		tSel = {}
		for x in string.gmatch(sSel, "[^,]+") do
			tSel[#tSel + 1] = x
		end
	end
	local tN = {}
	for x in string.gmatch(sLimits .. ",", "([^,]*),") do
		tN[#tN + 1] = toNumber(x)
	end
	local bAllowed = nil
	if sAllowed == "1" then
		bAllowed = true
	elseif sAllowed == "0" then
		bAllowed = false
	end
	return {
		sKey = sKey, tSel = tSel, bAllowed = bAllowed, sReason = sReason,
		tLimits = { nPriceMin = tN[1], nPriceMax = tN[2], nPriceDefault = tN[3], nHoursMin = tN[4], nHoursMax = tN[5], nHoursDefault = tN[6] },
	}
end
Lister.ParseSeen = parseSeen

-- The freshest page report for this key under the current watch (read
-- after the select or clear it watches), or nil: none, stale, another
-- key, or a page that could not read the selection.
Lister._PageReport = function(self, tRun, sKey)
	local r = tRun and tRun.tSeen
	if r == nil or r.sReq ~= tRun.sWatchReq or r.sKey ~= sKey or r.tSel == nil then
		return nil
	end
	if now() - r.nAt > self.nPageFresh then
		return nil
	end
	return r
end

-- Whether sKey is the only selection: the page's report when there is a
-- fresh one ("page"), else Lua's own reads ("lua"; true / false / nil).
Lister._IsSelected = function(self, tRun, sKey, bMark)
	local r = self:_PageReport(tRun, sKey)
	if r ~= nil then
		return onlySelected(r.tSel, sKey), "page"
	end
	return self:_SelState(sKey, bMark), "lua"
end

-- Asks the page to report what it sees for sKey (a new request id: older
-- reports never count for it), or to stop (sKey nil).
Lister._Watch = function(self, tRun, sKey)
	if sKey == nil then
		if tRun.sWatchReq ~= nil then
			tRun.sWatchReq = nil
			self:_Send(tRun.oUI, "PZ2QoL_ListerWatch", "", "")
		end
		return
	end
	tRun.nWatchSeq = (tRun.nWatchSeq or 0) + 1
	tRun.sWatchReq = "w" .. tostring(tRun.nId) .. "_" .. tRun.nWatchSeq
	tRun.sWatchKey = sKey
	tRun.nWatchSent = now()
	self:_Send(tRun.oUI, "PZ2QoL_ListerWatch", tRun.sWatchReq, sKey)
end

-- PZ2QoL_ListerSeen: the page's report, kept with its arrival time.
Lister.OnSeen = function(self, sReq, sText)
	local tRun = self.tRun
	if tRun == nil or tRun.sWatchReq == nil or tostring(sReq or "") ~= tRun.sWatchReq then
		return
	end
	local r = parseSeen(sText)
	if r == nil then
		if not tRun.bSeenBadMarked then
			tRun.bSeenBadMarked = true
			mark("lister_page_bad")
		end
		return
	end
	r.sReq = tRun.sWatchReq
	r.nAt = now()
	tRun.tSeen = r
	if not tRun.bPageSeen then
		tRun.bPageSeen = true
		mark("lister_page_seen")
	end
end

-- Once per run, when the page first shows the selection and its data
-- complete: what Lua's own reads showed at that moment (to settle why they
-- failed in game).
Lister._Diag = function(self, tRun, sKey)
	if tRun.bDiagDone then
		return
	end
	tRun.bDiagDone = true
	local bFlag = element(context("hubAnimalsData", "animalStorageData", "list", sKey), "selected")
	mark(bFlag == true and "lister_diag_flag_true" or bFlag == false and "lister_diag_flag_false" or "lister_diag_flag_nil")
	local tSel = self:_Selection()
	if tSel == nil then
		mark("lister_diag_arr_nil")
	elseif #tSel == 0 then
		mark("lister_diag_arr_empty")
	elseif onlySelected(tSel, sKey) then
		mark("lister_diag_arr_key")
	else
		mark("lister_diag_arr_other")
	end
	local bAllowed = element(context("hubAnimalsData", "animalStorageData", "actions"), "tradeAllowed")
	mark(type(bAllowed) == "boolean" and "lister_diag_allowed_bool" or "lister_diag_allowed_nil")
	local l = self:_Limits()
	mark((l.nPriceMin ~= nil and l.nPriceMax ~= nil) and "lister_diag_limits_ok" or "lister_diag_limits_none")
end

Lister._Franchise = function(self)
	local oMode = self.oStorageMode
	local bOk, t = pcall(function() return oMode.tWorldAPIs.franchise end)
	return bOk and t or nil
end

-- true / false, or nil when the hub type can't be read.
Lister._Online = function(self)
	local franchise = self:_Franchise()
	if franchise == nil then
		return nil
	end
	local bOk, n, nOnline = pcall(function()
		return franchise:GetPlanetHubType(), franchise.PlanetHubType_FranchiseOnline
	end)
	if not bOk or n == nil or nOnline == nil then
		return nil
	end
	return n == nOnline
end

-- Whether the game is waiting on a server request (and which signal said so).
Lister._Busy = function(self)
	local franchise = self:_Franchise()
	if franchise ~= nil then
		local bOk, bBusy = pcall(function() return franchise:IsDatabaseOperationInProgress() end)
		if bOk and bBusy == true then
			return true, "db"
		end
		local bOk2, v = pcall(function()
			if type(franchise.RequestsInProgress) ~= "function" then
				return nil
			end
			return franchise:RequestsInProgress()
		end)
		if bOk2 and (v == true or (type(v) == "number" and v > 0) or (type(v) == "table" and global.next(v) ~= nil)) then
			return true, "requests"
		end
	end
	-- the storage screen's own spinner (the vanilla guard against a second request)
	local ctx = context("hubAnimalsData", "network")
	if ctx ~= nil then
		if element(ctx, "connectingAction") == true then
			return true, "connecting"
		end
		if element(ctx, "loadingItems") == true then
			return true, "loading"
		end
	end
	-- the mod's own market check
	local MarketPeek = global.package.loaded["pz2qol.marketpeek"]
	local tPeek = type(MarketPeek) == "table" and MarketPeek.tPeek or nil
	if type(tPeek) == "table" and tPeek.sState == "requested" then
		return true, "peek"
	end
	return false
end

Lister._Missing = function(self)
	local tOut = array()
	for _, t in ipairs(tNeeded) do
		local fn = t[1] == "ui2" and ui2Fn(t[2]) or hubFn(t[2])
		if fn == nil then
			tOut[#tOut + 1] = "api." .. t[1] .. "." .. t[2]
		end
	end
	return tOut
end

-----------------------------------------------------------------------
-- Job, price and hours
-----------------------------------------------------------------------
-- "v1 <paceMs>\n<guid> <key> <price> <hours>\n..." -> tAnimals, nPaceMs
-- (or nil, sError). A GUID listed twice is listed once.
local function parseJob(sJob)
	if type(sJob) ~= "string" then
		return nil, "No job was sent."
	end
	local tAnimals, tSeen = {}, {}
	local nPace = nil
	local nLine = 0
	for sLine in string.gmatch(sJob .. "\n", "([^\n]*)\n") do
		sLine = string.match(sLine, "^%s*(.-)%s*$")
		if sLine ~= "" then
			nLine = nLine + 1
			if nLine == 1 then
				local sPace = string.match(sLine, "^v1%s+(%d+)$")
				if sPace == nil then
					return nil, "Unknown job format (expected v1)."
				end
				nPace = tonumber(sPace)
			else
				local sGuid, sKey, sPrice, sHours = string.match(sLine, "^(%S+)%s+(%S+)%s+(%S+)%s+(%S+)$")
				local nPrice = sPrice ~= "-" and toNumber(sPrice) or nil
				local vHours = (sHours == "max" or sHours == "default") and sHours or toNumber(sHours)
				-- GUIDs as guidOf prints them: decimal, or another plain token
				if sGuid == nil or not string.match(sGuid, "^[%w_%.:%-]+$") or (sPrice ~= "-" and nPrice == nil) or vHours == nil then
					return nil, "Bad job line " .. nLine .. "."
				end
				if not tSeen[sGuid] then
					tSeen[sGuid] = true
					tAnimals[#tAnimals + 1] = { sGuid = sGuid, sHint = sKey ~= "-" and sKey or nil, nPrice = nPrice, vHours = vHours }
				end
			end
		end
	end
	if nPace == nil then
		return nil, "Unknown job format (expected v1)."
	end
	if #tAnimals == 0 then
		return nil, "No animals to list."
	end
	return tAnimals, nPace
end
Lister.ParseJob = parseJob

-- nPrice (integer, inside the game's limits), sCapped, bUsedDefault; nPrice
-- nil when there is no usable price.
local function priceFor(nJob, tLimits)
	local nPrice, bDefault = nJob, false
	if nPrice == nil then
		nPrice, bDefault = tLimits.nPriceDefault, true
	end
	if nPrice == nil or not (nPrice > 0) then
		return nil, nil, bDefault
	end
	nPrice = math.floor(nPrice + 0.5)
	local sCapped = nil
	if tLimits.nPriceMin ~= nil and nPrice < math.ceil(tLimits.nPriceMin) then
		nPrice, sCapped = math.ceil(tLimits.nPriceMin), "min"
	end
	if tLimits.nPriceMax ~= nil and nPrice > math.floor(tLimits.nPriceMax) then
		nPrice, sCapped = math.floor(tLimits.nPriceMax), "max"
	end
	if nPrice < 1 then
		return nil, nil, bDefault
	end
	return toInteger(nPrice), sCapped, bDefault
end

-- Whole hours inside the game's limits: "max" -> the longest, "default" ->
-- the game's default, a number -> clamped.
local function hoursFor(vJob, tLimits)
	local nMin, nMax, nDefault = tLimits.nHoursMin, tLimits.nHoursMax, tLimits.nHoursDefault
	local n
	if vJob == "max" then
		n = nMax or nDefault or nMin or 1
	elseif vJob == "default" then
		n = nDefault or nMax or nMin or 1
	else
		n = vJob
		if nMin ~= nil and n < nMin then n = nMin end
		if nMax ~= nil and n > nMax then n = nMax end
	end
	n = math.floor(n)
	if n < 1 then
		n = 1
	end
	return toInteger(n)
end

Lister._ClampPace = function(self, v)
	local n = toNumber(v)
	if n == nil then
		return self.nPaceMs
	end
	if n < self.nPaceMin then n = self.nPaceMin end
	if n > self.nPaceMax then n = self.nPaceMax end
	return toInteger(n)
end

-----------------------------------------------------------------------
-- Talking to the page
-----------------------------------------------------------------------
Lister._Send = function(self, oUI, sEvent, ...)
	if oUI == nil then
		local Hub = global.package.loaded["pz2qol.hub"]
		oUI = Hub and Hub.bFrontEndIsModded and Hub.oFrontEndUI or nil
	end
	if oUI ~= nil then
		pcall(oUI.TriggerEventAtNextAdvance, oUI, sEvent, ...)
	end
end

Lister._State = function(self, tRun, sMessage)
	local t = now()
	local nWaited = 0
	if tRun.sPhase == "running" then
		local nFrom = tRun.sStep == "pause" and tRun.nPauseStart or tRun.nStepStart
		if nFrom ~= nil and t > nFrom then
			nWaited = toInteger(t - nFrom)
		end
	end
	local tResults = array()
	for i, r in ipairs(tRun.tResults) do
		tResults[i] = {
			guid = r.guid, status = r.status, kind = r.kind or NULL, price = r.price or NULL,
			hours = r.hours or NULL, capped = r.capped or NULL, usedDefault = r.usedDefault == true,
			detail = r.detail or "",
		}
	end
	return {
		run = tRun.nId, req = tRun.sReq, phase = tRun.sPhase, total = #tRun.tResults,
		index = tRun.nIndex - 1, step = tRun.sPhase == "running" and tRun.sStep or "",
		waited = nWaited, paceMs = self.nPaceMs, message = sMessage or tRun.sMessage or "",
		results = tResults,
	}
end

Lister._Emit = function(self, tRun, sMessage, oUI)
	tRun.bDirty = false
	tRun.nLastEmit = now()
	self:_Send(oUI or tRun.oUI, "PZ2QoL_ListerState", toJson(self:_State(tRun, sMessage)))
end

-- A Start that does not start: its own state, run 0, refused.
Lister._Refuse = function(self, oUI, sReq, sMessage, sPhase)
	mark("lister_start_refused")
	trace("start refused: " .. tostring(sMessage))
	self:_Send(oUI, "PZ2QoL_ListerState", toJson({
		run = 0, req = sReq, phase = sPhase or "done", refused = true, total = 0, index = 0, step = "",
		waited = 0, paceMs = self.nPaceMs, message = sMessage, results = array(),
	}))
end

-----------------------------------------------------------------------
-- The run
-----------------------------------------------------------------------
local tResultMarks = { listed = "lister_listed", refused = "lister_refused", timeout = "lister_timeout", skipped = "lister_skip" }

local tSkipText = {
	gone = "No longer in storage (sold, moved or filtered out).",
	listed = "Already on the market.",
	moving = "Being moved.",
	elderly = "Elderly and no longer fertile: the market won't take it.",
	juvenile = "A juvenile: the market won't take it.",
	unselectable = "The game did not select it in time.",
	changed = "The storage list changed just before listing; not listed.",
	busy = "The game was still busy with another server request; not listed.",
	noprice = "No price (and the game has no default for it).",
	untradeable = "The game does not allow trading it.",
}

-- The steps the page watches the selection in.
local tWatchSteps = { clear = true, select = true, selected = true, send = true }

Lister._SetStep = function(self, tRun, sStep, sMessage)
	if not tWatchSteps[sStep] then
		self:_Watch(tRun, nil)
	end
	tRun.sStep = sStep
	tRun.nStepStart = now()
	tRun.sMessage = sMessage or ""
	tRun.bDirty = true
	if tRun.tCur ~= nil then
		tRun.tCur.sBusyMarked = nil
	end
end

Lister._Begin = function(self, tRun)
	local tJob = tRun.tAnimals[tRun.nIndex]
	tRun.tCur = { sGuid = tJob.sGuid, sHint = tJob.sHint, nPrice = tJob.nPrice, vHours = tJob.vHours }
	tRun.tResults[tRun.nIndex].status = "working"
	self:_SetStep(tRun, "server")
end

Lister._Summary = function(self, tRun)
	local nListed = 0
	for _, r in ipairs(tRun.tResults) do
		if r.status == "listed" then
			nListed = nListed + 1
		end
	end
	return "Listed " .. nListed .. " of " .. #tRun.tResults .. "."
end

Lister._Next = function(self, tRun)
	if tRun.nIndex > #tRun.tAnimals then
		return self:_End(tRun, "done", self:_Summary(tRun))
	end
	self:_Begin(tRun)
end

-- The current animal's outcome; then its pause, or straight on.
Lister._Result = function(self, tRun, sStatus, sKind, sDetail)
	local tCur = tRun.tCur
	local tRes = tRun.tResults[tRun.nIndex]
	tRes.status = sStatus
	tRes.kind = sKind
	tRes.detail = sDetail or ""
	tRun.tCur = nil
	tRun.nIndex = tRun.nIndex + 1
	tRun.bDirty = true
	mark(tResultMarks[sStatus] or "lister_skip")
	-- a listing that timed out may still be answered (late errors): the
	-- next one waits for a quiet server first
	if tCur ~= nil and tCur.bSent and sStatus == "timeout" then
		tRun.bNeedQuiet = true
	end
	if tCur ~= nil and tCur.bSent then
		-- it reached the server: the player's pause before anything else is sent
		self.nLastServer = now()
		if tRun.nIndex <= #tRun.tAnimals then
			tRun.nPauseStart = self.nLastServer
			return self:_SetStep(tRun, "pause", "Pausing between listings.")
		end
	end
	self:_Next(tRun)
end

Lister._Skip = function(self, tRun, sKind, sDetail)
	-- why, in the trace (lister_skip alone said nothing)
	mark(tSkipText[sKind] ~= nil and ("lister_skip_" .. tostring(sKind)) or "lister_skip_other")
	return self:_Result(tRun, "skipped", sKind, sDetail or tSkipText[sKind])
end

Lister._End = function(self, tRun, sPhase, sMessage)
	local tCur = tRun.tCur
	if tCur ~= nil then
		local tRes = tRun.tResults[tRun.nIndex]
		if tCur.bSent then
			-- it reached the server: one last look, else it may still appear
			local bOk, bListed = pcall(self._IsListed, self, tCur)
			if bOk and bListed then
				tRes.status, tRes.kind, tRes.detail = "listed", nil, ""
				mark("lister_listed")
			else
				tRes.status, tRes.kind = "stopped", "stopped"
				tRes.detail = (sPhase == "closed" and "Animal Storage was closed" or "Stopped")
					.. " while waiting for the server; it may still appear on the market."
			end
			tRun.nIndex = tRun.nIndex + 1
			self.nLastServer = now()
		else
			-- nothing was sent for it: it stays to do
			tRes.status, tRes.kind, tRes.detail = "pending", nil, ""
			tRes.price, tRes.hours, tRes.capped, tRes.usedDefault = nil, nil, nil, nil
		end
		tRun.tCur = nil
	end
	self:_Watch(tRun, nil)
	tRun.sPhase = sPhase
	tRun.sStep = ""
	tRun.sMessage = sMessage or ""
	if self.tRun == tRun then
		self.tRun = nil
	end
	self.tLast = tRun
	mark(sPhase == "closed" and "lister_closed" or "lister_run_end")
	trace("run " .. tostring(tRun.nId) .. " " .. sPhase .. ": " .. tostring(sMessage))
	self:_Emit(tRun)
end

Lister._MarkBusy = function(self, tRun, sWhy)
	local tCur = tRun.tCur
	if tCur ~= nil and tCur.sBusyMarked ~= tRun.sStep then
		tCur.sBusyMarked = tRun.sStep
		mark("lister_busy_" .. tostring(sWhy))
	end
end

-- The animal's key now: the last key it had, the page's hint, then the list.
Lister._Find = function(self, tCur, tList)
	local sGuid = tCur.sGuid
	if tCur.sKey ~= nil and guidOf(tCur.sKey) == sGuid then
		return tCur.sKey
	end
	if tCur.sHint ~= nil and tCur.sHint ~= tCur.sKey and guidOf(tCur.sHint) == sGuid then
		return tCur.sHint
	end
	if tList == nil then
		return nil
	end
	for k, tRow in pairs(tList) do
		local sKey = type(tRow) == "table" and rowKey(k, tRow) or nil
		if sKey ~= nil and sKey ~= tCur.sKey and sKey ~= tCur.sHint and guidOf(sKey) == sGuid then
			return sKey
		end
	end
	return nil
end

Lister._IsListed = function(self, tCur)
	if tCur.sKey ~= nil and guidOf(tCur.sKey) == tCur.sGuid then
		return isListed(rowOf(tCur.sKey, nil) or rowOf(tCur.sKey, self:_List()))
	end
	-- the list was rebuilt: find the animal again
	local tList = self:_List()
	local sKey = self:_Find(tCur, tList)
	if sKey == nil then
		return false
	end
	tCur.sKey = sKey
	return isListed(rowOf(sKey, tList))
end

-- The game's data for the selection: nil and what is missing until it is
-- there (selection = {key} when readable, tradeAllowed written, and the
-- limits when allowed).
-- sSrc in the result says whose reads it is: "page" (a fresh page report,
-- the authority when there is one) or "lua" (Lua's own reads, the fallback).
local function limitsMissing(tLimits)
	return tLimits.nPriceMin == nil or tLimits.nPriceMax == nil or (tLimits.nHoursMax == nil and tLimits.nHoursDefault == nil)
end

Lister._SelectionData = function(self, tCur, tRun)
	local r = self:_PageReport(tRun, tCur.sKey)
	if r ~= nil then
		if not onlySelected(r.tSel, tCur.sKey) then
			return nil, "selection"
		end
		if type(r.bAllowed) ~= "boolean" then
			return nil, "allowed"
		end
		if r.bAllowed and limitsMissing(r.tLimits) then
			return nil, "limits"
		end
		self:_Diag(tRun, tCur.sKey)
		return { bAllowed = r.bAllowed, sReason = r.sReason, tLimits = r.tLimits, sSrc = "page" }
	end
	local bSel = self:_SelState(tCur.sKey, true)
	if bSel == nil then
		if not tCur.bSelUnknown then
			tCur.bSelUnknown = true
			mark("lister_sel_unknown")
		end
	elseif not bSel then
		return nil, "selection"
	end
	local ctx = context("hubAnimalsData", "animalStorageData", "actions")
	local bAllowed = element(ctx, "tradeAllowed")
	if type(bAllowed) ~= "boolean" then
		return nil, "allowed"
	end
	local tLimits = self:_Limits()
	if bAllowed and limitsMissing(tLimits) then
		return nil, "limits"
	end
	return { bAllowed = bAllowed, sReason = element(ctx, "tradeDisallowedReason"), tLimits = tLimits, sSrc = "lua" }
end

-- The selection's data as one string, to see whether it changed under us.
local function dataPrint(tData)
	local l = tData.tLimits
	return table.concat({ tostring(tData.bAllowed), tostring(l.nPriceMin), tostring(l.nPriceMax), tostring(l.nPriceDefault),
		tostring(l.nHoursMin), tostring(l.nHoursMax), tostring(l.nHoursDefault) }, "|")
end

-- The same for whatever the game shows now, selection or not, and whose
-- reads it is (the fresh page report for this key, else Lua's own).
Lister._RawPrint = function(self, tRun, sKey)
	local r = self:_PageReport(tRun, sKey)
	if r ~= nil then
		return dataPrint(r), "page"
	end
	local bAllowed = element(context("hubAnimalsData", "animalStorageData", "actions"), "tradeAllowed")
	return dataPrint({ bAllowed = bAllowed, tLimits = self:_Limits() }), "lua"
end

local tUnselectableText = {
	selection = "The game did not select it in time.",
	allowed = "The game did not say whether it can be traded in time.",
	limits = "The game did not give its price limits in time.",
}

-- Skips unselectable, saying (and marking) which of the game's data never
-- came, and what the page last saw for it (none, the key, another, empty).
Lister._Unselectable = function(self, tRun, sWhy)
	mark("lister_unsel_" .. tostring(sWhy))
	local r = tRun.tSeen
	local tCur = tRun.tCur
	if r == nil or r.sReq ~= tRun.sWatchReq then
		mark("lister_page_none")
	elseif r.tSel == nil then
		mark("lister_page_sel_unread")
	elseif tCur ~= nil and onlySelected(r.tSel, tCur.sKey) then
		mark("lister_page_sel_key")
	elseif #r.tSel == 0 then
		mark("lister_page_sel_empty")
	else
		mark("lister_page_sel_other")
	end
	return self:_Skip(tRun, "unselectable", tUnselectableText[sWhy])
end

-- One animal's step on this frame. Errors are caught by Tick.
Lister._Step = function(self, tRun, t)
	local tCur = tRun.tCur
	if tRun.sStep == "server" then
		local bBusy, sWhy = self:_Busy()
		-- RequestsInProgress alone may stay on for background polls (the old
		-- page lister only ever asked IsDatabaseOperationInProgress): short wait
		if bBusy and sWhy == "requests" and (tRun.bRequestsIgnored or t - tRun.nStepStart > self.nRequestsGrace) then
			if not tRun.bRequestsIgnored then
				tRun.bRequestsIgnored = true
				mark("lister_busy_requests_ignored")
			end
			bBusy = false
		end
		if bBusy then
			tRun.nIdleSince = nil
			self:_MarkBusy(tRun, sWhy)
			if t - tRun.nStepStart > self.nServerTimeout then
				return self:_Skip(tRun, "busy")
			end
			tRun.sMessage = "Waiting for the game's other server requests."
			return
		end
		if tRun.bNeedQuiet then
			tRun.nIdleSince = tRun.nIdleSince or t
			if t - tRun.nIdleSince < self.nQuiet then
				tRun.sMessage = "Letting the server settle after a timeout."
				return
			end
			tRun.bNeedQuiet = false
			mark("lister_quiet")
		end
		self:_SetStep(tRun, "resolve")
	end
	if tRun.sStep == "resolve" then
		local tList = self:_List()
		if tList == nil and not tCur.bListMarked then
			tCur.bListMarked = true
			mark("lister_list_unreadable")
		end
		local sKey = self:_Find(tCur, tList)
		if sKey == nil then
			return self:_Skip(tRun, "gone", tList == nil and "Not found (the storage list could not be read)." or nil)
		end
		local tRow = rowOf(sKey, tList)
		if tRow ~= nil then
			if isListed(tRow) then
				return self:_Skip(tRun, "listed")
			end
			if tRow.isMoving == true then
				return self:_Skip(tRun, "moving")
			end
			-- EAnimalMaturity: 0 infant, 6 elderly and infertile
			local nMaturity = toNumber(tRow.maturity)
			if nMaturity == 6 then
				return self:_Skip(tRun, "elderly")
			end
			if nMaturity == 0 then
				return self:_Skip(tRun, "juvenile")
			end
		end
		tCur.sKey = sKey
		-- clear first and see it clear, so the previous animal's data
		-- can't pass for this one's (local calls, no server request)
		api.planetHub.StorageUIClearSelectedItems()
		tCur.nClearedAt = t
		self:_SetStep(tRun, "clear", "Selecting it.")
		-- the page reports what it sees from here on
		self:_Watch(tRun, sKey)
		return
	end
	if tRun.sStep == "clear" then
		local bStill
		local r = self:_PageReport(tRun, tCur.sKey)
		if r ~= nil then
			bStill = #r.tSel > 0
		elseif tRun.bPageSeen then
			-- the page reports in this run: wait for its view of the clear
			bStill = true
		else
			local tSel = self:_Selection()
			-- the array, or (where it reads empty) this row's own flag
			bStill = (tSel ~= nil and #tSel > 0) or self:_SelState(tCur.sKey) == true
		end
		if bStill and t - tCur.nClearedAt < self.nClearWait then
			return
		end
		-- the list may have been rebuilt meanwhile
		if guidOf(tCur.sKey) ~= tCur.sGuid then
			local sKey = self:_Find(tCur, self:_List())
			if sKey == nil then
				return self:_Skip(tRun, "gone")
			end
			tCur.sKey = sKey
		end
		-- what the game shows before this animal's data arrives (it may
		-- not reset on Clear): equal data after selecting may still be stale
		tCur.sClearedPrint, tCur.sClearedSrc = self:_RawPrint(tRun, tCur.sKey)
		-- exactly this animal, the way a click on its row selects it
		-- by the row's id, as a click on the row does (see nativeId)
		api.planetHub.StorageUISelectItem(nativeId(tCur.sKey))
		tCur.nSelectedAt = t
		self:_SetStep(tRun, "select", "Selecting it.")
		-- a new watch: only what the page reads after the select counts
		self:_Watch(tRun, tCur.sKey)
		return
	end
	if tRun.sStep == "select" then
		local tData, sWhy = self:_SelectionData(tCur, tRun)
		if tData == nil then
			if t - tCur.nSelectedAt > self.nSelectTimeout then
				return self:_Unselectable(tRun, sWhy)
			end
			return
		end
		-- the data may follow the selection a frame later: settle first
		self:_SetStep(tRun, "selected", "Reading the game's limits.")
		return
	end
	if tRun.sStep == "selected" then
		if t - tRun.nStepStart < self.nSettle then
			return
		end
		local tData, sWhy = self:_SelectionData(tCur, tRun)
		if tData == nil then
			if t - tCur.nSelectedAt > self.nSelectTimeout then
				return self:_Unselectable(tRun, sWhy)
			end
			return self:_SetStep(tRun, "select", "Selecting it.")
		end
		-- (read from another source than the note: can't tell, so as if unchanged)
		local bSame = tData.sSrc ~= tCur.sClearedSrc or dataPrint(tData) == tCur.sClearedPrint
		if bSame and t - tCur.nSelectedAt < self.nSameSettle then
			-- unchanged since before selecting: maybe this animal's data is
			-- the same, maybe it has not arrived; wait a little longer
			if not tCur.bSameMarked then
				tCur.bSameMarked = true
				mark("lister_data_same")
			end
			return
		end
		if not tData.bAllowed then
			local sReason = tData.sReason
			return self:_Skip(tRun, "untradeable", (type(sReason) == "string" and sReason ~= "") and sReason or nil)
		end
		local tRes = tRun.tResults[tRun.nIndex]
		local nPrice, sCapped, bDefault = priceFor(tCur.nPrice, tData.tLimits)
		tRes.usedDefault = bDefault
		if nPrice == nil then
			return self:_Skip(tRun, "noprice")
		end
		tCur.nSendPrice = nPrice
		tCur.sDataPrint = dataPrint(tData)
		tCur.sDataSrc = tData.sSrc
		tCur.nSendHours = hoursFor(tCur.vHours, tData.tLimits)
		tRes.price, tRes.hours, tRes.capped = nPrice, tCur.nSendHours, sCapped
		self:_SetStep(tRun, "send", "Listing at " .. nPrice .. " CC for " .. tCur.nSendHours .. " h.")
	end
	if tRun.sStep == "send" then
		local bBusy, sWhy = self:_Busy()
		-- RequestsInProgress alone may stay on for background polls (the old
		-- page lister only ever asked IsDatabaseOperationInProgress): short wait
		if bBusy and sWhy == "requests" and (tRun.bRequestsIgnored or t - tRun.nStepStart > self.nRequestsGrace) then
			if not tRun.bRequestsIgnored then
				tRun.bRequestsIgnored = true
				mark("lister_busy_requests_ignored")
			end
			bBusy = false
		end
		if bBusy then
			self:_MarkBusy(tRun, sWhy)
			if t - tRun.nStepStart > self.nServerTimeout then
				return self:_Skip(tRun, "busy")
			end
			tRun.sMessage = "Waiting for the game's other server requests."
			return
		end
		-- in the same tick as the call: the key must still be this animal,
		-- and the only selection
		if guidOf(tCur.sKey) ~= tCur.sGuid then
			return self:_Skip(tRun, "changed")
		end
		-- (by the freshest page report when there is one, else Lua's reads)
		if self:_IsSelected(tRun, tCur.sKey) == false then
			return self:_Skip(tRun, "changed")
		end
		-- the game's data must still be what the price came from (it may
		-- arrive in parts), read the same way: otherwise settle and work it
		-- out again
		local tNow = self:_SelectionData(tCur, tRun)
		if tNow == nil or tNow.sSrc ~= tCur.sDataSrc or dataPrint(tNow) ~= tCur.sDataPrint then
			tCur.nResettled = (tCur.nResettled or 0) + 1
			mark("lister_data_changed")
			if tCur.nResettled > self.nResettles then
				return self:_Skip(tRun, "unselectable", "The game's data for it kept changing.")
			end
			return self:_SetStep(tRun, "selected", "Reading the game's limits again.")
		end
		-- counts as sent even if the call raises: the pause still follows
		tCur.bSent = true
		tCur.nSentAt = t
		tCur.nLastPoll = t
		mark("lister_send")
		api.planetHub.StorageUIStartAnimalAuction(tCur.sKey, tCur.nSendPrice, tCur.nSendHours)
		self:_SetStep(tRun, "confirm", "Waiting for the server to confirm.")
		return
	end
	if tRun.sStep == "confirm" then
		if t - tCur.nLastPoll < self.nConfirmPoll then
			return
		end
		tCur.nLastPoll = t
		if self:_IsListed(tCur) then
			return self:_Result(tRun, "listed", nil, "")
		end
		local tErr = tCur.tError
		if tErr ~= nil then
			local sErr = tErr.sName or ("code " .. tostring(tErr.nError))
			if tErr.sName == "DidNotGetResponse" then
				-- the game's request timed out: the listing may still arrive
				if t - tErr.nTime > self.nLateConfirm then
					return self:_Result(tRun, "timeout", "timeout", "The server timed out (" .. sErr .. "); it may still appear on the market.")
				end
			elseif tErr.sName == nil or tErr.sName == "Unknown" then
				-- unspecific: it may have gone through after all
				if t - tErr.nTime > self.nRejectGrace then
					return self:_Result(tRun, "refused", "refused", "Refused by the server (" .. sErr .. ").")
				end
			else
				return self:_Result(tRun, "refused", "refused", "Refused by the server (" .. sErr .. ").")
			end
		elseif t - tCur.nSentAt > self.nConfirmTimeout then
			return self:_Result(tRun, "timeout", "timeout", "No confirmation after " .. self.nConfirmTimeout .. " s; it may still appear on the market.")
		end
	end
end

-- Every frame while Animal Storage is open (its Advance).
Lister.Tick = function(self)
	local tRun = self.tRun
	if tRun == nil then
		return
	end
	local t = now()
	if tRun.tCur == nil then
		-- between animals: after the pause (the pace may change during it)
		if tRun.sStep ~= "pause" or t - (tRun.nPauseStart or 0) >= self.nPaceMs / 1000 then
			self:_Next(tRun)
		end
	end
	if self.tRun == tRun and tRun.tCur ~= nil then
		local bOk, sErr = pcall(self._Step, self, tRun, t)
		if not bOk and self.tRun == tRun and tRun.tCur ~= nil then
			-- a bug or a game change in this animal's step: skip it, carry on
			mark("lister_error")
			trace("step " .. tostring(tRun.sStep) .. " failed: " .. tostring(sErr))
			self:_Result(tRun, "skipped", "error", "Mod error: " .. tostring(sErr))
		end
	end
	-- a page that reloaded, or missed the watch: ask again
	if self.tRun == tRun and tRun.sWatchReq ~= nil and t - (tRun.nWatchSent or 0) > self.nWatchResend then
		local r = tRun.tSeen
		if r == nil or r.sReq ~= tRun.sWatchReq or t - r.nAt > self.nWatchResend then
			tRun.nWatchSent = t
			self:_Send(tRun.oUI, "PZ2QoL_ListerWatch", tRun.sWatchReq, tRun.sWatchKey)
		end
	end
	if self.tRun == tRun and (tRun.bDirty or t - (tRun.nLastEmit or 0) >= self.nStateInterval) then
		self:_Emit(tRun)
	end
end

-- MsgType_DatabaseErrorMessage, through PZ2QoL.Errors: only a listing's
-- (request type 42) answer to the animal being confirmed counts.
Lister.OnServerError = function(self, nError, sName, nRequestType)
	local tRun = self.tRun
	local tCur = tRun and tRun.tCur
	if tCur == nil or not tCur.bSent or tCur.tError ~= nil then
		return
	end
	if toNumber(nRequestType) ~= self.nListingRequest or sName == "Ok" then
		return
	end
	tCur.tError = { nError = nError, sName = sName, nTime = now() }
	if sName == "DidNotGetResponse" then
		tRun.sMessage = "The server timed out; checking whether it was listed."
	else
		tRun.sMessage = "Server error (" .. tostring(sName or ("code " .. tostring(nError))) .. "); checking whether it went through."
	end
	tRun.bDirty = true
end

-----------------------------------------------------------------------
-- Page -> Lua
-----------------------------------------------------------------------
Lister.Hello = function(self, oUI, sReq)
	mark("lister_hello")
	local tMissing = self:_Missing()
	local bStorage = self.oStorageMode ~= nil
	local nRows = NULL
	if bStorage then
		local tList = self:_List()
		if tList == nil then
			tMissing[#tMissing + 1] = "storageList"
			mark("lister_list_unreadable")
		else
			nRows = 0
			for _, tRow in pairs(tList) do
				if type(tRow) == "table" then
					nRows = nRows + 1
				end
			end
		end
	end
	local bOnline = self:_Online()
	self:_Send(oUI, "PZ2QoL_ListerCaps", tostring(sReq or ""), toJson({
		ok = #tMissing == 0, missing = tMissing, storage = bStorage,
		online = bOnline == nil and NULL or bOnline, rows = nRows,
		running = self.tRun ~= nil, version = self.nVersion,
	}))
	-- a page that (re)loads during a run picks it up
	if self.tRun ~= nil then
		self.tRun.oUI = oUI
		self:_Emit(self.tRun)
	end
end

-- Row keys (comma-separated) -> { ids: { key: guid }, rows: { key: { name,
-- species, gender } }, failed: [keys] }. rows are read in the same tick as the
-- GUIDs: the page keeps a GUID only if the row is still the animal it saw.
Lister.Resolve = function(self, oUI, sReq, sKeys)
	local tIds, tRows, tFailed = {}, {}, array()
	local bStorage = self.oStorageMode ~= nil
	local tList = bStorage and self:_List() or nil
	local n = 0
	for sKey in string.gmatch(tostring(sKeys or ""), "[^,%s]+") do
		n = n + 1
		if n > self.nMaxKeys then
			break
		end
		-- keys only mean something while Animal Storage is open
		local sGuid = bStorage and guidOf(sKey) or nil
		local tRow = sGuid ~= nil and rowOf(sKey, tList) or nil
		if sGuid ~= nil and tRow ~= nil then
			tIds[sKey] = sGuid
			tRows[sKey] = { name = tRow.name, species = tRow.species, gender = tRow.gender }
		else
			tFailed[#tFailed + 1] = sKey
		end
	end
	self:_Send(oUI, "PZ2QoL_ListerIds", tostring(sReq or ""), toJson({ ids = tIds, rows = tRows, failed = tFailed }))
end

Lister.Start = function(self, oUI, sReq, sJob)
	sReq = tostring(sReq or "")
	if self.tRun ~= nil then
		self:_Refuse(oUI, sReq, "A listing run is already going; stop it first.")
		return self:_Emit(self.tRun, nil, oUI)
	end
	local tAnimals, vPace = parseJob(sJob)
	if tAnimals == nil then
		return self:_Refuse(oUI, sReq, vPace)
	end
	local tMissing = self:_Missing()
	if #tMissing > 0 then
		return self:_Refuse(oUI, sReq, "This game version has no " .. table.concat(tMissing, ", ") .. ".")
	end
	if self.oStorageMode == nil then
		return self:_Refuse(oUI, sReq, "Animal Storage is not open.", "closed")
	end
	if self:_Online() == false then
		return self:_Refuse(oUI, sReq, "Listing on the market needs an online Franchise.")
	end
	self.nPaceMs = self:_ClampPace(vPace)
	self.nRuns = self.nRuns + 1
	local tRun = { nId = self.nRuns, sReq = sReq, oUI = oUI, sPhase = "running", tAnimals = tAnimals, tResults = {}, nIndex = 1 }
	for i, tJob in ipairs(tAnimals) do
		tRun.tResults[i] = { guid = tJob.sGuid, status = "pending" }
	end
	self.tRun = tRun
	mark("lister_run_start")
	self.bFlagMarked = nil
	trace("run " .. tRun.nId .. ": " .. #tAnimals .. " animals")
	local t = now()
	if self.nLastServer ~= nil and t - self.nLastServer < self.nPaceMs / 1000 then
		-- the last run's listing was moments ago: its pause first
		tRun.nPauseStart = self.nLastServer
		self:_SetStep(tRun, "pause", "Pausing between listings.")
	else
		self:_Begin(tRun)
	end
	self:_Emit(tRun)
end

-- The player's Stop: at once, unless a listing is waiting for the server
-- (then that animal is "stopped": it may still appear).
Lister.Stop = function(self)
	local tRun = self.tRun
	if tRun == nil then
		if self.tLast ~= nil then
			self:_Emit(self.tLast)
		end
		return
	end
	mark("lister_stop")
	self:_End(tRun, "stopped", "Stopped by you.")
end

Lister.SetPace = function(self, nMs)
	self.nPaceMs = self:_ClampPace(nMs)
	if self.tRun ~= nil then
		self:_Emit(self.tRun)
	end
end

-----------------------------------------------------------------------
-- Wiring
-----------------------------------------------------------------------
-- JS -> Lua events on the hub page, registered from the view's ready
-- callback (registering earlier is silently dropped).
Lister.Attach = function(self, oUI)
	if oUI == nil or self.tViews[oUI] then
		return
	end
	self.tViews[oUI] = true
	local function guard(sName, fn)
		-- callbacks get (callbackArgument, eventArgs...)
		return function(_, ...)
			local bOk, sErr = pcall(fn, ...)
			if not bOk then
				trace(sName .. " failed: " .. tostring(sErr))
			end
		end
	end
	local bOk, sErr = pcall(function()
		oUI:AddEventListener("PZ2QoL_ListerHello", 1, guard("hello", function(sReq)
			self:Hello(oUI, sReq)
		end), self)
		oUI:AddEventListener("PZ2QoL_ListerResolve", 2, guard("resolve", function(sReq, sKeys)
			self:Resolve(oUI, sReq, sKeys)
		end), self)
		oUI:AddEventListener("PZ2QoL_ListerStart", 2, guard("start", function(sReq, sJob)
			local bRan, sRunErr = pcall(self.Start, self, oUI, sReq, sJob)
			if not bRan and self.tRun == nil then
				self:_Refuse(oUI, tostring(sReq or ""), "The listing engine failed: " .. tostring(sRunErr))
			end
		end), self)
		oUI:AddEventListener("PZ2QoL_ListerStop", 0, guard("stop", function()
			self:Stop()
		end), self)
		oUI:AddEventListener("PZ2QoL_ListerPace", 1, guard("pace", function(nMs)
			self:SetPace(nMs)
		end), self)
		oUI:AddEventListener("PZ2QoL_ListerSeen", 2, guard("seen", function(sReq, sText)
			self:OnSeen(sReq, sText)
		end), self)
	end)
	if not bOk then
		trace("listeners failed: " .. tostring(sErr))
	end
end

Lister._PatchStorageMode = function(self, StorageMode)
	local fnIn = StorageMode.TransitionIn
	local fnOut = StorageMode.TransitionOut
	local fnAdvance = StorageMode.Advance
	if type(fnIn) ~= "function" or type(fnOut) ~= "function" or type(fnAdvance) ~= "function" then
		trace("AnimalStorageHubMode has changed; the market desk engine is off")
		return
	end
	local function close(sMessage)
		local tRun = self.tRun
		if tRun ~= nil then
			local bOk, sErr = pcall(self._End, self, tRun, "closed", sMessage)
			if not bOk then
				self.tRun = nil
				trace("close failed: " .. tostring(sErr))
			end
		end
	end
	StorageMode.TransitionIn = function(oMode, ...)
		-- a run from a storage visit that never ended (no TransitionOut seen)
		close("Animal Storage was reopened.")
		self.oStorageMode = oMode
		return fnIn(oMode, ...)
	end
	StorageMode.TransitionOut = function(oMode, ...)
		-- row keys mean nothing outside Animal Storage: the run ends here
		close("Animal Storage was closed.")
		if self.oStorageMode == oMode then
			self.oStorageMode = nil
		end
		return fnOut(oMode, ...)
	end
	StorageMode.Advance = function(oMode, ...)
		if self.tRun ~= nil then
			local bOk, sErr = pcall(self.Tick, self)
			if not bOk then
				-- the engine itself failed (not one animal's step): end the
				-- run rather than fail on every frame
				trace("tick failed: " .. tostring(sErr))
				local tRun = self.tRun
				if tRun ~= nil then
					local bEnded = pcall(self._End, self, tRun, "done", "The listing engine failed: " .. tostring(sErr))
					if not bEnded then
						self.tRun = nil
					end
				end
			end
		end
		return fnAdvance(oMode, ...)
	end
end

Lister.Init = function(self, Core)
	self.Core = Core
	Core:AddModulePatch("StartScreen.Globe.AnimalStorageHubMode", function(t) self:_PatchStorageMode(t) end)
	local Errors = global.package.loaded["pz2qol.errors"]
	if type(Errors) == "table" and type(Errors.AddServerErrorListener) == "function" then
		Errors:AddServerErrorListener(function(nError, sName, nRequestType)
			self:OnServerError(nError, sName, nRequestType)
		end)
	else
		trace("no server error listener; refusals only time out")
	end
end
