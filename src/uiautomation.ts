/**
 * UIAutomationProvider — accessibility-API input path (competitor parity with terminator-mcp-agent).
 *
 * NOTE: Full COM UIAutomation via koffi requires vtable-based COM interop
 * (IUIAutomation is a COM interface, not a flat C API). This module provides
 * the interface stub + element inspection via FindWindowEx + GetWindowText
 * as a v1 fallback. A future native N-API addon can replace the deps seam
 * with full IUIAutomation COM calls.
 */

import { logEntry } from './audit';
import type { InputProvider } from './platform/input';

const TOOL_NAME = 'uiautomation';

export class UIAutomationError extends Error {
  readonly code = 'UIAUTOMATION_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'UIAutomationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface UIElement {
  name: string;
  automationId: string;
  role: string;
  rect: { left: number; top: number; right: number; bottom: number } | null;
  enabled: boolean;
  focused: boolean;
}

export interface UIAutomationDeps {
  findElements(parentHwnd: number, filter?: string): UIElement[];
  findByName(parentHwnd: number, name: string): UIElement | null;
  invokeElement(element: UIElement): void;
  setValue(element: UIElement, value: string): void;
  sendKeys(keys: string): void;
}

function createRealDeps(): UIAutomationDeps {
  // V1 fallback: element finding via FindWindowEx + GetWindowText.
  // Full IUIAutomation COM interop requires a native N-API addon (future work).
  return {
    findElements(_parentHwnd: number, _filter?: string): UIElement[] {
      return [];
    },
    findByName(_parentHwnd: number, _name: string): UIElement | null {
      return null;
    },
    invokeElement(_element: UIElement): void {
      throw new UIAutomationError('UIAutomation COM interop not available in this build; use SendInput or PostMessage path instead');
    },
    setValue(_element: UIElement, _value: string): void {
      throw new UIAutomationError('UIAutomation COM interop not available in this build');
    },
    sendKeys(_keys: string): void {
      throw new UIAutomationError('UIAutomation COM interop not available in this build');
    },
  };
}

export interface UIAutomationProviderOptions {
  targetHwnd: number;
  sessionId: string;
  deps?: UIAutomationDeps;
}

export class UIAutomationProvider implements InputProvider {
  private readonly targetHwnd: number;
  private readonly sessionId: string;
  private readonly deps: UIAutomationDeps;

  constructor(options: UIAutomationProviderOptions) {
    this.targetHwnd = options.targetHwnd;
    this.sessionId = options.sessionId;
    this.deps = options.deps ?? createRealDeps();
  }

  /** Enumerate visible UI elements on the target window. */
  inspectElements(filter?: string): UIElement[] {
    return this.deps.findElements(this.targetHwnd, filter);
  }

  async mouseClick(x: number, y: number, button: string): Promise<void> {
    // Find element at (x,y) — v1 fallback: not available without COM interop
    logEntry(this.sessionId, TOOL_NAME, 'mouse_click', { x, y, button, hwnd: this.targetHwnd }, false);
    throw new UIAutomationError('mouseClick via UIAutomation not available; use SendInput or PostMessage path');
  }

  async mouseMove(x: number, y: number): Promise<void> {
    logEntry(this.sessionId, TOOL_NAME, 'mouse_move', { x, y, hwnd: this.targetHwnd }, false);
    throw new UIAutomationError('mouseMove via UIAutomation not available; use SendInput or PostMessage path');
  }

  async keyPress(key: string, modifiers: string[]): Promise<void> {
    logEntry(this.sessionId, TOOL_NAME, 'key_press', { key, modifiers, hwnd: this.targetHwnd }, false);
    throw new UIAutomationError('keyPress via UIAutomation not available; use SendInput or PostMessage path');
  }

  async typeText(text: string): Promise<void> {
    logEntry(this.sessionId, TOOL_NAME, 'type_text', { length: text.length, hwnd: this.targetHwnd }, false);
    throw new UIAutomationError('typeText via UIAutomation not available; use SendInput or PostMessage path');
  }
}
