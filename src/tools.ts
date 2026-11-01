import { mkdir, readFile, writeFile, stat as fsStat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DriveClient, DriveError, ROOT_DIR_ID, TRASH_DIR_ID, escapeRegex, normalizePath, type CozyDoc } from './drive.js';
import {
  guessMime,
  humanSize,
  isTar,
  isTextLike,
  markdownFromTar,
  summarize,
  variantName,
  withExtension,
} from './format.js';
import type { FileIndex, Hit } from './file-index.js';
import { Approver, ApprovalUnavailable, NotApproved, type ApprovalMode, type Language } from './approval.js';

const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const CREATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
const MODIFY = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

// ---------- shared argument shapes ----------
const itemRef = {
  id: z.string().optional().describe('Item id (from a listing or search). Use either id or path.'),
  path: z.string().optional().describe('Absolute path, e.g. "/Documents/Rapport.pdf". Use either id or path.'),
  drive_id: z
    .string()
    .optional()
    .describe('Shared drive id (from list_shared_drives) when the item lives in a shared drive; omit for "My Drive".'),
};
const parentRef = {
  parent_id: z.string().optional().describe('Destination folder id. Use either parent_id or parent_path.'),
  parent_path: z.string().optional().describe('Destination folder absolute path (default: root "/").'),
  drive_id: itemRef.drive_id,
};

type Ref = { id?: string; path?: string; drive_id?: string };

function text(value: unknown) {
  return { content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

function wrap<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A) => {
    try {
      return text(await fn(args));
    } catch (e) {
      if (e instanceof NotApproved) {
        return text(
          e.outcome === 'decline'
            ? 'Not done: the user refused this action, nothing was changed in the drive. Do not retry unless the user asks again.'
            : 'Not done: no answer to the approval request, nothing was changed in the drive. Do not retry unless the user asks again.'
        );
      }
      if (e instanceof ApprovalUnavailable) return { ...text(`Not done: ${e.message}`), isError: true };
      const err = e as DriveError;
      const lines = [`Error: ${err.message}`];
      if (err.hint) lines.push(`How to fix: ${err.hint}`);
      return { ...text(lines.join('\n')), isError: true };
    }
  };
}

function requireRef(ref: Ref, what = 'item'): void {
  if (!ref.id && !ref.path) throw new DriveError(`Give the ${what} id or path`, 400);
}

async function loadBytes(args: { local_path?: string; content?: string; content_base64?: string }): Promise<Uint8Array> {
  const given = [args.local_path, args.content, args.content_base64].filter((v) => v !== undefined).length;
  if (given !== 1) throw new DriveError('Give exactly one of local_path, content or content_base64', 400);
  if (args.local_path !== undefined) {
    if (!isAbsolute(args.local_path)) throw new DriveError('local_path must be absolute', 400);
    return new Uint8Array(await readFile(args.local_path));
  }
  if (args.content !== undefined) return new TextEncoder().encode(args.content);
  return new Uint8Array(Buffer.from(args.content_base64!, 'base64'));
}

export function registerTools(
  server: McpServer,
  drive: DriveClient,
  index: FileIndex,
  opts: { approval?: { mode: ApprovalMode; language: Language; timeoutMs: number } } = {}
): void {
  const app = drive.config.appUrl;
  const approval = opts.approval ?? drive.config.approval ?? { mode: 'elicit' as const, language: 'en' as const, timeoutMs: 600_000 };
  const approver = new Approver(server.server, { ...approval, as: new URL(drive.config.baseUrl).host });
  const L = (k: Parameters<Approver['label']>[0]) => approver.label(k);
  /** "My Drive" or "Test team (shared drive)". */
  const driveLabel = async (driveId?: string): Promise<string> => {
    if (!driveId) return L('my_drive');
    const d = (await drive.sharedDrives().catch(() => [] as CozyDoc[])).find((x) => x.id === driveId);
    const name = d?.attributes.description ?? d?.attributes.rules?.[0]?.title ?? driveId;
    return `${name} (${L('shared_drive')})`;
  };
  /** Path of a folder for the prompt (its id when it cannot be read). */
  const folderLabel = async (dirId: string, driveId?: string): Promise<string> => {
    try {
      return (await drive.stat(dirId, driveId, { limit: 1 })).data.attributes.path ?? dirId;
    } catch {
      return dirId;
    }
  };
  /** Path of a file or folder for the prompt, with its size for files. */
  const itemLabel = async (doc: CozyDoc, driveId?: string): Promise<string> => {
    const a = doc.attributes;
    if (a.type === 'directory') return `${a.path ?? a.name}/`;
    const dir = a.dir_id ? await folderLabel(a.dir_id, driveId) : '';
    const full = dir && dir !== a.dir_id ? `${dir.replace(/\/$/, '')}/${a.name}` : a.name;
    return a.size !== undefined ? `${full} (${humanSize(Number(a.size))})` : full;
  };
  const conflictLabel = (c?: string) => (c === 'rename' ? L('rename') : c === 'overwrite' ? L('overwrite') : undefined);
  const sourceLabel = (a: { local_path?: string; content?: string; content_base64?: string }, bytes: Uint8Array) =>
    a.local_path ? a.local_path : a.content !== undefined ? `${L('text')} (${humanSize(bytes.length)})` : `base64 (${humanSize(bytes.length)})`;
  const preview = (a: { content?: string }) => (a.content !== undefined ? a.content : undefined);
  const hitSummary = (h: Hit) =>
    summarize(
      { id: h.id, attributes: { type: h.type, name: h.name, dir_id: h.dir_id, path: h.path, mime: h.mime, class: h.class, size: h.size, updated_at: h.updated_at } },
      app
    );
  const sum = (doc: CozyDoc, extra: { dirPath?: string; driveId?: string } = {}) => summarize(doc, app, extra);

  /** Folder paths: from the local index, else one stat per unknown folder. */
  const folderPaths = async (dirIds: string[]): Promise<Record<string, string>> => {
    const out: Record<string, string> = {};
    const unique = [...new Set(dirIds.filter(Boolean))];
    await index.sync().catch(() => {});
    const missing: string[] = [];
    for (const id of unique) {
      const p = index.dirPath(id);
      if (p) out[id] = p;
      else missing.push(id);
    }
    await Promise.all(
      missing.slice(0, 30).map(async (id) => {
        try {
          const p = (await drive.stat(id, undefined, { limit: 1 })).data.attributes.path;
          if (p) out[id] = p;
        } catch {
          /* unknown folder: no path */
        }
      })
    );
    return out;
  };

  /** Summaries of files enriched with their folder path. */
  const withPaths = async (docs: CozyDoc[]) => {
    const paths = await folderPaths(docs.filter((d) => d.attributes.type !== 'directory').map((d) => d.attributes.dir_id));
    return docs.map((d) => sum(d, { dirPath: paths[d.attributes.dir_id] }));
  };

  /** Upload with a name-conflict policy. */
  const uploadWithPolicy = async (
    dirId: string,
    name: string,
    bytes: Uint8Array,
    mime: string,
    onConflict: 'error' | 'rename' | 'overwrite',
    driveId?: string
  ): Promise<{ doc: CozyDoc; action: string }> => {
    try {
      return { doc: await drive.upload(dirId, name, bytes, mime, driveId), action: 'created' };
    } catch (e) {
      if (!(e instanceof DriveError) || e.status !== 409 || onConflict === 'error') throw e;
    }
    if (onConflict === 'overwrite') {
      const dir = await drive.stat(dirId, driveId, { limit: 1 });
      const existing = await drive.statByPath(`${dir.data.attributes.path}/${name}`, driveId, { limit: 1 });
      if (existing.data.attributes.type === 'directory') throw new DriveError(`${name} is a folder`, 409);
      return { doc: await drive.overwrite(existing.data.id, bytes, mime, driveId), action: 'overwritten' };
    }
    for (let n = 2; n < 50; n++) {
      try {
        return { doc: await drive.upload(dirId, variantName(name, n), bytes, mime, driveId), action: 'created (renamed)' };
      } catch (e) {
        if (!(e instanceof DriveError) || e.status !== 409) throw e;
      }
    }
    throw new DriveError(`Could not find a free name for ${name}`, 409);
  };

  // ======================= READ =======================

  server.registerTool(
    'get_drive_info',
    {
      title: 'Drive info',
      description: 'Storage usage and quota of the Twake Drive, plus the web address of the drive.',
      inputSchema: {},
      annotations: READ,
    },
    wrap(async () => {
      const usage = (await drive.diskUsage()) as Record<string, any>;
      const used = Number(usage.used ?? 0);
      const quota = usage.quota !== undefined ? Number(usage.quota) : undefined;
      return {
        instance: drive.config.baseUrl,
        web_app: app,
        used: humanSize(used),
        quota: humanSize(quota),
        used_percent: quota ? Math.round((used / quota) * 1000) / 10 : undefined,
        files_count: usage.files_count,
        versions_size: humanSize(usage.versions !== undefined ? Number(usage.versions) : undefined),
        trash_size: humanSize(usage.trash !== undefined ? Number(usage.trash) : undefined),
      };
    })
  );

  server.registerTool(
    'list_folder',
    {
      title: 'List folder',
      description:
        'List the files and sub-folders of a folder (default: root "/"). Paginated: pass next_cursor back as cursor.',
      inputSchema: {
        ...itemRef,
        limit: z.number().int().min(1).max(100).default(50).describe('Max entries (1-100)'),
        cursor: z.string().optional().describe('next_cursor from a previous call'),
      },
      annotations: READ,
    },
    wrap(async (a: Ref & { limit: number; cursor?: string }) => {
      const res = await drive.resolve(a, a.drive_id, { limit: a.limit, cursor: a.cursor });
      const dir = res.data;
      if (dir.attributes.type !== 'directory') throw new DriveError(`${dir.attributes.name} is a file: use get_item`, 400);
      const items = (res.included ?? [])
        .filter((d) => (d.type ?? 'io.cozy.files') === 'io.cozy.files' && d.id !== TRASH_DIR_ID)
        .map((d) => sum(d, { dirPath: dir.attributes.path, driveId: a.drive_id }));
      const next = res.links?.next ? new URL(res.links.next, drive.config.baseUrl).searchParams.get('page[cursor]') : null;
      return {
        folder: { id: dir.id, path: dir.attributes.path, name: dir.attributes.name, url: sum(dir).url },
        count: items.length,
        items,
        next_cursor: next ?? undefined,
      };
    })
  );

  server.registerTool(
    'get_item',
    {
      title: 'Get item details',
      description: 'Metadata of a file or folder (size, type, dates, path, tags, favourite, old versions, web link).',
      inputSchema: itemRef,
      annotations: READ,
    },
    wrap(async (a: Ref) => {
      requireRef(a);
      const res = await drive.resolve(a, a.drive_id, { limit: 1 });
      const doc = res.data;
      let dirPath: string | undefined;
      if (doc.attributes.type !== 'directory' && doc.attributes.dir_id) {
        dirPath = a.drive_id
          ? (await drive.stat(doc.attributes.dir_id, a.drive_id, { limit: 1 }).catch(() => undefined))?.data.attributes.path
          : (await folderPaths([doc.attributes.dir_id]))[doc.attributes.dir_id];
      }
      const versions = (res.included ?? [])
        .filter((d) => d.type === 'io.cozy.files.versions')
        .map((v) => ({ version_id: v.id.split('/').pop(), updated_at: v.attributes.updated_at, size: humanSize(Number(v.attributes.size)) }));
      return {
        ...sum(doc, { dirPath, driveId: a.drive_id }),
        size_human: humanSize(doc.attributes.size !== undefined ? Number(doc.attributes.size) : undefined),
        rev: doc.meta?.rev,
        created_by_app: doc.attributes.cozyMetadata?.createdByApp,
        old_versions: versions.length ? versions : undefined,
      };
    })
  );

  server.registerTool(
    'search_files',
    {
      title: 'Search files',
      description:
        'Search the whole drive by name: case- and accent-insensitive, every word must appear in the name. ' +
        'Optional filters: type, class (pdf, image, text, spreadsheet, slide, audio, video...) and in_path (folder scope). ' +
        'Uses a local index refreshed from the server before each search; trashed items are excluded. Shared drives not included.',
      inputSchema: {
        query: z.string().min(1).describe('Words of the name to look for'),
        type: z.enum(['file', 'directory', 'any']).default('any'),
        class: z.string().optional().describe('Cozy file class, e.g. "pdf", "image", "text", "spreadsheet", "slide"'),
        in_path: z.string().optional().describe('Only inside this folder (absolute path), e.g. "/LINAGORA/_Clients"'),
        limit: z.number().int().min(1).max(200).default(30),
      },
      annotations: READ,
    },
    wrap(async (a: { query: string; type: 'file' | 'directory' | 'any'; class?: string; in_path?: string; limit: number }) => {
      await index.sync();
      const res = index.search(a.query, { type: a.type, class: a.class, inPath: a.in_path, limit: a.limit });
      return { query: a.query, total: res.total, returned: res.hits.length, items: res.hits.map(hitSummary) };
    })
  );

  server.registerTool(
    'list_recent_files',
    {
      title: 'Recent files',
      description: 'Most recently modified files, newest first (optionally inside a folder).',
      inputSchema: {
        limit: z.number().int().min(1).max(200).default(20),
        in_path: z.string().optional().describe('Only inside this folder (absolute path)'),
      },
      annotations: READ,
    },
    wrap(async (a: { limit: number; in_path?: string }) => {
      await index.sync();
      const hits = index.recent(a.limit, a.in_path);
      return { count: hits.length, items: hits.map(hitSummary) };
    })
  );

  server.registerTool(
    'list_favorites',
    {
      title: 'Favourites',
      description: 'Files and folders marked as favourite.',
      inputSchema: { limit: z.number().int().min(1).max(200).default(100) },
      annotations: READ,
    },
    wrap(async (a: { limit: number }) => {
      const useIndex = await drive.ensureIndex(['cozyMetadata.favorite']);
      const res = await drive.find({ selector: { 'cozyMetadata.favorite': true }, use_index: useIndex, limit: a.limit });
      const items = (await withPaths(res.data.filter((d) => !d.attributes.trashed))).filter(
        (i) => !i.path?.startsWith('/.cozy_trash')
      );
      return { count: items.length, items };
    })
  );

  server.registerTool(
    'list_trash',
    {
      title: 'List trash',
      description: 'Items currently in the trash (they can be restored with restore_from_trash).',
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(50),
        cursor: z.string().optional(),
      },
      annotations: READ,
    },
    wrap(async (a: { limit: number; cursor?: string }) => {
      const res = await drive.listTrash({ limit: a.limit, cursor: a.cursor });
      const next = res.links?.next ? new URL(res.links.next, drive.config.baseUrl).searchParams.get('page[cursor]') : null;
      return {
        count: res.data.length,
        items: res.data.map((d) => ({ ...sum(d), restore_path: d.attributes.restore_path })),
        next_cursor: next ?? undefined,
      };
    })
  );

  server.registerTool(
    'read_file',
    {
      title: 'Read a text file',
      description:
        'Return the text content of a text-like file: .txt, .md, .csv, .json, .xml, .html, Cozy notes (.cozy-note, returned as Markdown) ' +
        'and Excalidraw drawings. For binary files (PDF, Office, images) use download_file and process the local copy.',
      inputSchema: {
        ...itemRef,
        max_chars: z.number().int().min(100).max(500000).optional().describe('Truncate after this many characters'),
      },
      annotations: READ,
    },
    wrap(async (a: Ref & { max_chars?: number }) => {
      requireRef(a, 'file');
      const meta = (await drive.resolve(a, a.drive_id, { limit: 1 })).data;
      if (meta.attributes.type === 'directory') throw new DriveError('This is a folder: use list_folder', 400);
      const name: string = meta.attributes.name;
      if (!isTextLike(meta.attributes.mime, name)) {
        throw new DriveError(`${name} (${meta.attributes.mime}) is not a text file: use download_file`, 415);
      }
      const { bytes } = await drive.download(meta.id, a.drive_id);
      let content = isTar(bytes) ? markdownFromTar(bytes) ?? '' : new TextDecoder().decode(bytes);
      const max = a.max_chars ?? drive.config.maxTextChars;
      const truncated = content.length > max;
      if (truncated) content = content.slice(0, max);
      return { id: meta.id, name, mime: meta.attributes.mime, chars: content.length, truncated, content };
    })
  );

  server.registerTool(
    'download_file',
    {
      title: 'Download a file',
      description:
        'Download a file to the local disk (default folder: TWAKE_DRIVE_DOWNLOAD_DIR) and return its local path, ' +
        'e.g. to read a PDF or an Office document with local tools.',
      inputSchema: {
        ...itemRef,
        save_to: z.string().optional().describe('Absolute local path (file or existing folder). Default: download folder.'),
      },
      annotations: { ...READ, idempotentHint: false },
    },
    wrap(async (a: Ref & { save_to?: string }) => {
      requireRef(a, 'file');
      const meta = (await drive.resolve(a, a.drive_id, { limit: 1 })).data;
      if (meta.attributes.type === 'directory') throw new DriveError('Downloading a whole folder is not supported', 400);
      const name: string = meta.attributes.name;
      let target: string;
      if (a.save_to) {
        if (!isAbsolute(a.save_to)) throw new DriveError('save_to must be absolute', 400);
        const isDir = existsSync(a.save_to) && (await fsStat(a.save_to)).isDirectory();
        target = isDir ? join(a.save_to, name) : a.save_to;
      } else {
        target = join(drive.config.downloadDir, name);
        for (let n = 2; existsSync(target); n++) target = join(drive.config.downloadDir, variantName(name, n));
      }
      await mkdir(dirname(target), { recursive: true });
      const { bytes } = await drive.download(meta.id, a.drive_id);
      await writeFile(target, bytes);
      return { id: meta.id, name, local_path: resolvePath(target), size: humanSize(bytes.length), mime: meta.attributes.mime };
    })
  );

  server.registerTool(
    'list_shared_drives',
    {
      title: 'Shared drives',
      description: 'Shared drives the user owns or belongs to. Use the returned drive_id with the other tools.',
      inputSchema: {},
      annotations: READ,
    },
    wrap(async () => {
      const drives = await drive.sharedDrives();
      return drives.map((d) => ({
        drive_id: d.id,
        name: d.attributes.description ?? d.attributes.rules?.[0]?.title,
        owner: d.attributes.owner === true,
        root_folder_id: d.attributes.rules?.[0]?.values?.[0],
        members: (d.attributes.members ?? []).map((m: any) => ({ name: m.public_name ?? m.name, email: m.email, status: m.status, read_only: m.read_only })),
      }));
    })
  );

  server.registerTool(
    'list_sharings',
    {
      title: 'Sharings',
      description: 'Files and folders shared with people (owner side and recipient side), with members and rights.',
      inputSchema: {},
      annotations: READ,
    },
    wrap(async () => {
      const list = await drive.sharings();
      return list.map((s) => ({
        sharing_id: s.id,
        description: s.attributes.description,
        owner: s.attributes.owner === true,
        drive: s.attributes.drive === true || undefined,
        file_ids: (s.attributes.rules ?? []).flatMap((r: any) => (r.doctype === 'io.cozy.files' ? r.values ?? [] : [])),
        members: (s.attributes.members ?? []).map((m: any) => ({ name: m.public_name ?? m.name, email: m.email, status: m.status, read_only: m.read_only })),
        created_at: s.attributes.created_at,
      }));
    })
  );

  server.registerTool(
    'list_share_links',
    {
      title: 'Public links',
      description: 'Public share links (anyone with the link) that exist on files and folders, with their rights and expiry.',
      inputSchema: {},
      annotations: READ,
    },
    wrap(async () => {
      const res = await drive.listShareLinks();
      return res.data.map((p) => linkSummary(p, app));
    })
  );

  // ======================= CREATE =======================

  server.registerTool(
    'create_folder',
    {
      title: 'Create folder',
      description: 'Create a folder. With parents=true, every missing folder of `path` is created (like mkdir -p).',
      inputSchema: {
        name: z.string().optional().describe('Folder name (with parent_id/parent_path)'),
        path: z.string().optional().describe('Full absolute path of the folder to create, e.g. "/Projets/2027/Kick-off"'),
        parents: z.boolean().default(false),
        ...parentRef,
      },
      annotations: CREATE,
    },
    wrap(async (a: { name?: string; path?: string; parents: boolean; parent_id?: string; parent_path?: string; drive_id?: string }) => {
      if (a.path) {
        const parts = normalizePath(a.path).split('/').filter(Boolean);
        if (!parts.length) throw new DriveError('path must not be the root', 400);
        await approver.confirm({ action: 'create_folder', details: [['drive', await driveLabel(a.drive_id)], ['folder', normalizePath(a.path)]] });
        let parentId = await drive.rootId(a.drive_id);
        let current = '';
        let last: CozyDoc | undefined;
        for (const [i, part] of parts.entries()) {
          current += `/${part}`;
          try {
            last = (await drive.statByPath(current, a.drive_id, { limit: 1 })).data;
            if (i === parts.length - 1) return { already_existed: true, ...sum(last) };
          } catch (e) {
            if (!(e instanceof DriveError) || e.status !== 404) throw e;
            if (i < parts.length - 1 && !a.parents) throw new DriveError(`${current} does not exist (use parents=true)`, 404);
            last = await drive.mkdir(parentId, part, a.drive_id);
          }
          parentId = last.id;
        }
        return { created: true, ...sum(last!) };
      }
      if (!a.name) throw new DriveError('Give either path, or name with parent_id/parent_path', 400);
      const parentId = await drive.resolveDirId({ id: a.parent_id, path: a.parent_path }, a.drive_id);
      await approver.confirm({ action: 'create_folder', details: [['drive', await driveLabel(a.drive_id)], ['destination', await folderLabel(parentId, a.drive_id)], ['name', a.name]] });
      return { created: true, ...sum(await drive.mkdir(parentId, a.name, a.drive_id)) };
    })
  );

  const conflict = z
    .enum(['error', 'rename', 'overwrite'])
    .default('error')
    .describe('If a file with this name exists: error (default), rename ("name (2).ext") or overwrite (new version)');

  server.registerTool(
    'upload_file',
    {
      title: 'Upload / create a file',
      description:
        'Create a file in the drive from a local file (local_path), from text (content) or from base64 bytes (content_base64).',
      inputSchema: {
        name: z.string().optional().describe('File name in the drive (default: basename of local_path)'),
        local_path: z.string().optional().describe('Absolute path of a local file to upload'),
        content: z.string().optional().describe('Text content (UTF-8)'),
        content_base64: z.string().optional().describe('Binary content, base64-encoded'),
        mime: z.string().optional().describe('MIME type (guessed from the extension by default)'),
        on_conflict: conflict,
        ...parentRef,
      },
      annotations: CREATE,
    },
    wrap(async (a: any) => {
      const name: string | undefined = a.name ?? (a.local_path ? basename(a.local_path) : undefined);
      if (!name) throw new DriveError('name is required when uploading content', 400);
      const bytes = await loadBytes(a);
      const dirId = await drive.resolveDirId({ id: a.parent_id, path: a.parent_path }, a.drive_id);
      await approver.confirm({
        action: 'upload_file',
        details: [
          ['drive', await driveLabel(a.drive_id)],
          ['destination', await folderLabel(dirId, a.drive_id)],
          ['name', name],
          ['source', sourceLabel(a, bytes)],
          ['content', preview(a)],
          ['if_exists', conflictLabel(a.on_conflict)],
        ],
      });
      const { doc, action } = await uploadWithPolicy(dirId, name, bytes, a.mime ?? guessMime(name), a.on_conflict, a.drive_id);
      return { action, ...sum(doc, { driveId: a.drive_id }), size_human: humanSize(bytes.length) };
    })
  );

  server.registerTool(
    'update_file_content',
    {
      title: 'Replace file content',
      description: 'Replace the content of an existing file (the previous content is kept as an old version).',
      inputSchema: {
        ...itemRef,
        local_path: z.string().optional(),
        content: z.string().optional(),
        content_base64: z.string().optional(),
      },
      annotations: MODIFY,
    },
    wrap(async (a: any) => {
      requireRef(a, 'file');
      const meta = (await drive.resolve(a, a.drive_id, { limit: 1 })).data;
      if (meta.attributes.type === 'directory') throw new DriveError('This is a folder', 400);
      const bytes = await loadBytes(a);
      await approver.confirm({
        action: 'update_file_content',
        details: [
          ['drive', await driveLabel(a.drive_id)],
          ['file', `${await itemLabel(meta, a.drive_id)} → ${humanSize(bytes.length)}, ${L('kept_as_version')}`],
          ['source', sourceLabel(a, bytes)],
          ['content', preview(a)],
        ],
      });
      const doc = await drive.overwrite(meta.id, bytes, meta.attributes.mime ?? guessMime(meta.attributes.name), a.drive_id, meta.meta?.rev);
      return { updated: true, ...sum(doc, { driveId: a.drive_id }), size_human: humanSize(bytes.length) };
    })
  );

  server.registerTool(
    'create_document',
    {
      title: 'Create an office document',
      description:
        'Create an empty office document from the Twake Drive templates: text (.docx), sheet (.xlsx) or slide (.pptx). ' +
        'It opens in the online office editor from the returned url.',
      inputSchema: {
        kind: z.enum(['text', 'sheet', 'slide']),
        name: z.string().describe('Document name (extension added if missing)'),
        on_conflict: conflict,
        ...parentRef,
      },
      annotations: CREATE,
    },
    wrap(async (a: any) => {
      const tpl = { text: 'text.docx', sheet: 'sheet.xlsx', slide: 'slide.pptx' }[a.kind as 'text' | 'sheet' | 'slide'];
      const ext = tpl.split('.')[1];
      const name = withExtension(a.name, ext);
      const bytes = new Uint8Array(await readFile(join(TEMPLATES_DIR, tpl)));
      const dirId = await drive.resolveDirId({ id: a.parent_id, path: a.parent_path }, a.drive_id);
      await approver.confirm({
        action: 'create_document',
        details: [['drive', await driveLabel(a.drive_id)], ['destination', await folderLabel(dirId, a.drive_id)], ['name', name], ['if_exists', conflictLabel(a.on_conflict)]],
      });
      const { doc, action } = await uploadWithPolicy(dirId, name, bytes, guessMime(name), a.on_conflict, a.drive_id);
      return { action, ...sum(doc, { driveId: a.drive_id }) };
    })
  );

  server.registerTool(
    'create_note',
    {
      title: 'Create a note',
      description:
        'Create a Twake/Cozy note (collaborative rich-text document). Optional initial content in Markdown ' +
        '(headings, lists, bold, italic, links, code, quotes).',
      inputSchema: {
        title: z.string().describe('Note title (also the file name)'),
        markdown: z.string().optional().describe('Initial content in Markdown'),
        on_conflict: conflict,
        ...parentRef,
      },
      annotations: CREATE,
    },
    wrap(async (a: any) => {
      const dirId = await drive.resolveDirId({ id: a.parent_id, path: a.parent_path }, a.drive_id);
      await approver.confirm({
        action: 'create_note',
        details: [
          ['drive', await driveLabel(a.drive_id)],
          ['destination', await folderLabel(dirId, a.drive_id)],
          ['name', a.title],
          ['content', a.markdown],
          ['if_exists', conflictLabel(a.on_conflict)],
        ],
      });
      if (!a.markdown) {
        const doc = await drive.createEmptyNote(a.title, dirId, a.drive_id);
        return { action: 'created', ...sum(doc, { driveId: a.drive_id }) };
      }
      // A .cozy-note upload is turned back into a ProseMirror note by the stack (docs/notes.md).
      const name = withExtension(a.title, 'cozy-note');
      const { doc, action } = await uploadWithPolicy(
        dirId,
        name,
        new TextEncoder().encode(a.markdown),
        'text/vnd.cozy.note+markdown',
        a.on_conflict,
        a.drive_id
      );
      return { action, ...sum(doc, { driveId: a.drive_id }) };
    })
  );

  server.registerTool(
    'create_shortcut',
    {
      title: 'Create a web shortcut',
      description: 'Create a shortcut (.url file) to a web address in a folder.',
      inputSchema: {
        name: z.string(),
        url: z.string().url(),
        parent_id: parentRef.parent_id,
        parent_path: parentRef.parent_path,
      },
      annotations: CREATE,
    },
    wrap(async (a: { name: string; url: string; parent_id?: string; parent_path?: string }) => {
      const dirId = await drive.resolveDirId({ id: a.parent_id, path: a.parent_path });
      await approver.confirm({
        action: 'create_shortcut',
        details: [['drive', L('my_drive')], ['destination', await folderLabel(dirId)], ['name', withExtension(a.name, 'url')], ['url', a.url]],
      });
      return { action: 'created', ...sum(await drive.createShortcut(withExtension(a.name, 'url'), a.url, dirId)) };
    })
  );

  server.registerTool(
    'create_drawing',
    {
      title: 'Create a drawing',
      description: 'Create an empty Excalidraw drawing (.excalidraw) that opens in the Twake Drive whiteboard.',
      inputSchema: { name: z.string(), on_conflict: conflict, ...parentRef },
      annotations: CREATE,
    },
    wrap(async (a: any) => {
      const name = withExtension(a.name, 'excalidraw');
      const scene = JSON.stringify({ type: 'excalidraw', version: 2, elements: [], appState: {}, files: {} });
      const dirId = await drive.resolveDirId({ id: a.parent_id, path: a.parent_path }, a.drive_id);
      await approver.confirm({
        action: 'create_drawing',
        details: [['drive', await driveLabel(a.drive_id)], ['destination', await folderLabel(dirId, a.drive_id)], ['name', name], ['if_exists', conflictLabel(a.on_conflict)]],
      });
      const { doc, action } = await uploadWithPolicy(
        dirId,
        name,
        new TextEncoder().encode(scene),
        'application/vnd.excalidraw+json',
        a.on_conflict,
        a.drive_id
      );
      return { action, ...sum(doc, { driveId: a.drive_id }) };
    })
  );

  // ======================= ORGANISE =======================

  server.registerTool(
    'rename_item',
    {
      title: 'Rename',
      description: 'Rename a file or a folder (keep the extension unless asked otherwise).',
      inputSchema: { ...itemRef, new_name: z.string().min(1) },
      annotations: MODIFY,
    },
    wrap(async (a: Ref & { new_name: string }) => {
      requireRef(a);
      const meta = (await drive.resolve(a, a.drive_id, { limit: 1 })).data;
      await approver.confirm({
        action: 'rename_item',
        details: [['drive', await driveLabel(a.drive_id)], ['item', await itemLabel(meta, a.drive_id)], ['change', `${meta.attributes.name} → ${a.new_name}`]],
      });
      return { renamed_from: meta.attributes.name, ...sum(await drive.patch(meta.id, { name: a.new_name }, a.drive_id)) };
    })
  );

  server.registerTool(
    'move_item',
    {
      title: 'Move',
      description: 'Move a file or folder into another folder of the same drive.',
      inputSchema: {
        ...itemRef,
        destination_id: z.string().optional().describe('Destination folder id'),
        destination_path: z.string().optional().describe('Destination folder absolute path ("/" for root)'),
      },
      annotations: MODIFY,
    },
    wrap(async (a: Ref & { destination_id?: string; destination_path?: string }) => {
      requireRef(a);
      if (!a.destination_id && !a.destination_path) throw new DriveError('Give destination_id or destination_path', 400);
      const meta = (await drive.resolve(a, a.drive_id, { limit: 1 })).data;
      const dirId = await drive.resolveDirId({ id: a.destination_id, path: a.destination_path }, a.drive_id);
      await approver.confirm({
        action: 'move_item',
        details: [['drive', await driveLabel(a.drive_id)], ['item', await itemLabel(meta, a.drive_id)], ['destination', await folderLabel(dirId, a.drive_id)]],
      });
      return { moved: true, ...sum(await drive.patch(meta.id, { dir_id: dirId }, a.drive_id)) };
    })
  );

  server.registerTool(
    'copy_file',
    {
      title: 'Copy a file',
      description: 'Copy a file, in the same folder (a copy suffix is added) or into another folder, optionally with a new name.',
      inputSchema: {
        ...itemRef,
        destination_id: z.string().optional(),
        destination_path: z.string().optional(),
        new_name: z.string().optional(),
      },
      annotations: CREATE,
    },
    wrap(async (a: Ref & { destination_id?: string; destination_path?: string; new_name?: string }) => {
      requireRef(a, 'file');
      const meta = (await drive.resolve(a, a.drive_id, { limit: 1 })).data;
      if (meta.attributes.type === 'directory') throw new DriveError('Copying a folder is not supported by the API', 400);
      const dirId =
        a.destination_id || a.destination_path
          ? await drive.resolveDirId({ id: a.destination_id, path: a.destination_path }, a.drive_id)
          : undefined;
      await approver.confirm({
        action: 'copy_file',
        details: [
          ['drive', await driveLabel(a.drive_id)],
          ['file', await itemLabel(meta, a.drive_id)],
          ['destination', dirId ? await folderLabel(dirId, a.drive_id) : meta.attributes.dir_id ? await folderLabel(meta.attributes.dir_id, a.drive_id) : undefined],
          ['name', a.new_name],
        ],
      });
      return { copied: true, ...sum(await drive.copy(meta.id, { name: a.new_name, dirId }, a.drive_id)) };
    })
  );

  server.registerTool(
    'set_favorite',
    {
      title: 'Favourite',
      description: 'Mark or unmark a file or folder as favourite.',
      inputSchema: { ...itemRef, favorite: z.boolean().default(true) },
      annotations: MODIFY,
    },
    wrap(async (a: Ref & { favorite: boolean }) => {
      requireRef(a);
      const meta = (await drive.resolve(a, a.drive_id, { limit: 1 })).data;
      await approver.confirm({
        action: 'set_favorite',
        details: [['drive', await driveLabel(a.drive_id)], ['item', await itemLabel(meta, a.drive_id)], ['change', L(a.favorite ? 'on' : 'off')]],
      });
      const cozyMetadata = { ...(meta.attributes.cozyMetadata ?? {}), favorite: a.favorite };
      return sum(await drive.patch(meta.id, { cozyMetadata }, a.drive_id));
    })
  );

  server.registerTool(
    'set_tags',
    {
      title: 'Tags',
      description: 'Replace the tags of a file or folder (pass [] to clear).',
      inputSchema: { ...itemRef, tags: z.array(z.string()) },
      annotations: MODIFY,
    },
    wrap(async (a: Ref & { tags: string[] }) => {
      requireRef(a);
      const meta = (await drive.resolve(a, a.drive_id, { limit: 1 })).data;
      const before: string[] = meta.attributes.tags ?? [];
      await approver.confirm({
        action: 'set_tags',
        details: [
          ['drive', await driveLabel(a.drive_id)],
          ['item', await itemLabel(meta, a.drive_id)],
          ['tags', `${before.length ? before.join(', ') : L('none')} → ${a.tags.length ? a.tags.join(', ') : L('none')}`],
        ],
      });
      return sum(await drive.patch(meta.id, { tags: a.tags }, a.drive_id));
    })
  );

  server.registerTool(
    'trash_item',
    {
      title: 'Move to trash',
      description: 'Move a file or folder to the trash (reversible with restore_from_trash).',
      inputSchema: itemRef,
      annotations: { ...MODIFY, destructiveHint: true },
    },
    wrap(async (a: Ref) => {
      requireRef(a);
      const meta = (await drive.resolve(a, a.drive_id, { limit: 1 })).data;
      await approver.confirm({
        action: 'trash_item',
        details: [['drive', await driveLabel(a.drive_id)], ['item', `${await itemLabel(meta, a.drive_id)} · ${L('reversible')}`]],
      });
      await drive.trash(meta.id, a.drive_id);
      return { trashed: true, id: meta.id, name: meta.attributes.name };
    })
  );

  server.registerTool(
    'restore_from_trash',
    {
      title: 'Restore from trash',
      description: 'Restore a trashed item to its original folder (id from list_trash).',
      inputSchema: { id: z.string() },
      annotations: MODIFY,
    },
    wrap(async (a: { id: string }) => {
      const meta = (await drive.stat(a.id, undefined, { limit: 1 })).data;
      const back = meta.attributes.restore_path;
      await approver.confirm({
        action: 'restore_from_trash',
        details: [['item', meta.attributes.name], ['destination', back]],
      });
      return { restored: true, ...sum(await drive.restore(a.id)) };
    })
  );

  server.registerTool(
    'revert_version',
    {
      title: 'Restore an old version',
      description: 'Make an old version (version_id from get_item.old_versions) the current content of a file.',
      inputSchema: { id: z.string(), version_id: z.string() },
      annotations: MODIFY,
    },
    wrap(async (a: { id: string; version_id: string }) => {
      const res = await drive.stat(a.id, undefined, { limit: 1 });
      const v = (res.included ?? []).find((d) => d.type === 'io.cozy.files.versions' && d.id.split('/').pop() === a.version_id);
      await approver.confirm({
        action: 'revert_version',
        details: [
          ['file', `${await itemLabel(res.data)}, ${L('kept_as_version')}`],
          ['version', v ? `${v.attributes.updated_at} (${humanSize(Number(v.attributes.size))})` : a.version_id],
        ],
      });
      return { reverted: true, ...sum(await drive.revert(a.id, a.version_id)) };
    })
  );

  // ======================= SHARE LINKS =======================

  server.registerTool(
    'create_share_link',
    {
      title: 'Create a public link',
      description:
        'Create a public link to a file or folder: ANYONE with the link can open it (read-only by default). ' +
        'Optional password and expiry date. Confirm with the user before creating one.',
      inputSchema: {
        ...itemRef,
        write: z.boolean().default(false).describe('Allow editing through the link (default: read-only)'),
        password: z.string().min(4).optional(),
        expires_at: z.string().optional().describe('ISO date/time after which the link stops working'),
      },
      annotations: CREATE,
    },
    wrap(async (a: Ref & { write: boolean; password?: string; expires_at?: string }) => {
      requireRef(a);
      if (a.drive_id) throw new DriveError('Public links on shared-drive items are not supported by this tool', 400);
      const meta = (await drive.resolve(a, undefined, { limit: 1 })).data;
      const expiresAt = a.expires_at ? new Date(a.expires_at).toISOString() : undefined;
      await approver.confirm({
        action: 'create_share_link',
        details: [
          ['item', await itemLabel(meta)],
          ['rights', L(a.write ? 'edit' : 'read_only')],
          ['password', a.password ? L('yes') : L('none')],
          ['expires', expiresAt ?? L('never')],
        ],
      });
      const perm = await drive.createShareLink(meta.id, { write: a.write, password: a.password, expiresAt });
      return { item: sum(meta), link: linkSummary(perm, app) };
    })
  );

  server.registerTool(
    'revoke_share_link',
    {
      title: 'Revoke public links',
      description: 'Delete every public link that gives access to a file or folder.',
      inputSchema: itemRef,
      annotations: { ...MODIFY, destructiveHint: true },
    },
    wrap(async (a: Ref) => {
      requireRef(a);
      const meta = (await drive.resolve(a, undefined, { limit: 1 })).data;
      const res = await drive.listShareLinks();
      const matching = res.data.filter((p) =>
        Object.values(p.attributes.permissions ?? {}).some((r: any) => (r.values ?? []).includes(meta.id))
      );
      if (matching.length) {
        await approver.confirm({ action: 'revoke_share_link', details: [['item', await itemLabel(meta)], ['links', String(matching.length)]] });
      }
      for (const p of matching) await drive.deletePermission(p.id);
      return { item: meta.attributes.name, revoked_links: matching.length };
    })
  );

  // ======================= PERMANENT DELETION =======================

  server.registerTool(
    'delete_permanently',
    {
      title: 'Delete permanently',
      description: 'Permanently destroy an item that is ALREADY in the trash. Irreversible.',
      inputSchema: { id: z.string() },
      annotations: DESTRUCTIVE,
    },
    wrap(async (a: { id: string }) => {
      const meta = (await drive.stat(a.id, undefined, { limit: 1 })).data;
      const inTrash =
        meta.attributes.trashed === true ||
        meta.attributes.dir_id === TRASH_DIR_ID ||
        String(meta.attributes.path ?? '').startsWith('/.cozy_trash/');
      if (!inTrash) throw new DriveError('Only trashed items can be destroyed: use trash_item first', 400);
      await approver.confirm({
        action: 'delete_permanently',
        details: [['item', `${meta.attributes.name}${meta.attributes.size !== undefined ? ` (${humanSize(Number(meta.attributes.size))})` : ''}`], ['folder', meta.attributes.restore_path]],
      });
      await drive.destroy(a.id);
      return { destroyed: true, id: a.id, name: meta.attributes.name };
    })
  );

  server.registerTool(
    'empty_trash',
    {
      title: 'Empty trash',
      description: 'Permanently destroy everything in the trash. Irreversible.',
      inputSchema: {},
      annotations: DESTRUCTIVE,
    },
    wrap(async () => {
      const trash = await drive.listTrash({ limit: 100 }).catch(() => undefined);
      const items = trash?.data ?? [];
      const names = items.slice(0, 10).map((d) => d.attributes.name);
      await approver.confirm({
        action: 'empty_trash',
        details: [['contents', trash ? `${items.length}${trash.links?.next ? '+' : ''} ${L('items')}${names.length ? `: ${names.join(', ')}${items.length > 10 ? ', …' : ''}` : ''}` : undefined]],
      });
      await drive.emptyTrash();
      return { emptied: true };
    })
  );
}

export function linkSummary(p: CozyDoc, appUrl: string) {
  const a = p.attributes ?? {};
  const code = a.shortcodes?.email ?? a.shortcodes?.code ?? a.codes?.email ?? a.codes?.code;
  const rules = Object.values(a.permissions ?? {}) as Array<{ verbs?: string[]; values?: string[] }>;
  const verbs = rules.flatMap((r) => r.verbs ?? []);
  return {
    link_id: p.id,
    url: code ? `${appUrl}/public?sharecode=${encodeURIComponent(code)}` : undefined,
    file_ids: rules.flatMap((r) => r.values ?? []),
    rights: verbs.some((v) => v !== 'GET') ? 'edit' : 'read-only',
    password: a.password ? true : undefined,
    expires_at: a.expires_at,
    created_at: a.cozyMetadata?.createdAt,
  };
}
