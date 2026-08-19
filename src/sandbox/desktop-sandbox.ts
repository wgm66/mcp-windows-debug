/**
 * WindowsDesktopSandbox — v1 SandboxProvider backed by a private Win32 desktop.
 *
 * Flow:
 *   1. main thread calls `CreateDesktopW` (koffi → user32) with
 *      `DESKTOP_CREATEWINDOW | DESKTOP_HOOKCONTROL | GENERIC_READ | GENERIC_WRITE`.
 *      `CreateDesktopW` is NOT sticky per-thread — safe to call on main.
 *   2. main thread spawns a `worker_threads.Worker` (the worker owns ALL
 *      subsequent private-desktop interaction). The worker calls
 *      `SetThreadDesktop(privateDesktop)` once, then `CreateProcessW` with
 *      `STARTUPINFO.lpDesktop = L"<desktop-name>"` to spawn the target on the
 *      private desktop, and `FindWindowExW` (on the private desktop) to locate
 *      the target window.
 *   3. worker posts `{type:'init', ok:true, hwnd}` back. The main thread wraps
 *      the result in a `SandboxHandle` whose `dispose()` terminates the worker
 *      and calls `CloseDesktop`.
 *
 * What this file MUST NOT do (plan .omo/plans/sandbox-isolation.md todo 2):
 *   - Never call `SetThreadDesktop` on Node's main thread (sticky per-thread,
 *     would break the Default-desktop path + the heartbeat).
 *   - Never call `SwitchDesktop` (would swap the user's visible desktop).
 *   - Never use `SendInput` in sandbox mode (forbidden — enters the system
 *     input stream). Injection is the PostMessage provider's job, not this
 *     file's.
 */

import { Worker } from 'node:worker_threads';
import * as path from 'node:path';
import * as koffi from 'koffi';
import { randomBytes } from 'node:crypto';

import { logEntry } from '../audit';
import { NotImplementedError } from '../platform/sandbox';
import type {
  SandboxConfig,
  SandboxHandle,
  SandboxProvider,
} from '../platform/sandbox';

/** Tool name reported to the audit log. */
const TOOL_NAME = 'sandbox';

/** Prefix for every private desktop name we create. */
export const DESKTOP_NAME_PREFIX = 'McpSandbox';

/**
 * `dwDesiredAccess` passed to `CreateDesktopW`.
 *
 * - `DESKTOP_CREATEWINDOW` (0x0002): the target process needs to create
 *   windows on this desktop.
 * - `DESKTOP_HOOKCONTROL` (0x0008): LL hooks are desktop-scoped; the
 *   watchdog (if used) needs this to install hooks on the private desktop.
 * - `GENERIC_READ`  (0x80000000): required by `SetThreadDesktop` +
 *   `FindWindowExW` reading windows on the desktop.
 * - `GENERIC_WRITE` (0x40000000): required by `CloseDesktop` and window
 *   creation on the desktop.
 *
 * `DESKTOP_SWITCHDESKTOP` is deliberately NOT requested — it would let a
 * future caller swap the user's visible desktop, which the plan forbids
 * ("NO SwitchDesktop call").
 */
export const DESKTOP_ACCESS_FLAGS: number =
  0x0002 | 0x0008 | 0x80000000 | 0x40000000;

/** Number of times to retry `CreateDesktopW` on a name collision. */
const CREATE_DESKTOP_MAX_RETRIES = 3;

/** Shape of messages the main thread posts to the worker. */
export type DesktopWorkerRequest =
  | {
      type: 'init';
      desktopHandle: bigint;
      desktopName: string;
      targetApp?: string;
      targetHwnd?: number;
    }
  | { type: 'dispose' };

/** Shape of messages the worker posts back to the main thread. */
export type DesktopWorkerResponse =
  | { type: 'init'; ok: true; hwnd: number }
  | { type: 'init'; ok: false; error: string };

/**
 * Worker seam — the main thread only calls `postMessage`, `onMessage`, and
 * `terminate`. The real impl is `node:worker_threads.Worker`; tests inject a
 * fake. Keeping the seam narrow lets the contract test run without spinning a
 * real OS thread.
 */
export interface DesktopWorkerLike {
  postMessage(message: DesktopWorkerRequest): void;
  onMessage(cb: (msg: DesktopWorkerResponse) => void): void;
  terminate(): void;
}

/** Factory seam so tests inject a fake worker; production wires the real one. */
export type DesktopWorkerFactory = (workerData?: unknown) => DesktopWorkerLike;

/** Win32 seam for the few desktop APIs the MAIN thread calls directly. */
export interface DesktopWin32Deps {
  /**
   * `CreateDesktopW(lpszDesktop, NULL, NULL, 0, dwDesiredAccess, NULL)` →
   * `HDESK`. Returns `0n` on failure (caller retries with a fresh name).
   */
  createDesktop(name: string, access: number): bigint;
  /** `CloseDesktop(hDesktop)` — never throws from the caller's perspective. */
  closeDesktop(handle: bigint): void;
}

// ---------------------------------------------------------------------------
// Real koffi Win32 deps (lazily initialized; never called during tests)
// ---------------------------------------------------------------------------

interface RealContext {
  createDesktop(name: string, access: number): bigint;
  closeDesktop(handle: bigint): void;
}

let realContext: RealContext | undefined;

function ensureRealContext(): RealContext {
  if (realContext) return realContext;
  const user32 = koffi.load('user32.dll');
  // `CreateDesktopW` is NOT sticky per-thread — calling it on the main thread
  // is safe; only `SetThreadDesktop` (called inside the worker) is sticky.
  const CreateDesktopW = user32.func(
    'void * CreateDesktopW(uint16 *lpszDesktop, void *lpszDevice, void *pDevmode, uint32 dwFlags, uint32 dwDesiredAccess, void *lpSecurityAttributes)',
  );
  const CloseDesktop = user32.func('bool CloseDesktop(void *hDesktop)');
  realContext = {
    createDesktop(name: string, access: number): bigint {
      const buf = Buffer.alloc((name.length + 1) * 2);
      for (let i = 0; i < name.length; i++) buf.writeUInt16LE(name.charCodeAt(i), i * 2);
      const h = CreateDesktopW(buf, null, null, 0, access, null);
      return BigInt(h as number);
    },
    closeDesktop(handle: bigint): void {
      try {
        CloseDesktop(handle.toString());
      } catch {
        // best effort — never throw from dispose
      }
    },
  };
  return realContext;
}

function createRealWin32Deps(): DesktopWin32Deps {
  return {
    createDesktop(name: string, access: number): bigint {
      return ensureRealContext().createDesktop(name, access);
    },
    closeDesktop(handle: bigint): void {
      ensureRealContext().closeDesktop(handle);
    },
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Build the full desktop name from prefix + suffix. */
export function makeDesktopName(prefix: string, suffix: string): string {
  if (!prefix) throw new Error('desktop name prefix must not be empty');
  if (prefix.includes('\\')) {
    throw new Error('desktop name prefix must not contain a backslash');
  }
  if (!/^[a-z0-9]{1,32}$/.test(suffix)) {
    throw new Error(
      'desktop name suffix must be 1..32 lowercase-alphanumeric chars',
    );
  }
  return `${prefix}-${suffix}`;
}

/** Generate a random lowercase-alphanumeric 12-char suffix. */
export function generateDesktopSuffix(): string {
  // 12 base36 chars ≈ 62 bits of entropy; collisions on a single machine
  // are astronomically unlikely; CreateDesktop still retries on collision.
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(12);
  let out = '';
  for (let i = 0; i < 12; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/** Parse a `<prefix>-<suffix>` desktop name back into its parts. */
export function parseDesktopName(
  name: string,
  prefix: string,
): { prefix: string; suffix: string } {
  if (!name.startsWith(prefix + '-')) {
    throw new Error(`desktop name does not start with prefix "${prefix}"`);
  }
  const suffix = name.slice(prefix.length + 1);
  return { prefix, suffix };
}

/**
 * `MAKELPARAM(x, y)` — packs two 16-bit client coordinates into one 32-bit
 * LPARAM for `WM_LBUTTONDOWN` / `WM_MOUSEMOVE` / etc.
 *
 * Negative coordinates (rare in client space) wrap into the unsigned 16-bit
 * range as Win32 expects (LPARAM is a UINT_PTR).
 */
export function encodeLParam(x: number, y: number): number {
  const lo = x & 0xffff;
  const hi = (y & 0xffff) << 16;
  // Convert to unsigned 32-bit range to match the LPARAM (UINT_PTR) contract.
  return (hi | lo) >>> 0;
}

// ---------------------------------------------------------------------------
// Worker script path
// ---------------------------------------------------------------------------

function defaultWorkerScriptPath(): string {
  // The server runs from the project root (`node ./dist/index.js`); the worker
  // is compiled alongside it at dist/sandbox/desktop-worker.js.
  return path.join(process.cwd(), 'dist', 'sandbox', 'desktop-worker.js');
}

function createRealWorkerFactory(): DesktopWorkerFactory {
  return (workerData?: unknown) => {
    const data = (workerData ?? {}) as { workerScriptPath?: string };
    const scriptPath = data.workerScriptPath ?? defaultWorkerScriptPath();
    const worker = new Worker(scriptPath, { workerData });
    return {
      postMessage(message: DesktopWorkerRequest): void {
        worker.postMessage(message);
      },
      onMessage(cb: (msg: DesktopWorkerResponse) => void): void {
        worker.on('message', cb);
      },
      terminate(): void {
        void worker.terminate().catch(() => {});
      },
    };
  };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface WindowsDesktopSandboxOptions {
  sessionId: string;
  /** Win32 seam (defaults to the real koffi/user32 backend). */
  win32?: DesktopWin32Deps;
  /** Worker factory seam (defaults to the real `worker_threads.Worker`). */
  workerFactory?: DesktopWorkerFactory;
  /** Path to the worker script (defaults to the dist-bundled worker). */
  workerScriptPath?: string;
}

interface ActiveSandbox {
  desktopHandle: bigint;
  desktopName: string;
  worker: DesktopWorkerLike;
  disposed: boolean;
}

export class WindowsDesktopSandbox implements SandboxProvider {
  private readonly sessionId: string;
  private readonly win32: DesktopWin32Deps;
  private readonly workerFactory: DesktopWorkerFactory;
  private readonly workerScriptPath: string;
  private active: ActiveSandbox | null = null;

  constructor(options: WindowsDesktopSandboxOptions) {
    this.sessionId = options.sessionId;
    this.win32 = options.win32 ?? createRealWin32Deps();
    this.workerFactory = options.workerFactory ?? createRealWorkerFactory();
    this.workerScriptPath =
      options.workerScriptPath ?? defaultWorkerScriptPath();
  }

  async createSandbox(config: SandboxConfig): Promise<SandboxHandle> {
    if (config.mode !== 'desktop') {
      throw new NotImplementedError(
        'WindowsDesktopSandbox only supports mode: desktop; use LocalRdpSandbox for rdp',
      );
    }
    if (!config.targetApp && !config.targetHwnd) {
      throw new Error(
        'createSandbox requires targetApp (to spawn) or targetHwnd (to attach)',
      );
    }

    // Create the private desktop on the MAIN thread — CreateDesktopW is not
    // sticky per-thread. SetThreadDesktop (sticky) is only ever called inside
    // the worker.
    let desktopHandle = 0n;
    let desktopName = '';
    for (let attempt = 0; attempt < CREATE_DESKTOP_MAX_RETRIES; attempt++) {
      desktopName = makeDesktopName(DESKTOP_NAME_PREFIX, generateDesktopSuffix());
      desktopHandle = this.win32.createDesktop(desktopName, DESKTOP_ACCESS_FLAGS);
      if (desktopHandle !== 0n) break;
    }
    if (desktopHandle === 0n) {
      this.log(
        'create_sandbox',
        {
          error: 'CreateDesktopW returned 0 after retries',
          attempts: CREATE_DESKTOP_MAX_RETRIES,
        },
        false,
      );
      throw new Error(
        `CreateDesktopW failed after ${CREATE_DESKTOP_MAX_RETRIES} attempts`,
      );
    }

    // Spawn the worker that owns ALL private-desktop interaction.
    const worker = this.workerFactory({
      desktopHandle: desktopHandle.toString(),
      desktopName,
      targetApp: config.targetApp,
      targetHwnd: config.targetHwnd,
      workerScriptPath: this.workerScriptPath,
    });

    const initMessage: DesktopWorkerRequest = {
      type: 'init',
      desktopHandle,
      desktopName,
    };
    if (config.targetApp) initMessage.targetApp = config.targetApp;
    if (config.targetHwnd !== undefined) initMessage.targetHwnd = config.targetHwnd;

    try {
      const hwnd = await this.awaitWorkerInit(worker, initMessage);
      if (!hwnd) {
        throw new Error(
          'worker reported targetHwnd=0; spawn failed or window not found',
        );
      }
      this.active = {
        desktopHandle,
        desktopName,
        worker,
        disposed: false,
      };
      this.log(
        'create_sandbox',
        { desktopName, targetHwnd: hwnd },
        true,
      );
      return {
        desktopName,
        targetHwnd: hwnd,
        dispose: (): Promise<void> => this.disposeInternal(),
      };
    } catch (err) {
      // Tear down partial state: terminate worker, close desktop.
      try {
        worker.terminate();
      } catch {
        // best effort
      }
      try {
        this.win32.closeDesktop(desktopHandle);
      } catch {
        // best effort
      }
      this.log(
        'create_sandbox',
        { desktopName, error: errorMessage(err) },
        false,
      );
      throw err;
    }
  }

  /** Tear down the active sandbox: terminate the worker, close the desktop. */
  private async disposeInternal(): Promise<void> {
    const sandbox = this.active;
    if (!sandbox || sandbox.disposed) return;
    sandbox.disposed = true;

    try {
      sandbox.worker.postMessage({ type: 'dispose' });
    } catch {
      // best effort — the worker may already be gone
    }
    try {
      sandbox.worker.terminate();
    } catch {
      // best effort
    }
    try {
      this.win32.closeDesktop(sandbox.desktopHandle);
    } catch {
      // best effort
    }
    this.log(
      'dispose_sandbox',
      { desktopName: sandbox.desktopName },
      true,
    );
    this.active = null;
  }

  // -- internals -------------------------------------------------------------

  /**
   * Post the init message and resolve with the worker's reported hwnd, or
   * reject with the worker's error. Never times out here — the caller owns
   * lifecycle timeouts; the worker is expected to respond promptly.
   */
  private async awaitWorkerInit(
    worker: DesktopWorkerLike,
    initMessage: DesktopWorkerRequest,
  ): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      worker.onMessage((msg: DesktopWorkerResponse) => {
        if (msg.type !== 'init') return;
        if (msg.ok) {
          resolve(msg.hwnd);
        } else {
          reject(new Error(msg.error));
        }
      });
      worker.postMessage(initMessage);
    });
  }

  private log(
    action: string,
    details: Record<string, unknown>,
    success: boolean,
  ): void {
    logEntry(this.sessionId, TOOL_NAME, action, details, success);
  }
}

function errorMessage(err: unknown): string {
  if (err !== null && typeof err === 'object') {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(err);
}
