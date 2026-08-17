/**
 * Append-only audit log.
 *
 * `logEntry` appends one JSON line (NDJSON) to a per-session, per-day log
 * file under `.omo/logs/`. The log is append-only: there is deliberately no
 * delete, truncate, or clear API exposed to callers. Rotation and retention
 * happen only as an internal side effect of appending.
 *
 * Data minimization: `details` is sanitized before writing — keystroke
 * content, file content, and screenshot/binary payloads are stripped, never
 * logged.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Rotate a log file once it reaches this many bytes. */
const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** Delete log files whose mtime is older than this (7 days). */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Keys whose values must never be written to the audit log. Matched
 * case-insensitively. Covers keystroke content, file content, and
 * screenshot/binary payloads.
 */
const SENSITIVE_KEYS = new Set<string>([
  // keystroke content
  'keystrokes',
  'keystroke',
  'keylog',
  'typedtext',
  // file content
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

function getLogDir(): string {
  const override = process.env.AUDIT_LOG_DIR;
  return path.resolve(override ?? path.join('.omo', 'logs'));
}

/** Local date as YYYY-MM-DD (matches the human-facing file name). */
function localDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Rotate `file` to a numbered suffix when it has grown past the cap. */
function rotateIfNeeded(file: string, base: string): void {
  if (!fs.existsSync(file)) return;
  if (fs.statSync(file).size < MAX_FILE_BYTES) return;
  let n = 1;
  while (fs.existsSync(`${base}.${n}.ndjson`)) n++;
  fs.renameSync(file, `${base}.${n}.ndjson`);
}

/** Delete `.ndjson` files older than the retention window. */
function purgeOldLogs(dir: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - RETENTION_MS;
  for (const name of names) {
    if (!name.endsWith('.ndjson')) continue;
    const full = path.join(dir, name);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
    } catch {
      // best-effort; a single stale file must not break logging.
    }
  }
}

/**
 * Append one audit entry to the session's log file.
 *
 * @param sessionId Identifies the debugging session.
 * @param toolName  The MCP tool that acted.
 * @param action    Human-readable action label.
 * @param details   Extra context (sanitized: no keystrokes/file content/screenshots).
 * @param success   Whether the action succeeded.
 */
export function logEntry(
  sessionId: string,
  toolName: string,
  action: string,
  details: Record<string, unknown>,
  success: boolean,
): void {
  const now = new Date();
  const cleaned = sanitizeValue(details);
  const safeDetails: Record<string, unknown> =
    typeof cleaned === 'object' && cleaned !== null
      ? (cleaned as Record<string, unknown>)
      : {};

  const entry = {
    timestamp: now.toISOString(),
    sessionId,
    toolName,
    action,
    details: safeDetails,
    success,
  };

  const dir = getLogDir();
  fs.mkdirSync(dir, { recursive: true });

  const base = path.join(dir, `audit-${sessionId}-${localDate(now)}`);
  const file = `${base}.ndjson`;
  rotateIfNeeded(file, base);

  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
  purgeOldLogs(dir);
}
