import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { InputSchema } from './args.js';
import { CliError } from './errors.js';

/** What `call` writes on stdout and the exit code it ends with; what `tools` writes. */
type Content = CallToolResult['content'][number];

/**
 * What a server sends (an e-mail subject, a description) can carry terminal control sequences: they could rewrite
 * the line above, retitle the window or fill the clipboard. Only new lines and tabs are kept.
 */
export function printable(text: string): string {
  // control characters are what these patterns look for
  /* eslint-disable no-control-regex */
  return text
    // only a terminated OSC goes whole: an unterminated one must not take the text after it (its ESC goes below)
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
  /* eslint-enable no-control-regex */
}

function describeContent(item: Content): string {
  switch (item.type) {
    case 'text':
      return item.text;
    case 'image':
    case 'audio':
      return `[${item.type} ${item.mimeType}, ${Buffer.byteLength(item.data, 'base64')} bytes]`;
    case 'resource': {
      const resource = item.resource as { uri: string; mimeType?: string; text?: string; blob?: string };
      const size = resource.blob !== undefined ? Buffer.byteLength(resource.blob, 'base64') : Buffer.byteLength(resource.text ?? '', 'utf8');
      return `[resource ${resource.uri}${resource.mimeType ? ` ${resource.mimeType}` : ''}, ${size} bytes]`;
    }
    default:
      return `[${(item as { type: string; uri?: string }).type}${(item as { uri?: string }).uri ? ` ${(item as { uri?: string }).uri}` : ''}]`;
  }
}

export function renderResult(result: CallToolResult, json: boolean): string {
  if (json) return `${JSON.stringify(result)}\n`;
  const parts = (result.content ?? []).map((item) => printable(describeContent(item)));
  return parts.length ? `${parts.join('\n\n')}\n` : '';
}

/** 3 wins: a write that was not approved did not happen, whatever the server says about it. */
export function exitCodeFor(result: CallToolResult, declined: boolean): 0 | 1 | 3 {
  if (declined) return 3;
  return result.isError ? 1 : 0;
}

export function toolLine(tool: Tool): string {
  const first = tool.description?.split('\n')[0]?.trim();
  return printable(first ? `${tool.name} — ${first}` : tool.name) + '\n';
}

export function describeTool(tool: Tool): string {
  const schema = tool.inputSchema as InputSchema;
  const required = new Set(schema.required ?? []);
  const lines = Object.entries(schema.properties ?? {}).map(([key, property]) => {
    const type = Array.isArray(property.type)
      ? property.type.join('|')
      : property.type === 'array' && property.items?.type
        ? `array of ${property.items.type}`
        : (property.type ?? 'any');
    return `  ${key} (${type}${required.has(key) ? ', required' : ''})${property.description ? ` — ${property.description}` : ''}`;
  });
  const description = tool.description ? `${tool.description}\n` : '';
  return printable(`${tool.name}\n${description}\n${lines.length ? `Parameters:\n${lines.join('\n')}` : 'No parameters.'}`) + '\n';
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}

export function findTool(tools: Tool[], name: string, command: string): Tool {
  const tool = tools.find((t) => t.name === name);
  if (tool) return tool;
  const closest = tools
    .map((t) => t.name)
    .sort((a, b) => distance(a, name) - distance(b, name) || a.localeCompare(b))
    .slice(0, 3);
  throw new CliError(2, `"${name}" is not a tool of ${command}${closest.length ? ` (closest: ${closest.join(', ')})` : ''}: list them with \`${command} tools\`.`);
}
