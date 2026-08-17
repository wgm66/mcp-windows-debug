/**
 * Audit log tests (TDD).
 *
 * The audit module writes append-only NDJSON lines to
 * `<AUDIT_LOG_DIR>/audit-<sessionId>-<date>.ndjson`. Each test points
 * `AUDIT_LOG_DIR` at a fresh temp dir so runs are isolated and the real
 * `.omo/logs` is never touched.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import * as audit from '../src/audit';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'));
}

/** Read every log line for one session across all its (possibly rotated) files. */
function readAllLines(dir: string, sessionId: string): string[] {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`audit-${sessionId}-`) && f.endsWith('.ndjson'));
  const lines: string[] = [];
  for (const f of files) {
    const content = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const line of content.split('\n')) {
      if (line.trim().length > 0) lines.push(line);
    }
  }
  return lines;
}

afterEach(() => {
  delete process.env.AUDIT_LOG_DIR;
});

describe('audit logEntry', () => {
  it('appends 100 entries as 100 valid JSON lines', () => {
    const dir = tmpDir();
    process.env.AUDIT_LOG_DIR = dir;
    const sid = 'sess-hundred';

    for (let i = 0; i < 100; i++) {
      audit.logEntry(sid, 'tool', 'act', { n: i }, true);
    }

    const lines = readAllLines(dir, sid);
    expect(lines).toHaveLength(100);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes a canary string exactly N times after N calls', () => {
    const dir = tmpDir();
    process.env.AUDIT_LOG_DIR = dir;
    const sid = 'sess-canary';
    const canary = `CANARY_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const N = 3;

    for (let i = 0; i < N; i++) {
      audit.logEntry(sid, 'tool', canary, {}, true);
    }

    const all = readAllLines(dir, sid).join('\n');
    const count = all.split(canary).length - 1;
    expect(count).toBe(N);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('strips keystroke content from details (including nested)', () => {
    const dir = tmpDir();
    process.env.AUDIT_LOG_DIR = dir;
    const sid = 'sess-sanitize';

    audit.logEntry(
      sid,
      'tool',
      'act',
      { keystrokes: 'TOP-SECRET', safe: 'ok', nested: { keystrokes: 'x', keep: 1 } },
      true,
    );

    const lines = readAllLines(dir, sid);
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]) as {
      details: {
        keystrokes?: unknown;
        safe: string;
        nested: { keystrokes?: unknown; keep: number };
      };
    };
    expect(entry.details.keystrokes).toBeUndefined();
    expect(entry.details.safe).toBe('ok');
    expect(entry.details.nested.keystrokes).toBeUndefined();
    expect(entry.details.nested.keep).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('exposes no delete, truncate, or clear API', () => {
    const exports = audit as unknown as Record<string, unknown>;
    expect(exports.logEntry).toBeDefined();
    expect(exports.delete).toBeUndefined();
    expect(exports.deleteLog).toBeUndefined();
    expect(exports.truncate).toBeUndefined();
    expect(exports.clear).toBeUndefined();
  });
});
