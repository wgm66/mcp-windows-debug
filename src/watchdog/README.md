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

## IPC protocol (todo 7)

The same pipe carries a newline-delimited JSON protocol. Each frame is one JSON
object terminated by `\n`. The Node client is `WatchdogClient` in `src/ipc.ts`.

### Authentication

The watchdog reads the expected token from the `WATCHDOG_TOKEN` environment
variable (never argv — argv is readable by any same-user process). The first
frame a client sends after connecting MUST be:

```json
{"token":"<hex>"}
```

If it matches, the watchdog replies `{"ok":true,"op":"AUTH"}` and enables the
command frames below. A mismatch (or any other pre-auth frame) is answered with
`{"ok":false,"error":"unauthorized"}` and the connection is closed. If
`WATCHDOG_TOKEN` is unset/empty, authentication is disabled (any client may
connect — used by the bare-heartbeat scaffold).

### Commands (client -> watchdog)

| Frame | Effect | Reply |
|-------|--------|-------|
| `{"op":"REGISTER_REGION","x":..,"y":..,"w":..,"h":..,"id":".."}` | Append a protected region | `{"ok":true,"op":"REGISTER_REGION"}` or `{"ok":false,...,"error":"..."}` |
| `{"op":"HEARTBEAT"}` | Refresh the dead-man switch | none |
| `{"op":"STATUS"}` | Report state | `{"hooked":true/false,"regions":N}` |
| `{"op":"SHUTDOWN"}` | Unhook and exit cleanly | `{"ok":true,"op":"SHUTDOWN"}` then pipe close |

Regions are **append-only** for the session lifetime; there is deliberately no
`UNREGISTER_REGION` (the AI must not be able to remove its own constraints).

### Token generation (Node)

```ts
import { generateToken } from '../src/ipc';
const token = generateToken(); // crypto.randomBytes(32).toString('hex')
// spawn watchdog with env WATCHDOG_TOKEN = token
```

## Safety notes

- Keystroke/button content is **never** read or logged; only the injected flag
  and cursor destination are inspected. Non-injected events are discarded
  immediately.
- Hook-proc execution is kept well under 100 ms (`LowLevelHooksTimeout`); the
  max observed proc time is measured with `QueryPerformanceCounter` and printed
  on exit.
- Transport is named pipe only. No TCP.
- `WATCHDOG_TOKEN` is the only authentication channel; the token is passed via
  the process environment and presented as the first JSON frame after connect.

## Handoff to todo 8

Todo 8 spawns the watchdog (elevated) with `WATCHDOG_TOKEN` set, connects a
`WatchdogClient`, registers the session's protected regions, and runs a 1 s
heartbeat loop. The `--test-region` flag remains only as a manual smoke-test
aid; the Node MCP always registers regions over the pipe.
