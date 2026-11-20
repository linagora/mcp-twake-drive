import { randomBytes } from 'node:crypto';

/** The batches one server instance approved: in memory only, 15 minutes each, every action used once. */
export const BATCH_TTL_MS = 15 * 60_000;

export interface BatchItem {
  tool: string;
  /** canonical(arguments) */
  key: string;
  /** the approval text the user approved, computed with BATCH_REF */
  message: string;
  used: boolean;
}

interface Batch {
  expiresAt: number;
  items: BatchItem[];
}

export class BatchStore {
  private readonly batches = new Map<string, Batch>();

  constructor(private readonly now: () => number = Date.now) {}

  create(items: Omit<BatchItem, 'used'>[]): { batchId: string; expiresAt: number } {
    this.sweep();
    const batchId = randomBytes(16).toString('hex');
    const expiresAt = this.now() + BATCH_TTL_MS;
    this.batches.set(batchId, { expiresAt, items: items.map((item) => ({ ...item, used: false })) });
    return { batchId, expiresAt };
  }

  /** The first unused action of the batch with this tool and these arguments, now marked used. */
  reserve(batchId: string, tool: string, key: string): BatchItem | 'unknown' | 'expired' | 'absent' {
    const batch = this.batches.get(batchId);
    if (!batch) return 'unknown';
    if (this.now() > batch.expiresAt) {
      this.batches.delete(batchId);
      return 'expired';
    }
    const item = batch.items.find((i) => !i.used && i.tool === tool && i.key === key);
    if (!item) return 'absent';
    item.used = true;
    return item;
  }

  /** The action did not go through the batch (its text changed): it stays available. */
  release(item: BatchItem): void {
    item.used = false;
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, batch] of this.batches) if (now > batch.expiresAt) this.batches.delete(id);
  }
}
