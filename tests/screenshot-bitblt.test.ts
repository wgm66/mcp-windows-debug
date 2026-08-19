/**
 * BitBltScreenProvider tests (TDD).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { BitBltScreenProvider, encodePng } from '../src/screenshot-bitblt';
import type { BitBltDeps } from '../src/screenshot-bitblt';

function makeFakeDeps(overrides: Partial<BitBltDeps> = {}): BitBltDeps {
  return {
    printWindow: () => true,
    getClientRect: () => ({ width: 2, height: 2 }),
    createCompatibleDC: () => 100,
    createCompatibleBitmap: () => 200,
    selectObject: () => 0,
    getDIBits: () => 2,
    deleteDC: () => true,
    deleteObject: () => true,
    findWindowEx: () => 42,
    ...overrides,
  };
}

describe('encodePng pure logic', () => {
  it('produces valid PNG with magic bytes', () => {
    const bgra = Buffer.alloc(4 * 4); // 2x2 BGRA
    const png = encodePng(2, 2, bgra);
    expect(png[0]).toBe(0x89);
    expect(png[1]).toBe(0x50);
    expect(png[2]).toBe(0x4e);
    expect(png[3]).toBe(0x47);
  });

  it('produces correct IHDR dimensions', () => {
    const bgra = Buffer.alloc(6 * 4);
    const png = encodePng(3, 2, bgra);
    expect(png.readUInt32BE(16)).toBe(3); // width at IHDR offset
    expect(png.readUInt32BE(20)).toBe(2); // height
  });
});

describe('BitBltScreenProvider', () => {
  let logDir: string;
  let sessionId: string;

  beforeEach(() => {
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitblt-test-'));
    sessionId = 'bb-' + Date.now();
    process.env.AUDIT_LOG_DIR = logDir;
  });

  afterEach(() => {
    delete process.env.AUDIT_LOG_DIR;
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  it('captureFull returns valid PNG', async () => {
    const deps = makeFakeDeps({ getDIBits: (_hdc, _hbmp, _s, _sl, buf, _bi) => { buf.fill(0xff); return 2; } });
    const provider = new BitBltScreenProvider({ targetHwnd: 1, sessionId, deps });
    const result = await provider.captureFull();
    expect(result.width).toBe(2);
    expect(result.height).toBe(2);
    expect(result.png[0]).toBe(0x89);
    expect(result.png[1]).toBe(0x50);
  });

  it('captureWindow finds window and captures', async () => {
    const deps = makeFakeDeps({ findWindowEx: () => 99, getDIBits: (_h, _b, _s, _sl, buf, _bi) => { buf.fill(0); return 2; } });
    const provider = new BitBltScreenProvider({ targetHwnd: 1, sessionId, deps });
    const result = await provider.captureWindow('test');
    expect(result.png.length).toBeGreaterThan(8);
  });

  it('throws BitBltError when window not found', async () => {
    const deps = makeFakeDeps({ findWindowEx: () => 0 });
    const provider = new BitBltScreenProvider({ targetHwnd: 1, sessionId, deps });
    await expect(provider.captureWindow('missing')).rejects.toMatchObject({ name: 'BitBltError', code: 'BITBLT_ERROR' });
  });

  it('throws BitBltError when PrintWindow fails', async () => {
    const deps = makeFakeDeps({ printWindow: () => false });
    const provider = new BitBltScreenProvider({ targetHwnd: 1, sessionId, deps });
    await expect(provider.captureFull()).rejects.toMatchObject({ name: 'BitBltError', code: 'BITBLT_ERROR' });
  });

  it('throws BitBltError on zero-size window', async () => {
    const deps = makeFakeDeps({ getClientRect: () => ({ width: 0, height: 0 }) });
    const provider = new BitBltScreenProvider({ targetHwnd: 1, sessionId, deps });
    await expect(provider.captureFull()).rejects.toMatchObject({ name: 'BitBltError', code: 'BITBLT_ERROR' });
  });

  it('audit log entry written per capture', async () => {
    const deps = makeFakeDeps({ getDIBits: (_h, _b, _s, _sl, buf, _bi) => { buf.fill(0); return 2; } });
    const provider = new BitBltScreenProvider({ targetHwnd: 1, sessionId, deps });
    await provider.captureFull();
    const files = fs.readdirSync(logDir).filter(function (f) { return f.endsWith('.ndjson'); });
    expect(files.length).toBeGreaterThanOrEqual(1);
  });
});
