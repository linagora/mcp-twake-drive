import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * What the approval gate does inside a batch. In a capture (approve_batch describing a planned call) it notes the
 * approval text and stops the tool before anything is written; for a call the user approved in a batch it lets the
 * first request through when its text is the one approved. Everywhere else it asks, as before.
 */
export const BATCH_REF = 'batch';

export class BatchCapture extends Error {
  constructor() {
    super('approve_batch is describing this call: nothing is written');
    this.name = 'BatchCapture';
  }
}

type Context = { mode: 'capture'; message?: string } | { mode: 'preapproved'; expected: string; asked: boolean; used: boolean };

const store = new AsyncLocalStorage<Context>();

/** The batch this call runs in, if any: a gate whose text costs reads (an async description) computes it only then. */
export function batchMode(): 'capture' | 'preapproved' | undefined {
  return store.getStore()?.mode;
}

export function batchHook(describe: () => string): 'approved' | 'ask' {
  const context = store.getStore();
  if (!context) return 'ask';
  if (context.mode === 'capture') {
    context.message ??= describe();
    throw new BatchCapture();
  }
  // only the first request of the call can be the approved one, whatever its text
  if (context.asked) return 'ask';
  context.asked = true;
  if (describe() !== context.expected) return 'ask';
  context.used = true;
  return 'approved';
}

export async function runCapture<T>(fn: () => Promise<T>): Promise<{ message?: string; outcome: 'captured' | 'returned' | 'threw'; error?: unknown }> {
  const context: Context = { mode: 'capture' };
  try {
    await store.run(context, fn);
    return context.message === undefined ? { outcome: 'returned' } : { message: context.message, outcome: 'returned' };
  } catch (error) {
    if (error instanceof BatchCapture) return { message: context.message, outcome: 'captured' };
    return context.message === undefined ? { outcome: 'threw', error } : { message: context.message, outcome: 'threw', error };
  }
}

export async function runPreapproved<T>(expected: string, fn: () => Promise<T>): Promise<{ result: T; approved: boolean }> {
  const context: Context = { mode: 'preapproved', expected, asked: false, used: false };
  const result = await store.run(context, fn);
  return { result, approved: context.used };
}
