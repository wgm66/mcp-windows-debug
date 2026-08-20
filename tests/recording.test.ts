/**
 * SessionRecorder tests (TDD).
 *
 * The recorder writes a JSON transcript document to
 * `<RECORDING_DIR>/<sessionId>.json` with shape `{ sessionId, entries }`.
 * Each test points `RECORDING_DIR` at a fresh temp dir so the real
 * `.omo/recordings` is never touched.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { SessionRecorder } from '../src/recording';
import type { ReplayOutcome, TranscriptEntry } from '../src/recording';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'recording-test-'));
}

afterEach(() => {
  delete process.env.RECORDING_DIR;
});

describe('SessionRecorder record', () => {
  it('appends one entry per record() call, preserving order', () => {
    const dir = tmpDir();
    process.env.RECORDING_DIR = dir;
    const rec = new SessionRecorder('sess-order');

    rec.record('mouse_click', { x: 1, y: 2 }, { ok: true });
    rec.record('key_press', { key: 'Enter' }, { ok: true });
    rec.record('capture_window', { title: 'Notepad' }, { ok: true });

    const entries = rec.getTranscript();
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.toolName)).toEqual([
      'mouse_click',
      'key_press',
      'capture_window',
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes a JSON file at <RECORDING_DIR>/<sessionId>.json', () => {
    const dir = tmpDir();
    process.env.RECORDING_DIR = dir;
    const sid = 'sess-file';
    const rec = new SessionRecorder(sid);

    rec.record('mouse_click', { x: 1 }, { ok: true });

    const file = path.join(dir, `${sid}.json`);
    expect(fs.existsSync(file)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      sessionId: string;
      entries: TranscriptEntry[];
    };
    expect(parsed.sessionId).toBe(sid);
    expect(parsed.entries).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('stores timestamp, toolName, args, result per entry', () => {
    const dir = tmpDir();
    process.env.RECORDING_DIR = dir;
    const rec = new SessionRecorder('sess-fields');

    rec.record('mouse_click', { x: 5, y: 9 }, { clicked: true });

    const e = rec.getTranscript()[0];
    expect(e.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(e.toolName).toBe('mouse_click');
    expect(e.args).toEqual({ x: 5, y: 9 });
    expect(e.result).toEqual({ clicked: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('stores optional screenshotPath when provided', () => {
    const dir = tmpDir();
    process.env.RECORDING_DIR = dir;
    const rec = new SessionRecorder('sess-shot');

    rec.record('capture_window', { title: 'A' }, { size: 42 }, '.omo/shots/a.png');

    const e = rec.getTranscript()[0];
    expect(e.screenshotPath).toBe('.omo/shots/a.png');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('omits screenshotPath when not provided', () => {
    const dir = tmpDir();
    process.env.RECORDING_DIR = dir;
    const rec = new SessionRecorder('sess-noshot');

    rec.record('mouse_click', { x: 1 }, {});

    const e = rec.getTranscript()[0];
    expect(e.screenshotPath).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('strips keystroke content from args, including nested (data minimization)', () => {
    const dir = tmpDir();
    process.env.RECORDING_DIR = dir;
    const rec = new SessionRecorder('sess-sanitize-args');

    rec.record(
      'type_text',
      { text: 'TOP-SECRET', keystrokes: 'TOP-SECRET', safe: 'ok', nested: { keystrokes: 'x', keep: 1 } },
      { ok: true },
    );

    const e = rec.getTranscript()[0];
    const args = e.args as Record<string, unknown>;
    expect(args.text).toBeUndefined();
    expect(args.keystrokes).toBeUndefined();
    expect(args.safe).toBe('ok');
    expect(args.nested).toEqual({ keep: 1 });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('strips keystroke content from result too', () => {
    const dir = tmpDir();
    process.env.RECORDING_DIR = dir;
    const rec = new SessionRecorder('sess-sanitize-result');

    rec.record('key_press', { key: 'Enter' }, { ok: true, keystrokes: 'LEAKED' });

    const e = rec.getTranscript()[0];
    const result = e.result as Record<string, unknown>;
    expect(result.keystrokes).toBeUndefined();
    expect(result.ok).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('assigns monotonically increasing entry ids', () => {
    const dir = tmpDir();
    process.env.RECORDING_DIR = dir;
    const rec = new SessionRecorder('sess-ids');

    rec.record('mouse_click', { x: 1 }, {});
    rec.record('key_press', { key: 'Enter' }, {});
    rec.record('capture_window', { title: 'A' }, {});

    const ids = rec.getTranscript().map((e) => e.id);
    expect(ids).toEqual([1, 2, 3]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('SessionRecorder replay', () => {
  it('re-issues the same tool calls in the same order via executor', async () => {
    const dir = tmpDir();
    process.env.RECORDING_DIR = dir;
    const rec = new SessionRecorder('sess-replay');

    rec.record('mouse_click', { x: 1, y: 2 }, { ok: true });
    rec.record('key_press', { key: 'Enter' }, { ok: true });
    rec.record('capture_window', { title: 'Notepad' }, { ok: true });

    const calls: { toolName: string; args: Record<string, unknown> }[] = [];
    const fakeExecutor = (toolName: string, args: Record<string, unknown>): unknown => {
      calls.push({ toolName, args });
      return { echoed: toolName };
    };

    const transcriptPath = path.join(dir, 'sess-replay.json');
    const outcomes = await SessionRecorder.replay(transcriptPath, fakeExecutor);

    expect(outcomes).toHaveLength(3);
    expect(calls).toEqual([
      { toolName: 'mouse_click', args: { x: 1, y: 2 } },
      { toolName: 'key_press', args: { key: 'Enter' } },
      { toolName: 'capture_window', args: { title: 'Notepad' } },
    ]);
    expect(outcomes.every((o) => o.ok)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('propagates executor errors as a non-ok outcome without aborting the sequence', async () => {
    const dir = tmpDir();
    process.env.RECORDING_DIR = dir;
    const rec = new SessionRecorder('sess-replay-err');

    rec.record('mouse_click', { x: 1 }, {});
    rec.record('key_press', { key: 'Enter' }, {});
    rec.record('capture_window', { title: 'A' }, {});

    let i = 0;
    const fakeExecutor = (toolName: string): unknown => {
      i++;
      if (i === 2) throw new Error('boom');
      return { ok: true, toolName };
    };

    const transcriptPath = path.join(dir, 'sess-replay-err.json');
    const outcomes = await SessionRecorder.replay(transcriptPath, fakeExecutor);

    expect(outcomes).toHaveLength(3);
    expect(outcomes[0].ok).toBe(true);
    expect(outcomes[1].ok).toBe(false);
    if (!outcomes[1].ok) {
      expect(outcomes[1].error).toBe('boom');
    }
    expect(outcomes[2].ok).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('SessionRecorder surface guarantees', () => {
  it('exposes no video API', () => {
    const exports = { SessionRecorder } as unknown as Record<string, unknown>;
    expect(exports.SessionRecorder).toBeDefined();
    expect(exports.startVideo).toBeUndefined();
    expect(exports.stopVideo).toBeUndefined();
    expect(exports.VideoRecorder).toBeUndefined();
  });

  it('replay outcome is a discriminated union narrowed by ok', () => {
    const ok: ReplayOutcome = { toolName: 't', ok: true, result: 1 };
    const err: ReplayOutcome = { toolName: 't', ok: false, error: 'x' };
    const pick = (o: ReplayOutcome): string => (o.ok ? `ok:${String(o.result)}` : `err:${o.error}`);
    expect(pick(ok)).toBe('ok:1');
    expect(pick(err)).toBe('err:x');
  });
});
