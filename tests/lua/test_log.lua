-- Behaviour test for PZ2QoL.Core's detailed log (Core:Log / Core:LogText /
-- Core.FormatLogData) against a mock package.loadlib that stands in for the
-- dbg\lg_*.dll copies of tools/trace/pz2_trace.c. Run:
--   lua53 tests/lua/test_log.lua <path-to-mods/PZ2QoL/Main/>
local sModDir = arg[1] or "mods/PZ2QoL/Main/"

local nFailed, nPassed = 0, 0
local function check(bCond, sName)
	if bCond then
		nPassed = nPassed + 1
	else
		nFailed = nFailed + 1
		print("FAIL: " .. sName)
	end
end

function module(sName, tBase)
	local t = tBase or {}
	package.loaded[string.lower(sName)] = t
	return t
end

-- The fake lg_* DLLs: a per-file "mark" that does what the DLL does (one
-- line buffer; lg_end writes it to tLines). tMissing[name] = true: no file.
local tLines, sBuf, nLoads, tMissing, bThrow = {}, nil, 0, {}, false
local tLoadNames = {}
local fnRealLoadlib = package.loadlib
package.loadlib = function(sPath, sSym)
	nLoads = nLoads + 1
	if bThrow then
		error("loadlib exploded")
	end
	local sName = string.match(sPath, "([%w_%.]+)%.dll$")
	tLoadNames[#tLoadNames + 1] = sName
	if sName == nil or tMissing[sName] then
		return nil, "not found"
	end
	if sName == "cp_boot" then
		return function() end
	end
	if sSym ~= "mark" then
		return function() end
	end
	if sName == "lg_clr" then
		return function() sBuf = "" return 0 end
	elseif sName == "lg_end" then
		return function()
			if sBuf ~= nil and sBuf ~= "" then tLines[#tLines + 1] = sBuf end
			sBuf = nil
			return 0
		end
	end
	local sHex = string.match(sName, "^lg_(%x%x)$")
	if sHex then
		local c = string.char(tonumber(sHex, 16))
		return function() sBuf = (sBuf or "") .. c return 0 end
	end
	-- cp_<name> checkpoints and marks
	return function() return 0 end
end

local Core = assert(loadfile(sModDir .. "pz2qol.core.lua"))("PZ2QoL.Core")
Core = package.loaded["pz2qol.core"]
check(type(Core.Log) == "function" and type(Core.LogText) == "function" and type(Core.FormatLogData) == "function", "log API present")

-- 1. Off unless the trace build is there (release: nothing loaded, nothing written)
Core.bTrace = false
nLoads = 0
Core:Log("lister", "send", { run = 1, guid = "123" })
Core:LogText("hello")
check(nLoads == 0 and #tLines == 0, "release build: a no-op, no DLL touched")

-- 2. Formatting
Core.bTrace = true
check(Core.FormatLogData(nil) == "", "no data")
check(Core.FormatLogData("text here") == ' "text here"', "plain text quoted: " .. Core.FormatLogData("text here"))
local s = Core.FormatLogData({ price = 1200, guid = "4400000000001", run = 3, i = 2, ok = true, note = "two words", z = 1.5, big = 12345678901 })
check(s == ' run=3 i=2 guid=4400000000001 big=12345678901 note="two words" ok=true price=1200 z=1.5', "lead keys first, rest sorted: " .. s)
s = Core.FormatLogData({ a = 'say "hi"', b = "", c = "x=y", d = "line1\nline2" })
check(s == [[ a="say 'hi'" b="" c="x=y" d="line1 line2"]], "quoting and control characters: " .. s)
s = Core.FormatLogData({ list = { 1, 2, 3 }, map = { b = 2, a = "x" } })
check(s == " list=[1,2,3] map=[a:x,b:2]", "tables: " .. s)
s = Core.FormatLogData({ steamId = "765611", token = "abc", userName = "me", authKey = "k", price = 5 })
check(s == " authKey=[redacted] price=5 steamId=[redacted] token=[redacted] userName=[redacted]", "sensitive keys redacted: " .. s)
s = Core.FormatLogData({ long = string.rep("a", 400) })
check(#s < 200 and string.sub(s, -1) == "~", "long values cut: " .. #s)
s = Core.FormatLogData({ nested = { inner = { deep = 1 } } })
check(s == " nested=[inner:[...]]", "nested tables stop at one level: " .. s)
s = Core.FormatLogData({ n = 0 / 0, f = 1 / 3 })
check(s == " f=0.3333 n=nan", "odd numbers: " .. s)

-- 3. Lines through the fake DLLs
tLines = {}
Core:Log("lister", "send", { run = 3, i = 1, guid = "4400000000001", price = 1200, hours = 12 })
check(#tLines == 1 and tLines[1] == "lua#1 lister send run=3 i=1 guid=4400000000001 hours=12 price=1200", "one line: " .. tostring(tLines[1]))
Core:Log("peek", "ready")
check(tLines[2] == "lua#2 peek ready", "no data: " .. tostring(tLines[2]))
Core:LogText("js#7@10:00:00.000 desk open n=3 caf\195\169")
check(tLines[3] == "js#7@10:00:00.000 desk open n=3 caf??", "non-ASCII bytes as ?: " .. tostring(tLines[3]))
Core:LogText(string.rep("b", 5000))
check(#tLines[4] == Core.nLogMax + 1 and string.sub(tLines[4], -1) == "~", "long lines cut: " .. #tLines[4])
Core:LogText("")
Core:LogText(nil)
Core:LogText(42)
check(#tLines == 4, "empty or non-string text writes nothing")
-- each byte's DLL is loaded once, then reused
local nBefore = nLoads
Core:Log("lister", "send", { run = 3, i = 1, guid = "4400000000001", price = 1200, hours = 12 })
check(nLoads == nBefore, "no new loads for known bytes")

-- 4. Fail soft: a missing lg_end turns the log off for the session, never raises
package.loaded["pz2qol.core"] = nil
tMissing = { lg_end = true }
local Core2 = assert(loadfile(sModDir .. "pz2qol.core.lua"))("PZ2QoL.Core")
Core2 = package.loaded["pz2qol.core"]
Core2.bTrace = true
local tCp = {}
Core2.Checkpoint = function(_, sName) tCp[#tCp + 1] = sName end
tLines = {}
local bOk = pcall(Core2.Log, Core2, "lister", "send", { run = 1 })
check(bOk and #tLines == 0 and Core2.bLogOff == true, "missing lg_end: no line, log off")
check(tCp[1] == "log_channel_missing", "missing channel marked once")
nLoads = 0
Core2:Log("lister", "send", { run = 2 })
check(nLoads == 0, "off for the session: no more loads")

-- a byte's DLL missing: that character is left out, the line still written
package.loaded["pz2qol.core"] = nil
tMissing = { lg_7a = true } -- 'z'
local Core3 = assert(loadfile(sModDir .. "pz2qol.core.lua"))("PZ2QoL.Core")
Core3 = package.loaded["pz2qol.core"]
Core3.bTrace = true
local tCp3 = {}
Core3.Checkpoint = function(_, sName) tCp3[#tCp3 + 1] = sName end
tLines = {}
Core3:LogText("zebra")
check(tLines[1] == "ebra" and not Core3.bLogOff, "missing byte DLL: character dropped, line kept")
check(tCp3[1] == "log_channel_ok", "first line marks the channel ok")

-- loadlib itself raising: off, never raises
package.loaded["pz2qol.core"] = nil
tMissing = {}
local Core4 = assert(loadfile(sModDir .. "pz2qol.core.lua"))("PZ2QoL.Core")
Core4 = package.loaded["pz2qol.core"]
Core4.bTrace = true
Core4.Checkpoint = function() end
bThrow = true
bOk = pcall(Core4.Log, Core4, "lister", "x", { a = 1 })
check(bOk and Core4.bLogOff == true, "loadlib raising: off, no error")
bThrow = false

-- data whose tostring raises: the line is dropped, nothing raises
local tBad = setmetatable({}, { __tostring = function() error("boom") end })
package.loaded["pz2qol.core"] = nil
local Core5 = assert(loadfile(sModDir .. "pz2qol.core.lua"))("PZ2QoL.Core")
Core5 = package.loaded["pz2qol.core"]
Core5.bTrace = true
Core5.Checkpoint = function() end
tLines = {}
bOk = pcall(Core5.Log, Core5, "lister", "x", { bad = tBad, ok = 1 })
check(bOk, "a value that raises in tostring: no error")

-- 5. Every log_* name Core marks is in checkpoints.txt
local tKnown = {}
local f = io.open(sModDir .. "../../../tools/trace/checkpoints.txt", "r")
check(f ~= nil, "checkpoints.txt found")
if f then
	for l in f:lines() do tKnown[(string.gsub(l, "%s+$", ""))] = true end
	f:close()
end
check(tKnown["log_channel_ok"] and tKnown["log_channel_missing"], "checkpoints.txt has log_channel_ok / log_channel_missing")

package.loadlib = fnRealLoadlib
print(string.format("%d passed, %d failed", nPassed, nFailed))
if nFailed > 0 then os.exit(1) end
