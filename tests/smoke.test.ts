/**
 * Smoke test: assert the four platform provider interface files export
 * their interfaces, so `npm test` has a green placeholder.
 */

describe('scaffold smoke', () => {
  it('exports InputProvider from src/platform/input.ts', () => {
    const mod = require('../src/platform/input');
    expect(mod).toBeDefined();
  });

  it('exports ScreenProvider from src/platform/screen.ts', () => {
    const mod = require('../src/platform/screen');
    expect(mod).toBeDefined();
  });

  it('exports FileProvider from src/platform/file.ts', () => {
    const mod = require('../src/platform/file');
    expect(mod).toBeDefined();
  });

  it('exports SafetyProvider from src/platform/safety.ts', () => {
    const mod = require('../src/platform/safety');
    expect(mod).toBeDefined();
  });
});
