/**
 * PostMessageInputProvider — sandbox-isolated input injection.
 *
 * Delivers mouse and keyboard events directly to a target window's message
 * queue via PostMessageW/SendMessageW, WITHOUT entering the system input
 * stream. This means the user's real mouse and keyboard are 100% untouched.
 *
 * WM_LBUTTONDOWN/UP and WM_MOUSEMOVE expect CLIENT coordinates (relative to
 * the target window's client area), so ScreenToClient is called before
 * MAKELPARAM.
 */

import * as koffi from 'koffi';

import { logEntry } from './audit';
import type { InputProvider } from './platform/input';

const TOOL_NAME = 'input-postmessage';

// Windows message constants
const WM_MOUSEMOVE = 0x0200;
const WM_LBUTTONDOWN = 0x0201;
const WM_LBUTTONUP = 0x0202;
const WM_RBUTTONDOWN = 0x0204;
const WM_RBUTTONUP = 0x0205;
const WM_MBUTTONDOWN = 0x0207;
const WM_MBUTTONUP = 0x0208;
const WM_KEYDOWN = 0x0100;
const WM_KEYUP = 0x0101;
const WM_CHAR = 0x0102;

// Mouse button state flags for WPARAM
const MK_LBUTTON = 0x0001;
const MK_RBUTTON = 0x0002;
const MK_MBUTTON = 0x0010;

// Key-name → virtual-key code table (reused from input.ts)
const NAMED_KEYS: Record<string, number> = {
  backspace: 0x08, tab: 0x09, enter: 0x0d, return: 0x0d,
  shift: 0x10, ctrl: 0x11, control: 0x11, alt: 0x12,
  pause: 0x13, caps: 0x14, capslock: 0x14, esc: 0x1b, escape: 0x1b,
  space: 0x20, pageup: 0x21, pgup: 0x21, pagedown: 0x22, pgdn: 0x22,
  end: 0x23, home: 0x24, left: 0x25, arrowleft: 0x25, up: 0x26, arrowup: 0x26,
  right: 0x27, arrowright: 0x27, down: 0x28, arrowdown: 0x28,
  printscreen: 0x2c, prtsc: 0x2c, insert: 0x2d, ins: 0x2d,
  delete: 0x2e, del: 0x2e, win: 0x5b, windows: 0x5b, meta: 0x5b,
  numlock: 0x90, scrolllock: 0x91,
  ';': 0xba, '=': 0xbb, ',': 0xbc, '-': 0xbd, '.': 0xbe, '/': 0xbf,
  '`': 0xc0, '[': 0xdb, '\\': 0xdc, ']': 0xdd, "'": 0xde,
};
for (let i = 1; i <= 24; i++) { NAMED_KEYS[`f${i}`] = 0x6f + i; }

const MODIFIER_KEYS: Record<string, number> = {
  shift: 0x10, ctrl: 0x11, control: 0x11, alt: 0x12, win: 0x5b, windows: 0x5b,
};

export class InvalidKeyError extends Error {
  readonly code = 'INVALID_KEY';
  constructor(key: string) {
    super(`unknown key: ${JSON.stringify(key)}`);
    this.name = 'InvalidKeyError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Injectable deps seam for testing. */
export interface PostMessageDeps {
  postMessageW(hwnd: number, msg: number, wParam: bigint, lParam: number): void;
  sendMessageW(hwnd: number, msg: number, wParam: bigint, lParam: number): bigint;
  screenToClient(hwnd: number, x: number, y: number): { x: number; y: number };
  vkKeyScanW(ch: string): number;
}

export function makeLParam(x: number, y: number): number {
  return ((y << 16) | (x & 0xffff)) >>> 0;
}

export function keyToVk(key: string): number {
  const lower = key.toLowerCase();
  if (NAMED_KEYS[lower] !== undefined) return NAMED_KEYS[lower];
  if (key.length === 1) {
    const code = key.toUpperCase().charCodeAt(0);
    if (code >= 0x30 && code <= 0x39) return code;
    if (code >= 0x41 && code <= 0x5a) return code;
  }
  throw new InvalidKeyError(key);
}

export function modifierToVk(mod: string): number {
  const lower = mod.toLowerCase();
  if (MODIFIER_KEYS[lower] !== undefined) return MODIFIER_KEYS[lower];
  throw new InvalidKeyError(mod);
}

function createRealDeps(): PostMessageDeps {
  const user32 = koffi.load('user32.dll');
  const PostMessageW = user32.func('bool PostMessageW(void *hWnd, uint32 Msg, uintptr_t wParam, int32 lParam)');
  const SendMessageW = user32.func('int64 SendMessageW(void *hWnd, uint32 Msg, uintptr_t wParam, int32 lParam)');
  const ScreenToClient = user32.func('bool ScreenToClient(void *hWnd, int32 *lpPoint)');
  const VkKeyScanW = user32.func('int16 VkKeyScanW(uint16 ch)');
  return {
    postMessageW(hwnd, msg, wParam, lParam) {
      PostMessageW(BigInt(hwnd), msg, wParam, lParam);
    },
    sendMessageW(hwnd, msg, wParam, lParam) {
      return BigInt(SendMessageW(BigInt(hwnd), msg, wParam, lParam));
    },
    screenToClient(hwnd, x, y) {
      const buf = Buffer.alloc(8);
      buf.writeInt32LE(x, 0);
      buf.writeInt32LE(y, 4);
      ScreenToClient(BigInt(hwnd), buf);
      return { x: buf.readInt32LE(0), y: buf.readInt32LE(4) };
    },
    vkKeyScanW(ch) {
      return Number(VkKeyScanW(ch.charCodeAt(0)));
    },
  };
}

const MOUSE_BUTTON_FLAGS: Record<string, { down: number; up: number; mk: number }> = {
  left: { down: WM_LBUTTONDOWN, up: WM_LBUTTONUP, mk: MK_LBUTTON },
  right: { down: WM_RBUTTONDOWN, up: WM_RBUTTONUP, mk: MK_RBUTTON },
  middle: { down: WM_MBUTTONDOWN, up: WM_MBUTTONUP, mk: MK_MBUTTON },
};

export interface PostMessageInputProviderOptions {
  targetHwnd: number;
  sessionId: string;
  deps?: PostMessageDeps;
}

export class PostMessageInputProvider implements InputProvider {
  private readonly targetHwnd: number;
  private readonly sessionId: string;
  private readonly deps: PostMessageDeps;

  constructor(options: PostMessageInputProviderOptions) {
    this.targetHwnd = options.targetHwnd;
    this.sessionId = options.sessionId;
    this.deps = options.deps ?? createRealDeps();
  }

  async mouseClick(x: number, y: number, button: string): Promise<void> {
    const flags = MOUSE_BUTTON_FLAGS[button.toLowerCase()];
    if (!flags) throw new InvalidKeyError(button);
    const client = this.deps.screenToClient(this.targetHwnd, x, y);
    const lParam = makeLParam(client.x, client.y);
    this.deps.postMessageW(this.targetHwnd, flags.down, BigInt(flags.mk), lParam);
    this.deps.postMessageW(this.targetHwnd, flags.up, BigInt(0), lParam);
    logEntry(this.sessionId, TOOL_NAME, 'mouse_click', { x, y, button, hwnd: this.targetHwnd }, true);
  }

  async mouseMove(x: number, y: number): Promise<void> {
    const client = this.deps.screenToClient(this.targetHwnd, x, y);
    const lParam = makeLParam(client.x, client.y);
    this.deps.postMessageW(this.targetHwnd, WM_MOUSEMOVE, BigInt(0), lParam);
    logEntry(this.sessionId, TOOL_NAME, 'mouse_move', { x, y, hwnd: this.targetHwnd }, true);
  }

  async keyPress(key: string, modifiers: string[]): Promise<void> {
    const vk = keyToVk(key);
    const modVks = modifiers.map(modifierToVk);
    for (const mvk of modVks) {
      this.deps.postMessageW(this.targetHwnd, WM_KEYDOWN, BigInt(mvk), 0);
    }
    this.deps.postMessageW(this.targetHwnd, WM_KEYDOWN, BigInt(vk), 0);
    this.deps.postMessageW(this.targetHwnd, WM_KEYUP, BigInt(vk), 0);
    for (const mvk of modVks) {
      this.deps.postMessageW(this.targetHwnd, WM_KEYUP, BigInt(mvk), 0);
    }
    logEntry(this.sessionId, TOOL_NAME, 'key_press', { key, modifiers, hwnd: this.targetHwnd }, true);
  }

  async typeText(text: string): Promise<void> {
    for (const ch of text) {
      const vk = this.deps.vkKeyScanW(ch);
      this.deps.sendMessageW(this.targetHwnd, WM_CHAR, BigInt(vk & 0xffff), 0);
    }
    logEntry(this.sessionId, TOOL_NAME, 'type_text', { length: text.length, hwnd: this.targetHwnd }, true);
  }
}
