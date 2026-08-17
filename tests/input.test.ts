/**
 * WindowsInputProvider tests (TDD).
 *
 * Only the PURE logic is exercised here — key-name→VK mapping, coordinate
 * conversion math, INPUT-struct building, and modifier flags — via the
 * exported pure functions and the injectable `deps` seam. No real OS
 * injection ever runs in these tests: the provider is always constructed
 * with fake deps, and the pure functions never touch user32.dll.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  InvalidKeyError,
  WindowsInputProvider,
  buildKeyPressEvents,
  buildUnicodeEvents,
  keyToVk,
  logicalToPhysical,
  modifierToVk,
  normalizeAbsolute,
  KEYEVENTF_KEYUP,
  KEYEVENTF_UNICODE,
  MOUSEEVENTF_ABSOLUTE,
  MOUSEEVENTF_LEFTDOWN,
  MOUSEEVENTF_LEFTUP,
  MOUSEEVENTF_MOVE,
} from '../src/input';
import type {
  KeyEvent,
  MouseEvent,
  WindowsInputDeps,
} from '../src/input';

/** A fake deps bundle that records injections instead of hitting the OS. */
interface FakeRecord {
  keyEvents: KeyEvent[][];
  mouseEvents: MouseEvent[];
  dpi: { dpiX: number; dpiY: number };
  screen: { width: number; height: number };
}

function makeDeps(): { record: FakeRecord; deps: WindowsInputDeps } {
  const record: FakeRecord = {
    keyEvents: [],
    mouseEvents: [],
    dpi: { dpiX: 120, dpiY: 120 },
    screen: { width: 1920, height: 1080 },
  };
  const deps: WindowsInputDeps = {
    sendKeyEvents: (events: KeyEvent[]) => {
      record.keyEvents.push(events);
    },
    sendMouseEvent: (event: MouseEvent) => {
      record.mouseEvents.push(event);
    },
    getDpiForPoint: () => record.dpi,
    virtualScreenSize: () => record.screen,
  };
  return { record, deps };
}

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

function readRaw(dir: string): string {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.ndjson'))
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
    .join('\n');
}

beforeEach(() => {
  tempDirs = [];
  logDir = makeDir('input-audit-');
  sessionId = `sess-${Math.random().toString(36).slice(2)}`;
  process.env.AUDIT_LOG_DIR = logDir;
});

afterEach(() => {
  delete process.env.AUDIT_LOG_DIR;
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('keyToVk', () => {
  it('maps named and single-character keys to their virtual-key codes', () => {
    expect(keyToVk('a')).toBe(0x41);
    expect(keyToVk('A')).toBe(0x41);
    expect(keyToVk('z')).toBe(0x5a);
    expect(keyToVk('0')).toBe(0x30);
    expect(keyToVk('9')).toBe(0x39);
    expect(keyToVk('enter')).toBe(0x0d);
    expect(keyToVk('return')).toBe(0x0d);
    expect(keyToVk('escape')).toBe(0x1b);
    expect(keyToVk('space')).toBe(0x20);
    expect(keyToVk('tab')).toBe(0x09);
    expect(keyToVk('f5')).toBe(0x74);
    expect(keyToVk('left')).toBe(0x25);
    expect(keyToVk('delete')).toBe(0x2e);
    expect(keyToVk('del')).toBe(0x2e);
  });

  it('throws InvalidKeyError for an unknown key', () => {
    expect(() => keyToVk('nonexistent')).toThrow(InvalidKeyError);
    expect(() => keyToVk('nonexistent')).toThrow('unknown key');
  });

  it('InvalidKeyError is a proper Error subclass', () => {
    const err = new InvalidKeyError('bad');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(InvalidKeyError);
    expect(err.name).toBe('InvalidKeyError');
    expect(err.code).toBe('INVALID_KEY');
  });
});

describe('buildUnicodeEvents', () => {
  it('builds KEYEVENTF_UNICODE down+up inputs for a single character', () => {
    const events = buildUnicodeEvents('A');
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ wVk: 0, wScan: 0x41, dwFlags: KEYEVENTF_UNICODE });
    expect(events[1]).toEqual({
      wVk: 0,
      wScan: 0x41,
      dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
    });
  });

  it('emits a down+up pair per UTF-16 code unit (surrogate pairs split)', () => {
    const ascii = buildUnicodeEvents('Hi');
    expect(ascii.map((e) => e.wScan)).toEqual([0x48, 0x48, 0x69, 0x69]);

    const emoji = buildUnicodeEvents('\u{1f600}');
    expect(emoji).toHaveLength(4);
    expect(emoji.map((e) => e.wScan)).toEqual([0xd83d, 0xd83d, 0xde00, 0xde00]);
    expect(emoji.every((e) => e.wVk === 0)).toBe(true);
  });
});

describe('buildKeyPressEvents', () => {
  it('wraps the main key with modifier down/up pairs and KEYEVENTF_KEYUP flags', () => {
    const events = buildKeyPressEvents('a', ['ctrl', 'shift']);
    expect(events).toHaveLength(6);
    const [ctrlDown, shiftDown, aDown, aUp, shiftUp, ctrlUp] = events;

    expect(ctrlDown).toEqual({ wVk: 0x11, wScan: 0, dwFlags: 0 }); // VK_CONTROL
    expect(shiftDown).toEqual({ wVk: 0x10, wScan: 0, dwFlags: 0 }); // VK_SHIFT
    expect(aDown).toEqual({ wVk: 0x41, wScan: 0, dwFlags: 0 });
    expect(aUp).toEqual({ wVk: 0x41, wScan: 0, dwFlags: KEYEVENTF_KEYUP });
    expect(shiftUp.dwFlags).toBe(KEYEVENTF_KEYUP);
    expect(ctrlUp.dwFlags).toBe(KEYEVENTF_KEYUP);
  });

  it('modifierToVk maps modifier names and rejects unknown ones', () => {
    expect(modifierToVk('ctrl')).toBe(0x11);
    expect(modifierToVk('alt')).toBe(0x12);
    expect(modifierToVk('win')).toBe(0x5b);
    expect(() => modifierToVk('hyper')).toThrow(InvalidKeyError);
  });
});

describe('coordinate conversion math', () => {
  it('logicalToPhysical scales by dpi/96', () => {
    expect(logicalToPhysical(100, 50, 192, 192)).toEqual({ x: 200, y: 100 });
    expect(logicalToPhysical(0, 0, 120, 120)).toEqual({ x: 0, y: 0 });
  });

  it('normalizeAbsolute maps physical pixels onto the 0..65535 range', () => {
    expect(normalizeAbsolute(0, 0, 1920, 1080)).toEqual({ x: 0, y: 0 });
    expect(normalizeAbsolute(1920, 1080, 1920, 1080)).toEqual({ x: 65535, y: 65535 });
    expect(normalizeAbsolute(960, 540, 1920, 1080)).toEqual({ x: 32768, y: 32768 });
  });
});

describe('WindowsInputProvider with injected deps (no OS injection)', () => {
  it('typeText sends unicode events and audits length without the text', async () => {
    const { record, deps } = makeDeps();
    const provider = new WindowsInputProvider({ sessionId, deps });
    const secret = 'super-secret-password';

    await provider.typeText(secret);

    expect(record.keyEvents).toHaveLength(1);
    expect(record.keyEvents[0].length).toBe(secret.length * 2);
    expect(record.keyEvents[0][0].dwFlags).toBe(KEYEVENTF_UNICODE);

    const entries = readEntries(logDir).filter((e) => e.sessionId === sessionId);
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe('type_text');
    expect(entries[0].success).toBe(true);
    expect(readRaw(logDir)).not.toContain(secret);
  });

  it('mouseClick emits move + down + up absolute events for the button', async () => {
    const { record, deps } = makeDeps();
    const provider = new WindowsInputProvider({ sessionId, deps });

    await provider.mouseClick(100, 100, 'left');

    expect(record.mouseEvents).toHaveLength(3);
    const [move, down, up] = record.mouseEvents;
    // logical (100,100) at 120 dpi -> physical (125,125); normalized over a
    // 1920x1080 virtual screen: x=round(125*65535/1920)=4267, y=round(.../1080)=7585.
    expect(move.dx).toBe(4267);
    expect(move.dy).toBe(7585);
    expect(move.dwFlags & MOUSEEVENTF_MOVE).not.toBe(0);
    expect(move.dwFlags & MOUSEEVENTF_ABSOLUTE).not.toBe(0);
    expect(down.dwFlags & MOUSEEVENTF_LEFTDOWN).not.toBe(0);
    expect(up.dwFlags & MOUSEEVENTF_LEFTUP).not.toBe(0);
    expect(up.dwFlags & MOUSEEVENTF_ABSOLUTE).not.toBe(0);
  });

  it('keyPress with an unknown key audits success=false and rethrows', async () => {
    const { deps } = makeDeps();
    const provider = new WindowsInputProvider({ sessionId, deps });

    await expect(provider.keyPress('nope', [])).rejects.toBeInstanceOf(
      InvalidKeyError,
    );

    const entries = readEntries(logDir).filter((e) => e.sessionId === sessionId);
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe('key_press');
    expect(entries[0].success).toBe(false);
  });
});
