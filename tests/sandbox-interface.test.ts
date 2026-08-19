/**
 * SandboxProvider interface + LocalRdpSandbox stub tests (TDD).
 */

import { LocalRdpSandbox } from '../src/sandbox/rdp-sandbox';
import { NotImplementedError } from '../src/platform/sandbox';
import type { SandboxProvider } from '../src/platform/sandbox';

describe('SandboxProvider interface + LocalRdpSandbox stub', () => {
  it('LocalRdpSandbox implements SandboxProvider', () => {
    const provider: SandboxProvider = new LocalRdpSandbox();
    expect(typeof provider.createSandbox).toBe('function');
  });

  it('createSandbox throws NotImplementedError', async () => {
    const provider = new LocalRdpSandbox();
    await expect(provider.createSandbox({ mode: 'rdp' })).rejects.toBeInstanceOf(
      NotImplementedError,
    );
  });

  it('NotImplementedError has code NOT_IMPLEMENTED', async () => {
    const provider = new LocalRdpSandbox();
    try {
      await provider.createSandbox({ mode: 'rdp' });
      fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NotImplementedError);
      const e = err as NotImplementedError;
      expect(e.code).toBe('NOT_IMPLEMENTED');
      expect(e.name).toBe('NotImplementedError');
    }
  });
});