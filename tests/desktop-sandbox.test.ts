/**
 * WindowsDesktopSandbox tests (TDD).
 *
 * Only PURE logic + the provider contract are exercised here — desktop-name
 * generation, LPARAM encoding, access-flag composition, and the SandboxHandle
 * lifecycle — via the injectable seams (`workerFactory`, `win32`). No real OS
 * desktop is ever created and no real worker_threads Worker is spawned in
 * these tests: the provider is always constructed with a fake worker factory
 * and fake Win32 deps.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  WindowsDesktopSandbox,
  DESKTOP_ACCESS_FLAGS,
  DESKTOP_NAME_PREFIX,
  makeDesktopName,
  generateDesktopSuffix,
  encodeLParam,
  parseDesktopName,
} from '../src/sandbox/desktop-sandbox';
import type {
  DesktopWin32Deps,
  DesktopWorkerFactory,
  DesktopWorkerLike,
  DesktopWorkerResponse,
} from '../src/sandbox/desktop-sandbox';
import { NotImplementedError } from '../src/platform/sandbox';
import type { SandboxProvider } from '../src/platform/sandbox';

// ---------------------------------------------------------------------------
// Pure helper constants — verified against Win32 headers
// ---------------------------------------------------------------------------

describe('DESKTOP_ACCESS_FLAGS', () => {
  it('includes DESKTOP_CREATEWINDOW (0x0002)', () => {
    // Required so the target process can create windows on the private desktop.
    expect(DESKTOP_ACCESS_FLAGS & 0x0002).not.toBe(0);
  });

  it('includes DESKTOP_HOOKCONTROL (0x0008)', () => {
    // LL hooks are desktop-scoped; the watchdog (if used) needs this.
    expect(DESKTOP_ACCESS_FLAGS & 0x0008).not.toBe(0);
  });

  it('includes GENERIC_READ and GENERIC_WRITE (0x80000000 | 0x40000000)', () => {
    // Required for SetThreadDesktop + FindWindowExW on the private desktop.
    expect(DESKTOP_ACCESS_FLAGS & 0x80000000).not.toBe(0);
    expect(DESKTOP_ACCESS_FLAGS & 0x40000000).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Desktop name generation
// ---------------------------------------------------------------------------

describe('makeDesktopName', () => {
  it('joins prefix and suffix with a dash', () => {
    expect(makeDesktopName('McpSandbox', 'abc123')).toBe('McpSandbox-abc123');
  });

  it('rejects a suffix that is not lowercase-alphanumeric', () => {
    expect(() => makeDesktopName('McpSandbox', 'with space')).toThrow();
    expect(() => makeDesktopName('McpSandbox', 'UPPER')).toThrow();
    expect(() => makeDesktopName('McpSandbox', 'a-b')).toThrow();
    expect(() => makeDesktopName('McpSandbox', '')).toThrow();
  });

  it('rejects a prefix containing characters that are illegal in a Win32 desktop name', () => {
    // Backslash is the desktop-namespace separator; reject it.
    expect(() => makeDesktopName('a\\b', 'abc')).toThrow();
    expect(() => makeDesktopName('', 'abc')).toThrow();
  });
});

describe('generateDesktopSuffix + parseDesktopName', () => {
  it('produces a lowercase-alphanumeric suffix of length 12', () => {
    const s = generateDesktopSuffix();
    expect(s).toMatch(/^[a-z0-9]{12}$/);
  });

  it('two consecutive suffixes differ (randomness)', () => {
    expect(generateDesktopSuffix()).not.toBe(generateDesktopSuffix());
  });

  it('parseDesktopName splits a full name back into prefix+suffix', () => {
    const name = makeDesktopName(DESKTOP_NAME_PREFIX, 'abc123def456');
    const parsed = parseDesktopName(name, DESKTOP_NAME_PREFIX);
    expect(parsed.prefix).toBe(DESKTOP_NAME_PREFIX);
    expect(parsed.suffix).toBe('abc123def456');
  });

  it('parseDesktopName rejects a name that does not start with the prefix', () => {
    expect(() => parseDesktopName('Other-abc123', DESKTOP_NAME_PREFIX)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// LPARAM encoding (MAKELPARAM)
// ---------------------------------------------------------------------------

describe('encodeLParam', () => {
  it('encodes (x,y) as a LOWORD(x) | HIWORD(y) 32-bit value', () => {
    expect(encodeLParam(0, 0)).toBe(0);
    expect(encodeLParam(1, 2)).toBe((2 << 16) | 1);
    expect(encodeLParam(0x1234, 0x5678)).toBe((0x5678 << 16) | 0x1234);
  });

  it('wraps negative coordinates into the unsigned 16-bit range', () => {
    // -1 → 0xffff in LOWORD; the high word is 0.
    expect(encodeLParam(-1, 0)).toBe(0x0000ffff);
  });
});

// ---------------------------------------------------------------------------
// Fakes for the provider contract test
// ---------------------------------------------------------------------------

interface FakeWin32 extends DesktopWin32Deps {
  createdDesktops: string[];
  closedDesktops: bigint[];
  nextDesktopHandle: bigint;
  createFailOnce: boolean;
}

function makeWin32(): FakeWin32 {
  let handleCounter = 100n;
  const w: FakeWin32 = {
    createdDesktops: [],
    closedDesktops: [],
    nextDesktopHandle: 0n,
    createFailOnce: false,
    createDesktop(name: string, _access: number): bigint {
      w.createdDesktops.push(name);
      if (w.createFailOnce) {
        w.createFailOnce = false;
        return 0n;
      }
      handleCounter += 1n;
      w.nextDesktopHandle = handleCounter;
      return handleCounter;
    },
    closeDesktop(h: bigint): void {
      w.closedDesktops.push(h);
    },
  };
  return w;
}

interface FakeWorker extends DesktopWorkerLike {
  posted: unknown[];
  terminated: boolean;
  // The main thread awaits the first 'init' response; tests drive it.
  sendInitResponse(hwnd: number): void;
  sendErrorResponse(message: string): void;
  // Tracks the init message so the test can assert it carried the desktop
  // handle and name.
  lastInitMessage: { type: string; desktopHandle: bigint; desktopName: string; targetApp: string } | null;
}

function makeWorker(): FakeWorker {
  const listeners: Array<(msg: DesktopWorkerResponse) => void> = [];
  const worker: FakeWorker = {
    posted: [],
    terminated: false,
    lastInitMessage: null,
    postMessage(msg: unknown): void {
      worker.posted.push(msg);
      if (msg && (msg as { type?: string }).type === 'init') {
        worker.lastInitMessage = msg as FakeWorker['lastInitMessage'];
      }
    },
    onMessage(cb: (msg: DesktopWorkerResponse) => void): void {
      listeners.push(cb);
    },
    terminate(): void {
      worker.terminated = true;
    },
    sendInitResponse(hwnd: number): void {
      for (const cb of listeners) cb({ type: 'init', ok: true, hwnd });
    },
    sendErrorResponse(message: string): void {
      for (const cb of listeners) cb({ type: 'init', ok: false, error: message });
    },
  };
  return worker;
}

function makeWorkerFactory(worker: FakeWorker): DesktopWorkerFactory {
  return () => worker;
}

// ---------------------------------------------------------------------------
// Audit-log harness (mirrors input.test.ts pattern)
// ---------------------------------------------------------------------------

interface AuditEntry {
  timestamp: string;
  sessionId: string;
  toolName: string;
  action: string;
  details: Record<string, unknown>;
  success: boolean;
}

let tempDirs: string[];
let logDir: string;
let sessionId: string;

function makeDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function readEntries(dir: string): AuditEntry[] {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ndjson'));
  const entries: AuditEntry[] = [];
  for (const f of files) {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      entries.push(JSON.parse(line) as AuditEntry);
    }
  }
  return entries;
}

beforeEach(() => {
  tempDirs = [];
  logDir = makeDir('desktop-sandbox-audit-');
  sessionId = `sess-${Math.random().toString(36).slice(2)}`;
  process.env.AUDIT_LOG_DIR = logDir;
});

afterEach(() => {
  delete process.env.AUDIT_LOG_DIR;
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// WindowsDesktopSandbox — provider contract
// ---------------------------------------------------------------------------

describe('WindowsDesktopSandbox', () => {
  it('implements SandboxProvider', () => {
    const provider: SandboxProvider = new WindowsDesktopSandbox({
      sessionId,
      win32: makeWin32(),
      workerFactory: makeWorkerFactory(makeWorker()),
    });
    expect(typeof provider.createSandbox).toBe('function');
  });

  it('rejects mode: rdp with NotImplementedError (sandbox backend owns desktop only)', async () => {
    const provider = new WindowsDesktopSandbox({
      sessionId,
      win32: makeWin32(),
      workerFactory: makeWorkerFactory(makeWorker()),
    });
    await expect(provider.createSandbox({ mode: 'rdp' })).rejects.toBeInstanceOf(
      NotImplementedError,
    );
  });

  it('rejects targetApp and targetHwnd both absent', async () => {
    const provider = new WindowsDesktopSandbox({
      sessionId,
      win32: makeWin32(),
      workerFactory: makeWorkerFactory(makeWorker()),
    });
    await expect(provider.createSandbox({ mode: 'desktop' })).rejects.toThrow(
      /targetApp|targetHwnd/i,
    );
  });

  it('creates a private desktop via CreateDesktopW with the right access flags', async () => {
    const win32 = makeWin32();
    const worker = makeWorker();
    const provider = new WindowsDesktopSandbox({
      sessionId,
      win32,
      workerFactory: makeWorkerFactory(worker),
    });

    const handlePromise = provider.createSandbox({
      mode: 'desktop',
      targetApp: 'notepad.exe',
    });
    // The provider spawns the worker and posts an init message; the worker in
    // the test reports back a (fake) target hwnd.
    worker.sendInitResponse(0x1234);
    const handle = await handlePromise;

    expect(win32.createdDesktops).toHaveLength(1);
    const name = win32.createdDesktops[0];
    expect(name).toContain(DESKTOP_NAME_PREFIX);
    expect(handle.desktopName).toBe(name);
    expect(handle.targetHwnd).toBe(0x1234);
  });

  it('passes the desktop handle and desktopName to the worker init message', async () => {
    const win32 = makeWin32();
    const worker = makeWorker();
    const provider = new WindowsDesktopSandbox({
      sessionId,
      win32,
      workerFactory: makeWorkerFactory(worker),
    });

    const p = provider.createSandbox({
      mode: 'desktop',
      targetApp: 'notepad.exe',
    });
    worker.sendInitResponse(0x1);
    await p;

    expect(worker.lastInitMessage).not.toBeNull();
    expect(worker.lastInitMessage!.type).toBe('init');
    expect(typeof worker.lastInitMessage!.desktopHandle).toBe('bigint');
    expect(worker.lastInitMessage!.desktopHandle).toBe(win32.nextDesktopHandle);
    expect(worker.lastInitMessage!.desktopName).toBe(win32.createdDesktops[0]);
    expect(worker.lastInitMessage!.targetApp).toBe('notepad.exe');
  });

  it('retries with a fresh name when CreateDesktopW returns 0 (name collision)', async () => {
    const win32 = makeWin32();
    win32.createFailOnce = true; // first name collides
    const worker = makeWorker();
    const provider = new WindowsDesktopSandbox({
      sessionId,
      win32,
      workerFactory: makeWorkerFactory(worker),
    });

    const p = provider.createSandbox({
      mode: 'desktop',
      targetApp: 'notepad.exe',
    });
    worker.sendInitResponse(0x5);
    await p;

    expect(win32.createdDesktops).toHaveLength(2);
    expect(win32.createdDesktops[0]).not.toBe(win32.createdDesktops[1]);
  });

  it('throws when the worker reports an init failure', async () => {
    const worker = makeWorker();
    const provider = new WindowsDesktopSandbox({
      sessionId,
      win32: makeWin32(),
      workerFactory: makeWorkerFactory(worker),
    });

    const p = provider.createSandbox({
      mode: 'desktop',
      targetApp: 'notepad.exe',
    });
    worker.sendErrorResponse('CreateProcessW failed: 740');
    await expect(p).rejects.toThrow(/CreateProcessW|740/);
  });

  it('throws when targetHwnd is absent and targetApp spawn returns hwnd 0', async () => {
    const worker = makeWorker();
    const provider = new WindowsDesktopSandbox({
      sessionId,
      win32: makeWin32(),
      workerFactory: makeWorkerFactory(worker),
    });

    const p = provider.createSandbox({
      mode: 'desktop',
      targetApp: 'notepad.exe',
    });
    worker.sendInitResponse(0);
    await expect(p).rejects.toThrow(/targetHwnd|spawn|0/i);
  });

  it('accepts targetHwnd-only config (attach, no spawn)', async () => {
    const win32 = makeWin32();
    const worker = makeWorker();
    const provider = new WindowsDesktopSandbox({
      sessionId,
      win32,
      workerFactory: makeWorkerFactory(worker),
    });

    const p = provider.createSandbox({
      mode: 'desktop',
      targetHwnd: 0xabcd,
    });
    worker.sendInitResponse(0xabcd);
    const handle = await p;

    expect(handle.targetHwnd).toBe(0xabcd);
    // The init message must NOT carry a targetApp when none was supplied.
    expect(worker.lastInitMessage).not.toBeNull();
    expect(worker.lastInitMessage!.targetApp).toBeUndefined();
  });

  it('dispose terminates the worker and closes the private desktop', async () => {
    const win32 = makeWin32();
    const worker = makeWorker();
    const provider = new WindowsDesktopSandbox({
      sessionId,
      win32,
      workerFactory: makeWorkerFactory(worker),
    });

    const p = provider.createSandbox({
      mode: 'desktop',
      targetApp: 'notepad.exe',
    });
    worker.sendInitResponse(0x1);
    const handle = await p;

    await handle.dispose();

    expect(worker.terminated).toBe(true);
    expect(win32.closedDesktops).toContain(win32.nextDesktopHandle);
  });

  it('dispose is idempotent', async () => {
    const win32 = makeWin32();
    const worker = makeWorker();
    const provider = new WindowsDesktopSandbox({
      sessionId,
      win32,
      workerFactory: makeWorkerFactory(worker),
    });

    const p = provider.createSandbox({
      mode: 'desktop',
      targetApp: 'notepad.exe',
    });
    worker.sendInitResponse(0x1);
    const handle = await p;

    await handle.dispose();
    await expect(handle.dispose()).resolves.not.toThrow();
  });

  it('audits the create + dispose on success', async () => {
    const win32 = makeWin32();
    const worker = makeWorker();
    const provider = new WindowsDesktopSandbox({
      sessionId,
      win32,
      workerFactory: makeWorkerFactory(worker),
    });

    const p = provider.createSandbox({
      mode: 'desktop',
      targetApp: 'notepad.exe',
    });
    worker.sendInitResponse(0x1);
    const handle = await p;
    await handle.dispose();

    const entries = readEntries(logDir).filter((e) => e.sessionId === sessionId);
    const actions = entries.map((e) => e.action);
    expect(actions).toContain('create_sandbox');
    expect(actions).toContain('dispose_sandbox');
    const create = entries.find((e) => e.action === 'create_sandbox');
    expect(create!.success).toBe(true);
    // desktopName is logged but never the target app path or hwnd of the user
    // window (hwnd is an opaque handle, not sensitive, but keep it minimal).
    expect(create!.details.desktopName).toBe(win32.createdDesktops[0]);
  });

  it('audits create_sandbox failure with success=false', async () => {
    const worker = makeWorker();
    const provider = new WindowsDesktopSandbox({
      sessionId,
      win32: makeWin32(),
      workerFactory: makeWorkerFactory(worker),
    });

    const p = provider.createSandbox({
      mode: 'desktop',
      targetApp: 'notepad.exe',
    });
    worker.sendErrorResponse('spawn failed');
    await expect(p).rejects.toThrow();

    const entries = readEntries(logDir).filter((e) => e.sessionId === sessionId);
    const create = entries.find((e) => e.action === 'create_sandbox');
    expect(create).toBeDefined();
    expect(create!.success).toBe(false);
  });
});
