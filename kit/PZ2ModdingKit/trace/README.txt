Checkpoint tracer: a log file for mod Lua
=========================================

Retail Planet Zoo 2 gives mod Lua no visible output: there is no io library,
api.debug.Trace goes nowhere, and the api.debug file calls are stubs. The game
does let Lua call package.loadlib, so a mod can "log" by loading tiny DLLs:

  package.loadlib("<dir>\\cp_<name>.dll", "*")     loads it once: DllMain appends
                                                   "HH:MM:SS.mmm tid=<thread> cp_<name>.dll"
                                                   to trace.log next to the DLL
  package.loadlib("<dir>\\cp_<name>.dll", "mark")  returns the exported mark(); every
                                                   call appends another line

The DLL touches nothing else: no Lua API, no game memory. It only writes trace.log.
The template mod's Core:Mark(name) does all of this for you.

This kit ships the source only (pz2_trace.c). Build it yourself:

1. Install Visual Studio (Community is fine) with "Desktop development with C++".
2. Open "x64 Native Tools Command Prompt for VS" and run:
       cl /nologo /O2 /LD /MT pz2_trace.c /Fe:pz2_trace.dll
3. List your checkpoint names, one per line, in checkpoints.txt (e.g. boot, booted,
   add_content_to_call, example_patched, example_first_park_tick).
4. Make one copy per name in your mod's dbg folder:
       python make_checkpoints.py pz2_trace.dll checkpoints.txt "<game>\Win64\ovldata\MyMod\dbg"
5. Play, then read <game>\Win64\ovldata\MyMod\dbg\trace.log.

A name without its own cp_<name>.dll is silently not logged. Never ship the dbg
folder in a release: without it every Mark is a no-op.

Tips
- Line up the last trace lines with a crash dump's time to see what ran last
  (tools\crashsum.py prints the game's running time).
- Game Lua runs on several threads (Main and "fTask Wn" workers); the tid column
  shows which.
- To log a number, spell it with names like chr_0 .. chr_9, chr_minus, chr_dot.
