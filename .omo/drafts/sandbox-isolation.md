# Sandbox Isolation - Planning Draft

## Intent
- **Routing**: CLEAR — user specified the exact change: automated keyboard/mouse injection must run in a sandbox, not the user's interactive desktop. User chose the mechanism: `CreateDesktop` + `PostMessage` (v1, any edition), with `LocalRdpSession` interface reserved.
- **Review required**: true (security-critical, multi-file architecture change)

## Classification
- **Size**: ARCHITECTURE — touches input/screenshot/safety/orchestrator/platform layers, adds new sandbox infra
- **Dynamic adversarial lanes**: Will be needed (PostMessage bypasses LL-hook watchdog — safety model re-evaluation)

## Decisions Recorded (from user)
| # | Decision | Choice | Why it matters |
|---|----------|--------|----------------|
| 1 | Sandbox mechanism (v1) | `CreateDesktop` + `SetThreadDesktop` + spawn target with `lpDesktop` | Lowest cost, any Windows edition, no VM/RDP; LL hooks are desktop-scoped per MS docs |
| 2 | Injection method | `PostMessage`/`SendMessage` (direct-to-window) instead of `SendInput` | Does NOT enter the system input stream → user's real mouse/keyboard 100% untouched |
| 3 | RDP interface reserved | `LocalRdpSession` provider interface defined but NOT implemented in v1 | Future Pro-edition path with full SendInput+watchdog inside an isolated session |
| 4 | Both modes user-selectable | `start_debug_session` accepts `sandbox: 'desktop' | 'rdp'` (rdp throws NotImplemented) | User picks per session |

## Status
- **Current**: delivered — plan written, Metis-reviewed (APPROVE after 6 fixes + matrix cleanup); 10 todos / 4 waves; Large effort / High risk
- **Gate**: awaiting user explicit approval to execute (user said "待我批准后执行")

## Research Findings (verified)

### Librarian: Windows sandbox mechanisms (HIGH confidence)
- **LL hooks (`WH_KEYBOARD_LL`/`WH_MOUSE_LL`) are DESKTOP-SCOPED** per MS docs: "affects all applications in the same desktop as the calling thread". A private desktop isolates hooks from the user's `Default` desktop.
- `CreateDesktop` + `SetThreadDesktop` + `STARTUPINFO.lpDesktop` creates a private desktop in-process via koffi; no edition prerequisite.
- `SendInput` injects into the SESSION's input desktop stream — to avoid touching the user's desktop entirely, switch to `PostMessage`/`SendMessage` (direct-to-window, never enters system input stream).
- `PostMessage` bypasses LL hooks entirely → the watchdog's injected-input filter becomes moot for PostMessage-based injection. Safety is enforced by: (a) private desktop isolation, (b) window-scoping gate, (c) target window must be on the private desktop.
- Session 0 is NOT viable for GUI (non-interactive since Vista, dead since Win10 1803).
- Windows Sandbox needs 1903+ (user's machine is 1803) → NOT available.

## Risk Notes
- **PostMessage ≠ SendInput semantically**: some apps may behave differently (e.g., focus/activation chains, hardware-level input). Documented honestly.
- **Watchdog role changes**: with PostMessage, the LL-hook injected-input filter is no longer the primary safety mechanism. Safety shifts to: private-desktop isolation + window-scoping + audit. The watchdog's dead-man switch + heartbeat still useful for session lifecycle.
- **Screenshot scope**: `node-screenshots` captures the input desktop. For a private non-input desktop, need `PrintWindow`/`BitBlt` fallback on windows of that desktop.
- **RDP interface reserved**: `LocalRdpSession` provider defined but throws `NotImplementedError`; future work.
