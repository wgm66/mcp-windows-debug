/**
 * LocalRdpSandbox — reserved RDP-session sandbox backend (NOT implemented in v1).
 *
 * Throws NotImplementedError on createSandbox so the interface is available
 * for future Pro-edition full-isolation work without changing call sites.
 */

import type { SandboxConfig, SandboxHandle, SandboxProvider } from '../platform/sandbox';
import { NotImplementedError } from '../platform/sandbox';

export class LocalRdpSandbox implements SandboxProvider {
  async createSandbox(_config: SandboxConfig): Promise<SandboxHandle> {
    throw new NotImplementedError('LocalRdpSandbox is not implemented; use WindowsDesktopSandbox (mode: desktop) instead');
  }
}
