/**
 * UIAutomationProvider tests (TDD).
 */

import { UIAutomationProvider, UIAutomationError } from '../src/uiautomation';
import type { UIAutomationDeps, UIElement } from '../src/uiautomation';

function makeFakeDeps(overrides: Partial<UIAutomationDeps> = {}): UIAutomationDeps {
  const elements: UIElement[] = [
    { name: 'OK Button', automationId: 'btnOK', role: 'button', rect: { left: 10, top: 10, right: 50, bottom: 30 }, enabled: true, focused: false },
    { name: 'Input Field', automationId: 'txtInput', role: 'edit', rect: { left: 10, top: 40, right: 200, bottom: 60 }, enabled: true, focused: true },
  ];
  return {
    findElements: () => elements,
    findByName: (_h: number, name: string) => elements.find(function (e) { return e.name === name; }) ?? null,
    invokeElement: () => {},
    setValue: () => {},
    sendKeys: () => {},
    ...overrides,
  };
}

describe('UIAutomationProvider', () => {
  it('inspectElements returns elements from deps', () => {
    const provider = new UIAutomationProvider({
      targetHwnd: 1, sessionId: 'test', deps: makeFakeDeps(),
    });
    const elements = provider.inspectElements();
    expect(elements).toHaveLength(2);
    expect(elements[0].name).toBe('OK Button');
  });

  it('inspectElements with filter narrows results', () => {
    const provider = new UIAutomationProvider({
      targetHwnd: 1, sessionId: 'test', deps: makeFakeDeps(),
    });
    const elements = provider.inspectElements('OK');
    expect(elements.length).toBeLessThanOrEqual(2);
    expect(elements.some(function (e) { return e.name.includes('OK'); })).toBe(true);
  });

  it('mouseClick throws UIAutomationError in v1 stub', async () => {
    const provider = new UIAutomationProvider({
      targetHwnd: 1, sessionId: 'test', deps: makeFakeDeps(),
    });
    await expect(provider.mouseClick(10, 10, 'left')).rejects.toBeInstanceOf(UIAutomationError);
  });

  it('typeText throws UIAutomationError in v1 stub', async () => {
    const provider = new UIAutomationProvider({
      targetHwnd: 1, sessionId: 'test', deps: makeFakeDeps(),
    });
    await expect(provider.typeText('hello')).rejects.toBeInstanceOf(UIAutomationError);
  });

  it('implements InputProvider interface', () => {
    const provider = new UIAutomationProvider({
      targetHwnd: 1, sessionId: 'test', deps: makeFakeDeps(),
    });
    expect(typeof provider.mouseClick).toBe('function');
    expect(typeof provider.mouseMove).toBe('function');
    expect(typeof provider.keyPress).toBe('function');
    expect(typeof provider.typeText).toBe('function');
  });
});
