#!/usr/bin/env node
/**
 * mcp-twake-drive: MCP server (stdio) for Twake Drive (cozy-stack).
 *
 * Env: TWAKE_DRIVE_URL, TWAKE_DRIVE_TOKEN_COMMAND (or TWAKE_DRIVE_TOKEN),
 * optional TWAKE_DRIVE_DOWNLOAD_DIR, TWAKE_DRIVE_UPLOAD_DIR, TWAKE_DRIVE_MAX_TEXT_CHARS.
 * Logs go to stderr only: stdout carries JSON-RPC.
 */
import { VERSION } from './version.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { ROOT_DIR_ID, createCozyClient, type TokenSource } from './drive.js';
import { CommandTokenProvider } from './token-command.js';
import { registerTools } from './tools.js';
import { FileIndex } from './file-index.js';
import { join } from 'node:path';


async function main(): Promise<void> {
  // The cozy-* packages log through console.log, and stdout carries JSON-RPC.
  console.log = console.error;
  const config = loadConfig();
  const tokens: TokenSource = config.tokenCommand
    ? new CommandTokenProvider(config.tokenCommand)
    : { getToken: async () => config.token!, invalidate: () => {} };
  const client = createCozyClient(config.baseUrl, tokens);

  // Fail fast with an actionable message rather than exposing broken tools.
  try {
    await client.getStackClient().loadToken();
    await client.collection('io.cozy.files').statById(ROOT_DIR_ID, { 'page[limit]': 1 });
  } catch (e) {
    process.stderr.write(`mcp-twake-drive: cannot reach ${config.baseUrl}: ${(e as Error).message}\n`);
    process.exit(1);
  }

  const host = new URL(config.baseUrl).host;
  const index = new FileIndex(client, config.baseUrl, join(config.cacheDir, `${host}.json`));

  const server = new McpServer({ name: 'mcp-twake-drive', version: VERSION });
  registerTools(server, client, config, index);
  await server.connect(new StdioServerTransport());
  process.stderr.write(`mcp-twake-drive ${VERSION} connected to ${config.baseUrl}\n`);
}

main().catch((e) => {
  process.stderr.write(`mcp-twake-drive: ${(e as Error).message}\n`);
  process.exit(1);
});
