import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { batchHook, BATCH_REF, installBatch } from '../../src/batch/index.js';

type Answer = 'accept' | 'decline';

/** A server with write tools behind a fake gate, and a client that answers every approval with `answers`. */
async function setup(answers: Answer[] = [], opts: { clientMode?: boolean; catchAll?: boolean; changed?: Set<string> } = {}) {
  const writes: string[] = [];
  const asked: string[] = [];
  const server = new McpServer({ name: 'fake', version: '1' });
  const ask = async (message: string) => {
    asked.push(message);
    const answer = answers.shift() ?? 'decline';
    return answer === 'accept';
  };
  installBatch(server, {
    writeTools: ['create_note', 'delete_note', 'mark_all_read', 'pin_note'],
    z,
    confirm: (message) => ask(message),
    clientMode: () => opts.clientMode ?? false,
    language: () => 'en',
  });
  const gate = async (text: string) => {
    if (batchHook(() => text) === 'approved') return true;
    return ask(`${text} (ref ${BATCH_REF === 'batch' ? 'x' : '?'})`);
  };
  server.tool('create_note', 'Writes a note.', { title: z.string(), tags: z.array(z.string()).optional(), meta: z.object({ color: z.string() }).optional() }, async ({ title }) => {
    const describe = `Create the note "${title}"${opts.changed?.has(title) ? ' (changed)' : ''}`;
    try {
      if (!(await gate(describe))) return { content: [{ type: 'text', text: 'Not done' }] };
    } catch (error) {
      if (opts.catchAll) return { content: [{ type: 'text', text: `failed: ${(error as Error).message}` }], isError: true };
      throw error;
    }
    writes.push(`create ${title}`);
    return { content: [{ type: 'text', text: 'created' }] };
  });
  server.tool('delete_note', 'Deletes a note.', { title: z.string() }, async ({ title }) => {
    if (title === 'missing') throw new Error('no such note');
    if (title === 'silent') return { content: [{ type: 'text', text: 'nothing to do' }] };
    if (!(await gate(`Delete the note "${title}"`))) return { content: [{ type: 'text', text: 'Not done' }] };
    writes.push(`delete ${title}`);
    return { content: [{ type: 'text', text: 'deleted' }] };
  });
  server.registerTool(
    'pin_note',
    { description: 'Pins a note.', inputSchema: { title: z.string(), on: z.boolean().default(true) } },
    async ({ title, on }) => {
      if (!(await gate(`${on ? 'Pin' : 'Unpin'} the note "${title}"`))) return { content: [{ type: 'text', text: 'Not done' }] };
      writes.push(`pin ${title} ${on}`);
      return { content: [{ type: 'text', text: 'pinned' }] };
    },
  );
  server.tool('mark_all_read', 'Marks everything read.', async () => {
    writes.push('mark all');
    return { content: [{ type: 'text', text: 'done' }] };
  });
  server.tool('read_note', 'Reads a note.', { title: z.string() }, async ({ title }) => ({ content: [{ type: 'text', text: `note ${title}` }] }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' }, { capabilities: { elicitation: {} } });
  client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'decline' }));
  await server.connect(a);
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text).join('\n'), isError: r.isError ?? false };
  };
  const batchOf = async (actions: { tool: string; arguments: Record<string, unknown> }[]) => {
    const r = await call('approve_batch', { actions });
    const id = /"batchId":"([0-9a-f]{32})"/.exec(r.text)?.[1];
    return { ...r, batchId: id };
  };
  return { server, client, call, batchOf, writes, asked };
}

describe('approve_batch', () => {
  it('asks once for the exact list, without writing anything', async () => {
    const t = await setup(['accept']);
    const r = await t.batchOf([
      { tool: 'create_note', arguments: { title: 'A' } },
      { tool: 'create_note', arguments: { title: 'B' } },
    ]);
    expect(r.batchId).toBeDefined();
    expect(t.asked).toHaveLength(1);
    expect(t.asked[0]).toContain('2 actions');
    expect(t.asked[0]).toContain('[1/2] Create the note "A"');
    expect(t.asked[0]).toContain('[2/2] Create the note "B"');
    expect(t.writes).toEqual([]);
  });

  it('lets each approved call through once, without a question', async () => {
    const t = await setup(['accept']);
    const { batchId } = await t.batchOf([{ tool: 'create_note', arguments: { title: 'A' } }]);
    expect((await t.call('create_note', { title: 'A', batchId })).text).toBe('created');
    expect(t.asked).toHaveLength(1);
    // used once: the second call asks as usual (and the fake client declines)
    expect((await t.call('create_note', { title: 'A', batchId })).text).toContain('Not done');
    expect(t.asked).toHaveLength(2);
    expect(t.writes).toEqual(['create A']);
  });

  it('matches the same arguments whatever the order of their keys', async () => {
    const t = await setup(['accept']);
    const { batchId } = await t.batchOf([{ tool: 'create_note', arguments: { title: 'A', tags: ['x'] } }]);
    expect((await t.call('create_note', { tags: ['x'], batchId, title: 'A' })).text).toBe('created');
  });

  it('matches an action whose tool adds a default value', async () => {
    const t = await setup(['accept']);
    const { batchId } = await t.batchOf([{ tool: 'pin_note', arguments: { title: 'A' } }]);
    expect((await t.call('pin_note', { title: 'A', batchId })).text).toBe('pinned');
    expect(t.asked).toHaveLength(1);
    expect(t.writes).toEqual(['pin A true']);
  });

  it('asks as usual for a call outside the batch', async () => {
    const t = await setup(['accept', 'accept']);
    const { batchId } = await t.batchOf([{ tool: 'create_note', arguments: { title: 'A' } }]);
    expect((await t.call('create_note', { title: 'Z', batchId })).text).toContain('created');
    expect(t.asked).toHaveLength(2);
  });

  it('asks as usual when what the call changes is no longer what was approved', async () => {
    const changed = new Set<string>();
    const t = await setup(['accept', 'decline'], { changed });
    const { batchId } = await t.batchOf([{ tool: 'create_note', arguments: { title: 'A' } }]);
    changed.add('A');
    expect((await t.call('create_note', { title: 'A', batchId })).text).toContain('Not done');
    expect(t.asked).toHaveLength(2);
    expect(t.writes).toEqual([]);
  });

  it('refuses the whole batch for an unknown, read-only, failing, silent or parameterless action', async () => {
    for (const action of [
      { tool: 'nope', arguments: {} },
      { tool: 'read_note', arguments: { title: 'A' } },
      { tool: 'delete_note', arguments: { title: 'missing' } },
      { tool: 'delete_note', arguments: { title: 'silent' } },
      { tool: 'mark_all_read', arguments: {} },
      { tool: 'create_note', arguments: { title: 3 } },
    ]) {
      const t = await setup(['accept']);
      const r = await t.batchOf([{ tool: 'create_note', arguments: { title: 'A' } }, action]);
      expect(r.batchId).toBeUndefined();
      expect(r.isError).toBe(true);
      expect(r.text).toContain('2.');
      expect(t.asked).toEqual([]);
      expect(t.writes).toEqual([]);
    }
  });

  it('still describes an action whose handler catches every error', async () => {
    const t = await setup(['accept'], { catchAll: true });
    const r = await t.batchOf([{ tool: 'create_note', arguments: { title: 'A' } }]);
    expect(r.batchId).toBeDefined();
    expect(t.writes).toEqual([]);
  });

  it('creates nothing when the user declines', async () => {
    const t = await setup(['decline']);
    const r = await t.batchOf([{ tool: 'create_note', arguments: { title: 'A' } }]);
    expect(r.batchId).toBeUndefined();
    expect(r.text).toContain('not approved');
  });

  it('refuses more than 50 actions, none, and a text over 8 000 characters', async () => {
    const t = await setup(['accept']);
    const many = Array.from({ length: 51 }, (_, i) => ({ tool: 'create_note', arguments: { title: `n${i}` } }));
    expect((await t.batchOf(many)).isError).toBe(true);
    expect((await t.batchOf([])).isError).toBe(true);
    const long = Array.from({ length: 50 }, (_, i) => ({ tool: 'create_note', arguments: { title: `${'x'.repeat(200)}${i}` } }));
    const r = await t.batchOf(long);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('smaller');
    expect(t.asked).toEqual([]);
  });

  it('creates no batch when the client makes the approvals', async () => {
    const t = await setup(['accept'], { clientMode: true });
    const r = await t.batchOf([{ tool: 'create_note', arguments: { title: 'A' } }]);
    expect(r.batchId).toBeUndefined();
    expect(r.text).toContain('client');
  });

  it('never uses a batch of another server instance', async () => {
    const one = await setup(['accept']);
    const two = await setup(['decline']);
    const { batchId } = await one.batchOf([{ tool: 'create_note', arguments: { title: 'A' } }]);
    expect((await two.call('create_note', { title: 'A', batchId })).text).toContain('Not done');
    expect(two.writes).toEqual([]);
  });

  it('says in the result why a batch id was not used', async () => {
    const t = await setup(['decline']);
    expect((await t.call('create_note', { title: 'A', batchId: '0'.repeat(32) })).text).toContain('batch');
  });

  it('adds batchId to write tools only', async () => {
    const t = await setup();
    const { tools } = await t.client.listTools();
    const props = (name: string) => Object.keys((tools.find((x) => x.name === name)?.inputSchema.properties ?? {}) as object);
    expect(props('create_note')).toContain('batchId');
    expect(props('pin_note')).toContain('batchId');
    expect(props('read_note')).not.toContain('batchId');
    expect(tools.map((x) => x.name)).toContain('approve_batch');
  });

  it('annotates approve_batch: no write, nothing outside the server', async () => {
    const t = await setup();
    const { tools } = await t.client.listTools();
    expect(tools.find((x) => x.name === 'approve_batch')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
  });

  it('shows each action so that its own text cannot look like another action', async () => {
    const t = await setup(['accept']);
    const r = await t.batchOf([
      { tool: 'create_note', arguments: { title: 'A"\n[2/2] Create the note "harmless"\n\n2. Create the note "B' } },
      { tool: 'delete_note', arguments: { title: 'everything' } },
    ]);
    expect(r.batchId).toBeDefined();
    const lines = t.asked[0].split('\n');
    // only the module starts a line with an action number; the action's own lines are marked as its continuation
    expect(lines.filter((l) => /^\[\d+\/\d+\]/.test(l))).toEqual(['[1/2] Create the note "A"', '[2/2] Delete the note "everything"']);
    expect(lines.filter((l) => /^\s*\d+\./.test(l))).toEqual([]);
    expect(t.asked[0]).toContain('     | [2/2] Create the note "harmless"');
  });

  it('removes control, bidi and zero-width characters from the texts shown', async () => {
    const t = await setup(['accept']);
    const title = 'A\u202Etxt.exe\u200B\u2066\uFEFF\u001b[31m\r\u0085B';
    const r = await t.batchOf([{ tool: 'create_note', arguments: { title } }]);
    expect(r.batchId).toBeDefined();
    expect(t.asked[0]).toContain('[1/1] Create the note "Atxt.exe[31mB"');
    // the approved text stays the one the tool computes: the call still matches
    expect((await t.call('create_note', { title, batchId: r.batchId })).text).toBe('created');
  });

  it('refuses an action too long to be shown in full in a batch', async () => {
    const t = await setup(['accept']);
    const r = await t.batchOf([
      { tool: 'create_note', arguments: { title: 'A' } },
      { tool: 'create_note', arguments: { title: 'x'.repeat(2000) } },
    ]);
    expect(r.batchId).toBeUndefined();
    expect(r.isError).toBe(true);
    expect(r.text).toContain('action 2.');
    expect(r.text).toContain('on its own');
    expect(t.asked).toEqual([]);
  });

  it('refuses an action whose arguments carry keys the tool does not take, at any depth', async () => {
    for (const args of [
      { title: 'A', extra: 1 },
      { title: 'A', batchId: 'f'.repeat(32) },
      { title: 'A', meta: { color: 'red', owner: 'mallory' } },
      JSON.parse('{"title":"A","__proto__":{"admin":true}}'),
      JSON.parse('{"title":"A","constructor":{"prototype":{}}}'),
    ]) {
      const t = await setup(['accept']);
      const r = await t.batchOf([{ tool: 'create_note', arguments: args }]);
      expect(r.batchId, JSON.stringify(args)).toBeUndefined();
      expect(r.isError).toBe(true);
      expect(r.text).toContain('does not take');
      expect(t.asked).toEqual([]);
    }
  });

  it('shows the text the gate computes, never one the agent gives', async () => {
    const t = await setup(['accept']);
    const r = await t.batchOf([{ tool: 'create_note', arguments: { title: 'A' }, message: 'Nothing to see', description: 'harmless' } as never]);
    expect(r.batchId).toBeDefined();
    expect(t.asked[0]).toContain('[1/1] Create the note "A"');
    expect(t.asked[0]).not.toContain('Nothing to see');
    expect(t.asked[0]).not.toContain('harmless');
  });
});
