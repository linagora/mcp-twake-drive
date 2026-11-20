import { describe, expect, it } from 'vitest';
import { canonical } from '../../src/batch/canonical.js';
import { BATCH_TTL_MS, BatchStore } from '../../src/batch/store.js';

describe('canonical', () => {
  it('sorts object keys at every depth and keeps arrays in order', () => {
    expect(canonical({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"x":2,"y":1}]},"b":1}');
  });

  it('leaves out undefined values, as JSON does', () => {
    expect(canonical({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it('writes a date as JSON does', () => {
    expect(canonical({ at: new Date(0) })).toBe('{"at":"1970-01-01T00:00:00.000Z"}');
  });

  it('refuses what JSON cannot tell apart: class instances, maps, inherited keys', () => {
    expect(() => canonical({ a: new Map([['x', 1]]) })).toThrow();
    expect(() => canonical(Object.create({ admin: true }))).toThrow();
    expect(() => canonical({ a: Object.setPrototypeOf({ b: 1 }, { c: 2 }) })).toThrow();
  });
});

describe('BatchStore', () => {
  const items = [
    { tool: 'create_event', key: canonical({ title: 'A' }), message: 'Create A' },
    { tool: 'create_event', key: canonical({ title: 'B' }), message: 'Create B' },
  ];

  it('gives a random id and reserves each action once', () => {
    const store = new BatchStore();
    const { batchId } = store.create(items);
    expect(batchId).toMatch(/^[0-9a-f]{32}$/);
    const first = store.reserve(batchId, 'create_event', canonical({ title: 'A' }));
    expect(first).toMatchObject({ message: 'Create A' });
    expect(store.reserve(batchId, 'create_event', canonical({ title: 'A' }))).toBe('absent');
  });

  it('gives an action back when it was not used', () => {
    const store = new BatchStore();
    const { batchId } = store.create(items);
    const item = store.reserve(batchId, 'create_event', canonical({ title: 'B' }));
    if (typeof item === 'string') throw new Error(item);
    store.release(item);
    expect(store.reserve(batchId, 'create_event', canonical({ title: 'B' }))).toMatchObject({ message: 'Create B' });
  });

  it('says why nothing matched', () => {
    const store = new BatchStore();
    const { batchId } = store.create(items);
    expect(store.reserve('0'.repeat(32), 'create_event', canonical({ title: 'A' }))).toBe('unknown');
    expect(store.reserve(batchId, 'delete_event', canonical({ title: 'A' }))).toBe('absent');
    expect(store.reserve(batchId, 'create_event', canonical({ title: 'C' }))).toBe('absent');
  });

  it('forgets a batch after 15 minutes', () => {
    let t = 1_000_000;
    const store = new BatchStore(() => t);
    const { batchId, expiresAt } = store.create(items);
    expect(expiresAt).toBe(1_000_000 + BATCH_TTL_MS);
    t += BATCH_TTL_MS + 1;
    expect(store.reserve(batchId, 'create_event', canonical({ title: 'A' }))).toBe('expired');
  });
});
