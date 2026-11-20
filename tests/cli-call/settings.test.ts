import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSettings, settingsPath, writeSettings } from '../../src/cli-call/settings.js';

describe('settingsPath', () => {
  it('is in the home folder of the account, never where an environment variable points', () => {
    expect(settingsPath('linux', '/home/u')).toBe('/home/u/.config/twake-ai/cli.json');
    expect(settingsPath('darwin', '/Users/u')).toBe('/Users/u/.config/twake-ai/cli.json');
    expect(settingsPath('win32', 'C:\\Users\\u')).toBe('C:\\Users\\u\\AppData\\Roaming\\twake-ai\\cli.json');
  });
});

describe('readSettings / writeSettings', () => {
  it('reads an absent file as empty lists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cli-settings-'));
    expect(await readSettings(join(dir, 'cli.json'))).toEqual({ version: 1, allowedUnattended: [], agentMarkers: [] });
  });

  it('writes the file readable by the user only, and reads it back', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cli-settings-'));
    const file = join(dir, 'deep', 'cli.json');
    await writeSettings(file, { version: 1, allowedUnattended: ['cron-agenda'], agentMarkers: ['MY_AGENT'] });
    expect(await readSettings(file)).toEqual({ version: 1, allowedUnattended: ['cron-agenda'], agentMarkers: ['MY_AGENT'] });
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ version: 1 });
  });

  it('refuses a damaged file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cli-settings-'));
    for (const content of ['{bad', '[]', '{"version":2,"allowedUnattended":[],"agentMarkers":[]}', '{"version":1,"allowedUnattended":["Bad Name"],"agentMarkers":[]}', '{"version":1,"allowedUnattended":[],"agentMarkers":["a b"]}']) {
      const file = join(dir, 'cli.json');
      await writeFile(file, content, { mode: 0o600 });
      await chmod(file, 0o600);
      await expect(readSettings(file)).rejects.toMatchObject({ exitCode: 4, message: expect.stringContaining(file) });
    }
  });

  it.skipIf(process.platform === 'win32')('refuses a file other accounts may write', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cli-settings-'));
    const file = join(dir, 'cli.json');
    await writeFile(file, '{"version":1,"allowedUnattended":["cron"],"agentMarkers":[]}', { mode: 0o666 });
    await chmod(file, 0o666);
    await expect(readSettings(file)).rejects.toMatchObject({ exitCode: 4, message: expect.stringContaining('other accounts') });
  });

  it('takes missing lists as empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cli-settings-'));
    const file = join(dir, 'cli.json');
    await writeFile(file, '{"version":1}', { mode: 0o600 });
    await chmod(file, 0o600);
    expect(await readSettings(file)).toEqual({ version: 1, allowedUnattended: [], agentMarkers: [] });
  });
});
