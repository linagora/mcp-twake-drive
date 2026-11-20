import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { canonical } from './canonical.js';
import { BATCH_REF, runCapture, runPreapproved } from './context.js';
import { BatchStore } from './store.js';

/**
 * approve_batch (spec §5): the user approves the exact list of a series of writes once; each write that carries the
 * batch id and matches one listed action exactly goes through without a question, if its approval text is still the
 * one approved. Installed on one McpServer before its tools are registered: it wraps their registration.
 *
 * What a batch approves is exactly what each action's approval text shows: the comparison of that text is what
 * catches a target that changed since; a change the text does not show is not seen. A batch is valid only in the
 * server instance (the session) that approved it, under the approval settings it was approved under (mode,
 * language, account: `settings()`), for 15 minutes; every batch is forgotten when the instance closes.
 */
type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
type Handler = (...args: unknown[]) => unknown;

/** The part of zod this module uses (the repository's own zod is passed in). */
export interface ZodLike {
  string(): { optional(): { describe(text: string): unknown } };
  object(shape: Record<string, unknown>): { safeParse(value: unknown): { success: boolean; data?: unknown; error?: { message: string } } };
  array(item: unknown): { min(n: number): { max(n: number): unknown } };
  unknown(): unknown;
}

export interface BatchOptions {
  /** the tools that ask for approval before writing */
  writeTools: readonly string[];
  z: ZodLike;
  /** asks the user with the server's own approval request; true: accepted */
  confirm(message: string, extra: unknown): Promise<boolean>;
  /** *_APPROVAL=client: the client makes the approvals, no batch */
  clientMode(): boolean;
  language(): 'en' | 'fr';
  /** what the approvals depend on besides the text (mode, language, account…): a batch approved under other settings approves nothing */
  settings?(): string;
  now?: () => number;
}

const MAX_ACTIONS = 50;
const MAX_TEXT = 8000;
/** an action longer than this is not shown in a batch (the user would approve what they cannot read): it asks on its own */
const MAX_ACTION_TEXT = 1500;

/**
 * The text of one action as the batch question shows it: line breaks as \n (U+2028 and U+2029 included), without
 * terminal controls (C0 but the line feed, DEL, C1),
 * bidi overrides or isolates, and zero-width characters, which could make it read as something else. What is
 * stored and compared stays the tool's own text.
 */
export function shown(text: string): string {
  let out = '';
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c === 0x0a || c === 0x2028 || c === 0x2029) out += '\n'; // line and paragraph separators break lines too
    else if (c === 0x09) out += ' ';
    else if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) continue;
    else if ((c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c === 0xfeff) continue;
    else out += ch;
  }
  return out;
}

/**
 * The text of one action without the last paragraph of a single approval ("Ref. batch · Accept to do it now…"): the
 * batch question asks once for the list. Display only; the stored and compared text keeps it.
 */
function withoutFooter(text: string): string {
  return text.replace(new RegExp(`\\n\\n[^\\n]* ${BATCH_REF} · [^\\n]*$`), '');
}

/** `[i/n] first line`, every other line of the action marked as its continuation: only this module starts a line with a number. */
function listed(text: string, i: number, n: number): string {
  return `[${i}/${n}] ${text.split('\n').join('\n     | ')}`;
}

const TEXT = {
  en: {
    header: (n: number) => `Approve these ${n} actions at once? Each one runs only as listed, once, within 15 minutes.`,
    approved: 'Batch approved',
    declined: 'Batch not approved: nothing was approved, each action will ask as usual.',
    client: 'No batch: this server is set to let the client make the approvals (APPROVAL=client).',
    tooLong: 'Batch refused: the list is too long to show in one approval; make smaller batches.',
    count: 'Batch refused: give between 1 and 50 actions.',
    unusable: (reason: string) => `(batch not used: ${reason}; the action went through the usual approval)`,
    actionTooLong: 'has an approval text too long to show in a batch: call it on its own.',
  },
  fr: {
    header: (n: number) => `Approuver ces ${n} actions en une fois ? Chacune ne s'exécute que telle quelle, une fois, dans les 15 minutes.`,
    approved: 'Lot approuvé',
    declined: "Lot non approuvé : rien n'est approuvé, chaque action demandera comme d'habitude.",
    client: 'Pas de lot : ce serveur laisse le client faire les approbations (APPROVAL=client).',
    tooLong: 'Lot refusé : la liste est trop longue pour une seule approbation ; faites des lots plus petits.',
    count: 'Lot refusé : donnez entre 1 et 50 actions.',
    unusable: (reason: string) => `(lot non utilisé : ${reason} ; l'action a suivi l'approbation habituelle)`,
    actionTooLong: "a un texte d'approbation trop long pour un lot : appelez-la seule.",
  },
} as const;

interface Registered {
  handler: Handler;
  /** a zod raw shape or a zod object, as the tool was registered; undefined: no parameters */
  schema?: unknown;
}

type Parseable = { safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: { message: string } }; extend?: (shape: Record<string, unknown>) => unknown };

function isZodObject(value: unknown): value is Parseable {
  return typeof value === 'object' && value !== null && typeof (value as { safeParse?: unknown }).safeParse === 'function';
}

function isRawShape(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !isZodObject(value) && Object.values(value).every(isZodObject);
}

/** The first key of the raw arguments that validation dropped (a key the tool does not take), at any depth. */
function droppedKey(raw: unknown, parsed: unknown, path = ''): string | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  if (parsed === null || typeof parsed !== 'object') return undefined; // a transform made something else of it
  if (Array.isArray(raw)) {
    if (!Array.isArray(parsed)) return undefined;
    for (const [i, item] of raw.entries()) {
      const found = droppedKey(item, parsed[i], `${path}[${i}]`);
      if (found) return found;
    }
    return undefined;
  }
  if (Object.getPrototypeOf(raw) !== Object.prototype && Object.getPrototypeOf(raw) !== null) return path || '(arguments)';
  for (const key of Object.keys(raw)) {
    const at = path ? `${path}.${key}` : key;
    if (!Object.prototype.hasOwnProperty.call(parsed, key)) {
      if ((raw as Record<string, unknown>)[key] === undefined) continue;
      return at;
    }
    const found = droppedKey((raw as Record<string, unknown>)[key], (parsed as Record<string, unknown>)[key], at);
    if (found) return found;
  }
  return undefined;
}

/** canonical(), or undefined for arguments it refuses (they then never match a batch). */
function keyOf(value: unknown): string | undefined {
  try {
    return canonical(value);
  } catch {
    return undefined;
  }
}

function withNote(result: unknown, note: string): unknown {
  const r = result as ToolResult;
  if (!r || !Array.isArray(r.content)) return result;
  return { ...r, content: [...r.content, { type: 'text', text: note }] };
}

export function installBatch(server: McpServer, o: BatchOptions): void {
  const registry = new Map<string, Registered>();
  const store = new BatchStore(o.now);
  const settings = (): string => `${o.clientMode() ? 'client' : 'elicit'}|${o.language()}|${o.settings?.() ?? ''}`;
  // every batch is forgotten when the instance closes (a new connection is a new session)
  const closed = server.server.onclose;
  server.server.onclose = () => {
    store.clear();
    closed?.();
  };
  const writes = new Set(o.writeTools);
  const batchIdSchema = o.z.string().optional().describe('The batchId approve_batch gave, when this exact call is part of an approved batch.');

  const wrap = (name: string, handler: Handler): Handler =>
    async (...args: unknown[]) => {
      const [input, ...rest] = args as [Record<string, unknown>, ...unknown[]];
      if (input === null || typeof input !== 'object' || !('batchId' in input)) return handler(...args);
      const { batchId, ...actual } = input;
      if (typeof batchId !== 'string' || batchId === '') return handler(actual, ...rest);
      // the arguments as the SDK validated them with the tool's schema, the way approve_batch computed its key
      const key = keyOf(actual);
      const t = TEXT[o.language()];
      if (key === undefined) return withNote(await handler(actual, ...rest), t.unusable('these arguments cannot be compared'));
      const item = store.reserve(batchId, name, key, settings());
      if (typeof item === 'string') {
        const reason =
          item === 'expired' ? 'it expired'
          : item === 'unknown' ? 'no such batch in this session'
          : item === 'changed' ? 'the approval settings changed since it was approved'
          : 'this exact call is not in the batch, or was already made';
        return withNote(await handler(actual, ...rest), t.unusable(reason));
      }
      const { result, approved } = await runPreapproved(item.message, async () => handler(actual, ...rest));
      if (!approved) {
        store.release(item);
        return withNote(result, t.unusable('what it changes is no longer what was approved'));
      }
      return result;
    };

  const add = (name: string, schema: unknown, handler: Handler): { schema: unknown; handler: Handler } => {
    registry.set(name, { handler, schema });
    if (!writes.has(name) || schema === undefined) return { schema, handler };
    if (isRawShape(schema)) return { schema: { ...schema, batchId: batchIdSchema }, handler: wrap(name, handler) };
    if (isZodObject(schema) && typeof schema.extend === 'function') return { schema: schema.extend({ batchId: batchIdSchema }), handler: wrap(name, handler) };
    return { schema, handler };
  };

  // server.tool(name, [description], [paramsSchema], [annotations], callback)
  const originalTool = server.tool.bind(server) as (...args: unknown[]) => unknown;
  server.tool = ((...args: unknown[]) => {
    const name = args[0] as string;
    const handler = args[args.length - 1] as Handler;
    const middle = args.slice(1, -1);
    const index = middle.findIndex((a) => isRawShape(a) || isZodObject(a));
    const schema = index === -1 ? undefined : middle[index];
    const wrapped = add(name, schema, handler);
    if (index !== -1) middle[index] = wrapped.schema;
    return originalTool(name, ...middle, wrapped.handler);
  }) as typeof server.tool;

  // server.registerTool(name, { inputSchema, … }, callback)
  if (typeof (server as { registerTool?: unknown }).registerTool === 'function') {
    const originalRegister = (server as unknown as { registerTool: (...args: unknown[]) => unknown }).registerTool.bind(server);
    (server as unknown as { registerTool: (...args: unknown[]) => unknown }).registerTool = (name: unknown, config: unknown, handler: unknown) => {
      const c = (config ?? {}) as { inputSchema?: unknown };
      const wrapped = add(name as string, c.inputSchema, handler as Handler);
      return originalRegister(name, wrapped.schema === undefined ? c : { ...c, inputSchema: wrapped.schema }, wrapped.handler);
    };
  }

  const z = o.z;
  originalTool(
    'approve_batch',
    'Ask the user ONCE for one approval of a list of write actions, before making them. Give the exact tool names and arguments you will use; the answer is a batchId. Then call each tool with exactly those arguments plus batchId: it runs without another question, once, within 15 minutes. Anything not in the list, or changed since, asks as usual. Use it for a series of 3 or more similar writes the user agreed to approve together.',
    {
      actions: z
        // arguments kept as the agent sent them (a record schema would drop keys such as __proto__ before the check below)
        .array(z.object({ tool: z.string(), arguments: z.unknown() } as Record<string, unknown>))
        .min(1)
        .max(MAX_ACTIONS),
    } as Record<string, unknown>,
    { title: 'Approve a series of writes at once', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async (input: { actions: { tool: string; arguments: unknown }[] }, extra: unknown): Promise<ToolResult> => {
      const t = TEXT[o.language()];
      if (o.clientMode()) return { content: [{ type: 'text', text: t.client }] };
      const actions = input.actions ?? [];
      if (actions.length < 1 || actions.length > MAX_ACTIONS) return { content: [{ type: 'text', text: t.count }], isError: true };
      const described: { tool: string; key: string; message: string }[] = [];
      for (const [i, action] of actions.entries()) {
        const refuse = (why: string): ToolResult => ({ content: [{ type: 'text', text: `Batch refused: action ${i + 1}. (${action.tool}) ${why}` }], isError: true });
        const entry = registry.get(action.tool);
        if (!entry) return refuse('is not a tool of this server.');
        if (!writes.has(action.tool)) return refuse('does not write: call it directly.');
        if (entry.schema === undefined) return refuse('takes no arguments: it cannot be part of a batch, call it on its own.');
        if (action.arguments === null || typeof action.arguments !== 'object' || Array.isArray(action.arguments)) return refuse('needs its arguments as an object.');
        const parsed = (isZodObject(entry.schema) ? entry.schema : z.object(entry.schema as Record<string, unknown>)).safeParse(action.arguments);
        if (!parsed.success) return refuse(`has invalid arguments: ${parsed.error?.message ?? 'see the tool schema'}`);
        // what the user approves is what the agent sent: no key that validation would drop
        const dropped = droppedKey(action.arguments, parsed.data);
        if (dropped !== undefined) return refuse(`has an argument the tool does not take: ${dropped}.`);
        const key = keyOf(parsed.data);
        if (key === undefined) return refuse('has arguments that cannot be compared.');
        const capture = await runCapture(async () => entry.handler(parsed.data, extra));
        if (capture.message === undefined) {
          return refuse(capture.outcome === 'threw' ? `cannot be prepared: ${String((capture.error as Error)?.message ?? capture.error)}` : 'would not ask for an approval: call it on its own.');
        }
        if (shown(withoutFooter(capture.message)).length > MAX_ACTION_TEXT) return refuse(t.actionTooLong);
        // the arguments as the tool receives them (zod defaults added), as the call will be compared
        described.push({ tool: action.tool, key, message: capture.message });
      }
      const text = [t.header(described.length), '', ...described.map((d, i) => listed(shown(withoutFooter(d.message)), i + 1, described.length))].join('\n');
      if (text.length > MAX_TEXT) return { content: [{ type: 'text', text: t.tooLong }], isError: true };
      if (!(await o.confirm(text, extra))) return { content: [{ type: 'text', text: t.declined }] };
      const { batchId, expiresAt } = store.create(described, settings());
      return { content: [{ type: 'text', text: `${t.approved}: ${JSON.stringify({ batchId, expiresAt: new Date(expiresAt).toISOString(), count: described.length })}` }] };
    },
  );
}
