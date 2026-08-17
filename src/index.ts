/**
 * Entry point: build the MCP server and connect it to the stdio transport.
 *
 * OpenCode config:
 *   { "mcp": { "windows-debug": { "type": "local", "command": ["node", "./dist/index.js"] } } }
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { buildServer } from './server';

async function main(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  // stdio is the only channel; report and exit non-zero rather than hang.
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`mcp-windows-debug fatal: ${message}\n`);
  process.exit(1);
});
