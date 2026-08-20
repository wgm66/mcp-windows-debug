/**
 * Session JSON transcript recorder + replay.
 *
 * `SessionRecorder` records every tool call (name, args, result, timestamp,
 * optional screenshot path) into a JSON transcript file under
 * `<RECORDING_DIR>/<sessionId>.json`. The transcript shape is
 * `{ sessionId, entries: TranscriptEntry[] }`.
 *
 * Data minimization: keystroke content and screenshot/binary payloads are
 * stripped from `args` and `result` before being stored, mirroring `audit.ts`.
 * No video is produced or referenced anywhere.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Keys whose values must never be written to the transcript. Matched
 * case-insensitively. Covers keystroke content, file content, and
 * screenshot/binary payloads.
 */
const SENSITIVE_KEYS = new Set<string>([
  // keystroke content
  'keystrokes',
  'keystroke',
  'keylog',
  'typedtext',
  'text',
  'filecontent',
  'filedata',
  'content',
  // screenshot / binary payloads
  'screenshot',
  'screenshotdata',
  'imagedata',
  'base64',
  'binary',
  'buffer',
  'blob',
]);

/** Recursively strip sensitive keys and non-JSON values from `value`. */
function sanitizeValue(value: unknown): unknown {
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (Buffer.isBuffer(value)) return undefined;
  if (Array.isArray(value)) {
    return value.map(sanitizeValue).filter((v) => v !== undefined);
  }
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') {
    return value;
  }
  if (type === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(key.toLowerCase())) continue;
      const cleaned = sanitizeValue(v);
      if (cleaned !== undefined) out[key] = cleaned;
    }
    return out;
  }
  // function, symbol, bigint — omit.
  return undefined;
}

function getRecordingDir(): string {
  const override = process.env.RECORDING_DIR;
  return path.resolve(override ?? path.join('.omo', 'recordings'));
}

function toPlainRecord(value: unknown): Record<string, unknown> {
  const cleaned = sanitizeValue(value);
  if (cleaned === null || cleaned === undefined) return {};
  if (typeof cleaned === 'object' && !Array.isArray(cleaned)) {
    return cleaned as Record<string, unknown>;
  }
  // Primitives and arrays are wrapped so callers always get a record.
  return { value: cleaned };
}

/** One recorded tool call. */
export interface TranscriptEntry {
  /** 1-based sequence id within the transcript. */
  readonly id: number;
  /** ISO 8601 timestamp of the recorded call. */
  readonly timestamp: string;
  /** MCP tool name. */
  readonly toolName: string;
  /** Sanitized tool args (no keystroke content / payloads). */
  readonly args: Record<string, unknown>;
  /** Sanitized tool result (no keystroke content / payloads). */
  readonly result: Record<string, unknown>;
  /** Optional path to a screenshot captured alongside the call. */
  readonly screenshotPath?: string;
}

/** Transcript file shape. */
export interface Transcript {
  readonly sessionId: string;
  readonly entries: TranscriptEntry[];
}

/** Result of re-issuing one tool call during replay. */
export type ReplayOutcome =
  | { readonly toolName: string; readonly ok: true; readonly result: unknown }
  | { readonly toolName: string; readonly ok: false; readonly error: string };

/** Function used to re-issue a recorded tool call during replay. */
export type ReplayExecutor = (
  toolName: string,
  args: Record<string, unknown>,
) => unknown | Promise<unknown>;

/**
 * Records every tool call into a JSON transcript file and supports
 * re-issuing the same calls in order via `replay`.
 */
export class SessionRecorder {
  private readonly sessionId: string;
  private readonly entries: TranscriptEntry[] = [];
  private nextId = 1;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /**
   * Record one tool call. Appends to the in-memory transcript and persists
   * the full transcript to disk as JSON.
   */
  record(
    toolName: string,
    args: Record<string, unknown>,
    result: Record<string, unknown>,
    screenshotPath?: string,
  ): void {
    const entry: TranscriptEntry = {
      id: this.nextId++,
      timestamp: new Date().toISOString(),
      toolName,
      args: toPlainRecord(args),
      result: toPlainRecord(result),
      ...(screenshotPath === undefined ? {} : { screenshotPath }),
    };
    this.entries.push(entry);
    this.persist();
  }

  /** Return the current transcript entries (live snapshot). */
  getTranscript(): TranscriptEntry[] {
    return [...this.entries];
  }

  /**
   * Re-issue every tool call recorded in `transcriptPath`, in order,
   * using `executor`. A throw from the executor becomes a non-ok outcome
   * for that entry; subsequent entries still replay.
   */
  static async replay(
    transcriptPath: string,
    executor: ReplayExecutor,
  ): Promise<ReplayOutcome[]> {
    const raw = fs.readFileSync(transcriptPath, 'utf8');
    const parsed = JSON.parse(raw) as Transcript;
    const outcomes: ReplayOutcome[] = [];
    for (const entry of parsed.entries) {
      try {
        const result = await executor(entry.toolName, entry.args);
        outcomes.push({ toolName: entry.toolName, ok: true, result });
      } catch (err) {
        const message =
          err !== null && typeof err === 'object'
            ? typeof (err as { message?: unknown }).message === 'string'
              ? ((err as { message: string }).message)
              : String(err)
            : String(err);
        outcomes.push({ toolName: entry.toolName, ok: false, error: message });
      }
    }
    return outcomes;
  }

  private persist(): void {
    const dir = getRecordingDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${this.sessionId}.json`);
    const doc: Transcript = { sessionId: this.sessionId, entries: this.entries };
    fs.writeFileSync(file, JSON.stringify(doc, null, 2), 'utf8');
  }
}
