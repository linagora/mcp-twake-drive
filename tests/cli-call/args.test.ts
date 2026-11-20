import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergeArguments, parseArgPairs, readJsonArgument, type InputSchema } from '../../src/cli-call/args.js';
import { CliError } from '../../src/cli-call/errors.js';

const schema: InputSchema = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    count: { type: 'integer' },
    ratio: { type: 'number' },
    loud: { type: 'boolean' },
    tags: { type: 'array', items: { type: 'string' } },
    sizes: { type: 'array', items: { type: 'integer' } },
    filter: { type: 'object' },
    maybe: { type: ['integer', 'null'] },
  },
};

function usage(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(2);
    return (error as Error).message;
  }
  throw new Error('no error');
}

describe('parseArgPairs', () => {
  it('converts each value to the type the schema gives its key', () => {
    expect(parseArgPairs(['text=hi', 'count=3', 'ratio=0.5', 'loud=true', 'filter={"a":1}', 'maybe=4'], schema)).toEqual({
      text: 'hi',
      count: 3,
      ratio: 0.5,
      loud: true,
      filter: { a: 1 },
      maybe: 4,
    });
  });

  it('keeps "=" inside the value', () => {
    expect(parseArgPairs(['text=a=b'], schema)).toEqual({ text: 'a=b' });
  });

  it('keeps an unknown key as text', () => {
    expect(parseArgPairs(['other=12'], schema)).toEqual({ other: '12' });
  });

  it('adds one item per repeated key of an array, converted to the item type', () => {
    expect(parseArgPairs(['tags=a', 'tags=b', 'sizes=1', 'sizes=2'], schema)).toEqual({ tags: ['a', 'b'], sizes: [1, 2] });
  });

  it('takes a JSON array whole', () => {
    expect(parseArgPairs(['tags=["x","y"]'], schema)).toEqual({ tags: ['x', 'y'] });
  });

  it('lets the last value of a plain key win', () => {
    expect(parseArgPairs(['text=a', 'text=b'], schema)).toEqual({ text: 'b' });
  });

  it('refuses a pair without a key, a bad number, a bad boolean and bad JSON', () => {
    expect(usage(() => parseArgPairs(['=x'], schema))).toContain('key=value');
    expect(usage(() => parseArgPairs(['text'], schema))).toContain('key=value');
    expect(usage(() => parseArgPairs(['count=three'], schema))).toContain('count');
    expect(usage(() => parseArgPairs(['count='], schema))).toContain('count');
    expect(usage(() => parseArgPairs(['loud=yes'], schema))).toContain('true or false');
    expect(usage(() => parseArgPairs(['filter={a'], schema))).toContain('JSON');
  });
});

describe('readJsonArgument', () => {
  const noStdin = async () => {
    throw new Error('stdin read');
  };

  it('reads an object given inline', async () => {
    expect(await readJsonArgument('{"text":"hi"}', noStdin)).toEqual({ text: 'hi' });
  });

  it('reads it from a file after @', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cli-args-'));
    await writeFile(join(dir, 'a.json'), '{"count": 2}');
    expect(await readJsonArgument(`@${join(dir, 'a.json')}`, noStdin)).toEqual({ count: 2 });
  });

  it('reads it from stdin for -', async () => {
    expect(await readJsonArgument('-', async () => '{"loud": false}\n')).toEqual({ loud: false });
  });

  it('refuses what is not a JSON object, and a file that cannot be read', async () => {
    for (const spec of ['[1]', '3', 'null', '{bad']) {
      await expect(readJsonArgument(spec, noStdin)).rejects.toMatchObject({ exitCode: 2 });
    }
    await expect(readJsonArgument('@/nowhere/at/all.json', noStdin)).rejects.toMatchObject({ exitCode: 2 });
  });
});

describe('mergeArguments', () => {
  it('lets --arg replace a key of --json', () => {
    expect(mergeArguments({ text: 'a', count: 1 }, { count: 2 })).toEqual({ text: 'a', count: 2 });
  });
});
