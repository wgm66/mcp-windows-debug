/**
 * End-to-end integration test for the MCP stdio server (todo 11).
 *
 * Spawns the built server (`node dist/index.js`, or a tiny allowlist-mode
 * launcher) and drives it over raw newline-delimited JSON-RPC on stdio — no
 * Playwright, no TCP, no manual GUI. Reuses the exact stdio framing proven by
 * `tests/server.test.ts` (the SDK's `StdioServerTransport` serializes each
 * message as `JSON.stringify(msg) + '\n'`; the client splits stdout on `\n`).
 *
 * Scenarios:
 *   (a) full lifecycle — spawn → `initialize` → `tools/list` → `tools/call`
 *       (`read_file`) → graceful shutdown (stdin EOF → clean exit);
 *   (b) `read_file` / `list_directory` under BOTH access modes (denylist via
 *       the default server, allowlist via a spawned launcher), on real temp
 *       files;
 *   (c) `capture_window` + `screenshot://full` resource read (real PNG bytes) —
 *       display-gated, skipped when no monitor is present;
 *   (d) input-injection round-trip: focus Notepad via `SetForegroundWindow`
 *       (koffi/user32), `type_text`, read the edit control back via
 *       `SendMessage(WM_GETTEXT)` — gated on display AND elevation (the
 *       watchdog backing `start_debug_session` needs admin);
 *   (e) debug-session lifecycle (`start_debug_session` → `end_debug_session`) —
 *       gated on elevation; the no-session / no-regions error paths run
 *       everywhere.
 *
 * Requires `npm run build` to have produced `dist/index.js` first; `beforeAll`
 * asserts that and fails with a clear message otherwise.
 */

import { spawn, spawnSync, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as koffi from 'koffi';
import { Monitor } from 'node-screenshots';

jest.setTimeout(30000);

const DIST = path.join(__dirname, '..', 'dist', 'index.js');
const SERVER_JS = path.join(__dirname, '..', 'dist', 'server.js');
// The launcher requires the SDK stdio transport by absolute path (it lives in
// os.tmpdir(), so bare `require('@modelcontextprotocol/...')` would not resolve).
const SDK_STDIO_JS = require.resolve('@modelcontextprotocol/sdk/server/stdio.js');
const WATCHDOG_EXE = path.join(__dirname, '..', 'src', 'watchdog', 'watchdog.exe');

/** PNG signature: 89 50 4E 47. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

// ---------------------------------------------------------------------------
// Environment gates
// ---------------------------------------------------------------------------

/** True when an interactive display (≥1 monitor) is available. */
const hasDisplay = (() => {
  try {
    return Monitor.all().length > 0;
  } catch {
    return false;
  }
})();

/**
 * True when this shell is elevated. The watchdog's elevation check precedes
 * argument parsing, so `watchdog.exe --help` returns 0 iff elevated (same
 * probe as `tests/ipc.test.ts`).
 */
function shellIsElevated(): boolean {
  try {
    const probe = spawnSync(WATCHDOG_EXE, ['--help'], { encoding: 'utf8', timeout: 5000 });
    return probe.status === 0;
  } catch {
    return false;
  }
}

const elevated = shellIsElevated();
const displayIt = hasDisplay ? it : it.skip;
const elevatedSuite = elevated ? describe : describe.skip;
const displayAndElevatedSuite = hasDisplay && elevated ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Minimal newline-delimited JSON-RPC client over a child's stdio
// (same framing as tests/server.test.ts — the SDK serializes `msg + '\n'`).
// ---------------------------------------------------------------------------

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

class StdioClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private nextId = 1;
  private stderr = '';
  private _exitCode: number | null = null;
  private readonly pending = new Map<
    number,
    { resolve: (m: JsonRpcMessage) => void; reject: (e: Error) => void }
  >();

  constructor(args: string[]) {
    this.child = spawn('node', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.on('data', (d: Buffer) => this.onData(d));
    this.child.stderr.on('data', (d: Buffer) => {
      this.stderr += d.toString('utf8');
    });
    this.child.on('exit', (code) => {
      this._exitCode = code;
    });
  }

  get exitCode(): number | null {
    return this._exitCode;
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      if (line.length === 0) continue;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line) as JsonRpcMessage;
      } catch {
        continue; // ignore malformed frames
      }
      if (typeof msg.id === 'number') {
        const entry = this.pending.get(msg.id);
        if (entry) {
          this.pending.delete(msg.id);
          entry.resolve(msg);
        }
      }
    }
  }

  request(method: string, params?: unknown): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    const frame = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method}\nstderr:\n${this.stderr}`));
      }, 20000);
      this.pending.set(id, {
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.child.stdin.write(frame);
    });
  }

  notify(method: string, params?: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async initialize(): Promise<JsonRpcMessage> {
    const init = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'integration.test', version: '1.0.0' },
    });
    this.notify('notifications/initialized');
    return init;
  }

  /** Graceful shutdown: EOF on stdin → server exits; hard-kill after 5s. */
  shutdown(): Promise<void> {
    if (this._exitCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill();
        resolve();
      }, 5000);
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      this.child.stdin.end();
    });
  }

  kill(): void {
    this.child.kill();
  }
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

/** Concatenated `text` content of a tool/resource result (if any). */
function resultText(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? '').join('');
}

/** True when a JSON-RPC message is an error response or an `isError` result. */
function isErrorResult(res: JsonRpcMessage): boolean {
  return res.error !== undefined || (res.result as { isError?: boolean })?.isError === true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll `cond` every 100ms until it returns truthy or `timeoutMs` elapses. */
async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(100);
  }
  return cond();
}

/** Decode a base64 PNG blob and assert it carries the PNG magic + non-trivial size. */
function expectPngBytes(base64: string): Buffer {
  const buf = Buffer.from(base64, 'base64');
  expect(buf.subarray(0, 4)).toEqual(PNG_MAGIC);
  expect(buf.length).toBeGreaterThan(1024);
  return buf;
}

// ---------------------------------------------------------------------------
// Allowlist-mode launcher (written to a temp dir; spawns over stdio)
// ---------------------------------------------------------------------------

const ALLOWLIST_LAUNCHER_SOURCE = `
const { buildServer } = require(process.argv[2]);
const { StdioServerTransport } = require(process.argv[3]);
const roots = JSON.parse(process.argv[4]);
const server = buildServer({ fileMode: 'allowlist', allowlistRoots: roots });
server.connect(new StdioServerTransport()).catch((err) => {
  process.stderr.write(String(err && err.stack ? err.stack : err));
  process.exit(1);
});
`;

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// Scenario (a) + (b): full lifecycle + denylist file access (default server)
// ---------------------------------------------------------------------------

describe('MCP stdio — lifecycle + denylist file access (default server)', () => {
  let client: StdioClient;
  let tmpDir: string;
  let normalFile: string;
  let deniedFile: string;

  beforeAll(async () => {
    if (!fs.existsSync(DIST)) {
      throw new Error('dist/index.js missing — run "npm run build" before "npm test"');
    }
    tmpDir = makeTempDir('mcp-integration-');
    normalFile = path.join(tmpDir, 'hello.txt');
    fs.writeFileSync(normalFile, 'integration hello\n', 'utf8');
    const deniedDir = path.join(tmpDir, '.ssh');
    fs.mkdirSync(deniedDir);
    deniedFile = path.join(deniedDir, 'id_rsa');
    fs.writeFileSync(deniedFile, 'pretend-private-key', 'utf8');

    client = new StdioClient([DIST]);
    const init = await client.initialize();
    expect(init.error).toBeUndefined();
    expect(init.result).toBeDefined();
  }, 30000);

  afterAll(async () => {
    await client.shutdown();
    client.kill();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('(a) initialize exposes the server identity and tools/list has 11 tools', async () => {
    const init = await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'integration.test', version: '1.0.0' },
    });
    const serverInfo = (init.result as { serverInfo: { name: string; version: string } })
      .serverInfo;
    expect(serverInfo.name).toBe('mcp-windows-debug');
    expect(serverInfo.version).toBe('0.1.0');

    const res = await client.request('tools/list', {});
    expect(res.error).toBeUndefined();
    const names = ((res.result as { tools: Array<{ name: string }> }).tools ?? [])
      .map((t) => t.name)
      .sort();
    expect(names).toEqual([
      'capture_window',
      'end_debug_session',
      'execute_action',
      'inspect_element',
      'key_press',
      'list_directory',
      'mouse_click',
      'mouse_move',
      'read_file',
      'start_debug_session',
      'type_text',
    ]);
  });

  it('(a) read_file returns a real temp file\'s content (tools/call round-trip)', async () => {
    const res = await client.request('tools/call', {
      name: 'read_file',
      arguments: { path: normalFile },
    });
    expect(isErrorResult(res)).toBe(false);
    expect(resultText(res.result)).toBe('integration hello\n');
  });

  it('(b) denylist: read_file blocks a path under .ssh/', async () => {
    const res = await client.request('tools/call', {
      name: 'read_file',
      arguments: { path: deniedFile },
    });
    expect(isErrorResult(res)).toBe(true);
    expect(resultText(res.result)).toContain('ACCESS_DENIED');
  });

  it('(b) list_directory lists entries but blocks the .ssh subdirectory', async () => {
    const list = await client.request('tools/call', {
      name: 'list_directory',
      arguments: { path: tmpDir },
    });
    expect(isErrorResult(list)).toBe(false);
    const entries = JSON.parse(resultText(list.result)) as string[];
    expect(entries).toContain('hello.txt');
    expect(entries).toContain('.ssh');

    const denied = await client.request('tools/call', {
      name: 'list_directory',
      arguments: { path: path.join(tmpDir, '.ssh') },
    });
    expect(isErrorResult(denied)).toBe(true);
    expect(resultText(denied.result)).toContain('ACCESS_DENIED');
  });

  it('(b) read_file rejects a mode that is not configured for this session', async () => {
    const res = await client.request('tools/call', {
      name: 'read_file',
      arguments: { path: normalFile, mode: 'allowlist' },
    });
    expect(isErrorResult(res)).toBe(true);
    expect(resultText(res.result)).toContain("not configured");
  });

  it('(e) start_debug_session with empty regions returns ABORT_BUTTONS_REQUIRED', async () => {
    const res = await client.request('tools/call', {
      name: 'start_debug_session',
      arguments: { regions: [] },
    });
    expect(isErrorResult(res)).toBe(true);
    expect(resultText(res.result)).toContain('ABORT_BUTTONS_REQUIRED');
  });

  it('(e) end_debug_session with no active session returns a structured error', async () => {
    const res = await client.request('tools/call', {
      name: 'end_debug_session',
      arguments: {},
    });
    expect(isErrorResult(res)).toBe(true);
    expect(resultText(res.result)).toContain('no active debug session');
  });

  it('(a) graceful shutdown: stdin EOF makes the server exit cleanly (code 0)', async () => {
    await client.shutdown();
    expect(client.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario (b): allowlist file access (spawned allowlist-mode launcher)
// ---------------------------------------------------------------------------

describe('MCP stdio — allowlist file access (allowlist launcher)', () => {
  let client: StdioClient;
  let launcherPath: string;
  let allowRoot: string;
  let outsideDir: string;
  let insideFile: string;
  let outsideFile: string;

  beforeAll(async () => {
    if (!fs.existsSync(SERVER_JS)) {
      throw new Error('dist/server.js missing — run "npm run build" before "npm test"');
    }
    const launchDir = makeTempDir('mcp-integration-launch-');
    launcherPath = path.join(launchDir, 'allowlist-launcher.cjs');
    fs.writeFileSync(launcherPath, ALLOWLIST_LAUNCHER_SOURCE, 'utf8');

    allowRoot = makeTempDir('mcp-integration-allow-');
    outsideDir = makeTempDir('mcp-integration-outside-');
    insideFile = path.join(allowRoot, 'inside.txt');
    outsideFile = path.join(outsideDir, 'outside.txt');
    fs.writeFileSync(insideFile, 'inside allowlist root\n', 'utf8');
    fs.writeFileSync(outsideFile, 'outside allowlist root\n', 'utf8');

    client = new StdioClient([launcherPath, SERVER_JS, SDK_STDIO_JS, JSON.stringify([allowRoot])]);
    const init = await client.initialize();
    expect(init.error).toBeUndefined();
  }, 30000);

  afterAll(async () => {
    await client.shutdown();
    client.kill();
    fs.rmSync(allowRoot, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
    fs.rmSync(path.dirname(launcherPath), { recursive: true, force: true });
  });

  it('(b) read_file allows a path inside the allowlist root', async () => {
    const res = await client.request('tools/call', {
      name: 'read_file',
      arguments: { path: insideFile },
    });
    expect(isErrorResult(res)).toBe(false);
    expect(resultText(res.result)).toBe('inside allowlist root\n');
  });

  it('(b) read_file blocks a path outside the allowlist root', async () => {
    const res = await client.request('tools/call', {
      name: 'read_file',
      arguments: { path: outsideFile },
    });
    expect(isErrorResult(res)).toBe(true);
    expect(resultText(res.result)).toContain('ACCESS_DENIED');
  });

  it('(b) list_directory allows the root and blocks a directory outside it', async () => {
    const inside = await client.request('tools/call', {
      name: 'list_directory',
      arguments: { path: allowRoot },
    });
    expect(isErrorResult(inside)).toBe(false);
    expect(JSON.parse(resultText(inside.result)) as string[]).toContain('inside.txt');

    const outside = await client.request('tools/call', {
      name: 'list_directory',
      arguments: { path: outsideDir },
    });
    expect(isErrorResult(outside)).toBe(true);
    expect(resultText(outside.result)).toContain('ACCESS_DENIED');
  });

  it('(b) read_file rejects mode denylist on an allowlist session', async () => {
    const res = await client.request('tools/call', {
      name: 'read_file',
      arguments: { path: insideFile, mode: 'denylist' },
    });
    expect(isErrorResult(res)).toBe(true);
    expect(resultText(res.result)).toContain("not configured");
  });
});

// ---------------------------------------------------------------------------
// Scenario (c): screenshot capture + screenshot://full resource (display-gated)
// ---------------------------------------------------------------------------

describe('MCP stdio — screenshot capture + resource read', () => {
  let client: StdioClient;

  beforeAll(async () => {
    if (!fs.existsSync(DIST)) {
      throw new Error('dist/index.js missing — run "npm run build" before "npm test"');
    }
    client = new StdioClient([DIST]);
    const init = await client.initialize();
    expect(init.error).toBeUndefined();
  }, 30000);

  afterAll(async () => {
    await client.shutdown();
    client.kill();
  });

  displayIt('(c) capture_window returns a real PNG image', async () => {
    const res = await client.request('tools/call', {
      name: 'capture_window',
      arguments: { title: '' },
    });
    expect(isErrorResult(res)).toBe(false);
    const image = (res.result as { content: Array<{ type?: string; data?: string }> })
      .content
      .find((c) => c.type === 'image');
    expect(image).toBeDefined();
    expectPngBytes(image!.data!);
  });

  displayIt('(c) resources/read screenshot://full returns a real PNG blob', async () => {
    const res = await client.request('resources/read', { uri: 'screenshot://full' });
    expect(res.error).toBeUndefined();
    const contents = (res.result as { contents: Array<{ blob?: string }> }).contents;
    expect(contents).toHaveLength(1);
    expectPngBytes(contents[0].blob!);
  });
});

// ---------------------------------------------------------------------------
// Scenario (d): input injection round-trip via Notepad (display + elevation)
// ---------------------------------------------------------------------------

// Requires elevation because `type_text` routes through `injectGuarded`, which
// needs an ACTIVE debug session, which needs the elevated watchdog. Requires a
// display because Notepad + foreground/cursor scoping need a real desktop.
// Skipped on a non-elevated or headless shell.
displayAndElevatedSuite('MCP stdio — input injection round-trip via Notepad', () => {
  let client: StdioClient;
  let notepad: ChildProcess;
  let win32: ReturnType<typeof notepadWin32>;

  // Win32 surface (koffi → user32), lazily initialized so it only loads when
  // this elevation/display-gated suite actually runs.
  function notepadWin32() {
    const user32 = koffi.load('user32.dll');
    return {
      findWindow: user32.func('void * FindWindowA(str lpClassName, str lpWindowName)'),
      findWindowEx: user32.func(
        'void * FindWindowExA(void *hWndParent, void *hWndChildAfter, str lpszClass, str lpszWindow)',
      ),
      setForeground: user32.func('bool SetForegroundWindow(void *hWnd)'),
      setCursorPos: user32.func('bool SetCursorPos(int32 X, int32 Y)'),
      getWindowRect: user32.func('bool GetWindowRect(void *hWnd, void *lpRect)'),
      getForeground: user32.func('void * GetForegroundWindow()'),
      sendMessage: user32.func(
        'int64 SendMessageA(void *hWnd, uint32 Msg, uintptr wParam, void *lParam)',
      ),
    };
  }

  const WM_GETTEXT = 0x000d;
  const WM_CLOSE = 0x0010;

  function readEditText(edit: number): string {
    const buf = Buffer.alloc(2048);
    win32.sendMessage(BigInt(edit), WM_GETTEXT, 2048, buf);
    const nul = buf.indexOf(0);
    return buf.toString('utf8', 0, nul === -1 ? buf.length : nul);
  }

  beforeAll(async () => {
    if (!fs.existsSync(DIST)) {
      throw new Error('dist/index.js missing — run "npm run build" before "npm test"');
    }
    win32 = notepadWin32();
    notepad = spawn('notepad.exe', [], { detached: true, stdio: 'ignore' });
    client = new StdioClient([DIST]);
    const init = await client.initialize();
    expect(init.error).toBeUndefined();
  }, 30000);

  afterAll(async () => {
    await client.shutdown();
    client.kill();
    try {
      notepad.kill();
    } catch {
      // best effort
    }
  });

  it('(d) types text into Notepad and reads it back via WM_GETTEXT', async () => {
    // Wait for the Notepad window, then its Edit child control.
    const windowReady = await waitFor(
      () => Number(win32.findWindow('Notepad', null) ?? 0) !== 0,
      10000,
    );
    expect(windowReady).toBe(true);

    const rawHwnd = win32.findWindow('Notepad', null);
    const hwnd = Number(rawHwnd ?? 0);
    const edit = Number(win32.findWindowEx(BigInt(hwnd), null, 'Edit', null) ?? 0);
    expect(hwnd).toBeGreaterThan(0);
    expect(edit).toBeGreaterThan(0);

    // Focus Notepad and place the cursor inside its rect so the safety
    // window-scoping gate (`cursorAndFocusInside`) passes.
    win32.setForeground(BigInt(hwnd));
    const rect = Buffer.alloc(16);
    win32.getWindowRect(BigInt(hwnd), rect);
    const cx = Math.round((rect.readInt32LE(0) + rect.readInt32LE(8)) / 2);
    const cy = Math.round((rect.readInt32LE(4) + rect.readInt32LE(12)) / 2);
    win32.setCursorPos(cx, cy);
    await waitFor(() => Number(win32.getForeground() ?? 0) === hwnd, 5000);

    // Start a debug session: the orchestrator resolves the target window as
    // the current foreground (Notepad), which the safety gate scopes against.
    const marker = `mcp-it-${Date.now()}`;
    const start = await client.request('tools/call', {
      name: 'start_debug_session',
      arguments: { regions: [{ x: 0, y: 0, w: 10, h: 10, id: 'abort' }] },
    });
    expect(isErrorResult(start)).toBe(false);
    await sleep(500); // let the orchestrator snapshot the target window

    const typed = await client.request('tools/call', {
      name: 'type_text',
      arguments: { text: marker },
    });
    expect(isErrorResult(typed)).toBe(false);

    await sleep(300);
    expect(readEditText(edit)).toContain(marker);

    const ended = await client.request('tools/call', {
      name: 'end_debug_session',
      arguments: {},
    });
    expect(isErrorResult(ended)).toBe(false);

    // Close Notepad (discard the unsaved buffer) and reap the process.
    win32.sendMessage(BigInt(hwnd), WM_CLOSE, 0, null);
  });
});

// ---------------------------------------------------------------------------
// Scenario (e): debug session lifecycle (elevation-gated)
// ---------------------------------------------------------------------------

// The watchdog refuses non-admin runs (ERROR_ACCESS_DENIED → exit 1), so the
// start → end happy path is skipped unless this shell is elevated. The no-
// session / no-regions error paths already run in the denylist suite above.
elevatedSuite('MCP stdio — debug session lifecycle (elevated only)', () => {
  let client: StdioClient;

  beforeAll(async () => {
    if (!fs.existsSync(DIST)) {
      throw new Error('dist/index.js missing — run "npm run build" before "npm test"');
    }
    client = new StdioClient([DIST]);
    const init = await client.initialize();
    expect(init.error).toBeUndefined();
  }, 30000);

  afterAll(async () => {
    await client.shutdown();
    client.kill();
  });

  it('(e) start_debug_session returns a handle and end_debug_session ends it', async () => {
    const start = await client.request('tools/call', {
      name: 'start_debug_session',
      arguments: { regions: [{ x: 0, y: 0, w: 10, h: 10, id: 'abort' }] },
    });
    expect(isErrorResult(start)).toBe(false);
    const handle = JSON.parse(resultText(start.result)) as { id: string; regions: number };
    expect(typeof handle.id).toBe('string');
    expect(handle.regions).toBe(1);

    const ended = await client.request('tools/call', {
      name: 'end_debug_session',
      arguments: { id: handle.id },
    });
    expect(isErrorResult(ended)).toBe(false);
    expect(resultText(ended.result)).toContain('debug session ended');
  });
});
