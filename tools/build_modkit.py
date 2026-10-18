"""Zip the Planet Zoo 2 Modding Kit (kit/PZ2ModdingKit) for Nexus.

usage: python tools/build_modkit.py [version]   -> dist/PZ2ModdingKit-<version>.zip

Only the kit's own text files go in (no __pycache__, no build output, no DLLs).
"""
import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KIT = os.path.join(ROOT, "kit", "PZ2ModdingKit")
ALLOWED = {".md", ".txt", ".py", ".c", ".lua"}


def main():
    version = sys.argv[1] if len(sys.argv) > 1 else "1.0.0"
    out = os.path.join(ROOT, "dist", f"PZ2ModdingKit-{version}.zip")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    count = 0
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for dirpath, dirnames, names in os.walk(KIT):
            dirnames[:] = sorted(d for d in dirnames if d != "__pycache__" and not d.startswith("%"))
            for name in sorted(names):
                ext = os.path.splitext(name)[1].lower()
                if ext not in ALLOWED:
                    raise SystemExit(f"unexpected file in kit: {os.path.join(dirpath, name)}")
                full = os.path.join(dirpath, name)
                rel = os.path.relpath(full, os.path.dirname(KIT)).replace(os.sep, "/")
                z.write(full, rel)
                count += 1
    print(f"{out}: {count} files, {os.path.getsize(out)} bytes")


if __name__ == "__main__":
    main()
