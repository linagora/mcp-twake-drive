import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CommandTokenProvider } from '../src/token-command.js';

// The command line runs through the system shell: /bin/sh, or cmd.exe on Windows.
// Both read a path in double quotes the same way, even with a space in it.
function broker(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'token broker '));
  const file = join(dir, 'broker.cjs');
  writeFileSync(file, script);
  return `"${process.execPath}" "${file}"`;
}

describe('CommandTokenProvider through the system shell', () => {
  it('runs a quoted command line and passes its arguments', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const p = new CommandTokenProvider(
      `${broker(`process.stdout.write(JSON.stringify({ access_token: process.argv[2], expires_at: ${exp} }))`)} tok`,
    );
    expect(await p.getToken()).toBe('tok');
  });

  it('reports the last line the command wrote on stderr', async () => {
    const p = new CommandTokenProvider(broker(`process.stderr.write('no grant: run login\\n'); process.exit(78);`));
    await expect(p.getToken()).rejects.toThrow(/no grant: run login/);
  });
});
