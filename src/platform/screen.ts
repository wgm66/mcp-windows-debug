/**
 * ScreenProvider abstracts platform-specific screen capture.
 * The Windows backend implements this via node-screenshots.
 *
 * NOTE: pure type declaration only — no platform code here.
 */

/** A captured screen image plus its dimensions. */
export interface CaptureResult {
  png: Buffer;
  width: number;
  height: number;
}

export interface ScreenProvider {
  /** Capture the entire screen. */
  captureFull(): Promise<CaptureResult>;
  /** Capture a specific window by its title. */
  captureWindow(title: string): Promise<CaptureResult>;
}
