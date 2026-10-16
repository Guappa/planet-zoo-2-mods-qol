/*
 * PZ2Harness native probe.
 *
 * Loaded from Lua via package.loadlib(). It does not link against Lua (the
 * game links Lua statically and exports no lua_* symbols); it only proves
 * that a content pack can get native code running inside PlanetZoo2.exe.
 *
 * Writes pz2h_native.log next to this DLL.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>

static HMODULE g_self;

static void log_line(const char *fmt, ...)
{
    char path[MAX_PATH];
    DWORD n = GetModuleFileNameA(g_self, path, MAX_PATH);
    if (n == 0 || n >= MAX_PATH)
        return;
    char *slash = strrchr(path, '\\');
    if (!slash)
        return;
    strcpy_s(slash + 1, MAX_PATH - (slash + 1 - path), "pz2h_native.log");

    FILE *f = NULL;
    if (fopen_s(&f, path, "a") != 0 || !f)
        return;

    SYSTEMTIME t;
    GetLocalTime(&t);
    fprintf(f, "%04d-%02d-%02d %02d:%02d:%02d.%03d pid=%lu tid=%lu ",
            t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond, t.wMilliseconds,
            GetCurrentProcessId(), GetCurrentThreadId());

    va_list ap;
    va_start(ap, fmt);
    vfprintf(f, fmt, ap);
    va_end(ap);
    fputc('\n', f);
    fclose(f);
}

BOOL WINAPI DllMain(HINSTANCE inst, DWORD reason, LPVOID reserved)
{
    (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) {
        g_self = inst;
        DisableThreadLibraryCalls(inst);
        char exe[MAX_PATH] = {0};
        GetModuleFileNameA(NULL, exe, MAX_PATH);
        char cwd[MAX_PATH] = {0};
        GetCurrentDirectoryA(MAX_PATH, cwd);
        log_line("DLL_PROCESS_ATTACH exe=\"%s\" cwd=\"%s\" exebase=%p", exe, cwd,
                 (void *)GetModuleHandleA(NULL));
    }
    return TRUE;
}

/* lua_CFunction signature: int f(lua_State *L). Returns 0 Lua results. */
__declspec(dllexport) int pz2h_hello(void *L)
{
    log_line("pz2h_hello called from Lua, lua_State=%p", L);
    return 0;
}

/* Entry point if the DLL is ever reached through require()'s C searcher. */
__declspec(dllexport) int luaopen_pz2h_native(void *L)
{
    log_line("luaopen_pz2h_native called (require path), lua_State=%p", L);
    return 0;
}
