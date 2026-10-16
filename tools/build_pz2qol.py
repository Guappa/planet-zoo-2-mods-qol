"""Build the PZ2QoL content pack.

usage: python build_pz2qol.py --cobra-tools <dir> [--python <exe>] [--out <dir>] [--install <game dir>]

Produces <out>/PZ2QoL/:
  Manifest.xml
  Main.ovl            Lua (plain text; the game compiles it at load)
  UI/PZ2QoLUI.ovl     UI overlay: a .ppuipkg with our HTML/JS/CSS
Every OVL is extracted again afterwards and compared with the sources.
"""
import argparse
import filecmp
import os
import shutil
import subprocess
import sys
import tempfile
from xml.sax.saxutils import escape

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MOD_SRC = os.path.join(ROOT, "mods", "PZ2QoL")
PACK = "PZ2QoL"
UI_EXTENSIONS = {".html", ".js", ".css", ".svg", ".png", ".json"}
OVERLAY = "PZ2QoLUI"
MANIFEST = """<ContentPack version="1">
  <Name>PZ2QoL</Name>
  <ID>3b7f0c2e-9d4a-4e61-8f25-6a1c0d9e47b3</ID>
  <Version>1</Version>
  <Type>Game</Type>
</ContentPack>
"""


def run(cmd):
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0 or "ERROR" in proc.stdout or "ERROR" in proc.stderr:
        sys.stderr.write(proc.stdout[-3000:] + proc.stderr[-3000:])
        raise SystemExit(f"command failed: {' '.join(cmd)}")
    return proc.stdout


def set_version_flag(ovl_path):
    # Retail PZ2 OVLs have version_flag (header byte 4) = 0x01; cobra-tools'
    # Planet Coaster 2 profile writes 0x00.
    with open(ovl_path, "r+b") as f:
        head = f.read(8)
        if head[:4] != b"FRES":
            raise SystemExit(f"{ovl_path} is not an OVL")
        f.seek(4)
        f.write(b"\x01")


def ui_files():
    ui_root = os.path.join(MOD_SRC, "UI")
    for dirpath, _, names in os.walk(ui_root):
        for name in sorted(names):
            if os.path.splitext(name)[1].lower() not in UI_EXTENSIONS:
                continue
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, ui_root).replace(os.sep, "/")
            yield rel, full


def write_ppuipkg(path):
    """cobra-tools reads .ppuipkg as XML; file_content is signed char values."""
    files = list(ui_files())
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(f'<PPUIPKGRoot file_count="{len(files)}" icondata_count="0" game="Planet Coaster 2">\n')
        f.write(f"\t<basic_path>{PACK}/UI</basic_path>\n\t<files>\n")
        for rel, full in files:
            data = open(full, "rb").read()
            values = " ".join(str(b - 256 if b > 127 else b) for b in data)
            f.write(f'\t\t<ppuipkgfile file_size="{len(data)}">\n')
            f.write(f"\t\t\t<file_name>{escape(rel)}</file_name>\n")
            f.write(f"\t\t\t<file_content>{values}</file_content>\n")
            f.write("\t\t</ppuipkgfile>\n")
        f.write("\t</files>\n\t<types />\n</PPUIPKGRoot>\n")
    return files


def ovl_new(args, src_dir, out_ovl):
    run([args.python, os.path.join(args.cobra_tools, "ovl_tool_cmd.py"), "new",
         "-g", "Planet Coaster 2", "-i", src_dir, "-o", out_ovl, "-f"])
    set_version_flag(out_ovl)


def ovl_extract(args, ovl, out_dir):
    run([args.python, os.path.join(args.cobra_tools, "ovl_tool_cmd.py"), "extract", ovl, "-o", out_dir])


def verify_main(args, ovl, tmp):
    out = os.path.join(tmp, "verify_main")
    ovl_extract(args, ovl, out)
    src = os.path.join(MOD_SRC, "Main")
    for name in sorted(os.listdir(src)):
        got = os.path.join(out, name.lower())
        if not os.path.exists(got) or not filecmp.cmp(os.path.join(src, name), got, shallow=False):
            raise SystemExit(f"Main.ovl round trip mismatch: {name}")
    print(f"  Main.ovl: {len(os.listdir(src))} Lua files verified")


def verify_ui(args, ovl, tmp):
    out = os.path.join(tmp, "verify_ui")
    ovl_extract(args, ovl, out)
    pkgs = [f for f in os.listdir(out) if f.endswith(".ppuipkg")]
    if len(pkgs) != 1:
        raise SystemExit(f"expected one ppuipkg in UI overlay, found {pkgs}")
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from ppuipkg_unpack import unpack
    files_dir = os.path.join(out, "files")
    count = unpack(os.path.join(out, pkgs[0]), files_dir)
    for rel, full in ui_files():
        got = os.path.join(files_dir, rel)
        if not os.path.exists(got) or not filecmp.cmp(full, got, shallow=False):
            raise SystemExit(f"UI overlay round trip mismatch: {rel}")
    print(f"  {OVERLAY}.ovl: {count} UI files verified")


def find_vcvars():
    import glob
    roots = [os.environ.get("ProgramFiles", r"C:\Program Files"), r"C:\Program Files"]
    for root in roots:
        hits = sorted(glob.glob(os.path.join(root, "Microsoft Visual Studio", "*", "*", "VC", "Auxiliary", "Build", "vcvars64.bat")))
        if hits:
            return hits[-1]
    raise SystemExit("MSVC vcvars64.bat not found (needed for --debug-trace)")


def build_trace(dest, tmp):
    """Checkpoint tracer: one tiny DLL copied per checkpoint name."""
    src = os.path.join(ROOT, "tools", "trace", "pz2_trace.c")
    dll = os.path.join(tmp, "pz2_trace.dll")
    obj = os.path.join(tmp, "pz2_trace.obj")
    cmd = f'"{find_vcvars()}" >nul && cl /nologo /O2 /LD /MT "{src}" /Fe"{dll}" /Fo"{obj}" /link /NOLOGO'
    proc = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if proc.returncode != 0 or not os.path.exists(dll):
        sys.stderr.write(proc.stdout + proc.stderr)
        raise SystemExit("trace DLL build failed")
    dbg = os.path.join(dest, "dbg")
    os.makedirs(dbg)
    names = [n.strip() for n in open(os.path.join(ROOT, "tools", "trace", "checkpoints.txt")) if n.strip()]
    for name in names:
        shutil.copyfile(dll, os.path.join(dbg, f"cp_{name}.dll"))
    print(f"  debug trace: {len(names)} checkpoints -> {os.path.join(dbg, 'trace.log')}")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--cobra-tools", required=True)
    p.add_argument("--python", default=sys.executable)
    p.add_argument("--out", default=os.path.join(ROOT, "build"))
    p.add_argument("--install", help="game folder; copies the pack to <game>/Win64/ovldata/PZ2QoL")
    p.add_argument("--debug-trace", action="store_true",
                   help="add dbg/cp_*.dll checkpoint tracers; the game then writes dbg/trace.log")
    args = p.parse_args()

    dest = os.path.join(args.out, PACK)
    if os.path.exists(dest):
        shutil.rmtree(dest)
    os.makedirs(os.path.join(dest, "UI"))
    with tempfile.TemporaryDirectory() as tmp:
        main_ovl = os.path.join(dest, "Main.ovl")
        ovl_new(args, os.path.join(MOD_SRC, "Main"), main_ovl)

        ui_src = os.path.join(tmp, "ui_src")
        os.makedirs(ui_src)
        write_ppuipkg(os.path.join(ui_src, OVERLAY.lower() + ".ppuipkg"))
        ui_ovl = os.path.join(dest, "UI", OVERLAY + ".ovl")
        ovl_new(args, ui_src, ui_ovl)

        with open(os.path.join(dest, "Manifest.xml"), "w", newline="\n") as f:
            f.write(MANIFEST)

        if args.debug_trace:
            build_trace(dest, tmp)
        print("built", dest)
        verify_main(args, main_ovl, tmp)
        verify_ui(args, ui_ovl, tmp)

    if args.install:
        target = os.path.join(args.install, "Win64", "ovldata", PACK)
        if os.path.exists(target):
            shutil.rmtree(target)
        shutil.copytree(dest, target)
        print("installed to", target, "(delete that folder to uninstall)")


if __name__ == "__main__":
    main()
