# competitive-improvements - Work Plan

## TL;DR (For humans)

**What you'll get:** A set of targeted improvements that close the gaps between mcp-windows-debug and its competitors (terminator-mcp-agent, Anthropic Computer Use, Windows MCP/CursorTouch, UFO³). Each improvement adopts a proven competitor strength while preserving this project's unique advantages (dual-process safety, sandbox isolation, OpenCode-native MCP).

**Why this approach:** The competitor comparison revealed 6 actionable gaps where competitors do better: (1) no UIAutomation/accessibility-API path, (2) ShellExecuteEx elevation stub, (3) no MCP SDK v2 migration path, (4) no ElementInspector/find-and-click tool, (5) no session recording/replay, (6) no README quick-start badge/config validation. Each gap maps to one focused todo.

**What it will NOT do:** No full UI application (stays stdio MCP). No macOS/Linux backend (interfaces already reserved). No removal of existing SendInput/watchdog/sandbox paths. No new external dependencies beyond what's already installed.

**Effort:** Medium — 8 todos across 4 waves.
**Risk:** Medium — UIAutomation addon touches the input layer; ShellExecuteEx touches elevation.

**Decisions to sanity-check:**
- UIAutomation as an OPTIONAL tool (not replacing SendInput/PostMessage, additive)
- ShellExecuteEx via koffi shell32 (not a separate exe)
- MCP SDK v2 migration deferred (zod v4/ESM-only, OpenCode compatibility unproven)
- Session recording as JSON transcript (not video)

Your next move: approve this plan, or ask for adjustments.

---

> TL;DR (machine): Medium effort, Medium risk — 8 todos: UIAutomation tool, ShellExecuteEx elevation, element inspector, session recording, config validation, README badges, CI workflow, competitive test suite.

## Scope
### Must have
1. `UIAutomationProvider` — optional accessibility-API input path (koffi → UIAutomationCore/uiautomation), enabling find-by-name/click-by-text without screenshots (competitor: terminator-mcp-agent)
2. `ShellExecuteExW` elevation — replace the `spawnElevated()` stub with a real koffi `shell32.dll` call that triggers UAC (competitor: none have this, but it closes our own gap)
3. `inspect_element` MCP tool — enumerate visible UI elements (name, role, rect, enabled) on the target window via UIAutomation (competitor: Windows MCP Inspector)
4. Session recording — JSON transcript of every tool call + screenshot timestamp, replayable (competitor: UFO³ workflow recording)
5. Config validation — `--validate-config` CLI flag that checks `opencode.jsonc` has the correct `mcp` entry and `dist/index.js` exists (competitor: Windows MCP's `--tools` validation)
6. README quick-start badges + OpenCode config validation snippet
7. CI workflow — GitHub Actions: build + tsc + test on push (competitor: all open-source MCP servers have CI)
8. Competitive test suite — add tests that exercise the new UIAutomation + elevation + recording paths

### Must NOT have
- NO full GUI application (stays stdio MCP)
- NO macOS/Linux backend implementation (interfaces already reserved)
- NO MCP SDK v2 migration (deferred — ESM-only, OpenCode unproven)
- NO removal of existing SendInput/PostMessage/watchdog paths
- NO new npm dependencies (UIAutomation via koffi FFI to existing system DLLs)
- NO video recording (JSON transcript only)

## Verification strategy
- Test decision: TDD — RED → GREEN → SURFACE
- Framework: Jest (TypeScript)
- Evidence path: `.omo/evidence/comp-<N>.<ext>`

## Execution strategy
### Parallel execution waves

**Wave 1 — Foundation**: ShellExecuteEx elevation + config validation (independent)
**Wave 2 — UIAutomation**: UIAutomationProvider + inspect_element tool (depends on Wave 1 for elevation testing)
**Wave 3 — Recording**: Session recording (independent of Wave 2)
**Wave 4 — Finalization**: README + CI + competitive tests

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 | — | 2 | 3,4,5 |
| 2 | 1 | 6 | 3,4,5 |
| 3 | 1 | 6 | 2,4,5 |
| 4 | — | 6 | 1,2,3,5 |
| 5 | — | 6 | 1,2,3,4 |
| 6 | 2,3,4,5 | 7 | — |
| 7 | 6 | 8 | — |
| 8 | 7 | — | — |

## Todos

- [x] 1. ShellExecuteExW elevation (replace spawnElevated stub)
  What to do / Must NOT do: In `src/safety.ts`, replace the `spawnElevated()` stub (line ~314) with a real `ShellExecuteExW` call via koffi `shell32.dll`. Use `SEE_MASK_NOCLOSEPROCESS` to get the process handle. Handle `ERROR_CANCELLED` (1223, user declined UAC) and `ERROR_ELEVATION_REQUIRED` (740) by throwing `ElevationRequiredError`. The watchdog exe path + `--pipe-id` + `WATCHDOG_TOKEN` env are passed as the lpFile + lpParameters. Must NOT change the non-elevated `defaultSpawnWatchdog` path (fallback). Must NOT add new deps.
  Parallelization: Wave 1 | Blocked by: — | Blocks: 2
  References: `src/safety.ts:306-318` (spawnElevated stub), `src/safety.ts:214-237` (defaultSpawnWatchdog), koffi `shell32.dll` `ShellExecuteExW` + `SHELLEXECUTEINFOW` struct
  Acceptance criteria: `startDebugSession` with watchdog requiring elevation triggers UAC prompt; on accept, watchdog spawns elevated; on decline, throws `ElevationRequiredError`; non-elevated fallback path unchanged
  QA: TDD — test that `spawnElevated` calls `ShellExecuteExW` with correct params (fake koffi deps); real UAC prompt tested manually
  Commit: Y | feat(safety): ShellExecuteExW elevation for watchdog spawn

- [x] 2. UIAutomationProvider (accessibility-API input path)
  What to do / Must NOT do: Create `src/uiautomation.ts` — `UIAutomationProvider` implementing `InputProvider` via koffi FFI to `uiautomation.dll` (IUIAutomation COM interface). Methods: `mouseClick` finds element by name/automation-id and invokes `Invoke` or `Click` pattern; `keyPress` sends via `SendKeys`; `typeText` via `Value` pattern. Constructor takes `targetHwnd` + optional deps seam. Must NOT replace SendInput or PostMessage paths (additive, third option). Must NOT add npm deps (koffi FFI to system DLL only).
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 6
  References: `src/input.ts` (InputProvider pattern), `src/input-postmessage.ts` (deps seam pattern), MS docs for `IUIAutomation` COM interface
  Acceptance criteria: `UIAutomationProvider` implements `InputProvider`; unit tests for element-finding + invoke logic with fake deps; `tsc --noEmit` clean
  QA: TDD — fake COM deps; test find-by-name + invoke pattern
  Commit: Y | feat(input): UIAutomationProvider via accessibility API

- [x] 3. inspect_element MCP tool (element enumeration)
  What to do / Must NOT do: In `src/server.ts`, register a new `inspect_element` tool that takes `{ title: string, filter?: string }` and returns a JSON list of visible UI elements on the target window (name, automationId, role, rect, enabled, focused) via the UIAutomation tree walker. Competitor: Windows MCP Inspector. Must NOT depend on screenshots. Must NOT modify existing tools.
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 6
  References: `src/server.ts` (tool registration pattern), `src/uiautomation.ts` (from todo 2)
  Acceptance criteria: `tools/list` returns 11 tools; `inspect_element` on a Notepad window returns ≥1 element; invalid window → structured error
  QA: TDD — fake UIAutomation tree walker; test element enumeration shape
  Commit: Y | feat(server): inspect_element tool via UIAutomation tree walker

- [x] 4. Session recording (JSON transcript)
  What to do / Must NOT do: Create `src/recording.ts` — `SessionRecorder` that hooks into the audit log and records every tool call (name, args, result, timestamp, screenshot path) into a JSON transcript file under `.omo/recordings/session-<id>.json`. Supports `replay(transcriptPath)` that re-issues the same tool calls in order (competitor: UFO³ workflow recording). Must NOT record keystroke content (data minimization). Must NOT use video.
  Parallelization: Wave 3 | Blocked by: — | Blocks: 6
  References: `src/audit.ts` (logEntry pattern), `src/server.ts` (tool handler context)
  Acceptance criteria: start/end session produces a transcript file; replay re-issues calls in order; transcript contains no keystroke content
  QA: TDD — fake recorder; test record + replay with fake tool calls
  Commit: Y | feat(recording): session JSON transcript + replay

- [x] 5. Config validation CLI flag
  What to do / Must NOT do: In `src/index.ts`, add `--validate-config` flag that reads `~/.config/opencode/opencode.jsonc`, checks the `mcp.windows-debug` entry exists with correct shape (`type: local`, `command: [node, ...]`, `environment: {}`), and verifies `dist/index.js` exists. Prints `OK` or a diagnostic error. Must NOT modify the config file.
  Parallelization: Wave 1 | Blocked by: — | Blocks: 6
  References: `src/index.ts` (entry point), `README.md` (config format)
  Acceptance criteria: `node dist/index.js --validate-config` exits 0 with `OK` when config is correct; exits 1 with diagnostic when missing/wrong
  QA: manual — run with correct config (exit 0), run with missing entry (exit 1 + message)
  Commit: Y | feat(cli): --validate-config flag for OpenCode config

- [x] 6. README quick-start badges + config snippet
  What to do / Must NOT do: Update `README.md`: add build-status badge (links to CI from todo 7), add quick-start section with one-command setup (`npm install && npm run build && cd src\watchdog && build.bat`), add `--validate-config` usage, document `inspect_element` tool, document session recording. Must NOT claim absolute safety. Must NOT add screenshots (text only).
  Parallelization: Wave 4 | Blocked by: 2,3,4,5 | Blocks: 7
  References: `README.md`, `src/server.ts` (tool count = 11 now)
  Acceptance criteria: README has badges + quick-start + new tools documented
  QA: README exists with all sections
  Commit: Y | docs: quick-start badges + new tools documentation

- [x] 7. CI workflow (GitHub Actions)
  What to do / Must NOT do: Create `.github/workflows/ci.yml` — on push/PR, run `npm install`, `npm run build`, `npx tsc --noEmit`, `npm test -- --forceExit`. Use `windows-latest` runner (project is Windows-only). Must NOT run GUI/elevation-gated tests (they skip). Must NOT require MSVC (watchdog build is optional in CI).
  Parallelization: Wave 4 | Blocked by: 6 | Blocks: 8
  References: `.github/` (new directory)
  Acceptance criteria: CI runs on push; build + tsc + test pass; skips elevation-gated tests
  QA: push triggers CI; green checkmark on GitHub
  Commit: Y | ci: GitHub Actions build + test workflow

- [x] 8. Competitive test suite + final verification
  What to do / Must NOT do: Write `tests/competitive.test.ts` — tests that exercise the new paths: (a) UIAutomationProvider constructs + implements InputProvider; (b) `inspect_element` tool registered in tools/list (11 tools); (c) session recorder produces valid JSON; (d) `--validate-config` flag works; (e) ShellExecuteEx called with correct params (fake deps). Final verification: `tsc --noEmit` clean, `npm test` green, `npm run build` exit 0.
  Parallelization: Wave 4 | Blocked by: 7 | Blocks: —
  References: all new files from todos 1-5
  Acceptance criteria: all tests pass; tsc clean; build exit 0
  QA: `npm test` green
  Commit: Y | test: competitive test suite for new improvement paths

## Final verification wave
- [x] F1. Plan compliance audit
- [x] F2. Code quality review
- [x] F3. Scripted integration QA
- [x] F4. Scope fidelity

## Success criteria
1. **UIAutomation path**: `inspect_element` + `UIAutomationProvider` provide screenshot-free element interaction (competitor parity with terminator-mcp-agent)
2. **Elevation**: `ShellExecuteExW` triggers UAC; watchdog spawns elevated (closes our own gap)
3. **Session recording**: JSON transcript + replay (competitor parity with UFO³)
4. **Config validation**: `--validate-config` verifies OpenCode setup (competitor parity with Windows MCP)
5. **CI**: GitHub Actions green on push (competitor parity with all open-source MCP servers)
6. **Quality**: tsc clean, tests green, build exit 0, no new deps
