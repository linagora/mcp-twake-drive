/**
 * Local metadata index of the drive, for name search.
 *
 * The cozy-stack has no server-side search: a Mango `$regex` on names scans
 * every document and times out on a large drive, which is why the Twake Drive
 * web and mobile apps search a locally replicated copy. We do the same with
 * the light `/files/_changes` feed (names, folders, types, sizes, dates only),
 * persisted to a private cache file and refreshed incrementally from the last
 * sequence before every search. Nothing is fetched until the first search.
 */
import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface Entry {
  n: string; // name
  t: 'f' | 'd';
  p?: string; // dir_id
  path?: string; // directories only (files: derived from their folder)
  m?: string; // mime
  c?: string; // class
  s?: number; // size
  u?: string; // updated_at
  x?: 1; // trashed
}

interface Snapshot {
  version: 1;
  base: string;
  seq: string;
  synced_at: string;
  entries: Record<string, Entry>;
}

export interface Hit {
  id: string;
  name: string;
  type: 'file' | 'directory';
  path?: string;
  dir_id?: string;
  mime?: string;
  class?: string;
  size?: number;
  updated_at?: string;
}

const FIELDS = ['type', 'name', 'dir_id', 'path', 'trashed', 'mime', 'class', 'size', 'updated_at'];
const BATCH = 10000;

export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

export class FileIndex {
  private entries = new Map<string, Entry>();
  private seq = '0';
  private loaded = false;
  private syncing: Promise<void> | null = null;
  lastSync?: Date;

  constructor(
    private readonly client: any,
    private readonly baseUrl: string,
    private readonly cacheFile: string
  ) {}

  get size(): number {
    return this.entries.size;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const snap = JSON.parse(await readFile(this.cacheFile, 'utf8')) as Snapshot;
      if (snap.version === 1 && snap.base === this.baseUrl) {
        this.entries = new Map(Object.entries(snap.entries));
        this.seq = snap.seq;
      }
    } catch {
      /* no cache yet */
    }
  }

  private async save(): Promise<void> {
    const snap: Snapshot = {
      version: 1,
      base: this.baseUrl,
      seq: this.seq,
      synced_at: new Date().toISOString(),
      entries: Object.fromEntries(this.entries),
    };
    await mkdir(dirname(this.cacheFile), { recursive: true, mode: 0o700 });
    const tmp = `${this.cacheFile}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(snap), { mode: 0o600 });
    await rename(tmp, this.cacheFile);
    await chmod(this.cacheFile, 0o600).catch(() => {});
  }

  /** Pull every change since the last known sequence (coalesced). */
  sync(): Promise<void> {
    if (!this.syncing) {
      this.syncing = this.doSync().finally(() => {
        this.syncing = null;
      });
    }
    return this.syncing;
  }

  private async doSync(): Promise<void> {
    await this.load();
    for (;;) {
      const initial = this.seq === '0';
      // Q() has no query on the changes feed.
      const res: { newLastSeq: string; pending?: number; results: Array<{ id: string; deleted?: boolean; doc?: Record<string, any> }> } = await this.client
        .collection('io.cozy.files')
        .fetchChanges({ since: this.seq }, { includeDocs: true, fields: FIELDS, limit: BATCH, skipDeleted: initial ? true : undefined });
      for (const r of res.results) {
        if (r.deleted || !r.doc) {
          this.entries.delete(r.id);
          continue;
        }
        const d = r.doc;
        const e: Entry = { n: d.name ?? '', t: d.type === 'directory' ? 'd' : 'f' };
        if (d.dir_id) e.p = d.dir_id;
        if (e.t === 'd' && d.path) e.path = d.path;
        if (d.mime) e.m = d.mime;
        if (d.class) e.c = d.class;
        if (d.size !== undefined) e.s = Number(d.size);
        if (d.updated_at) e.u = d.updated_at;
        if (d.trashed) e.x = 1;
        this.entries.set(r.id, e);
      }
      this.seq = res.newLastSeq;
      if (res.results.length > 0) await this.save();
      if (!res.pending || res.results.length === 0) break;
    }
    this.lastSync = new Date();
  }

  private pathOf(id: string, e: Entry): string | undefined {
    if (e.t === 'd') return e.path;
    const parent = e.p ? this.entries.get(e.p) : undefined;
    if (!parent?.path) return undefined;
    return parent.path === '/' ? `/${e.n}` : `${parent.path}/${e.n}`;
  }

  private visible(id: string, e: Entry, path?: string): boolean {
    if (e.x) return false;
    if (id === 'io.cozy.files.root-dir' || id === 'io.cozy.files.trash-dir') return false;
    if (path && (path === '/.cozy_trash' || path.startsWith('/.cozy_trash/'))) return false;
    return true;
  }

  private hit(id: string, e: Entry, path?: string): Hit {
    return {
      id,
      name: e.n,
      type: e.t === 'd' ? 'directory' : 'file',
      path,
      dir_id: e.p,
      mime: e.m,
      class: e.c,
      size: e.s,
      updated_at: e.u,
    };
  }

  /**
   * Accent- and case-insensitive name search; every word of the query must
   * appear in the name. Ranking: exact name, then prefix, then the rest; ties
   * broken by most recent update.
   */
  search(
    query: string,
    opts: { type?: 'file' | 'directory' | 'any'; class?: string; inPath?: string; limit: number }
  ): { total: number; hits: Hit[] } {
    const q = fold(query.trim());
    const words = q.split(/\s+/).filter(Boolean);
    const scope = opts.inPath ? fold(opts.inPath.replace(/\/+$/, '')) : undefined;
    const scored: Array<{ score: number; u: string; hit: Hit }> = [];
    for (const [id, e] of this.entries) {
      if (opts.type === 'file' && e.t !== 'f') continue;
      if (opts.type === 'directory' && e.t !== 'd') continue;
      if (opts.class && e.c !== opts.class) continue;
      const name = fold(e.n);
      if (!words.every((w) => name.includes(w))) continue;
      const path = this.pathOf(id, e);
      if (!this.visible(id, e, path)) continue;
      if (scope && !(path && (fold(path) === scope || fold(path).startsWith(scope + '/')))) continue;
      const base = name.replace(/\.[^.]+$/, '');
      const score = name === q || base === q ? 3 : name.startsWith(q) ? 2 : 1;
      scored.push({ score, u: e.u ?? '', hit: this.hit(id, e, path) });
    }
    scored.sort((a, b) => b.score - a.score || (a.u < b.u ? 1 : a.u > b.u ? -1 : 0));
    return { total: scored.length, hits: scored.slice(0, opts.limit).map((s) => s.hit) };
  }
}
