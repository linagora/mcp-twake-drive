import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema, type CallToolResult, type ElicitRequest, type ElicitResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { CliError } from './errors.js';

/** The server, started as its own process (stdio), driven by the SDK's client; approval requests go to onElicit. */
export interface OpenClientOptions {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** the client's name and version, as the server sees them */
  name: string;
  version: string;
  /** the whole budget, start included: initialize and tools/list do not get the SDK's own 60 s */
  timeoutMs: number;
  onElicit(params: ElicitRequest['params']): Promise<ElicitResult>;
}

export interface McpSession {
  tools: Tool[];
  call(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<CallToolResult>;
  /** what the server wrote on stderr (the last 64 KiB) */
  stderr(): string;
  close(): Promise<void>;
}

const STDERR_LIMIT = 64 * 1024;

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

function unavailable(error: unknown, stderr: string): CliError {
  if (error instanceof CliError) return error;
  const tail = stderr.trim().split('\n').slice(-5).join('\n');
  return new CliError(4, `the server stopped answering (${String((error as Error)?.message ?? error)})${tail ? `:\n${tail}` : '.'}`);
}

export async function openClient(o: OpenClientOptions): Promise<McpSession> {
  // the SDK's default environment is a short list: the server needs ours (its *_ variables, TWAKE_AI_HOME…)
  const transport = new StdioClientTransport({ command: o.command, args: o.args, env: definedEnv(o.env), stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_LIMIT);
  });
  const client = new Client({ name: o.name, version: o.version }, { capabilities: { elicitation: {} } });
  client.setRequestHandler(ElicitRequestSchema, (request) => o.onElicit(request.params));
  // Ctrl-C or a kill: the server is stopped with us, and the pending call ends as "stopped answering"
  const stop = () => void transport.close();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const close = async () => {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await client.close().catch(() => undefined);
  };
  const deadline = Date.now() + o.timeoutMs;
  const left = () => Math.max(1, deadline - Date.now());
  try {
    await client.connect(transport, { timeout: left() });
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor === undefined ? undefined : { cursor }, { timeout: left() });
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return {
      tools,
      stderr: () => stderr,
      close,
      call: async (name, args, timeoutMs) => {
        const budget = Math.min(timeoutMs, left());
        try {
          return (await client.callTool({ name, arguments: args }, undefined, { timeout: budget, maxTotalTimeout: budget })) as CallToolResult;
        } catch (error) {
          throw unavailable(error, stderr);
        }
      },
    };
  } catch (error) {
    await close();
    throw unavailable(error, stderr);
  }
}
