/**
 * approve_batch: the user approves a list of writes once; each matching call with the batchId then runs
 * without another question, and anything else asks as usual.
 */
import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createCozyClient } from '../src/drive.js';
import type { Config } from '../src/config.js';
import { registerTools } from '../src/tools.js';
import { FileIndex } from '../src/file-index.js';
import { WRITE_TOOLS } from '../src/approval.js';

const config: Config = {
  baseUrl: 'https://alice.twake.example.com',
  cacheDir: '/tmp/twake-drive-test-cache',
  downloadDir: '/tmp/twake-drive-test',
  uploadDir: '/tmp/twake-drive-test',
  maxTextChars: 1000,
};
const tokens = { getToken: async () => 'tok', invalidate: () => {} };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/vnd.api+json' } });
const dir = (id: string, path: string) => ({ data: { id, attributes: { type: 'directory', name: path.split('/').pop() || '/', path } } });
const file = (id: string) => ({
  data: { id, attributes: { type: 'file', name: 'Rapport.txt', dir_id: 'd1', size: '2048', mime: 'text/plain', trashed: true, restore_path: '/Docs', tags: ['budget'] } },
  included: [{ type: 'io.cozy.files.versions', id: `${id}/v1`, attributes: { updated_at: '2026-10-30T10:00:00Z', size: '1000' } }],
});

/** A fake cozy-stack: GETs answer, anything else is a write and is recorded. */
function stack() {
  const writes: string[] = [];
  const impl = vi.fn(async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const p = url.pathname;
    if (method !== 'GET') {
      writes.push(`${method} ${p}`);
      if (method === 'DELETE') return new Response(null, { status: 204 });
      return json(201, { data: { id: 'new', attributes: { type: 'file', name: 'new.txt', dir_id: 'd1' } } });
    }
    if (p === '/sharings/drives') return json(200, { data: [{ id: 'drv1', attributes: { description: 'Équipe Projet', rules: [{ values: ['root1'] }] } }] });
    if (p === '/permissions/doctype/io.cozy.files/shared-by-link') return json(200, { data: [{ id: 'perm1', attributes: { permissions: { files: { values: ['f1'] } } } }] });
    if (p === '/files/io.cozy.files.trash-dir') {
      return json(200, { data: { id: 'io.cozy.files.trash-dir', attributes: { type: 'directory' } }, included: [{ id: 't1', attributes: { name: 'old.txt' } }, { id: 't2', attributes: { name: 'older.txt' } }] });
    }
    if (p.endsWith('/metadata')) {
      const path = url.searchParams.get('Path') ?? '/';
      return path.endsWith('.txt') ? json(200, file('f1')) : json(200, dir('d-' + path, path));
    }
    const id = decodeURIComponent(p.split('/').pop()!);
    if (id === 'd1') return json(200, dir('d1', '/Docs'));
    if (id === 'd2') return json(200, dir('d2', '/Archives'));
    if (id === 'root1') return json(200, dir('root1', '/Drives/Équipe Projet'));
    if (id === 'io.cozy.files.root-dir') return json(200, dir(id, '/'));
    if (id.startsWith('f') || id.startsWith('t')) return json(200, file(id));
    return json(404, { errors: [{ detail: 'not found' }] });
  });
  vi.stubGlobal('fetch', impl);
  return { writes };
}

async function connect(answers: ('accept' | 'decline')[], opts: { elicitation?: boolean; mode?: 'elicit' | 'client' } = {}) {
  const { writes } = stack();
  const cozy = createCozyClient(config.baseUrl, tokens);
  const server = new McpServer({ name: 't', version: '0' });
  registerTools(server, cozy, config, new FileIndex(cozy, config.baseUrl, `/tmp/twake-drive-approval-${process.pid}-${Math.random()}.json`), {
    approval: { mode: opts.mode ?? 'elicit', language: 'fr', timeoutMs: 2000 },
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const prompts: string[] = [];
  const client = new Client({ name: 'c', version: '0' }, { capabilities: opts.elicitation === false ? {} : { elicitation: { form: {} } } });
  if (opts.elicitation !== false) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      prompts.push(req.params.message);
      const answer = answers.shift() ?? 'decline';
      return answer === 'accept' ? { action: answer, content: {} } : { action: answer };
    });
  }
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r: any = await client.callTool({ name, arguments: args });
    return { error: r.isError === true, text: (r.content as { text: string }[]).map((c) => c.text).join('\n') };
  };
  const batchOf = async (actions: { tool: string; arguments: Record<string, unknown> }[]) => {
    const r = await call('approve_batch', { actions });
    return { ...r, batchId: /"batchId":"([0-9a-f]{32})"/.exec(r.text)?.[1] };
  };
  return { call, batchOf, writes, prompts };
}

const WRITES: [string, Record<string, unknown>][] = [
  ['create_folder', { name: 'Kick-off', parent_id: 'd1' }],
  ['upload_file', { name: 'notes.txt', content: 'bonjour', parent_id: 'd1' }],
  ['update_file_content', { id: 'f1', content: 'v2' }],
  ['create_document', { kind: 'text', name: 'Compte rendu', parent_id: 'd1' }],
  ['create_note', { title: 'Idées', markdown: '# Idées', parent_id: 'd1' }],
  ['create_shortcut', { name: 'Site', url: 'https://example.com', parent_id: 'd1' }],
  ['create_drawing', { name: 'Schéma', parent_id: 'd1' }],
  ['rename_item', { id: 'f1', new_name: 'Rapport final.txt' }],
  ['move_item', { id: 'f1', destination_id: 'd2' }],
  ['copy_file', { id: 'f1', destination_id: 'd2' }],
  ['set_favorite', { id: 'f1', favorite: true }],
  ['set_tags', { id: 'f1', tags: ['budget', '2027'] }],
  ['trash_item', { id: 'f1' }],
  ['restore_from_trash', { id: 't1' }],
  ['revert_version', { id: 'f1', version_id: 'v1' }],
  ['create_share_link', { id: 'f1' }],
  ['revoke_share_link', { id: 'f1' }],
  ['delete_permanently', { id: 't1' }],
  ['empty_trash', {}],
];

const folder = { name: 'Kick-off', parent_id: 'd1' };
const folder2 = { name: 'Suivi', parent_id: 'd1' };

describe('approve_batch', () => {
  it('lists the write tools as WRITE_TOOLS', () => {
    expect([...WRITE_TOOLS].sort()).toEqual(WRITES.map(([n]) => n).sort());
  });

  it('creates two folders after one approval of the batch', async () => {
    const t = await connect(['accept']);
    const b = await t.batchOf([
      { tool: 'create_folder', arguments: folder },
      { tool: 'create_folder', arguments: folder2 },
    ]);
    expect(b.batchId, b.text).toBeDefined();
    expect(t.prompts).toHaveLength(1);
    expect(t.prompts[0]).toContain('2 actions');
    expect(t.prompts[0]).toContain('[1/2] Twake Drive : Créer un dossier');
    expect(t.prompts[0]).toContain('Nom : Suivi');
    expect(t.writes).toEqual([]);
    expect((await t.call('create_folder', { ...folder, batchId: b.batchId })).error).toBe(false);
    expect((await t.call('create_folder', { ...folder2, batchId: b.batchId })).error).toBe(false);
    expect(t.prompts).toHaveLength(1);
    expect(t.writes).toHaveLength(2);
  });

  it('asks again for a create_folder whose arguments are not in the batch', async () => {
    const t = await connect(['accept', 'accept']);
    const b = await t.batchOf([{ tool: 'create_folder', arguments: folder }]);
    const r = await t.call('create_folder', { ...folder, name: 'Autre', batchId: b.batchId });
    expect(t.prompts).toHaveLength(2);
    expect(t.prompts[1]).toContain('Nom : Autre');
    expect(r.text).toContain('lot non utilisé');
    expect(t.writes).toHaveLength(1);
  });

  it('writes nothing while preparing the batch', async () => {
    const t = await connect(['decline']);
    const b = await t.batchOf(WRITES.map(([tool, args]) => ({ tool, arguments: args })));
    expect(b.batchId).toBeUndefined();
    expect(b.text).toContain('Lot non approuvé');
    expect(t.prompts).toHaveLength(1);
    expect(t.prompts[0]).toContain(`${WRITES.length} actions`);
    expect(t.writes).toEqual([]);
  });

  it('refuses a batch with a read tool', async () => {
    const t = await connect(['accept']);
    const b = await t.batchOf([
      { tool: 'create_folder', arguments: folder },
      { tool: 'list_folder', arguments: { id: 'd1' } },
    ]);
    expect(b.error).toBe(true);
    expect(b.text).toContain('action 2.');
    expect(t.prompts).toEqual([]);
  });

  it.each(WRITES)('%s runs once approved in a batch, without another question', async (tool, args) => {
    const t = await connect(['accept']);
    const b = await t.batchOf([{ tool, arguments: args }]);
    expect(b.batchId, b.text).toBeDefined();
    expect(t.writes).toEqual([]);
    const r = await t.call(tool, { ...args, batchId: b.batchId });
    expect(r.error, r.text).toBe(false);
    expect(r.text).not.toContain('lot non utilisé');
    expect(t.prompts).toHaveLength(1);
    expect(t.writes.length).toBeGreaterThan(0);
  });

  it('creates no batch with TWAKE_DRIVE_APPROVAL=client', async () => {
    const t = await connect([], { mode: 'client' });
    const b = await t.batchOf([{ tool: 'create_folder', arguments: folder }]);
    expect(b.batchId).toBeUndefined();
    expect(b.text).toContain('client');
  });
});
