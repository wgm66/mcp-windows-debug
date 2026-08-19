/**
 * Sandbox-aware safety gate tests (TDD).
 * Tests injectGuarded with sandboxMode=true → hwnd-validity gate,
 * NOT cursorAndFocusInside (which queries the Default desktop).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { DebugSessionManager } from '../src/safety';
import { AbortButtonsRequiredError, NoActiveSessionError } from '../src/safety';
import type { Region } from '../src/platform/safety';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'safety-sandbox-'));
}

interface FakeClient {
  connect(): Promise<void>;
  registerRegions(_r: Region[]): Promise<void>;
  heartbeat(): Promise<void>;
  status(): Promise<{ hooked: boolean; regions: number }>;
  shutdown(): Promise<void>;
  close(): void;
}

function makeFakeClient(): FakeClient {
  return {
    connect: () => Promise.resolve(),
    registerRegions: () => Promise.resolve(),
    heartbeat: () => Promise.resolve(),
    status: () => Promise.resolve({ hooked: true, regions: 1 }),
    shutdown: () => Promise.resolve(),
    close: () => {},
  };
}

function makeFakeSpawn() {
  return async () => ({
    pid: -1,
    kill() {},
    exited: new Promise<void>(() => {}), // never resolves (stays alive until killed)
  });
}

describe('sandbox-aware safety gate', () => {
  let logDir: string;

  beforeEach(() => {
    logDir = tmpDir();
    process.env.AUDIT_LOG_DIR = logDir;
  });

  afterEach(() => {
    delete process.env.AUDIT_LOG_DIR;
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  it('injectGuarded with sandboxMode=true + valid hwnd passes', async () => {
    const fakeClient = makeFakeClient();
    const mgr = new DebugSessionManager({
      sessionId: 'sb1',
      clientFactory: () => fakeClient,
      spawnWatchdog: makeFakeSpawn(),
      sandboxGate: { isWindow: () => true, getThreadDesktop: () => 999 },
    });
    const regions: Region[] = [{ x: 0, y: 0, w: 10, h: 10, id: 'r' }];
    await mgr.startDebugSession(regions);
    mgr.setTargetWindow(12345);
    mgr.setSandboxMode(999);

    let ran = false;
    const result = await mgr.injectGuarded(() => { ran = true; return 42; });
    expect(result).toBe(42);
    expect(ran).toBe(true);
    await mgr.endDebugSession({ id: 'sb1', token: '', regions });
  });

  it('injectGuarded with sandboxMode=true + invalid hwnd throws WindowScopeViolationError', async () => {
    const fakeClient = makeFakeClient();
    const mgr = new DebugSessionManager({
      sessionId: 'sb2',
      clientFactory: () => fakeClient,
      spawnWatchdog: makeFakeSpawn(),
      sandboxGate: { isWindow: () => false, getThreadDesktop: () => 999 },
    });
    const regions: Region[] = [{ x: 0, y: 0, w: 10, h: 10, id: 'r' }];
    await mgr.startDebugSession(regions);
    mgr.setTargetWindow(99999);
    mgr.setSandboxMode(999);

    await expect(mgr.injectGuarded(() => 1)).rejects.toMatchObject({
      name: 'WindowScopeViolationError',
      code: 'WINDOW_SCOPE_VIOLATION',
    });
    await mgr.endDebugSession({ id: 'sb2', token: '', regions });
  });

  it('injectGuarded with sandboxMode=true + wrong desktop throws WindowScopeViolationError', async () => {
    const fakeClient = makeFakeClient();
    const mgr = new DebugSessionManager({
      sessionId: 'sb3',
      clientFactory: () => fakeClient,
      spawnWatchdog: makeFakeSpawn(),
      sandboxGate: { isWindow: () => true, getThreadDesktop: () => 888 },
    });
    const regions: Region[] = [{ x: 0, y: 0, w: 10, h: 10, id: 'r' }];
    await mgr.startDebugSession(regions);
    mgr.setTargetWindow(12345);
    mgr.setSandboxMode(999); // expected desktop 999, but getThreadDesktop returns 888

    await expect(mgr.injectGuarded(() => 1)).rejects.toMatchObject({
      name: 'WindowScopeViolationError',
      code: 'WINDOW_SCOPE_VIOLATION',
    });
    await mgr.endDebugSession({ id: 'sb3', token: '', regions });
  });

  it('injectGuarded without session throws NoActiveSessionError', async () => {
    const mgr = new DebugSessionManager({
      sessionId: 'sb4',
      clientFactory: () => makeFakeClient(),
      spawnWatchdog: makeFakeSpawn(),
      sandboxGate: { isWindow: () => true, getThreadDesktop: () => 0 },
    });
    await expect(mgr.injectGuarded(() => 1)).rejects.toBeInstanceOf(NoActiveSessionError);
  });

  it('startDebugSession with 0 regions still throws AbortButtonsRequiredError', async () => {
    const mgr = new DebugSessionManager({
      sessionId: 'sb5',
      clientFactory: () => makeFakeClient(),
      spawnWatchdog: makeFakeSpawn(),
      sandboxGate: { isWindow: () => true, getThreadDesktop: () => 0 },
    });
    await expect(mgr.startDebugSession([])).rejects.toBeInstanceOf(AbortButtonsRequiredError);
  });
});
