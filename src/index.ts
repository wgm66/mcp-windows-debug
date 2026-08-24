/**
 * Entry point: build the MCP server and connect it to the stdio transport.
 *
 * OpenCode config:
 *   { "mcp": { "windows-debug": { "type": "local", "command": ["node", "./dist/index.js"] } } }
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { buildServer } from './server';

export type {
  SandboxConfig,
  SandboxHandle,
  SandboxProvider,
  NotImplementedError,
} from './platform/sandbox';
export { LocalRdpSandbox } from './sandbox/rdp-sandbox';

/** Strip JSONC comments while respecting string literals. */
function stripJsonComments(text: string): string {
  let result = '';
  let i = 0;
  let inString = false;
  let stringChar = '';
  while (i < text.length) {
    const ch = text[i];
    if (inString) {
      result += ch;
      if (ch === '\\' && i + 1 < text.length) { result += text[i + 1]; i += 2; continue; }
      if (ch === stringChar) inString = false;
      i++;
      continue;
    }
    if (ch === '"') { inString = true; stringChar = '"'; result += ch; i++; continue; }
    if (ch === '/' && i + 1 < text.length && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && i + 1 < text.length && text[i + 1] === '*') {
      i += 2;
      while (i + 1 < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    result += ch;
    i++;
  }
  return result;
}

/** Validate that the OpenCode config has a correct mcp.windows-debug entry. */
function validateConfig(): void {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  const configPath = path.join(home, '.config', 'opencode', 'opencode.jsonc');
  if (!fs.existsSync(configPath)) {
    console.error(`ERROR: config file not found at ${configPath}`);
    process.exit(1);
  }
  const raw = fs.readFileSync(configPath, 'utf8');
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(stripJsonComments(raw)) as Record<string, unknown>;
  } catch {
    console.error('ERROR: config file is not valid JSON/JSONC');
    process.exit(1);
  }
  const mcp = config.mcp as Record<string, unknown> | undefined;
  if (!mcp || typeof mcp !== 'object') {
    console.error('ERROR: config has no "mcp" key');
    process.exit(1);
  }
  const entry = mcp['windows-debug'] as Record<string, unknown> | undefined;
  if (!entry) {
    console.error('ERROR: config has no "mcp.windows-debug" entry');
    process.exit(1);
  }
  if (entry.type !== 'local') {
    console.error(`ERROR: mcp.windows-debug.type must be "local", got "${String(entry.type)}"`);
    process.exit(1);
  }
  const command = entry.command;
  if (!Array.isArray(command) || command.length < 2 || command[0] !== 'node') {
    console.error('ERROR: mcp.windows-debug.command must be ["node", "<path>/dist/index.js"]');
    process.exit(1);
  }
  const indexPath = String(command[1]);
  if (!fs.existsSync(indexPath)) {
    console.error(`ERROR: dist/index.js not found at ${indexPath}`);
    process.exit(1);
  }
  console.log('OK: mcp.windows-debug config is valid');
  process.exit(0);
}

async function main(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.argv.includes('--validate-config')) {
  validateConfig();
} else {
  main().catch((err: unknown) => {
    // stdio is the only channel; report and exit non-zero rather than hang.
    const message = err instanceof Error ? err.stack ?? err.message : String(err);
    process.stderr.write(`mcp-windows-debug fatal: ${message}\n`);
    process.exit(1);
  });
}