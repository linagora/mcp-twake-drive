import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { describeTool, exitCodeFor, findTool, renderResult, toolLine } from '../../src/cli-call/output.js';

const echo: Tool = {
  name: 'echo',
  description: 'Returns its arguments.\nSecond line.',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string', description: 'what to say' }, tags: { type: 'array', items: { type: 'string' } }, maybe: { type: ['integer', 'null'] } },
    required: ['text'],
  },
};
const tools: Tool[] = [echo, { name: 'send_note', inputSchema: { type: 'object' } }, { name: 'search_emails', description: 'Search.', inputSchema: { type: 'object' } }];

describe('renderResult', () => {
  it('writes the text contents, a blank line between them', () => {
    const result: CallToolResult = { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] };
    expect(renderResult(result, false)).toBe('a\n\nb\n');
  });

  it('names what is not text, with its type and size', () => {
    const result: CallToolResult = { content: [{ type: 'image', data: Buffer.from('12345').toString('base64'), mimeType: 'image/png' }] };
    expect(renderResult(result, false)).toBe('[image image/png, 5 bytes]\n');
  });

  it('writes nothing for an empty result', () => {
    expect(renderResult({ content: [] }, false)).toBe('');
  });

  it('writes the whole result as one JSON line with --json-output', () => {
    const result: CallToolResult = { content: [{ type: 'text', text: 'a' }], structuredContent: { n: 1 } };
    expect(renderResult(result, true)).toBe(`${JSON.stringify(result)}\n`);
  });
});

describe('exitCodeFor', () => {
  it('is 0, 1 on isError, and 3 when an approval was declined, even with isError', () => {
    expect(exitCodeFor({ content: [] }, false)).toBe(0);
    expect(exitCodeFor({ content: [], isError: true }, false)).toBe(1);
    expect(exitCodeFor({ content: [], isError: true }, true)).toBe(3);
    expect(exitCodeFor({ content: [] }, true)).toBe(3);
  });
});

describe('tool descriptions', () => {
  it('gives one line per tool: its name and the first line of its description', () => {
    expect(toolLine(echo)).toBe('echo — Returns its arguments.\n');
    expect(toolLine(tools[1])).toBe('send_note\n');
  });

  it('describes a tool with its parameters, types and required ones', () => {
    expect(describeTool(echo)).toBe(
      'echo\nReturns its arguments.\nSecond line.\n\nParameters:\n  text (string, required) — what to say\n  tags (array of string)\n  maybe (integer|null)\n',
    );
    expect(describeTool(tools[1])).toBe('send_note\n\nNo parameters.\n');
  });
});

describe('findTool', () => {
  it('finds a tool by its exact name', () => {
    expect(findTool(tools, 'echo', 'mcp-twake-dav')).toBe(echo);
  });

  it('names the closest tools when the name is wrong', () => {
    expect(() => findTool(tools, 'ecko', 'mcp-twake-dav')).toThrow(/"ecko" is not a tool of mcp-twake-dav \(closest: echo, /);
    expect(() => findTool(tools, 'ecko', 'mcp-twake-dav')).toThrow(/mcp-twake-dav tools/);
  });
});

describe('terminal control sequences from a server', () => {
  const evil = 'Subject\u001b]52;c;cGF5bG9hZA==\u0007 \u001b[2K\rApproved\u009b31m';

  it('are never written by the text output, the tool lines or the descriptions', () => {
    for (const written of [
      renderResult({ content: [{ type: 'text', text: evil }] }, false),
      toolLine({ name: 'x', description: evil, inputSchema: { type: 'object' } }),
      describeTool({ name: 'x', description: evil, inputSchema: { type: 'object', properties: { a: { type: 'string', description: evil } } } }),
    ]) {
      expect(written).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
      expect(written).toContain('Subject');
    }
  });

  it('never hide the text after an unterminated sequence', () => {
    expect(renderResult({ content: [{ type: 'text', text: 'Subject A \u001b] trap\nSubject B\nSubject C' }] }, false)).toBe('Subject A ] trap\nSubject B\nSubject C\n');
  });

  it('keep new lines and tabs', () => {
    expect(renderResult({ content: [{ type: 'text', text: 'a\tb\nc' }] }, false)).toBe('a\tb\nc\n');
  });

  it('stay escaped in --json-output', () => {
    expect(renderResult({ content: [{ type: 'text', text: evil }] }, true)).toContain('\\u001b');
  });
});
