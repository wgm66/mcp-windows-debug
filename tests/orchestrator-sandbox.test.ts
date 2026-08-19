/**
 * Sandbox-aware orchestrator probe tests (TDD).
 */

import { Orchestrator } from '../src/orchestrator';
import type { WindowProbe, Clock, Rect } from '../src/orchestrator';
import type { InputProvider } from '../src/platform/input';
import type { ScreenProvider } from '../src/platform/screen';
import type { SessionState } from '../src/safety';

class FakeProbe implements WindowProbe {
  title = 'TestApp';
  rect: Rect = { left: 0, top: 0, right: 800, bottom: 600 };
  foreground = 12345;
  secure = false;
  windowValid = true;
  getWindowText(_h: number) { return this.title; }
  getWindowRect(_h: number) { return this.rect; }
  getForegroundWindow() { return this.foreground; }
  isSecureDesktop() { return this.secure; }
  isWindow(_h: number) { return this.windowValid; }
}

class FakeClock implements Clock {
  t = 1000;
  timers: Array<{ fn: () => void; ms: number; id: number }> = [];
  nextId = 1;
  now() { return this.t; }
  setInterval(fn: () => void, ms: number) { const id = this.nextId++; this.timers.push({ fn, ms, id }); return id; }
  clearInterval(h: unknown) { this.timers = this.timers.filter(function (t) { return t.id !== h; }); }
  setTimeout(fn: () => void, ms: number) { const id = this.nextId++; this.timers.push({ fn, ms, id }); return id; }
  clearTimeout(h: unknown) { this.timers = this.timers.filter(function (t) { return t.id !== h; }); }
  advance(ms: number) { this.t += ms; const due = this.timers.filter(function (t) { return t.ms <= ms; }); for (const d of due) d.fn(); this.timers = this.timers.filter(function (t) { return !due.includes(t); }); }
}

class FakeInput implements InputProvider {
  calls: string[] = [];
  async mouseClick() { this.calls.push('click'); }
  async mouseMove() { this.calls.push('move'); }
  async keyPress() { this.calls.push('key'); }
  async typeText() { this.calls.push('type'); }
}

class FakeScreen implements ScreenProvider {
  async captureFull() { return { png: Buffer.from([0x89, 0x50, 0x4e, 0x47]), width: 1, height: 1 }; }
  async captureWindow() { return { png: Buffer.from([0x89, 0x50, 0x4e, 0x47]), width: 1, height: 1 }; }
}

class FakeSafety {
  _state: SessionState = 'ACTIVE';
  target = 12345;
  get state() { return this._state; }
  async injectGuarded<T>(action: () => T | Promise<T>): Promise<T> { return action(); }
  setTargetWindow(h: number) { this.target = h; }
  setSandboxMode(_d: unknown) {}
}

describe('sandbox-aware orchestrator probe', () => {
  it('executeAction in sandbox mode does NOT throw StaleStateError for valid target', async () => {
    const probe = new FakeProbe();
    const clock = new FakeClock();
    const safety = new FakeSafety();
    const input = new FakeInput();
    const orch = new Orchestrator({
      sessionId: 'sb-test', safety: safety as never, input, screen: new FakeScreen(), probe, clock, sandboxMode: true,
    });
    orch.start({ targetWindow: 12345 });
    // In sandbox mode, foreground is NOT target (12345 vs probe.foreground=12345 by default)
    // but sandboxMode should skip the foreground check.
    await orch.executeAction('mouse_move', { x: 100, y: 100 });
    expect(input.calls).toContain('move');
  });

  it('executeAction in sandbox mode throws StaleStateError when IsWindow returns false', async () => {
    const probe = new FakeProbe();
    probe.windowValid = false;
    const clock = new FakeClock();
    const safety = new FakeSafety();
    const input = new FakeInput();
    const orch = new Orchestrator({
      sessionId: 'sb-test2', safety: safety as never, input, screen: new FakeScreen(), probe, clock, sandboxMode: true,
    });
    orch.start({ targetWindow: 12345 });
    await expect(orch.executeAction('mouse_move', { x: 1, y: 1 })).rejects.toMatchObject({ name: 'StaleStateError' });
  });

  it('sandbox mode skips secure-desktop check', async () => {
    const probe = new FakeProbe();
    probe.secure = true; // would normally pause
    const clock = new FakeClock();
    const safety = new FakeSafety();
    const input = new FakeInput();
    const orch = new Orchestrator({
      sessionId: 'sb-test3', safety: safety as never, input, screen: new FakeScreen(), probe, clock, sandboxMode: true,
    });
    orch.start({ targetWindow: 12345 });
    await orch.executeAction('mouse_move', { x: 1, y: 1 });
    expect(input.calls).toContain('move');
    expect(orch.isPaused()).toBe(false);
  });
});
