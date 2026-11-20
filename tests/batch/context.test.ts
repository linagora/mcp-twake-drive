import { describe, expect, it } from 'vitest';
import { BatchCapture, batchHook, batchMode, runCapture, runPreapproved } from '../../src/batch/context.js';

describe('batchHook', () => {
  it('asks outside a batch', () => {
    expect(batchHook(() => 'text')).toBe('ask');
  });

  it('notes the text and stops the tool in a capture', async () => {
    const writes: string[] = [];
    const r = await runCapture(async () => {
      batchHook(() => 'Create A');
      writes.push('written');
    });
    expect(r).toMatchObject({ message: 'Create A', outcome: 'captured' });
    expect(writes).toEqual([]);
  });

  it('still notes the text when the handler catches the stop', async () => {
    const r = await runCapture(async () => {
      try {
        batchHook(() => 'Create A');
      } catch (error) {
        expect(error).toBeInstanceOf(BatchCapture);
        return 'a tool result';
      }
      return 'written';
    });
    expect(r).toMatchObject({ message: 'Create A', outcome: 'returned' });
  });

  it('says when a handler never asked', async () => {
    expect(await runCapture(async () => 'done')).toEqual({ outcome: 'returned' });
    expect(await runCapture(async () => Promise.reject(new Error('not found')))).toMatchObject({ outcome: 'threw' });
  });

  it('approves a pre-approved call whose text did not change', async () => {
    const r = await runPreapproved('Create A', async () => batchHook(() => 'Create A'));
    expect(r).toEqual({ result: 'approved', approved: true });
  });

  it('asks when the text changed', async () => {
    const r = await runPreapproved('Create A', async () => batchHook(() => 'Create A (moved)'));
    expect(r).toEqual({ result: 'ask', approved: false });
  });

  it('approves only the first request of a pre-approved call', async () => {
    const r = await runPreapproved('Create A', async () => [batchHook(() => 'Create A'), batchHook(() => 'Create A')]);
    expect(r.result).toEqual(['approved', 'ask']);
  });

  it('never approves a later request when the first one asked', async () => {
    const r = await runPreapproved('Create A', async () => [batchHook(() => 'Create A (moved)'), batchHook(() => 'Create A')]);
    expect(r).toEqual({ result: ['ask', 'ask'], approved: false });
  });

  it('tells a gate whether it runs in a batch, so that it computes its text only then', async () => {
    expect(batchMode()).toBeUndefined();
    expect((await runPreapproved('x', async () => batchMode())).result).toBe('preapproved');
    let mode: string | undefined;
    await runCapture(async () => {
      mode = batchMode();
    });
    expect(mode).toBe('capture');
  });
});
