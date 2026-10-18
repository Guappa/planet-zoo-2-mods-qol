"""Unpack Planet Zoo 2's game scripts and UI into readable files.

usage:
  python pz2_unpack.py --cobra-tools <cobra-tools dir> --game "<Planet Zoo 2 dir>" --out <dir>
                       [--python <python with cobra-tools deps>] [--no-lua] [--no-ui]
                       [--ovl <extra .ovl> ...]

What it does (read-only on the game folder):
  1. cobra-tools extracts the Lua from GameMain\\Main.ovl and Content0\\Main.ovl.
     The game ships Lua 5.3 bytecode (*.lua.bin).
  2. cobra-tools' bundled luadec decompiles every *.lua.bin next to it as *.lua.
     The .bin files are kept: `luadec -dis <file>.lua.bin` lists each function's
     start line, which maps a crash report's line number to a function.
  3. cobra-tools extracts the UI package (.ppuipkg) from
     GameMain\\Content\\UserInterfaceEssentials.ovl, and ppuipkg_unpack.py turns it
     into the real HTML / JS / CSS (the game UI is a Preact app on Coherent Gameface).

Output:
  <out>/lua/GameMain/*.lua      engine-side game scripts (~245)
  <out>/lua/Content0/*.lua      game content scripts (~870)
  <out>/ui/                     Frontend.html, HUD.html, js/, css/ ...
  <out>/unpack_report.txt       counts, and the files with DECOMPILER ERROR blocks

Keep the output to yourself: it is Frontier's code. Read it, never redistribute it.
"""
import argparse
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from ppuipkg_unpack import unpack  # noqa: E402

LUA_OVLS = {
    "GameMain": os.path.join("Win64", "ovldata", "GameMain", "Main.ovl"),
    "Content0": os.path.join("Win64", "ovldata", "Content0", "Main.ovl"),
}
UI_OVL = os.path.join("Win64", "ovldata", "GameMain", "Content", "UserInterfaceEssentials.ovl")
DECOMPILE_TIMEOUT = 20


def cobra_extract(args, ovl, out_dir, file_type):
    cmd = [args.python, os.path.join(args.cobra_tools, "ovl_tool_cmd.py"), "extract", ovl,
           "-o", out_dir, "--type", file_type]
    # ovl_tool_cmd imports its own modules relative to the working directory
    proc = subprocess.run(cmd, cwd=args.cobra_tools, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout[-2000:] + proc.stderr[-2000:])
        raise SystemExit(f"cobra-tools failed on {ovl}")


def decompile(luadec, bin_path):
    """luadec, then luadec -s (no debug info) if the first try gives no output."""
    for extra in ([], ["-s"]):
        try:
            proc = subprocess.run([luadec, *extra, bin_path], capture_output=True, timeout=DECOMPILE_TIMEOUT)
        except subprocess.TimeoutExpired:
            return None
        if proc.stdout:
            return proc.stdout
    return None


def unpack_lua(args, luadec, report):
    for pack, rel in LUA_OVLS.items():
        ovl = os.path.join(args.game, rel)
        if not os.path.isfile(ovl):
            report.append(f"{pack}: {ovl} not found, skipped")
            continue
        out_dir = os.path.join(args.out, "lua", pack)
        print(f"extracting {pack} Lua ...")
        cobra_extract(args, ovl, out_dir, ".lua")
        bins = sorted(f for f in os.listdir(out_dir) if f.endswith(".lua.bin"))
        ok, partial, failed = 0, [], []
        for i, name in enumerate(bins, 1):
            if i % 100 == 0:
                print(f"  decompiled {i}/{len(bins)}")
            src = decompile(luadec, os.path.join(out_dir, name))
            if src is None:
                failed.append(name)
                continue
            with open(os.path.join(out_dir, name[:-4]), "wb") as f:
                f.write(src)
            if b"DECOMPILER ERROR" in src:
                partial.append(name[:-4])
            else:
                ok += 1
        report.append(f"{pack}: {len(bins)} scripts, {ok} clean, {len(partial)} with DECOMPILER ERROR blocks "
                      f"(still mostly readable), {len(failed)} failed")
        report.extend(f"  partial: {n}" for n in partial)
        report.extend(f"  failed:  {n}" for n in failed)


def unpack_ui(args, ovls, report):
    for ovl in ovls:
        if not os.path.isfile(ovl):
            report.append(f"UI: {ovl} not found, skipped")
            continue
        tmp = os.path.join(args.out, "_ppuipkg")
        print(f"extracting UI package from {os.path.basename(ovl)} (large, takes a minute) ...")
        cobra_extract(args, ovl, tmp, ".ppuipkg")
        for name in sorted(os.listdir(tmp)):
            if name.endswith(".ppuipkg"):
                count = unpack(os.path.join(tmp, name), os.path.join(args.out, "ui"))
                report.append(f"UI: {name}: {count} files -> ui/")
        if not args.keep_xml:
            shutil.rmtree(tmp, ignore_errors=True)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--cobra-tools", required=True, help="cobra-tools checkout (github.com/OpenNaja/cobra-tools)")
    p.add_argument("--game", required=True, help="Planet Zoo 2 install folder (the one with PlanetZoo2.exe)")
    p.add_argument("--out", required=True, help="output folder (outside the game folder)")
    p.add_argument("--python", default=sys.executable, help="python with cobra-tools' requirements")
    p.add_argument("--no-lua", action="store_true")
    p.add_argument("--no-ui", action="store_true")
    p.add_argument("--ovl", action="append", default=[], help="another OVL holding a .ppuipkg to unpack too")
    p.add_argument("--keep-xml", action="store_true", help="keep cobra-tools' raw .ppuipkg XML dump")
    args = p.parse_args()

    args.cobra_tools = os.path.abspath(args.cobra_tools)
    args.out = os.path.abspath(args.out)
    args.game = os.path.abspath(args.game)
    if args.out.lower().startswith(args.game.lower()):
        raise SystemExit("--out must be outside the game folder")
    luadec = os.path.join(args.cobra_tools, "modules", "formats", "utils", "luadec", "luadec.exe")
    if not args.no_lua and not os.path.isfile(luadec):
        raise SystemExit(f"luadec not found at {luadec}")
    os.makedirs(args.out, exist_ok=True)

    report = []
    if not args.no_lua:
        unpack_lua(args, luadec, report)
    if not args.no_ui:
        unpack_ui(args, [os.path.join(args.game, UI_OVL)] + args.ovl, report)
    with open(os.path.join(args.out, "unpack_report.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(report) + "\n")
    print("\n".join(line for line in report if not line.startswith("  ")))
    print("done:", args.out)


if __name__ == "__main__":
    main()
