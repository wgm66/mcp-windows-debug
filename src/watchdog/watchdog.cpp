// McpWatchdog - native Windows safety process.
//
// Installs global low-level keyboard/mouse hooks that block INJECTED input
// aimed at protected screen regions. Human input always passes through.
//
// Safety contract (see .omo/plans/mcp-windows-debug.md todos 6 and 7):
//   * Never log keystroke/button content - only the injected flag + cursor
//     destination are inspected.
//   * Dead-man switch: a named pipe (`\\.\pipe\McpWatchdog-<id>`) carries
//     heartbeats. If none arrives for > 2 s, unhook and exit so a crashed
//     Node MCP can never leave input blocked.
//   * Runs as admin only; non-admin prints ERROR_ACCESS_DENIED and exits 1.
//
// IPC protocol (newline-delimited JSON on the same pipe):
//   * First frame from a client MUST be `{"token":"<hex>"}` matching the
//     WATCHDOG_TOKEN env var (an empty token disables auth). Until a matching
//     token is presented, every other frame is rejected and the connection
//     is closed.
//   * `{"op":"REGISTER_REGION","x":..,"y":..,"w":..,"h":..,"id":".."}` appends
//     a protected region. Regions are append-only for the session lifetime -
//     there is deliberately NO UNREGISTER_REGION.
//   * `{"op":"HEARTBEAT"}` refreshes the dead-man switch. Any bare byte still
//     counts as a heartbeat too (scaffold compatibility).
//   * `{"op":"STATUS"}` replies `{"hooked":bool,"regions":N}`.
//   * `{"op":"SHUTDOWN"}` unhooks and exits cleanly.

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------

static HHOOK g_hKeyboardHook = nullptr;
static HHOOK g_hMouseHook = nullptr;
static HANDLE g_hPipe = INVALID_HANDLE_VALUE;
static HANDLE g_hPipeThread = nullptr;
static HWND g_hwnd = nullptr;

// Token required to authenticate a pipe client (read from WATCHDOG_TOKEN env).
// Empty => authentication disabled (bare-heartbeat scaffold compatibility).
static std::string g_token;

// Protected regions, in screen coordinates (physical pixels). The pipe thread
// appends (REGISTER_REGION) while the LL hook procs (main thread) read via
// PointInRegions, so access is guarded by g_regionsLock.
struct Region {
    LONG x, y, w, h;
};
static std::vector<Region> g_regions;
static SRWLOCK g_regionsLock = SRWLOCK_INIT;

// Heartbeat state. Updated by the pipe thread, read by the main thread.
static std::atomic<unsigned long long> g_lastHeartbeat{ 0 };
static std::atomic<bool> g_running{ true };

// Hook proc timing (max observed microseconds). LL hook procs run on the main
// thread, so a plain global is safe.
static double g_maxProcUs = 0.0;
static LARGE_INTEGER g_qpcFreq{};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

static void UpdateMaxProcUs(LARGE_INTEGER t0, LARGE_INTEGER t1) {
    double us = static_cast<double>(t1.QuadPart - t0.QuadPart) * 1e6 /
                static_cast<double>(g_qpcFreq.QuadPart);
    if (us > g_maxProcUs) {
        g_maxProcUs = us;
    }
}

static bool PointInRegions(LONG px, LONG py) {
    AcquireSRWLockShared(&g_regionsLock);
    for (const Region& r : g_regions) {
        if (px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h) {
            ReleaseSRWLockShared(&g_regionsLock);
            return true;
        }
    }
    ReleaseSRWLockShared(&g_regionsLock);
    return false;
}

static bool IsElevated() {
    bool elevated = false;
    HANDLE token = nullptr;
    if (OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {
        TOKEN_ELEVATION te{};
        DWORD sz = sizeof(te);
        if (GetTokenInformation(token, TokenElevation, &te, sizeof(te), &sz)) {
            elevated = te.TokenIsElevated != 0;
        }
        CloseHandle(token);
    }
    return elevated;
}

static bool ParseRegion(const char* s, Region& out) {
    long v[4] = { 0, 0, 0, 0 };
    const char* p = s;
    for (int i = 0; i < 4; ++i) {
        char* end = nullptr;
        v[i] = strtol(p, &end, 10);
        if (end == p) {
            return false;
        }
        p = end;
        if (i < 3) {
            if (*p != ',') {
                return false;
            }
            ++p;
        }
    }
    out.x = static_cast<LONG>(v[0]);
    out.y = static_cast<LONG>(v[1]);
    out.w = static_cast<LONG>(v[2]);
    out.h = static_cast<LONG>(v[3]);
    return true;
}

// ---------------------------------------------------------------------------
// Hook procs (run on the main thread's message loop)
// ---------------------------------------------------------------------------

static LRESULT CALLBACK KeyboardProc(int nCode, WPARAM wParam, LPARAM lParam) {
    if (nCode == HC_ACTION) {
        LARGE_INTEGER t0{}, t1{};
        QueryPerformanceCounter(&t0);
        const KBDLLHOOKSTRUCT* k = reinterpret_cast<const KBDLLHOOKSTRUCT*>(lParam);
        if ((k->flags & LLKHF_INJECTED) != 0) {
            // Destination is the current cursor position; the event itself
            // carries no keystroke content we ever read.
            POINT pt{};
            if (GetCursorPos(&pt) && PointInRegions(pt.x, pt.y)) {
                QueryPerformanceCounter(&t1);
                UpdateMaxProcUs(t0, t1);
                return 1; // block injected event aimed at a protected region
            }
        }
        QueryPerformanceCounter(&t1);
        UpdateMaxProcUs(t0, t1);
    }
    return CallNextHookEx(g_hKeyboardHook, nCode, wParam, lParam);
}

static LRESULT CALLBACK MouseProc(int nCode, WPARAM wParam, LPARAM lParam) {
    if (nCode == HC_ACTION) {
        LARGE_INTEGER t0{}, t1{};
        QueryPerformanceCounter(&t0);
        const MSLLHOOKSTRUCT* m = reinterpret_cast<const MSLLHOOKSTRUCT*>(lParam);
        if ((m->flags & LLMHF_INJECTED) != 0) {
            if (PointInRegions(m->pt.x, m->pt.y)) {
                QueryPerformanceCounter(&t1);
                UpdateMaxProcUs(t0, t1);
                return 1; // block injected event aimed at a protected region
            }
        }
        QueryPerformanceCounter(&t1);
        UpdateMaxProcUs(t0, t1);
    }
    return CallNextHookEx(g_hMouseHook, nCode, wParam, lParam);
}

// ---------------------------------------------------------------------------
// Message-only window + heartbeat monitor (main thread)
// ---------------------------------------------------------------------------

static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    switch (msg) {
    case WM_TIMER: {
        unsigned long long now = GetTickCount64();
        if (now - g_lastHeartbeat.load() > 2000) {
            // Dead-man switch tripped: no heartbeat for > 2 s.
            PostQuitMessage(0);
        }
        return 0;
    }
    }
    return DefWindowProc(hwnd, msg, wParam, lParam);
}

// ---------------------------------------------------------------------------
// IPC pipe thread: token auth + newline-delimited JSON protocol
// ---------------------------------------------------------------------------

// Write a NUL-terminated reply to the connected pipe. Called from the pipe
// thread only, where g_hPipe is valid.
static void WritePipe(const char* s) {
    DWORD n = 0;
    WriteFile(g_hPipe, s, static_cast<DWORD>(std::strlen(s)), &n, nullptr);
}

// Skip ASCII whitespace (space, tab, CR, LF).
static void SkipWs(const std::string& s, size_t& i) {
    while (i < s.size() &&
           (s[i] == ' ' || s[i] == '\t' || s[i] == '\r' || s[i] == '\n')) {
        ++i;
    }
}

// Extract the string value of a top-level `"key":` pair from a flat JSON
// object. Values we emit are alphanumeric (tokens, ids) with no escapes, so a
// simple quote-to-quote scan suffices. Returns false if absent/malformed.
static bool JsonGetString(const std::string& s, const char* key, std::string& out) {
    std::string needle = "\"";
    needle += key;
    needle += "\"";
    size_t i = s.find(needle);
    if (i == std::string::npos) {
        return false;
    }
    i += needle.size();
    SkipWs(s, i);
    if (i >= s.size() || s[i] != ':') {
        return false;
    }
    ++i;
    SkipWs(s, i);
    if (i >= s.size() || s[i] != '"') {
        return false;
    }
    ++i;
    size_t start = i;
    while (i < s.size() && s[i] != '"') {
        ++i;
    }
    if (i >= s.size()) {
        return false;
    }
    out = s.substr(start, i - start);
    return true;
}

// Extract the integer value of a top-level `"key":` pair.
static bool JsonGetInt(const std::string& s, const char* key, long& out) {
    std::string needle = "\"";
    needle += key;
    needle += "\"";
    size_t i = s.find(needle);
    if (i == std::string::npos) {
        return false;
    }
    i += needle.size();
    SkipWs(s, i);
    if (i >= s.size() || s[i] != ':') {
        return false;
    }
    ++i;
    SkipWs(s, i);
    if (i >= s.size()) {
        return false;
    }
    char* end = nullptr;
    long v = strtol(s.c_str() + i, &end, 10);
    if (end == s.c_str() + i) {
        return false;
    }
    out = v;
    return true;
}

// Handle one complete JSON frame. Returns false to close the connection.
static bool HandleLine(const std::string& line, bool& authenticated) {
    if (line.empty()) {
        return true; // bare newline: heartbeat only (already counted)
    }

    if (!authenticated) {
        // The only acceptable pre-auth frame is the correct token.
        std::string tok;
        if (JsonGetString(line, "token", tok) && tok == g_token) {
            authenticated = true;
            WritePipe("{\"ok\":true,\"op\":\"AUTH\"}\n");
            return true;
        }
        WritePipe("{\"ok\":false,\"error\":\"unauthorized\"}\n");
        return false; // reject: disconnect, keep listening for a valid client
    }

    std::string op;
    if (!JsonGetString(line, "op", op)) {
        return true; // not a command frame (e.g. bare-byte heartbeat)
    }

    if (op == "REGISTER_REGION") {
        long x = 0, y = 0, w = 0, h = 0;
        std::string id;
        if (JsonGetInt(line, "x", x) && JsonGetInt(line, "y", y) &&
            JsonGetInt(line, "w", w) && JsonGetInt(line, "h", h) &&
            JsonGetString(line, "id", id)) {
            if (w <= 0 || h <= 0) {
                WritePipe("{\"ok\":false,\"op\":\"REGISTER_REGION\",\"error\":\"invalid region\"}\n");
                return true;
            }
            Region r{};
            r.x = static_cast<LONG>(x);
            r.y = static_cast<LONG>(y);
            r.w = static_cast<LONG>(w);
            r.h = static_cast<LONG>(h);
            AcquireSRWLockExclusive(&g_regionsLock);
            g_regions.push_back(r);
            ReleaseSRWLockExclusive(&g_regionsLock);
            WritePipe("{\"ok\":true,\"op\":\"REGISTER_REGION\"}\n");
            return true;
        }
        WritePipe("{\"ok\":false,\"op\":\"REGISTER_REGION\",\"error\":\"bad payload\"}\n");
        return true;
    }

    if (op == "HEARTBEAT") {
        g_lastHeartbeat.store(GetTickCount64());
        return true; // no reply
    }

    if (op == "STATUS") {
        AcquireSRWLockShared(&g_regionsLock);
        size_t nregions = g_regions.size();
        ReleaseSRWLockShared(&g_regionsLock);
        bool hooked = (g_hKeyboardHook != nullptr && g_hMouseHook != nullptr);
        char reply[64];
        std::snprintf(reply, sizeof(reply), "{\"hooked\":%s,\"regions\":%zu}\n",
                      hooked ? "true" : "false", nregions);
        WritePipe(reply);
        return true;
    }

    if (op == "SHUTDOWN") {
        WritePipe("{\"ok\":true,\"op\":\"SHUTDOWN\"}\n");
        PostMessageW(g_hwnd, WM_QUIT, 0, 0);
        return false;
    }

    return true; // unknown op: ignore, still counts as a heartbeat
}

static DWORD WINAPI PipeThread(LPVOID /*unused*/) {
    // g_hPipe is created by main before this thread starts.
    while (g_running.load()) {
        BOOL ok = ConnectNamedPipe(g_hPipe, nullptr);
        if (!ok) {
            DWORD err = GetLastError();
            if (err == ERROR_PIPE_CONNECTED) {
                ok = TRUE;
            } else if (err == ERROR_NO_DATA) {
                DisconnectNamedPipe(g_hPipe);
                continue; // client connected then closed before sending
            } else {
                break; // pipe closed (shutdown) or unrecoverable error
            }
        }
        if (!ok) {
            break;
        }

        bool authenticated = g_token.empty(); // no token configured => open
        std::string line;
        char buf[256];

        for (;;) {
            DWORD n = 0;
            BOOL r = ReadFile(g_hPipe, buf, sizeof(buf), &n, nullptr);
            if (r && n > 0) {
                // ANY byte read refreshes the dead-man switch (bare-byte
                // heartbeat compatibility). Content is never logged.
                g_lastHeartbeat.store(GetTickCount64());
                for (DWORD i = 0; i < n; ++i) {
                    char c = buf[i];
                    if (c == '\n') {
                        if (!line.empty() && line.back() == '\r') {
                            line.pop_back();
                        }
                        bool keep = HandleLine(line, authenticated);
                        line.clear();
                        if (!keep) {
                            break;
                        }
                    } else {
                        line.push_back(c);
                    }
                }
            }
            if (!r) {
                DWORD err = GetLastError();
                if (err == ERROR_BROKEN_PIPE || err == ERROR_PIPE_NOT_CONNECTED ||
                    err == ERROR_NO_DATA) {
                    break; // client disconnected
                }
                if (err == ERROR_MORE_DATA) {
                    continue;
                }
                break;
            }
            if (n == 0) {
                break;
            }
        }
        DisconnectNamedPipe(g_hPipe);
    }
    return 0;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

static void Cleanup() {
    if (g_hKeyboardHook) {
        UnhookWindowsHookEx(g_hKeyboardHook);
        g_hKeyboardHook = nullptr;
    }
    if (g_hMouseHook) {
        UnhookWindowsHookEx(g_hMouseHook);
        g_hMouseHook = nullptr;
    }
    g_running.store(false);
    if (g_hPipe != INVALID_HANDLE_VALUE) {
        CloseHandle(g_hPipe); // unblocks the pipe thread's pending op
        g_hPipe = INVALID_HANDLE_VALUE;
    }
    if (g_hPipeThread) {
        WaitForSingleObject(g_hPipeThread, 1000);
        CloseHandle(g_hPipeThread);
        g_hPipeThread = nullptr;
    }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

static void PrintUsage() {
    std::printf(
        "McpWatchdog - native Windows safety process (global low-level hooks)\n"
        "\n"
        "Usage: watchdog.exe [--test-region x,y,w,h]... [--pipe-id <id>]\n"
        "\n"
        "  --test-region x,y,w,h   Pre-register a protected screen region (repeatable).\n"
        "                          Injected input inside a region is blocked.\n"
        "  --pipe-id <id>          Named-pipe id (default: \"default\").\n"
        "                          Pipe path: \\\\.\\pipe\\McpWatchdog-<id>.\n"
        "  --help                  Show this message.\n"
        "\n"
        "Requires Administrator privileges. Exits (unhooking both hooks) when\n"
        "no heartbeat is received on the pipe for > 2 seconds.\n");
}

int main(int argc, char** argv) {
    QueryPerformanceFrequency(&g_qpcFreq);

    if (!IsElevated()) {
        std::fprintf(stderr,
                     "ERROR_ACCESS_DENIED: McpWatchdog requires Administrator "
                     "privileges (global low-level hooks are restricted to "
                     "elevated processes). Re-run from an elevated shell.\n");
        return 1;
    }

    std::string pipeId = "default";

    for (int i = 1; i < argc; ++i) {
        const char* a = argv[i];
        if (std::strcmp(a, "--help") == 0 || std::strcmp(a, "-h") == 0) {
            PrintUsage();
            return 0;
        } else if (std::strcmp(a, "--test-region") == 0 && i + 1 < argc) {
            Region r{};
            if (!ParseRegion(argv[++i], r)) {
                std::fprintf(stderr, "invalid --test-region value: \"%s\" (expected x,y,w,h)\n", argv[i]);
                return 1;
            }
            g_regions.push_back(r);
        } else if (std::strncmp(a, "--test-region=", 14) == 0) {
            Region r{};
            if (!ParseRegion(a + 14, r)) {
                std::fprintf(stderr, "invalid --test-region value: \"%s\" (expected x,y,w,h)\n", a + 14);
                return 1;
            }
            g_regions.push_back(r);
        } else if (std::strcmp(a, "--pipe-id") == 0 && i + 1 < argc) {
            pipeId = argv[++i];
        } else if (std::strncmp(a, "--pipe-id=", 10) == 0) {
            pipeId = a + 10;
        } else {
            std::fprintf(stderr, "unknown argument: \"%s\" (try --help)\n", a);
            return 1;
        }
    }

    // Read the pipe-auth token from the environment (never argv, which any
    // same-user process could read). Empty => authentication disabled.
    {
        char tokenBuf[256]{};
        DWORD tokenLen = GetEnvironmentVariableA("WATCHDOG_TOKEN", tokenBuf,
                                                 sizeof(tokenBuf));
        if (tokenLen > 0 && tokenLen < sizeof(tokenBuf)) {
            g_token.assign(tokenBuf, tokenLen);
        }
    }

    // Message-only window + message loop so LL hooks dispatch on this thread.
    WNDCLASSW wc{};
    wc.lpfnWndProc = WndProc;
    wc.hInstance = GetModuleHandleW(nullptr);
    wc.lpszClassName = L"McpWatchdogMsgWnd";
    if (!RegisterClassW(&wc)) {
        DWORD err = GetLastError();
        if (err != ERROR_CLASS_ALREADY_EXISTS) {
            std::fprintf(stderr, "RegisterClassW failed: %lu\n", err);
            return 1;
        }
    }

    HWND hwnd = CreateWindowExW(0, wc.lpszClassName, L"McpWatchdog", 0, 0, 0, 0, 0,
                                HWND_MESSAGE, nullptr, wc.hInstance, nullptr);
    if (!hwnd) {
        std::fprintf(stderr, "CreateWindowExW failed: %lu\n", GetLastError());
        return 1;
    }
    g_hwnd = hwnd; // the pipe thread posts WM_QUIT here on SHUTDOWN

    // Install global low-level hooks. LL hooks do NOT require a separate DLL;
    // the hook proc lives in this EXE. hMod = our module, dwThreadId = 0 (all).
    HINSTANCE hSelf = GetModuleHandleW(nullptr);
    g_hKeyboardHook = SetWindowsHookExW(WH_KEYBOARD_LL, KeyboardProc, hSelf, 0);
    g_hMouseHook = SetWindowsHookExW(WH_MOUSE_LL, MouseProc, hSelf, 0);
    if (!g_hKeyboardHook || !g_hMouseHook) {
        std::fprintf(stderr, "SetWindowsHookEx failed: %lu\n", GetLastError());
        Cleanup();
        return 1;
    }

    std::string pipePath = "\\\\.\\pipe\\McpWatchdog-" + pipeId;
    g_hPipe = CreateNamedPipeA(pipePath.c_str(),
                               PIPE_ACCESS_DUPLEX,
                               PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                               PIPE_UNLIMITED_INSTANCES,
                               256, 256, 0, nullptr);
    if (g_hPipe == INVALID_HANDLE_VALUE) {
        std::fprintf(stderr, "CreateNamedPipe failed: %lu\n", GetLastError());
        Cleanup();
        return 1;
    }

    g_hPipeThread = CreateThread(nullptr, 0, PipeThread, nullptr, 0, nullptr);
    if (!g_hPipeThread) {
        std::fprintf(stderr, "CreateThread failed: %lu\n", GetLastError());
        Cleanup();
        return 1;
    }

    std::printf("[watchdog] elevated=yes hooks=keyboard+mouse pipe=%s regions=%zu auth=%s\n",
                pipePath.c_str(), g_regions.size(),
                g_token.empty() ? "off" : "token");
    for (const Region& r : g_regions) {
        std::printf("[watchdog]   region x=%ld y=%ld w=%ld h=%ld\n", r.x, r.y, r.w, r.h);
    }
    std::printf("[watchdog] heartbeat dead-man active (2 s timeout)\n");
    std::fflush(stdout);

    g_lastHeartbeat.store(GetTickCount64()); // avoid immediate timeout at startup

    SetTimer(hwnd, 1, 200, nullptr); // monitor every 200 ms

    MSG msg{};
    while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }

    // Loop ended (WM_QUIT) - heartbeat timeout or shutdown.
    Cleanup();
    std::printf("[watchdog] exiting cleanly; hooks removed; max hook-proc time=%.3f us\n",
                g_maxProcUs);
    return 0;
}
