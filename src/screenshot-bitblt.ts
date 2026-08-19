/**
 * BitBltScreenProvider — captures windows on a private (non-input) Win32 desktop
 * via PrintWindow + BitBlt, since node-screenshots only captures the input desktop.
 *
 * Known limitation: PrintWindow sends WM_PRINT/WM_PRINTCLIENT; it fails for
 * Direct3D/OpenGL/hardware-accelerated windows (games, some UWP, Electron GPU).
 */

import * as zlib from 'zlib';

import * as koffi from 'koffi';

import { logEntry } from './audit';
import type { CaptureResult, ScreenProvider } from './platform/screen';

const TOOL_NAME = 'screenshot-bitblt';
const PW_RENDERFULLCONTENT = 2;

export class BitBltError extends Error {
  readonly code = 'BITBLT_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'BitBltError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface BitBltDeps {
  printWindow(hwnd: number, hdcMem: number, flags: number): boolean;
  getClientRect(hwnd: number): { width: number; height: number } | null;
  createCompatibleDC(hdc: number): number;
  createCompatibleBitmap(hdc: number, width: number, height: number): number;
  selectObject(hdc: number, hobj: number): number;
  getDIBits(hdc: number, hbmp: number, startScan: number, scanLines: number, lpvBits: Buffer, lpbi: Buffer): number;
  deleteDC(hdc: number): boolean;
  deleteObject(hobj: number): boolean;
  findWindowEx(parentHwnd: number, childAfter: number, className: string | null, windowName: string | null): number;
}

function createRealDeps(): BitBltDeps {
  const user32 = koffi.load('user32.dll');
  const gdi32 = koffi.load('gdi32.dll');
  const PrintWindow = user32.func('bool PrintWindow(void *hwnd, void *hdcMem, uint32 nFlags)');
  const GetClientRect = user32.func('bool GetClientRect(void *hWnd, void *lpRect)');
  const CreateCompatibleDC = gdi32.func('void * CreateCompatibleDC(void *hdc)');
  const CreateCompatibleBitmap = gdi32.func('void * CreateCompatibleBitmap(void *hdc, int32 width, int32 height)');
  const SelectObject = gdi32.func('void * SelectObject(void *hdc, void *hobj)');
  const GetDIBits = gdi32.func('int32 GetDIBits(void *hdc, void *hbmp, uint32 startScan, uint32 scanLines, void *lpvBits, void *lpbi)');
  const DeleteDC = gdi32.func('bool DeleteDC(void *hdc)');
  const DeleteObject = gdi32.func('bool DeleteObject(void *hobj)');
  const FindWindowExW = user32.func('void * FindWindowExW(void *parent, void *childAfter, str16 className, str16 windowName)');

  return {
    printWindow(hwnd, hdcMem, flags) { return PrintWindow(BigInt(hwnd), BigInt(hdcMem), flags); },
    getClientRect(hwnd) {
      const buf = Buffer.alloc(16);
      if (!GetClientRect(BigInt(hwnd), buf)) return null;
      return { width: buf.readInt32LE(8) - buf.readInt32LE(0), height: buf.readInt32LE(12) - buf.readInt32LE(4) };
    },
    createCompatibleDC(hdc) { return Number(CreateCompatibleDC(BigInt(hdc))); },
    createCompatibleBitmap(hdc, width, height) { return Number(CreateCompatibleBitmap(BigInt(hdc), width, height)); },
    selectObject(hdc, hobj) { return Number(SelectObject(BigInt(hdc), BigInt(hobj))); },
    getDIBits(hdc, hbmp, _startScan, scanLines, lpvBits, lpbi) { return GetDIBits(BigInt(hdc), BigInt(hbmp), 0, scanLines, lpvBits, lpbi); },
    deleteDC(hdc) { return DeleteDC(BigInt(hdc)); },
    deleteObject(hobj) { return DeleteObject(BigInt(hobj)); },
    findWindowEx(parentHwnd, childAfter, className, windowName) {
      return Number(FindWindowExW(BigInt(parentHwnd), BigInt(childAfter), className ?? null, windowName ?? null));
    },
  };
}

export function encodePng(width: number, height: number, bgra: Buffer): Buffer {
  const rgba = Buffer.from(bgra);
  for (let i = 0; i < rgba.length; i += 4) { const b = rgba[i]; rgba[i] = rgba[i + 2]; rgba[i + 2] = b; }
  const rowSize = width * 4;
  const raw = Buffer.alloc(height * (rowSize + 1));
  for (let y = 0; y < height; y++) { raw[y * (rowSize + 1)] = 0; rgba.copy(raw, y * (rowSize + 1) + 1, y * rowSize, (y + 1) * rowSize); }
  const compressed = zlib.deflateSync(raw);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const ihdrChunk = makeChunk('IHDR', ihdr);
  const idatChunk = makeChunk('IDAT', compressed);
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));
  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function makeChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) { crc ^= buf[i]; for (let j = 0; j < 8; j++) { crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface BitBltScreenProviderOptions {
  targetHwnd: number; sessionId: string; deps?: BitBltDeps;
}

export class BitBltScreenProvider implements ScreenProvider {
  private readonly targetHwnd: number;
  private readonly sessionId: string;
  private readonly deps: BitBltDeps;

  constructor(options: BitBltScreenProviderOptions) {
    this.targetHwnd = options.targetHwnd;
    this.sessionId = options.sessionId;
    this.deps = options.deps ?? createRealDeps();
  }

  async captureFull(): Promise<CaptureResult> { return this.captureHwnd(this.targetHwnd); }

  async captureWindow(title: string): Promise<CaptureResult> {
    const hwnd = this.deps.findWindowEx(0, 0, null, title);
    if (!hwnd) throw new BitBltError(`window not found: ${title}`);
    return this.captureHwnd(hwnd);
  }

  private captureHwnd(hwnd: number): CaptureResult {
    const rect = this.deps.getClientRect(hwnd);
    if (!rect || rect.width <= 0 || rect.height <= 0) throw new BitBltError(`invalid window rect for hwnd ${hwnd}`);
    const { width, height } = rect;
    const hdcMem = this.deps.createCompatibleDC(0);
    if (!hdcMem) throw new BitBltError('CreateCompatibleDC failed');
    try {
      const hbmp = this.deps.createCompatibleBitmap(hdcMem, width, height);
      if (!hbmp) throw new BitBltError('CreateCompatibleBitmap failed');
      try {
        this.deps.selectObject(hdcMem, hbmp);
        if (!this.deps.printWindow(hwnd, hdcMem, PW_RENDERFULLCONTENT)) throw new BitBltError('PrintWindow failed (D3D/OpenGL/hardware-accelerated window)');
        const bi = Buffer.alloc(40);
        bi.writeInt32LE(40, 0); bi.writeInt32LE(width, 4); bi.writeInt32LE(height, 8); bi.writeInt16LE(1, 12); bi.writeInt16LE(32, 14);
        const pixelBuf = Buffer.alloc(width * height * 4);
        if (this.deps.getDIBits(hdcMem, hbmp, 0, height, pixelBuf, bi) === 0) throw new BitBltError('GetDIBits failed');
        const png = encodePng(width, height, pixelBuf);
        logEntry(this.sessionId, TOOL_NAME, 'capture', { hwnd, width, height, size: png.length }, true);
        return { png, width, height };
      } finally { this.deps.deleteObject(hbmp); }
    } finally { this.deps.deleteDC(hdcMem); }
  }
}
