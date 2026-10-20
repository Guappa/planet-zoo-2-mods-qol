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
 *
 * Detailed log (free text with values, 2026-10-18). The game exports no
 * Lua C API (no lua_* symbols), so a C function cannot read its Lua
 * arguments. Instead Lua spells each line one character at a time through
 * more copies of this DLL, still calling nothing but "mark":
 *   lg_clr.dll   clears this thread's line
 *   lg_XX.dll    appends the byte 0xXX (XX = 20..7e, printable ASCII)
 *   lg_end.dll   writes "<time> tid=<thread> LOG <line>" to trace.log
 *   lg_core.dll  holds the per-thread lines (the others load it lazily,
 *                outside DllMain, and call its lg_put / lg_end / lg_clr)
 * The lg_* copies write nothing when they are loaded. Lines are kept per
 * thread, so game Lua running on several threads cannot interleave them.
 * Still no Lua API and no game memory is read: a misbehaving log can only
 * lose lines, never touch the game.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <string.h>

enum { ROLE_NONE, ROLE_CP, ROLE_BYTE, ROLE_END, ROLE_CLR, ROLE_CORE };

static HINSTANCE g_inst;
static int g_role = ROLE_NONE;
static int g_byte;

/* trace.log next to this module; 0 on failure */
static int trace_path(HINSTANCE inst, char *path, char *name, size_t cap)
{
    DWORD n = GetModuleFileNameA(inst, path, (DWORD)cap);
    if (n == 0 || n >= cap)
        return 0;
    char *slash = strrchr(path, '\\');
    if (!slash)
        return 0;
    if (name)
        strcpy_s(name, MAX_PATH, slash + 1);
    strcpy_s(slash + 1, cap - (slash + 1 - path), "trace.log");
    return 1;
}

static void append(const char *path, const char *text, int len)
{
    HANDLE f = CreateFileA(path, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (f == INVALID_HANDLE_VALUE)
        return;
    DWORD written;
    if (len > 0)
        WriteFile(f, text, (DWORD)len, &written, NULL);
    CloseHandle(f);
}

static void log_line(HINSTANCE inst)
{
    char path[MAX_PATH], name[MAX_PATH];
    if (!trace_path(inst, path, name, MAX_PATH))
        return;
    SYSTEMTIME t;
    GetLocalTime(&t);
    char line[MAX_PATH + 64];
    int len = sprintf_s(line, sizeof line, "%02d:%02d:%02d.%03d tid=%lu %s\r\n",
                        t.wHour, t.wMinute, t.wSecond, t.wMilliseconds, GetCurrentThreadId(), name);
    append(path, line, len);
}

/* ------------------------------------------------------------------ core */
/* Only the lg_core.dll copy's state is used; every copy carries the code. */
#define LG_SLOTS 32
#define LG_MAX 1500
static struct {
    DWORD tid;
    int len;
    char buf[LG_MAX];
} g_slots[LG_SLOTS];
static SRWLOCK g_lock = SRWLOCK_INIT;

/* this thread's slot; with take, a free one when it has none (or NULL) */
static int slot_of(DWORD tid, int take)
{
    int free_slot = -1;
    for (int i = 0; i < LG_SLOTS; i++) {
        if (g_slots[i].tid == tid)
            return i;
        if (free_slot < 0 && g_slots[i].tid == 0)
            free_slot = i;
    }
    if (take && free_slot >= 0) {
        g_slots[free_slot].tid = tid;
        g_slots[free_slot].len = 0;
        return free_slot;
    }
    return -1;
}

__declspec(dllexport) void lg_put(int ch)
{
    DWORD tid = GetCurrentThreadId();
    AcquireSRWLockExclusive(&g_lock);
    int i = slot_of(tid, 1);
    if (i >= 0 && g_slots[i].len < LG_MAX)
        g_slots[i].buf[g_slots[i].len++] = (char)ch;
    ReleaseSRWLockExclusive(&g_lock);
}

__declspec(dllexport) void lg_clr(void)
{
    DWORD tid = GetCurrentThreadId();
    AcquireSRWLockExclusive(&g_lock);
    int i = slot_of(tid, 0);
    if (i >= 0) {
        g_slots[i].tid = 0;
        g_slots[i].len = 0;
    }
    ReleaseSRWLockExclusive(&g_lock);
}

__declspec(dllexport) void lg_end(void)
{
    DWORD tid = GetCurrentThreadId();
    char text[LG_MAX + 1];
    int n = 0;
    AcquireSRWLockExclusive(&g_lock);
    int i = slot_of(tid, 0);
    if (i >= 0) {
        n = g_slots[i].len;
        memcpy(text, g_slots[i].buf, (size_t)n);
        g_slots[i].tid = 0;
        g_slots[i].len = 0;
    }
    ReleaseSRWLockExclusive(&g_lock);
    if (n <= 0)
        return;
    text[n] = 0;
    char path[MAX_PATH];
    if (!trace_path(g_inst, path, NULL, MAX_PATH))
        return;
    SYSTEMTIME t;
    GetLocalTime(&t);
    char head[64];
    int hl = sprintf_s(head, sizeof head, "%02d:%02d:%02d.%03d tid=%lu LOG ",
                       t.wHour, t.wMinute, t.wSecond, t.wMilliseconds, tid);
    if (hl <= 0)
        return;
    /* one WriteFile per line (appends stay whole across threads) */
    char out[LG_MAX + 96];
    memcpy(out, head, (size_t)hl);
    memcpy(out + hl, text, (size_t)n);
    out[hl + n] = '\r';
    out[hl + n + 1] = '\n';
    append(path, out, hl + n + 2);
}

/* --------------------------------------------------------- lg_* copies */
typedef void (*put_fn)(int);
typedef void (*void_fn)(void);
static put_fn g_put;
static void_fn g_end, g_clr;
static volatile LONG g_core_tried;

/* loads lg_core.dll from this module's folder (never from DllMain) */
static int ensure_core(void)
{
    if (g_put && g_end && g_clr)
        return 1;
    if (InterlockedExchange(&g_core_tried, 1))
        return g_put && g_end && g_clr;
    char path[MAX_PATH];
    DWORD n = GetModuleFileNameA(g_inst, path, MAX_PATH);
    if (n == 0 || n >= MAX_PATH)
        return 0;
    char *slash = strrchr(path, '\\');
    if (!slash)
        return 0;
    strcpy_s(slash + 1, MAX_PATH - (slash + 1 - path), "lg_core.dll");
    HMODULE core = LoadLibraryA(path);
    if (!core)
        return 0;
    void_fn e = (void_fn)GetProcAddress(core, "lg_end");
    void_fn c = (void_fn)GetProcAddress(core, "lg_clr");
    put_fn p = (put_fn)GetProcAddress(core, "lg_put");
    if (!p || !e || !c)
        return 0;
    g_end = e;
    g_clr = c;
    g_put = p;
    return 1;
}

static int hexval(char c)
{
    if (c >= '0' && c <= '9')
        return c - '0';
    if (c >= 'a' && c <= 'f')
        return c - 'a' + 10;
    if (c >= 'A' && c <= 'F')
        return c - 'A' + 10;
    return -1;
}

/* what this copy does, from its file name */
static void set_role(HINSTANCE inst)
{
    char path[MAX_PATH];
    DWORD n = GetModuleFileNameA(inst, path, MAX_PATH);
    if (n == 0 || n >= MAX_PATH)
        return;
    char *slash = strrchr(path, '\\');
    const char *name = slash ? slash + 1 : path;
    if (_strnicmp(name, "lg_", 3) != 0) {
        g_role = ROLE_CP;
        return;
    }
    const char *rest = name + 3;
    if (_stricmp(rest, "end.dll") == 0)
        g_role = ROLE_END;
    else if (_stricmp(rest, "clr.dll") == 0)
        g_role = ROLE_CLR;
    else if (_stricmp(rest, "core.dll") == 0)
        g_role = ROLE_CORE;
    else if (hexval(rest[0]) >= 0 && hexval(rest[1]) >= 0 && _stricmp(rest + 2, ".dll") == 0) {
        int b = hexval(rest[0]) * 16 + hexval(rest[1]);
        if (b >= 0x20 && b <= 0x7e) {
            g_byte = b;
            g_role = ROLE_BYTE;
        }
    }
}

__declspec(dllexport) int mark(void *L)
{
    (void)L;
    switch (g_role) {
    case ROLE_CP:
        log_line(g_inst);
        break;
    case ROLE_BYTE:
        if (ensure_core())
            g_put(g_byte);
        break;
    case ROLE_END:
        if (ensure_core())
            g_end();
        break;
    case ROLE_CLR:
        if (ensure_core())
            g_clr();
        break;
    default:
        break;
    }
    return 0;
}

BOOL WINAPI DllMain(HINSTANCE inst, DWORD reason, LPVOID reserved)
{
    (void)reserved;
    if (reason != DLL_PROCESS_ATTACH)
        return TRUE;
    DisableThreadLibraryCalls(inst);
    g_inst = inst;
    set_role(inst);
    if (g_role == ROLE_CP)
        log_line(inst);
    return TRUE;
}
