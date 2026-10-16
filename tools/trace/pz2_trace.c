/*
 * Checkpoint tracer for debugging mods in-game.
 *
 * The same DLL is copied once per checkpoint name (cp_<name>.dll). Lua calls
 * package.loadlib("<dir>\\cp_<name>.dll", "*") at that point; loading the
 * copy runs DllMain, which appends "<time> cp_<name>" to trace.log next to
 * it. Nothing else happens, so a checkpoint cannot affect the game.
 *
 * For repeating breadcrumbs Lua can instead load the exported "mark"
 * function (package.loadlib(path, "mark")) and call it: every call appends
 * another line. It ignores its lua_State and returns 0 results, so it uses
 * no Lua API at all.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>

static HINSTANCE g_inst;

static void log_line(HINSTANCE inst)
{
    char path[MAX_PATH];
    DWORD n = GetModuleFileNameA(inst, path, MAX_PATH);
    if (n == 0 || n >= MAX_PATH)
        return;
    char *slash = strrchr(path, '\\');
    if (!slash)
        return;
    char name[MAX_PATH];
    strcpy_s(name, sizeof name, slash + 1);
    strcpy_s(slash + 1, MAX_PATH - (slash + 1 - path), "trace.log");

    HANDLE f = CreateFileA(path, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (f == INVALID_HANDLE_VALUE)
        return;
    SYSTEMTIME t;
    GetLocalTime(&t);
    char line[MAX_PATH + 64];
    int len = sprintf_s(line, sizeof line, "%02d:%02d:%02d.%03d tid=%lu %s\r\n",
                        t.wHour, t.wMinute, t.wSecond, t.wMilliseconds, GetCurrentThreadId(), name);
    DWORD written;
    if (len > 0)
        WriteFile(f, line, (DWORD)len, &written, NULL);
    CloseHandle(f);
}

__declspec(dllexport) int mark(void *L)
{
    (void)L;
    log_line(g_inst);
    return 0;
}

BOOL WINAPI DllMain(HINSTANCE inst, DWORD reason, LPVOID reserved)
{
    (void)reserved;
    if (reason != DLL_PROCESS_ATTACH)
        return TRUE;
    DisableThreadLibraryCalls(inst);
    g_inst = inst;
    log_line(inst);
    return TRUE;
}
