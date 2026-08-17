/**
 * Orchestrator (todo 10) — the auto-debug monitoring loop.
 *
 * While a debug session is ACTIVE, the orchestrator polls the session's target
 * window (title, rect, foreground status) every `pollIntervalMs`. When a
 * trigger fires (title change, rect change, foreground change, or — when
 * `pixelDiffThreshold > 0` — a screenshot-signature change), it captures a
 * fresh screenshot, builds a context object, and exposes it as the in-memory
 * latest context (read by the `debug://context` resource).
 *
 * The client (OpenCode) polls `debug://context`, decides an action, and calls
 * `execute_action`. The orchestrator NEVER decides actions itself — it only
 * executes client decisions. Every action passes through three gates before
 * injection:
 *   1. Governor      — cooldown (5s), rate limit (6/min), auto-pause after 3
 *                      consecutive failures, 30-minute session cap.
 *   2. Freshness     — re-capture + `GetForegroundWindow` check against the
 *                      session target; divergence → `StaleStateError`.
 *   3. Secure desktop— `OpenInputDesktop` vs the session input desktop;
 *                      divergence (UAC/lock) → pause + `SecureDesktopError`,
 *                      zero injection.
 *
 * Injection is dispatched to the `InputProvider` exclusively through the
 * safety manager's `injectGuarded`, which additionally enforces window scoping.
 *
 * State machine: IDLE → MONITORING → TRIGGERED → ACTING → COOLDOWN → MONITORING,
 * plus PAUSED as a guard state entered on auto-pause / secure desktop.
 */

import { createHash } from 'node:crypto';
import * as koffi from 'koffi';

import { logEntry } from './audit';
import type { InputProvider } from './platform/input';
import type { CaptureResult, ScreenProvider } from './platform/screen';
import type { SessionState } from './safety';

/** Tool name reported to the audit log. */
const TOOL_NAME = 'orchestrator';

// Default governor knobs.
const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_COOLDOWN_MS = 5000;
const DEFAULT_MAX_INTERVENTIONS_PER_MINUTE = 6;
const DEFAULT_SESSION_CAP_MS = 30 * 60 * 1000;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** The target window state diverged since the client's decision (freshness). */
export class StaleStateError extends Error {
  readonly code = 'STALE_STATE';
  constructor(message = 'target window state diverged since the decision') {
    super(message);
    this.name = 'StaleStateError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** An action was refused because the governor cooldown is still active. */
export class CooldownActiveError extends Error {
  readonly code = 'COOLDOWN_ACTIVE';
  constructor(remainingMs?: number) {
    super(
      remainingMs === undefined
        ? 'cooldown active'
        : `cooldown active (${remainingMs}ms remaining)`,
    );
    this.name = 'CooldownActiveError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** An action was refused because the interventions/minute cap is reached. */
export class RateLimitExceededError extends Error {
  readonly code = 'RATE_LIMIT_EXCEEDED';
  constructor(message = 'intervention rate limit exceeded') {
    super(message);
    this.name = 'RateLimitExceededError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** An action was refused because the orchestrator is paused. */
export class OrchestratorPausedError extends Error {
  readonly code = 'ORCHESTRATOR_PAUSED';
  constructor(reason?: string) {
    super(reason ? `orchestrator paused: ${reason}` : 'orchestrator paused');
    this.name = 'OrchestratorPausedError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** An action was refused because the secure desktop is active (UAC/lock). */
export class SecureDesktopError extends Error {
  readonly code = 'SECURE_DESKTOP';
  constructor(message = 'secure desktop active; injection refused') {
    super(message);
    this.name = 'SecureDesktopError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** An unknown action name or malformed params were supplied. */
export class InvalidActionError extends Error {
  readonly code = 'INVALID_ACTION';
  constructor(message: string) {
    super(message);
    this.name = 'InvalidActionError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** `executeAction` was called while the orchestrator is not monitoring. */
export class NotMonitoringError extends Error {
  readonly code = 'NOT_MONITORING';
  constructor(message = 'orchestrator is not monitoring') {
    super(message);
    this.name = 'NotMonitoringError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OrchestratorState =
  | 'IDLE'
  | 'MONITORING'
  | 'TRIGGERED'
  | 'ACTING'
  | 'COOLDOWN'
  | 'PAUSED';

export type TriggerReason = 'title' | 'foreground' | 'rect' | 'pixel';

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Injected Win32 surface for window state + secure-desktop detection. */
export interface WindowProbe {
  getWindowText(hwnd: number): string;
  getWindowRect(hwnd: number): Rect | null;
  getForegroundWindow(): number;
  isSecureDesktop(): boolean;
}

/** Injected time/timer surface so governor timing is deterministic in tests. */
export interface Clock {
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** The subset of `DebugSessionManager` the orchestrator depends on. */
export interface SafetyGate {
  readonly state: SessionState;
  injectGuarded<T>(action: () => T | Promise<T>): Promise<T>;
  setTargetWindow(hwnd: number): void;
}

export interface ScreenshotMeta {
  width: number;
  height: number;
  size: number;
  base64: string;
}

export interface DebugContext {
  status: OrchestratorState;
  sessionState: SessionState;
  target: { hwnd: number; title: string; foreground: boolean };
  trigger: TriggerReason | null;
  screenshot: ScreenshotMeta | null;
  interventions: number;
  consecutiveFailures: number;
  paused: boolean;
  pauseReason: string | null;
  secureDesktop: boolean;
  lastActionAt: number | null;
  sessionStartedAt: number | null;
  timestamp: number;
}

export interface OrchestratorEvent {
  type: 'trigger' | 'pause' | 'secure_desktop' | 'session_end';
  reason?: string;
  state: OrchestratorState;
}

export interface OrchestratorOptions {
  sessionId: string;
  safety: SafetyGate;
  input: InputProvider;
  screen: ScreenProvider;
  probe: WindowProbe;
  clock?: Clock;
  pollIntervalMs?: number;
  /** > 0 enables the pixel-diff trigger (PNG-signature change). */
  pixelDiffThreshold?: number;
  cooldownMs?: number;
  maxInterventionsPerMinute?: number;
  sessionCapMs?: number;
  maxConsecutiveFailures?: number;
  onNotify?: (event: OrchestratorEvent) => void;
}

// ---------------------------------------------------------------------------
// Real Win32 probe (koffi → user32) — lazily initialized
// ---------------------------------------------------------------------------

function createRealWindowProbe(): WindowProbe {
  const user32 = koffi.load('user32.dll');
  const GetWindowTextW = user32.func('int32 GetWindowTextW(void *hWnd, void *lpString, int32 nMaxCount)');
  const GetWindowRect = user32.func('bool GetWindowRect(void *hWnd, void *lpRect)');
  const GetForegroundWindow = user32.func('void * GetForegroundWindow()');
  const OpenInputDesktop = user32.func(
    'void * OpenInputDesktop(uint32 dwFlags, bool fInherit, uint32 dwDesiredAccess)',
  );
  const CloseDesktop = user32.func('bool CloseDesktop(void *hDesktop)');

  const DESKTOP_READOBJECTS = 0x0001;
  // Baseline: the input desktop the process started on.
  const sessionDesktop = OpenInputDesktop(0, false, DESKTOP_READOBJECTS);

  return {
    getWindowText(hwnd: number): string {
      const buf = Buffer.alloc(2048); // 1024 UTF-16 code units
      const len = GetWindowTextW(BigInt(hwnd), buf, 1024);
      return buf.toString('utf16le', 0, Math.max(0, len) * 2);
    },
    getWindowRect(hwnd: number): Rect | null {
      const buf = Buffer.alloc(16); // RECT { left,top,right,bottom:int32 }
      if (!GetWindowRect(BigInt(hwnd), buf)) return null;
      return {
        left: buf.readInt32LE(0),
        top: buf.readInt32LE(4),
        right: buf.readInt32LE(8),
        bottom: buf.readInt32LE(12),
      };
    },
    getForegroundWindow(): number {
      return Number(GetForegroundWindow());
    },
    isSecureDesktop(): boolean {
      const now = OpenInputDesktop(0, false, DESKTOP_READOBJECTS);
      if (now === null) return true; // cannot read the input desktop → fail closed
      const secure = now !== sessionDesktop;
      CloseDesktop(now);
      return secure;
    },
  };
}

function realClock(): Clock {
  return {
    now: () => Date.now(),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  };
}

function errorMessage(err: unknown): string {
  if (err !== null && typeof err === 'object') {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(err);
}

function signature(buffer: Buffer): string {
  return createHash('sha1').update(buffer).digest('hex');
}

function rectEquals(a: Rect | null, b: Rect | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new InvalidActionError(`field '${field}' must be a number`);
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new InvalidActionError(`field '${field}' must be a string`);
  }
  return value;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new InvalidActionError(`field '${field}' must be a string array`);
  }
  return value as string[];
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export class Orchestrator {
  private readonly sessionId: string;
  private readonly safety: SafetyGate;
  private readonly input: InputProvider;
  private readonly screen: ScreenProvider;
  private readonly probe: WindowProbe;
  private readonly clock: Clock;
  private readonly pollIntervalMs: number;
  private readonly pixelDiffThreshold: number;
  private readonly cooldownMs: number;
  private readonly maxInterventionsPerMinute: number;
  private readonly sessionCapMs: number;
  private readonly maxConsecutiveFailures: number;
  private readonly onNotify: ((event: OrchestratorEvent) => void) | undefined;

  private _state: OrchestratorState = 'IDLE';
  private targetHwnd: number | null = null;
  private lastTitle: string | null = null;
  private lastRect: Rect | null = null;
  private lastForeground: boolean | null = null;
  private lastSignature: string | null = null;
  private sessionStartedAt: number | null = null;
  private pollTimer: unknown = null;
  private cooldownTimer: unknown = null;
  private actionTimestamps: number[] = [];
  private lastActionAt: number | null = null;
  private interventions = 0;
  private consecutiveFailures = 0;
  private paused = false;
  private pauseReason: string | null = null;
  private lastTriggerReason: TriggerReason | null = null;
  private lastScreenshot: ScreenshotMeta | null = null;
  private latestContext: DebugContext;

  constructor(options: OrchestratorOptions) {
    this.sessionId = options.sessionId;
    this.safety = options.safety;
    this.input = options.input;
    this.screen = options.screen;
    this.probe = options.probe;
    this.clock = options.clock ?? realClock();
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.pixelDiffThreshold = options.pixelDiffThreshold ?? 0;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.maxInterventionsPerMinute =
      options.maxInterventionsPerMinute ?? DEFAULT_MAX_INTERVENTIONS_PER_MINUTE;
    this.sessionCapMs = options.sessionCapMs ?? DEFAULT_SESSION_CAP_MS;
    this.maxConsecutiveFailures =
      options.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
    this.onNotify = options.onNotify;
    this.latestContext = this.buildContext();
  }

  get state(): OrchestratorState {
    return this._state;
  }

  /** The latest context object (read by the `debug://context` resource). */
  getContext(): DebugContext {
    return this.latestContext;
  }

  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Begin monitoring the target window. Defaults to the current foreground
   * window; pass `targetWindow` to pin a specific handle.
   *
   * @throws NotMonitoringError if no target window can be resolved.
   */
  start(options: { targetWindow?: number } = {}): void {
    if (this._state !== 'IDLE') {
      throw new NotMonitoringError('orchestrator is already running');
    }
    const target = options.targetWindow ?? this.probe.getForegroundWindow();
    if (target === 0) {
      this.log('start', { error: 'no target window' }, false);
      throw new NotMonitoringError('no target window (foreground is 0)');
    }

    this.targetHwnd = target;
    this.safety.setTargetWindow(target);
    this.lastTitle = this.probe.getWindowText(target);
    this.lastRect = this.probe.getWindowRect(target);
    this.lastForeground = this.probe.getForegroundWindow() === target;
    this.lastSignature = null;
    this.sessionStartedAt = this.clock.now();
    this.actionTimestamps = [];
    this.lastActionAt = null;
    this.interventions = 0;
    this.consecutiveFailures = 0;
    this.paused = false;
    this.pauseReason = null;
    this.lastTriggerReason = null;
    this.lastScreenshot = null;

    this.transition('MONITORING');
    this.log('start', { targetWindow: target, title: this.lastTitle }, true);
    this.pollTimer = this.clock.setInterval(() => {
      void this.poll();
    }, this.pollIntervalMs);
  }

  /** Stop monitoring and clear all timers (idempotent). */
  stop(): void {
    this.stopPolling();
    this.clearCooldown();
    if (this._state !== 'IDLE') this.transition('IDLE');
  }

  /**
   * Execute a client-decided action within the active session.
   *
   * Gates, in order: not-started / paused → cooldown → rate limit → secure
   * desktop → freshness (re-capture + foreground check) → `injectGuarded`.
   *
   * @throws NotMonitoringError, OrchestratorPausedError, CooldownActiveError,
   *         RateLimitExceededError, SecureDesktopError, StaleStateError,
   *         InvalidActionError, or the injected action's own error.
   */
  async executeAction(action: string, params: Record<string, unknown> = {}): Promise<void> {
    if (this._state === 'IDLE' || this.targetHwnd === null) {
      this.log('execute_action', { action, error: 'NotMonitoringError' }, false);
      throw new NotMonitoringError();
    }
    if (this.paused) {
      this.log(
        'execute_action',
        { action, error: 'OrchestratorPausedError', reason: this.pauseReason },
        false,
      );
      throw new OrchestratorPausedError(this.pauseReason ?? undefined);
    }

    // Parse/validate the action up front (fail fast; not an intervention failure).
    const run = this.buildAction(action, params);

    const now = this.clock.now();

    if (this.lastActionAt !== null && now - this.lastActionAt < this.cooldownMs) {
      const remaining = this.cooldownMs - (now - this.lastActionAt);
      this.log('execute_action', { action, error: 'CooldownActiveError', remainingMs: remaining }, false);
      throw new CooldownActiveError(remaining);
    }

    this.pruneActionTimestamps(now);
    if (this.actionTimestamps.length >= this.maxInterventionsPerMinute) {
      this.log('execute_action', { action, error: 'RateLimitExceededError' }, false);
      throw new RateLimitExceededError();
    }

    if (this.probe.isSecureDesktop()) {
      this.pause('secure_desktop');
      this.log('execute_action', { action, error: 'SecureDesktopError' }, false);
      throw new SecureDesktopError();
    }

    // Freshness gate: re-capture + foreground check against the session target.
    const target = this.targetHwnd;
    await this.captureFresh();
    if (this.probe.getForegroundWindow() !== target) {
      this.recordFailure();
      if (!this.paused) this.transition('MONITORING');
      this.log(
        'execute_action',
        { action, error: 'StaleStateError', foreground: this.probe.getForegroundWindow(), target },
        false,
      );
      throw new StaleStateError();
    }

    this.transition('ACTING');
    try {
      await this.safety.injectGuarded(run);
      this.interventions += 1;
      this.consecutiveFailures = 0;
      this.lastActionAt = now;
      this.actionTimestamps.push(now);
      this.log('execute_action', { action }, true);
      this.transition('COOLDOWN');
      this.scheduleCooldown();
    } catch (err) {
      this.recordFailure();
      if (!this.paused) this.transition('MONITORING');
      this.log('execute_action', { action, error: errorMessage(err) }, false);
      throw err;
    }
  }

  // -- internals -------------------------------------------------------------

  private async poll(): Promise<void> {
    if (this._state !== 'MONITORING' && this._state !== 'TRIGGERED') return;
    const target = this.targetHwnd;
    if (target === null) return;

    if (this.sessionStartedAt !== null && this.clock.now() - this.sessionStartedAt >= this.sessionCapMs) {
      await this.endSession('session_cap');
      return;
    }

    if (this.probe.isSecureDesktop()) {
      this.pause('secure_desktop');
      return;
    }

    const title = this.probe.getWindowText(target);
    const rect = this.probe.getWindowRect(target);
    const foreground = this.probe.getForegroundWindow() === target;

    const reasons: TriggerReason[] = [];
    if (title !== this.lastTitle) reasons.push('title');
    if (!rectEquals(rect, this.lastRect)) reasons.push('rect');
    if (foreground !== this.lastForeground) reasons.push('foreground');

    if (this.pixelDiffThreshold > 0) {
      const sig = await this.captureSignature();
      if (this.lastSignature !== null && sig !== null && sig !== this.lastSignature) {
        reasons.push('pixel');
      }
      if (sig !== null) this.lastSignature = sig;
    }

    this.lastTitle = title;
    this.lastRect = rect;
    this.lastForeground = foreground;

    if (reasons.length > 0 && this._state === 'MONITORING') {
      await this.fireTrigger(reasons[0]);
    } else if (this._state === 'TRIGGERED') {
      this.transition('MONITORING');
    }
    this.refreshContext();
  }

  private async fireTrigger(reason: TriggerReason): Promise<void> {
    this.lastTriggerReason = reason;
    this.transition('TRIGGERED');
    await this.captureFresh();
    this.notify({ type: 'trigger', reason, state: this._state });
    this.log('trigger', { reason }, true);
  }

  private async capture(): Promise<CaptureResult | null> {
    const target = this.targetHwnd;
    if (target === null) return null;
    const title = this.probe.getWindowText(target);
    try {
      return await this.screen.captureWindow(title);
    } catch {
      return null;
    }
  }

  private async captureSignature(): Promise<string | null> {
    const result = await this.capture();
    return result ? signature(result.png) : null;
  }

  private async captureFresh(): Promise<void> {
    const result = await this.capture();
    this.lastScreenshot = result
      ? {
          width: result.width,
          height: result.height,
          size: result.png.length,
          base64: result.png.toString('base64'),
        }
      : null;
    this.refreshContext();
  }

  private buildAction(action: string, params: Record<string, unknown>): () => Promise<void> {
    switch (action) {
      case 'mouse_click': {
        const x = requireNumber(params.x, 'x');
        const y = requireNumber(params.y, 'y');
        const button = requireString(params.button, 'button');
        return () => this.input.mouseClick(x, y, button);
      }
      case 'mouse_move': {
        const x = requireNumber(params.x, 'x');
        const y = requireNumber(params.y, 'y');
        return () => this.input.mouseMove(x, y);
      }
      case 'key_press': {
        const key = requireString(params.key, 'key');
        const modifiers = requireStringArray(params.modifiers, 'modifiers');
        return () => this.input.keyPress(key, modifiers);
      }
      case 'type_text': {
        const text = requireString(params.text, 'text');
        return () => this.input.typeText(text);
      }
      default:
        throw new InvalidActionError(`unknown action: ${JSON.stringify(action)}`);
    }
  }

  private pruneActionTimestamps(now: number): void {
    const windowStart = now - RATE_LIMIT_WINDOW_MS;
    this.actionTimestamps = this.actionTimestamps.filter((t) => t > windowStart);
  }

  private recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      this.pause('consecutive_failures');
    }
    this.refreshContext();
  }

  private pause(reason: string): void {
    if (this.paused) return;
    this.paused = true;
    this.pauseReason = reason;
    this.transition('PAUSED');
    this.stopPolling();
    this.notify({ type: 'pause', reason, state: this._state });
    this.log('pause', { reason }, true);
  }

  private async endSession(reason: string): Promise<void> {
    this.stopPolling();
    this.clearCooldown();
    this.transition('IDLE');
    this.notify({ type: 'session_end', reason, state: this._state });
    this.log('session_end', { reason }, true);
  }

  private scheduleCooldown(): void {
    this.clearCooldown();
    this.cooldownTimer = this.clock.setTimeout(() => {
      this.cooldownTimer = null;
      if (this._state === 'COOLDOWN') this.transition('MONITORING');
    }, this.cooldownMs);
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      this.clock.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private clearCooldown(): void {
    if (this.cooldownTimer !== null) {
      this.clock.clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
  }

  private transition(next: OrchestratorState): void {
    const from = this._state;
    if (from === next) return;
    this._state = next;
    this.log('state', { from, to: next }, true);
    this.refreshContext();
  }

  private refreshContext(): void {
    this.latestContext = this.buildContext();
  }

  private buildContext(): DebugContext {
    const target = this.targetHwnd;
    const foreground = target !== null && this.probe.getForegroundWindow() === target;
    return {
      status: this._state,
      sessionState: this.safety.state,
      target: {
        hwnd: target ?? 0,
        title: target !== null ? this.probe.getWindowText(target) : '',
        foreground,
      },
      trigger: this.lastTriggerReason,
      screenshot: this.lastScreenshot,
      interventions: this.interventions,
      consecutiveFailures: this.consecutiveFailures,
      paused: this.paused,
      pauseReason: this.pauseReason,
      secureDesktop: this.probe.isSecureDesktop(),
      lastActionAt: this.lastActionAt,
      sessionStartedAt: this.sessionStartedAt,
      timestamp: this.clock.now(),
    };
  }

  private notify(event: OrchestratorEvent): void {
    this.onNotify?.(event);
  }

  private log(action: string, details: Record<string, unknown>, success: boolean): void {
    logEntry(this.sessionId, TOOL_NAME, action, details, success);
  }
}

export { createRealWindowProbe };
