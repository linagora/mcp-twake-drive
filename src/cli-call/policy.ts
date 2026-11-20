import type { ElicitRequest, ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { printable } from './output.js';

/**
 * Who started `call`, and the answer the command line gives the server's approval requests (spec §2.3):
 * the user in a terminal is approved automatically (asked with --i), an agent is refused (its writes go
 * through its MCP tools, where the user answers), and a command without a terminal is refused unless
 * --yes --as names someone the user allowed.
 */
export type CallContext = 'user' | 'agent' | 'unattended';

/** Environment variables an agent sets in the commands it runs (each one checked on the real agent). */
export const KNOWN_AGENT_MARKERS: readonly string[] = ['CLAUDECODE', 'HERMES_HOME'];

export function detectContext(o: { stdinTTY: boolean; stderrTTY: boolean; env: NodeJS.ProcessEnv; markers: string[] }): { context: CallContext; marker?: string } {
  const marker = [...KNOWN_AGENT_MARKERS, ...o.markers].find((name) => (o.env[name] ?? '') !== '');
  if (marker) return { context: 'agent', marker };
  return { context: o.stdinTTY && o.stderrTTY ? 'user' : 'unattended' };
}

export type Lang = 'en' | 'fr';

export function languageOf(env: NodeJS.ProcessEnv): Lang {
  const value = env.USER_LANGUAGE || env.LC_ALL || env.LC_MESSAGES || env.LANG || '';
  return /^fr/i.test(value) ? 'fr' : 'en';
}

const MESSAGES = {
  en: {
    approvedUser: 'Approved: you typed this command in a terminal (pass --i to be asked first).',
    approvedUnattended: 'Approved by --yes --as {name}.',
    prompt: 'Approve? [y/N] ',
    refusedAgent:
      'Refused: this command was started by an agent ({marker} is set). An agent writes through its MCP tools, which ask you first.',
    refusedUnattended:
      'Refused: there is no terminal to ask you. Run the command in a terminal, or pass --yes --as <name> for a name allowed with `{command} allow-unattended <name>`.',
    unsupported: 'Refused: the server asked a question the command line cannot answer.',
    confirmAllow: 'Let "{name}" write without asking you, whenever a command passes --yes --as {name}? [y/N] ',
  },
  fr: {
    approvedUser: "Approuvé : vous avez tapé cette commande dans un terminal (passez --i pour qu'on vous demande d'abord).",
    approvedUnattended: 'Approuvé par --yes --as {name}.',
    prompt: 'Approuver ? [o/N] ',
    refusedAgent:
      "Refusé : cette commande a été lancée par un agent ({marker} est défini). Un agent écrit par ses outils MCP, qui vous demandent d'abord.",
    refusedUnattended:
      "Refusé : il n'y a pas de terminal pour vous demander. Lancez la commande dans un terminal, ou passez --yes --as <nom> pour un nom autorisé avec `{command} allow-unattended <nom>`.",
    unsupported: 'Refusé : le serveur pose une question à laquelle la ligne de commande ne sait pas répondre.',
    confirmAllow: "Autoriser « {name} » à écrire sans vous demander, chaque fois qu'une commande passe --yes --as {name} ? [o/N] ",
  },
} as const;

export type MessageKey = keyof (typeof MESSAGES)['en'];

export function text(lang: Lang, key: MessageKey, vars: Record<string, string> = {}): string {
  return MESSAGES[lang][key].replace(/\{(\w+)\}/g, (_, name: string) => vars[name] ?? `{${name}}`);
}

export function isYes(answer: string): boolean {
  return ['y', 'yes', 'o', 'oui'].includes(answer.trim().toLowerCase());
}

export interface PolicyOptions {
  context: CallContext;
  marker?: string;
  /** --i */
  interactive: boolean;
  yes: boolean;
  as?: string;
  /** cli.json's allowedUnattended */
  allowed: string[];
  /** stdin is the --json input: it cannot carry an answer too */
  stdinTaken: boolean;
  /** the package name, for the messages */
  command: string;
  ask(question: string): Promise<string>;
  stderr(text: string): void;
  lang: Lang;
}

export interface Approver {
  handle(params: ElicitRequest['params']): Promise<ElicitResult>;
  /** an approval was declined during the call: the exit code is 3 */
  readonly declined: boolean;
}

export function cliApprover(o: PolicyOptions): Approver {
  let declined = false;
  // the approval text comes from the server: no control sequence may disguise it
  const say = (line: string) => o.stderr(`${printable(line)}\n`);
  const accept = (): ElicitResult => ({ action: 'accept', content: {} });
  const decline = (): ElicitResult => {
    declined = true;
    return { action: 'decline' };
  };
  const unattended = (): ElicitResult => {
    if (o.yes && o.as !== undefined && o.allowed.includes(o.as)) {
      say(text(o.lang, 'approvedUnattended', { name: o.as }));
      return accept();
    }
    say(text(o.lang, 'refusedUnattended', { command: o.command }));
    return decline();
  };
  return {
    get declined() {
      return declined;
    },
    async handle(params) {
      const schema = 'requestedSchema' in params ? params.requestedSchema : undefined;
      if (!schema || Object.keys(schema.properties ?? {}).length > 0) {
        say(text(o.lang, 'unsupported'));
        return decline();
      }
      say(params.message);
      if (o.context === 'agent') {
        say(text(o.lang, 'refusedAgent', { marker: o.marker ?? '' }));
        return decline();
      }
      if (o.context === 'unattended') return unattended();
      if (!o.interactive) {
        say(text(o.lang, 'approvedUser'));
        return accept();
      }
      if (o.stdinTaken) return unattended();
      const answer = await o.ask(text(o.lang, 'prompt')).catch(() => '');
      return isYes(answer) ? accept() : decline();
    },
  };
}
