// McpWatchdog - native Windows safety process.
//
// Installs global low-level keyboard/mouse hooks that block INJECTED input
// aimed at protected screen regions. Human input always passes through.
//
// Safety contract (see .omo/plans/mcp-windows-debug.md todo 6):
//   * Never log keystroke/button content - only the injected flag + cursor
//     destination are inspected.
//   * Dead-man switch: a bare named pipe (`\\.\pipe\McpWatchdog-<id>`)
//     carries heartbeats. If none arrives for > 2 s, unhook and exit so a
//     crashed Node MCP can never leave input blocked.
//   * Runs as admin only; non-admin prints ERROR_ACCESS_DENIED and exits 1.
//
// TODO 7 will add the formal REGISTER_REGION/STATUS/SHUTDOWN protocol on the
// same pipe. This scaffold only supports `--test-region` + the bare
// heartbeat pipe.

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

// Protected regions, in screen coordinates (physical pixels). Read-only after
// startup: LL hook procs run on the installing thread's message loop (main
// thread), so no locking is required for the test-region case.
struct Region {
    LONG x, y, w, h;
};
static std::vector<Region> g_regions;

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
    for (const Region& r : g_regions) {
        if (px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h) {
            return true;
        }
    }
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
// Heartbeat pipe thread
// ---------------------------------------------------------------------------

static DWORD WINAPI HeartbeatThread(LPVOID /*unused*/) {
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

        char buf[64];
        for (;;) {
            DWORD n = 0;
            BOOL r = ReadFile(g_hPipe, buf, sizeof(buf), &n, nullptr);
            if (r && n > 0) {
                // ANY byte read == heartbeat. Content is irrelevant and never
                // logged or inspected.
                g_lastHeartbeat.store(GetTickCount64());
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

    g_hPipeThread = CreateThread(nullptr, 0, HeartbeatThread, nullptr, 0, nullptr);
    if (!g_hPipeThread) {
        std::fprintf(stderr, "CreateThread failed: %lu\n", GetLastError());
        Cleanup();
        return 1;
    }

    std::printf("[watchdog] elevated=yes hooks=keyboard+mouse pipe=%s regions=%zu\n",
                pipePath.c_str(), g_regions.size());
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
