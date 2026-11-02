import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Config {
  /** Cozy instance, e.g. https://alice.twake.example.com */
  baseUrl: string;
  /** Shell command printing an access token (raw or JSON {access_token, expires_at}) */
  tokenCommand?: string;
  /** Static token (development only) */
  token?: string;
  downloadDir: string;
  /** The only folder local_path may read from */
  uploadDir: string;
  /** Private cache of the metadata index used for search */
  cacheDir: string;
  maxTextChars: number;
  /** Prior approval of every write: elicit = the server asks the user (MCP elicitation); client = the MCP client confirms. */
  approval?: { mode: 'elicit' | 'client'; language: 'en' | 'fr'; timeoutMs: number };
}

function expandHome(p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const raw = env.TWAKE_DRIVE_URL;
  if (!raw) throw new Error('TWAKE_DRIVE_URL is required (e.g. https://alice.twake.example.com)');
  const url = new URL(raw);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error('TWAKE_DRIVE_URL must use HTTPS (only localhost may use HTTP)');
  }
  const baseUrl = url.origin;
  if (!env.TWAKE_DRIVE_TOKEN_COMMAND && !env.TWAKE_DRIVE_TOKEN) {
    throw new Error('Set TWAKE_DRIVE_TOKEN_COMMAND (recommended) or TWAKE_DRIVE_TOKEN');
  }
  const downloadDir = expandHome(env.TWAKE_DRIVE_DOWNLOAD_DIR ?? '~/Downloads/twake-drive');
  return {
    baseUrl,
    tokenCommand: env.TWAKE_DRIVE_TOKEN_COMMAND,
    token: env.TWAKE_DRIVE_TOKEN,
    downloadDir,
    uploadDir: env.TWAKE_DRIVE_UPLOAD_DIR ? expandHome(env.TWAKE_DRIVE_UPLOAD_DIR) : downloadDir,
    cacheDir: expandHome(env.TWAKE_DRIVE_CACHE_DIR ?? join(env.XDG_CACHE_HOME ?? '~/.cache', 'mcp-twake-drive')),
    maxTextChars: Number(env.TWAKE_DRIVE_MAX_TEXT_CHARS ?? 60000),
    approval: approvalOf(env),
  };
}

function approvalOf(env: NodeJS.ProcessEnv): NonNullable<Config['approval']> {
  const mode = (env.TWAKE_DRIVE_APPROVAL ?? 'elicit').toLowerCase();
  if (mode !== 'elicit' && mode !== 'client') throw new Error('TWAKE_DRIVE_APPROVAL must be elicit or client');
  const timeoutMs = Number(env.TWAKE_DRIVE_APPROVAL_TIMEOUT_MS ?? 600000);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('TWAKE_DRIVE_APPROVAL_TIMEOUT_MS must be a number of milliseconds');
  return { mode, language: (env.USER_LANGUAGE ?? '').toLowerCase().startsWith('fr') ? 'fr' : 'en', timeoutMs };
}
