# sandbox-isolation - Work Plan

## TL;DR (For humans)

**What you'll get:** A refactor of the MCP server's input/screenshot/safety layers so automated keyboard/mouse injection runs inside an isolated private Win32 Desktop (via `CreateDesktop` + `SetThreadDesktop`), using `PostMessage`/`SendMessage` instead of `SendInput`. The user's real mouse, keyboard, and desktop are 100% untouched. A `LocalRdpSession` provider interface is reserved for a future Pro-edition full-isolation path.

**Why this approach:** The current `SendInput`-based injection enters the system input stream, moving the user's real cursor and keyboard focus — disrupting their other work. `PostMessage`/`SendMessage` delivers input directly to a target window's message queue without touching the system input stream. Combined with a private Win32 Desktop (LL hooks are desktop-scoped per Microsoft docs), the user's `Default` desktop is completely isolated.

**What it will NOT do:** No RDP session implementation in v1 (interface reserved, throws `NotImplementedError`). No Hyper-V/Windows Sandbox (machine is Win10 1803, Sandbox needs 1903+). No removal of the existing `SendInput` path (kept as a fallback provider behind the interface). No change to the watchdog's dead-man switch (still useful for session lifecycle, though LL-hook filtering becomes secondary).

**Effort:** Large — 10 implementation todos across 4 waves.
**Risk:** High — PostMessage semantics differ from SendInput; safety-gate redesign for sandbox mode; threading-model change (worker_threads).

**Decisions to sanity-check:**
- `CreateDesktop` + `PostMessage` as v1 sandbox (any Windows edition, no VM/RDP)
- `LocalRdpSession` interface reserved but NOT implemented (future Pro-edition path)
- Both modes user-selectable per session via `start_debug_session({ sandbox: 'desktop' | 'rdp' })`

Your next move: approve this plan, or ask for adjustments. Full execution detail follows below.

---

> TL;DR (machine): Large effort, High risk — refactor input/screenshot/safety to private-desktop + PostMessage isolation; sandbox-aware safety gate + probe; worker_threads for SetThreadDesktop; reserve LocalRdpSession interface; 10 todos across 4 waves.

## Scope
### Must have
1. `SandboxProvider` interface under `src/platform/sandbox.ts` — `createSandbox(config): Promise<SandboxHandle>`, `SandboxHandle` exposes `desktop` name, `targetHwnd`, and `dispose()`
2. `WindowsDesktopSandbox` (v1 backend): `CreateDesktopW` + `SetThreadDesktop` + spawn target process with `STARTUPINFO.lpDesktop` via koffi
3. `PostMessageInputProvider` (new `InputProvider` backend): `mouseClick`/`mouseMove`/`keyPress`/`typeText` via `PostMessageW`/`SendMessageW` to the target window's message queue (NOT `SendInput`)
4. `BitBltScreenProvider` (new `ScreenProvider` backend): capture windows on the private desktop via `PrintWindow`/`BitBlt` (NOT `node-screenshots` which captures the input desktop)
5. `start_debug_session` accepts `sandbox: 'desktop' | 'rdp'` parameter; `'desktop'` uses `WindowsDesktopSandbox`, `'rdp'` throws `NotImplementedError`
6. `LocalRdpSandbox` class implementing `SandboxProvider` interface — stub that throws `NotImplementedError` on `createSandbox`
7. Orchestrator + safety layer route injection through the sandbox's `PostMessageInputProvider` when sandbox mode is active
8. Audit log records sandbox mode per session

### Must NOT have
- NO RDP session implementation in v1 (interface + stub only)
- NO Hyper-V or Windows Sandbox (edition prerequisite not met)
- NO removal of the existing `SendInput`-based `WindowsInputProvider` (kept as fallback)
- NO removal of the existing `node-screenshots`-based `WindowsScreenProvider` (kept for non-sandbox mode)
- NO change to the watchdog's LL-hook code (dead-man switch + heartbeat still active; filtering becomes secondary — in sandbox mode the watchdog provides ZERO input filtering because PostMessage bypasses LL hooks; safety rests on private-desktop isolation + hwnd-validity gate + audit)
- NO `SwitchDesktop` call (would swap the user's visible desktop — violates isolation)
- NO `SendInput` in sandbox mode (forbidden — it enters the system input stream)
- NO `SetThreadDesktop` on Node's main thread (sticky per-thread; breaks Default-desktop path + heartbeat) — must use a `worker_threads` thread that owns all private-desktop interaction

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: **TDD** — RED → GREEN → SURFACE for every behavior change
- Framework: Jest (TypeScript)
- Evidence path: `.omo/evidence/sandbox-task-<N>.<ext>`
- Every todo carries: exhaustive References, agent-executable Acceptance criteria, happy + failure QA scenarios, Commit line

## Execution strategy
### Parallel execution waves

**Wave 1 — Interfaces**: SandboxProvider interface + LocalRdpSandbox stub (no dependencies)
**Wave 2 — Desktop backend**: WindowsDesktopSandbox + PostMessageInputProvider + BitBltScreenProvider (depends on Wave 1)
**Wave 3 — Integration**: Wire sandbox into safety + orchestrator + server (depends on Wave 2)
**Wave 4 — Verification**: Tests + documentation (depends on Wave 3)

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 | — | 2,3,4,5,6 | — |
| 2 | 1 | 5,7 | 3,4,6 |
| 3 | 1 | 7 | 2,4,5,6 |
| 4 | 1 | 7 | 2,3,5,6 |
| 5 | 1,2 | 7 | 3,4,6 |
| 6 | 1,5 | 7 | 2,3,4 |
| 7 | 2,3,4,5,6 | 8 | — |
| 8 | 7 | 9 | — |
| 9 | 8 | 10 | — |
| 10 | 9 | — | — |

## Todos

- [x] 1. SandboxProvider interface + LocalRdpSandbox stub
  What to do / Must NOT do: Create `src/platform/sandbox.ts` exporting `SandboxProvider` interface (`createSandbox(config: SandboxConfig): Promise<SandboxHandle>`), `SandboxConfig` (`{ mode: 'desktop' | 'rdp', targetApp?: string, targetHwnd?: number }`), `SandboxHandle` (`{ desktopName: string, targetHwnd: number, dispose(): Promise<void> }`). Create `src/sandbox/rdp-sandbox.ts` exporting `LocalRdpSandbox implements SandboxProvider` — `createSandbox()` throws `NotImplementedError` (with `Object.setPrototypeOf`). Must NOT implement any RDP logic.
  Parallelization: Wave 1 | Blocked by: — | Blocks: 2,3,4,5,6
  References: `src/platform/safety.ts` (interface pattern), `src/platform/input.ts`
  Acceptance criteria: `tsc --noEmit` clean; `src/platform/sandbox.ts` exports the three types; `LocalRdpSandbox` throws `NotImplementedError`
  QA: `npm test` green; `npx tsc --noEmit` exit 0
  Commit: Y | feat(sandbox): SandboxProvider interface + LocalRdpSandbox stub

- [x] 2. WindowsDesktopSandbox (CreateDesktop backend)
  What to do / Must NOT do: Implement `src/sandbox/desktop-sandbox.ts` — `WindowsDesktopSandbox implements SandboxProvider`. Uses koffi to call `CreateDesktopW` (with `DESKTOP_CREATEWINDOW|DESKTOP_HOOKCONTROL|...` access), then spawns a **`worker_threads` Worker** that calls `SetThreadDesktop(privateDesktop)` and owns ALL subsequent private-desktop interaction (probe, injection, capture). `CreateProcessW` with `STARTUPINFO.lpDesktop = L"<desktop-name>"` spawns the target app on the private desktop (from the worker thread). Returns `SandboxHandle` with `desktopName` + `targetHwnd` (found via `FindWindowExW` on the private desktop, from the worker). `dispose()` closes the desktop + terminates the worker. Must NOT call `SetThreadDesktop` on Node's main thread (sticky, breaks Default-desktop path + heartbeat). Must NOT call `SwitchDesktop`. Must handle `CreateDesktop` name collision with a unique suffix.
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 5
  References: `src/safety.ts` (koffi pattern), `src/watchdog/watchdog.cpp` (Win32 API pattern)
  Acceptance criteria: `WindowsDesktopSandbox.createSandbox({ mode:'desktop', targetApp:'notepad.exe' })` returns a handle with a non-empty `desktopName` and non-zero `targetHwnd`; the spawned process runs on the private desktop (verifiable via process desktop query)
  QA: spawn notepad on a private desktop; assert `GetThreadDesktop(GetCurrentThreadId())` differs from the default desktop
  Commit: Y | feat(sandbox): WindowsDesktopSandbox via CreateDesktop + SetThreadDesktop

- [x] 3. PostMessageInputProvider (direct-to-window injection)
  What to do / Must NOT do: Implement `src/input-postmessage.ts` — `PostMessageInputProvider implements InputProvider`. `mouseClick(x,y,button)` → `ScreenToClient(targetHwnd, &pt)` FIRST (converts screen→client coords), then `PostMessageW(targetHwnd, WM_LBUTTONDOWN/UP, MK_LBUTTON, MAKELPARAM(clientX, clientY))`. `mouseMove` → same with `WM_MOUSEMOVE`. `keyPress` → `PostMessageW(targetHwnd, WM_KEYDOWN/UP, VkKeyScanW(key), 0)`. `typeText` → `SendMessageW(targetHwnd, WM_CHAR, charCode, 0)` per character. Uses koffi `user32.dll`. Must NOT use `SendInput`. Must NOT touch the system input stream. MUST convert screen→client coordinates before `MAKELPARAM` (WM_LBUTTONDOWN expects client coords, not screen).
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 5
  References: `src/input.ts` (koffi pattern, key mapping tables), `src/platform/input.ts`, MS docs for `WM_LBUTTONDOWN` LPARAM (client coords)
  Acceptance criteria: unit-test the pure logic (message building, LPARAM encoding, key→VK mapping, **screen→client coordinate conversion via fake ScreenToClient**) with fake deps; `tsc --noEmit` clean
  QA: TDD RED→GREEN for message-building + coordinate-conversion pure functions
  Commit: Y | feat(input): PostMessageInputProvider with ScreenToClient for sandbox-isolated injection

- [x] 4. BitBltScreenProvider (private-desktop capture)
  What to do / Must NOT do: Implement `src/screenshot-bitblt.ts` — `BitBltScreenProvider implements ScreenProvider`. `captureFull()` → `PrintWindow(targetHwnd, hdc, PW_RENDERFULLCONTENT)` + `BitBlt` to a memory DC → PNG via a minimal encoder OR return raw BGRA buffer. `captureWindow(title)` → `FindWindowExW` on the private desktop + `PrintWindow`. Uses koffi `user32.dll` + `gdi32.dll`. Must NOT use `node-screenshots` (captures the input desktop, not the private one). MUST document known limitation: `PrintWindow` fails for Direct3D/OpenGL/hardware-accelerated windows (games, some UWP, Electron with GPU rendering) — send `WM_PRINT`/`WM_PRINTCLIENT` as fallback, but some apps still won't render.
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 5
  References: `src/screenshot.ts` (interface), `src/input.ts` (koffi pattern)
  Acceptance criteria: `captureWindow` on a spawned notepad returns a valid PNG buffer; `tsc --noEmit` clean
  QA: spawn notepad on private desktop; capture; assert PNG magic bytes
  Commit: Y | feat(screenshot): BitBltScreenProvider with PrintWindow fallback for private-desktop capture

- [x] 5. Sandbox-aware safety gate (replaces cursorAndFocusInside for sandbox sessions)
  What to do / Must NOT do: In `src/safety.ts`, add a sandbox mode to `injectGuarded`. For sandbox sessions, REPLACE `cursorAndFocusInside` (which checks Default-desktop foreground+cursor — wrong for a private-desktop target) with a hwnd-validity gate: (a) `IsWindow(targetHwnd)` still true, (b) `GetWindowThreadProcessId(targetHwnd)` → threadId → `GetThreadDesktop(threadId)` === the private desktop handle (target still on the private desktop). Do NOT check `GetForegroundWindow` or `GetCursorPos` (they query the Default desktop and would always fail). Add a `sandboxMode: boolean` field to `ActiveSession`; when true, use the hwnd-validity gate; when false, use the existing `cursorAndFocusInside`. `IsWindow`/`GetWindowThreadProcessId`/`GetThreadDesktop` via koffi user32.
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 7
  References: `src/safety.ts:439-477` (injectGuarded + cursorAndFocusInside)
  Acceptance criteria: `injectGuarded` with `sandboxMode=true` + valid target hwnd → passes; invalid hwnd → throws `WindowScopeViolationError`; target on wrong desktop → throws `WindowScopeViolationError`. TDD RED→GREEN.
  Commit: Y | feat(safety): sandbox-aware hwnd-validity gate for private-desktop sessions

- [x] 6. Sandbox-aware orchestrator probe
  What to do / Must NOT do: In `src/orchestrator.ts`, for sandbox sessions, route all probe calls (`getForegroundWindow`, `getWindowText`, `getWindowRect`, `isSecureDesktop`) through the sandbox's worker thread (which has `SetThreadDesktop` set). The probe must return private-desktop state, not Default-desktop state. DISABLE the Default-desktop freshness gate (`getForegroundWindow() !== target → StaleStateError`) for sandbox sessions — replace with an hwnd-validity check (`IsWindow(target)` still true). The `isSecureDesktop()` check is irrelevant on a private desktop (always false in sandbox mode — the private desktop is never the UAC secure desktop).
  Parallelization: Wave 2 | Blocked by: 1,5 | Blocks: 7
  References: `src/orchestrator.ts:415-425,499-510` (probe + freshness gate)
  Acceptance criteria: sandbox session `poll()` returns private-desktop title/rect; `executeAction` does NOT throw `StaleStateError` for a valid sandbox target. TDD.
  Commit: Y | feat(orchestrator): sandbox-aware probe + disabled Default-desktop freshness gate

- [x] 7. Wire sandbox into safety + orchestrator + server
  What to do / Must NOT do: In `src/safety.ts`, `startDebugSession` accepts `sandbox?: 'desktop'|'rdp'`. If `'desktop'` → create `WindowsDesktopSandbox`, spawn target, get `targetHwnd`, set as the session target; use `PostMessageInputProvider` + `BitBltScreenProvider` for the session. If `'rdp'` → `LocalRdpSandbox` (throws `NotImplemented`). If no sandbox → existing `SendInput` path (unchanged fallback). In `src/server.ts`, `start_debug_session` tool passes `sandbox` param. In `src/orchestrator.ts`, `executeAction` uses the session's sandbox-aware input provider.
  Parallelization: Wave 3 | Blocked by: 2,3,4,5,6 | Blocks: 8
  References: `src/safety.ts`, `src/orchestrator.ts`, `src/server.ts`
  Acceptance criteria: `start_debug_session({ regions:[...], sandbox:'desktop' })` creates a private desktop; `executeAction('mouse_click', {x,y,button})` sends PostMessage (no SendInput); audit log records `sandbox: 'desktop'`
  QA: start session with sandbox='desktop' + notepad target; assert no SendInput (grep audit log); assert notepad receives the message
  Commit: Y | feat(safety): wire sandbox into session lifecycle + orchestrator

- [x] 8. Integration tests for sandbox mode
  What to do / Must NOT do: Write `tests/sandbox.test.ts` — (a) `start_debug_session` with `sandbox:'desktop'` creates a private desktop (desktop name non-empty); (b) `executeAction('type_text', {text:'hi'})` delivers WM_CHAR to the target window (verifiable via SendMessage echo or a test app); (c) `sandbox:'rdp'` throws `NotImplementedError`; (d) audit log records sandbox mode. Use fake/mock deps where real GUI is unavailable.
  Parallelization: Wave 4 | Blocked by: 7 | Blocks: 9
  References: `tests/safety.test.ts`, `tests/orchestrator.test.ts`
  Acceptance criteria: `npm test` green; RED→GREEN captured
  Commit: Y | test(sandbox): integration tests for desktop-sandbox mode

- [x] 9. README update for sandbox mode
  What to do / Must NOT do: Update `README.md` Usage section: document `sandbox: 'desktop'|'rdp'` parameter; explain PostMessage vs SendInput; document that desktop mode isolates the user's real desktop; document RDP as reserved. Update Security model: PostMessage bypasses LL hooks (safety = private desktop + window scoping + audit); in sandbox mode the watchdog provides ZERO input filtering — safety rests on private-desktop isolation + hwnd-validity gate + audit. Document `PrintWindow` limitation (fails for D3D/OpenGL/hardware-accelerated windows). Document that `SetThreadDesktop` runs on a worker thread (not main).
  Parallelization: Wave 4 | Blocked by: 8 | Blocks: 10
  References: `README.md`
  Acceptance criteria: README has sandbox section; PostMessage semantics documented honestly
  Commit: Y | docs(sandbox): document desktop-sandbox mode + PostMessage injection

- [x] 10. Final verification
  What to do / Must NOT do: `tsc --noEmit` clean; `npm test` green; `npm run build` exit 0; grep for `SendInput` in sandbox-mode code paths (should be absent); grep for `SwitchDesktop` (forbidden).
  Parallelization: Wave 4 | Blocked by: 9 | Blocks: —
  References: —
  Acceptance criteria: all checks pass
  Commit: N | —

## Final verification wave
- [x] F1. Plan compliance audit
- [x] F2. Code quality review
- [x] F3. Scripted integration QA
- [x] F4. Scope fidelity

## Success criteria
1. **Isolation**: PostMessage injection never enters the system input stream; user's real mouse/keyboard/desktop untouched
2. **Private desktop**: target app runs on a `CreateDesktop` desktop; LL hooks are desktop-scoped (isolated from `Default`)
3. **Interface reserved**: `LocalRdpSandbox` stub exists; `sandbox:'rdp'` throws `NotImplementedError`
4. **Fallback**: existing `SendInput` path unchanged for non-sandbox sessions
5. **Quality**: tsc clean, tests green, build exit 0
6. **Honesty**: PostMessage semantics documented; LL-hook-filter-moot limitation documented; `PrintWindow` fails for Direct3D/OpenGL/hardware-accelerated windows (games, some UWP, Electron with GPU rendering) — documented as known limitation
