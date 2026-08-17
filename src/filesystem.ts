/**
 * Windows backend of FileProvider.
 *
 * Reads text/binary files and lists directories under a dual access policy:
 * - denylist mode: blocks paths inside `.ssh/`, credential stores, and the
 *   Windows Credential/Vault/DPAPI store; everything else is allowed.
 * - allowlist mode: only paths under the configured roots are allowed.
 *
 * Files larger than 10 MiB are rejected, symlinks/junctions that escape an
 * allowlist root (or resolve into a denied location) are rejected, and
 * binary files are returned base64-encoded. Every read and list appends an
 * audit entry via `logEntry`.
 */

import * as fs from 'fs';
import * as path from 'path';

import { logEntry } from './audit';
import type { FileContent, FileProvider } from './platform/file';

/** Tool name reported to the audit log. */
const TOOL_NAME = 'filesystem';

/** Default maximum file size before a FileTooLargeError is raised. */
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Path segments that always fall under the deny list. */
const DENIED_SEGMENTS = new Set<string>([
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.kube',
  '.docker',
  '.git-credentials',
  '.netrc',
  '_netrc',
]);

/** Lower-case, slash-normalized fragments of Windows credential/vault stores. */
const DENIED_PATH_FRAGMENTS = [
  'microsoft/vault',
  'microsoft/credentials',
  'microsoft/protect',
];

export type FileAccessMode = 'denylist' | 'allowlist';

export interface WindowsFileProviderOptions {
  sessionId: string;
  mode: FileAccessMode;
  /** Required when `mode === 'allowlist'`. */
  allowlistRoots?: string[];
  /** Override the default 10 MiB size cap. */
  maxFileBytes?: number;
}

export class AccessDeniedError extends Error {
  readonly code = 'ACCESS_DENIED';
  constructor(message: string) {
    super(message);
    this.name = 'AccessDeniedError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class FileTooLargeError extends Error {
  readonly code = 'FILE_TOO_LARGE';
  constructor(message: string) {
    super(message);
    this.name = 'FileTooLargeError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class DirectoryNotFoundError extends Error {
  readonly code = 'DIRECTORY_NOT_FOUND';
  constructor(message: string) {
    super(message);
    this.name = 'DirectoryNotFoundError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Normalize a path for case-insensitive, separator-insensitive comparison. */
function normalizeForCompare(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

/** True when `candidate` is `root` itself or strictly inside `root`. */
function isWithin(root: string, candidate: string): boolean {
  const r = normalizeForCompare(root).replace(/\/+$/, '');
  const c = normalizeForCompare(candidate);
  return c === r || c.startsWith(`${r}/`);
}

/** True when `realPath` matches a deny-list segment or fragment. */
function isDenied(realPath: string): boolean {
  const normalized = normalizeForCompare(realPath);
  const segments = normalized.split('/').filter((s) => s.length > 0);
  if (segments.some((s) => DENIED_SEGMENTS.has(s))) return true;
  return DENIED_PATH_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

function isEnoent(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}

function errorMessage(err: unknown): string {
  if (err !== null && typeof err === 'object') {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(err);
}

/** Decode a buffer as utf-8, falling back to base64 for binary content. */
function decode(buf: Buffer): FileContent {
  if (buf.includes(0)) {
    return { content: buf.toString('base64'), encoding: 'base64' };
  }
  return { content: buf.toString('utf8'), encoding: 'utf-8' };
}

export class WindowsFileProvider implements FileProvider {
  private readonly sessionId: string;
  private readonly mode: FileAccessMode;
  private readonly allowlistRoots: string[];
  private readonly maxFileBytes: number;

  constructor(options: WindowsFileProviderOptions) {
    this.sessionId = options.sessionId;
    this.mode = options.mode;
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.allowlistRoots = (options.allowlistRoots ?? []).map((root) => {
      const resolved = path.resolve(root);
      try {
        return fs.realpathSync(resolved);
      } catch {
        return resolved;
      }
    });
    if (this.mode === 'allowlist' && this.allowlistRoots.length === 0) {
      throw new Error('allowlist mode requires at least one allowlistRoot');
    }
  }

  async readFile(target: string): Promise<FileContent> {
    try {
      const real = await fs.promises.realpath(path.resolve(target));
      this.assertAllowed(real, target);
      const stat = await fs.promises.stat(real);
      if (stat.size > this.maxFileBytes) {
        throw new FileTooLargeError(`file exceeds ${this.maxFileBytes} bytes: ${target}`);
      }
      const buffer = await fs.promises.readFile(real);
      const decoded = decode(buffer);
      this.log(
        'read_file',
        { path: target, size: stat.size, encoding: decoded.encoding },
        true,
      );
      return decoded;
    } catch (err) {
      this.log('read_file', { path: target, error: errorMessage(err) }, false);
      throw err;
    }
  }

  async listDirectory(target: string): Promise<string[]> {
    try {
      const real = await fs.promises.realpath(path.resolve(target)).catch((err: unknown) => {
        if (isEnoent(err)) {
          throw new DirectoryNotFoundError(`directory not found: ${target}`);
        }
        throw err;
      });
      this.assertAllowed(real, target);
      const stat = await fs.promises.stat(real);
      if (!stat.isDirectory()) {
        throw new DirectoryNotFoundError(`not a directory: ${target}`);
      }
      const entries = await fs.promises.readdir(real);
      this.log('list_directory', { path: target, count: entries.length }, true);
      return entries;
    } catch (err) {
      this.log('list_directory', { path: target, error: errorMessage(err) }, false);
      throw err;
    }
  }

  private assertAllowed(realPath: string, requested: string): void {
    if (!this.isAllowed(realPath)) {
      throw new AccessDeniedError(`access denied: ${requested}`);
    }
  }

  private isAllowed(realPath: string): boolean {
    if (this.mode === 'allowlist') {
      return this.allowlistRoots.some((root) => isWithin(root, realPath));
    }
    return !isDenied(realPath);
  }

  private log(action: string, details: Record<string, unknown>, success: boolean): void {
    logEntry(this.sessionId, TOOL_NAME, action, { mode: this.mode, ...details }, success);
  }
}
