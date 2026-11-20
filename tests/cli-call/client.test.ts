import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openClient, type OpenClientOptions } from '../../src/cli-call/client.js';

const fake = fileURLToPath(new URL('./fake-server.mjs', import.meta.url));

function options(overrides: Partial<OpenClientOptions> = {}): OpenClientOptions {
  return { command: process.execPath, args: [fake], env: { ...process.env }, name: 'test', version: '0.0.0', timeoutMs: 15_000, onElicit: async () => ({ action: 'decline' }), ...overrides };
}

describe('openClient', { timeout: 20_000 }, () => {
  it('starts the server and lists its tools', async () => {
    const session = await openClient(options());
    try {
      expect(session.tools.map((t) => t.name)).toEqual(['echo', 'send_note', 'fail', 'hang']);
      expect(session.stderr()).toContain('fake tools ready');
    } finally {
      await session.close();
    }
  });

  it('calls a tool and passes approval requests to onElicit', async () => {
    const asked: string[] = [];
    const session = await openClient(options({ onElicit: async (params) => (asked.push(params.message), { action: 'accept', content: {} }) }));
    try {
      expect(await session.call('echo', { text: 'hi' }, 10_000)).toMatchObject({ content: [{ type: 'text', text: '{"text":"hi"}' }] });
      expect(await session.call('send_note', { text: 'x' }, 10_000)).toMatchObject({ content: [{ text: 'note written' }] });
      expect(asked).toEqual(['Write the note "x"?']);
    } finally {
      await session.close();
    }
  });

  it('gives up on a call after its timeout', async () => {
    const session = await openClient(options());
    try {
      await expect(session.call('hang', {}, 500)).rejects.toMatchObject({ exitCode: 4 });
    } finally {
      await session.close();
    }
  });

  it('says why when the server does not start', async () => {
    await expect(openClient(options({ env: { ...process.env, FAKE_EXIT_AT_START: '1' } }))).rejects.toMatchObject({
      exitCode: 4,
      message: expect.stringContaining('boom: cannot start'),
    });
  });
});
