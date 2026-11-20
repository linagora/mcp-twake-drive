import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, posix, win32 } from 'node:path';
import { CliError } from './errors.js';

/**
 * cli.json, shared by the six Twake.ai servers and mcp-twake-ai: the names allowed to write without a terminal
 * (`--yes --as <name>`) and the extra environment variables that tell a command was started by an agent.
 */
export interface CliSettings {
  version: 1;
  allowedUnattended: string[];
  agentMarkers: string[];
}

export const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MARKER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Next to mcp-twake-ai's config.json, in the home folder the system gives the account (`os.userInfo()`), never where
 * an environment variable points: a command line could otherwise be given a cli.json of its own (TWAKE_AI_HOME,
 * XDG_CONFIG_HOME, APPDATA, HOME) that allows any name.
 */
export function settingsPath(platform: NodeJS.Platform, home: string): string {
  const path = platform === 'win32' ? win32 : posix;
  return platform === 'win32' ? path.join(home, 'AppData', 'Roaming', 'twake-ai', 'cli.json') : path.join(home, '.config', 'twake-ai', 'cli.json');
}

const empty = (): CliSettings => ({ version: 1, allowedUnattended: [], agentMarkers: [] });

export async function readSettings(file: string): Promise<CliSettings> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty();
    throw new CliError(4, `${file} cannot be read: ${(error as Error).message}`);
  }
  // a list another account may write is no list of the user's
  if (process.platform !== 'win32' && ((await stat(file)).mode & 0o022) !== 0) {
    throw new CliError(4, `${file} may be written by other accounts: run \`chmod 600 ${file}\`, or delete it.`);
  }
  const damaged = new CliError(4, `${file} is damaged: fix it, or delete it to start again with no allowed names.`);
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw damaged;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw damaged;
  const { version, allowedUnattended = [], agentMarkers = [] } = raw as Record<string, unknown>;
  const strings = (value: unknown, pattern: RegExp) => Array.isArray(value) && value.every((v) => typeof v === 'string' && pattern.test(v));
  if (version !== 1 || !strings(allowedUnattended, NAME) || !strings(agentMarkers, MARKER)) throw damaged;
  return { version: 1, allowedUnattended: allowedUnattended as string[], agentMarkers: agentMarkers as string[] };
}

export async function writeSettings(file: string, settings: CliSettings): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}
