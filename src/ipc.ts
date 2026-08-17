/**
 * WatchdogClient - Node-side IPC client for the native McpWatchdog process.
 *
 * Transport: a Windows named pipe `\\.\pipe\McpWatchdog-<pipeId>`.
 * Framing: newline-delimited JSON - each message is one JSON object followed
 * by `\n`. Authentication: the first message after connect is `{"token":"..."}`;
 * the watchdog compares it against the WATCHDOG_TOKEN env var it was spawned
 * with and replies `{"ok":false,"error":"unauthorized"}` + closes the pipe on
 * a mismatch.
 *
 * See src/watchdog/README.md for the full frame format.
 */

import * as crypto from 'node:crypto';
import * as net from 'node:net';

import type { Region, SafetyStatus } from './platform/safety';

export type { Region, SafetyStatus } from './platform/safety';

export interface WatchdogClientOptions {
  /** Named-pipe id; the pipe path is `\\.\pipe\McpWatchdog-<pipeId>`. */
  pipeId: string;
  /** Hex token shared with the watchdog (spawned with WATCHDOG_TOKEN). */
  token: string;
  /** Total budget (ms) to wait for the pipe to appear before failing. */
  connectTimeoutMs?: number;
}

/** The pipe could not be reached, or the connection dropped mid-request. */
export class WatchdogConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WatchdogConnectionError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The watchdog rejected the presented token. */
export class WatchdogAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WatchdogAuthError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The watchdog replied with a malformed or negative acknowledgment. */
export class WatchdogProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WatchdogProtocolError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Generate a fresh 32-byte (64 hex chars) session token. */
export function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

const REQUEST_TIMEOUT_MS = 5000;
const RETRY_DELAY_MS = 100;

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class WatchdogClient {
  private readonly pipePath: string;
  private readonly token: string;
  private readonly connectTimeoutMs: number;

  private socket: net.Socket | null = null;
  private lineBuffer = '';
  private pending: PendingRequest[] = [];

  constructor(options: WatchdogClientOptions) {
    this.pipePath = `\\\\.\\pipe\\McpWatchdog-${options.pipeId}`;
    this.token = options.token;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5000;
  }

  /** True once the token handshake has completed. */
  get connected(): boolean {
    return this.socket !== null;
  }

  /**
   * Connect to the pipe and complete the token handshake. Retries while the
   * pipe has not yet been created (the watchdog may still be starting), but a
   * rejected token is permanent and throws immediately.
   */
  async connect(): Promise<void> {
    if (this.socket) return;
    const deadline = Date.now() + this.connectTimeoutMs;
    let lastError: Error = new WatchdogConnectionError('connect timed out');
    for (;;) {
      try {
        const socket = await this.openSocket();
        this.attach(socket);
        await this.handshake();
        return;
      } catch (err) {
        const cause = err as Error;
        this.teardown();
        if (cause instanceof WatchdogAuthError) throw cause;
        lastError = cause;
        if (Date.now() >= deadline) break;
        await sleep(RETRY_DELAY_MS);
      }
    }
    throw lastError;
  }

  /** Register (append) protected regions; sequential and acknowledged. */
  async registerRegions(regions: Region[]): Promise<void> {
    for (const region of regions) {
      const reply = await this.request({
        op: 'REGISTER_REGION',
        x: region.x,
        y: region.y,
        w: region.w,
        h: region.h,
        id: region.id,
      });
      if (reply.ok !== true) {
        const detail = typeof reply.error === 'string' ? reply.error : 'unknown error';
        throw new WatchdogProtocolError(`REGISTER_REGION failed: ${detail}`);
      }
    }
  }

  /** Refresh the watchdog's dead-man switch (fire-and-forget). */
  async heartbeat(): Promise<void> {
    this.send({ op: 'HEARTBEAT' });
  }

  /** Query whether the watchdog is hooked and how many regions are active. */
  async status(): Promise<SafetyStatus> {
    const reply = await this.request({ op: 'STATUS' });
    if (typeof reply.hooked !== 'boolean' || typeof reply.regions !== 'number') {
      throw new WatchdogProtocolError('malformed STATUS reply');
    }
    return { hooked: reply.hooked, regions: reply.regions };
  }

  /** Ask the watchdog to unhook and exit; resolves once the pipe closes. */
  async shutdown(): Promise<void> {
    const socket = this.socket;
    if (!socket) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => socket.destroy(), REQUEST_TIMEOUT_MS);
      socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.write(`${JSON.stringify({ op: 'SHUTDOWN' })}\n`);
    });
    this.socket = null;
  }

  /** Close the socket immediately (no shutdown handshake). */
  close(): void {
    this.teardown();
  }

  // -- internals -------------------------------------------------------------

  private openSocket(): Promise<net.Socket> {
    return new Promise<net.Socket>((resolve, reject) => {
      const socket = net.connect(this.pipePath);
      socket.setNoDelay(true);
      const onError = (err: Error) =>
        reject(new WatchdogConnectionError(`pipe connect failed: ${err.message}`));
      socket.once('error', onError);
      socket.once('connect', () => {
        socket.removeListener('error', onError);
        resolve(socket);
      });
    });
  }

  private attach(socket: net.Socket): void {
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', (err: Error) =>
      this.rejectAllPending(new WatchdogConnectionError(err.message)),
    );
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null;
      this.rejectAllPending(new WatchdogConnectionError('connection closed'));
    });
  }

  private teardown(): void {
    this.rejectAllPending(new WatchdogConnectionError('connection closed'));
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }

  private send(obj: Record<string, unknown>): void {
    const socket = this.socket;
    if (!socket) throw new WatchdogConnectionError('not connected');
    socket.write(`${JSON.stringify(obj)}\n`);
  }

  private request(
    obj: Record<string, unknown>,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new WatchdogConnectionError('not connected'));
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const entry: PendingRequest = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.removePending(entry);
          reject(new WatchdogConnectionError('timed out waiting for watchdog reply'));
        }, timeoutMs),
      };
      this.pending.push(entry);
      socket.write(`${JSON.stringify(obj)}\n`);
    });
  }

  private removePending(entry: PendingRequest): void {
    const idx = this.pending.indexOf(entry);
    if (idx >= 0) this.pending.splice(idx, 1);
  }

  private rejectAllPending(err: Error): void {
    for (const entry of this.pending.splice(0)) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
  }

  private onData(chunk: Buffer): void {
    this.lineBuffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = this.lineBuffer.indexOf('\n')) >= 0) {
      const line = this.lineBuffer.slice(0, idx).replace(/\r$/, '');
      this.lineBuffer = this.lineBuffer.slice(idx + 1);
      if (line.length === 0) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // ignore malformed frames
      }
      const entry = this.pending.shift();
      if (entry) {
        clearTimeout(entry.timer);
        entry.resolve(parsed);
      }
    }
  }

  private async handshake(): Promise<void> {
    const reply = await this.request({ token: this.token });
    if (reply.ok === true) return;
    const detail = typeof reply.error === 'string' ? reply.error : 'token rejected';
    throw new WatchdogAuthError(detail);
  }
}
