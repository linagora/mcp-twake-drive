import { describe, expect, it } from 'vitest';
import { cliApprover, detectContext, languageOf, type PolicyOptions } from '../../src/cli-call/policy.js';

const approval = { mode: 'form' as const, message: 'Create the event "Lunch"?', requestedSchema: { type: 'object' as const, properties: {} } };

function setup(overrides: Partial<PolicyOptions> = {}) {
  const asked: string[] = [];
  let err = '';
  const approver = cliApprover({
    context: 'user',
    interactive: false,
    yes: false,
    allowed: [],
    stdinTaken: false,
    command: 'mcp-twake-dav',
    ask: async (question) => {
      asked.push(question);
      return 'n';
    },
    stderr: (t) => {
      err += t;
    },
    lang: 'en',
    ...overrides,
  });
  return { approver, asked, err: () => err };
}

describe('detectContext', () => {
  it('is the user in a terminal without agent markers', () => {
    expect(detectContext({ stdinTTY: true, stderrTTY: true, env: {}, markers: [] })).toEqual({ context: 'user' });
  });

  it('is an agent when a known or configured marker is set, terminal or not', () => {
    expect(detectContext({ stdinTTY: true, stderrTTY: true, env: { CLAUDECODE: '1' }, markers: [] })).toEqual({ context: 'agent', marker: 'CLAUDECODE' });
    expect(detectContext({ stdinTTY: false, stderrTTY: false, env: { HERMES_HOME: '/h' }, markers: [] })).toEqual({ context: 'agent', marker: 'HERMES_HOME' });
    expect(detectContext({ stdinTTY: true, stderrTTY: true, env: { MY_AGENT: 'x' }, markers: ['MY_AGENT'] })).toEqual({ context: 'agent', marker: 'MY_AGENT' });
  });

  it('ignores an empty marker', () => {
    expect(detectContext({ stdinTTY: true, stderrTTY: true, env: { CLAUDECODE: '' }, markers: [] })).toEqual({ context: 'user' });
  });

  it('is unattended when stdin or stderr is not a terminal', () => {
    expect(detectContext({ stdinTTY: false, stderrTTY: true, env: {}, markers: [] })).toEqual({ context: 'unattended' });
    expect(detectContext({ stdinTTY: true, stderrTTY: false, env: {}, markers: [] })).toEqual({ context: 'unattended' });
  });
});

describe('languageOf', () => {
  it('follows USER_LANGUAGE, then the locale', () => {
    expect(languageOf({ USER_LANGUAGE: 'fr' })).toBe('fr');
    expect(languageOf({ LANG: 'fr_FR.UTF-8' })).toBe('fr');
    expect(languageOf({ LANG: 'en_US.UTF-8' })).toBe('en');
    expect(languageOf({})).toBe('en');
  });
});

describe('cliApprover', () => {
  it('approves the user automatically, and says so on stderr', async () => {
    const { approver, asked, err } = setup();
    expect(await approver.handle(approval)).toEqual({ action: 'accept', content: {} });
    expect(asked).toEqual([]);
    expect(err()).toContain('Create the event "Lunch"?');
    expect(err()).toContain('--i');
  });

  it('asks the user with --i, and accepts y, yes, o and oui only', async () => {
    for (const [answer, action] of [['y', 'accept'], ['YES', 'accept'], [' o ', 'accept'], ['oui', 'accept'], ['', 'decline'], ['no', 'decline']] as const) {
      const { approver, asked } = setup({ interactive: true, ask: async (q) => (asked.push(q), answer) });
      expect((await approver.handle(approval)).action).toBe(action);
      expect(asked).toEqual(['Approve? [y/N] ']);
      expect(approver.declined).toBe(action === 'decline');
    }
  });

  it('declines when the answer cannot be read', async () => {
    const { approver } = setup({
      interactive: true,
      ask: async () => {
        throw new Error('input closed');
      },
    });
    expect(await approver.handle(approval)).toEqual({ action: 'decline' });
  });

  it('does not ask with --i when stdin carries the arguments: unattended rules', async () => {
    const { approver, asked } = setup({ interactive: true, stdinTaken: true });
    expect(await approver.handle(approval)).toEqual({ action: 'decline' });
    expect(asked).toEqual([]);
  });

  it('refuses an agent, even with --i or --yes, and points to its MCP tools', async () => {
    const { approver, asked, err } = setup({ context: 'agent', marker: 'CLAUDECODE', interactive: true, yes: true, as: 'cron', allowed: ['cron'] });
    expect(await approver.handle(approval)).toEqual({ action: 'decline' });
    expect(asked).toEqual([]);
    expect(err()).toContain('CLAUDECODE');
    expect(err()).toContain('MCP');
  });

  it('refuses without a terminal, and says how to allow a name', async () => {
    const { approver, err } = setup({ context: 'unattended' });
    expect(await approver.handle(approval)).toEqual({ action: 'decline' });
    expect(err()).toContain('mcp-twake-dav allow-unattended');
  });

  it('accepts --yes --as an allowed name without a terminal', async () => {
    const { approver, err } = setup({ context: 'unattended', yes: true, as: 'cron-agenda', allowed: ['cron-agenda'] });
    expect(await approver.handle(approval)).toEqual({ action: 'accept', content: {} });
    expect(err()).toContain('--yes --as cron-agenda');
  });

  it('refuses --yes --as a name that is not allowed, and --yes alone', async () => {
    expect(await setup({ context: 'unattended', yes: true, as: 'other', allowed: ['cron-agenda'] }).approver.handle(approval)).toEqual({ action: 'decline' });
    expect(await setup({ context: 'unattended', yes: true, allowed: ['cron-agenda'] }).approver.handle(approval)).toEqual({ action: 'decline' });
  });

  it('asks in French for a French user', async () => {
    const { approver, asked } = setup({ interactive: true, lang: 'fr', ask: async (q) => (asked.push(q), 'o') });
    await approver.handle(approval);
    expect(asked).toEqual(['Approuver ? [o/N] ']);
  });

  it('declines a question it cannot answer (a form with fields, or a URL)', async () => {
    const { approver, err } = setup();
    const form = { ...approval, requestedSchema: { type: 'object' as const, properties: { reason: { type: 'string' as const } } } };
    expect(await approver.handle(form)).toEqual({ action: 'decline' });
    expect(await approver.handle({ mode: 'url', message: 'Open', url: 'https://x', elicitationId: 'e1' })).toEqual({ action: 'decline' });
    expect(err()).toContain('cannot answer');
  });
});

describe('approval texts from a server', () => {
  it('are written without terminal control sequences', async () => {
    const { approver, err } = setup();
    await approver.handle({ ...approval, message: 'Send "Hi\u001b[2K\rApproved\u001b]0;title\u0007"?' });
    expect(err()).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expect(err()).toContain('Send "Hi');
  });
});
