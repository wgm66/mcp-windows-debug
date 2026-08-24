/**
 * Windows backend of InputProvider.
 *
 * Injects mouse and keyboard events through koffi + user32's `SendInput`
 * (`keybd_event` / `mouse_event` are never used). The process is made
 * per-monitor DPI aware once (`DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2`);
 * logical coordinates are converted to physical pixels via `GetDpiForMonitor`
 * before being normalized for `MOUSEEVENTF_ABSOLUTE`. Every injection appends
 * an audit entry via `logEntry`; typed text content is never logged.
 */

import * as koffi from 'koffi';

import { logEntry } from './audit';
import type { InputProvider } from './platform/input';

/** Tool name reported to the audit log. */
const TOOL_NAME = 'input';

// ---------------------------------------------------------------------------
// Windows constants
// ---------------------------------------------------------------------------

/** INPUT.type values. */
const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;

/** KEYEVENTF_* flags. */
export const KEYEVENTF_EXTENDEDKEY = 0x0001;
export const KEYEVENTF_KEYUP = 0x0002;
export const KEYEVENTF_UNICODE = 0x0004;
export const KEYEVENTF_SCANCODE = 0x0008;

/** MOUSEEVENTF_* flags. */
export const MOUSEEVENTF_MOVE = 0x0001;
export const MOUSEEVENTF_LEFTDOWN = 0x0002;
export const MOUSEEVENTF_LEFTUP = 0x0004;
export const MOUSEEVENTF_RIGHTDOWN = 0x0008;
export const MOUSEEVENTF_RIGHTUP = 0x0010;
export const MOUSEEVENTF_MIDDLEDOWN = 0x0020;
export const MOUSEEVENTF_MIDDLEUP = 0x0040;
export const MOUSEEVENTF_ABSOLUTE = 0x8000;

/** DPI-awareness context handle for per-monitor-aware-v2 (value -4). */
const DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4;
/** MDT_EFFECTIVE_DPI. */
const MDT_EFFECTIVE_DPI = 0;
/** MONITOR_DEFAULTTONEAREST. */
const MONITOR_DEFAULTTONEAREST = 2;
/** GetSystemMetrics indices for the virtual screen size. */
const SM_CXVIRTUALSCREEN = 78;
const SM_CYVIRTUALSCREEN = 79;

// ---------------------------------------------------------------------------
// Key-name → virtual-key mapping (pure)
// ---------------------------------------------------------------------------

/** Named keys that do not map to a single printable ASCII code point. */
const NAMED_KEYS: Record<string, number> = {
  backspace: 0x08,
  tab: 0x09,
  enter: 0x0d,
  return: 0x0d,
  shift: 0x10,
  ctrl: 0x11,
  control: 0x11,
  alt: 0x12,
  pause: 0x13,
  caps: 0x14,
  capslock: 0x14,
  esc: 0x1b,
  escape: 0x1b,
  space: 0x20,
  pageup: 0x21,
  pgup: 0x21,
  pagedown: 0x22,
  pgdn: 0x22,
  end: 0x23,
  home: 0x24,
  left: 0x25,
  arrowleft: 0x25,
  up: 0x26,
  arrowup: 0x26,
  right: 0x27,
  arrowright: 0x27,
  down: 0x28,
  arrowdown: 0x28,
  printscreen: 0x2c,
  prtsc: 0x2c,
  insert: 0x2d,
  ins: 0x2d,
  delete: 0x2e,
  del: 0x2e,
  win: 0x5b,
  windows: 0x5b,
  meta: 0x5b,
  super: 0x5b,
  cmd: 0x5b,
  command: 0x5b,
  numlock: 0x90,
  scrolllock: 0x91,
  ';': 0xba,
  '=': 0xbb,
  ',': 0xbc,
  '-': 0xbd,
  '.': 0xbe,
  '/': 0xbf,
  '`': 0xc0,
  '[': 0xdb,
  '\\': 0xdc,
  ']': 0xdd,
  "'": 0xde,
};

// Function keys F1..F24 (VK_F1 = 0x70 .. VK_F24 = 0x87).
for (let i = 1; i <= 24; i++) {
  NAMED_KEYS[`f${i}`] = 0x6f + i;
}

/** Modifier names → virtual-key code. */
const MODIFIER_KEYS: Record<string, number> = {
  ctrl: 0x11,
  control: 0x11,
  shift: 0x10,
  alt: 0x12,
  win: 0x5b,
  windows: 0x5b,
  meta: 0x5b,
  super: 0x5b,
  cmd: 0x5b,
  command: 0x5b,
};

/** Raised when a key or modifier name cannot be resolved to a virtual key. */
export class InvalidKeyError extends Error {
  readonly code = 'INVALID_KEY';
  constructor(key: string) {
    super(`unknown key: ${JSON.stringify(key)}`);
    this.name = 'InvalidKeyError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Map a key name (or single printable ASCII char) to its virtual-key code. */
export function keyToVk(key: string): number {
  if (key.length === 1) {
    const code = key.toUpperCase().charCodeAt(0);
    if ((code >= 0x41 && code <= 0x5a) || (code >= 0x30 && code <= 0x39)) {
      return code;
    }
  }
  const vk = NAMED_KEYS[key.toLowerCase()];
  if (vk === undefined) throw new InvalidKeyError(key);
  return vk;
}

/** Map a modifier name to its virtual-key code. */
export function modifierToVk(modifier: string): number {
  const vk = MODIFIER_KEYS[modifier.toLowerCase()];
  if (vk === undefined) throw new InvalidKeyError(modifier);
  return vk;
}

// ---------------------------------------------------------------------------
// INPUT-struct building (pure)
// ---------------------------------------------------------------------------

/** One keyboard input event (maps 1:1 to a KEYBDINPUT). */
export interface KeyEvent {
  wVk: number;
  wScan: number;
  dwFlags: number;
}

/** One mouse input event (maps 1:1 to a MOUSEINPUT). */
export interface MouseEvent {
  dx: number;
  dy: number;
  mouseData: number;
  dwFlags: number;
}

/**
 * Build the down/up sequence for a key press, holding each modifier around
 * the main key (modifiers are released in reverse order).
 */
export function buildKeyPressEvents(key: string, modifiers: string[]): KeyEvent[] {
  const mainVk = keyToVk(key);
  const modVks = modifiers.map(modifierToVk);
  const events: KeyEvent[] = [];
  for (const vk of modVks) {
    events.push({ wVk: vk, wScan: 0, dwFlags: 0 });
  }
  events.push({ wVk: mainVk, wScan: 0, dwFlags: 0 });
  events.push({ wVk: mainVk, wScan: 0, dwFlags: KEYEVENTF_KEYUP });
  for (const vk of [...modVks].reverse()) {
    events.push({ wVk: vk, wScan: 0, dwFlags: KEYEVENTF_KEYUP });
  }
  return events;
}

/**
 * Build KEYEVENTF_UNICODE down/up pairs, one pair per UTF-16 code unit, so
 * astral-plane characters split into their surrogate halves as SendInput
 * requires.
 */
export function buildUnicodeEvents(text: string): KeyEvent[] {
  const events: KeyEvent[] = [];
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    events.push({ wVk: 0, wScan: unit, dwFlags: KEYEVENTF_UNICODE });
    events.push({ wVk: 0, wScan: unit, dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP });
  }
  return events;
}

// ---------------------------------------------------------------------------
// Coordinate conversion (pure)
// ---------------------------------------------------------------------------

export interface Point {
  x: number;
  y: number;
}
export interface Dpi {
  dpiX: number;
  dpiY: number;
}
export interface Size {
  width: number;
  height: number;
}

/** Convert logical (96-DPI) coordinates to physical pixels. */
export function logicalToPhysical(x: number, y: number, dpiX: number, dpiY: number): Point {
  return { x: (x * dpiX) / 96, y: (y * dpiY) / 96 };
}

/** Normalize physical pixels onto the 0..65535 absolute range. */
export function normalizeAbsolute(x: number, y: number, screenW: number, screenH: number): Point {
  return {
    x: Math.round((x * 65535) / screenW),
    y: Math.round((y * 65535) / screenH),
  };
}

/** Mouse button → down/up flag pair. */
const MOUSE_BUTTONS: Record<string, { down: number; up: number }> = {
  left: { down: MOUSEEVENTF_LEFTDOWN, up: MOUSEEVENTF_LEFTUP },
  right: { down: MOUSEEVENTF_RIGHTDOWN, up: MOUSEEVENTF_RIGHTUP },
  middle: { down: MOUSEEVENTF_MIDDLEDOWN, up: MOUSEEVENTF_MIDDLEUP },
};

function mouseButtonFlags(button: string): { down: number; up: number } {
  const flags = MOUSE_BUTTONS[button.toLowerCase()];
  if (!flags) throw new Error(`unknown mouse button: ${JSON.stringify(button)}`);
  return flags;
}

// ---------------------------------------------------------------------------
// Runtime deps (koffi → user32/shcore) — lazily initialized
// ---------------------------------------------------------------------------

export interface WindowsInputDeps {
  sendKeyEvents(events: KeyEvent[]): void;
  sendMouseEvent(event: MouseEvent): void;
  getDpiForPoint(x: number, y: number): Dpi;
  virtualScreenSize(): Size;
}

// koffi type definitions for the Windows INPUT structure (x64 layout verified:
// sizeof INPUT = 40). These are pure registrations — no DLL is loaded here.
const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
  dx: 'int32',
  dy: 'int32',
  mouseData: 'uint32',
  dwFlags: 'uint32',
  time: 'uint32',
  dwExtraInfo: 'uintptr',
});
const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
  wVk: 'uint16',
  wScan: 'uint16',
  dwFlags: 'uint32',
  time: 'uint32',
  dwExtraInfo: 'uintptr',
});
const HARDWAREINPUT = koffi.struct('HARDWAREINPUT', {
  uMsg: 'uint32',
  wParamL: 'uint16',
  wParamH: 'uint16',
});
const INPUT_UNION = koffi.union('INPUT_UNION', {
  mi: MOUSEINPUT,
  ki: KEYBDINPUT,
  hi: HARDWAREINPUT,
});
const INPUT = koffi.struct('INPUT', { type: 'uint32', u: INPUT_UNION });
const POINT = koffi.struct('POINT', { x: 'int32', y: 'int32' });

/** sizeof(INPUT) on x64 (verified against koffi.sizeof). */
const INPUT_SIZE = koffi.sizeof(INPUT);

interface RealContext {
  sendInput(inputs: unknown[]): void;
  getDpiForPoint(x: number, y: number): Dpi;
  virtualScreenSize(): Size;
}

let realContext: RealContext | undefined;
let dpiAwarenessSet = false;

function initRealContext(): RealContext {
  const user32 = koffi.load('user32.dll');
  const shcore = koffi.load('shcore.dll');

  const SetProcessDpiAwarenessContext = user32.func(
    'bool SetProcessDpiAwarenessContext(void *value)',
  );
  // Per-monitor-aware-v2, once per process (idempotent, best-effort).
  if (!dpiAwarenessSet) {
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    dpiAwarenessSet = true;
  }

  const SendInput = user32.func(
    'uint32 SendInput(uint32 cInputs, INPUT *pInputs, int cbSize)',
  );
  const GetSystemMetrics = user32.func('int32 GetSystemMetrics(int32 nIndex)');
  const MonitorFromPoint = user32.func('MonitorFromPoint', 'void *', [POINT, 'uint32']);
  const GetDpiForMonitor = shcore.func(
    'int32 GetDpiForMonitor(void *hmonitor, int32 dpiType, uint32 *dpiX, uint32 *dpiY)',
  );

  return {
    sendInput(inputs: unknown[]): void {
      const inserted = SendInput(inputs.length, inputs, INPUT_SIZE);
      if (inserted !== inputs.length) {
        throw new Error(`SendInput inserted ${inserted}/${inputs.length} events`);
      }
    },
    getDpiForPoint(x: number, y: number): Dpi {
      const monitor = MonitorFromPoint(
        { x: Math.round(x), y: Math.round(y) },
        MONITOR_DEFAULTTONEAREST,
      );
      const buf = Buffer.alloc(8);
      const hr = GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, buf, buf.subarray(4));
      if (hr !== 0) {
        throw new Error(`GetDpiForMonitor failed: HRESULT 0x${(hr >>> 0).toString(16)}`);
      }
      return { dpiX: buf.readUInt32LE(0), dpiY: buf.readUInt32LE(4) };
    },
    virtualScreenSize(): Size {
      return {
        width: GetSystemMetrics(SM_CXVIRTUALSCREEN),
        height: GetSystemMetrics(SM_CYVIRTUALSCREEN),
      };
    },
  };
}

function createRealDeps(): WindowsInputDeps {
  function ensure(): RealContext {
    if (!realContext) realContext = initRealContext();
    return realContext;
  }
  return {
    sendKeyEvents(events: KeyEvent[]): void {
      ensure().sendInput(events.map(toKeyInput));
    },
    sendMouseEvent(event: MouseEvent): void {
      ensure().sendInput([toMouseInput(event)]);
    },
    getDpiForPoint(x: number, y: number): Dpi {
      return ensure().getDpiForPoint(x, y);
    },
    virtualScreenSize(): Size {
      return ensure().virtualScreenSize();
    },
  };
}

/** Convert a KeyEvent into a koffi INPUT object (KEYBDINPUT). */
function toKeyInput(event: KeyEvent): unknown {
  return {
    type: INPUT_KEYBOARD,
    u: {
      ki: { wVk: event.wVk, wScan: event.wScan, dwFlags: event.dwFlags, time: 0, dwExtraInfo: 0 },
    },
  };
}

/** Convert a MouseEvent into a koffi INPUT object (MOUSEINPUT). */
function toMouseInput(event: MouseEvent): unknown {
  return {
    type: INPUT_MOUSE,
    u: {
      mi: {
        dx: event.dx,
        dy: event.dy,
        mouseData: event.mouseData,
        dwFlags: event.dwFlags,
        time: 0,
        dwExtraInfo: 0,
      },
    },
  };
}

function errorMessage(err: unknown): string {
  if (err !== null && typeof err === 'object') {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(err);
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface WindowsInputProviderOptions {
  sessionId: string;
  /** Injectable seams; defaults to the real koffi/SendInput backend. */
  deps?: WindowsInputDeps;
}

export class WindowsInputProvider implements InputProvider {
  private readonly sessionId: string;
  private readonly deps: WindowsInputDeps;

  constructor(options: WindowsInputProviderOptions) {
    this.sessionId = options.sessionId;
    this.deps = options.deps ?? createRealDeps();
  }

  async mouseClick(x: number, y: number, button: string): Promise<void> {
    try {
      const flags = mouseButtonFlags(button);
      const norm = this.toAbsolute(x, y);
      this.deps.sendMouseEvent({
        dx: norm.x,
        dy: norm.y,
        mouseData: 0,
        dwFlags: MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE,
      });
      this.deps.sendMouseEvent({
        dx: norm.x,
        dy: norm.y,
        mouseData: 0,
        dwFlags: flags.down | MOUSEEVENTF_ABSOLUTE,
      });
      this.deps.sendMouseEvent({
        dx: norm.x,
        dy: norm.y,
        mouseData: 0,
        dwFlags: flags.up | MOUSEEVENTF_ABSOLUTE,
      });
      this.log('mouse_click', { x, y, button }, true);
    } catch (err) {
      this.log('mouse_click', { x, y, button, error: errorMessage(err) }, false);
      throw err;
    }
  }

  async mouseMove(x: number, y: number): Promise<void> {
    try {
      const norm = this.toAbsolute(x, y);
      this.deps.sendMouseEvent({
        dx: norm.x,
        dy: norm.y,
        mouseData: 0,
        dwFlags: MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE,
      });
      this.log('mouse_move', { x, y }, true);
    } catch (err) {
      this.log('mouse_move', { x, y, error: errorMessage(err) }, false);
      throw err;
    }
  }

  async keyPress(key: string, modifiers: string[]): Promise<void> {
    try {
      this.deps.sendKeyEvents(buildKeyPressEvents(key, modifiers));
      this.log('key_press', { key, modifiers }, true);
    } catch (err) {
      this.log('key_press', { key, modifiers, error: errorMessage(err) }, false);
      throw err;
    }
  }

  async typeText(text: string): Promise<void> {
    try {
      this.deps.sendKeyEvents(buildUnicodeEvents(text));
      // Length only — the typed text content is never logged.
      this.log('type_text', { length: text.length }, true);
    } catch (err) {
      this.log('type_text', { length: text.length, error: errorMessage(err) }, false);
      throw err;
    }
  }

  /** Convert logical coordinates to the 0..65535 absolute range. */
  private toAbsolute(x: number, y: number): Point {
    const dpi = this.deps.getDpiForPoint(x, y);
    const physical = logicalToPhysical(x, y, dpi.dpiX, dpi.dpiY);
    const size = this.deps.virtualScreenSize();
    return normalizeAbsolute(physical.x, physical.y, size.width, size.height);
  }

  private log(action: string, details: Record<string, unknown>, success: boolean): void {
    logEntry(this.sessionId, TOOL_NAME, action, details, success);
  }
}
