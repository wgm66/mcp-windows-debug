/**
 * InputProvider abstracts platform-specific input injection.
 * The Windows backend implements this via koffi + SendInput.
 *
 * NOTE: pure type declaration only — no platform code here.
 */
export interface InputProvider {
  /** Click at screen coordinates with the given mouse button. */
  mouseClick(x: number, y: number, button: string): Promise<void>;
  /** Move the mouse cursor to screen coordinates. */
  mouseMove(x: number, y: number): Promise<void>;
  /** Press a key, optionally with modifier keys held. */
  keyPress(key: string, modifiers: string[]): Promise<void>;
  /** Type a text string as keyboard input. */
  typeText(text: string): Promise<void>;
}
