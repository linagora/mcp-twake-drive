/**
 * Thin client for the Twake Drive (cozy-stack) HTTP API.
 *
 * Routes: docs/files.md, docs/notes.md, docs/permissions.md and
 * docs/shared-drives.md in https://github.com/cozy/cozy-stack. A shared drive
 * mirrors the /files routes under /sharings/drives/:drive-id.
 */
import type { Config } from './config.js';

export const ROOT_DIR_ID = 'io.cozy.files.root-dir';
export const TRASH_DIR_ID = 'io.cozy.files.trash-dir';

export interface TokenSource {
  getToken(): Promise<string>;
  invalidate(): void;
}

export interface CozyDoc {
  id: string;
  type?: string;
  attributes: Record<string, any>;
  meta?: { rev?: string };
  relationships?: Record<string, any>;
  links?: Record<string, string>;
}

export class DriveError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly hint?: string
  ) {
    super(message);
    this.name = 'DriveError';
  }
}

interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: BodyInit | object;
  headers?: Record<string, string>;
  accept?: string;
}

const HINTS: Record<number, string> = {
  401: 'The Twake Drive token was refused. Run `twake-token drive-check`; if the grant is revoked, the user must run `twake-token drive-authorize --renew`.',
  403: 'Not allowed: the OAuth scope or the sharing rights do not cover this operation.',
  404: 'Not found: check the id or the path (paths are absolute, e.g. /Documents/report.pdf).',
  409: 'Conflict: an item with the same name already exists in the destination.',
  412: 'The document changed meanwhile (revision mismatch): fetch it again and retry.',
  413: 'The file is too large for the remaining quota.',
};

export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class DriveClient {
  private readonly fetchImpl: typeof fetch;
  private readonly indexes = new Map<string, string>();

  constructor(
    readonly config: Config,
    private readonly tokens: TokenSource,
    fetchImpl?: typeof fetch
  ) {
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  /** `/files` or, for a shared drive, `/sharings/drives/:id`. */
  base(driveId?: string): string {
    return driveId ? `/sharings/drives/${encodeURIComponent(driveId)}` : '/files';
  }

  async raw(method: string, path: string, opts: RequestOptions = {}, retried = false): Promise<Response> {
    const url = new URL(path, this.config.baseUrl);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = {
      accept: opts.accept ?? 'application/vnd.api+json',
      authorization: `Bearer ${await this.tokens.getToken()}`,
      ...opts.headers,
    };
    let body: BodyInit | undefined;
    if (opts.body !== undefined) {
      if (
        typeof opts.body === 'string' ||
        opts.body instanceof Uint8Array ||
        opts.body instanceof ArrayBuffer ||
        opts.body instanceof Blob
      ) {
        body = opts.body as BodyInit;
      } else {
        body = JSON.stringify(opts.body);
        headers['content-type'] ??= 'application/vnd.api+json';
      }
    }
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (e) {
      throw new DriveError(`Twake Drive did not answer (${method} ${url.pathname}): ${(e as Error).message}`);
    }
    if (res.status === 401 && !retried) {
      this.tokens.invalidate();
      return this.raw(method, path, opts, true);
    }
    return res;
  }

  private async fail(res: Response, what: string): Promise<never> {
    let detail = '';
    try {
      const text = await res.text();
      try {
        const doc = JSON.parse(text);
        detail = doc.errors?.[0]?.detail ?? doc.errors?.[0]?.title ?? doc.error ?? doc.message ?? '';
      } catch {
        detail = text.slice(0, 200);
      }
    } catch {
      /* ignore */
    }
    throw new DriveError(`${what} failed: HTTP ${res.status}${detail ? ` (${detail})` : ''}`, res.status, HINTS[res.status]);
  }

  async json<T = any>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const res = await this.raw(method, path, opts);
    if (!res.ok) await this.fail(res, `${method} ${path.split('?')[0]}`);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  // ---------- reading ----------

  async stat(id: string, driveId?: string, page?: { limit?: number; cursor?: string }) {
    return this.json<{ data: CozyDoc; included?: CozyDoc[]; links?: { next?: string } }>(
      'GET',
      `${this.base(driveId)}/${encodeURIComponent(id)}`,
      { query: { 'page[limit]': page?.limit, 'page[cursor]': page?.cursor } }
    );
  }

  async statByPath(path: string, driveId?: string, page?: { limit?: number; cursor?: string }) {
    return this.json<{ data: CozyDoc; included?: CozyDoc[]; links?: { next?: string } }>(
      'GET',
      `${this.base(driveId)}/metadata`,
      { query: { Path: normalizePath(path), 'page[limit]': page?.limit, 'page[cursor]': page?.cursor } }
    );
  }

  private roots = new Map<string, string>();

  /** Root folder of a drive: the instance root, or the folder a shared drive shares (its first rule). */
  async rootId(driveId?: string): Promise<string> {
    if (!driveId) return ROOT_DIR_ID;
    const known = this.roots.get(driveId);
    if (known) return known;
    const d = (await this.sharedDrives()).find((x) => x.id === driveId);
    const root = d?.attributes.rules?.[0]?.values?.[0];
    if (!root) throw new DriveError(`Unknown shared drive ${driveId}`, 404, 'Use list_shared_drives to get a valid drive_id');
    this.roots.set(driveId, root);
    return root;
  }

  /** Resolve an item from an id or an absolute path (root of the drive when both are absent). */
  async resolve(ref: { id?: string; path?: string }, driveId?: string, page?: { limit?: number; cursor?: string }) {
    if (ref.id) return this.stat(ref.id, driveId, page);
    if (ref.path && ref.path !== '/') return this.statByPath(ref.path, driveId, page);
    return this.stat(await this.rootId(driveId), driveId, page);
  }

  async resolveDirId(ref: { id?: string; path?: string }, driveId?: string): Promise<string> {
    if (ref.id) return ref.id;
    if (!ref.path || ref.path === '/') return this.rootId(driveId);
    const doc = await this.statByPath(ref.path, driveId, { limit: 1 });
    if (doc.data.attributes.type !== 'directory') throw new DriveError(`${ref.path} is a file, not a folder`, 400);
    return doc.data.id;
  }

  async ensureIndex(fields: string[]): Promise<string> {
    const key = fields.join(',');
    const known = this.indexes.get(key);
    if (known) return known;
    const res = await this.json<{ id: string }>('POST', '/data/io.cozy.files/_index', {
      body: { index: { fields } },
      headers: { 'content-type': 'application/json' },
      accept: 'application/json',
    });
    this.indexes.set(key, res.id);
    return res.id;
  }

  async find(body: Record<string, unknown>) {
    return this.json<{ data: CozyDoc[]; links?: { next?: string }; meta?: { count?: number } }>('POST', '/files/_find', {
      body,
      headers: { 'content-type': 'application/json' },
    });
  }

  async download(id: string, driveId?: string): Promise<{ bytes: Uint8Array; contentType: string }> {
    const path = driveId ? `${this.base(driveId)}/download/${encodeURIComponent(id)}` : `/files/download/${encodeURIComponent(id)}`;
    const res = await this.raw('GET', path, { accept: '*/*' });
    if (!res.ok) await this.fail(res, 'download');
    return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get('content-type') ?? '' };
  }

  // ---------- writing ----------

  async upload(
    dirId: string,
    name: string,
    bytes: Uint8Array,
    contentType: string,
    driveId?: string,
    tags?: string[]
  ): Promise<CozyDoc> {
    const res = await this.raw('POST', `${this.base(driveId)}/${encodeURIComponent(dirId)}`, {
      query: { Type: 'file', Name: name, Tags: tags?.length ? tags.join(',') : undefined },
      body: bytes,
      headers: { 'content-type': contentType || 'application/octet-stream' },
    });
    if (!res.ok) await this.fail(res, `upload of ${name}`);
    return ((await res.json()) as { data: CozyDoc }).data;
  }

  async overwrite(id: string, bytes: Uint8Array, contentType: string, driveId?: string, rev?: string): Promise<CozyDoc> {
    const res = await this.raw('PUT', `${this.base(driveId)}/${encodeURIComponent(id)}`, {
      body: bytes,
      headers: { 'content-type': contentType || 'application/octet-stream', ...(rev ? { 'if-match': rev } : {}) },
    });
    if (!res.ok) await this.fail(res, 'content update');
    return ((await res.json()) as { data: CozyDoc }).data;
  }

  async mkdir(parentId: string, name: string, driveId?: string): Promise<CozyDoc> {
    const doc = await this.json<{ data: CozyDoc }>('POST', `${this.base(driveId)}/${encodeURIComponent(parentId)}`, {
      query: { Type: 'directory', Name: name },
    });
    return doc.data;
  }

  async patch(id: string, attributes: Record<string, unknown>, driveId?: string): Promise<CozyDoc> {
    const doc = await this.json<{ data: CozyDoc }>('PATCH', `${this.base(driveId)}/${encodeURIComponent(id)}`, {
      body: { data: { type: 'io.cozy.files', id, attributes } },
    });
    return doc.data;
  }

  async copy(id: string, opts: { name?: string; dirId?: string }, driveId?: string): Promise<CozyDoc> {
    const doc = await this.json<{ data: CozyDoc }>('POST', `${this.base(driveId)}/${encodeURIComponent(id)}/copy`, {
      query: { Name: opts.name, DirID: opts.dirId },
    });
    return doc.data;
  }

  async trash(id: string, driveId?: string): Promise<CozyDoc> {
    const doc = await this.json<{ data: CozyDoc }>('DELETE', `${this.base(driveId)}/${encodeURIComponent(id)}`);
    return doc?.data;
  }

  async listTrash(page?: { limit?: number; cursor?: string }) {
    return this.json<{ data: CozyDoc[]; links?: { next?: string } }>('GET', '/files/trash', {
      query: { 'page[limit]': page?.limit, 'page[cursor]': page?.cursor },
    });
  }

  async restore(id: string): Promise<CozyDoc> {
    const doc = await this.json<{ data: CozyDoc }>('POST', `/files/trash/${encodeURIComponent(id)}`);
    return doc.data;
  }

  async destroy(id: string): Promise<void> {
    await this.json('DELETE', `/files/trash/${encodeURIComponent(id)}`);
  }

  async emptyTrash(): Promise<void> {
    await this.json('DELETE', '/files/trash');
  }

  async revert(id: string, versionId: string): Promise<CozyDoc> {
    const doc = await this.json<{ data: CozyDoc }>(
      'POST',
      `/files/revert/${encodeURIComponent(id)}/${encodeURIComponent(versionId)}`
    );
    return doc.data;
  }

  async createShortcut(name: string, url: string, dirId: string): Promise<CozyDoc> {
    const doc = await this.json<{ data: CozyDoc }>('POST', '/shortcuts', {
      body: { data: { type: 'io.cozy.files.shortcuts', attributes: { name, url, dir_id: dirId } } },
    });
    return doc.data;
  }

  async createEmptyNote(title: string, dirId: string, driveId?: string): Promise<CozyDoc> {
    const path = driveId ? `${this.base(driveId)}/notes` : '/notes';
    const doc = await this.json<{ data: CozyDoc }>('POST', path, {
      body: { data: { type: 'io.cozy.notes.documents', attributes: { title, dir_id: dirId, schema: NOTE_SCHEMA } } },
    });
    return doc.data;
  }

  // ---------- sharing ----------

  async listShareLinks(page?: { limit?: number; cursor?: string }) {
    return this.json<{ data: CozyDoc[]; links?: { next?: string } }>(
      'GET',
      '/permissions/doctype/io.cozy.files/shared-by-link',
      { query: { 'page[limit]': page?.limit ?? 100, 'page[cursor]': page?.cursor } }
    );
  }

  async createShareLink(
    fileId: string,
    opts: { write?: boolean; password?: string; expiresAt?: string }
  ): Promise<CozyDoc> {
    const attributes: Record<string, unknown> = {
      permissions: {
        files: {
          type: 'io.cozy.files',
          verbs: opts.write ? ['GET', 'POST', 'PUT', 'PATCH'] : ['GET'],
          values: [fileId],
        },
      },
    };
    if (opts.password) attributes.password = opts.password;
    if (opts.expiresAt) attributes.expires_at = opts.expiresAt;
    const doc = await this.json<{ data: CozyDoc }>('POST', '/permissions', {
      query: { codes: 'email' },
      body: { data: { type: 'io.cozy.permissions', attributes } },
    });
    return doc.data;
  }

  async deletePermission(id: string): Promise<void> {
    await this.json('DELETE', `/permissions/${encodeURIComponent(id)}`);
  }

  async sharedDrives(): Promise<CozyDoc[]> {
    const doc = await this.json<{ data: CozyDoc[] }>('GET', '/sharings/drives');
    return doc.data ?? [];
  }

  async sharings(): Promise<CozyDoc[]> {
    const doc = await this.json<{ data: CozyDoc[] }>('GET', '/sharings/doctype/io.cozy.files');
    return doc.data ?? [];
  }

  async diskUsage(): Promise<Record<string, unknown>> {
    const doc = await this.json<{ data: CozyDoc }>('GET', '/settings/disk-usage');
    return doc.data.attributes;
  }
}

export function normalizePath(path: string): string {
  const p = ('/' + path.trim()).replace(/\/+/g, '/');
  return p.length > 1 ? p.replace(/\/$/, '') : p;
}

/** Default ProseMirror schema of Cozy Notes (docs/notes.md), OrderedMaps as arrays. */
export const NOTE_SCHEMA = {
  nodes: [
    ['doc', { content: 'block+' }],
    ['paragraph', { content: 'inline*', group: 'block' }],
    ['blockquote', { content: 'block+', group: 'block' }],
    ['horizontal_rule', { group: 'block' }],
    ['heading', { content: 'inline*', group: 'block', attrs: { level: { default: 1 } } }],
    ['code_block', { content: 'text*', marks: '', group: 'block' }],
    ['text', { group: 'inline' }],
    ['image', { group: 'inline', inline: true, attrs: { alt: {}, src: {}, title: {} } }],
    ['hard_break', { group: 'inline', inline: true }],
    ['ordered_list', { content: 'list_item+', group: 'block', attrs: { order: { default: 1 } } }],
    ['bullet_list', { content: 'list_item+', group: 'block' }],
    ['list_item', { content: 'paragraph block*' }],
  ],
  marks: [
    ['link', { attrs: { href: {}, title: {} }, inclusive: false }],
    ['em', {}],
    ['strong', {}],
    ['code', {}],
  ],
  topNode: 'doc',
};
