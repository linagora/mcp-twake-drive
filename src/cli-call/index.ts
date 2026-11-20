import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { mergeArguments, parseArgPairs, readJsonArgument, type InputSchema } from './args.js';
import { openClient, type McpSession } from './client.js';
import { CliError } from './errors.js';
import { describeTool, exitCodeFor, findTool, printable, renderResult, toolLine } from './output.js';
import { cliApprover, detectContext, isYes, languageOf, text } from './policy.js';
import { NAME, readSettings, settingsPath, writeSettings } from './settings.js';

/**
 * `<server> tools`, `<server> call <tool>` and `<server> allow-unattended <name>`: the server's tools from a terminal
 * or a script (spec §2). The same module in the six Twake.ai servers.
 */
export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface CliDeps {
  io: CliIo;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** the account's home folder as the system knows it; undefined: no name is allowed, none can be */
  home: string | undefined;
  stdinTTY: boolean;
  stderrTTY: boolean;
  /** stops waiting (and frees the terminal) when the signal aborts */
  ask(question: string, signal: AbortSignal): Promise<string>;
  readStdin(): Promise<string>;
}

const COMMANDS = ['call', 'tools', 'allow-unattended'];
const DEFAULT_TIMEOUT_S = 900;

export function isCliCommand(argv: string[]): boolean {
  return COMMANDS.includes(argv[0] ?? '');
}

function askOnStderr(question: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    let answered = false;
    // the call ended (timeout, server gone, signal) while the question was shown: let go of the terminal
    signal.addEventListener('abort', () => rl.close(), { once: true });
    rl.once('line', (line) => {
      answered = true;
      rl.close();
      resolve(line);
    });
    rl.once('close', () => {
      if (!answered) reject(new Error('the input closed'));
    });
    rl.setPrompt(question);
    rl.prompt();
  });
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** The account's home folder as the system knows it, never $HOME (see settingsPath); none if the system gives none. */
function accountHome(): string | undefined {
  try {
    return userInfo().homedir || undefined;
  } catch {
    return undefined;
  }
}

function defaultDeps(): CliDeps {
  return {
    io: { stdout: (t) => void process.stdout.write(t), stderr: (t) => void process.stderr.write(t) },
    env: process.env,
    platform: process.platform,
    home: accountHome(),
    stdinTTY: Boolean(process.stdin.isTTY),
    stderrTTY: Boolean(process.stderr.isTTY),
    ask: askOnStderr,
    readStdin: readAllStdin,
  };
}

function usageText(command: string): string {
  return `usage:
  ${command} tools [<tool>] [--json-output]
  ${command} call <tool> [--arg <key>=<value>]... [--json <object>|@<file>|-] [--i] [--yes --as <name>] [--json-output] [--timeout <seconds>] [--verbose]
  ${command} allow-unattended <name> [--revoke]
`;
}

function parse<T>(command: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    throw new CliError(2, `${(error as Error).message}\n\n${usageText(command)}`);
  }
}

/** TWAKE_MCP_CLI_SERVER (a JSON array: command, then its arguments) or this very server, started as a server. */
function serverCommand(env: NodeJS.ProcessEnv, entry: string): string[] {
  const configured = env.TWAKE_MCP_CLI_SERVER;
  if (configured === undefined || configured === '') return [process.execPath, entry];
  let value: unknown;
  try {
    value = JSON.parse(configured) as unknown;
  } catch {
    value = undefined;
  }
  if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === 'string' && v !== '')) {
    throw new CliError(2, 'TWAKE_MCP_CLI_SERVER must be a JSON array of strings: the command, then its arguments.');
  }
  return value as string[];
}

export async function runCliCommand(argv: string[], options: { entry: string }, overrides: Partial<CliDeps> = {}): Promise<number> {
  const d = { ...defaultDeps(), ...overrides };
  const pkg = JSON.parse(readFileSync(join(dirname(options.entry), '..', 'package.json'), 'utf8')) as { name: string; version: string };
  try {
    return await dispatch(argv, pkg, options.entry, d);
  } catch (error) {
    const known = error instanceof CliError;
    let message = known ? error.message : `unexpected error: ${String((error as Error)?.message ?? error)}`;
    // a Matrix device store holds one process: name the ways to share it
    if (/already used by process/.test(message)) message += '\nUse `mcp-twake-ai call chat …`, or TWAKE_MCP_CLI_SERVER, to reach the Chat server that runs.';
    // the message can quote the server's stderr
    d.io.stderr(`${pkg.name}: ${printable(message)}\n`);
    return known ? error.exitCode : 4;
  }
}

async function dispatch(argv: string[], pkg: { name: string; version: string }, entry: string, d: CliDeps): Promise<number> {
  const [command, ...args] = argv;
  // fail closed: without the account's home folder, no list is read and none is written
  const file = d.home === undefined ? undefined : settingsPath(d.platform, d.home);
  if (command === 'allow-unattended') {
    if (file === undefined) throw new CliError(4, 'the system gives no home folder for this account: allowed names cannot be kept.');
    return allowUnattended(args, pkg.name, file, d);
  }
  if (command !== 'tools' && command !== 'call') throw new CliError(2, usageText(pkg.name));
  const { values, positionals } = parse(pkg.name, () =>
    parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options:
        command === 'tools'
          ? { 'json-output': { type: 'boolean' } }
          : {
              arg: { type: 'string', multiple: true },
              json: { type: 'string' },
              i: { type: 'boolean' },
              yes: { type: 'boolean' },
              as: { type: 'string' },
              'json-output': { type: 'boolean' },
              timeout: { type: 'string' },
              verbose: { type: 'boolean' },
            },
    }),
  );
  const v = values as Record<string, string | boolean | string[] | undefined>;
  const [name, ...extra] = positionals;
  if (extra.length > 0 || (command === 'call' && name === undefined)) throw new CliError(2, usageText(pkg.name));
  const timeout = v.timeout === undefined ? DEFAULT_TIMEOUT_S : Number(v.timeout);
  if (!Number.isInteger(timeout) || timeout <= 0) throw new CliError(2, `--timeout takes a number of seconds, not "${String(v.timeout)}".`);
  const [executable, ...serverArgs] = serverCommand(d.env, entry);
  const settings = file === undefined ? { version: 1 as const, allowedUnattended: [], agentMarkers: [] } : await readSettings(file);
  const { context, marker } = detectContext({ stdinTTY: d.stdinTTY, stderrTTY: d.stderrTTY, env: d.env, markers: settings.agentMarkers });
  // read before the server starts: a bad --json costs nothing
  const json = typeof v.json === 'string' ? await readJsonArgument(v.json, d.readStdin) : {};
  // aborted when the command ends: a question still shown must not keep the process alive
  const asking = new AbortController();
  const approver = cliApprover({
    context,
    marker,
    interactive: v.i === true,
    yes: v.yes === true,
    as: typeof v.as === 'string' ? v.as : undefined,
    allowed: settings.allowedUnattended,
    stdinTaken: v.json === '-',
    command: pkg.name,
    ask: (question) => d.ask(question, asking.signal),
    stderr: d.io.stderr,
    lang: languageOf(d.env),
  });
  const session: McpSession = await openClient({
    timeoutMs: timeout * 1000,
    command: executable,
    args: serverArgs,
    env: d.env,
    name: `${pkg.name} cli`,
    version: pkg.version,
    onElicit: (params) => approver.handle(params),
  });
  try {
    const tools = [...session.tools].sort((a, b) => a.name.localeCompare(b.name));
    if (command === 'tools') {
      if (name === undefined) d.io.stdout(v['json-output'] ? `${JSON.stringify({ tools })}\n` : tools.map(toolLine).join(''));
      else {
        const tool = findTool(tools, name, pkg.name);
        d.io.stdout(v['json-output'] ? `${JSON.stringify(tool)}\n` : describeTool(tool));
      }
      return 0;
    }
    const tool = findTool(tools, name!, pkg.name);
    const pairs = parseArgPairs(Array.isArray(v.arg) ? v.arg : [], tool.inputSchema as InputSchema);
    const result = await session.call(name!, mergeArguments(json, pairs), timeout * 1000);
    d.io.stdout(renderResult(result, v['json-output'] === true));
    if (v.verbose) d.io.stderr(printable(session.stderr()));
    return exitCodeFor(result, approver.declined);
  } finally {
    asking.abort();
    await session.close();
  }
}

/** allow-unattended <name> [--revoke]: allowing is typed by the user in a terminal, never by an agent or a script. */
async function allowUnattended(args: string[], command: string, file: string, d: CliDeps): Promise<number> {
  const { values, positionals } = parse(command, () =>
    parseArgs({ args, allowPositionals: true, strict: true, options: { revoke: { type: 'boolean' } } }),
  );
  const [name, ...extra] = positionals;
  if (name === undefined || extra.length > 0) throw new CliError(2, usageText(command));
  if (!NAME.test(name)) throw new CliError(2, `"${name}" is not a valid name: use lowercase letters, digits and dashes (cron-agenda…).`);
  const settings = await readSettings(file);
  const allowed = new Set(settings.allowedUnattended);
  if (values.revoke) {
    allowed.delete(name);
    await writeSettings(file, { ...settings, allowedUnattended: [...allowed].sort() });
    d.io.stdout(`--yes --as ${name} no longer approves anything.\n`);
    return 0;
  }
  const settingsMarkers = settings.agentMarkers;
  const { context } = detectContext({ stdinTTY: d.stdinTTY, stderrTTY: d.stderrTTY, env: d.env, markers: settingsMarkers });
  if (context !== 'user') throw new CliError(2, 'allow-unattended asks you to confirm in a terminal: type it yourself, not from a script or an agent.');
  const answer = await d.ask(text(languageOf(d.env), 'confirmAllow', { name }), new AbortController().signal).catch(() => '');
  if (!isYes(answer)) {
    d.io.stdout('Nothing changed.\n');
    return 1;
  }
  allowed.add(name);
  await writeSettings(file, { ...settings, allowedUnattended: [...allowed].sort() });
  d.io.stdout(`${name} may now write with --yes --as ${name}, for the six Twake.ai servers. Undo it with \`${command} allow-unattended ${name} --revoke\`.\n`);
  return 0;
}
