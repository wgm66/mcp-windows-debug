/**
 * SandboxProvider abstracts the isolation mechanism for automated GUI
 * debugging. The Windows desktop backend (v1) creates a private Win32
 * desktop; a future LocalRdpSandbox backend will isolate via a separate
 * RDP session.
 *
 * NOTE: pure type declaration only — no platform code here.
 */

/** Configuration for creating an isolated sandbox. */
export interface SandboxConfig {
  /** Isolation mechanism: 'desktop' = private Win32 desktop (v1), 'rdp' = local RDP session (reserved). */
  mode: 'desktop' | 'rdp';
  /** Path to the target application to spawn inside the sandbox. */
  targetApp?: string;
  /** Existing window handle to attach to (alternative to targetApp). */
  targetHwnd?: number;
}

/** Handle to an active sandbox session. */
export interface SandboxHandle {
  /** Name of the private desktop (or RDP session identifier). */
  desktopName: string;
  /** Window handle of the target application inside the sandbox. */
  targetHwnd: number;
  /** Tear down the sandbox: close the desktop, terminate spawned processes, release resources. */
  dispose(): Promise<void>;
}

/** Provider interface for creating isolated sandboxes. */
export interface SandboxProvider {
  /** Create an isolated sandbox and spawn/attach the target application. */
  createSandbox(config: SandboxConfig): Promise<SandboxHandle>;
}

/** Thrown when a sandbox backend is not yet implemented (e.g., RDP in v1). */
export class NotImplementedError extends Error {
  readonly code = 'NOT_IMPLEMENTED';
  constructor(message = 'sandbox backend not implemented') {
    super(message);
    this.name = 'NotImplementedError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
