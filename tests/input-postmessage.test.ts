/**
 * PostMessageInputProvider tests (TDD).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { PostMessageInputProvider, makeLParam, keyToVk, modifierToVk, InvalidKeyError } from '../src/input-postmessage';
import type { PostMessageDeps } from '../src/input-postmessage';

interface FakeCall { hwnd: number; msg: number; wParam: bigint; lParam: number }

function makeFakeDeps(): PostMessageDeps & { calls: FakeCall[]; sendMessageCalls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const sendMessageCalls: FakeCall[] = [];
  return {
    calls,
    sendMessageCalls,
    postMessageW(hwnd, msg, wParam, lParam) { calls.push({ hwnd, msg, wParam, lParam }); },
    sendMessageW(hwnd, msg, wParam, lParam) { sendMessageCalls.push({ hwnd, msg, wParam, lParam }); return 0n; },
    screenToClient(_hwnd, x, y) { return { x: x + 10, y: y + 20 }; },
    vkKeyScanW(ch) { return ch.charCodeAt(0); },
  } as PostMessageDeps & { calls: FakeCall[]; sendMessageCalls: FakeCall[] };
}

describe('PostMessageInputProvider pure logic', () => {
  it('makeLParam encodes x,y into low/high 16-bit', () => {
    const result = makeLParam(100, 200);
    expect(result & 0xffff).toBe(100);
    expect((result >>> 16) & 0xffff).toBe(200);
  });

  it('makeLParam handles zero', () => {
    expect(makeLParam(0, 0)).toBe(0);
  });

  it('keyToVk maps named keys', () => {
    expect(keyToVk('enter')).toBe(0x0d);
    expect(keyToVk('f5')).toBe(0x74);
    expect(keyToVk('esc')).toBe(0x1b);
  });

  it('keyToVk maps single chars', () => {
    expect(keyToVk('a')).toBe(0x41);
    expect(keyToVk('A')).toBe(0x41);
    expect(keyToVk('5')).toBe(0x35);
  });

  it('keyToVk throws InvalidKeyError for unknown', () => {
    expect(() => keyToVk('xyz')).toThrow(InvalidKeyError);
  });

  it('modifierToVk maps modifiers', () => {
    expect(modifierToVk('shift')).toBe(0x10);
    expect(modifierToVk('ctrl')).toBe(0x11);
  });

  it('modifierToVk throws InvalidKeyError for unknown', () => {
    expect(() => modifierToVk('xyz')).toThrow(InvalidKeyError);
  });
});

describe('PostMessageInputProvider injection', () => {
  let logDir: string;
  let sessionId: string;

  beforeEach(() => {
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-test-'));
    sessionId = 'pm-' + Date.now();
    process.env.AUDIT_LOG_DIR = logDir;
  });

  afterEach(() => {
    delete process.env.AUDIT_LOG_DIR;
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  it('mouseClick calls ScreenToClient then PostMessageW WM_LBUTTONDOWN+UP', async () => {
    const fake = makeFakeDeps();
    const provider = new PostMessageInputProvider({ targetHwnd: 12345, sessionId, deps: fake });
    await provider.mouseClick(500, 300, 'left');
    const expectedLParam = makeLParam(510, 320);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0].msg).toBe(0x0201);
    expect(fake.calls[1].msg).toBe(0x0202);
    expect(fake.calls[0].lParam).toBe(expectedLParam);
    expect(fake.calls[0].wParam).toBe(BigInt(1));
  });

  it('mouseMove calls PostMessageW WM_MOUSEMOVE with client coords', async () => {
    const fake = makeFakeDeps();
    const provider = new PostMessageInputProvider({ targetHwnd: 99, sessionId, deps: fake });
    await provider.mouseMove(200, 100);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].msg).toBe(0x0200);
    expect(fake.calls[0].lParam).toBe(makeLParam(210, 120));
  });

  it('keyPress sends WM_KEYDOWN+UP for key and modifiers', async () => {
    const fake = makeFakeDeps();
    const provider = new PostMessageInputProvider({ targetHwnd: 1, sessionId, deps: fake });
    await provider.keyPress('a', ['ctrl']);
    expect(fake.calls).toHaveLength(4);
    expect(fake.calls[0].msg).toBe(0x0100);
    expect(fake.calls[1].msg).toBe(0x0100);
    expect(fake.calls[2].msg).toBe(0x0101);
    expect(fake.calls[3].msg).toBe(0x0101);
  });

  it('typeText sends WM_CHAR per character via SendMessageW', async () => {
    const fake = makeFakeDeps();
    const provider = new PostMessageInputProvider({ targetHwnd: 1, sessionId, deps: fake });
    await provider.typeText('hi');
    expect(fake.sendMessageCalls).toHaveLength(2);
    expect(fake.sendMessageCalls[0].msg).toBe(0x0102);
    expect(fake.sendMessageCalls[0].wParam).toBe(BigInt('h'.charCodeAt(0)));
  });

  it('mouseClick with unknown button throws InvalidKeyError', async () => {
    const fake = makeFakeDeps();
    const provider = new PostMessageInputProvider({ targetHwnd: 1, sessionId, deps: fake });
    await expect(provider.mouseClick(0, 0, 'xyz')).rejects.toMatchObject({ name: 'InvalidKeyError', code: 'INVALID_KEY' });
  });

  it('audit log entry is written per injection', async () => {
    const fake = makeFakeDeps();
    const provider = new PostMessageInputProvider({ targetHwnd: 1, sessionId, deps: fake });
    await provider.typeText('x');
    const files = fs.readdirSync(logDir).filter(function (f) { return f.endsWith('.ndjson'); });
    expect(files.length).toBeGreaterThanOrEqual(1);
    const content = fs.readFileSync(path.join(logDir, files[0]), 'utf8');
    expect(content).toContain('type_text');
  });
});
