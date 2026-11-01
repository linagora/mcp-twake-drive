import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { DriveClient, DriveError, escapeRegex, normalizePath } from '../src/drive.js';
import { deriveAppUrl, loadConfig, type Config } from '../src/config.js';
import { isTar, isTextLike, markdownFromTar, summarize, variantName, withExtension } from '../src/format.js';
import { registerTools, linkSummary } from '../src/tools.js';
import { FileIndex, fold } from '../src/file-index.js';

const config: Config = {
  baseUrl: 'https://alice.twake.example.com',
  cacheDir: '/tmp/twake-drive-test-cache',
  appUrl: 'https://alice-drive.twake.example.com',
  downloadDir: '/tmp/twake-drive-test',
  maxTextChars: 1000,
  timeoutMs: 5000,
};

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;
function fakeFetch(handler: Handler) {
  const calls: { method: string; url: URL; init: RequestInit }[] = [];
  const impl = vi.fn(async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    calls.push({ method: init.method ?? 'GET', url, init });
    return handler(url, init);
  });
  return { impl: impl as unknown as typeof fetch, calls };
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/vnd.api+json' } });

const tokens = () => {
  let n = 0;
  return { getToken: vi.fn(async () => `tok${++n}`), invalidate: vi.fn() };
};

describe('config', () => {
  it('derives the drive app URL from the instance', () => {
    expect(deriveAppUrl('https://alice.twake.example.com')).toBe('https://alice-drive.twake.example.com');
    expect(deriveAppUrl('https://a.b.c', 'notes')).toBe('https://a-notes.b.c');
  });
  it('refuses plain HTTP and missing credentials', () => {
    expect(() => loadConfig({ TWAKE_DRIVE_URL: 'http://x.example.com', TWAKE_DRIVE_TOKEN: 't' })).toThrow(/HTTPS/);
    expect(() => loadConfig({ TWAKE_DRIVE_URL: 'https://x.example.com' })).toThrow(/TOKEN/);
    expect(loadConfig({ TWAKE_DRIVE_URL: 'https://x.example.com/', TWAKE_DRIVE_TOKEN: 't' }).baseUrl).toBe('https://x.example.com');
  });
});

describe('DriveClient', () => {
  it('retries once with a fresh token after a 401', async () => {
    const t = tokens();
    const { impl, calls } = fakeFetch((_u, init) =>
      (init.headers as any).authorization === 'Bearer tok1' ? json(401, {}) : json(200, { data: { id: 'x', attributes: {} } })
    );
    const d = new DriveClient(config, t, impl);
    await d.stat('x');
    expect(calls).toHaveLength(2);
    expect(t.invalidate).toHaveBeenCalledOnce();
  });

  it('routes shared-drive calls under /sharings/drives/:id', async () => {
    const { impl, calls } = fakeFetch(() => json(200, { data: { id: 'f', attributes: {} } }));
    const d = new DriveClient(config, tokens(), impl);
    await d.stat('f', 'drv1');
    await d.download('f', 'drv1').catch(() => {});
    expect(calls[0].url.pathname).toBe('/sharings/drives/drv1/f');
    expect(calls[1].url.pathname).toBe('/sharings/drives/drv1/download/f');
  });

  it('uploads with Type/Name query and the raw bytes', async () => {
    const { impl, calls } = fakeFetch(() => json(201, { data: { id: 'n', attributes: { name: 'a.txt', type: 'file' } } }));
    const d = new DriveClient(config, tokens(), impl);
    await d.upload('dir1', 'a b.txt', new TextEncoder().encode('hi'), 'text/plain', undefined, ['x']);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url.pathname).toBe('/files/dir1');
    expect(calls[0].url.searchParams.get('Type')).toBe('file');
    expect(calls[0].url.searchParams.get('Name')).toBe('a b.txt');
    expect(calls[0].url.searchParams.get('Tags')).toBe('x');
    expect((calls[0].init.headers as any)['content-type']).toBe('text/plain');
  });

  it('turns stack errors into DriveError with a hint', async () => {
    const { impl } = fakeFetch(() => json(409, { errors: [{ status: '409', detail: 'Conflict' }] }));
    const d = new DriveClient(config, tokens(), impl);
    const err = await d.mkdir('root', 'X').catch((e) => e);
    expect(err).toBeInstanceOf(DriveError);
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/Conflict/);
    expect(err.hint).toMatch(/same name/);
  });

  it('resolves paths through /files/metadata', async () => {
    const { impl, calls } = fakeFetch(() => json(200, { data: { id: 'd', attributes: { type: 'directory', path: '/Docs' } } }));
    const d = new DriveClient(config, tokens(), impl);
    expect(await d.resolveDirId({ path: 'Docs/' })).toBe('d');
    expect(calls[0].url.pathname).toBe('/files/metadata');
    expect(calls[0].url.searchParams.get('Path')).toBe('/Docs');
  });
});

describe('helpers', () => {
  it('folds accents and case', () => {
    expect(fold('Réunion ÉTÉ')).toBe('reunion ete');
  });
  it('escapes regex metacharacters and normalises paths', () => {
    expect(escapeRegex('a.b (1)*')).toBe('a\\.b \\(1\\)\\*');
    expect(normalizePath('//Docs//x/')).toBe('/Docs/x');
    expect(normalizePath('/')).toBe('/');
  });
  it('names variants and extensions', () => {
    expect(variantName('rapport.pdf', 2)).toBe('rapport (2).pdf');
    expect(variantName('README', 3)).toBe('README (3)');
    expect(withExtension('Budget', 'xlsx')).toBe('Budget.xlsx');
    expect(withExtension('Budget.XLSX', 'xlsx')).toBe('Budget.XLSX');
  });
  it('detects text files', () => {
    expect(isTextLike('text/vnd.cozy.note+markdown', 'n.cozy-note')).toBe(true);
    expect(isTextLike('application/octet-stream', 'x.md')).toBe(true);
    expect(isTextLike('application/pdf', 'x.pdf')).toBe(false);
  });
  it('extracts index.md from a note tar', () => {
    const header = new Uint8Array(512);
    const enc = new TextEncoder();
    header.set(enc.encode('index.md'), 0);
    const body = enc.encode('# Titre\n');
    header.set(enc.encode(body.length.toString(8).padStart(11, '0')), 124);
    header.set(enc.encode('ustar'), 257);
    const tar = new Uint8Array(512 * 3);
    tar.set(header, 0);
    tar.set(body, 512);
    expect(isTar(tar)).toBe(true);
    expect(markdownFromTar(tar)).toBe('# Titre\n');
  });
  it('summarises files with path and web link', () => {
    const s = summarize(
      { id: 'f1', attributes: { type: 'file', name: 'a.pdf', dir_id: 'd1', size: '2048', cozyMetadata: { favorite: true } } },
      config.appUrl,
      { dirPath: '/Docs' }
    );
    expect(s).toMatchObject({ path: '/Docs/a.pdf', size: 2048, favorite: true });
    expect(s.url).toBe('https://alice-drive.twake.example.com/#/folder/d1/file/f1');
  });
  it('builds public link URLs from shortcodes', () => {
    const l = linkSummary(
      { id: 'p1', attributes: { shortcodes: { email: 'ABC' }, permissions: { files: { verbs: ['GET'], values: ['f1'] } } } },
      config.appUrl
    );
    expect(l).toMatchObject({ url: 'https://alice-drive.twake.example.com/public?sharecode=ABC', rights: 'read-only', file_ids: ['f1'] });
  });
});

describe('MCP tools (in-memory)', () => {
  async function connect(handler: Handler) {
    const { impl, calls } = fakeFetch(handler);
    const server = new McpServer({ name: 't', version: '0' });
    const drive = new DriveClient(config, tokens(), impl);
    registerTools(server, drive, new FileIndex(drive, `/tmp/twake-drive-test-${process.pid}-${Math.random()}.json`));
    const [a, b] = InMemoryTransport.createLinkedPair();
    const prompts: string[] = [];
    const client = new Client({ name: 'c', version: '0' }, { capabilities: { elicitation: { form: {} } } });
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      prompts.push(req.params.message);
      return { action: 'accept', content: {} };
    });
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (name: string, args: Record<string, unknown>) => {
      const r: any = await client.callTool({ name, arguments: args });
      return { error: r.isError === true, text: r.content[0].text as string };
    };
    return { client, call, calls, prompts };
  }

  it('exposes the expected tools', async () => {
    const { client } = await connect(() => json(200, {}));
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'copy_file', 'create_document', 'create_drawing', 'create_folder', 'create_note', 'create_share_link',
        'create_shortcut', 'delete_permanently', 'download_file', 'empty_trash', 'get_drive_info', 'get_item',
        'list_favorites', 'list_folder', 'list_recent_files', 'list_share_links', 'list_shared_drives', 'list_sharings',
        'list_trash', 'move_item', 'read_file', 'rename_item', 'restore_from_trash', 'revert_version',
        'revoke_share_link', 'search_files', 'set_favorite', 'set_tags', 'trash_item', 'update_file_content', 'upload_file',
      ].sort()
    );
  });

  it('search syncs the local index from _changes and matches without accents/case', async () => {
    const results = [
      { id: 'io.cozy.files.root-dir', doc: { type: 'directory', name: '', path: '/' } },
      { id: 'd1', doc: { type: 'directory', name: 'Projets', path: '/Projets', dir_id: 'io.cozy.files.root-dir' } },
      { id: 'f1', doc: { type: 'file', name: 'Budget Réunion 2027.xlsx', dir_id: 'd1', class: 'spreadsheet', updated_at: '2026-01-01T00:00:00Z' } },
      { id: 'f2', doc: { type: 'file', name: 'reunion-notes.md', dir_id: 'd1', trashed: true } },
      { id: 'f3', doc: { type: 'file', name: 'Autre.pdf', dir_id: 'd1' } },
    ];
    const { call, calls } = await connect((u) =>
      u.pathname === '/files/_changes' ? json(200, { last_seq: '5-x', pending: 0, results }) : json(200, {})
    );
    const r = await call('search_files', { query: 'budget reunion' });
    expect(r.error).toBe(false);
    const out = JSON.parse(r.text);
    expect(out.total).toBe(1);
    expect(out.items[0]).toMatchObject({ id: 'f1', path: '/Projets/Budget Réunion 2027.xlsx' });
    expect(calls[0].url.searchParams.get('since')).toBe('0');
    const recent = JSON.parse((await call('list_recent_files', {})).text);
    expect(recent.items.map((i: any) => i.id)).toEqual(['f1']); // f2 trashed, f3 has no date
    expect(calls[1].url.searchParams.get('since')).toBe('5-x');
  });

  it('upload renames on conflict when asked', async () => {
    let n = 0;
    const { call, calls } = await connect((u, init) => {
      if (init.method === 'POST' && u.pathname === '/files/io.cozy.files.root-dir') {
        n++;
        return n === 1
          ? json(409, { errors: [{ detail: 'Conflict' }] })
          : json(201, { data: { id: 'new', attributes: { type: 'file', name: u.searchParams.get('Name') } } });
      }
      return json(404, {});
    });
    const r = await call('upload_file', { name: 'note.txt', content: 'hello', on_conflict: 'rename' });
    expect(r.error).toBe(false);
    expect(JSON.parse(r.text)).toMatchObject({ action: 'created (renamed)', name: 'note (2).txt' });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2);
  });

  it('refuses to destroy an item that is not in the trash', async () => {
    const { call, calls } = await connect(() => json(200, { data: { id: 'f', attributes: { type: 'file', name: 'x', trashed: false } } }));
    const r = await call('delete_permanently', { id: 'f' });
    expect(r.error).toBe(true);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('destroys a folder that sits in the trash (folders carry no trashed flag)', async () => {
    const { call, calls } = await connect((_u, init) =>
      init.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : json(200, { data: { id: 'd', attributes: { type: 'directory', name: 'x', dir_id: 'io.cozy.files.trash-dir', path: '/.cozy_trash/x' } } })
    );
    const r = await call('delete_permanently', { id: 'd' });
    expect(r.error).toBe(false);
    expect(calls.find((c) => c.method === 'DELETE')?.url.pathname).toBe('/files/trash/d');
  });

  it('reports errors with a "How to fix" line', async () => {
    const { call } = await connect(() => json(404, { errors: [{ detail: 'not found' }] }));
    const r = await call('get_item', { path: '/Nope' });
    expect(r.error).toBe(true);
    expect(r.text).toMatch(/How to fix: Not found/);
  });
});
