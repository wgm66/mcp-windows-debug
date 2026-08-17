/**
 * WatchdogClient (src/ipc.ts) tests.
 *
 * Two suites:
 *   1. "mock pipe server" (always runs): a Node `net.createServer` emulates the
 *      watchdog protocol so the client's token handshake, JSON serialization
 *      and reply parsing are exercised WITHOUT elevation or a compiled exe.
 *   2. "real watchdog.exe" (elevation-gated): spawns the compiled watchdog and
 *      runs the full handshake -> REGISTER_REGION -> STATUS -> SHUTDOWN cycle
 *      against the native process. Skipped when this shell is non-elevated,
 *      because the watchdog prints ERROR_ACCESS_DENIED and exits 1.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import * as path from 'node:path';

import {
  WatchdogAuthError,
  WatchdogClient,
  generateToken,
} from '../src/ipc';

jest.setTimeout(30000);

const WATCHDOG_EXE = path.join(
  __dirname,
  '..',
  'src',
  'watchdog',
  'watchdog.exe',
);

// ---------------------------------------------------------------------------
// Mock pipe server (covers client serialization/parsing, no elevation needed)
// ---------------------------------------------------------------------------

interface MockWatchdog {
  pipeId: string;
  seen: {
    auth: string | null;
    regions: Array<Record<string, unknown>>;
    shutdown: boolean;
  };
  close: () => Promise<void>;
}

function createMockWatchdogServer(token: string): Promise<MockWatchdog> {
  const pipeId = `mock-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const pipeName = `\\\\.\\pipe\\McpWatchdog-${pipeId}`;
  const seen: MockWatchdog['seen'] = { auth: null, regions: [], shutdown: false };

  const server = createServer((socket) => {
    let buf = '';
    let authed = false;
    socket.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line.length === 0) continue;
        const msg = JSON.parse(line) as Record<string, unknown>;
        if (!authed) {
          if (msg.token === token) {
            authed = true;
            seen.auth = token;
            socket.write(`${JSON.stringify({ ok: true, op: 'AUTH' })}\n`);
          } else {
            socket.write(`${JSON.stringify({ ok: false, error: 'unauthorized' })}\n`);
            socket.end();
          }
          continue;
        }
        switch (msg.op) {
          case 'REGISTER_REGION':
            seen.regions.push(msg);
            socket.write(`${JSON.stringify({ ok: true, op: 'REGISTER_REGION' })}\n`);
            break;
          case 'STATUS':
            socket.write(
              `${JSON.stringify({ hooked: true, regions: seen.regions.length })}\n`,
            );
            break;
          case 'HEARTBEAT':
            break;
          case 'SHUTDOWN':
            seen.shutdown = true;
            socket.write(`${JSON.stringify({ ok: true, op: 'SHUTDOWN' })}\n`);
            socket.end();
            break;
          default:
            break;
        }
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(pipeName, () => {
      resolve({
        pipeId,
        seen,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

describe('WatchdogClient (mock pipe server)', () => {
  let token: string;
  let mock: MockWatchdog;
  let client: WatchdogClient | undefined;

  beforeEach(async () => {
    token = generateToken();
    mock = await createMockWatchdogServer(token);
  });

  afterEach(async () => {
    if (client) {
      client.close();
      client = undefined;
    }
    await mock.close();
  });

  it('handshakes with the token and serializes REGISTER_REGION / STATUS / SHUTDOWN', async () => {
    client = new WatchdogClient({ pipeId: mock.pipeId, token });
    await client.connect();
    await client.registerRegions([{ x: 1, y: 2, w: 3, h: 4, id: 'r1' }]);

    expect(mock.seen.auth).toBe(token);
    expect(mock.seen.regions).toHaveLength(1);
    expect(mock.seen.regions[0]).toMatchObject({
      op: 'REGISTER_REGION',
      x: 1,
      y: 2,
      w: 3,
      h: 4,
      id: 'r1',
    });

    const status = await client.status();
    expect(status).toEqual({ hooked: true, regions: 1 });

    await client.shutdown();
    expect(mock.seen.shutdown).toBe(true);
  });

  it('status() before any regions reports regions=0', async () => {
    client = new WatchdogClient({ pipeId: mock.pipeId, token });
    await client.connect();
    await expect(client.status()).resolves.toEqual({ hooked: true, regions: 0 });
  });

  it('heartbeat() sends HEARTBEAT without awaiting a reply', async () => {
    client = new WatchdogClient({ pipeId: mock.pipeId, token });
    await client.connect();
    await expect(client.heartbeat()).resolves.toBeUndefined();
  });

  it('rejects the connection with WatchdogAuthError on a wrong token', async () => {
    client = new WatchdogClient({ pipeId: mock.pipeId, token: 'f'.repeat(64) });
    await expect(client.connect()).rejects.toBeInstanceOf(WatchdogAuthError);
  });
});

// ---------------------------------------------------------------------------
// Real watchdog.exe (elevation-gated)
// ---------------------------------------------------------------------------

// The watchdog requires elevation to install global low-level hooks. When this
// shell is non-elevated, `watchdog.exe --help` prints ERROR_ACCESS_DENIED and
// exits 1 (the elevation check precedes argument parsing), so the real-exe
// suite is skipped. Run `npm test` from an elevated PowerShell to enable it.
function shellIsElevated(): boolean {
  try {
    const probe = spawnSync(WATCHDOG_EXE, ['--help'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    return probe.status === 0;
  } catch {
    return false;
  }
}

const realExeSuite = shellIsElevated() ? describe : describe.skip;

realExeSuite('WatchdogClient against real watchdog.exe (elevated only)', () => {
  let pipeId: string;
  let token: string;
  let proc: ChildProcess;
  let client: WatchdogClient | undefined;

  beforeEach(() => {
    pipeId = `t${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    token = generateToken();
    proc = spawn(WATCHDOG_EXE, ['--pipe-id', pipeId], {
      env: { ...process.env, WATCHDOG_TOKEN: token },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  });

  afterEach(() => {
    if (client) {
      client.close();
      client = undefined;
    }
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      proc.kill();
    }
  });

  async function connect(tok: string = token): Promise<WatchdogClient> {
    const c = new WatchdogClient({ pipeId, token: tok, connectTimeoutMs: 10000 });
    await c.connect();
    return c;
  }

  it('(a) handshake + REGISTER_REGION -> STATUS reports regions=1', async () => {
    client = await connect();
    await client.registerRegions([{ x: 0, y: 0, w: 100, h: 100, id: 'r1' }]);
    const status = await client.status();
    expect(status.hooked).toBe(true);
    expect(status.regions).toBe(1);
    await client.shutdown();
  });

  it('(b) STATUS before any regions reports regions=0', async () => {
    client = await connect();
    const status = await client.status();
    expect(status.hooked).toBe(true);
    expect(status.regions).toBe(0);
    await client.shutdown();
  });

  it('(c) wrong token is rejected', async () => {
    await expect(connect('f'.repeat(64))).rejects.toBeInstanceOf(WatchdogAuthError);
  });

  it('(d) SHUTDOWN exits the watchdog cleanly (code 0)', async () => {
    client = await connect();
    await client.registerRegions([{ x: 0, y: 0, w: 10, h: 10, id: 'r' }]);
    const exited = new Promise<number | null>((resolve) =>
      proc.once('exit', (code) => resolve(code)),
    );
    await client.shutdown();
    expect(await exited).toBe(0);
  });
});
