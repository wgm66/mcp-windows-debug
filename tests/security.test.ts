/**
 * Security acceptance tests (todo 12).
 *
 * Six scenarios; exactly ONE runs non-elevated:
 *
 *   (d) audit privacy — ZERO keystroke content in the audit log. RUNS: drives
 *       the real `src/audit.ts` `logEntry` sanitizer AND the input provider's
 *       `logEntry` usage with a canary keystroke, then asserts the canary never
 *       appears in the log while a safe action label does.
 *
 * The other five are elevation/display-gated and `describe.skip` on this
 * non-elevated shell. Each carries the exact manual command to run it elevated.
 *
 *   (a) hook removal via dead-man switch        — elevation
 *   (b) injected click blocked 100/100          — elevation + GUI
 *   (c) non-injected / outside-region click 100/100 — elevation + GUI
 *   (e) coordinate tolerance ±2px (mixed DPI)   — elevation + multi-monitor
 *   (f) secure-desktop pause within 2s          — elevation + lock screen
 *
 * No actual input injection happens in an automated (non-elevated) run:
 * only (d) executes, and it uses a fake `WindowsInputDeps` seam (no SendInput).
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as koffi from 'koffi';
import { Monitor } from 'node-screenshots';

import { logEntry } from '../src/audit';
import { WindowsInputProvider } from '../src/input';
import type { WindowsInputDeps } from '../src/input';
import { WatchdogClient, generateToken } from '../src/ipc';
import { Orchestrator, createRealWindowProbe } from '../src/orchestrator';
import type { OrchestratorEvent, SafetyGate } from '../src/orchestrator';
import type { InputProvider } from '../src/platform/input';
import type { CaptureResult, ScreenProvider } from '../src/platform/screen';
import type { SessionState } from '../src/safety';

jest.setTimeout(30000);

const WATCHDOG_EXE = path.join(__dirname, '..', 'src', 'watchdog', 'watchdog.exe');

// ---------------------------------------------------------------------------
// Environment gates
// ---------------------------------------------------------------------------

/** True when an interactive display (≥1 monitor) is available. */
const hasDisplay = (() => {
  try {
    return Monitor.all().length > 0;
  } catch {
    return false;
  }
})();

/**
 * True when this shell is elevated. The watchdog's elevation check precedes
 * argument parsing, so `watchdog.exe --help` returns 0 iff elevated (same
 * probe as `tests/ipc.test.ts`).
 */
function shellIsElevated(): boolean {
  try {
    const probe = spawnSync(WATCHDOG_EXE, ['--help'], { encoding: 'utf8', timeout: 5000 });
    return probe.status === 0;
  } catch {
    return false;
  }
}

const elevated = shellIsElevated();
const elevatedSuite = elevated ? describe : describe.skip;
const displayAndElevatedSuite = hasDisplay && elevated ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll `cond` every 50ms until it returns truthy or `timeoutMs` elapses. */
async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(50);
  }
  return cond();
}

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Read every `.ndjson` audit line under `dir` into one string. */
function readRawAudit(dir: string): string {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.ndjson'))
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
    .join('\n');
}

/** Fake deps so the audit test never touches SendInput. */
function makeFakeDeps(): { deps: WindowsInputDeps } {
  const deps: WindowsInputDeps = {
    sendKeyEvents: () => {},
    sendMouseEvent: () => {},
    getDpiForPoint: () => ({ dpiX: 96, dpiY: 96 }),
    virtualScreenSize: () => ({ width: 1920, height: 1080 }),
  };
  return { deps };
}

/**
 * Lazily-initialized Win32 surface (koffi → user32/shcore). Only the skipped
 * elevation/display suites call this, so the running audit test never loads
 * user32.dll.
 */
function createWin32() {
  const user32 = koffi.load('user32.dll');
  const shcore = koffi.load('shcore.dll');
  const POINT = koffi.struct('POINT', { x: 'int32', y: 'int32' });
  return {
    findWindow: user32.func('void * FindWindowA(str lpClassName, str lpWindowName)'),
    setForeground: user32.func('bool SetForegroundWindow(void *hWnd)'),
    getWindowRect: user32.func('bool GetWindowRect(void *hWnd, void *lpRect)'),
    getForeground: user32.func('void * GetForegroundWindow()'),
    getCursorPos: user32.func('bool GetCursorPos(void *lpPoint)'),
    getDpiForWindow: user32.func('uint32 GetDpiForWindow(void *hWnd)'),
    monitorFromPoint: user32.func('MonitorFromPoint', 'void *', [POINT, 'uint32']),
    getDpiForMonitor: shcore.func(
      'int32 GetDpiForMonitor(void *hmonitor, int32 dpiType, uint32 *dpiX, uint32 *dpiY)',
    ),
    lockWorkStation: user32.func('bool LockWorkStation()'),
  };
}

/** Effective DPI at a physical screen point (mixed-DPI aware). */
function readDpiAt(
  win32: ReturnType<typeof createWin32>,
  x: number,
  y: number,
): { dpiX: number; dpiY: number } {
  const monitor = win32.monitorFromPoint({ x: Math.round(x), y: Math.round(y) }, 2);
  const buf = Buffer.alloc(8);
  const hr = win32.getDpiForMonitor(monitor, 0, buf, buf.subarray(4));
  if (hr !== 0) {
    throw new Error(`GetDpiForMonitor failed: HRESULT 0x${(hr >>> 0).toString(16)}`);
  }
  return { dpiX: buf.readUInt32LE(0), dpiY: buf.readUInt32LE(4) };
}

// ---------------------------------------------------------------------------
// (a) helper: a plain-node "MCP server" that holds the watchdog pipe open and
//     heartbeats. Passed `-e` so it needs no compiled dist/TS import.
// ---------------------------------------------------------------------------

const HELPER_SOURCE = String.raw`
const net = require('net');
const pipePath = process.env.SEC_HELPER_PIPE_PATH;
const token = process.env.SEC_HELPER_TOKEN;
const sock = net.connect(pipePath);
let buf = '';
sock.setNoDelay(true);
sock.on('connect', function () {
  sock.write(JSON.stringify({ token: token }) + '\n');
});
sock.on('data', function (chunk) {
  buf += chunk.toString('utf8');
  var idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    var line = buf.slice(0, idx).replace(/\r$/, '');
    buf = buf.slice(idx + 1);
    if (line.length === 0) continue;
    try {
      var msg = JSON.parse(line);
      if (msg.ok === true && msg.op === 'AUTH') {
        process.stdout.write('READY\n');
        setInterval(function () {
          try { sock.write(JSON.stringify({ op: 'HEARTBEAT' }) + '\n'); } catch (e) {}
        }, 500);
      }
    } catch (e) {}
  }
});
sock.on('error', function () { process.exit(1); });
`;

// ---------------------------------------------------------------------------
// (d) Audit privacy — RUNS (non-elevated)
// ---------------------------------------------------------------------------

describe('security — audit privacy: zero keystroke content (non-elevated, RUNS)', () => {
  let logDir: string;
  let sessionId: string;

  beforeEach(() => {
    logDir = makeTempDir('security-audit-');
    sessionId = `sess-${Math.random().toString(36).slice(2)}`;
    process.env.AUDIT_LOG_DIR = logDir;
  });

  afterEach(() => {
    delete process.env.AUDIT_LOG_DIR;
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  it('(d) keystroke canary never reaches the audit log; the safe action label does', async () => {
    const canary = `CANARY_KEYSTROKE_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    // 1. Input-provider audit path: typeText audits `length` only, never the text.
    const { deps } = makeFakeDeps();
    const provider = new WindowsInputProvider({ sessionId, deps });
    await provider.typeText(canary);

    // 2. Direct logEntry path: the sanitizer strips keystroke keys recursively.
    logEntry(
      sessionId,
      'input',
      'type_text',
      { keystrokes: canary, typedText: canary, safeLabel: 'type_text' },
      true,
    );

    const raw = readRawAudit(logDir);

    // ZERO keystroke content: the canary must never appear anywhere.
    expect(raw).not.toContain(canary);
    // Positive control: the safe action label DOES appear (log is real).
    expect(raw).toContain('"action":"type_text"');
    // Positive control: the provider's length-only audit is present.
    expect(raw).toContain('"length"');
    // Positive control: a non-sensitive detail key survives sanitization.
    expect(raw).toContain('"safeLabel":"type_text"');
  });
});

// ---------------------------------------------------------------------------
// (a) Hook removal via dead-man switch — elevation
// ---------------------------------------------------------------------------

elevatedSuite('(a) watchdog dead-man switch removes hooks within 3000ms of taskkill', () => {
  // Manual (from an ELEVATED PowerShell at the project root):
  //   npx jest tests/security.test.ts -t "dead-man switch"
  let watchdog: ChildProcess | undefined;
  let helper: ChildProcess | undefined;
  let pipeId: string;
  let token: string;

  beforeEach(() => {
    pipeId = `sec-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    token = generateToken();
    watchdog = spawn(WATCHDOG_EXE, ['--pipe-id', pipeId], {
      env: { ...process.env, WATCHDOG_TOKEN: token },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  });

  afterEach(() => {
    for (const p of [helper, watchdog]) {
      if (p && p.exitCode === null && p.signalCode === null) {
        try {
          p.kill();
        } catch {
          // best effort
        }
      }
    }
  });

  it('kills the holding Node process and observes the watchdog unhook + exit', async () => {
    const pipePath = `\\\\.\\pipe\\McpWatchdog-${pipeId}`;
    helper = spawn('node', ['-e', HELPER_SOURCE], {
      env: { ...process.env, SEC_HELPER_PIPE_PATH: pipePath, SEC_HELPER_TOKEN: token },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Positive control: the helper completes the token handshake → the watchdog
    // is up, hooked, and serving the pipe (hooks are installed before the pipe).
    let helperOut = '';
    helper.stdout?.on('data', (d: Buffer) => {
      helperOut += d.toString('utf8');
    });
    const ready = await waitFor(() => helperOut.includes('READY'), 5000);
    expect(ready).toBe(true);
    expect(watchdog?.exitCode).toBeNull();

    // Kill the holding Node process (simulates a crashed MCP server).
    const kill = spawnSync('taskkill', ['/F', '/PID', String(helper.pid)], {
      encoding: 'utf8',
    });
    expect(kill.status).toBe(0);

    // The dead-man switch (2s) must unhook and exit the watchdog within 3000ms.
    // Hook presence ⟺ watchdog process alive (Cleanup unhooks both hooks before
    // the process exits), so process-exit is the polled observable.
    const exited = await waitFor(
      () => (watchdog ? watchdog.exitCode !== null || watchdog.signalCode !== null : false),
      3000,
    );
    expect(exited).toBe(true);
    expect(watchdog?.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (b) Injected click into a protected region is blocked (100/100) — elevation + GUI
// ---------------------------------------------------------------------------

displayAndElevatedSuite('(b) injected click into a protected region is blocked (100/100)', () => {
  // Manual (from an ELEVATED PowerShell on an interactive desktop):
  //   npx jest tests/security.test.ts -t "injected click"
  let watchdog: ChildProcess | undefined;
  let notepadA: ChildProcess | undefined;
  let notepadB: ChildProcess | undefined;
  let client: WatchdogClient | undefined;
  let win32: ReturnType<typeof createWin32>;
  let hwndA: number;
  let hwndB: number;

  beforeAll(async () => {
    win32 = createWin32();
    const pipeId = `sec-${process.pid}-${Date.now()}-b`;
    const token = generateToken();
    watchdog = spawn(WATCHDOG_EXE, ['--pipe-id', pipeId], {
      env: { ...process.env, WATCHDOG_TOKEN: token },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    client = new WatchdogClient({ pipeId, token, connectTimeoutMs: 10000 });
    await client.connect();
    // A region covering the entire virtual screen: every injected click is blocked.
    await client.registerRegions([{ x: 0, y: 0, w: 1_000_000, h: 1_000_000, id: 'full' }]);

    notepadA = spawn('notepad.exe', [], { detached: true, stdio: 'ignore' });
    await waitFor(() => Number(win32.findWindow('Notepad', null) ?? 0) !== 0, 10000);
    hwndA = Number(win32.findWindow('Notepad', null));

    notepadB = spawn('notepad.exe', [], { detached: true, stdio: 'ignore' });
    await waitFor(() => Number(win32.findWindow('Notepad', null) ?? 0) !== hwndA, 10000);
    hwndB = Number(win32.findWindow('Notepad', null));
  }, 30000);

  afterAll(() => {
    client?.close();
    for (const p of [notepadA, notepadB, watchdog]) {
      if (p && p.exitCode === null && p.signalCode === null) {
        try {
          p.kill();
        } catch {
          // best effort
        }
      }
    }
  });

  it('(b) 100 injected clicks inside the region are all blocked', async () => {
    const rect = Buffer.alloc(16);
    win32.getWindowRect(BigInt(hwndA), rect);
    const cx = Math.round((rect.readInt32LE(0) + rect.readInt32LE(8)) / 2);
    const cy = Math.round((rect.readInt32LE(4) + rect.readInt32LE(12)) / 2);
    const dpi = win32.getDpiForWindow(BigInt(hwndA));
    const lx = (cx * 96) / dpi;
    const ly = (cy * 96) / dpi;

    const provider = new WindowsInputProvider({
      sessionId: `sec-${Math.random().toString(36).slice(2)}`,
    });

    for (let i = 0; i < 100; i++) {
      win32.setForeground(BigInt(hwndB));
      await waitFor(() => Number(win32.getForeground() ?? 0) === hwndB, 5000);
      await provider.mouseClick(lx, ly, 'left');
      await sleep(20);
      // Blocked: the injected click never activates Notepad A.
      expect(Number(win32.getForeground() ?? 0)).toBe(hwndB);
    }
  });
});

// ---------------------------------------------------------------------------
// (c) Non-injected / outside-region click passes (100/100) — elevation + GUI
// ---------------------------------------------------------------------------

displayAndElevatedSuite('(c) non-injected / outside-region click passes (100/100)', () => {
  // Manual (from an ELEVATED PowerShell on an interactive desktop):
  //   npx jest tests/security.test.ts -t "outside-region click"
  //
  // NOTE: a true hardware "physical" click (LLMHF_INJECTED == 0) cannot be
  // synthesized — SendInput / mouse_event always set the injected flag. This
  // test exercises the hook's pass-through branch: an injected click OUTSIDE
  // any protected region takes the same `CallNextHookEx` path a physical
  // (non-injected) click takes, proving the watchdog never over-blocks.
  let watchdog: ChildProcess | undefined;
  let notepadA: ChildProcess | undefined;
  let notepadB: ChildProcess | undefined;
  let client: WatchdogClient | undefined;
  let win32: ReturnType<typeof createWin32>;
  let hwndA: number;
  let hwndB: number;

  beforeAll(async () => {
    win32 = createWin32();
    const pipeId = `sec-${process.pid}-${Date.now()}-c`;
    const token = generateToken();
    watchdog = spawn(WATCHDOG_EXE, ['--pipe-id', pipeId], {
      env: { ...process.env, WATCHDOG_TOKEN: token },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    client = new WatchdogClient({ pipeId, token, connectTimeoutMs: 10000 });
    await client.connect();
    // A 1x1 region in the top-left corner, far from the click target.
    await client.registerRegions([{ x: 0, y: 0, w: 1, h: 1, id: 'corner' }]);

    notepadA = spawn('notepad.exe', [], { detached: true, stdio: 'ignore' });
    await waitFor(() => Number(win32.findWindow('Notepad', null) ?? 0) !== 0, 10000);
    hwndA = Number(win32.findWindow('Notepad', null));

    notepadB = spawn('notepad.exe', [], { detached: true, stdio: 'ignore' });
    await waitFor(() => Number(win32.findWindow('Notepad', null) ?? 0) !== hwndA, 10000);
    hwndB = Number(win32.findWindow('Notepad', null));
  }, 30000);

  afterAll(() => {
    client?.close();
    for (const p of [notepadA, notepadB, watchdog]) {
      if (p && p.exitCode === null && p.signalCode === null) {
        try {
          p.kill();
        } catch {
          // best effort
        }
      }
    }
  });

  it('(c) 100 injected clicks OUTSIDE the region all reach the target', async () => {
    const rect = Buffer.alloc(16);
    win32.getWindowRect(BigInt(hwndA), rect);
    const cx = Math.round((rect.readInt32LE(0) + rect.readInt32LE(8)) / 2);
    const cy = Math.round((rect.readInt32LE(4) + rect.readInt32LE(12)) / 2);
    const dpi = win32.getDpiForWindow(BigInt(hwndA));
    const lx = (cx * 96) / dpi;
    const ly = (cy * 96) / dpi;

    const provider = new WindowsInputProvider({
      sessionId: `sec-${Math.random().toString(36).slice(2)}`,
    });

    for (let i = 0; i < 100; i++) {
      win32.setForeground(BigInt(hwndB));
      await waitFor(() => Number(win32.getForeground() ?? 0) === hwndB, 5000);
      await provider.mouseClick(lx, ly, 'left');
      await sleep(20);
      // Pass-through: the click activates Notepad A.
      expect(Number(win32.getForeground() ?? 0)).toBe(hwndA);
    }
  });
});

// ---------------------------------------------------------------------------
// (e) Coordinate tolerance ±2px (mixed DPI) — elevation + multi-monitor
// ---------------------------------------------------------------------------

displayAndElevatedSuite('(e) coordinate tolerance ±2px across mixed DPI', () => {
  // Manual (from an ELEVATED PowerShell on a multi-monitor, mixed-DPI desktop):
  //   npx jest tests/security.test.ts -t "coordinate tolerance"
  //
  // NOTE: full mixed-DPI coverage additionally requires a real mixed-DPI
  // desktop. The forward DPI lookup in `WindowsInputProvider.toAbsolute`
  // passes LOGICAL coords to `MonitorFromPoint` (which expects physical
  // pixels) — a potential src issue this test is designed to surface; if this
  // test fails on mixed-DPI hardware, that lookup is the first suspect.
  it('(e) mouseMove lands within ±2px of the requested logical coordinate', async () => {
    const win32 = createWin32();
    const provider = new WindowsInputProvider({
      sessionId: `sec-${Math.random().toString(36).slice(2)}`,
    });

    const points = [
      { x: 100, y: 100 },
      { x: 500, y: 300 },
      { x: 900, y: 500 },
    ];

    for (const pt of points) {
      await provider.mouseMove(pt.x, pt.y);
      await sleep(50);

      const cursor = Buffer.alloc(8);
      if (!win32.getCursorPos(cursor)) throw new Error('GetCursorPos failed');
      const px = cursor.readInt32LE(0);
      const py = cursor.readInt32LE(4);

      const dpi = readDpiAt(win32, px, py);
      const logical = { x: (px * 96) / dpi.dpiX, y: (py * 96) / dpi.dpiY };

      expect(Math.abs(logical.x - pt.x)).toBeLessThanOrEqual(2);
      expect(Math.abs(logical.y - pt.y)).toBeLessThanOrEqual(2);
    }
  });
});

// ---------------------------------------------------------------------------
// (f) Secure-desktop pause within 2s — elevation + lock screen
// ---------------------------------------------------------------------------

elevatedSuite('(f) secure desktop pause within 2s', () => {
  // Manual (from an ELEVATED PowerShell at the project root):
  //   npx jest tests/security.test.ts -t "secure desktop pause"
  // WARNING: this LOCKS the workstation — unlock manually (Win+L password)
  // before continuing any other work.
  it('(f) LockWorkStation switches the input desktop and pauses the orchestrator', async () => {
    const probe = createRealWindowProbe();
    const target = probe.getForegroundWindow();
    expect(target).toBeGreaterThan(0);

    const safety: SafetyGate = {
      state: 'ACTIVE' as SessionState,
      injectGuarded: async <T>(action: () => T | Promise<T>): Promise<T> => action(),
      setTargetWindow: () => {},
    };
    const input: InputProvider = {
      mouseClick: async () => {},
      mouseMove: async () => {},
      keyPress: async () => {},
      typeText: async () => {},
    };
    const screen: ScreenProvider = {
      captureFull: async (): Promise<CaptureResult> => ({ png: Buffer.alloc(0), width: 0, height: 0 }),
      captureWindow: async (): Promise<CaptureResult> => ({ png: Buffer.alloc(0), width: 0, height: 0 }),
    };

    const events: OrchestratorEvent[] = [];
    const orch = new Orchestrator({
      sessionId: `sec-${Math.random().toString(36).slice(2)}`,
      safety,
      input,
      screen,
      probe,
      pollIntervalMs: 200,
      onNotify: (e) => events.push(e),
    });
    orch.start({ targetWindow: target });

    // Switch to the secure desktop (lock the workstation).
    const win32 = createWin32();
    expect(win32.lockWorkStation()).toBe(true);

    const paused = await waitFor(() => orch.isPaused(), 2000);
    expect(paused).toBe(true);
    expect(orch.state).toBe('PAUSED');
    expect(orch.getContext().pauseReason).toBe('secure_desktop');
    expect(events.some((e) => e.type === 'pause' && e.reason === 'secure_desktop')).toBe(true);

    orch.stop();
  });
});
