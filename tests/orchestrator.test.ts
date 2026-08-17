/**
 * Orchestrator (src/orchestrator.ts) tests (TDD).
 *
 * Only PURE logic is exercised here — the state machine, trigger detection,
 * the governor (cooldown / rate limit / consecutive-failure pause / session
 * cap), the freshness gate, and secure-desktop handling — via injectable
 * seams. Every OS dependency (screen capture, input injection, window probing,
 * the safety gate) is faked, and time is controlled by a deterministic
 * `FakeClock`, so the suite runs with ZERO Win32 calls and ZERO real waits
 * (no 5s cooldown sleeps, no 30-minute caps in wall-clock time).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  CooldownActiveError,
  InvalidActionError,
  NotMonitoringError,
  Orchestrator,
  OrchestratorPausedError,
  RateLimitExceededError,
  SecureDesktopError,
  StaleStateError,
} from '../src/orchestrator';
import type {
  Clock,
  OrchestratorEvent,
  OrchestratorOptions,
  Rect,
  SafetyGate,
  WindowProbe,
} from '../src/orchestrator';
import type { InputProvider } from '../src/platform/input';
import type { CaptureResult, ScreenProvider } from '../src/platform/screen';
import type { SessionState } from '../src/safety';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** Deterministic clock: manual `advance` fires due timers in time order. */
class FakeClock implements Clock {
  private nowMs = 0;
  private nextId = 1;
  private readonly intervals = new Map<number, { fn: () => void; periodMs: number; nextAt: number }>();
  private readonly timeouts = new Map<number, { fn: () => void; at: number }>();

  now(): number {
    return this.nowMs;
  }

  setInterval(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.intervals.set(id, { fn, periodMs: ms, nextAt: this.nowMs + ms });
    return id;
  }

  clearInterval(handle: unknown): void {
    this.intervals.delete(handle as number);
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timeouts.set(id, { fn, at: this.nowMs + ms });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timeouts.delete(handle as number);
  }

  /** Advance virtual time by `ms`, firing every due timer in chronological order. */
  advance(ms: number): void {
    const target = this.nowMs + ms;
    for (;;) {
      let next: number | null = null;
      for (const t of this.timeouts.values()) if (next === null || t.at < next) next = t.at;
      for (const i of this.intervals.values()) if (next === null || i.nextAt < next) next = i.nextAt;
      if (next === null || next > target) break;

      this.nowMs = next;
      const dueTimeouts = [...this.timeouts.entries()].filter(([, t]) => t.at === next);
      for (const [id, t] of dueTimeouts) {
        this.timeouts.delete(id);
        t.fn();
      }
      const dueIntervals = [...this.intervals.entries()].filter(([, i]) => i.nextAt === next);
      for (const [, i] of dueIntervals) {
        i.fn();
        i.nextAt = next + i.periodMs;
      }
    }
    this.nowMs = target;
  }
}

/** Fake window probe: title/rect/foreground/secure-desktop all under test control. */
class FakeProbe implements WindowProbe {
  title = 'initial';
  fg = 100;
  rect: Rect | null = { left: 0, top: 0, right: 100, bottom: 100 };
  secure = false;

  getWindowText(_hwnd: number): string {
    return this.title;
  }
  getWindowRect(_hwnd: number): Rect | null {
    return this.rect;
  }
  getForegroundWindow(): number {
    return this.fg;
  }
  isSecureDesktop(): boolean {
    return this.secure;
  }
}

/** Fake screen provider returning a controllable PNG payload. */
class FakeScreen implements ScreenProvider {
  png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  captures = 0;

  async captureFull(): Promise<CaptureResult> {
    return { png: this.png, width: 100, height: 50 };
  }
  async captureWindow(_title: string): Promise<CaptureResult> {
    this.captures += 1;
    return { png: this.png, width: 100, height: 50 };
  }
}

/** Fake input provider recording each injection call. */
class FakeInput implements InputProvider {
  calls: string[] = [];
  async mouseClick(x: number, y: number, button: string): Promise<void> {
    this.calls.push(`mouse_click:${x},${y},${button}`);
  }
  async mouseMove(x: number, y: number): Promise<void> {
    this.calls.push(`mouse_move:${x},${y}`);
  }
  async keyPress(key: string, modifiers: string[]): Promise<void> {
    this.calls.push(`key_press:${key}:${modifiers.join('+')}`);
  }
  async typeText(text: string): Promise<void> {
    this.calls.push(`type_text:${text}`);
  }
}

/** Fake safety gate: records the target and optionally fails N injections. */
class FakeSafety implements SafetyGate {
  state: SessionState = 'ACTIVE';
  target: number | null = null;
  failuresRemaining = 0;
  injections = 0;

  async injectGuarded<T>(action: () => T | Promise<T>): Promise<T> {
    this.injections += 1;
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error('injection failed');
    }
    return action();
  }

  setTargetWindow(hwnd: number): void {
    this.target = hwnd;
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  orchestrator: Orchestrator;
  clock: FakeClock;
  probe: FakeProbe;
  screen: FakeScreen;
  input: FakeInput;
  safety: FakeSafety;
  events: OrchestratorEvent[];
}

let tempDirs: string[];
let logDir: string;
let sessionId: string;
const orchestrators: Orchestrator[] = [];

function makeOrchestrator(overrides: Partial<OrchestratorOptions> = {}): Harness {
  const clock = new FakeClock();
  const probe = new FakeProbe();
  const screen = new FakeScreen();
  const input = new FakeInput();
  const safety = new FakeSafety();
  const events: OrchestratorEvent[] = [];

  const orchestrator = new Orchestrator({
    sessionId,
    safety,
    input,
    screen,
    probe,
    clock,
    onNotify: (e) => events.push(e),
    ...overrides,
  });
  orchestrators.push(orchestrator);

  return { orchestrator, clock, probe, screen, input, safety, events };
}

function beforeTest(): void {
  tempDirs = [];
  logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-audit-'));
  sessionId = `sess-${Math.random().toString(36).slice(2)}`;
  process.env.AUDIT_LOG_DIR = logDir;
}

function afterTest(): void {
  delete process.env.AUDIT_LOG_DIR;
  for (const o of orchestrators) {
    try {
      o.stop();
    } catch {
      // best-effort cleanup
    }
  }
  orchestrators.length = 0;
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
}

/** Drain pending microtasks (async capture/detection continuations). */
function flushAsync(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

beforeEach(beforeTest);
afterEach(afterTest);

// ---------------------------------------------------------------------------
// Trigger detection
// ---------------------------------------------------------------------------

describe('Orchestrator trigger detection', () => {
  it('fires a title-change trigger within one poll interval', async () => {
    const h = makeOrchestrator({ pollIntervalMs: 1000 });
    h.orchestrator.start({ targetWindow: 100 });
    expect(h.orchestrator.state).toBe('MONITORING');

    h.clock.advance(1000); // first poll: no change
    expect(h.orchestrator.state).toBe('MONITORING');

    h.probe.title = 'new title';
    h.clock.advance(1000); // second poll detects the title change
    await flushAsync();

    expect(h.orchestrator.state).toBe('TRIGGERED');
    const ctx = h.orchestrator.getContext();
    expect(ctx.trigger).toBe('title');
    expect(ctx.target.title).toBe('new title');
    expect(ctx.screenshot).not.toBeNull();
    expect(h.screen.captures).toBeGreaterThanOrEqual(1);
  });

  it('fires a pixel-diff trigger when the screenshot signature changes', async () => {
    const h = makeOrchestrator({ pollIntervalMs: 1000, pixelDiffThreshold: 1 });
    h.orchestrator.start({ targetWindow: 100 });

    h.clock.advance(1000); // baseline signature captured
    await flushAsync();
    expect(h.orchestrator.state).toBe('MONITORING');

    h.screen.png = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]);
    h.clock.advance(1000); // signature differs → trigger
    await flushAsync();

    expect(h.orchestrator.state).toBe('TRIGGERED');
    expect(h.orchestrator.getContext().trigger).toBe('pixel');
  });
});

// ---------------------------------------------------------------------------
// Governor
// ---------------------------------------------------------------------------

describe('Orchestrator governor', () => {
  it('enforces the 5s cooldown: a second action within 5s is rejected', async () => {
    const h = makeOrchestrator({ cooldownMs: 5000, pollIntervalMs: 1000 });
    h.orchestrator.start({ targetWindow: 100 });
    h.clock.advance(1000);

    await h.orchestrator.executeAction('type_text', { text: 'hi' });
    expect(h.input.calls).toContain('type_text:hi');
    expect(h.orchestrator.state).toBe('COOLDOWN');

    h.clock.advance(1000);
    await expect(
      h.orchestrator.executeAction('type_text', { text: 'too soon' }),
    ).rejects.toBeInstanceOf(CooldownActiveError);

    h.clock.advance(5000);
    await h.orchestrator.executeAction('type_text', { text: 'yo' });
    expect(h.input.calls).toContain('type_text:yo');
  });

  it('auto-pauses after 3 consecutive failures', async () => {
    const h = makeOrchestrator({ maxConsecutiveFailures: 3, cooldownMs: 0 });
    h.orchestrator.start({ targetWindow: 100 });
    h.safety.failuresRemaining = 3;

    await expect(h.orchestrator.executeAction('type_text', { text: 'a' })).rejects.toThrow();
    await expect(h.orchestrator.executeAction('type_text', { text: 'b' })).rejects.toThrow();
    await expect(h.orchestrator.executeAction('type_text', { text: 'c' })).rejects.toThrow();

    expect(h.orchestrator.isPaused()).toBe(true);
    expect(h.orchestrator.state).toBe('PAUSED');
    expect(h.orchestrator.getContext().pauseReason).toBe('consecutive_failures');

    await expect(
      h.orchestrator.executeAction('type_text', { text: 'd' }),
    ).rejects.toBeInstanceOf(OrchestratorPausedError);
  });

  it('auto-ends the session after the 30-minute cap', async () => {
    const h = makeOrchestrator({ sessionCapMs: 100, pollIntervalMs: 10 });
    h.orchestrator.start({ targetWindow: 100 });

    h.clock.advance(200);

    expect(h.orchestrator.state).toBe('IDLE');
    const endEvents = h.events.filter((e) => e.type === 'session_end');
    expect(endEvents).toHaveLength(1);
    expect(endEvents[0].reason).toBe('session_cap');
  });

  it('enforces the 6-interventions-per-minute rate limit', async () => {
    const h = makeOrchestrator({ cooldownMs: 0, maxInterventionsPerMinute: 6 });
    h.orchestrator.start({ targetWindow: 100 });

    for (let i = 0; i < 6; i++) {
      await h.orchestrator.executeAction('type_text', { text: String(i) });
    }

    await expect(
      h.orchestrator.executeAction('type_text', { text: '7' }),
    ).rejects.toBeInstanceOf(RateLimitExceededError);

    h.clock.advance(61_000);
    await h.orchestrator.executeAction('type_text', { text: '8' });
    expect(h.input.calls).toContain('type_text:8');
  });
});

// ---------------------------------------------------------------------------
// Freshness gate
// ---------------------------------------------------------------------------

describe('Orchestrator freshness gate', () => {
  it('rejects with StaleStateError when the foreground window diverged', async () => {
    const h = makeOrchestrator();
    h.orchestrator.start({ targetWindow: 100 });

    h.probe.fg = 200; // focus moved to another window

    await expect(
      h.orchestrator.executeAction('type_text', { text: 'x' }),
    ).rejects.toBeInstanceOf(StaleStateError);
    expect(h.input.calls).toHaveLength(0); // nothing was injected
  });

  it('rejects with SecureDesktopError and pauses when the secure desktop is active', async () => {
    const h = makeOrchestrator();
    h.orchestrator.start({ targetWindow: 100 });

    h.probe.secure = true;

    await expect(
      h.orchestrator.executeAction('type_text', { text: 'x' }),
    ).rejects.toBeInstanceOf(SecureDesktopError);
    expect(h.orchestrator.isPaused()).toBe(true);
    expect(h.input.calls).toHaveLength(0);
  });

  it('dispatches a valid action through the safety gate', async () => {
    const h = makeOrchestrator();
    h.orchestrator.start({ targetWindow: 100 });

    await h.orchestrator.executeAction('mouse_click', { x: 10, y: 20, button: 'left' });

    expect(h.safety.target).toBe(100);
    expect(h.safety.injections).toBe(1);
    expect(h.input.calls).toContain('mouse_click:10,20,left');
  });
});

// ---------------------------------------------------------------------------
// Input validation + lifecycle
// ---------------------------------------------------------------------------

describe('Orchestrator validation and lifecycle', () => {
  it('rejects with NotMonitoringError before start', async () => {
    const h = makeOrchestrator();
    await expect(
      h.orchestrator.executeAction('type_text', { text: 'x' }),
    ).rejects.toBeInstanceOf(NotMonitoringError);
  });

  it('rejects an unknown action with InvalidActionError', async () => {
    const h = makeOrchestrator();
    h.orchestrator.start({ targetWindow: 100 });
    await expect(h.orchestrator.executeAction('bogus', {})).rejects.toBeInstanceOf(
      InvalidActionError,
    );
    expect(h.input.calls).toHaveLength(0);
  });
});
