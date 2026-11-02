/** Every cozy-client query of the server: definitions, aliases and fetch policy. */
import { Q } from 'cozy-client';

export const FILES_DOCTYPE = 'io.cozy.files';
export const TRASH_DIR_ID = 'io.cozy.files.trash-dir';

export interface Page {
  limit: number;
  bookmark?: string;
}

// An assistant reads its own writes right away, so a query never answers from the store.
const fetchPolicy = () => true;

const pageAlias = ({ limit, bookmark }: Page) => `/limit/${limit}/bookmark/${bookmark ?? ''}`;

/** Dates past `horizon` are ignored (bogus client clocks). */
export const buildRecentFilesQuery = (horizon: string, page: Page) => ({
  definition: Q(FILES_DOCTYPE)
    .where({ updated_at: { $gt: null, $lte: horizon } })
    .partialIndex({ type: 'file', trashed: false, dir_id: { $nin: [TRASH_DIR_ID] } })
    .indexFields(['updated_at'])
    .sortBy([{ updated_at: 'desc' }])
    .limitBy(page.limit)
    .offsetBookmark(page.bookmark as string),
  options: { as: `${FILES_DOCTYPE}/recent${pageAlias(page)}`, fetchPolicy },
});

export const buildRecentFilesInFolderQuery = (dirId: string, horizon: string, page: Page) => ({
  definition: Q(FILES_DOCTYPE)
    .where({ dir_id: dirId, updated_at: { $gt: null, $lte: horizon } })
    .partialIndex({ type: 'file', trashed: false })
    .indexFields(['dir_id', 'updated_at'])
    .sortBy([{ dir_id: 'desc' }, { updated_at: 'desc' }])
    .limitBy(page.limit)
    .offsetBookmark(page.bookmark as string),
  options: { as: `${FILES_DOCTYPE}/dir/${dirId}/recent${pageAlias(page)}`, fetchPolicy },
});

/** Same partial index as the Twake Drive web app, so the instance does not build a second one. */
export const buildFavoritesQuery = (page: Page) => ({
  definition: Q(FILES_DOCTYPE)
    .where({ name: { $gt: null } })
    .partialIndex({
      'cozyMetadata.favorite': true,
      path: { $or: [{ $exists: false }, { $regex: '^(?!/.cozy_trash)' }] },
      trashed: { $or: [{ $exists: false }, { $eq: false }] },
      driveId: { $exists: false },
    })
    .indexFields(['name'])
    .sortBy([{ name: 'asc' }])
    .limitBy(page.limit)
    .offsetBookmark(page.bookmark as string),
  options: { as: `${FILES_DOCTYPE}/favorites${pageAlias(page)}`, fetchPolicy },
});

export const buildDiskUsageQuery = () => ({
  definition: Q('io.cozy.settings').getById('io.cozy.settings.disk-usage'),
  options: { as: 'io.cozy.settings/io.cozy.settings.disk-usage', fetchPolicy },
});
