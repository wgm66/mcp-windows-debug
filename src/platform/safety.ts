/**
 * SafetyProvider abstracts the dual-process safety watchdog.
 * The Windows backend implements this as a separate watchdog process
 * that blocks input/execution in registered exclusion regions.
 *
 * NOTE: pure type declaration only — no platform code here.
 */

/** A rectangular exclusion region in screen coordinates. */
export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
  id: string;
}

/** Live status of the safety watchdog. */
export interface SafetyStatus {
  hooked: boolean;
  regions: number;
}

export interface SafetyProvider {
  /** Register (or replace) the set of protected exclusion regions. */
  registerRegions(regions: Region[]): Promise<void>;
  /** Confirm the watchdog process is still alive. */
  heartbeat(): Promise<void>;
  /** Gracefully stop the watchdog process. */
  shutdown(): Promise<void>;
  /** Report whether the watchdog is hooked and how many regions are active. */
  status(): Promise<SafetyStatus>;
}
