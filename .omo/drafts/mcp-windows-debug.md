# MCP Windows Debug Tool - Planning Draft

## Intent
- **Routing**: CLEAR — user specified the exact endpoint (MCP server for GUI automation — key/mouse, vision, file access, auto-debug, abort-button safety — with cross-platform interfaces, Windows backend in v1)
- **Review required**: false

## Classification
- **Size**: ARCHITECTURE — empty repo, 6+ modules, security-critical, long-term impact
- **Dynamic adversarial lanes**: Will be needed

## Decisions Recorded (from user interview)
| # | Decision | Choice | Why it matters |
|---|----------|--------|----------------|
| 1 | Tech stack | TypeScript/Node.js | Official MCP SDK, OpenCode ecosystem match |
| 2 | Vision integration | MCP exposes screenshots only; model on OpenCode side | Security, no API key in MCP, single responsibility |
| 3 | Abort-button safety | Global keyboard/mouse hooks (WH_KEYBOARD_LL / WH_MOUSE_LL) | Physically block input to protected regions |
| 4 | Debug mode | Continuous monitoring + auto-intervention | Background loop watches target, auto-acts on conditions |

## Components (Topology Lock)
1. **MCP Server Core** — stdio transport, tool/resource registration, OpenCode config schema
2. **Windows Key/Mouse Layer** — SendInput only (koffi FFI); keybd_event/mouse_event forbidden (bypass injected-input filter)
3. **Screen Capture Layer** — screenshot full screen / specific windows, expose as MCP resources
4. **File System Access Layer** — broad read access, path validation, safety checks
5. **Safety Abort Layer** — global hooks, protected-region registry, physical input blocking
6. **Auto-Debug Orchestration** — continuous monitoring loop, condition triggers, action sequences
7. **Platform Abstraction Layer** — platform-neutral provider interfaces (`InputProvider`/`ScreenProvider`/`FileProvider`/`SafetyProvider`); Windows is the v1 backend; macOS/Linux plug in later

## Decisions Recorded (from user interview — round 2, safety-critical)
| # | Decision | Choice | Why it matters |
|---|----------|--------|----------------|
| 5 | Abort mechanism fix | Injected-input filter (LLKHF_INJECTED) + independent watchdog dead-man switch | Human can always click; MCP death auto-removes hooks; residual risk documented honestly |
| 6 | Process architecture | Dual-process: native watchdog (hooks+failsafe) + Node MCP service | Node event-loop stall cannot freeze system input or silently remove safety layer |
| 7 | Privilege model | Elevated (administrator) | Can inject into elevated windows, read any user's files; must handle secure desktop; higher attack value |
| 8 | File access policy | USER DECIDES per session between TWO modes: (a) wide read + sensitive-path denylist + audit, or (b) wide read + strict allowlist + audit | Runtime-mode choice; audit log mandatory in both; no tool may read without logging |
| 9 | Cross-platform strategy | Platform-neutral provider interfaces (`InputProvider`/`ScreenProvider`/`FileProvider`/`SafetyProvider`) with Windows as v1-only backend | macOS/Linux backends plug in later behind the same interfaces without re-architecting |

## Status
- **Current**: delivered — cross-platform interface modification applied and approved by Metis (round-5: APPROVE; Must-have #18 now owned by Todo 1 + tested)
- **Gate**: user approval received; `.omo/plans/mcp-windows-debug.md` written (14 todos, 7 waves) with cross-platform provider interfaces (`src/platform/`); passed dual-Momus review

## Research Findings (verified)

### Librarian 1: MCP SDK + Windows integration (HIGH confidence)
- MCP SDK: `@modelcontextprotocol/sdk` v1.x (latest 1.30.0) — `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`, `StdioServerTransport` from `@modelcontextprotocol/sdk/server/stdio.js`, zod v3. DECISION (v1 over v2): v2 (`@modelcontextprotocol/server`, released 2026-07-28) is ESM-only, zod v4/Standard Schema, and its OpenCode stdio compatibility is unproven; v1 is stable/production-recommended, CommonJS-compatible (matches koffi/node-screenshots decision), and proven with OpenCode. v2 upgrade is a future migration, out of scope.
- **OpenCode config key is `mcp` NOT `mcpServers`; `command` is array; `environment` NOT `env`** — critical adaptation difference
- Key/mouse: `koffi@3.1.4` (1.4M weekly DL, prebuilt binaries, no build toolchain) → `SendInput`
- Screen capture: `node-screenshots` (N-API/Rust, Windows.Graphics.Capture API)
- **UIA: NO mature Node.js package exists** — must write N-API C++ addon or use nut-js image matching fallback

### Metis Gap Analysis (38 findings, CRITICAL)
**Fundamental contradiction discovered**: abort-button protection is bidirectionally impossible:
- If hook blocks ALL input to protected region → human user also cannot click abort
- If hook blocks only INJECTED input (`LLKHF_INJECTED` flag) → other processes can synthesize non-flagged input to bypass
- **Resolution required**: non-input watchdog dead-man switch + honest documentation of residual risk

**Additional critical gaps**:
- Hook hosting risks total input starvation if Node event loop stalls (GC pause, deadlock)
- Monitor→model→act loop is raced by construction (screenshot→remote inference takes seconds, UI changes)
- Oscillation/runaway loop unaddressed (no rate limit, cooldown, failure counter, stop condition)
- Privilege model undefined (injection into elevated windows requires equal/higher integrity/UIPI)
- "Debug automation" has no capability list (what is monitored? what events trigger? intervention vocabulary?)
- File access has no allowlist/denylist/size cap/sensitive-path policy
- Secure desktop (UAC/lock screen) behavior undefined
- Crash/disconnect semantics missing (hook cleanup, held keys, half-typed commands)
- No audit trail requirement (append-only log of every file read, injected action, intervention decision)
- Coordinate system contract missing (screenshot pixels vs physical mouse coords under DPI scaling)

## Risk Notes
- **Global hooks require admin privilege** — deployment/installation constraint
- **AV/anti-cheat may flag global hooks** — need signing or documented workaround
- **File system "everything" access is a security surface** — need explicit capability declaration + user confirmation flow
- **Abort-button protection at hook level is irreversible design** — once specified, the hook must stay active until session end
- **Single-process design (MCP server + hooks + injector + monitor in one Node process) is highest-risk structural decision** — Metis recommends separate watchdog process
- **Capability trio (arbitrary file read + screenshots + input injection) = RAT primitive** — AV/EDR will classify as keylogger/remote-access trojan; code signing + AV-interaction strategy needed
- **Prompt injection via screen content unmitigated** — debugged app controls what appears on screen; on-screen text is adversarial input to model
