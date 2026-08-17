/**
 * WindowsFileProvider tests (TDD).
 *
 * The provider reads/lists files under a dual denylist/allowlist policy and
 * appends an audit entry per operation. Tests use fresh temp dirs
 * (os.tmpdir), point AUDIT_LOG_DIR at a temp dir, and never hardcode real
 * paths. Symlink escape is exercised with a directory junction, which
 * requires no elevated privileges on Windows.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  AccessDeniedError,
  DirectoryNotFoundError,
  FileTooLargeError,
  WindowsFileProvider,
} from '../src/filesystem';

const DEFAULT_LIMIT = 10 * 1024 * 1024;

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

function writeFile(dir: string, name: string, content: string | Buffer): string {
  const full = path.join(dir, name);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
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
  logDir = makeDir('fs-audit-');
  sessionId = `sess-${Math.random().toString(36).slice(2)}`;
  process.env.AUDIT_LOG_DIR = logDir;
});

afterEach(() => {
  delete process.env.AUDIT_LOG_DIR;
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('WindowsFileProvider readFile — denylist mode', () => {
  it('allows reading a plain file outside the deny list', async () => {
    const root = makeDir('fs-deny-');
    const file = writeFile(root, 'notes.txt', 'hello world');
    const provider = new WindowsFileProvider({ sessionId, mode: 'denylist' });

    const result = await provider.readFile(file);

    expect(result.content).toBe('hello world');
    expect(result.encoding).toBe('utf-8');
  });

  it('denies reading a file under a .ssh directory', async () => {
    const root = makeDir('fs-deny-');
    const file = writeFile(root, '.ssh/id_rsa', 'PRIVATE KEY');
    const provider = new WindowsFileProvider({ sessionId, mode: 'denylist' });

    await expect(provider.readFile(file)).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it('denies reading a file under a Windows vault path', async () => {
    const root = makeDir('fs-deny-');
    const file = writeFile(root, 'Microsoft/Vault/cred.bin', 'secret');
    const provider = new WindowsFileProvider({ sessionId, mode: 'denylist' });

    await expect(provider.readFile(file)).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it('denies reading a credential store file (.aws/credentials)', async () => {
    const root = makeDir('fs-deny-');
    const file = writeFile(root, '.aws/credentials', 'AKIA-SECRET');
    const provider = new WindowsFileProvider({ sessionId, mode: 'denylist' });

    await expect(provider.readFile(file)).rejects.toBeInstanceOf(AccessDeniedError);
  });
});

describe('WindowsFileProvider readFile — allowlist mode', () => {
  it('allows reading a file under a configured root', async () => {
    const root = makeDir('fs-allow-');
    const file = writeFile(root, 'data.txt', 'inside');
    const provider = new WindowsFileProvider({
      sessionId,
      mode: 'allowlist',
      allowlistRoots: [root],
    });

    const result = await provider.readFile(file);

    expect(result.content).toBe('inside');
  });

  it('denies reading a file outside the configured roots', async () => {
    const root = makeDir('fs-allow-');
    const outside = makeDir('fs-outside-');
    const file = writeFile(outside, 'secret.txt', 'outside');
    const provider = new WindowsFileProvider({
      sessionId,
      mode: 'allowlist',
      allowlistRoots: [root],
    });

    await expect(provider.readFile(file)).rejects.toBeInstanceOf(AccessDeniedError);
  });
});

describe('WindowsFileProvider readFile — size limit', () => {
  it('rejects a file larger than the default 10 MiB limit', async () => {
    const root = makeDir('fs-size-');
    const file = writeFile(root, 'big.bin', Buffer.alloc(DEFAULT_LIMIT + 1));
    const provider = new WindowsFileProvider({ sessionId, mode: 'denylist' });

    await expect(provider.readFile(file)).rejects.toBeInstanceOf(FileTooLargeError);
  });

  it('honors a custom maxFileBytes limit', async () => {
    const root = makeDir('fs-size-');
    const ok = writeFile(root, 'ok.txt', 'x'.repeat(1024));
    const tooBig = writeFile(root, 'too-big.txt', 'x'.repeat(1025));
    const provider = new WindowsFileProvider({
      sessionId,
      mode: 'denylist',
      maxFileBytes: 1024,
    });

    await expect(provider.readFile(ok)).resolves.toBeDefined();
    await expect(provider.readFile(tooBig)).rejects.toBeInstanceOf(FileTooLargeError);
  });
});

describe('WindowsFileProvider readFile — binary content', () => {
  it('returns base64 for binary content', async () => {
    const root = makeDir('fs-bin-');
    const bytes = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);
    const file = writeFile(root, 'blob.bin', bytes);
    const provider = new WindowsFileProvider({ sessionId, mode: 'denylist' });

    const result = await provider.readFile(file);

    expect(result.encoding).toBe('base64');
    expect(result.content).toBe(bytes.toString('base64'));
  });

  it('returns utf-8 for text content', async () => {
    const root = makeDir('fs-bin-');
    const file = writeFile(root, 'text.txt', 'héllo');
    const provider = new WindowsFileProvider({ sessionId, mode: 'denylist' });

    const result = await provider.readFile(file);

    expect(result.encoding).toBe('utf-8');
    expect(result.content).toBe('héllo');
  });
});

describe('WindowsFileProvider readFile — symlink escape', () => {
  it('rejects a junction that escapes the allowlist root', async () => {
    const root = makeDir('fs-link-');
    const outside = makeDir('fs-outside-');
    writeFile(outside, 'secret.txt', 'outside secret');
    const link = path.join(root, 'escape');
    fs.symlinkSync(outside, link, 'junction');
    const provider = new WindowsFileProvider({
      sessionId,
      mode: 'allowlist',
      allowlistRoots: [root],
    });

    await expect(provider.readFile(path.join(link, 'secret.txt'))).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
  });
});

describe('WindowsFileProvider listDirectory', () => {
  it('lists the immediate entries of a valid directory', async () => {
    const root = makeDir('fs-list-');
    writeFile(root, 'a.txt', 'a');
    writeFile(root, 'b.txt', 'b');
    fs.mkdirSync(path.join(root, 'sub'));
    const provider = new WindowsFileProvider({ sessionId, mode: 'denylist' });

    const entries = await provider.listDirectory(root);

    expect(entries).toHaveLength(3);
    expect(entries).toEqual(expect.arrayContaining(['a.txt', 'b.txt', 'sub']));
  });

  it('throws DirectoryNotFoundError for a nonexistent directory', async () => {
    const root = makeDir('fs-list-');
    const provider = new WindowsFileProvider({ sessionId, mode: 'denylist' });

    await expect(
      provider.listDirectory(path.join(root, 'missing')),
    ).rejects.toBeInstanceOf(DirectoryNotFoundError);
  });
});

describe('WindowsFileProvider audit', () => {
  it('writes an audit entry for every successful read and list', async () => {
    const root = makeDir('fs-audit-op-');
    const file = writeFile(root, 'note.txt', 'audited');
    const provider = new WindowsFileProvider({ sessionId, mode: 'denylist' });

    await provider.readFile(file);
    await provider.listDirectory(root);

    const entries = readAllEntries(logDir).filter((e) => e.sessionId === sessionId);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.action).sort()).toEqual(
      ['list_directory', 'read_file'].sort(),
    );
    expect(entries.every((e) => e.success === true)).toBe(true);
  });

  it('records a denied read as success=false', async () => {
    const root = makeDir('fs-audit-op-');
    const file = writeFile(root, '.ssh/key', 'x');
    const provider = new WindowsFileProvider({ sessionId, mode: 'denylist' });

    await expect(provider.readFile(file)).rejects.toBeInstanceOf(AccessDeniedError);

    const entries = readAllEntries(logDir).filter((e) => e.sessionId === sessionId);
    expect(entries).toHaveLength(1);
    expect(entries[0].success).toBe(false);
  });
});
