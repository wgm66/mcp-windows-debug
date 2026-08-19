/**
 * DebugSessionManager (src/safety.ts) tests (TDD).
 *
 * Only PURE logic is exercised here — the state machine, the injectGuarded
 * window-scoping gate, error-class construction, and the watchdog-down
 * transition — via injectable seams (`clientFactory`, `spawnWatchdog`,
 * `win32`, `releaseModifiers`). A FAKE watchdog client and a FAKE spawn are
 * injected, so the suite runs with ZERO elevation and ZERO real process
 * spawn. The real ShellExecuteEx(runas) elevated-spawn path is not wired in
 * this todo; it is documented in `DebugSessionManager.spawnElevated` (stub
 * that throws `ElevationRequiredError`) and exercised only manually/CI.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  AbortButtonsRequiredError,
  DebugSessionManager,
  ElevationRequiredError,
  NoActiveSessionError,
  WindowScopeViolationError,
} from '../src/safety';
import type {
  ClientFactory,
  DebugSessionHandle,
  Region,
  SessionState,
  SpawnedProcess,
  SpawnWatchdogFn,
  WatchdogClientLike,
  WindowDeps,
} from '../src/safety';

jest.setTimeout(30000);

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeClient extends WatchdogClientLike {
  connected: boolean;
  regions: Region[];
  shutDown: boolean;
  closed: boolean;
  heartbeats: number;
  failHeartbeat: boolean;
  shutdownHang: boolean;
}

function makeClient(): FakeClient {
  return {
    connected: false,
    regions: [],
    shutDown: false,
    closed: false,
    heartbeats: 0,
    failHeartbeat: false,
    shutdownHang: false,
    async connect() {
      this.connected = true;
    },
    async registerRegions(regions: Region[]) {
      this.regions.push(...regions);
    },
    async heartbeat() {
      if (this.failHeartbeat) throw new Error('heartbeat failed (watchdog gone)');
      this.heartbeats += 1;
    },
    async status() {
      return { hooked: true, regions: this.regions.length };
    },
    async shutdown() {
      // A never-resolving promise simulates a hung watchdog without keeping
      // the event loop alive (no timer/handle), so Jest still exits cleanly.
      if (this.shutdownHang) return await new Promise<never>(() => {});
      this.shutDown = true;
    },
    close() {
      this.closed = true;
    },
  };
}

interface FakeProc extends SpawnedProcess {
  killed: boolean;
  resolveExit: () => void;
}

function makeProc(): FakeProc {
  let resolveExit: () => void = () => {};
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  return {
    pid: 4242,
    killed: false,
    kill() {
      this.killed = true;
      resolveExit();
    },
    exited,
    resolveExit: () => resolveExit(),
  };
}

function makeWin32(init: {
  fg?: number;
  cursor?: { x: number; y: number };
  rect?: { left: number; top: number; right: number; bottom: number } | null;
} = {}): { state: { fg: number; cursor: { x: number; y: number }; rect: { left: number; top: number; right: number; bottom: number } | null }; deps: WindowDeps } {
  const state = {
    fg: init.fg ?? 100,
    cursor: init.cursor ?? { x: 50, y: 50 },
    rect: init.rect === undefined ? { left: 0, top: 0, right: 200, bottom: 200 } : init.rect,
  };
  const deps: WindowDeps = {
    getForegroundWindow: () => state.fg,
    getCursorPos: () => state.cursor,
    getWindowRect: () => state.rect,
  };
  return { state, deps };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  manager: DebugSessionManager;
  client: FakeClient;
  proc: FakeProc;
  win32: { fg: number; cursor: { x: number; y: number }; rect: { left: number; top: number; right: number; bottom: number } | null };
  states: Array<[SessionState, SessionState]>;
  released: () => number;
}

let tempDirs: string[];
let logDir: string;
let sessionId: string;
const managers: DebugSessionManager[] = [];

function makeDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeManager(overrides: {
  clientFactory?: ClientFactory;
  spawnWatchdog?: SpawnWatchdogFn;
  win32?: WindowDeps;
  heartbeatIntervalMs?: number;
  killGraceMs?: number;
} = {}): Harness {
  const client = makeClient();
  const proc = makeProc();
  const win32 = makeWin32();
  const states: Array<[SessionState, SessionState]> = [];
  let releasedCount = 0;

  const manager = new DebugSessionManager({
    sessionId,
    clientFactory: () => client,
    spawnWatchdog: async () => proc,
    win32: overrides.win32 ?? win32.deps,
    releaseModifiers: () => {
      releasedCount += 1;
    },
    heartbeatIntervalMs: overrides.heartbeatIntervalMs ?? 20,
    killGraceMs: overrides.killGraceMs ?? 50,
    onStateChange: (from, to) => states.push([from, to]),
    ...(overrides.clientFactory ? { clientFactory: overrides.clientFactory } : {}),
    ...(overrides.spawnWatchdog ? { spawnWatchdog: overrides.spawnWatchdog } : {}),
  });
  managers.push(manager);

  return {
    manager,
    client,
    proc,
    win32: win32.state,
    states,
    released: () => releasedCount,
  };
}

interface AuditEntry {
  sessionId: string;
  toolName: string;
  action: string;
  details: Record<string, unknown>;
  success: boolean;
}

function readEntries(dir: string): AuditEntry[] {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ndjson'));
  const entries: AuditEntry[] = [];
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (line.trim().length === 0) continue;
      entries.push(JSON.parse(line) as AuditEntry);
    }
  }
  return entries;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('waitFor timed out');
}

function region(id = 'abort'): Region {
  return { x: 0, y: 0, w: 100, h: 100, id };
}

beforeEach(() => {
  tempDirs = [];
  logDir = makeDir('safety-audit-');
  sessionId = `sess-${Math.random().toString(36).slice(2)}`;
  process.env.AUDIT_LOG_DIR = logDir;
});

afterEach(async () => {
  delete process.env.AUDIT_LOG_DIR;
  for (const m of managers) {
    try {
      await m.dispose();
    } catch {
      // best-effort cleanup
    }
  }
  managers.length = 0;
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

describe('DebugSessionManager state machine', () => {
  it('starts IDLE, drives IDLE→STARTING→ACTIVE, and returns a handle', async () => {
    const { manager, client, proc } = makeManager();
    expect(manager.state).toBe('IDLE');

    const handle: DebugSessionHandle = await manager.startDebugSession([region()]);

    expect(manager.state).toBe('ACTIVE');
    expect(handle.id).toBe(sessionId);
    expect(handle.token).toMatch(/^[0-9a-f]{64}$/);
    expect(handle.regions).toEqual([region()]);
    expect(client.connected).toBe(true);
    expect(client.regions).toEqual([region()]);
    expect(proc.killed).toBe(false);

    await manager.endDebugSession(handle);
    expect(manager.state).toBe('IDLE');
  });

  it('traverses the full IDLE→STARTING→ACTIVE→STOPPING→IDLE cycle', async () => {
    const { manager, states } = makeManager();
    const handle = await manager.startDebugSession([region()]);
    await manager.endDebugSession(handle);
    expect(states.map(([f, t]) => `${f}→${t}`)).toEqual([
      'IDLE→STARTING',
      'STARTING→ACTIVE',
      'ACTIVE→STOPPING',
      'STOPPING→IDLE',
    ]);
  });

  it('registers every region and passes the token + pipe-id to spawn', async () => {
    const seen: Array<{ pipeId: string; token: string }> = [];
    const regions = [region('a'), region('b')];
    const { manager, client } = makeManager({
      spawnWatchdog: async (args) => {
        seen.push(args);
        return makeProc();
      },
    });
    const handle = await manager.startDebugSession(regions);
    expect(client.regions).toEqual(regions);
    expect(seen).toHaveLength(1);
    expect(seen[0].pipeId).toBe(sessionId);
    expect(seen[0].token).toBe(handle.token);
  });

  it('startDebugSession([]) throws AbortButtonsRequiredError and stays IDLE', async () => {
    const { manager } = makeManager();
    await expect(manager.startDebugSession([])).rejects.toBeInstanceOf(
      AbortButtonsRequiredError,
    );
    expect(manager.state).toBe('IDLE');
  });

  it('startDebugSession while a session is already running throws NoActiveSessionError', async () => {
    const { manager } = makeManager();
    await manager.startDebugSession([region()]);
    await expect(manager.startDebugSession([region()])).rejects.toBeInstanceOf(
      NoActiveSessionError,
    );
  });

  it('spawn failure with ElevationRequiredError leaves the manager IDLE', async () => {
    const { manager } = makeManager({
      spawnWatchdog: async () => {
        throw new ElevationRequiredError();
      },
    });
    await expect(manager.startDebugSession([region()])).rejects.toBeInstanceOf(
      ElevationRequiredError,
    );
    expect(manager.state).toBe('IDLE');
  });

  it('spawnElevated() is a documented stub that throws ElevationRequiredError', async () => {
    const { manager } = makeManager();
    await expect(
      manager.spawnElevated({ pipeId: 'x', token: 'y' }),
    ).rejects.toBeInstanceOf(ElevationRequiredError);
  });

  it('connects to a pre-started watchdog when spawnWatchdog returns null (fallback)', async () => {
    const { manager, client } = makeManager({
      spawnWatchdog: async () => null,
    });
    const handle = await manager.startDebugSession([region()]);
    expect(manager.state).toBe('ACTIVE');
    expect(client.connected).toBe(true);
    await manager.endDebugSession(handle);
    expect(manager.state).toBe('IDLE');
  });

  it('throws ElevationRequiredError when the watchdog exits before connecting', async () => {
    const { manager } = makeManager({
      // A non-elevated watchdog exits immediately (ERROR_ACCESS_DENIED) without
      // ever creating the named pipe.
      spawnWatchdog: async () => ({
        pid: -1,
        kill() {},
        exited: Promise.resolve(),
      }),
      clientFactory: () => ({
        // The raw pipe connect would fail with ENOENT after the watchdog is
        // gone; model it as a delayed rejection the exit race must beat.
        async connect() {
          await new Promise((r) => setTimeout(r, 100));
          throw new Error('pipe connect failed: connect ENOENT');
        },
        async registerRegions() {},
        async heartbeat() {},
        async status() {
          return { hooked: false, regions: 0 };
        },
        async shutdown() {},
        close() {},
      }),
    });
    await expect(
      manager.startDebugSession([{ x: 0, y: 0, w: 1, h: 1, id: 'r' }]),
    ).rejects.toBeInstanceOf(ElevationRequiredError);
    expect(manager.state).toBe('IDLE');
  });
});

// ---------------------------------------------------------------------------
// injectGuarded
// ---------------------------------------------------------------------------

describe('injectGuarded window-scoping gate', () => {
  it('rejects with NoActiveSessionError when no session is ACTIVE', async () => {
    const { manager } = makeManager();
    await expect(manager.injectGuarded(async () => {})).rejects.toBeInstanceOf(
      NoActiveSessionError,
    );
  });

  it('runs the action and returns its result when cursor+focus are inside the target', async () => {
    const { manager } = makeManager();
    await manager.startDebugSession([region()]);
    manager.setTargetWindow(100);
    let ran = false;
    const result = await manager.injectGuarded(async () => {
      ran = true;
      return 42;
    });
    expect(ran).toBe(true);
    expect(result).toBe(42);
  });

  it('rejects with WindowScopeViolationError when no target window is set', async () => {
    const { manager } = makeManager();
    await manager.startDebugSession([region()]);
    await expect(manager.injectGuarded(async () => {})).rejects.toBeInstanceOf(
      WindowScopeViolationError,
    );
  });

  it('rejects with WindowScopeViolationError when the foreground window differs', async () => {
    const { manager, win32 } = makeManager();
    await manager.startDebugSession([region()]);
    manager.setTargetWindow(100);
    win32.fg = 200; // focus moved to another window
    await expect(manager.injectGuarded(async () => {})).rejects.toBeInstanceOf(
      WindowScopeViolationError,
    );
  });

  it('rejects with WindowScopeViolationError when the cursor is outside the target rect', async () => {
    const { manager, win32 } = makeManager();
    await manager.startDebugSession([region()]);
    manager.setTargetWindow(100);
    win32.fg = 100;
    win32.cursor = { x: 500, y: 500 }; // outside the 0..200 rect
    await expect(manager.injectGuarded(async () => {})).rejects.toBeInstanceOf(
      WindowScopeViolationError,
    );
  });

  it('rejects with WindowScopeViolationError when the target window has no rect', async () => {
    const { manager, win32 } = makeManager();
    await manager.startDebugSession([region()]);
    manager.setTargetWindow(100);
    win32.fg = 100;
    win32.rect = null;
    await expect(manager.injectGuarded(async () => {})).rejects.toBeInstanceOf(
      WindowScopeViolationError,
    );
  });

  it('rejects with NoActiveSessionError after the session has ended', async () => {
    const { manager } = makeManager();
    const handle = await manager.startDebugSession([region()]);
    await manager.endDebugSession(handle);
    await expect(manager.injectGuarded(async () => {})).rejects.toBeInstanceOf(
      NoActiveSessionError,
    );
  });
});

// ---------------------------------------------------------------------------
// Watchdog-down contract
// ---------------------------------------------------------------------------

describe('watchdog-down contract', () => {
  it('heartbeat failure transitions STOPPING→IDLE and refuses later input', async () => {
    const { manager, client } = makeManager();
    await manager.startDebugSession([region()]);
    expect(manager.state).toBe('ACTIVE');

    client.failHeartbeat = true;
    await waitFor(() => manager.state === 'IDLE', 2000);

    expect(manager.state).toBe('IDLE');
    await expect(manager.injectGuarded(async () => {})).rejects.toBeInstanceOf(
      NoActiveSessionError,
    );
  });

  it('watchdog process exit also triggers the watchdog-down transition', async () => {
    const { manager, proc } = makeManager();
    await manager.startDebugSession([region()]);
    expect(manager.state).toBe('ACTIVE');

    proc.resolveExit();
    await waitFor(() => manager.state === 'IDLE', 2000);

    expect(manager.state).toBe('IDLE');
  });
});

// ---------------------------------------------------------------------------
// endDebugSession teardown
// ---------------------------------------------------------------------------

describe('endDebugSession teardown', () => {
  it('calls shutdown and releases held modifiers', async () => {
    const { manager, client, released } = makeManager();
    const handle = await manager.startDebugSession([region()]);
    await manager.endDebugSession(handle);
    expect(client.shutDown).toBe(true);
    expect(client.closed).toBe(true);
    expect(released()).toBe(1);
  });

  it('kills the process when shutdown does not respond within the grace period', async () => {
    const { manager, client, proc } = makeManager();
    client.shutdownHang = true;
    const handle = await manager.startDebugSession([region()]);
    await manager.endDebugSession(handle);
    expect(proc.killed).toBe(true);
    expect(manager.state).toBe('IDLE');
  });

  it('endDebugSession with no active session throws NoActiveSessionError', async () => {
    const { manager } = makeManager();
    await expect(
      manager.endDebugSession({ id: 'nope', token: 't', regions: [] }),
    ).rejects.toBeInstanceOf(NoActiveSessionError);
  });
});

// ---------------------------------------------------------------------------
// Error classes + audit
// ---------------------------------------------------------------------------

describe('error classes and audit logging', () => {
  it('all four error classes are proper Error subclasses with names and codes', () => {
    const cases: Array<[Error, string, string]> = [
      [new AbortButtonsRequiredError(), 'AbortButtonsRequiredError', 'ABORT_BUTTONS_REQUIRED'],
      [new ElevationRequiredError(), 'ElevationRequiredError', 'ELEVATION_REQUIRED'],
      [new WindowScopeViolationError(), 'WindowScopeViolationError', 'WINDOW_SCOPE_VIOLATION'],
      [new NoActiveSessionError(), 'NoActiveSessionError', 'NO_ACTIVE_SESSION'],
    ];
    for (const [err, name, code] of cases) {
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe(name);
      expect((err as { code?: string }).code).toBe(code);
    }
  });

  it('audits every state transition and inject decision', async () => {
    const { manager } = makeManager();
    const handle = await manager.startDebugSession([region()]);
    manager.setTargetWindow(100);
    await manager.injectGuarded(async () => {});
    await manager.endDebugSession(handle);

    const entries = readEntries(logDir).filter((e) => e.toolName === 'safety');
    const actions = entries.map((e) => e.action);
    expect(actions).toContain('start_debug_session');
    expect(actions).toContain('inject_guarded');
    expect(actions).toContain('end_debug_session');

    const stateTransitions = entries
      .filter((e) => e.action === 'state')
      .map((e) => `${String(e.details.from)}→${String(e.details.to)}`);
    expect(stateTransitions).toEqual([
      'IDLE→STARTING',
      'STARTING→ACTIVE',
      'ACTIVE→STOPPING',
      'STOPPING→IDLE',
    ]);
  });
});
