"""Summarise Planet Zoo 2 crash dumps: exception code, faulting thread name,
faulting module, modules on the faulting thread's stack, the game's metadata
(running time, world) and its embedded report (Lua coroutines = what screen
the game was on).

Usage: <python with the `minidump` package> -I tools/crashsum.py <dump.dmp>...
Dumps: %TEMP%/Frontier Developments/Planet Zoo 2/CrashDumps (copy them first).
"""
import logging
import re
import struct
import sys
from collections import Counter

logging.disable(logging.CRITICAL)
from minidump.minidumpfile import MinidumpFile


def name(mod):
    return mod.name.replace(chr(47), chr(92)).split(chr(92))[-1]


for path in sys.argv[1:]:
    print("=" * 100)
    print(path)
    raw = open(path, "rb").read()
    n, rva = struct.unpack_from("<II", raw, 8)
    names, crash_tid = {}, None
    for i in range(n):
        t, size, off = struct.unpack_from("<III", raw, rva + i * 12)
        if t == 6:  # ExceptionStream
            tid, _, code, flags, rec, addr = struct.unpack_from("<IIIIQQ", raw, off)
            crash_tid = tid
            print("exception code", hex(code), "thread", tid, "addr", hex(addr))
        if t == 24:  # ThreadNamesStream
            cnt = struct.unpack_from("<I", raw, off)[0]
            for k in range(cnt):
                ntid, nrva = struct.unpack_from("<IQ", raw, off + 4 + k * 12)
                ln = struct.unpack_from("<I", raw, nrva)[0]
                names[ntid] = raw[nrva + 4:nrva + 4 + ln].decode("utf-16le", "replace")
    print("faulting thread name:", names.get(crash_tid))
    for key in (b"game_version", b"game_running_time", b"world_current_name", b"world_current_state"):
        j = raw.find(b'"' + key + b'"')
        if j >= 0:
            print(" ", raw[j:j + 80].split(b",")[0].decode("ascii", "replace"))
    try:
        m = MinidumpFile.parse(path)
        mods = sorted(m.modules.modules, key=lambda x: x.baseaddress)
        e = m.exception.exception_records[0]
        a = e.ExceptionRecord.ExceptionAddress
        for mod in mods:
            if mod.baseaddress <= a < mod.baseaddress + mod.size:
                print("faulting module", name(mod), "+", hex(a - mod.baseaddress))
        th = [t for t in m.threads.threads if t.ThreadId == e.ThreadId][0]
        data = m.get_reader().read(th.Stack.StartOfMemoryRange, th.Stack.MemoryLocation.DataSize)
        refs = Counter()
        for off in range(0, len(data) - 8, 8):
            v = struct.unpack_from("<Q", data, off)[0]
            for mod in mods:
                if mod.baseaddress <= v < mod.baseaddress + mod.size:
                    refs[name(mod)] += 1
                    break
        print("faulting thread stack modules:", dict(refs.most_common(10)))
    except Exception as ex:
        print("minidump parse failed:", ex)
    i = raw.find(b"Mod Information:")
    if i >= 0:
        end = raw.find(b"F3D Status", i)
        txt = re.sub(rb"[^\x09\x0a\x0d\x20-\x7e]+", b"\n", raw[i:end if end > 0 else i + 4000]).decode()
        lines = [l for l in txt.split("\n") if l.strip() and not l.startswith("---")]
        mods_line = [l for l in lines if "PZ2" in l or "modded" in l]
        lua = [l.strip() for l in lines if l.strip().startswith("LUA[2]") or l.strip().startswith("LUA[3]")]
        print("mod info:", mods_line)
        print("lua (screens/coroutines):")
        for l in lua:
            print("   ", l[:140])
    else:
        print("no embedded report")
