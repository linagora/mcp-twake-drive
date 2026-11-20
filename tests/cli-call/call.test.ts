import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runCliCommand, type CliDeps } from '../../src/cli-call/index.js';
import { settingsPath } from '../../src/cli-call/settings.js';

const fake = fileURLToPath(new URL('./fake-server.mjs', import.meta.url));
const entry = fileURLToPath(new URL('../../src/index.ts', import.meta.url));
const command = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).name as string;

async function cli(argv: string[], overrides: Partial<CliDeps> = {}, env: NodeJS.ProcessEnv = {}) {
  const home = await mkdtemp(join(tmpdir(), 'cli-call-'));
  let out = '';
  let err = '';
  const code = await runCliCommand(
    argv,
    { entry },
    {
      io: { stdout: (t) => void (out += t), stderr: (t) => void (err += t) },
      env: { PATH: process.env.PATH, TWAKE_MCP_CLI_SERVER: JSON.stringify([process.execPath, fake]), ...env },
      platform: process.platform,
      home,
      stdinTTY: false,
      stderrTTY: false,
      ask: async () => 'n',
      readStdin: async () => '',
      ...overrides,
    },
  );
  return { code, out, err, home };
}
const user = { stdinTTY: true, stderrTTY: true };

describe('tools', { timeout: 20_000 }, () => {
  it('lists the tools, one line each, sorted', async () => {
    const r = await cli(['tools']);
    expect(r).toMatchObject({ code: 0, out: 'echo — Returns its arguments.\nfail — Always fails.\nhang — Never answers.\nsend_note — Writes a note, after approval.\n' });
  });

  it('describes one tool, or gives them as JSON', async () => {
    expect((await cli(['tools', 'echo'])).out).toContain('Parameters:\n  text (string, required) — what to say\n');
    expect(JSON.parse((await cli(['tools', '--json-output'])).out).tools).toHaveLength(4);
  });
});

describe('call', { timeout: 20_000 }, () => {
  it('converts --arg with the schema and prints the result', async () => {
    const r = await cli(['call', 'echo', '--arg', 'text=hi', '--arg', 'count=3', '--arg', 'loud=true', '--arg', 'tags=a', '--arg', 'tags=b']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ text: 'hi', count: 3, loud: true, tags: ['a', 'b'] });
  });

  it('takes --json, and --arg replaces its keys', async () => {
    expect(JSON.parse((await cli(['call', 'echo', '--json', '{"text":"x","count":1}', '--arg', 'count=2'])).out)).toEqual({ text: 'x', count: 2 });
  });

  it('keeps stdout for the result only', async () => {
    const r = await cli(['call', 'send_note', '--arg', 'text=x', '--json-output'], user);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ content: [{ text: 'note written' }] });
    expect(r.err).toContain('Write the note "x"?');
  });

  it('exits 1 when the tool fails', async () => {
    expect(await cli(['call', 'fail'])).toMatchObject({ code: 1, out: 'it failed\n' });
  });

  it('approves the user automatically, and asks with --i', async () => {
    expect((await cli(['call', 'send_note', '--arg', 'text=x'], user)).code).toBe(0);
    const asked: string[] = [];
    expect((await cli(['call', 'send_note', '--arg', 'text=x', '--i'], { ...user, ask: async (q) => (asked.push(q), 'n') })).code).toBe(3);
    expect(asked).toEqual(['Approve? [y/N] ']);
  });

  it('refuses an agent with exit 3', async () => {
    const r = await cli(['call', 'send_note', '--arg', 'text=x', '--i'], user, { CLAUDECODE: '1' });
    expect(r.code).toBe(3);
    expect(r.err).toContain('CLAUDECODE');
  });

  it('refuses without a terminal, unless --yes --as an allowed name', async () => {
    const refused = await cli(['call', 'send_note', '--arg', 'text=x']);
    expect(refused.code).toBe(3);
    const allowed = await cli(['allow-unattended', 'cron-x'], { ...user, ask: async () => 'y' });
    expect(allowed.code).toBe(0);
    const same = { home: allowed.home };
    expect((await cli(['call', 'send_note', '--arg', 'text=x', '--yes', '--as', 'cron-x'], same)).code).toBe(0);
    expect((await cli(['call', 'send_note', '--arg', 'text=x', '--yes', '--as', 'other'], same)).code).toBe(3);
  });

  it('allows a name only after a yes typed in a terminal, and revokes anywhere', async () => {
    expect((await cli(['allow-unattended', 'cron-x'], { ask: async () => 'y' })).code).toBe(2);
    const r = await cli(['allow-unattended', 'cron-x'], { ...user, ask: async () => 'n' });
    expect(r.code).toBe(1);
    const ok = await cli(['allow-unattended', 'cron-x'], { ...user, ask: async () => 'y' });
    const file = settingsPath(process.platform, ok.home);
    expect(JSON.parse(await readFile(file, 'utf8')).allowedUnattended).toEqual(['cron-x']);
    expect((await cli(['allow-unattended', 'cron-x', '--revoke'], { home: ok.home })).code).toBe(0);
    expect(JSON.parse(await readFile(file, 'utf8')).allowedUnattended).toEqual([]);
    expect((await cli(['allow-unattended', 'Bad Name'], { ...user, ask: async () => 'y' })).code).toBe(2);
  });

  it('exits 2 for an unknown tool (naming the closest), a bad option or a bad server command', async () => {
    const r = await cli(['call', 'ecko']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('closest: echo');
    expect((await cli(['call', 'echo', '--timeout', 'soon'])).code).toBe(2);
    expect((await cli(['call'])).code).toBe(2);
    expect((await cli(['call', 'echo', '--nope'])).code).toBe(2);
    expect((await cli(['call', 'echo'], {}, { TWAKE_MCP_CLI_SERVER: 'node server.js' })).code).toBe(2);
  });

  it('exits 4 with the server last words when it does not start', async () => {
    const r = await cli(['call', 'echo', '--arg', 'text=x'], {}, { FAKE_EXIT_AT_START: '1' });
    expect(r.code).toBe(4);
    expect(r.err).toContain('boom: cannot start');
    expect(r.err.startsWith(`${command}: `)).toBe(true);
  });

  it('stops a tool that never answers', async () => {
    expect((await cli(['call', 'hang', '--timeout', '1'])).code).toBe(4);
  });

  it('never reads an allowed name from a cli.json an environment variable points to', async () => {
    const elsewhere = await cli(['allow-unattended', 'cron-x'], { ...user, ask: async () => 'y' });
    const r = await cli(['call', 'send_note', '--arg', 'text=x', '--yes', '--as', 'cron-x'], {}, { XDG_CONFIG_HOME: join(elsewhere.home, '.config'), HOME: elsewhere.home });
    expect(r.code).toBe(3);
  });

  it('allows no name when the system gives no home folder for the account', async () => {
    const r = await cli(['allow-unattended', 'cron-x'], { ...user, ask: async () => 'y', home: undefined });
    expect(r.code).toBe(4);
    expect((await cli(['call', 'send_note', '--arg', 'text=x', '--yes', '--as', 'cron-x'], { home: undefined })).code).toBe(3);
  });

  it('does not ask when stdin carries the arguments', async () => {
    const asked: string[] = [];
    const r = await cli(['call', 'send_note', '--json', '-', '--i'], { ...user, ask: async (q) => (asked.push(q), 'y'), readStdin: async () => '{"text":"x"}' });
    expect(r.code).toBe(3);
    expect(asked).toEqual([]);
  });
});
