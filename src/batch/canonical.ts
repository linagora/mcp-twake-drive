/**
 * JSON with object keys sorted at every depth: the same arguments give the same text, whatever their order.
 * Only what JSON writes faithfully is accepted: plain objects, arrays, strings, numbers, booleans, null, and values
 * with toJSON (dates). Anything else (a map, a class instance, an object with inherited keys) throws, so that two
 * different values can never give the same text.
 */
export function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(input: unknown): unknown {
  const value = input !== null && typeof input === 'object' && typeof (input as { toJSON?: unknown }).toJSON === 'function' ? (input as { toJSON(): unknown }).toJSON() : input;
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new TypeError('canonical: not a plain object');
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') throw new TypeError(`canonical: ${typeof value}`);
  return value;
}
