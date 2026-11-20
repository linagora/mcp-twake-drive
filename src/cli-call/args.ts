import { readFile } from 'node:fs/promises';
import { CliError } from './errors.js';

/** `call`'s --json and --arg options turned into the arguments of a tool, read with the tool's inputSchema. */
export type JsonObject = Record<string, unknown>;

export interface InputSchema {
  type?: string;
  properties?: Record<string, { type?: string | string[]; items?: { type?: string }; description?: string }>;
  required?: string[];
}

const usage = (message: string) => new CliError(2, message);

/** The type the schema gives `key`, `null` set aside (["integer", "null"] is an integer). */
function typeOf(schema: InputSchema, key: string): string | undefined {
  const type = schema.properties?.[key]?.type;
  return Array.isArray(type) ? type.find((t) => t !== 'null') : type;
}

function convert(key: string, raw: string, type: string | undefined): unknown {
  switch (type) {
    case 'number':
    case 'integer': {
      const value = Number(raw);
      if (raw.trim() === '' || !Number.isFinite(value)) throw usage(`--arg ${key}: "${raw}" is not a number.`);
      return value;
    }
    case 'boolean':
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      throw usage(`--arg ${key}: use true or false, not "${raw}".`);
    case 'object':
    case 'array':
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        throw usage(`--arg ${key}: "${raw}" is not valid JSON.`);
      }
    default:
      return raw;
  }
}

/** key=value pairs, each value converted to the type of its key; a repeated key of an array adds one item. */
export function parseArgPairs(pairs: string[], schema: InputSchema): JsonObject {
  const args: JsonObject = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) throw usage(`--arg needs key=value, not "${pair}".`);
    const key = pair.slice(0, eq);
    const raw = pair.slice(eq + 1);
    if (typeOf(schema, key) !== 'array') {
      args[key] = convert(key, raw, typeOf(schema, key));
    } else if (raw.trimStart().startsWith('[')) {
      args[key] = convert(key, raw, 'array');
    } else {
      const previous = Array.isArray(args[key]) ? (args[key] as unknown[]) : [];
      args[key] = [...previous, convert(key, raw, schema.properties?.[key]?.items?.type)];
    }
  }
  return args;
}

/** --json: the object itself, @file to read it from a file, - to read it from stdin. */
export async function readJsonArgument(spec: string, readStdin: () => Promise<string>): Promise<JsonObject> {
  let text: string;
  if (spec === '-') text = await readStdin();
  else if (spec.startsWith('@')) {
    text = await readFile(spec.slice(1), 'utf8').catch((): never => {
      throw usage(`--json ${spec}: the file cannot be read.`);
    });
  } else text = spec;
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw usage('--json: the arguments are not valid JSON.');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw usage('--json takes a JSON object ({…}).');
  return value as JsonObject;
}

/** --arg wins over the same key in --json. */
export function mergeArguments(json: JsonObject, pairs: JsonObject): JsonObject {
  return { ...json, ...pairs };
}
