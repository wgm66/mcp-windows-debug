/**
 * WindowsScreenProvider tests (TDD).
 *
 * The provider captures the full screen (or a specific monitor by index) and
 * individual windows by title via node-screenshots, and appends an audit
 * entry per capture. Capture tests need an interactive desktop, so they are
 * skipped when no monitor is present (headless CI); the WindowNotFoundError
 * and audit tests run everywhere.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { Monitor } from 'node-screenshots';

import { WindowsScreenProvider, WindowNotFoundError } from '../src/screenshot';

/** PNG signature: 89 50 4E 47. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

/** True when an interactive display (≥1 monitor) is available. */
const hasDisplay = (() => {
  try {
    return Monitor.all().length > 0;
  } catch {
    return false;
  }
})();

/** `it` for tests that require a real display, `it.skip` otherwise. */
const displayIt = hasDisplay ? it : it.skip;

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

function readAllEntries(dir: string): AuditEntry[] {
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
  logDir = makeDir('shot-audit-');
  sessionId = `sess-${Math.random().toString(36).slice(2)}`;
  process.env.AUDIT_LOG_DIR = logDir;
});

afterEach(() => {
  delete process.env.AUDIT_LOG_DIR;
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('WindowsScreenProvider captureFull', () => {
  displayIt('returns a valid PNG with the monitor dimensions', async () => {
    const provider = new WindowsScreenProvider({ sessionId });

    const result = await provider.captureFull();

    expect(result.png.subarray(0, 4)).toEqual(PNG_MAGIC);
    expect(result.png.length).toBeGreaterThan(1024);
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
  });

  displayIt('captures the monitor selected by index', async () => {
    const provider = new WindowsScreenProvider({ sessionId, monitorIndex: 0 });

    const result = await provider.captureFull();

    expect(result.png.subarray(0, 4)).toEqual(PNG_MAGIC);
    expect(result.png.length).toBeGreaterThan(1024);
  });
});

describe('WindowsScreenProvider captureWindow', () => {
  displayIt('captures the frontmost window for an empty title', async () => {
    const provider = new WindowsScreenProvider({ sessionId });

    const result = await provider.captureWindow('');

    expect(result.png.subarray(0, 4)).toEqual(PNG_MAGIC);
    expect(result.png.length).toBeGreaterThan(0);
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
  });

  it('throws WindowNotFoundError for a nonexistent title', async () => {
    const provider = new WindowsScreenProvider({ sessionId });
    const missing = `__no_such_window_${Date.now()}__`;

    await expect(provider.captureWindow(missing)).rejects.toBeInstanceOf(
      WindowNotFoundError,
    );
  });

  it('WindowNotFoundError is a proper Error subclass', () => {
    const err = new WindowNotFoundError('x');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(WindowNotFoundError);
    expect(err.name).toBe('WindowNotFoundError');
    expect(err.code).toBe('WINDOW_NOT_FOUND');
  });
});

describe('WindowsScreenProvider audit', () => {
  displayIt('writes a success audit entry for every capture', async () => {
    const provider = new WindowsScreenProvider({ sessionId });

    await provider.captureFull();
    await provider.captureWindow('');

    const entries = readAllEntries(logDir).filter((e) => e.sessionId === sessionId);
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.toolName === 'screenshot')).toBe(true);
    expect(entries.every((e) => e.success === true)).toBe(true);
    expect(entries.map((e) => e.action).sort()).toEqual(
      ['capture_full', 'capture_window'].sort(),
    );
  });

  it('records a window-not-found as success=false', async () => {
    const provider = new WindowsScreenProvider({ sessionId });
    const missing = `__no_such_window_${Date.now()}__`;

    await expect(provider.captureWindow(missing)).rejects.toBeInstanceOf(
      WindowNotFoundError,
    );

    const entries = readAllEntries(logDir).filter((e) => e.sessionId === sessionId);
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe('capture_window');
    expect(entries[0].success).toBe(false);
  });
});
