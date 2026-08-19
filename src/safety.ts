/**
 * DebugSessionManager — the safety abort layer (todo 8).
 *
 * Owns the debug-session lifecycle and is the single point of enforcement for
 * window-scoped input injection. It bridges the platform-neutral
 * `SafetyProvider` contract — backed in v1 by the native watchdog over a
 * named pipe (`WatchdogClient`, src/ipc.ts) — with the input layer: every
 * injection must pass through `injectGuarded`, which refuses to run unless a
 * session is ACTIVE and the cursor + keyboard focus are inside the session's
 * target window.
 *
 * State machine: IDLE → STARTING → ACTIVE → STOPPING → IDLE.
 *   - IDLE:     no session; `injectGuarded` / `endDebugSession` throw
 *               `NoActiveSessionError`.
 *   - STARTING: watchdog spawned/attached, regions being registered.
 *   - ACTIVE:   heartbeat flowing; injection permitted (window-scoped).
 *   - STOPPING: shutdown/kill in progress; injection refused.
 *
 * Every state transition and every inject decision is audited via `logEntry`
 * (tool name `safety`). Held modifiers are released through the injected
 * `releaseModifiers` hook on teardown (the native watchdog additionally
 * unhooks and releases keys on its own dead-man switch).
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as koffi from 'koffi';

import { logEntry } from './audit';
import { WatchdogClient, generateToken } from './ipc';
import type { Region, SafetyStatus } from './platform/safety';

export type { Region, SafetyStatus } from './platform/safety';

/** Tool name reported to the audit log. */
const TOOL_NAME = 'safety';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A session cannot start without at least one protected abort region. */
export class AbortButtonsRequiredError extends Error {
  readonly code = 'ABORT_BUTTONS_REQUIRED';
  constructor() {
    super('at least one protected abort region is required to start a debug session');
    this.name = 'AbortButtonsRequiredError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The watchdog needs elevation but could not be elevated (UAC declined/absent). */
export class ElevationRequiredError extends Error {
  readonly code = 'ELEVATION_REQUIRED';
  constructor(message = 'the safety watchdog requires administrator elevation') {
    super(message);
    this.name = 'ElevationRequiredError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Input was refused because cursor/focus is outside the session target window. */
export class WindowScopeViolationError extends Error {
  readonly code = 'WINDOW_SCOPE_VIOLATION';
  constructor(message = 'input refused: cursor or keyboard focus is outside the target window') {
    super(message);
    this.name = 'WindowScopeViolationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** An input tool was called while no debug session is ACTIVE. */
export class NoActiveSessionError extends Error {
  readonly code = 'NO_ACTIVE_SESSION';
  constructor(message = 'no active debug session') {
    super(message);
    this.name = 'NoActiveSessionError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SessionState = 'IDLE' | 'STARTING' | 'ACTIVE' | 'STOPPING';

/** Opaque handle identifying a started debug session. */
export interface DebugSessionHandle {
  readonly id: string;
  readonly token: string;
  readonly regions: readonly Region[];
}

/** A spawned watchdog process: hard-kill plus an exit notification. */
export interface SpawnedProcess {
  readonly pid: number;
  kill(): void;
  exited: Promise<void>;
}

/** The subset of `WatchdogClient` the manager depends on (structural). */
export interface WatchdogClientLike {
  connect(): Promise<void>;
  registerRegions(regions: Region[]): Promise<void>;
  heartbeat(): Promise<void>;
  status(): Promise<SafetyStatus>;
  shutdown(): Promise<void>;
  close(): void;
}

/** Creates a client for the given pipe/token; injectable for tests. */
export type ClientFactory = (pipeId: string, token: string) => WatchdogClientLike;

/**
 * Spawns (or locates) the watchdog for a session. Returns `null` to signal the
 * pre-started-admin fallback: an already-running elevated watchdog is assumed
 * to be listening on the session's named pipe, and the manager connects to it
 * without spawning. Throws `ElevationRequiredError` when elevation is required
 * but unavailable.
 */
export type SpawnWatchdogFn = (
  args: { pipeId: string; token: string },
) => Promise<SpawnedProcess | null>;

/** Injectable Win32 surface used by the window-scoping gate. */
export interface WindowDeps {
  getForegroundWindow(): number;
  getCursorPos(): { x: number; y: number };
  getWindowRect(
    hwnd: number,
  ): { left: number; top: number; right: number; bottom: number } | null;
}

export interface SandboxGate {
  isWindow(hwnd: number): boolean;
  getThreadDesktop(hwnd: number): unknown;
}

export interface DebugSessionManagerOptions {
  /** The MCP session id (also used as the watchdog named-pipe id). */
  sessionId: string;
  /** Client factory seam; defaults to a real `WatchdogClient`. */
  clientFactory?: ClientFactory;
  /** Spawn seam; defaults to `child_process.spawn` of the watchdog exe. */
  spawnWatchdog?: SpawnWatchdogFn;
  /** Win32 seam for the window-scoping gate; defaults to koffi user32. */
  win32?: WindowDeps;
  /** Sandbox gate seam; defaults to koffi user32 IsWindow+GetThreadDesktop. */
  sandboxGate?: SandboxGate;
  /** Releases any held modifiers on teardown; defaults to a no-op. */
  releaseModifiers?: () => void | Promise<void>;
  /** Heartbeat interval in ms (default 1000). */
  heartbeatIntervalMs?: number;
  /** Grace period (ms) to wait for a graceful shutdown before hard-killing. */
  killGraceMs?: number;
  /** Absolute path to watchdog.exe (defaults to <cwd>/src/watchdog/watchdog.exe). */
  watchdogExePath?: string;
  /** Fired on every state transition (useful for tests and orchestration). */
  onStateChange?: (from: SessionState, to: SessionState) => void;
}

// ---------------------------------------------------------------------------
// Real Win32 deps (koffi → user32) — lazily initialized
// ---------------------------------------------------------------------------

interface RealWindowDepsContext {
  deps: WindowDeps;
}

let realWindowDepsContext: RealWindowDepsContext | undefined;

function createRealWindowDeps(): WindowDeps {
  const user32 = koffi.load('user32.dll');
  const GetForegroundWindow = user32.func('void * GetForegroundWindow()');
  // Scalar/struct out-params use a Buffer (koffi struct types are not
  // JS-constructable — same pattern as GetDpiForMonitor in src/input.ts).
  const GetCursorPos = user32.func('bool GetCursorPos(void *lpPoint)');
  const GetWindowRect = user32.func('bool GetWindowRect(void *hWnd, void *lpRect)');

  return {
    getForegroundWindow(): number {
      return Number(GetForegroundWindow());
    },
    getCursorPos(): { x: number; y: number } {
      const buf = Buffer.alloc(8); // POINT { x:int32, y:int32 }
      if (!GetCursorPos(buf)) throw new Error('GetCursorPos failed');
      return { x: buf.readInt32LE(0), y: buf.readInt32LE(4) };
    },
    getWindowRect(hwnd: number) {
      const buf = Buffer.alloc(16); // RECT { left,top,right,bottom:int32 }
      if (!GetWindowRect(BigInt(hwnd), buf)) return null;
      return {
        left: buf.readInt32LE(0),
        top: buf.readInt32LE(4),
        right: buf.readInt32LE(8),
        bottom: buf.readInt32LE(12),
      };
    },
  };
}

function ensureRealWindowDeps(): WindowDeps {
  if (!realWindowDepsContext) {
    realWindowDepsContext = { deps: createRealWindowDeps() };
  }
  return realWindowDepsContext.deps;
}

// ---------------------------------------------------------------------------
// Sandbox-aware hwnd-validity gate (koffi → user32)
// ---------------------------------------------------------------------------

let sandboxGateContext: { isWindow: (hwnd: number) => boolean; getThreadDesktop: (hwnd: number) => unknown } | undefined;

function ensureSandboxGate(): { isWindow: (hwnd: number) => boolean; getThreadDesktop: (hwnd: number) => unknown } {
  if (!sandboxGateContext) {
    const user32 = koffi.load('user32.dll');
    const IsWindow = user32.func('bool IsWindow(void *hWnd)');
    const GetWindowThreadProcessId = user32.func('uint32 GetWindowThreadProcessId(void *hWnd, void *lpdwProcessId)');
    const GetThreadDesktop = user32.func('void * GetThreadDesktop(uint32 dwThreadId)');
    sandboxGateContext = {
      isWindow(hwnd: number): boolean {
        return IsWindow(BigInt(hwnd));
      },
      getThreadDesktop(hwnd: number): unknown {
        const pidBuf = Buffer.alloc(4);
        const threadId = GetWindowThreadProcessId(BigInt(hwnd), pidBuf);
        return GetThreadDesktop(threadId);
      },
    };
  }
  return sandboxGateContext;
}

// ---------------------------------------------------------------------------
// Real spawn (child_process) + elevation stub
// ---------------------------------------------------------------------------

/**
 * Default (NON-elevated) spawn. `child_process.spawn` cannot request UAC
 * elevation, so this is only correct when the watchdog is pre-started as admin
 * (pre-started fallback) or on a machine where hooks need no elevation. The
 * watchdog itself refuses non-admin runs with `ERROR_ACCESS_DENIED` (exit 1),
 * which the manager observes as a watchdog-down transition.
 */
function defaultSpawnWatchdog(exePath: string): SpawnWatchdogFn {
  return async ({ pipeId, token }) => {
    const child = spawn(exePath, ['--pipe-id', pipeId], {
      env: { ...process.env, WATCHDOG_TOKEN: token },
      stdio: 'ignore',
      windowsHide: true,
    });
    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.once('error', () => resolve());
    });
    return {
      pid: child.pid ?? -1,
      kill() {
        try {
          child.kill('SIGKILL');
        } catch {
          // best effort
        }
      },
      exited,
    };
  };
}

function defaultWatchdogExePath(): string {
  // The server runs from the project root (`node ./dist/index.js`), where the
  // in-place-built watchdog lives under src/watchdog/watchdog.exe.
  return path.join(process.cwd(), 'src', 'watchdog', 'watchdog.exe');
}

function defaultClientFactory(): ClientFactory {
  return (pipeId, token) => new WatchdogClient({ pipeId, token, connectTimeoutMs: 10000 });
}

function errorMessage(err: unknown): string {
  if (err !== null && typeof err === 'object') {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

interface ActiveSession {
  handle: DebugSessionHandle;
  client: WatchdogClientLike;
  proc: SpawnedProcess | null;
  targetWindow: number | null;
  /** When true, injectGuarded uses hwnd-validity gate instead of cursorAndFocusInside. */
  sandboxMode: boolean;
  /** Private desktop handle for sandbox desktop-membership check. */
  sandboxDesktopHandle: unknown;
}

export class DebugSessionManager {
  private readonly sessionId: string;
  private readonly clientFactory: ClientFactory;
  private readonly spawnWatchdog: SpawnWatchdogFn;
  private readonly win32: WindowDeps;
  private readonly sandboxGate: SandboxGate;
  private readonly releaseModifiers: () => void | Promise<void>;
  private readonly heartbeatIntervalMs: number;
  private readonly killGraceMs: number;
  private readonly onStateChange: ((from: SessionState, to: SessionState) => void) | undefined;

  private _state: SessionState = 'IDLE';
  private active: ActiveSession | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(options: DebugSessionManagerOptions) {
    this.sessionId = options.sessionId;
    this.clientFactory = options.clientFactory ?? defaultClientFactory();
    this.spawnWatchdog =
      options.spawnWatchdog ?? defaultSpawnWatchdog(options.watchdogExePath ?? defaultWatchdogExePath());
    this.win32 = options.win32 ?? ensureRealWindowDeps();
    this.sandboxGate = options.sandboxGate ?? ensureSandboxGate();
    this.releaseModifiers = options.releaseModifiers ?? (() => {});
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 1000;
    this.killGraceMs = options.killGraceMs ?? 1000;
    this.onStateChange = options.onStateChange;
  }

  get state(): SessionState {
    return this._state;
  }

  /**
   * Elevation hook — NOT wired in this todo.
   *
   * The watchdog's global low-level hooks require an elevated process, and
   * `child_process.spawn` cannot request UAC elevation. The production path
   * must spawn via `ShellExecuteExW(..., "runas", ...)` (koffi `shell32.dll`,
   * `SEE_MASK_NOCLOSEPROCESS`) so Windows shows the UAC prompt; on
   * `ERROR_CANCELLED` (1223) or `ERROR_ELEVATION_REQUIRED` (740) it must
   * throw `ElevationRequiredError`. Until then this stub always throws, and
   * the pre-started-admin fallback (an already-running elevated watchdog on
   * the session's named pipe) is used instead.
   */
  async spawnElevated(_args: { pipeId: string; token: string }): Promise<SpawnedProcess> {
    throw new ElevationRequiredError(
      'ShellExecuteExW(runas) elevation is not wired in this build; pre-start the watchdog as admin instead',
    );
  }

  /**
   * Start a debug session: validate ≥1 region, spawn/attach the watchdog,
   * register every region, start the 1s heartbeat loop, and return a handle.
   *
   * @throws AbortButtonsRequiredError if `regions` is empty.
   * @throws NoActiveSessionError if a session is already in progress.
   * @throws ElevationRequiredError (or the spawn error) if the watchdog cannot
   *         be spawned or reached.
   */
  async startDebugSession(regions: Region[]): Promise<DebugSessionHandle> {
    if (regions.length === 0) {
      this.log('start_debug_session', { regions: 0, error: 'AbortButtonsRequiredError' }, false);
      throw new AbortButtonsRequiredError();
    }
    if (this._state !== 'IDLE') {
      this.log('start_debug_session', { regions: regions.length, error: 'NoActiveSessionError' }, false);
      throw new NoActiveSessionError('a debug session is already in progress');
    }

    this.transition('STARTING');
    const token = generateToken();
    const pipeId = this.sessionId;
    const handle: DebugSessionHandle = { id: pipeId, token, regions: [...regions] };

    let proc: SpawnedProcess | null = null;
    let client: WatchdogClientLike | null = null;
    try {
      proc = await this.spawnWatchdog({ pipeId, token });
      client = this.clientFactory(pipeId, token);
      if (proc === null) {
        // Pre-started-admin fallback: no process to watch, just connect.
        await client.connect();
      } else {
        // Race the connect against the watchdog's exit. A non-elevated watchdog
        // exits (ERROR_ACCESS_DENIED) before ever creating the named pipe, so
        // the raw connect() would otherwise fail with ENOENT after a 10s retry.
        await Promise.race([
          client.connect(),
          proc.exited.then(() => {
            throw new ElevationRequiredError(
              'watchdog exited before connecting; run OpenCode elevated or pre-start the watchdog as admin',
            );
          }),
        ]);
      }
      await client.registerRegions(regions);

      this.active = { handle, client, proc, targetWindow: null, sandboxMode: false, sandboxDesktopHandle: null };
      this.transition('ACTIVE');
      this.startHeartbeat();
      this.log(
        'start_debug_session',
        { regions: regions.length, spawned: proc !== null, pid: proc?.pid ?? null },
        true,
      );

      // Watch the process for an unexpected exit (pre-started watchdogs have
      // no proc and are monitored purely via the heartbeat).
      proc?.exited.then(() => this.handleWatchdogDown('watchdog process exited')).catch(() =>
        this.handleWatchdogDown('watchdog process exited'),
      );
      return handle;
    } catch (err) {
      if (client) {
        try {
          client.close();
        } catch {
          // best effort
        }
      }
      if (proc) {
        try {
          proc.kill();
        } catch {
          // best effort
        }
      }
      this.active = null;
      this.transition('IDLE');
      this.log('start_debug_session', { regions: regions.length, error: errorMessage(err) }, false);
      throw err;
    }
  }

  /**
   * End a debug session: graceful shutdown (hard-kill after the grace
   * period), stop the heartbeat, release held modifiers, and return to IDLE.
   */
  async endDebugSession(handle: DebugSessionHandle): Promise<void> {
    if (this._state === 'IDLE' || !this.active) {
      throw new NoActiveSessionError();
    }
    if (this.active.handle.id !== handle.id) {
      throw new NoActiveSessionError('unknown session handle');
    }
    await this.stopSession('user');
    this.log('end_debug_session', { id: handle.id }, true);
  }

  /** Force-stop any active session (idempotent; safe for process shutdown). */
  async dispose(): Promise<void> {
    if (this._state === 'IDLE') return;
    await this.stopSession('user');
  }

  /** Record the session's target window for the window-scoping gate. */
  setTargetWindow(hwnd: number): void {
    if (this.active) this.active.targetWindow = hwnd;
  }

  /** Enable sandbox mode for the active session: hwnd-validity gate replaces cursorAndFocusInside. */
  setSandboxMode(desktopHandle: unknown): void {
    if (this.active) {
      this.active.sandboxMode = true;
      this.active.sandboxDesktopHandle = desktopHandle;
    }
  }

  /**
   * Window-scoping gate: every input tool must route through here. Refuses
   * unless a session is ACTIVE and the cursor + keyboard focus are inside the
   * session's target window.
   *
   * @throws NoActiveSessionError if no session is ACTIVE.
   * @throws WindowScopeViolationError if no target window is set, the
   *         foreground window differs, or the cursor is outside its rect.
   */
  async injectGuarded<T>(action: () => T | Promise<T>): Promise<T> {
    const session = this.active;
    if (!session || this._state !== 'ACTIVE') {
      this.log('inject_guarded', { error: 'NoActiveSessionError' }, false);
      throw new NoActiveSessionError();
    }
    const target = session.targetWindow;
    if (target === null) {
      this.log('inject_guarded', { error: 'no target window' }, false);
      throw new WindowScopeViolationError('no target window registered for the active session');
    }
    // Sandbox mode: hwnd-validity gate (IsWindow + desktop membership),
    // NOT cursorAndFocusInside (which queries the Default desktop's foreground/cursor).
    if (session.sandboxMode) {
      if (!this.hwndIsValidOnDesktop(target, session.sandboxDesktopHandle)) {
        this.log('inject_guarded', { targetWindow: target, error: 'WindowScopeViolationError', sandboxMode: true }, false);
        throw new WindowScopeViolationError('sandbox target window is invalid or not on the private desktop');
      }
    } else {
      if (!this.cursorAndFocusInside(target)) {
        this.log('inject_guarded', { targetWindow: target, error: 'WindowScopeViolationError' }, false);
        throw new WindowScopeViolationError();
      }
    }
    try {
      const result = await action();
      this.log('inject_guarded', { targetWindow: target }, true);
      return result;
    } catch (err) {
      this.log('inject_guarded', { targetWindow: target, error: errorMessage(err) }, false);
      throw err;
    }
  }

  // -- internals -------------------------------------------------------------

  private cursorAndFocusInside(target: number): boolean {
    if (this.win32.getForegroundWindow() !== target) return false;
    const rect = this.win32.getWindowRect(target);
    if (!rect) return false;
    const cursor = this.win32.getCursorPos();
    return (
      cursor.x >= rect.left &&
      cursor.x <= rect.right &&
      cursor.y >= rect.top &&
      cursor.y <= rect.bottom
    );
  }

  private hwndIsValidOnDesktop(target: number, desktopHandle: unknown): boolean {
    const gate = this.sandboxGate;
    if (!gate.isWindow(target)) return false;
    if (desktopHandle === null || desktopHandle === undefined) return true; // no desktop check if handle not set
    const threadDesktop = gate.getThreadDesktop(target);
    return threadDesktop === desktopHandle;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeatTick();
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async heartbeatTick(): Promise<void> {
    const session = this.active;
    if (!session || this._state !== 'ACTIVE') return;
    try {
      await session.client.heartbeat();
    } catch (err) {
      this.log('heartbeat', { error: errorMessage(err) }, false);
      this.handleWatchdogDown('heartbeat failed');
    }
  }

  private handleWatchdogDown(reason: string): void {
    if (this._state !== 'ACTIVE' && this._state !== 'STARTING') return;
    this.log('watchdog_down', { reason }, false);
    void this.stopSession('watchdog_down');
  }

  private async stopSession(kind: 'user' | 'watchdog_down'): Promise<void> {
    if (this._state === 'IDLE') return;
    this.transition('STOPPING');
    this.stopHeartbeat();

    const session = this.active;
    this.active = null;

    if (session) {
      const { client, proc } = session;
      if (kind === 'user') {
        await this.gracefulShutdown(client, proc);
      }
      if (proc) {
        try {
          proc.kill();
        } catch {
          // best effort
        }
      }
      try {
        client.close();
      } catch {
        // best effort
      }
    }
    try {
      await this.releaseModifiers();
    } catch {
      // best effort
    }
    this.transition('IDLE');
  }

  private async gracefulShutdown(client: WatchdogClientLike, proc: SpawnedProcess | null): Promise<void> {
    let timedOut = false;
    await Promise.race([
      client.shutdown().catch(() => {}),
      sleep(this.killGraceMs).then(() => {
        timedOut = true;
      }),
    ]);
    if (timedOut && proc) {
      try {
        proc.kill();
      } catch {
        // best effort
      }
    }
  }

  private transition(next: SessionState): void {
    const from = this._state;
    if (from === next) return;
    this._state = next;
    this.log('state', { from, to: next }, true);
    this.onStateChange?.(from, next);
  }

  private log(action: string, details: Record<string, unknown>, success: boolean): void {
    logEntry(this.sessionId, TOOL_NAME, action, details, success);
  }
}
