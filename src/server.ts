/**
 * MCP server core (todo 9).
 *
 * `buildServer` is the composition root: it wires the four Windows providers
 * (`WindowsFileProvider`, `WindowsScreenProvider`, `WindowsInputProvider`) and
 * the `DebugSessionManager` (safety layer) into a single `McpServer` over the
 * `@modelcontextprotocol/sdk` high-level API, and registers the full
 * tool/resource surface.
 *
 * Safety invariant: the four input-injection tools (`mouse_click`,
 * `mouse_move`, `key_press`, `type_text`) route exclusively through the safety
 * manager's `injectGuarded` — the only path that enforces the window-scoping
 * and active-session gates. `NoActiveSessionError` / `WindowScopeViolationError`
 * (and every other provider error) surface as structured `{ isError: true }`
 * tool results, never as a crash.
 *
 * NOTE on schemas: `registerTool` takes `inputSchema` as a zod *raw shape*
 * (`{ path: z.string() }`), not a wrapped `z.object(...)`. The SDK's canonical
 * examples use the raw-shape form; passing a `ZodObject` directly trips
 * TS2589 ("Type instantiation is excessively deep") against zod 3.25's bundled
 * zod-v4 type surface (`zod/v4/core`), which the SDK references in its
 * `AnySchema` union. The raw shape is the same zod-v3 primitives, just
 * unwrapped.
 */

import { randomUUID } from 'node:crypto';

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
// Import from `zod/v3` (NOT `zod`): the SDK's zod-compat types reference
// `zod/v3` directly, so this keeps the schema types identity-compatible with
// its `z3.ZodTypeAny` and avoids the TS2589 "excessively deep" instantiation
// (and OOM) that `import { z } from 'zod'` triggers against the bundled
// zod-v4 type surface.
import { z } from 'zod/v3';

import { WindowsFileProvider, type FileAccessMode } from './filesystem';
import { WindowsInputProvider } from './input';
import type { FileProvider } from './platform/file';
import type { InputProvider } from './platform/input';
import type { ScreenProvider } from './platform/screen';
import { DebugSessionManager, type DebugSessionHandle } from './safety';
import { WindowsScreenProvider } from './screenshot';

const SERVER_NAME = 'mcp-windows-debug';
const SERVER_VERSION = '0.1.0';

const REGION_SHAPE = {
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  id: z.string(),
};

export interface BuildServerOptions {
  /** The MCP session id (also the watchdog named-pipe id). Generated per process. */
  sessionId?: string;
  /** File access policy for this session (default `denylist`). */
  fileMode?: FileAccessMode;
  /** Required when `fileMode === 'allowlist'`. */
  allowlistRoots?: string[];
  /** Injectable seams (default to the real Windows backends). */
  fileProvider?: FileProvider;
  screenProvider?: ScreenProvider;
  inputProvider?: InputProvider;
  safety?: DebugSessionManager;
}

/** Extract a human-readable message from any thrown value. */
function errorMessage(err: unknown): string {
  if (err !== null && typeof err === 'object') {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(err);
}

/** Extract a stable error code (e.g. `NO_ACTIVE_SESSION`) from a thrown value. */
function errorCode(err: unknown): string | undefined {
  if (err !== null && typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** Map a thrown error to a structured MCP tool error result. */
function toolError(err: unknown): CallToolResult {
  const code = errorCode(err);
  const text = code ? `[${code}] ${errorMessage(err)}` : errorMessage(err);
  return { content: [{ type: 'text', text }], isError: true };
}

/** Build a success tool result carrying a single text line. */
function okResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

/** Coerce a URI-template variable (string or string[]) to a single string. */
function firstVariable(value: string | string[]): string {
  return Array.isArray(value) ? (value[0] ?? '') : value;
}

/**
 * The MCP server wiring: every tool/resource is registered against the
 * providers passed in (or constructed by default).
 */
export function buildServer(options: BuildServerOptions = {}): McpServer {
  const sessionId = options.sessionId ?? randomUUID();
  const fileMode = options.fileMode ?? 'denylist';

  const files =
    options.fileProvider ??
    new WindowsFileProvider({ sessionId, mode: fileMode, allowlistRoots: options.allowlistRoots });
  const screens = options.screenProvider ?? new WindowsScreenProvider({ sessionId });
  const input = options.inputProvider ?? new WindowsInputProvider({ sessionId });
  const safety = options.safety ?? new DebugSessionManager({ sessionId });

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, resources: {} } },
  );

  // The active session handle, so `end_debug_session` can delegate to the
  // safety manager with the exact handle `start_debug_session` returned.
  let activeHandle: DebugSessionHandle | null = null;

  /**
   * The ONLY path for the four injection tools: wraps the raw provider call in
   * the safety manager's `injectGuarded`, which rejects with
   * `NoActiveSessionError` / `WindowScopeViolationError` unless a session is
   * ACTIVE and the cursor + keyboard focus are inside the target window.
   */
  const inject = (label: string, action: () => Promise<void>): Promise<CallToolResult> =>
    safety
      .injectGuarded(action)
      .then(() => okResult(label))
      .catch((err: unknown) => toolError(err));

  // -- File tools -------------------------------------------------------------

  server.registerTool(
    'read_file',
    {
      description:
        'Read a text file from an absolute path (binary files are returned base64-encoded).',
      inputSchema: { path: z.string(), mode: z.enum(['denylist', 'allowlist']).optional() },
    },
    async ({ path, mode }) => {
      if (mode !== undefined && mode !== fileMode) {
        return toolError(
          new Error(`mode '${mode}' is not configured for this session (configured: '${fileMode}')`),
        );
      }
      try {
        const result = await files.readFile(path);
        return { content: [{ type: 'text', text: result.content }] };
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    'list_directory',
    {
      description: 'List the immediate entries of a directory.',
      inputSchema: { path: z.string(), mode: z.enum(['denylist', 'allowlist']).optional() },
    },
    async ({ path, mode }) => {
      if (mode !== undefined && mode !== fileMode) {
        return toolError(
          new Error(`mode '${mode}' is not configured for this session (configured: '${fileMode}')`),
        );
      }
      try {
        const entries = await files.listDirectory(path);
        return { content: [{ type: 'text', text: JSON.stringify(entries) }] };
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // -- Screen tool ------------------------------------------------------------

  server.registerTool(
    'capture_window',
    {
      description: 'Capture a window by its exact title as a PNG (empty title = frontmost window).',
      inputSchema: { title: z.string() },
    },
    async ({ title }) => {
      try {
        const result = await screens.captureWindow(title);
        return {
          content: [
            {
              type: 'text',
              text: `captured window ${JSON.stringify(title)} (${result.width}x${result.height}, ${result.png.length} bytes)`,
            },
            {
              type: 'image',
              data: result.png.toString('base64'),
              mimeType: 'image/png',
            },
          ],
        };
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // -- Input tools (all through injectGuarded) --------------------------------

  server.registerTool(
    'mouse_click',
    {
      description: 'Click at logical screen coordinates with the given mouse button.',
      inputSchema: { x: z.number(), y: z.number(), button: z.string() },
    },
    ({ x, y, button }) =>
      inject(`clicked ${button} at (${x},${y})`, () => input.mouseClick(x, y, button)),
  );

  server.registerTool(
    'mouse_move',
    {
      description: 'Move the mouse cursor to logical screen coordinates.',
      inputSchema: { x: z.number(), y: z.number() },
    },
    ({ x, y }) => inject(`moved mouse to (${x},${y})`, () => input.mouseMove(x, y)),
  );

  server.registerTool(
    'key_press',
    {
      description: 'Press a key, optionally holding modifier keys.',
      inputSchema: { key: z.string(), modifiers: z.array(z.string()).optional() },
    },
    ({ key, modifiers }) =>
      inject(`pressed key ${JSON.stringify(key)}`, () => input.keyPress(key, modifiers ?? [])),
  );

  server.registerTool(
    'type_text',
    {
      description: 'Type a text string as keyboard input.',
      inputSchema: { text: z.string() },
    },
    ({ text }) => inject(`typed ${text.length} characters`, () => input.typeText(text)),
  );

  // -- Session lifecycle ------------------------------------------------------

  server.registerTool(
    'start_debug_session',
    {
      description:
        'Start a debug session: spawn/attach the safety watchdog and register protected abort regions.',
      inputSchema: { regions: z.array(z.object(REGION_SHAPE)) },
    },
    async ({ regions }) => {
      try {
        const handle = await safety.startDebugSession(regions);
        activeHandle = handle;
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ id: handle.id, regions: handle.regions.length }),
            },
          ],
        };
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    'end_debug_session',
    {
      description: 'End the active debug session and shut down the safety watchdog.',
      inputSchema: { id: z.string().optional() },
    },
    async ({ id }) => {
      try {
        const handle = activeHandle;
        if (!handle) {
          return toolError(new Error('no active debug session'));
        }
        if (id !== undefined && id !== handle.id) {
          return toolError(new Error(`unknown session handle: ${JSON.stringify(id)}`));
        }
        await safety.endDebugSession(handle);
        activeHandle = null;
        return { content: [{ type: 'text', text: 'debug session ended' }] };
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // -- Orchestration stub (todo 10) -------------------------------------------

  server.registerTool(
    'execute_action',
    {
      description:
        'Execute a client-decided action within the active debug session (routed through the safety gate).',
      inputSchema: { action: z.string(), params: z.record(z.unknown()).optional() },
    },
    ({ action }) =>
      safety
        .injectGuarded(async () => {
          // The full orchestrator dispatch lands in todo 10.
        })
        .then(() =>
          okResult(
            `execute_action(${JSON.stringify(action)}) accepted — orchestrator dispatch is todo 10`,
          ),
        )
        .catch((err: unknown) => toolError(err)),
  );

  // -- Resources --------------------------------------------------------------

  server.registerResource(
    'screenshot-full',
    'screenshot://full',
    {
      title: 'Full-screen screenshot',
      description: 'PNG capture of the primary monitor.',
      mimeType: 'image/png',
    },
    async (uri) => {
      const result = await screens.captureFull();
      return {
        contents: [
          { uri: uri.toString(), mimeType: 'image/png', blob: result.png.toString('base64') },
        ],
      };
    },
  );

  server.registerResource(
    'screenshot-monitor',
    new ResourceTemplate('screenshot://monitor/{index}', { list: undefined }),
    {
      title: 'Monitor screenshot',
      description: 'PNG capture of a specific monitor by 0-based index.',
      mimeType: 'image/png',
    },
    async (uri, variables): Promise<ReadResourceResult> => {
      const index = Number(firstVariable(variables.index));
      const provider = new WindowsScreenProvider({ sessionId, monitorIndex: index });
      const result = await provider.captureFull();
      return {
        contents: [
          { uri: uri.toString(), mimeType: 'image/png', blob: result.png.toString('base64') },
        ],
      };
    },
  );

  server.registerResource(
    'debug-context',
    'debug://context',
    {
      title: 'Debug context',
      description: 'Current auto-debug loop context (filled in by todo 10).',
      mimeType: 'application/json',
    },
    async (uri): Promise<ReadResourceResult> => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: 'application/json',
          text: JSON.stringify({
            status: 'idle',
            sessionState: safety.state,
            note: 'orchestrator not wired (todo 10)',
          }),
        },
      ],
    }),
  );

  return server;
}
