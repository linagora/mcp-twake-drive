import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const bin = fileURLToPath(new URL('../../build/index.js', import.meta.url));
const fake = fileURLToPath(new URL('./fake-server.mjs', import.meta.url));

function run(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string; err: string; ms: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr.on('data', (c: Buffer) => (err += c.toString()));
    child.on('close', (code) => resolve({ code, out, err, ms: Date.now() - started }));
  });
}

describe.skipIf(!existsSync(bin))('the built binary', { timeout: 30_000 }, () => {
  it('runs call and exits on its own after a call', async () => {
    const home = await mkdtemp(join(tmpdir(), 'cli-bin-'));
    const r = await run(['call', 'echo', '--arg', 'text=hi'], { PATH: process.env.PATH, TWAKE_AI_HOME: home, TWAKE_MCP_CLI_SERVER: JSON.stringify([process.execPath, fake]) });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ text: 'hi' });
    expect(r.ms).toBeLessThan(15_000);
  });

  it('still starts the MCP server without a subcommand', async () => {
    // no configuration: the server says what is missing and exits non-zero, as before this change
    const r = await run([], { PATH: process.env.PATH });
    expect(r.code).not.toBe(0);
    expect(r.out).toBe('');
  });
});
