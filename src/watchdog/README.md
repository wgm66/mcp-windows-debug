# McpWatchdog — native Windows safety process

A C++ Win32 console app that installs global low-level keyboard/mouse hooks to
block **machine-injected** input (`LLKHF_INJECTED` / `LLMHF_INJECTED`) aimed at
protected screen regions. **Human input always passes through.** It is the
native backing process behind the platform-neutral `SafetyProvider` interface
(`src/platform/safety.ts`).

## Build

Requires MSVC 14.29 (VS2019 Build Tools) and the Windows SDK — no CMake,
MSBuild, or MinGW. Toolchain paths are hard-coded in `build.bat`:

```bat
cd src\watchdog
build.bat
```

This runs `vcvars64.bat`, then `cl.exe /W4 /EHsc /O2 /MT watchdog.cpp`
linking `user32.lib kernel32.lib`, producing `watchdog.exe` in this directory.

## Run (as admin)

Global low-level hooks require elevation. From an **elevated** PowerShell:

```powershell
.\watchdog.exe --test-region 0,0,100,100
```

If run non-admin, it prints `ERROR_ACCESS_DENIED` and exits with code 1
(no silent no-op).

## CLI flags

| Flag | Meaning |
|------|---------|
| `--test-region x,y,w,h` | Pre-register a protected screen region (repeatable). Injected input inside it is blocked. Screen coordinates, physical pixels. |
| `--pipe-id <id>` | Named-pipe id (default `default`). Pipe path: `\\.\pipe\McpWatchdog-<id>`. |
| `--help` | Usage. |

## Heartbeat (dead-man switch)

The watchdog listens on `\\.\pipe\McpWatchdog-<id>`. **Any byte** written by the
client counts as a heartbeat. If no heartbeat arrives for **> 2 seconds**, the
watchdog calls `UnhookWindowsHookEx` on both hooks and exits cleanly — so a
crashed Node MCP can never leave input blocked. A background thread accepts the
connection and reads; a message-loop timer (200 ms) on the main thread checks
the elapsed time.

## Safety notes

- Keystroke/button content is **never** read or logged; only the injected flag
  and cursor destination are inspected. Non-injected events are discarded
  immediately.
- Hook-proc execution is kept well under 100 ms (`LowLevelHooksTimeout`); the
  max observed proc time is measured with `QueryPerformanceCounter` and printed
  on exit.
- Transport is named pipe only. No TCP.

## Handoff to todo 7

Todo 7 replaces the `--test-region` scaffold with the formal
`REGISTER_REGION`/`STATUS`/`SHUTDOWN` IPC protocol on the **same pipe**, plus a
random-token handshake so only the Node MCP can connect. The hook/region/
dead-man machinery in this file is designed to carry over unchanged; only the
pipe-thread read loop and region registration path will be extended.
