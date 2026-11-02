import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createCozyClient } from '../src/drive.js';
import { loadConfig, type Config } from '../src/config.js';
import { isTar, isTextLike, markdownFromTar, summarize, withExtension } from '../src/format.js';
import { registerTools, linkSummary } from '../src/tools.js';
import { FileIndex, fold } from '../src/file-index.js';

const config: Config = {
  baseUrl: 'https://alice.twake.example.com',
  cacheDir: '/tmp/twake-drive-test-cache',
  downloadDir: '/tmp/twake-drive-test',
  uploadDir: '/tmp/twake-drive-test',
  maxTextChars: 1000,
};

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;
function fakeFetch(handler: Handler) {
  const calls: { method: string; url: URL; init: RequestInit }[] = [];
  const impl = vi.fn(async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    calls.push({ method: init.method ?? 'GET', url, init });
    return handler(url, init);
  });
  vi.stubGlobal('fetch', impl);
  return { calls };
}
afterEach(() => vi.unstubAllGlobals());
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/vnd.api+json' } });

const tokens = () => {
  let n = 0;
  return { getToken: vi.fn(async () => `tok${++n}`), invalidate: vi.fn() };
};

describe('config', () => {
  it('reads uploads from the download folder unless told otherwise', () => {
    const env = { TWAKE_DRIVE_URL: 'https://x.example.com', TWAKE_DRIVE_TOKEN: 't', TWAKE_DRIVE_DOWNLOAD_DIR: '/d' };
    expect(loadConfig(env).uploadDir).toBe('/d');
    expect(loadConfig({ ...env, TWAKE_DRIVE_UPLOAD_DIR: '/u' }).uploadDir).toBe('/u');
  });
  it('refuses plain HTTP and missing credentials', () => {
    expect(() => loadConfig({ TWAKE_DRIVE_URL: 'http://x.example.com', TWAKE_DRIVE_TOKEN: 't' })).toThrow(/HTTPS/);
    expect(() => loadConfig({ TWAKE_DRIVE_URL: 'https://x.example.com' })).toThrow(/TOKEN/);
    expect(loadConfig({ TWAKE_DRIVE_URL: 'https://x.example.com/', TWAKE_DRIVE_TOKEN: 't' }).baseUrl).toBe('https://x.example.com');
  });
});

describe('createCozyClient', () => {
  const stale = (token: string, refused: () => Response) =>
    fakeFetch((_u, init) =>
      (init.headers as any).Authorization === `Bearer ${token}` ? refused() : json(200, { data: { id: 'x', attributes: {} } })
    );

  it.each([
    ['an expired token', () => new Response('{}', { status: 401, headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer error="invalid_token" error_description="The access token expired"' } })],
    ['an invalid token, which the stack answers with a 400', () => json(400, { error: 'Invalid JWT token' })],
  ])('asks the token source again after %s', async (_name, refused) => {
    const t = tokens();
    const { calls } = stale('tok1', refused);
    const client = createCozyClient(config.baseUrl, t);
    await client.getStackClient().loadToken();
    await client.collection('io.cozy.files').statById('x');
    expect(calls).toHaveLength(2);
    expect(t.invalidate).toHaveBeenCalledOnce();
    expect((calls[1].init.headers as any).Authorization).toBe('Bearer tok2');
  });

  it('gives up when the new token is refused too', async () => {
    const t = tokens();
    const { calls } = fakeFetch(() => json(400, { error: 'Invalid JWT token' }));
    const client = createCozyClient(config.baseUrl, t);
    await client.getStackClient().loadToken();
    await expect(client.collection('io.cozy.files').statById('x')).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(2);
  });
});

describe('helpers', () => {
  it('folds accents and case', () => {
    expect(fold('Réunion ÉTÉ')).toBe('reunion ete');
  });
  it('adds a missing extension', () => {
    expect(withExtension('Budget', 'xlsx')).toBe('Budget.xlsx');
    expect(withExtension('Budget.XLSX', 'xlsx')).toBe('Budget.XLSX');
  });
  it('detects text files', () => {
    expect(isTextLike('text/vnd.cozy.note+markdown')).toBe(true);
    expect(isTextLike('application/json; charset=utf-8')).toBe(true);
    expect(isTextLike('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(false);
    expect(isTextLike('application/pdf')).toBe(false);
  });
  it('gives up on a tar entry with an invalid size', () => {
    const tarWithSize = (size: string, entry = 'image.png') => {
      const enc = new TextEncoder();
      const tar = new Uint8Array(512 * 2);
      tar.set(enc.encode(entry), 0);
      tar.set(enc.encode(size), 124);
      tar.set(enc.encode('ustar'), 257);
      return tar;
    };
    expect(markdownFromTar(tarWithSize('-1000'))).toBe(undefined);
    expect(markdownFromTar(tarWithSize('zzz', 'index.md'))).toBe(undefined);
    expect(markdownFromTar(tarWithSize('77777', 'index.md'))).toBe(undefined);
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
      config.baseUrl,
      { dirPath: '/Docs' }
    );
    expect(s).toMatchObject({ path: '/Docs/a.pdf', size: 2048, favorite: true });
    expect(s.url).toBe('https://alice-drive.twake.example.com/#/folder/d1/file/f1');
  });
  it('builds public link URLs from shortcodes', () => {
    const l = linkSummary(
      { id: 'p1', attributes: { shortcodes: { email: 'ABC' }, permissions: { files: { verbs: ['GET'], values: ['f1'] } } } },
      config.baseUrl
    );
    expect(l).toMatchObject({ url: 'https://alice-drive.twake.example.com/public?sharecode=ABC#/', rights: 'read-only', file_ids: ['f1'] });
  });
});

describe('MCP tools (in-memory)', () => {
  async function connect(handler: Handler, driveConfig = config) {
    const { calls } = fakeFetch(handler);
    const server = new McpServer({ name: 't', version: '0' });
    const cozy = createCozyClient(driveConfig.baseUrl, tokens());
    registerTools(server, cozy, driveConfig, new FileIndex(cozy, driveConfig.baseUrl, `/tmp/twake-drive-test-${process.pid}-${Math.random()}.json`));
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
    expect(calls[0].url.searchParams.get('skip_deleted')).toBe('true');
    expect(calls[0].url.searchParams.get('include_docs')).toBe('true');
    await call('search_files', { query: 'budget' });
    expect(calls[1].url.searchParams.get('since')).toBe('5-x');
  });

  it('reports a note tar it cannot read, and still reads a complete one', async () => {
    const tar = (size: number, stored: number) => {
      const enc = new TextEncoder();
      const bytes = new Uint8Array(512 + stored);
      bytes.set(enc.encode('index.md'), 0);
      bytes.set(enc.encode(size.toString(8).padStart(11, '0')), 124);
      bytes.set(enc.encode('ustar'), 257);
      bytes.fill(97, 512);
      return bytes;
    };
    let body = tar(800, 300);
    const { call } = await connect((u) =>
      u.pathname.startsWith('/files/download/')
        ? new Response(body, { status: 200 })
        : json(200, { data: { id: 'f', attributes: { type: 'file', name: 'n.cozy-note', mime: 'text/vnd.cozy.note+markdown' } } })
    );
    const cut = await call('read_file', { id: 'f' });
    expect(cut.error).toBe(true);
    expect(cut.text).toMatch(/n\.cozy-note.*damaged/);
    body = tar(800, 800);
    expect(JSON.parse((await call('read_file', { id: 'f' })).text).chars).toBe(800);
  });

  describe('local paths', () => {
    let tmp: string;
    let downloadDir: string;
    let outside: string;
    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), 'twake-drive-dl-'));
      downloadDir = join(tmp, 'downloads');
      outside = join(tmp, 'outside');
      mkdirSync(downloadDir);
      mkdirSync(outside);
    });
    afterEach(() => rmSync(tmp, { recursive: true, force: true }));

    const connectFile = () =>
      connect(
        (u, init) =>
          u.pathname.startsWith('/files/download/')
            ? new Response('remote', { status: 200 })
            : json(200, { data: { id: 'f', attributes: { type: 'file', name: init.method === 'PUT' ? 'put.txt' : 'a.txt' } } }),
        { ...config, downloadDir, uploadDir: downloadDir }
      );
    const downloads = (calls: { url: URL }[]) => calls.filter((c) => c.url.pathname.startsWith('/files/download/'));
    const puts = (calls: { method: string }[]) => calls.filter((c) => c.method === 'PUT');

    it('declares that it writes, without replacing anything', async () => {
      const { client } = await connectFile();
      const tool = (await client.listTools()).tools.find((t) => t.name === 'download_file');
      expect(tool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    });

    it('refuses the parent of the folder itself', async () => {
      const { call } = await connectFile();
      expect((await call('download_file', { id: 'f', save_to: `${downloadDir}/..` })).error).toBe(true);
      expect(existsSync(join(tmp, 'a.txt'))).toBe(false);
    });

    it('accepts a name that only starts with two dots', async () => {
      const { call } = await connectFile();
      mkdirSync(join(downloadDir, '..dir'));
      const named = join(downloadDir, '..dir', 'b.txt');
      expect((await call('download_file', { id: 'f', save_to: named })).error).toBe(false);
      expect(readFileSync(named, 'utf8')).toBe('remote');
    });

    it('works when the download folder is itself a symlink', async () => {
      const link = join(tmp, 'link-to-downloads');
      symlinkSync(downloadDir, link);
      const { call } = await connect(
        (u) =>
          u.pathname.startsWith('/files/download/')
            ? new Response('remote', { status: 200 })
            : json(200, { data: { id: 'f', attributes: { type: 'file', name: 'a.txt' } } }),
        { ...config, downloadDir: link }
      );
      expect((await call('download_file', { id: 'f' })).error).toBe(false);
      expect(readFileSync(join(downloadDir, 'a.txt'), 'utf8')).toBe('remote');
    });

    it('refuses a download outside the folder and leaves the target untouched', async () => {
      const target = join(outside, 'target');
      writeFileSync(target, 'local');
      const { call, calls } = await connectFile();
      expect((await call('download_file', { id: 'f', save_to: target })).error).toBe(true);
      expect(readFileSync(target, 'utf8')).toBe('local');
      expect(downloads(calls)).toHaveLength(0);
    });

    it('refuses a new folder created outside, and a ../ path', async () => {
      const { call } = await connectFile();
      expect((await call('download_file', { id: 'f', save_to: join(outside, 'new', 'x') })).error).toBe(true);
      expect(existsSync(join(outside, 'new'))).toBe(false);
      expect((await call('download_file', { id: 'f', save_to: `${downloadDir}/../outside/x` })).error).toBe(true);
      expect(existsSync(join(outside, 'x'))).toBe(false);
    });

    it('refuses a symlinked folder that leaves the download folder', async () => {
      symlinkSync(outside, join(downloadDir, 'link'));
      const { call } = await connectFile();
      expect((await call('download_file', { id: 'f', save_to: join(downloadDir, 'link', 'x') })).error).toBe(true);
      expect((await call('download_file', { id: 'f', save_to: join(downloadDir, 'link') })).error).toBe(true);
      expect(existsSync(join(outside, 'x'))).toBe(false);
      expect(existsSync(join(outside, 'a.txt'))).toBe(false);
    });

    it('does not write through a dangling symlink', async () => {
      const target = join(outside, 'not-yet');
      symlinkSync(target, join(downloadDir, 'dangling'));
      const { call } = await connectFile();
      expect((await call('download_file', { id: 'f', save_to: join(downloadDir, 'dangling') })).error).toBe(true);
      expect(existsSync(target)).toBe(false);
    });

    it('never overwrites an existing file', async () => {
      const existing = join(downloadDir, 'kept.txt');
      writeFileSync(existing, 'local');
      const { call } = await connectFile();
      expect((await call('download_file', { id: 'f', save_to: existing })).error).toBe(true);
      expect(readFileSync(existing, 'utf8')).toBe('local');
    });

    it('downloads inside the folder, by default and with save_to', async () => {
      const { call } = await connectFile();
      const first = JSON.parse((await call('download_file', { id: 'f' })).text);
      const second = JSON.parse((await call('download_file', { id: 'f' })).text);
      expect(first.local_path).toBe(join(downloadDir, 'a.txt'));
      expect(second.local_path).toBe(join(downloadDir, 'a (1).txt'));
      const nested = join(downloadDir, 'sub', 'b.txt');
      expect(JSON.parse((await call('download_file', { id: 'f', save_to: nested })).text).local_path).toBe(nested);
      expect(readFileSync(nested, 'utf8')).toBe('remote');
    });

    it('refuses to replace a file with a local file outside the folder', async () => {
      const other = join(outside, 'other');
      writeFileSync(other, 'local');
      symlinkSync(other, join(downloadDir, 'link-to-other'));
      const { call, calls } = await connectFile();
      expect((await call('update_file_content', { id: 'f', local_path: other })).error).toBe(true);
      expect((await call('update_file_content', { id: 'f', local_path: join(downloadDir, 'link-to-other') })).error).toBe(true);
      expect((await call('update_file_content', { id: 'f', local_path: 'relative.txt' })).error).toBe(true);
      expect(puts(calls)).toHaveLength(0);
    });

    it('refuses to upload a local file outside the upload folder', async () => {
      const other = join(outside, 'other');
      writeFileSync(other, 'local');
      symlinkSync(other, join(downloadDir, 'link-to-other'));
      const { call, calls } = await connectFile();
      expect((await call('upload_file', { local_path: other })).error).toBe(true);
      expect((await call('upload_file', { local_path: join(downloadDir, 'link-to-other') })).error).toBe(true);
      expect((await call('upload_file', { local_path: 'relative.txt' })).error).toBe(true);
      expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    });

    it('uploads a local file from the upload folder, or text from anywhere', async () => {
      const inside = join(downloadDir, 'inside.txt');
      writeFileSync(inside, 'inside');
      const { call, calls } = await connectFile();
      expect((await call('upload_file', { local_path: inside })).error).toBe(false);
      expect((await call('upload_file', { name: 'b.txt', content: 'text' })).error).toBe(false);
      expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2);
    });

    it('reads local files from their own folder when one is set', async () => {
      const uploads = join(tmp, 'uploads');
      mkdirSync(uploads);
      const inside = join(uploads, 'inside.txt');
      writeFileSync(inside, 'inside');
      const notThere = join(downloadDir, 'in-downloads.txt');
      writeFileSync(notThere, 'local');
      const { call } = await connect(() => json(200, { data: { id: 'f', attributes: { type: 'file', name: 'a.txt' } } }), {
        ...config,
        downloadDir,
        uploadDir: uploads,
      });
      expect((await call('upload_file', { local_path: inside })).error).toBe(false);
      expect((await call('update_file_content', { id: 'f', local_path: inside })).error).toBe(false);
      expect((await call('upload_file', { local_path: notThere })).error).toBe(true);
    });

    it('replaces a file from a local file inside the folder, or from content', async () => {
      const edited = join(downloadDir, 'edited.txt');
      writeFileSync(edited, 'edited');
      const { call, calls } = await connectFile();
      expect((await call('update_file_content', { id: 'f', local_path: edited })).error).toBe(false);
      expect((await call('update_file_content', { id: 'f', content: 'text' })).error).toBe(false);
      expect(puts(calls)).toHaveLength(2);
    });
  });

  const findBody = (c: { init: RequestInit }) => JSON.parse(String(c.init.body));

  it('reads recents and favourites through indexed queries, without the changes feed', async () => {
    const { call, calls } = await connect((u) => {
      if (u.pathname === '/data/io.cozy.files/_index') return json(200, { id: '_design/x', result: 'exists' });
      if (u.pathname === '/files/_find') {
        return json(200, {
          data: [{ id: 'f1', type: 'io.cozy.files', attributes: { type: 'file', name: 'a.txt', path: '/a.txt' } }],
          meta: { count: 2 },
          links: { next: '/files/_find?page[cursor]=bm1' },
        });
      }
      return json(404, {});
    });
    const recent = JSON.parse((await call('list_recent_files', { limit: 1 })).text);
    expect(recent).toMatchObject({ count: 1, next_cursor: 'bm1', items: [{ id: 'f1', path: '/a.txt' }] });
    const body = findBody(calls.find((c) => c.url.pathname === '/files/_find')!);
    expect(body.sort).toEqual([{ updated_at: 'desc' }]);
    expect(body.selector.updated_at.$gt).toBe(null);
    expect(body.selector.updated_at.$lte).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    expect(body.selector).toMatchObject({ type: 'file', trashed: false });

    await call('list_recent_files', { limit: 1, cursor: 'bm1' });
    expect(findBody(calls.at(-1)!).bookmark).toBe('bm1');

    const favorites = JSON.parse((await call('list_favorites', { limit: 1 })).text);
    expect(favorites).toMatchObject({ count: 1, next_cursor: 'bm1' });
    expect(findBody(calls.at(-1)!).selector).toMatchObject({ 'cozyMetadata.favorite': true });
    expect(calls.some((c) => c.url.pathname.endsWith('/_changes'))).toBe(false);
  });

  it('lists a folder with one paged request on its own route, by id and by path', async () => {
    const { call, calls } = await connect((u) =>
      json(200, {
        data: { id: 'd', type: 'io.cozy.files', attributes: { type: 'directory', name: 'd', path: '/d' } },
        included: [
          { id: 'sub', type: 'io.cozy.files', attributes: { type: 'directory', name: 'sub', dir_id: 'd', path: '/d/sub' } },
          { id: 'f1', type: 'io.cozy.files', attributes: { type: 'file', name: 'f1', dir_id: 'd' } },
        ],
        links: { next: `${u.pathname}?page[limit]=2&page[cursor]=c2` },
      })
    );
    const byId = JSON.parse((await call('list_folder', { id: 'd', limit: 2, cursor: 'c1' })).text);
    expect(byId).toMatchObject({ count: 2, next_cursor: 'c2' });
    expect(byId.items.map((i: any) => [i.id, i.path])).toEqual([['sub', '/d/sub'], ['f1', '/d/f1']]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url.pathname).toBe('/files/d');
    expect(calls[0].url.searchParams.get('page[limit]')).toBe('2');
    expect(calls[0].url.searchParams.get('page[cursor]')).toBe('c1');

    await call('list_folder', { path: '/d', limit: 2 });
    expect(calls).toHaveLength(2);
    expect(calls[1].url.pathname).toBe('/files/metadata');
    expect(calls[1].url.searchParams.get('Path')).toBe('/d');
    expect(calls[1].url.searchParams.get('page[limit]')).toBe('2');
  });

  it('resolves an item with a single child at most', async () => {
    const { call, calls } = await connect(() => json(200, { data: { id: 'd', type: 'io.cozy.files', attributes: { type: 'directory', name: 'd', path: '/d' } } }));
    await call('get_item', { id: 'd' });
    expect(calls.at(-1)!.url.searchParams.get('page[limit]')).toBe('1');
    await call('get_item', { path: '/d' });
    expect(calls.at(-1)!.url.searchParams.get('page[limit]')).toBe('1');
  });

  it('lists the trash through the stat route of its folder', async () => {
    const { call, calls } = await connect(() =>
      json(200, {
        data: { id: 'io.cozy.files.trash-dir', attributes: { type: 'directory', name: '.cozy_trash', path: '/.cozy_trash' } },
        included: [{ id: 'f', type: 'io.cozy.files', attributes: { type: 'file', name: 'x', restore_path: '/Docs' } }],
        links: { next: '/files/io.cozy.files.trash-dir?page[cursor]=c2' },
      })
    );
    const out = JSON.parse((await call('list_trash', { limit: 1 })).text);
    expect(out).toMatchObject({ count: 1, next_cursor: 'c2', items: [{ id: 'f', restore_path: '/Docs' }] });
    expect(calls).toHaveLength(1);
    expect(calls[0].url.pathname).toBe('/files/io.cozy.files.trash-dir');
  });

  it('turns a stack error into a status, its detail and a hint', async () => {
    const { call } = await connect(() => json(409, { errors: [{ status: '409', detail: 'Conflict' }] }));
    const r = await call('create_folder', { name: 'X' });
    expect(r.error).toBe(true);
    expect(r.text).toContain('Error: HTTP 409 (Conflict)');
    expect(r.text).toMatch(/How to fix: .*same name/);
  });

  it('uploads through FileCollection, in a shared drive too', async () => {
    const { call, calls } = await connect(() => json(201, { data: { id: 'n', attributes: { name: 'a b.txt', type: 'file' } } }));
    await call('upload_file', { name: 'a b.txt', content: 'hi', mime: 'text/plain', parent_id: 'dir1', drive_id: 'drv1' });
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url.pathname).toBe('/sharings/drives/drv1/dir1');
    expect(post.url.searchParams.get('Type')).toBe('file');
    expect(post.url.searchParams.get('Name')).toBe('a b.txt');
    expect((post.init.headers as any)['Content-Type']).toBe('text/plain');
  });

  it('resolves paths through the metadata route, in a shared drive too', async () => {
    const { call, calls } = await connect(() => json(200, { data: { id: 'd', attributes: { type: 'directory', path: '/Docs' } } }));
    await call('get_item', { path: 'Docs/', drive_id: 'drv1' });
    expect(calls[0].url.pathname).toBe('/sharings/drives/drv1/metadata');
    expect(calls[0].url.searchParams.get('Path')).toBe('/Docs');
  });

  it('keeps the spaces of a new name', async () => {
    const { call, calls } = await connect((_u, init) =>
      json(200, { data: { id: 'f', meta: { rev: '1-a' }, attributes: { type: 'file', name: init.method === 'PATCH' ? 'new' : 'old' } } })
    );
    await call('rename_item', { id: 'f', new_name: '  sp.txt ' });
    expect(JSON.parse(String(calls.at(-1)!.init.body)).data.attributes.name).toBe('  sp.txt ');
  });

  it('pages a shared drive folder through its stat route', async () => {
    const { call, calls } = await connect((u) =>
      json(200, {
        data: { id: 'd', attributes: { type: 'directory', name: 'd', path: '/d' } },
        included: [{ id: 'f1', type: 'io.cozy.files', attributes: { type: 'file', name: 'f1', dir_id: 'd' } }],
        links: { next: `${u.pathname}?page[cursor]=c2` },
      })
    );
    const out = JSON.parse((await call('list_folder', { id: 'd', drive_id: 'drv', limit: 5 })).text);
    expect(out).toMatchObject({ count: 1, next_cursor: 'c2', items: [{ id: 'f1', shared_drive_id: 'drv' }] });
    expect(calls.at(-1)!.url.pathname).toBe('/sharings/drives/drv/d');
    expect(calls.at(-1)!.url.searchParams.get('page[limit]')).toBe('5');
    expect(calls).toHaveLength(1);
  });

  it('routes attribute changes to the shared drive when there is one', async () => {
    const { call, calls } = await connect((_u, init) =>
      json(200, { data: { id: 'f', meta: { rev: '1-a' }, attributes: { type: 'file', name: init.method === 'PATCH' ? 'new' : 'old' } } })
    );
    await call('rename_item', { id: 'f', new_name: 'new' });
    expect(calls.at(-1)).toMatchObject({ method: 'PATCH' });
    expect(calls.at(-1)!.url.pathname).toBe('/files/f');
    await call('rename_item', { id: 'f', new_name: 'new', drive_id: 'drv' });
    expect(calls.at(-1)!.url.pathname).toBe('/sharings/drives/drv/f');
  });

  it('keeps old versions out of a folder listing and into get_item', async () => {
    const { call } = await connect(() =>
      json(200, {
        data: { id: 'f', attributes: { type: 'file', name: 'x', dir_id: 'd', path: '/d/x' } },
        included: [{ id: 'f/2-b', type: 'io.cozy.files.versions', attributes: { updated_at: '2026-01-01T00:00:00Z', size: '3' } }],
      })
    );
    const out = JSON.parse((await call('get_item', { id: 'f' })).text);
    expect(out.old_versions).toEqual([{ version_id: '2-b', updated_at: '2026-01-01T00:00:00Z', size: '3 Bytes' }]);
  });

  it('sends the type it is given, even when the name cannot tell it', async () => {
    const { call, calls } = await connect((_u, init) => json(init.method === 'POST' ? 201 : 200, { data: { id: 'n', attributes: { name: 'LIRE', type: 'file', mime: 'text/plain' } } }));
    await call('upload_file', { name: 'x.dat', content: 'hi', mime: 'image/png' });
    expect((calls.find((c) => c.method === 'POST')!.init.headers as any)['Content-Type']).toBe('image/png');
    await call('update_file_content', { id: 'n', content: 'hi' });
    expect((calls.find((c) => c.method === 'PUT')!.init.headers as any)['Content-Type']).toBe('text/plain');
  });

  it('reports a refused download with its status and hint', async () => {
    const { call } = await connect((u) =>
      u.pathname.startsWith('/files/download/')
        ? json(403, { errors: [{ status: '403', detail: 'file is infected' }] })
        : json(200, { data: { id: 'f', attributes: { type: 'file', name: 'a.txt', mime: 'text/plain' } } })
    );
    for (const tool of ['read_file', 'download_file']) {
      const r = await call(tool, { id: 'f' });
      expect(r.error).toBe(true);
      expect(r.text).toContain('Error: HTTP 403 (file is infected)');
      expect(r.text).toMatch(/How to fix: Not allowed/);
    }
  });

  it('gives the token hint on the 400 of a refused token', async () => {
    const { call } = await connect(() => json(400, { error: 'Invalid JWT token' }));
    const r = await call('get_item', { id: 'f' });
    expect(r.text).toContain('HTTP 400 (Invalid JWT token)');
    expect(r.text).toMatch(/How to fix: The Twake Drive token was refused/);
  });

  it('trims a name before looking for a conflict', async () => {
    const { call, calls } = await connect((u, init) => {
      if (init.method === 'POST') return json(201, { data: { id: 'new', attributes: { type: 'file', name: u.searchParams.get('Name') } } });
      if (u.pathname === '/files/metadata') return json(404, { errors: [{ status: '404', title: 'Not Found' }] });
      return json(200, { data: { id: 'io.cozy.files.root-dir', attributes: { type: 'directory', path: '/' } } });
    });
    const r = JSON.parse((await call('upload_file', { name: ' up.txt ', content: 'x', on_conflict: 'rename' })).text);
    expect(r).toMatchObject({ action: 'created', name: 'up.txt' });
    expect(calls.find((c) => c.url.pathname === '/files/metadata')!.url.searchParams.get('Path')).toBe('/up.txt');
  });

  it('upload renames on conflict when asked', async () => {
    const { call, calls } = await connect((u, init) => {
      if (init.method === 'POST') return json(201, { data: { id: 'new', attributes: { type: 'file', name: u.searchParams.get('Name') } } });
      if (u.pathname === '/files/metadata') {
        return u.searchParams.get('Path') === '/note.txt'
          ? json(200, { data: { id: 'old', attributes: { type: 'file', name: 'note.txt' } } })
          : json(404, { errors: [{ status: '404', title: 'Not Found' }] });
      }
      return json(200, { data: { id: 'io.cozy.files.root-dir', attributes: { type: 'directory', path: '/' } } });
    });
    const r = await call('upload_file', { name: 'note.txt', content: 'hello', on_conflict: 'rename' });
    expect(r.error).toBe(false);
    expect(JSON.parse(r.text)).toMatchObject({ action: 'created (renamed)', name: 'note (1).txt' });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('refuses to destroy an item that is not in the trash', async () => {
    const { call, calls } = await connect(() => json(200, { data: { id: 'f', attributes: { type: 'file', name: 'x', trashed: false } } }));
    const r = await call('delete_permanently', { id: 'f' });
    expect(r.error).toBe(true);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('destroys a folder that sits in the trash (folders carry no trashed flag)', async () => {
    const { call, calls } = await connect(() =>
      json(200, { data: { id: 'd', attributes: { type: 'directory', name: 'x', dir_id: 'io.cozy.files.trash-dir', path: '/.cozy_trash/x' } } })
    );
    const r = await call('delete_permanently', { id: 'd' });
    expect(r.error).toBe(false);
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url.pathname).toBe('/files/d');
    expect(JSON.parse(String(patch.init.body)).data.attributes.permanent_delete).toBe(true);
  });

  it('reports errors with a "How to fix" line', async () => {
    const { call } = await connect(() => json(404, { errors: [{ detail: 'not found' }] }));
    const r = await call('get_item', { path: '/Nope' });
    expect(r.error).toBe(true);
    expect(r.text).toMatch(/How to fix: Not found/);
  });
});
