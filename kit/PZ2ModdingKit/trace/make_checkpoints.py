"""Copy the tracer DLL once per checkpoint name: cp_<name>.dll.

usage: python make_checkpoints.py pz2_trace.dll checkpoints.txt <mod>/dbg
"""
import os
import shutil
import sys

dll, names_file, dest = sys.argv[1:4]
os.makedirs(dest, exist_ok=True)
names = [n.strip() for n in open(names_file) if n.strip() and not n.startswith("#")]
for name in names:
    shutil.copyfile(dll, os.path.join(dest, f"cp_{name}.dll"))
print(f"{len(names)} checkpoints in {dest}; the game writes {os.path.join(dest, 'trace.log')}")
