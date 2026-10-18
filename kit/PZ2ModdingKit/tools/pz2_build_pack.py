"""Build a Planet Zoo 2 content pack (mod folder) from plain source files.

usage:
  python pz2_build_pack.py --cobra-tools <dir> --src <mod source dir> [--out <dir>]
                           [--python <python with cobra-tools deps>] [--install "<Planet Zoo 2 dir>"]

Source layout (see template/MyMod):
  <src>/Main/*.lua    plain-text Lua modules; the game compiles them at load.
                      File names are dotted and lower case: mymod.core.lua is
                      require("MyMod.Core"); database.<pack>luadatabase.lua is the entry point.
  <src>/UI/...        optional: HTML / JS / CSS / SVG / PNG / JSON for a UI overlay
  <src>/Manifest.xml  optional: written on the first build with a new random ID, then kept

Output: <out>/<Pack>/Manifest.xml, Main.ovl and (with UI files) UI/<Pack>UI.ovl.
The pack name is the source folder's name.

Every OVL is extracted again after the build and compared byte for byte with the
sources, so a broken archive never reaches the game. Two PZ2 details are handled:
  - cobra-tools has no Planet Zoo 2 profile yet; PZ2 reads the Planet Coaster 2
    format, but only with header byte 4 (version_flag) set to 0x01.
  - a .ppuipkg is written as the XML cobra-tools expects (file bytes as signed chars).
"""
import argparse
import filecmp
import os
import shutil
import subprocess
import sys
import tempfile
import uuid
from xml.sax.saxutils import escape

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from ppuipkg_unpack import unpack  # noqa: E402

UI_EXTENSIONS = {".html", ".js", ".css", ".svg", ".png", ".json"}
MANIFEST = """<ContentPack version="1">
  <Name>{name}</Name>
  <ID>{id}</ID>
  <Version>1</Version>
  <Type>Game</Type>
</ContentPack>
"""


def run(args, cmd_args):
    cmd = [args.python, os.path.join(args.cobra_tools, "ovl_tool_cmd.py"), *cmd_args]
    proc = subprocess.run(cmd, cwd=args.cobra_tools, capture_output=True, text=True)
    if proc.returncode != 0 or "ERROR" in proc.stdout or "ERROR" in proc.stderr:
        sys.stderr.write(proc.stdout[-3000:] + proc.stderr[-3000:])
        raise SystemExit(f"cobra-tools failed: {' '.join(cmd_args)}")


def set_version_flag(ovl_path):
    with open(ovl_path, "r+b") as f:
        if f.read(4) != b"FRES":
            raise SystemExit(f"{ovl_path} is not an OVL")
        f.seek(4)
        f.write(b"\x01")


def ovl_new(args, src_dir, out_ovl):
    run(args, ["new", "-g", "Planet Coaster 2", "-i", src_dir, "-o", out_ovl, "-f"])
    set_version_flag(out_ovl)


def ui_files(ui_root):
    for dirpath, _, names in os.walk(ui_root):
        for name in sorted(names):
            if os.path.splitext(name)[1].lower() in UI_EXTENSIONS:
                full = os.path.join(dirpath, name)
                yield os.path.relpath(full, ui_root).replace(os.sep, "/"), full


def write_ppuipkg(path, pack, ui_root):
    files = list(ui_files(ui_root))
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(f'<PPUIPKGRoot file_count="{len(files)}" icondata_count="0" game="Planet Coaster 2">\n')
        f.write(f"\t<basic_path>{escape(pack)}/UI</basic_path>\n\t<files>\n")
        for rel, full in files:
            data = open(full, "rb").read()
            values = " ".join(str(b - 256 if b > 127 else b) for b in data)
            f.write(f'\t\t<ppuipkgfile file_size="{len(data)}">\n')
            f.write(f"\t\t\t<file_name>{escape(rel)}</file_name>\n")
            f.write(f"\t\t\t<file_content>{values}</file_content>\n")
            f.write("\t\t</ppuipkgfile>\n")
        f.write("\t</files>\n\t<types />\n</PPUIPKGRoot>\n")
    return len(files)


def verify_main(args, ovl, main_src, tmp):
    out = os.path.join(tmp, "verify_main")
    run(args, ["extract", ovl, "-o", out])
    names = sorted(os.listdir(main_src))
    for name in names:
        got = os.path.join(out, name.lower())
        if not os.path.exists(got) or not filecmp.cmp(os.path.join(main_src, name), got, shallow=False):
            raise SystemExit(f"Main.ovl round trip mismatch: {name}")
    print(f"  Main.ovl: {len(names)} Lua files verified")


def verify_ui(args, ovl, ui_root, tmp):
    out = os.path.join(tmp, "verify_ui")
    run(args, ["extract", ovl, "-o", out])
    pkgs = [f for f in os.listdir(out) if f.endswith(".ppuipkg")]
    if len(pkgs) != 1:
        raise SystemExit(f"expected one .ppuipkg in the UI overlay, found {pkgs}")
    files_dir = os.path.join(out, "files")
    count = unpack(os.path.join(out, pkgs[0]), files_dir)
    for rel, full in ui_files(ui_root):
        got = os.path.join(files_dir, rel)
        if not os.path.exists(got) or not filecmp.cmp(full, got, shallow=False):
            raise SystemExit(f"UI overlay round trip mismatch: {rel}")
    print(f"  {os.path.basename(ovl)}: {count} UI files verified")


def is_game_running(game):
    try:
        open(os.path.join(game, "PlanetZoo2.exe"), "r+b").close()
        return False
    except PermissionError:
        return True
    except OSError:
        return False


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--cobra-tools", required=True)
    p.add_argument("--src", required=True, help="mod source folder; its name is the pack name")
    p.add_argument("--out", default="build")
    p.add_argument("--python", default=sys.executable)
    p.add_argument("--install", help="Planet Zoo 2 folder; copies the pack to <game>/Win64/ovldata/<Pack>")
    args = p.parse_args()
    args.cobra_tools = os.path.abspath(args.cobra_tools)
    src = os.path.abspath(args.src)
    pack = os.path.basename(src.rstrip("\\/"))
    main_src = os.path.join(src, "Main")
    ui_root = os.path.join(src, "UI")
    if not os.path.isdir(main_src):
        raise SystemExit(f"{main_src} not found")
    entry = f"database.{pack.lower()}luadatabase.lua"
    if entry not in [n.lower() for n in os.listdir(main_src)]:
        print(f"warning: no Main/{entry}; the game will never run this pack's Lua")
    for name in os.listdir(main_src):
        if name != name.lower():
            print(f"warning: {name} is not lower case; game module files are")

    manifest = os.path.join(src, "Manifest.xml")
    if not os.path.exists(manifest):
        with open(manifest, "w", newline="\n") as f:
            f.write(MANIFEST.format(name=escape(pack), id=uuid.uuid4()))
        print(f"wrote {manifest} (new pack ID; keep this file)")

    dest = os.path.join(os.path.abspath(args.out), pack)
    if os.path.exists(dest):
        shutil.rmtree(dest)
    os.makedirs(dest)
    shutil.copyfile(manifest, os.path.join(dest, "Manifest.xml"))
    with tempfile.TemporaryDirectory() as tmp:
        main_ovl = os.path.join(dest, "Main.ovl")
        ovl_new(args, main_src, main_ovl)
        ui_ovl = None
        if os.path.isdir(ui_root) and any(True for _ in ui_files(ui_root)):
            os.makedirs(os.path.join(dest, "UI"))
            pkg_dir = os.path.join(tmp, "ui_src")
            os.makedirs(pkg_dir)
            write_ppuipkg(os.path.join(pkg_dir, (pack + "UI").lower() + ".ppuipkg"), pack, ui_root)
            ui_ovl = os.path.join(dest, "UI", pack + "UI.ovl")
            ovl_new(args, pkg_dir, ui_ovl)
        print("built", dest)
        verify_main(args, main_ovl, main_src, tmp)
        if ui_ovl:
            verify_ui(args, ui_ovl, ui_root, tmp)

    if args.install:
        if is_game_running(args.install):
            raise SystemExit("Planet Zoo 2 is running; close it and install again")
        target = os.path.join(args.install, "Win64", "ovldata", pack)
        if os.path.exists(target):
            shutil.rmtree(target)
        shutil.copytree(dest, target)
        print("installed to", target, "(delete that folder to uninstall)")


if __name__ == "__main__":
    main()
