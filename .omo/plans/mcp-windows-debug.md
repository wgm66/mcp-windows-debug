# mcp-windows-debug - Work Plan

## TL;DR (For humans)

**What you'll get:** A TypeScript/Node.js MCP server that plugs into OpenCode via stdio, letting the AI see your Windows screen (screenshots), click and type on your behalf, read project files, and automatically debug a target application — all while an independent watchdog process guarantees a physical abort button always works and the AI can never reach it.

**Why this approach:** Two-process architecture (Node MCP + native C++ watchdog) ensures Node.js event-loop stalls cannot freeze your mouse/keyboard or silently remove the safety layer. The watchdog uses Windows low-level hooks to filter only machine-injected input away from protected regions, while a heartbeat dead-man switch auto-removes hooks if the MCP process dies. File access is either denylist-guarded or allowlist-strict, with an append-only audit log of every action.

**What it will NOT do:** No vision model or OCR inside the server (screenshots only, understanding stays in OpenCode). No file write/delete, no shell-exec tool. No network transport, no remote control, no multi-client access. No macro recording, no scripting language, no general RPA. No persistence across reboots — lives only while OpenCode session lives. v1 ships only the Windows backend, but every capability sits behind a cross-platform provider interface so macOS/Linux backends can be added later without re-architecting.

**Effort:** Large — 14 implementation todos across 7 waves, plus a native C++ watchdog process.
**Risk:** High — global input hooks, admin privilege, AV/EDR false-positive risk, and a fundamental safety guarantee that cannot be absolute (documented honestly with residual risk).

**Decisions to sanity-check:**
- Dual-process architecture (native watchdog + Node MCP) — safest structural choice, adds C++ build step
- Admin privilege required — enables reading any user file and running the watchdog's global hooks; does NOT grant UIPI bypass (injecting into elevated windows still needs matching integrity level, hence Must-NOT #56). Elevation path: the MCP server (running as non-elevated user) must spawn the watchdog via `ShellExecuteEx` with `runas` verb, or the user must pre-start the watchdog as admin before launching OpenCode. The plan documents both paths; the implementation must handle `ERROR_ELEVATION_REQUIRED` gracefully.
- Injected-input filtering (not total blocking) for abort protection — human can always click, but other processes could theoretically synthesize non-flagged input (residual risk documented)
- File access: user picks denylist-mode or allowlist-mode per session
- Cross-platform strategy: platform-neutral provider interfaces (`InputProvider`/`ScreenProvider`/`FileProvider`/`SafetyProvider`) with Windows as the v1-only backend; macOS/Linux plug in later behind the same interfaces

Your next move: approve this plan, or ask for adjustments. Full execution detail follows below.

---

> TL;DR (machine): Large effort, High risk — TypeScript/Node.js MCP server + C++ watchdog for Windows GUI automation (cross-platform provider interfaces, Windows backend in v1), file read, screenshot resources, auto-debug loop with governor; stdio transport for OpenCode; dual-process safety with injected-input filtering + heartbeat dead-man switch.

## Scope
### Must have
1. MCP server over stdio transport, compatible with OpenCode (`mcp` config key, `command` array, `environment` map)
2. Windows keyboard/mouse injection via `SendInput` only (koffi FFI); `keybd_event` and `mouse_event` are forbidden fallbacks (they lack `LLKHF_INJECTED` flagging and would bypass the injected-input filter)
3. Screenshot capture of full screen or specific windows via `node-screenshots` (Windows.Graphics.Capture API)
4. File system read tools with per-session mode selection: (a) wide read + sensitive-path denylist + audit, or (b) wide read + strict allowlist + audit
5. Append-only audit log: every file read, every injected action, every screenshot request, every intervention decision
6. Native watchdog process (C++ Win32) that installs `WH_KEYBOARD_LL` and `WH_MOUSE_LL` global hooks
7. Injected-input filtering: hook proc blocks `LLKHF_INJECTED` input destined for protected regions; non-injected (human) input always passes
8. Heartbeat dead-man switch: watchdog removes hooks automatically if MCP heartbeat stops for > defined threshold
9. Pre-session abort-button registration: user registers one or more protected regions (screen rectangles or window controls); session cannot start with zero registered regions
10. Auto-debug orchestration loop: continuous monitoring of target window/process, condition triggers, action sequences
11. Loop governor: max interventions/minute, hard session time cap, auto-pause after N consecutive failures, cooldown between actions
12. Freshness gate: every action preceded by re-capture + foreground-window check; aborts if state diverged
13. Window scoping: injected input restricted to target window(s) only; cannot click outside debug context. Enforcement: every `mouse_click`/`key_press`/`type_text` call must resolve the target window handle from the session state and verify the cursor/keyboard focus is inside that window before injection; if not, the action is rejected.
14. Secure-desktop handling: UAC/lock screen appearance causes immediate pause + notification to host; zero injection attempted
15. DPI-aware coordinate mapping: screenshot pixels ↔ physical mouse coordinates under per-monitor DPI scaling
16. Crash/disconnect fail-safe: all hooks removed, held keys released, half-typed commands cancelled within ≤3000 ms of process death (heartbeat 2s timeout + 1s removal grace). The ≤500 ms figure is aspirational only; the guaranteed contract is ≤3000 ms.
17. OpenCode configuration example and usage documentation
18. Platform abstraction layer: platform-neutral TypeScript interfaces (`InputProvider`, `ScreenProvider`, `FileProvider`, `SafetyProvider`) under `src/platform/`; each concrete layer implements its interface; Windows is the only backend shipped in v1, macOS/Linux backends plug in later behind the same interfaces (not implemented in v1).

### Must NOT have (guardrails, anti-slop, scope boundaries)
- NO vision model, OCR, or inference inside the server (screenshots out only)
- NO file write, edit, delete tools; NO shell-exec tool; read-only file surface
- NO network transport (HTTP, WebSocket, TCP remote); stdio/local only. Named pipe IPC (`\\.\pipe\`) is the only allowed IPC mechanism; TCP localhost is explicitly forbidden to eliminate remote-access surface.
- NO multi-client access, no remote control, no web UI for abort registration
- NO macro recording/replay, NO scripting DSL, NO general-purpose RPA
- NO OS-level persistence (no autostart, no service/daemon install, no survival across logout)
- NO macOS/Linux concrete backends in v1 (interfaces are cross-platform, Windows backend only); NO RDP/multi-session/Session-0 support
- NO browser DOM/extension integration, NO video streaming (still frames only), NO plugin system for third-party MCP tools. Playwright is NOT used anywhere in the implementation; integration tests use `child_process.spawn` + raw JSON-RPC over stdio only.
- NO tool to enumerate, move, resize, or unregister protected regions after session start. `UNREGISTER_REGION` is removed from the IPC protocol entirely.
- NO injection into shells/elevated windows outside the debug target (window scoping enforces this)
- NO keystroke content in audit logs or any persistent storage (data minimization)

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: **TDD** — RED → GREEN → SURFACE for every behavior change
- Framework: Jest (TypeScript) for Node.js layers; Catch2 or Google Test for C++ watchdog; integration tests via child_process.spawn + raw JSON-RPC over stdio only (Playwright is NOT used anywhere)
- Evidence path: `.omo/evidence/task-<N>-mcp-windows-debug.<ext>`
- Every todo carries: exhaustive References, agent-executable Acceptance criteria, happy + failure QA scenarios with exact tool + invocation, Commit line
- Security acceptance: automated tests for hook removal on kill, injected-input blocking, physical-abort latency, coordinate tolerance, secure-desktop pause, audit-log absence of keystrokes

## Execution strategy
### Parallel execution waves
> Target 5-8 todos per wave. Fewer than 3 (except the final) means you under-split.

**Wave 1 — Foundation**: Project scaffold, build pipeline, audit log infra (no dependencies)
**Wave 2 — Core Layers (parallel)**: Platform provider interfaces (`src/platform/`) + File access, screen capture, key/mouse injection as their Windows backends (each independent; depend only on Wave 1)
**Wave 3 — Safety Watchdog (parallel with Wave 2)**: Native C++ watchdog scaffold, hook proc, heartbeat, IPC (no dependencies)
**Wave 4 — Integration**: Safety abort layer + MCP server core (depends on Waves 2+3)
**Wave 5 — Debug Orchestration**: Auto-debug loop + governor + freshness gate (depends on Wave 4)
**Wave 6 — Verification**: Integration tests + security acceptance tests (depends on Wave 5)
**Wave 7 — Finalization**: Documentation, config examples, final verification wave (depends on Wave 6)

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 | — | 2,3,4,5,6,7 | — |
| 2 | 1 | 3,4,5,8 | 3,4,5,6,7 |
| 3 | 1,2 | 8 | 4,5,6,7 |
| 4 | 1,2 | 8 | 3,5,6,7 |
| 5 | 1,2 | 8 | 3,4,6,7 |
| 6 | 1 | 7,8 | 2,3,4,5 |
| 7 | 1,6 | 8 | 2,3,4,5 |
| 8 | 2,3,4,5,6,7 | 9 | — |
| 9 | 3,4,5,8 | 10 | — |
| 10 | 9 | 11 | — |
| 11 | 10 | 12 | — |
| 12 | 11 | 13 | — |
| 13 | 12 | 14 | — |
| 14 | 13 | — | — |

## Todos
> Implementation + Test = ONE todo. Never separate.

- [x] 1. Project scaffold and build pipeline
  What to do / Must NOT do: Create the repository structure with `package.json` (dependencies: `@modelcontextprotocol/sdk@^1.30.0`, `koffi@3.1.4`, `node-screenshots`, `zod`, `typescript`, `jest`, `@types/node`), `tsconfig.json` (strict, CommonJS to align with MCP SDK and koffi/node-screenshots native modules), `.gitignore`, build scripts (`build`, `test`, `dev`), and directory layout (`src/`, `src/platform/` (provider interfaces), `src/watchdog/`, `tests/`, `.omo/evidence/`). Must NOT commit `node_modules` or compiled artifacts. Also create `src/platform/input.ts`, `screen.ts`, `file.ts`, `safety.ts` defining the four provider interfaces (method signatures only, no platform code; `SafetyProvider`: `registerRegions`/`heartbeat`/`shutdown`/`status` per todo 6).
  Parallelization: Wave 1 | Blocked by: — | Blocks: 2,3,4,5,6,7
  References (executor has NO interview context - be exhaustive):
    - MCP SDK pattern: `@modelcontextprotocol/sdk` v1.x with `McpServer` class from `@modelcontextprotocol/sdk/server/mcp.js` and `StdioServerTransport` from `@modelcontextprotocol/sdk/server/stdio.js`; tool registration via `server.registerTool(name, {description, inputSchema}, handler)`; schema uses `zod` v3 (zod v4/Standard Schema is v2-SDK-only, out of scope)
    - OpenCode config key: `mcp` (NOT `mcpServers`); format: `{ "mcp": { "my-server": { "type": "local", "command": ["node", "./dist/index.js"], "environment": { "KEY": "value" } } } }`
    - koffi FFI pattern: `const koffi = require('koffi'); const user32 = koffi.load('user32.dll'); const SendInput = user32.func('UINT SendInput(UINT cInputs, INPUT *pInputs, int cbSize)');`
    - node-screenshots API: `const { Monitor } = require('node-screenshots'); const monitor = Monitor.fromPoint(x, y); const image = monitor.captureImageSync();`
    - Project root: `G:\工程开发\AI全场景图形化调试` (Windows path)
  Acceptance criteria (agent-executable):
    - `npm install` exits 0
    - `npm run build` exits 0 and produces `dist/index.js`
    - `npm test` runs Jest and exits 0 (even if only a placeholder test)
    - `package.json` contains all listed dependencies with semver ranges
    - `src/platform/{input,screen,file,safety}.ts` each export their provider interface; `tsc --noEmit` compiles clean, and Todos 3–6's Windows backends each `implements` its interface (type-checked)
  QA scenarios (name the exact tool + invocation):
    - Happy: `npm run build` → `test -f dist/index.js` (or Windows equivalent `if exist dist\index.js`)
    - Failure: Delete `package.json` and run `npm run build` → expect exit != 0 with clear error
    - Evidence: `.omo/evidence/task-1-mcp-windows-debug.log`
  Commit: Y | chore(repo): scaffold project with MCP SDK, koffi, node-screenshots, jest

- [x] 2. Audit log infrastructure
  What to do / Must NOT do: Implement an append-only audit log module (`src/audit.ts`) that writes timestamped JSON lines to a rotating log file. Every entry must contain: `timestamp` (ISO 8601), `sessionId`, `toolName`, `action`, `details` (object, no sensitive content), `success` (boolean). Must NOT log keystroke content, file content, or screenshot binary data. Must NOT allow log truncation or deletion via any tool.
  Parallelization: Wave 1 | Blocked by: 1 | Blocks: 3,4,5,8
  References:
    - Log file path: `<project-root>/.omo/logs/audit-<sessionId>-<date>.ndjson`
    - Rotation: max 10 MB per file, max 7 days retention
    - fs.appendFileSync or fs.promises.appendFile for atomicity
  Acceptance criteria (agent-executable):
    - `src/audit.ts` exports `logEntry(sessionId, toolName, action, details, success)` that appends a valid JSON line
    - Log file is created on first entry and grows monotonically (no truncation)
    - `grep` for a canary string in log after 3 entries → finds exactly 3 occurrences
    - Attempt to call internal delete/truncate API → throws or is undefined
  QA scenarios:
    - Happy: Call `logEntry` 100 times → log file has 100 lines, each valid JSON
    - Failure: Set log file read-only → next `logEntry` throws with clear error, does not crash process
    - Evidence: `.omo/evidence/task-2-mcp-windows-debug.ndjson`
  Commit: Y | feat(audit): append-only audit log with rotation and data minimization

- [x] 3. File system access layer (dual mode)
  What to do / Must NOT do: Implement `src/filesystem.ts` — the Windows backend of the `FileProvider` interface (`src/platform/file.ts`). Expose two MCP tools: `read_file` and `list_directory`. Support dual mode per session: (a) DENYLIST mode — read any path except sensitive-path denylist (`.ssh/`, browser credential stores, token caches, Windows vault paths); (b) ALLOWLIST mode — read only paths under user-configured allowlist roots. Both modes log every read to audit (todo 2). Must NOT implement write/delete/move. Must NOT follow symlinks outside scope. Must reject paths > 10 MB without reading.
  Parallelization: Wave 2 | Blocked by: 1,2 | Blocks: 8
  References:
    - Denylist paths: `%USERPROFILE%\.ssh\*`, `%APPDATA%\*\*\*Credentials*`, `%LOCALAPPDATA%\*\*\*Token*`, Windows Credential Manager paths
    - fs.readFile with encoding detection (utf8 vs binary); for binary, return base64 with metadata
    - Path traversal guard: resolve absolute path, check against scope (denylist or allowlist)
  Acceptance criteria (agent-executable):
    - DENYLIST mode: `read_file('C:\Users\<user>\Documents\test.txt')` succeeds for non-denied path
    - DENYLIST mode: `read_file('C:\Users\<user>\.ssh\id_rsa')` throws `AccessDeniedError`
    - ALLOWLIST mode: `read_file('C:\allowed\test.txt')` succeeds; `read_file('C:\outside\test.txt')` throws
    - File > 10 MB → throws `FileTooLargeError` without reading full content into memory
    - `list_directory('<valid dir>')` returns a non-empty entry list; `list_directory('<nonexistent>')` throws `DirectoryNotFoundError`
    - Every call creates exactly one audit log entry
  QA scenarios:
    - Happy: Read a 1 KB text file → returns correct content + audit entry
    - Edge: Read a 0-byte file → returns empty string + audit entry
    - Edge: Symlink pointing outside scope → rejected before following
    - Failure: Attempt to read denied path → structured error, no content returned, audit entry recorded
    - Evidence: `.omo/evidence/task-3-mcp-windows-debug.log`
  Commit: Y | feat(filesystem): read_file + list_directory with denylist/allowlist dual mode

- [x] 4. Screen capture layer
  What to do / Must NOT do: Implement `src/screenshot.ts` — the Windows backend of the `ScreenProvider` interface (`src/platform/screen.ts`). Expose two capabilities: (a) MCP resource `screenshot://full` returning PNG of full primary monitor; (b) MCP tool `capture_window` taking window title/hex handle, returning PNG of that window. Use `node-screenshots` (Windows.Graphics.Capture API). Must log every capture to audit. Must NOT perform OCR or inference. Must handle multi-monitor by allowing monitor index selection. Must mask nothing (full screenshot as requested by user design decision).
  Parallelization: Wave 2 | Blocked by: 1,2 | Blocks: 8
  References:
    - node-screenshots API: `Monitor.all()` returns monitors; `monitor.captureImageSync()` returns buffer; `.toPngSync()` for PNG
    - Window capture: `Window.all()` or `Window.findByTitle()` then `window.captureImageSync()`
    - MCP resource pattern: register with `server.resource()` (v1 SDK) or return via tool
  Acceptance criteria (agent-executable):
    - `captureImageSync()` produces a valid PNG buffer (> 1 KB, < 50 MB for 1080p)
    - `capture_window` with valid window title returns PNG of that window
    - `capture_window` with non-existent window returns structured error
    - Every capture creates exactly one audit log entry
  QA scenarios:
    - Happy: Capture full screen → valid PNG, opens in image viewer
    - Happy: Capture specific window → PNG shows only that window content
    - Edge: Multi-monitor system, capture monitor index 1 vs 0 → different images
    - Failure: Capture non-existent window → `WindowNotFoundError`
    - Evidence: `.omo/evidence/task-4-mcp-windows-debug.png` + `.log`
  Commit: Y | feat(screenshot): full-screen and window capture via node-screenshots

- [x] 5. Key/mouse injection layer
  What to do / Must NOT do: Implement `src/input.ts` — the Windows backend of the `InputProvider` interface (`src/platform/input.ts`). MCP tools: `mouse_click(x, y, button)`, `mouse_move(x, y)`, `key_press(key, modifiers)`, `type_text(text)`. Use `koffi` to call `SendInput` via `user32.dll`. Must validate coordinates are within target window bounds (window scoping enforced at call site, not here). Must log every injection to audit. Must NOT inject into secure desktop (UAC/lock screen — checked at orchestration layer). Must handle DPI scaling by converting logical to physical coordinates via `GetDpiForMonitor`.
  Parallelization: Wave 2 | Blocked by: 1,2 | Blocks: 8
  References:
    - koffi SendInput signature: `UINT SendInput(UINT cInputs, LPINPUT pInputs, int cbSize)`
    - INPUT struct: `type=INPUT_MOUSE(0)` or `INPUT_KEYBOARD(1)`; dwFlags for MOUSEEVENTF_ABSOLUTE, etc.
    - keybd_event is explicitly forbidden as a fallback — it lacks `LLKHF_INJECTED` flagging and would bypass the watchdog's injected-input filter. Only `SendInput` is allowed.
    - DPI awareness: `SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)` at process start
    - Coordinate conversion: logical → physical using monitor DPI
  Acceptance criteria (agent-executable):
    - `mouse_click(100, 100, 'left')` moves cursor to (100,100) and clicks; cursor position verifiable via `GetCursorPos`
    - `type_text('Hello')` produces 'Hello' in a focused Notepad window
    - `key_press('F5', [])` sends F5 key
    - Every injection creates exactly one audit log entry
  QA scenarios:
    - Happy: Focus Notepad, `type_text('test')` → Notepad contains 'test'
    - Happy: `mouse_click` on known screen coordinate → cursor moves there, click registered by test harness
    - Edge: Unicode text (`'你好'`) → correct CJK characters typed
    - Failure: Invalid key name → throws `InvalidKeyError`
    - Evidence: `.omo/evidence/task-5-mcp-windows-debug.log` (with screen recording if possible)
  Commit: Y | feat(input): mouse and keyboard injection via koffi/SendInput

- [x] 6. Native watchdog process scaffold (C++)
  What to do / Must NOT do: Create `src/watchdog/` directory with a C++ Win32 console application — the Windows backing process behind the `SafetyProvider` interface (`src/platform/safety.ts`, platform-neutral: `registerRegions`/`heartbeat`/`shutdown`/`status`). The Node-side safety client (todo 8) implements `SafetyProvider` by IPC to this process. macOS/Linux would implement `SafetyProvider` with different mechanisms (e.g. CGEventTap) behind the same interface. Implement: (a) `SetWindowsHookEx(WH_KEYBOARD_LL, ...)` and `SetWindowsHookEx(WH_MOUSE_LL, ...)`; (b) hook proc that checks `LLKHF_INJECTED` flag — if set AND destination within protected region, return non-zero (block); otherwise pass through; (c) heartbeat listener on a named pipe only (TCP is forbidden) — if no heartbeat for > 2 seconds, call `UnhookWindowsHookEx` and exit cleanly. Must NOT log keystroke content. Must discard all non-relevant events immediately. Must run as admin (documented requirement). Must handle `LowLevelHooksTimeout` by keeping hook proc execution < 100 ms.
  Parallelization: Wave 3 | Blocked by: 1 | Blocks: 7,8
  References:
    - SetWindowsHookEx: https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowshookexa
    - LLKHF_INJECTED flag: https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-kbdllhookstruct
    - LowLevelHooksTimeout registry: `HKCU\Control Panel\Desktop\LowLevelHooksTimeout` (default 300 ms, Windows may detach slow hooks)
    - Named pipe: `CreateNamedPipe` + `ConnectNamedPipe` + async read loop
    - Hook proc contract: must reside in a DLL for global hooks? NO — for LL hooks (WH_KEYBOARD_LL / WH_MOUSE_LL), the hook proc can be in the same EXE process
  Acceptance criteria (agent-executable):
    - Watchdog EXE compiles with `cl.exe` or MinGW or CMake (provide build script)
    - Running watchdog as admin installs both hooks successfully (verifiable via Process Hacker or API)
    - Stopping heartbeat → watchdog exits within 3 seconds and hooks are removed
    - Hook proc execution time < 100 ms (measured via QueryPerformanceCounter)
  QA scenarios:
    - Happy: Run watchdog with admin → both hooks installed, heartbeat acknowledged
    - Happy: Send injected input to protected region → blocked (verifiable by checking no click/key reaches target)
    - Happy: Send human input to protected region → passes through normally
    - Failure: Run without admin → `ERROR_ACCESS_DENIED`, graceful exit with clear message
    - Evidence: `.omo/evidence/task-6-mcp-windows-debug.log`
  Commit: Y | feat(watchdog): native C++ watchdog with LL hooks and heartbeat dead-man switch

- [x] 7. Watchdog-MCP IPC protocol
  What to do / Must NOT do: Define and implement the binary/text protocol between Node MCP process and C++ watchdog. Messages: `REGISTER_REGION(x, y, w, h, id)`, `HEARTBEAT`, `STATUS`, `SHUTDOWN`. Must NOT include `UNREGISTER_REGION` — regions are immutable for the session lifetime to prevent the AI from removing its own constraints. Transport: named pipe (`\\.\pipe\McpWatchdog-<sessionId>`) only. TCP localhost is forbidden to eliminate remote-access surface. Must handle reconnect. Must NOT allow MCP to enumerate or modify protected regions via any other channel. Must authenticate pipe client (e.g., random token exchanged at startup) to prevent other processes from connecting.
  Parallelization: Wave 3 | Blocked by: 1,6 | Blocks: 8
  References:
    - Node.js net.createServer / net.connect for named pipes on Windows; koffi for `CreateNamedPipe`/`ConnectNamedPipe`/`ReadFile`/`WriteFile` via `kernel32.dll` on the C++ side
    - Named pipe path format: `\\.\pipe\<name>`
    - Protocol framing: length-prefixed JSON messages or simple newline-delimited JSON
    - Authentication: session start generates random 32-byte token; watchdog only accepts commands carrying this token. Exchange channel: pass the token via environment variable or as the first pipe message AFTER connect (never via argv/command line, which any same-user process can read).
  Acceptance criteria (agent-executable):
    - Node can connect to watchdog pipe and send `REGISTER_REGION`
    - Watchdog acknowledges with `OK` or `ERROR` response
    - Missing heartbeat for 2 seconds → watchdog auto-shutdown
    - Invalid token → connection rejected immediately
  QA scenarios:
    - Happy: Full REGISTER_REGION → HEARTBEAT → STATUS → SHUTDOWN cycle
    - Edge: Node process crashes mid-session → watchdog detects missing heartbeat, removes hooks, exits within 3s
    - Failure: Connect with wrong token → connection refused, no commands accepted
    - Evidence: `.omo/evidence/task-7-mcp-windows-debug.log`
  Commit: Y | feat(ipc): watchdog-MCP named pipe protocol with token authentication

- [x] 8. Safety abort layer integration
  What to do / Must NOT do: Integrate watchdog (todo 6+7) with MCP server. Implement `start_debug_session(regions[])` tool that: (a) validates ≥1 region provided, (b) spawns watchdog process with session token, (c) sends `REGISTER_REGION` for each, (d) starts heartbeat loop (every 1s), (e) returns session handle. Implement `end_debug_session(handle)` that sends `SHUTDOWN`, kills watchdog if no response in 1s, and cleans up. Must enforce: screenshots are never blocked (user decision); input injection to protected regions is blocked by the watchdog; file tools (`read_file`/`list_directory`) are unrelated to screen regions and governed solely by the file-access policy (todo 3). Must implement the window-scoping gate (Must-have #13): a single `inject_guarded(action)` entry point that every injection tool must route through — it resolves the target window handle from session state, calls `GetForegroundWindow`/`GetCursorPos` to verify the cursor and keyboard focus are inside that target window, and rejects the action with `WindowScopeViolationError` otherwise. Must ensure hooks are removed even if Node crashes. If the watchdog exits for any reason (heartbeat miss, AV kill, crash), the session transitions STOPPING→IDLE and all input tools are refused until a new `start_debug_session`.
  Parallelization: Wave 4 | Blocked by: 2,3,4,5,6,7 | Blocks: 9
  References:
    - Spawn elevated watchdog: `ShellExecuteEx` with `runas` verb via koffi (child_process.spawn CANNOT elevate); handle `ERROR_ELEVATION_REQUIRED` and `ERROR_CANCELLED` (user declined UAC) gracefully; fallback: user pre-starts watchdog as admin, MCP connects to the existing named pipe. Automated tests run the whole harness via this pre-started-admin fallback so zero UAC prompts occur during test execution
    - Session state machine: IDLE → STARTING → ACTIVE → STOPPING → IDLE
    - Protected regions: overlapping regions are permitted (both simply block); no overlap rejection
  Acceptance criteria (agent-executable):
    - `start_debug_session` with 1 region → watchdog spawned, hooks active, heartbeat flowing
    - `start_debug_session` with 0 regions → throws `AbortButtonsRequiredError`
    - `end_debug_session` → watchdog exits, hooks removed within 1s
    - Node process killed (simulated via `taskkill`) → watchdog auto-exits within 3s, hooks removed
    - Held-key release: inject `key_down(CTRL)`, kill Node → watchdog releases CTRL (verify `GetAsyncKeyState(VK_CONTROL)` not pressed) and no half-typed text persists
    - Watchdog exits unexpectedly mid-session → session transitions STOPPING→IDLE, all input tools refuse until new `start_debug_session`
  QA scenarios:
    - Happy: Start session with 2 regions → both registered, injection to regions blocked
    - Edge: Start session, move protected window → region still valid (screen rectangle, not window-relative; documented limitation)
    - Failure: Start session without admin → `ElevationRequiredError`
    - Security: `taskkill /F` on Node → watchdog exits, input restored
    - Evidence: `.omo/evidence/task-8-mcp-windows-debug.log`
  Commit: Y | feat(safety): debug session lifecycle with watchdog integration

- [x] 9. MCP server core (stdio transport, tool registration)
  What to do / Must NOT do: Implement `src/server.ts` using `@modelcontextprotocol/sdk` (`McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`, `StdioServerTransport` from `@modelcontextprotocol/sdk/server/stdio.js`, connected via `await server.connect(transport)`). Register all tools: `read_file`, `list_directory`, `capture_window`, `mouse_click`, `mouse_move`, `key_press`, `type_text`, `start_debug_session`, `end_debug_session`, `execute_action` (client calls this with the model's decision; see todo 10). Register resources: `screenshot://full`, `screenshot://monitor/{index}`, `debug://context` (client polls this for the auto-debug loop). Implement capability declaration. Must validate all inputs with Zod schemas. Must return structured errors (not raw exceptions). Must handle stdio transport lifecycle (open, close, error). Must NOT use sampling or any server-initiated model calls; the auto-debug loop (todo 10) relies on client polling for model decisions. All four injection tools (`mouse_click`, `mouse_move`, `key_press`, `type_text`) must route through `inject_guarded` (todo 8); calls with no ACTIVE session are rejected with `NoActiveSessionError`. `inject_guarded` is platform-neutral policy (scoping, freshness, session check) that consumes the active `InputProvider` and session window handle — it must NOT call Win32 directly.
  Parallelization: Wave 4 | Blocked by: 3,4,5,8 | Blocks: 10
  References:
    - MCP SDK server pattern: `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'; import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';`
    - Tool schema: `z.object({ path: z.string(), mode: z.enum(['denylist', 'allowlist']) })`
    - Error format: `{ content: [{ type: 'text', text: 'Error: ...' }], isError: true }`
  Acceptance criteria (agent-executable):
    - Server starts (via `await server.connect(new StdioServerTransport())`) and accepts JSON-RPC messages over stdin
    - `tools/list` request returns all registered tools with schemas
    - `resources/list` returns screenshot resources
    - Invalid input (e.g., `mouse_click('abc', 'def')`) → Zod validation error, not crash
  QA scenarios:
    - Happy: Send valid `read_file` JSON-RPC → correct response
    - Happy: Send `tools/list` → all 10 tools present with correct schemas
    - Failure: Send malformed JSON → structured error, server continues running
    - Failure: Send unknown tool name → `ToolNotFoundError`
    - Evidence: `.omo/evidence/task-9-mcp-windows-debug.log`
  Commit: Y | feat(server): MCP stdio server with full tool/resource registry

- [x] 10. Auto-debug orchestration loop
  What to do / Must NOT do: Implement `src/orchestrator.ts` that runs a continuous monitoring loop while a debug session is active. Responsibilities: (a) poll target window state (title, rect, foreground status) every N ms; (b) on trigger condition (e.g., window title change, pixel diff threshold, process event), capture fresh screenshot, build context, and expose it via a new MCP resource `debug://context`; (c) the client (OpenCode) polls `debug://context` and calls `execute_action(action, params)` tool with the model's decision; (d) orchestrator validates freshness (re-capture + check foreground window), executes via input layer if valid; (e) enforce governor: max 6 interventions/minute, 30-min session cap, auto-pause after 3 consecutive failures, 5s cooldown between actions. Must NOT decide actions itself — always delegates to model via MCP tool results. Must pause on secure desktop detection. Must NOT use sampling or any server-initiated model calls; all model interaction is client-initiated via `execute_action`.
  Parallelization: Wave 5 | Blocked by: 9 | Blocks: 11
  References:
    - Window monitoring: `GetWindowRect`, `GetForegroundWindow`, `IsWindowVisible`
    - Pixel diff: compare consecutive screenshots with simple hash or perceptual diff
    - Governor state machine: IDLE → MONITORING → TRIGGERED → ACTING → COOLDOWN → MONITORING
    - Secure desktop detection: call `OpenInputDesktop` and compare against the session's input desktop; if different (UAC/lock screen), pause. Do NOT rely on `GetForegroundWindow` alone.
  Acceptance criteria (agent-executable):
    - Orchestrator starts when `start_debug_session` is called
    - Trigger condition fires within 5 seconds of target window change
    - Governor enforces 5s cooldown: two actions within 5s → second rejected
    - After 3 consecutive failures → auto-pause, notification sent to host
    - Freshness gate (Must-have #12): re-capture shows foreground window diverged from session target → `execute_action` rejected with `StaleStateError`
    - Session auto-ends after 30 minutes
  QA scenarios:
    - Happy: Target window title changes → orchestrator detects, captures, exposes `debug://context`; client polls and calls `execute_action`; orchestrator validates freshness and executes
    - Happy: Governor allows action, then blocks next action for 5s cooldown
    - Edge: Secure desktop (simulated by a test thread switching to a different input desktop, NOT by locking the workstation which would block the harness) → orchestrator pauses within 2s, no injection attempted
    - Failure: 3 consecutive invalid actions → auto-pause, host notified
    - Evidence: `.omo/evidence/task-10-mcp-windows-debug.log`
  Commit: Y | feat(orchestrator): auto-debug loop with governor and freshness gate

- [x] 11. Integration tests
  What to do / Must NOT do: Write `tests/integration.test.ts` covering: (a) full MCP stdio lifecycle (spawn server, send JSON-RPC, verify responses); (b) file read in both denylist and allowlist modes; (c) screenshot capture and resource access; (d) input injection round-trip (focus Notepad, type text, verify content); (e) debug session lifecycle (start, register regions, inject to protected region is blocked, end, cleanup). Use `child_process.spawn` for server, `fs` for verification. Must NOT require manual GUI interaction for automated tests (use programmatic window focus where possible).
  Parallelization: Wave 6 | Blocked by: 10 | Blocks: 12
  References:
    - Integration test pattern: spawn server process, write JSON-RPC to stdin, read JSON-RPC from stdout
    - Test harness runs elevated with the watchdog pre-started as admin (todo 8 fallback); zero UAC prompts during automated runs
    - Window focus for tests: `SetForegroundWindow` via koffi, or use a test-only hidden window
    - Cleanup: `afterEach` kills server process, verifies watchdog not running
  Acceptance criteria (agent-executable):
    - `npm test` runs integration tests and all pass
    - Each test scenario has RED→GREEN evidence captured
    - Test suite runs in < 60 seconds
  QA scenarios:
    - Happy: Full end-to-end flow → all assertions pass
    - Failure: Server crashes during test → test fails with clear error, cleanup runs
    - Evidence: `.omo/evidence/task-11-mcp-windows-debug.log`
  Commit: Y | test(integration): end-to-end MCP stdio, file, screenshot, input, session lifecycle

- [x] 12. Security acceptance tests
  What to do / Must NOT do: Write `tests/security.test.ts` with automated security scenarios: (a) `taskkill /F` on Node process → hooks removed within 3000ms (measure via polling hook presence); (b) injected click to protected region → 100% blocked across 100 attempts; (c) physical (human-simulated) click to protected region → 100% passes; (d) audit log contains zero keystroke content (type canary string in other app, grep logs for absence); (e) coordinate tolerance test: injected click lands within ±2px of target on mixed-DPI multi-monitor; (f) secure desktop detection: lock screen triggers pause within 2s. These tests may require elevated privileges and GUI state; mark with `describe.skip` if environment lacks them, but document how to run manually.
  Parallelization: Wave 6 | Blocked by: 11 | Blocks: 13
  References:
    - Hook presence check: `GetWindowsHookEx` not directly queryable; use indirect method (inject event, verify blocked)
    - Process kill: `taskkill /F /PID <pid>` or `process.kill(pid, 'SIGKILL')`
    - Coordinate tolerance: compare expected vs actual cursor position via `GetCursorPos`
    - These tests require elevation; run the whole suite elevated with watchdog pre-started as admin (no UAC prompt mid-test)
  Acceptance criteria (agent-executable):
    - Each security test has clear PASS/FAIL observable
    - Tests that require admin/GUI are marked and documented
    - RED→GREEN evidence captured for each implemented test
  QA scenarios:
    - Happy: Injected click to protected region → blocked 100/100
    - Happy: Process kill → hooks removed, input restored
    - Edge: Multi-monitor mixed DPI → coordinate tolerance ±2px
    - Evidence: `.omo/evidence/task-12-mcp-windows-debug.log`
  Commit: Y | test(security): hook removal, input blocking, audit privacy, coordinate precision, secure desktop

- [x] 13. Documentation and OpenCode configuration
  What to do / Must NOT do: Write `README.md` with: (a) installation instructions (Node.js + admin requirement + build watchdog); (b) OpenCode configuration example (`~/.config/opencode/opencode.json` with `mcp` key); (c) usage guide (registering abort buttons, starting a session, interpreting results); (d) security model explanation (residual risks, what the tool CAN and CANNOT guarantee); (e) troubleshooting (AV false positives, hook timeouts, DPI issues). Must NOT claim absolute physical blocking. Must honestly document residual risks.
  Parallelization: Wave 7 | Blocked by: 12 | Blocks: 14
  References:
    - OpenCode config format: `{ "mcp": { "windows-debug": { "type": "local", "command": ["node", "./dist/index.js"], "environment": {} } } }`
    - Admin requirement: document UAC elevation for watchdog
    - AV interaction: suggest exclusion or code signing path
  Acceptance criteria (agent-executable):
    - README contains all 5 sections above
    - Config example is copy-paste ready for OpenCode
    - Security section explicitly states residual risks (injected-input filtering limitations, bypass by other processes)
  QA scenarios:
    - Happy: Follow README install steps → server runs
    - Evidence: `.omo/evidence/task-13-mcp-windows-debug.md` (README itself)
  Commit: Y | docs(readme): installation, config, usage, security model, troubleshooting

- [x] 14. Final verification wave
  What to do / Must NOT do: Run the complete verification suite in parallel: F1 plan compliance audit (every todo implemented per spec), F2 code quality review (LSP diagnostics clean, no any types, 80%+ test coverage), F3 scripted integration QA (spawn the server + a scripted JSON-RPC client that drives a real debug session against a test app; the full transcript is the evidence), F4 scope fidelity (verify no Must NOT have items crept in). Surface results, fix issues, re-verify until all APPROVE. Wait for user's explicit okay before declaring complete.
  Parallelization: Wave 7 | Blocked by: 13 | Blocks: —
  References:
    - F1: checklist against this plan's Must have / Must NOT have
    - F2: `npx tsc --noEmit`, jest --coverage, lsp_diagnostics on all changed files
    - F3: scripted end-to-end JSON-RPC transcript of a real debug session (no manual observation; the transcript IS the evidence)
    - F4: grep for forbidden patterns (write_file, shell_exec, http_server, etc.)
  Acceptance criteria (agent-executable):
    - F1: All Must have items checked, no Must NOT have violations
    - F2: `tsc --noEmit` exit 0, test coverage ≥ 80%, zero lint errors
    - F3: transcript artifact with at least 3 real debug scenarios captured (scripted, not manual)
    - F4: Grep for forbidden patterns returns zero matches
  QA scenarios:
    - Happy: All 4 verifications pass → plan complete
    - Failure: Any verification fails → fix and re-run until pass
    - Evidence: `.omo/evidence/task-14-mcp-windows-debug.log`
  Commit: N | —

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [x] F1. Plan compliance audit
- [x] F2. Code quality review
- [x] F3. Scripted integration QA
- [x] F4. Scope fidelity

## Commit strategy
- **Wave 1-2 (Foundation + Core)**: Each todo = one commit with conventional commit prefix (`chore`, `feat`, `test`)
- **Wave 3 (Watchdog)**: C++ code commits separately with `feat(watchdog)` prefix
- **Wave 4-5 (Integration + Orchestration)**: Feature commits with `feat(safety)`, `feat(server)`, `feat(orchestrator)`
- **Wave 6 (Tests)**: `test(integration)` and `test(security)` commits
- **Wave 7 (Docs + Final)**: `docs(readme)` commit; final verification wave results appended to plan file
- **No squash merges**: Keep granular history for audit trail alignment
- **Each commit must reference the todo number** in body: `Refs: todo-3`

## Success criteria
1. **Functional**: All Must have items implemented and verified by agent-executable tests
2. **Security**: All Metis-identified gaps addressed (dual-process, injected-input filtering, heartbeat dead-man switch, audit log, window scoping, governor, freshness gate, secure-desktop handling, coordinate correctness, crash fail-safe)
3. **Safety honesty**: Documentation explicitly states residual risks; does NOT claim absolute physical blocking
4. **Integration**: OpenCode can discover, connect, and use all tools via stdio with zero manual per-call configuration
5. **Quality**: TypeScript compiles clean, test coverage ≥ 80%, LSP diagnostics clean on all files, zero lint errors
6. **Scope discipline**: Zero Must NOT have items present; no scope creep verified by F4
7. **Auditability**: Every file read, injected action, screenshot request, and intervention decision is logged to append-only audit log
8. **Fail-safe**: Process death (normal or `taskkill /F`) results in hook removal and input restoration within ≤3000 ms (heartbeat 2s timeout + 1s removal grace; the ≤500 ms figure is aspirational only, NOT the contract)
