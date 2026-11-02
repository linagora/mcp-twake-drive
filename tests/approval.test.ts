/**
 * Prior approval of every write: each write tool asks the user (MCP elicitation) with the exact action,
 * and changes nothing in the drive unless the user accepts.
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
import { approvalMessage } from '../src/approval.js';

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

async function connect(answer: 'accept' | 'decline' | 'cancel', opts: { elicitation?: boolean; mode?: 'elicit' | 'client' } = {}) {
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
      return answer === 'accept' ? { action: answer, content: {} } : { action: answer };
    });
  }
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r: any = await client.callTool({ name, arguments: args });
    return { error: r.isError === true, text: r.content[0].text as string };
  };
  return { call, writes, prompts };
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

describe('prior approval of writes', () => {
  it('covers every write tool', async () => {
    const { call } = await connect('accept');
    void call;
    const READ_ONLY = ['get_drive_info', 'list_folder', 'get_item', 'search_files', 'list_recent_files', 'list_favorites', 'list_trash', 'read_file', 'list_shared_drives', 'list_sharings', 'list_share_links'];
    const LOCAL_WRITE = 'download_file';
    const server = new McpServer({ name: 't', version: '0' });
    stack();
    const cozy = createCozyClient(config.baseUrl, tokens);
    registerTools(server, cozy, config, new FileIndex(cozy, config.baseUrl, `/tmp/twake-drive-approval-${process.pid}-x.json`));
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'c', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names.filter((n) => !READ_ONLY.includes(n) && n !== LOCAL_WRITE).sort()).toEqual(WRITES.map(([n]) => n).sort());
    for (const t of tools) expect(t.annotations?.readOnlyHint, t.name).toBe(READ_ONLY.includes(t.name));
  });

  it.each(WRITES)('%s writes only after the user accepts', async (tool, args) => {
    const ok = await connect('accept');
    const r = await ok.call(tool, args);
    expect(r.error, r.text).toBe(false);
    expect(ok.prompts).toHaveLength(1);
    expect(ok.prompts[0]).toMatch(/^Twake Drive : .+\nEn tant que : alice\.twake\.example\.com \(votre compte\)\n/);
    expect(ok.prompts[0]).toMatch(/Réf\. [0-9a-f]{6} · Acceptez/);
    expect(ok.writes.length).toBeGreaterThan(0);
    for (const answer of ['decline', 'cancel'] as const) {
      const no = await connect(answer);
      const n = await no.call(tool, args);
      expect(n.text).toMatch(/^Not done: .*nothing was changed in the drive/);
      expect(no.writes).toEqual([]);
    }
  });

  it('shows paths, drives, what changes and who can open a link', async () => {
    const t = await connect('accept');
    await t.call('move_item', { id: 'f1', destination_id: 'd2' });
    expect(t.prompts[0]).toContain('Drive : Mon Drive');
    expect(t.prompts[0]).toContain('Élément : /Docs/Rapport.txt (2 KB)');
    expect(t.prompts[0]).toContain('Destination : /Archives');
    await t.call('create_share_link', { id: 'f1', write: true, expires_at: '2026-12-01T00:00:00Z' });
    expect(t.prompts[1]).toContain('Créer un lien public (toute personne ayant le lien)');
    expect(t.prompts[1]).toContain('Droits : modification');
    expect(t.prompts[1]).toContain('Expire : 2026-12-01T00:00:00.000Z');
    await t.call('upload_file', { name: 'notes.txt', content: 'bonjour', drive_id: 'drv1' });
    expect(t.prompts[2]).toContain('Drive : Équipe Projet (drive partagé)');
    expect(t.prompts[2]).toContain('Destination : /Drives/Équipe Projet');
    expect(t.prompts[2]).toContain('Contenu : bonjour');
    await t.call('set_tags', { id: 'f1', tags: [] });
    expect(t.prompts[3]).toContain('Étiquettes : budget → aucun');
    await t.call('empty_trash', {});
    expect(t.prompts[4]).toContain('Contenu : 2 éléments: old.txt, older.txt');
    expect(new Set(t.prompts.map((p) => /Réf\. (\w+)/.exec(p)![1])).size).toBe(5);
  });

  it('refuses to write when the client cannot ask, unless it confirms itself', async () => {
    const blind = await connect('accept', { elicitation: false });
    const r = await blind.call('trash_item', { id: 'f1' });
    expect(r.error).toBe(true);
    expect(r.text).toMatch(/cannot ask the user for approval/);
    expect(blind.writes).toEqual([]);
    const client = await connect('accept', { elicitation: false, mode: 'client' });
    expect((await client.call('trash_item', { id: 'f1' })).error).toBe(false);
    expect(client.writes).toHaveLength(1);
  });

  it('never asks for reads', async () => {
    const t = await connect('decline');
    await t.call('get_item', { id: 'f1' });
    await t.call('list_folder', { id: 'd1' });
    await t.call('list_shared_drives', {});
    expect(t.prompts).toEqual([]);
  });

  it('does not ask to revoke when there is no link', async () => {
    const t = await connect('decline');
    const r = await t.call('revoke_share_link', { id: 'f9' });
    expect(r.text).toMatch(/"revoked_links": 0/);
    expect(t.prompts).toEqual([]);
  });
});

describe('shared drives', () => {
  it('lists the root of a shared drive (its shared folder), not the instance root', async () => {
    const t = await connect('accept');
    const r = await t.call('list_folder', { drive_id: 'drv1' });
    expect(r.error, r.text).toBe(false);
    expect(JSON.parse(r.text).folder).toMatchObject({ id: 'root1', path: '/Drives/Équipe Projet' });
  });
});

describe('approvalMessage', () => {
  it('leaves out empty fields, writes English by default and shortens long contents', () => {
    const m = approvalMessage({ action: 'trash_item', details: [['item', '/Docs/a.txt'], ['drive', undefined], ['content', 'x'.repeat(1300)]] }, { language: 'en', as: 'alice.example.com' }, 'abc123');
    expect(m.split('\n').slice(0, 3)).toEqual(['Twake Drive: Move to the trash', 'As: alice.example.com (your account)', 'Item: /Docs/a.txt']);
    expect(m).toContain('… (+100)');
    expect(m.endsWith('Ref. abc123 · Accept to do it now, refuse to cancel.')).toBe(true);
  });
});
