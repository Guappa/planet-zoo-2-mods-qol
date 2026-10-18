"""Find which function a Planet Zoo 2 crash-report line number falls in.

usage: python lua_funcmap.py --cobra-tools <dir> <script>.lua.bin [line]

The game's bytecode keeps no per-instruction line info, so the decompiled .lua has
different line numbers from the ones in crash reports ("AnimalMovementEditMode.lua:1158").
Each function's start line survives, though: `luadec -dis` prints it as
"Defined at line". Without [line] this lists every function start; with it, it
prints the function whose start is the last one at or before that line.
Run it on the .lua.bin files pz2_unpack.py keeps next to the decompiled .lua.
"""
import argparse
import os
import re
import subprocess


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--cobra-tools", required=True)
    p.add_argument("bin")
    p.add_argument("line", nargs="?", type=int)
    args = p.parse_args()
    luadec = os.path.join(args.cobra_tools, "modules", "formats", "utils", "luadec", "luadec.exe")
    out = subprocess.run([luadec, "-dis", args.bin], capture_output=True, text=True, errors="replace").stdout

    # Each function block starts with "; Function: <id>" followed by "; Defined at line: N"
    starts, current = [], None
    for raw in out.splitlines():
        m = re.match(r";\s*Function:\s*(\S+)", raw)
        if m:
            current = m.group(1)
            continue
        m = re.match(r";\s*Defined at line:\s*(\d+)", raw)
        if m:
            starts.append((int(m.group(1)), current or "?"))
    starts.sort()
    if args.line is None:
        for line, fn in starts:
            print(f"{line:6d}  function {fn}")
        return
    best = None
    for line, fn in starts:
        if line <= args.line:
            best = (line, fn)
    if best is None:
        print("no function starts at or before that line (main chunk)")
    else:
        print(f"line {args.line} is in function {best[1]}, defined at line {best[0]}")
        lua = args.bin[:-4] if args.bin.endswith(".lua.bin") else None
        if lua and os.path.exists(lua):
            lines = open(lua, encoding="utf-8", errors="replace").read().splitlines()
            tag = f"function num : {best[1]} ,"
            for i, text in enumerate(lines):
                if tag in text:
                    print(f"decompiled {os.path.basename(lua)}, line {i + 1}:")
                    for shown in lines[max(0, i - 2):i + 1]:
                        print("   ", shown)
                    break
        else:
            print(f"In the decompiled .lua, search for \"function num : {best[1]} ,\".")


if __name__ == "__main__":
    main()
