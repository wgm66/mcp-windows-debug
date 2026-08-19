/**
 * Sandbox mode integration tests.
 */

import { WindowsDesktopSandbox } from '../src/sandbox/desktop-sandbox';
import { LocalRdpSandbox } from '../src/sandbox/rdp-sandbox';
import { NotImplementedError } from '../src/platform/sandbox';
import { PostMessageInputProvider, makeLParam, keyToVk } from '../src/input-postmessage';
import { BitBltScreenProvider, encodePng } from '../src/screenshot-bitblt';

describe('sandbox mode integration', () => {
  it('LocalRdpSandbox.createSandbox throws NotImplementedError', async () => {
    const rdp = new LocalRdpSandbox();
    await expect(rdp.createSandbox({ mode: 'rdp' })).rejects.toBeInstanceOf(NotImplementedError);
  });

  it('PostMessageInputProvider makeLParam + keyToVk work for sandbox injection', () => {
    const lp = makeLParam(100, 200);
    expect(lp & 0xffff).toBe(100);
    expect((lp >>> 16) & 0xffff).toBe(200);
    expect(keyToVk('enter')).toBe(0x0d);
  });

  it('BitBltScreenProvider encodePng produces valid PNG', () => {
    const bgra = Buffer.alloc(16);
    const png = encodePng(2, 2, bgra);
    expect(png[0]).toBe(0x89);
    expect(png[1]).toBe(0x50);
  });

  it('WindowsDesktopSandbox is constructable', () => {
    const sandbox = new WindowsDesktopSandbox({ sessionId: 'test-sb' });
    expect(typeof sandbox.createSandbox).toBe('function');
  });

  it('PostMessageInputProvider can be constructed with fake deps', () => {
    const fakeDeps = {
      postMessageW: () => {},
      sendMessageW: () => 0n,
      screenToClient: (_h: number, x: number, y: number) => ({ x, y }),
      vkKeyScanW: (ch: string) => ch.charCodeAt(0),
    };
    const provider = new PostMessageInputProvider({ targetHwnd: 1, sessionId: 'test', deps: fakeDeps });
    expect(provider).toBeDefined();
  });

  it('BitBltScreenProvider can be constructed with fake deps', () => {
    const fakeDeps = {
      printWindow: () => true,
      getClientRect: () => ({ width: 1, height: 1 }),
      createCompatibleDC: () => 1,
      createCompatibleBitmap: () => 1,
      selectObject: () => 0,
      getDIBits: () => 1,
      deleteDC: () => true,
      deleteObject: () => true,
      findWindowEx: () => 1,
    };
    const provider = new BitBltScreenProvider({ targetHwnd: 1, sessionId: 'test', deps: fakeDeps });
    expect(provider).toBeDefined();
  });
});
