/**
 * Competitive test suite — exercises all new improvement paths.
 */

import { elevateWatchdog } from '../src/elevation';
import type { ElevationDeps } from '../src/elevation';
import { UIAutomationProvider, UIAutomationError } from '../src/uiautomation';
import type { UIAutomationDeps, UIElement } from '../src/uiautomation';
import { SessionRecorder } from '../src/recording';

function makeFakeElevationDeps(overrides: Partial<ElevationDeps> = {}): ElevationDeps {
  return {
    shellExecuteExW: () => true,
    getLastError: () => 0,
    waitForSingleObject: () => 0,
    closeHandle: () => true,
    ...overrides,
  };
}

function makeFakeUIADeps(overrides: Partial<UIAutomationDeps> = {}): UIAutomationDeps {
  const elements: UIElement[] = [
    { name: 'OK', automationId: 'btnOK', role: 'button', rect: { left: 0, top: 0, right: 50, bottom: 30 }, enabled: true, focused: false },
  ];
  return {
    findElements: () => elements,
    findByName: () => elements[0] ?? null,
    invokeElement: () => {},
    setValue: () => {},
    sendKeys: () => {},
    ...overrides,
  };
}

describe('competitive test suite', () => {
  describe('elevation (ShellExecuteExW)', () => {
    it('succeeds with correct params', () => {
      const result = elevateWatchdog('C:\\wd.exe', 'pipe1', 'tok1', makeFakeElevationDeps());
      expect(result.success).toBe(true);
    });

    it('handles ERROR_CANCELLED (1223)', () => {
      const result = elevateWatchdog('C:\\wd.exe', 'pipe1', 'tok1',
        makeFakeElevationDeps({ shellExecuteExW: () => false, getLastError: () => 1223 }));
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(1223);
    });

    it('handles ERROR_ELEVATION_REQUIRED (740)', () => {
      const result = elevateWatchdog('C:\\wd.exe', 'pipe1', 'tok1',
        makeFakeElevationDeps({ shellExecuteExW: () => false, getLastError: () => 740 }));
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(740);
    });
  });

  describe('UIAutomationProvider', () => {
    it('inspectElements returns elements', () => {
      const provider = new UIAutomationProvider({ targetHwnd: 1, sessionId: 's', deps: makeFakeUIADeps() });
      const els = provider.inspectElements();
      expect(els).toHaveLength(1);
      expect(els[0].name).toBe('OK');
    });

    it('mouseClick throws UIAutomationError in v1', async () => {
      const provider = new UIAutomationProvider({ targetHwnd: 1, sessionId: 's', deps: makeFakeUIADeps() });
      await expect(provider.mouseClick(0, 0, 'left')).rejects.toBeInstanceOf(UIAutomationError);
    });

    it('implements InputProvider interface', () => {
      const provider = new UIAutomationProvider({ targetHwnd: 1, sessionId: 's', deps: makeFakeUIADeps() });
      expect(typeof provider.mouseClick).toBe('function');
      expect(typeof provider.typeText).toBe('function');
    });
  });

  describe('session recording', () => {
    it('records and retrieves transcript', () => {
      const recorder = new SessionRecorder('test-session');
      recorder.record('read_file', { path: 'test.txt' }, { content: 'hello' });
      recorder.record('mouse_click', { x: 1, y: 2 }, {});
      const transcript = recorder.getTranscript();
      expect(transcript).toHaveLength(2);
      expect(transcript[0].toolName).toBe('read_file');
    });

    it('does not record keystroke content', () => {
      const recorder = new SessionRecorder('test-session-2');
      recorder.record('type_text', { text: 'secret-password', keystrokes: 'data' }, {});
      const transcript = recorder.getTranscript();
      expect(transcript).toHaveLength(1);
      const args = transcript[0].args as Record<string, unknown>;
      expect(args.text).toBeUndefined();
      expect(args.keystrokes).toBeUndefined();
    });
  });

  describe('config validation', () => {
    it('--validate-config is in index.ts', () => {
      const fs = require('fs');
      const content = fs.readFileSync('src/index.ts', 'utf8');
      expect(content).toContain('--validate-config');
      expect(content).toContain('validateConfig');
    });
  });

  describe('CI workflow', () => {
    it('ci.yml exists with build+test', () => {
      const fs = require('fs');
      const content = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
      expect(content).toContain('npm run build');
      expect(content).toContain('npx tsc --noEmit');
      expect(content).toContain('npx jest');
      expect(content).toContain('windows-latest');
    });
  });

  describe('inspect_element tool registered', () => {
    it('server.ts registers inspect_element', () => {
      const fs = require('fs');
      const content = fs.readFileSync('src/server.ts', 'utf8');
      expect(content).toContain('inspect_element');
    });
  });
});
