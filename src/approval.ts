/**
 * Prior approval of every write, asked by the server itself through MCP elicitation: the client shows
 * the user the exact action (item, folder, drive, what changes) and the server writes only on an
 * explicit "accept". Fail closed: a client that cannot ask, a refusal, a timeout or an error means
 * nothing is written.
 */
import { randomBytes } from 'node:crypto';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

export type ApprovalMode = 'elicit' | 'client';
export type Language = 'en' | 'fr';

export class ApprovalUnavailable extends Error {}

export class NotApproved extends Error {
  constructor(readonly outcome: 'decline' | 'cancel') {
    super(outcome);
  }
}

const ACTIONS = {
  create_folder: { en: 'Create a folder', fr: 'Créer un dossier' },
  upload_file: { en: 'Upload a file', fr: 'Déposer un fichier' },
  update_file_content: { en: 'Replace the content of a file', fr: "Remplacer le contenu d'un fichier" },
  create_document: { en: 'Create an office document', fr: 'Créer un document bureautique' },
  create_note: { en: 'Create a note', fr: 'Créer une note' },
  create_shortcut: { en: 'Create a web shortcut', fr: 'Créer un raccourci web' },
  create_drawing: { en: 'Create a drawing', fr: 'Créer un dessin' },
  rename_item: { en: 'Rename', fr: 'Renommer' },
  move_item: { en: 'Move', fr: 'Déplacer' },
  copy_file: { en: 'Copy a file', fr: 'Copier un fichier' },
  set_favorite: { en: 'Change a favourite', fr: 'Modifier un favori' },
  set_tags: { en: 'Replace the tags', fr: 'Remplacer les étiquettes' },
  trash_item: { en: 'Move to the trash', fr: 'Mettre à la corbeille' },
  restore_from_trash: { en: 'Restore from the trash', fr: 'Restaurer depuis la corbeille' },
  revert_version: { en: 'Restore an old version', fr: 'Restaurer une ancienne version' },
  create_share_link: { en: 'Create a public link (anyone with the link)', fr: 'Créer un lien public (toute personne ayant le lien)' },
  revoke_share_link: { en: 'Revoke the public links', fr: 'Révoquer les liens publics' },
  delete_permanently: { en: 'Delete permanently (cannot be undone)', fr: 'Supprimer définitivement (irréversible)' },
  empty_trash: { en: 'Empty the trash (cannot be undone)', fr: 'Vider la corbeille (irréversible)' },
} as const;

const LABELS = {
  en: {
    as: 'As', drive: 'Drive', item: 'Item', file: 'File', folder: 'Folder', name: 'Name', destination: 'Destination', size: 'Size', source: 'Source',
    content: 'Content', if_exists: 'If the name exists', change: 'Change', tags: 'Tags', version: 'Version', rights: 'Rights', password: 'Password',
    expires: 'Expires', links: 'Links', url: 'Address', contents: 'Contents', account: 'your account', ref: 'Ref.', footer: 'Accept to do it now, refuse to cancel.',
    my_drive: 'My Drive', shared_drive: 'shared drive', read_only: 'read-only', edit: 'can edit', yes: 'yes', none: 'none', never: 'never',
    error: 'stop', rename: 'add a number', overwrite: 'replace it (new version)', text: 'text', on: 'add to favourites', off: 'remove from favourites',
    kept_as_version: 'the current content is kept as an old version', reversible: 'reversible from the trash', items: 'items',
  },
  fr: {
    as: 'En tant que', drive: 'Drive', item: 'Élément', file: 'Fichier', folder: 'Dossier', name: 'Nom', destination: 'Destination', size: 'Taille', source: 'Source',
    content: 'Contenu', if_exists: 'Si le nom existe', change: 'Changement', tags: 'Étiquettes', version: 'Version', rights: 'Droits', password: 'Mot de passe',
    expires: 'Expire', links: 'Liens', url: 'Adresse', contents: 'Contenu', account: 'votre compte', ref: 'Réf.', footer: 'Acceptez pour le faire maintenant, refusez pour annuler.',
    my_drive: 'Mon Drive', shared_drive: 'drive partagé', read_only: 'lecture seule', edit: 'modification', yes: 'oui', none: 'aucun', never: 'jamais',
    error: 'arrêter', rename: 'ajouter un numéro', overwrite: 'le remplacer (nouvelle version)', text: 'texte', on: 'ajouter aux favoris', off: 'retirer des favoris',
    kept_as_version: "le contenu actuel est gardé comme ancienne version", reversible: 'réversible depuis la corbeille', items: 'éléments',
  },
} as const;

export type Action = keyof typeof ACTIONS;
export type Label = keyof (typeof LABELS)['en'];

export interface ApprovalRequest {
  action: Action;
  details: [Label, string | undefined][];
}

export interface ApprovalOptions {
  mode: ApprovalMode;
  language: Language;
  timeoutMs: number;
  /** Who the writes are made as. */
  as?: string;
}

const MAX_SHOWN = 1200;

export function approvalMessage(req: ApprovalRequest, opts: Pick<ApprovalOptions, 'language' | 'as'>, ref: string): string {
  const L = LABELS[opts.language];
  const sep = opts.language === 'fr' ? ' : ' : ': ';
  const lines = [`Twake Drive${sep}${ACTIONS[req.action][opts.language]}`];
  if (opts.as) lines.push(`${L.as}${sep}${opts.as} (${L.account})`);
  for (const [label, raw] of req.details) {
    if (raw === undefined || raw === '') continue;
    const value = raw.length > MAX_SHOWN ? `${raw.slice(0, MAX_SHOWN)}… (+${raw.length - MAX_SHOWN})` : raw;
    lines.push(value.includes('\n') ? `${L[label]}${sep}\n${value}` : `${L[label]}${sep}${value}`);
  }
  lines.push('', `${L.ref} ${ref} · ${L.footer}`);
  return lines.join('\n');
}

export class Approver {
  constructor(
    private readonly server: Server,
    readonly opts: ApprovalOptions,
  ) {}

  label(key: Label): string {
    return LABELS[this.opts.language][key];
  }

  /** Resolves when the user accepted; throws NotApproved or ApprovalUnavailable otherwise. */
  async confirm(req: ApprovalRequest): Promise<void> {
    if (this.opts.mode === 'client') return;
    if (!this.server.getClientCapabilities()?.elicitation) {
      throw new ApprovalUnavailable(
        'This MCP client cannot ask the user for approval (no elicitation support), so mcp-twake-drive refuses to write. ' +
          'Use a client that supports elicitation, or set TWAKE_DRIVE_APPROVAL=client only if the client itself confirms every write tool with the user.',
      );
    }
    const ref = randomBytes(3).toString('hex');
    let action = 'cancel';
    try {
      const res = await this.server.elicitInput(
        { mode: 'form', message: approvalMessage(req, this.opts, ref), requestedSchema: { type: 'object', properties: {} } },
        { timeout: this.opts.timeoutMs },
      );
      action = res.action;
    } catch {
      action = 'cancel';
    }
    if (action !== 'accept') throw new NotApproved(action === 'decline' ? 'decline' : 'cancel');
  }
}
