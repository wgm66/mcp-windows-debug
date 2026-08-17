/**
 * Windows backend of ScreenProvider.
 *
 * Captures the full screen (or a specific monitor by index) and individual
 * windows by title via node-screenshots. Every capture appends an audit entry
 * via `logEntry`; only image metadata (dimensions/size, monitor id, window
 * title) is logged — never the pixel payload.
 */

import { Monitor, Window } from 'node-screenshots';

import { logEntry } from './audit';
import type { CaptureResult, ScreenProvider } from './platform/screen';

/** Tool name reported to the audit log. */
const TOOL_NAME = 'screenshot';

export interface WindowsScreenProviderOptions {
  sessionId: string;
  /** 0-based index into Monitor.all(). Omit to capture the primary monitor. */
  monitorIndex?: number;
}

export class WindowNotFoundError extends Error {
  readonly code = 'WINDOW_NOT_FOUND';
  constructor(title: string) {
    super(`window not found: ${JSON.stringify(title)}`);
    this.name = 'WindowNotFoundError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function errorMessage(err: unknown): string {
  if (err !== null && typeof err === 'object') {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(err);
}

export class WindowsScreenProvider implements ScreenProvider {
  private readonly sessionId: string;
  private readonly monitorIndex: number | undefined;

  constructor(options: WindowsScreenProviderOptions) {
    this.sessionId = options.sessionId;
    this.monitorIndex = options.monitorIndex;
  }

  async captureFull(): Promise<CaptureResult> {
    try {
      const monitors = Monitor.all();
      if (monitors.length === 0) {
        throw new Error('no monitors available for capture');
      }
      const monitor = this.selectMonitor(monitors);
      const image = await monitor.captureImage();
      const png = await image.toPng();
      this.log(
        'capture_full',
        {
          width: image.width,
          height: image.height,
          size: png.length,
          monitorId: monitor.id(),
        },
        true,
      );
      return { png, width: image.width, height: image.height };
    } catch (err) {
      this.log('capture_full', { error: errorMessage(err) }, false);
      throw err;
    }
  }

  async captureWindow(title: string): Promise<CaptureResult> {
    try {
      const window = this.findWindow(title);
      const image = await window.captureImage();
      const png = await image.toPng();
      this.log(
        'capture_window',
        { title, width: image.width, height: image.height, size: png.length },
        true,
      );
      return { png, width: image.width, height: image.height };
    } catch (err) {
      this.log('capture_window', { title, error: errorMessage(err) }, false);
      throw err;
    }
  }

  private selectMonitor(monitors: Monitor[]): Monitor {
    if (this.monitorIndex !== undefined) {
      const monitor = monitors[this.monitorIndex];
      if (!monitor) {
        throw new Error(
          `monitor index ${this.monitorIndex} out of range (${monitors.length} monitors)`,
        );
      }
      return monitor;
    }
    return monitors.find((m) => m.isPrimary()) ?? monitors[0];
  }

  private findWindow(title: string): Window {
    const windows = Window.all();
    // An empty title is a sentinel for the frontmost window; Window.all() is
    // sorted by z coordinate descending, so the first entry is the topmost.
    if (title === '') {
      const topmost = windows[0];
      if (!topmost) throw new WindowNotFoundError(title);
      return topmost;
    }
    const match = windows.find((w) => w.title() === title);
    if (!match) throw new WindowNotFoundError(title);
    return match;
  }

  private log(action: string, details: Record<string, unknown>, success: boolean): void {
    logEntry(this.sessionId, TOOL_NAME, action, details, success);
  }
}
