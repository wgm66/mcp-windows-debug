/**
 * Elevation tests (TDD).
 */

import { elevateWatchdog } from '../src/elevation';
import type { ElevationDeps } from '../src/elevation';

function makeFakeDeps(overrides: Partial<ElevationDeps> = {}): ElevationDeps {
  return {
    shellExecuteExW: () => true,
    getLastError: () => 0,
    waitForSingleObject: () => 0,
    closeHandle: () => true,
    ...overrides,
  };
}

describe('elevateWatchdog', () => {
  it('returns success when ShellExecuteExW succeeds', () => {
    const deps = makeFakeDeps({ shellExecuteExW: () => true });
    const result = elevateWatchdog('C:\\watchdog.exe', 'pipe-123', 'token-abc', deps);
    expect(result.success).toBe(true);
    expect(result.errorMessage).toBeUndefined();
  });

  it('returns ERROR_CANCELLED when user declines UAC', () => {
    const deps = makeFakeDeps({
      shellExecuteExW: () => false,
      getLastError: () => 1223,
    });
    const result = elevateWatchdog('C:\\watchdog.exe', 'pipe-123', 'token-abc', deps);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe(1223);
    expect(result.errorMessage).toContain('cancelled');
  });

  it('returns ERROR_ELEVATION_REQUIRED when elevation denied', () => {
    const deps = makeFakeDeps({
      shellExecuteExW: () => false,
      getLastError: () => 740,
    });
    const result = elevateWatchdog('C:\\watchdog.exe', 'pipe-123', 'token-abc', deps);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe(740);
    expect(result.errorMessage).toContain('Elevation required');
  });

  it('sets WATCHDOG_TOKEN in environment', () => {
    const deps = makeFakeDeps();
    delete process.env.WATCHDOG_TOKEN;
    elevateWatchdog('C:\\watchdog.exe', 'pipe-123', 'my-secret-token', deps);
    expect(process.env.WATCHDOG_TOKEN).toBe('my-secret-token');
    delete process.env.WATCHDOG_TOKEN;
  });
});
