import { generateWebLink } from 'cozy-client';
import { ROOT_DIR_ID, type CozyDoc } from './drive.js';

/** Compact, AI-friendly view of an io.cozy.files document. Undefined fields stay out of the JSON. */
export function summarize(doc: CozyDoc, baseUrl: string, extra: { dirPath?: string; driveId?: string } = {}) {
  const a = doc.attributes ?? {};
  const isFile = a.type !== 'directory';
  return {
    id: doc.id,
    name: a.name as string,
    type: isFile ? 'file' : 'directory',
    path: (a.path ?? (extra.dirPath ? `${extra.dirPath === '/' ? '' : extra.dirPath}/${a.name}` : undefined)) as string | undefined,
    dir_id: a.dir_id || undefined,
    size: isFile && a.size !== undefined ? Number(a.size) : undefined,
    mime: (isFile && a.mime) || undefined,
    class: (isFile && a.class) || undefined,
    created_at: a.created_at || undefined,
    updated_at: a.updated_at || undefined,
    favorite: a.cozyMetadata?.favorite ? true : undefined,
    tags: a.tags?.length ? a.tags : undefined,
    trashed: a.trashed ? true : undefined,
    shared_drive_id: extra.driveId,
    url: webLink(baseUrl, { hash: isFile ? `/folder/${a.dir_id ?? ROOT_DIR_ID}/file/${doc.id}` : `/folder/${doc.id}` }),
  };
}

export function webLink(baseUrl: string, link: { pathname?: string; hash?: string; searchParams?: string[][] }): string {
  return generateWebLink({ cozyUrl: baseUrl, slug: 'drive', subDomainType: 'flat', pathname: '', hash: '', searchParams: [], ...link });
}

export function isTextLike(mime = ''): boolean {
  return /^(text\/|application\/(json|xml|javascript|x-yaml|yaml|vnd\.excalidraw\+json)\b)/i.test(mime);
}

/** A note with images is stored as a tar archive (index.md + images). */
export function isTar(bytes: Uint8Array): boolean {
  if (bytes.length < 262) return false;
  return new TextDecoder().decode(bytes.slice(257, 262)) === 'ustar';
}

/** Extract `index.md` from a (uncompressed, POSIX) tar archive. */
export function markdownFromTar(bytes: Uint8Array): string | undefined {
  let offset = 0;
  const dec = new TextDecoder();
  while (offset + 512 <= bytes.length) {
    const header = bytes.slice(offset, offset + 512);
    const name = dec.decode(header.slice(0, 100)).replace(/\0.*$/s, '');
    if (!name) return undefined;
    const size = parseInt(dec.decode(header.slice(124, 136)).replace(/\0.*$/s, '').trim() || '0', 8);
    const start = offset + 512;
    if (!Number.isInteger(size) || size < 0 || start + size > bytes.length) return undefined;
    if (name === 'index.md' || name.endsWith('/index.md')) return dec.decode(bytes.slice(start, start + size));
    offset = start + Math.ceil(size / 512) * 512;
  }
  return undefined;
}

export function withExtension(name: string, ext: string): string {
  const trimmed = name.trim() || 'Sans titre';
  return trimmed.toLowerCase().endsWith(`.${ext}`) ? trimmed : `${trimmed}.${ext}`;
}
