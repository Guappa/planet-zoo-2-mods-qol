"""Install a built PZ2QoL pack into a game folder, safely.

usage: python install_pz2qol.py <built PZ2QoL folder> <game folder> [--wait] [--backup-dir <dir>]

- Refuses while the game runs (PlanetZoo2.exe cannot be opened for writing);
  with --wait it checks every 15 s for up to 12 h and installs once it closes.
- Saves the old dbg/trace.log (if any) into --backup-dir first.
- Keeps the player's data file (userdata.json: habitat assignments...).
- Copies every file, removes files the new build no longer has, and then
  compares every file by sha1. A plain copy over the second PC's network
  share once came up short while reporting success, so nothing is trusted
  without the hash check; mismatches are recopied, and the run fails if any
  file still differs.
"""
import argparse
import hashlib
import os
import shutil
import sys
import time

PACK = "PZ2QoL"
KEEP = {"trace.log", "userdata.json"}  # written by the game/mod, never by the build


def sha1(path):
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def game_closed(game):
    try:
        open(os.path.join(game, "PlanetZoo2.exe"), "r+b").close()
        return True
    except OSError:
        return False


def files_under(root):
    for dirpath, _, names in os.walk(root):
        for name in names:
            yield os.path.relpath(os.path.join(dirpath, name), root)


def install(src, target):
    os.makedirs(target, exist_ok=True)
    wanted = {rel for rel in files_under(src) if os.path.basename(rel) not in KEEP}
    for rel in list(files_under(target)):
        if rel not in wanted and os.path.basename(rel) not in KEEP:
            os.remove(os.path.join(target, rel))
    for attempt in range(3):
        bad = []
        for rel in sorted(wanted):
            s, d = os.path.join(src, rel), os.path.join(target, rel)
            if os.path.exists(d) and sha1(s) == sha1(d):
                continue
            os.makedirs(os.path.dirname(d), exist_ok=True)
            if os.path.exists(d):
                os.remove(d)
            shutil.copyfile(s, d)
            bad.append(rel)
        if not bad:
            return len(wanted)
        print(f"  pass {attempt + 1}: copied {len(bad)} file(s), checking again")
    still = [rel for rel in wanted if sha1(os.path.join(src, rel)) != sha1(os.path.join(target, rel))]
    if still:
        raise SystemExit(f"install incomplete: {len(still)} file(s) differ, e.g. {still[:3]}")
    return len(wanted)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("src", help="built pack folder (…/PZ2QoL)")
    p.add_argument("game", help="Planet Zoo 2 folder")
    p.add_argument("--wait", action="store_true", help="wait for the game to close")
    p.add_argument("--backup-dir", help="where to save the old dbg/trace.log")
    args = p.parse_args()
    if not os.path.isfile(os.path.join(args.src, "Main.ovl")):
        raise SystemExit(f"not a built pack: {args.src}")
    deadline = time.time() + 12 * 3600
    while not game_closed(args.game):
        if not args.wait:
            raise SystemExit("the game is running; close it first (or use --wait)")
        if time.time() > deadline:
            raise SystemExit("gave up: the game was still running after 12 h")
        time.sleep(15)
    target = os.path.join(args.game, "Win64", "ovldata", PACK)
    log = os.path.join(target, "dbg", "trace.log")
    if args.backup_dir and os.path.isfile(log):
        os.makedirs(args.backup_dir, exist_ok=True)
        dest = os.path.join(args.backup_dir, time.strftime("trace_%Y%m%d_%H%M%S.log"))
        shutil.copyfile(log, dest)
        os.remove(log)
        print("saved old trace.log to", dest)
    n = install(args.src, target)
    print(f"installed {n} files to {target}, all verified by sha1")


if __name__ == "__main__":
    sys.exit(main())
