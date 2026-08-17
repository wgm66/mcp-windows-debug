/**
 * Integration test for the MCP stdio server (todo 9).
 *
 * Spawns the built server (`node dist/index.js`) and drives it over raw
 * JSON-RPC on stdio — no Playwright, no TCP. Verifies:
 *   (a) `tools/list` returns the 10 registered tools;
 *   (b) `resources/list` returns the 2 fixed resources and
 *       `resources/templates/list` returns the `screenshot://monitor/{index}`
 *       template (3 registered resource surfaces total);
 *   (c) `read_file` on a temp file returns its content;
 *   (d) malformed tool args surface as a structured error and the server stays
 *       alive;
 *   (e) an unknown tool surfaces a structured error.
 *
 * Requires `npm run build` to have produced `dist/index.js` first.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const DIST = path.join(__dirname, '..', 'dist', 'index.js');

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Minimal newline-delimited JSON-RPC client over a child's stdio. */
class StdioClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private nextId = 1;
  private stderr = '';
  private readonly pending = new Map<
    number,
    { resolve: (m: JsonRpcMessage) => void; reject: (e: Error) => void }
  >();

  constructor() {
    this.child = spawn('node', [DIST], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.on('data', (d: Buffer) => this.onData(d));
    this.child.stderr.on('data', (d: Buffer) => {
      this.stderr += d.toString('utf8');
    });
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
      }, 15000);
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

  close(): void {
    this.child.stdin.end();
    this.child.kill();
  }
}

describe('MCP stdio server', () => {
  let client: StdioClient;
  let tmpFile: string;
  let tmpDir: string;

  beforeAll(async () => {
    if (!fs.existsSync(DIST)) {
      throw new Error('dist/index.js missing — run "npm run build" before "npm test"');
    }
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-server-test-'));
    tmpFile = path.join(tmpDir, 'hello.txt');
    fs.writeFileSync(tmpFile, 'hello from mcp server\n', 'utf8');

    client = new StdioClient();
    const init = await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'server.test', version: '1.0.0' },
    });
    expect(init.error).toBeUndefined();
    expect(init.result).toBeDefined();
    client.notify('notifications/initialized');
  }, 30000);

  afterAll(() => {
    client.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('(a) tools/list returns the 10 registered tools', async () => {
    const res = await client.request('tools/list', {});
    expect(res.error).toBeUndefined();
    const tools = (res.result as { tools: Array<{ name: string }> }).tools;
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'capture_window',
      'end_debug_session',
      'execute_action',
      'key_press',
      'list_directory',
      'mouse_click',
      'mouse_move',
      'read_file',
      'start_debug_session',
      'type_text',
    ]);
  });

  it('(b) resources/list + resources/templates/list cover the 3 registered resources', async () => {
    const list = await client.request('resources/list', {});
    expect(list.error).toBeUndefined();
    const resources = (list.result as { resources: Array<{ uri: string }> }).resources;
    const uris = resources.map((r) => r.uri).sort();
    expect(uris).toEqual(['debug://context', 'screenshot://full']);

    const tpl = await client.request('resources/templates/list', {});
    expect(tpl.error).toBeUndefined();
    const templates = (tpl.result as { resourceTemplates: Array<{ uriTemplate: string }> })
      .resourceTemplates;
    expect(templates.map((t) => t.uriTemplate)).toEqual(['screenshot://monitor/{index}']);
  });

  it('(c) read_file returns the temp file content', async () => {
    const res = await client.request('tools/call', {
      name: 'read_file',
      arguments: { path: tmpFile },
    });
    expect(res.error).toBeUndefined();
    const result = res.result as {
      isError?: boolean;
      content: Array<{ type: string; text?: string }>;
    };
    expect(result.isError).not.toBe(true);
    const text = result.content
      .map((c) => c.text ?? '')
      .join('');
    expect(text).toBe('hello from mcp server\n');
  });

  it('(d) malformed tool args surface a structured error and the server stays alive', async () => {
    const res = await client.request('tools/call', {
      name: 'mouse_click',
      arguments: { x: 'abc', y: 'def' },
    });
    const isStructuredError =
      res.error !== undefined || (res.result as { isError?: boolean })?.isError === true;
    expect(isStructuredError).toBe(true);

    // Server must still be responsive after the error.
    const ping = await client.request('tools/list', {});
    expect(ping.error).toBeUndefined();
  });

  it('(e) unknown tool surfaces a structured error', async () => {
    const res = await client.request('tools/call', {
      name: 'does_not_exist',
      arguments: {},
    });
    const isStructuredError =
      res.error !== undefined || (res.result as { isError?: boolean })?.isError === true;
    expect(isStructuredError).toBe(true);
  });
});
