// A stdio MCP server for the command line's tests (newline-delimited JSON-RPC).
import { createInterface } from 'node:readline';

if (process.env.FAKE_EXIT_AT_START === '1') {
  process.stderr.write('boom: cannot start\n');
  process.exit(1);
}
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const tools = [
  { name: 'echo', description: 'Returns its arguments.\nSecond line.', inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'what to say' }, count: { type: 'integer' }, loud: { type: 'boolean' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['text'] } },
  { name: 'send_note', description: 'Writes a note, after approval.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: 'fail', description: 'Always fails.', inputSchema: { type: 'object', properties: {} } },
  { name: 'hang', description: 'Never answers.', inputSchema: { type: 'object', properties: {} } },
];
let pending;
process.stderr.write('fake tools ready\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    return send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake-tools', version: '1' } } });
  }
  if (message.method === 'tools/list') return send({ jsonrpc: '2.0', id: message.id, result: { tools } });
  if (message.method === 'tools/call') {
    const { name, arguments: args } = message.params;
    if (name === 'echo') return send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(args) }] } });
    if (name === 'fail') return send({ jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: 'it failed' }] } });
    if (name === 'hang') return;
    pending = message.id;
    return send({ jsonrpc: '2.0', id: 'approval-1', method: 'elicitation/create', params: { mode: 'form', message: 'Write the note "' + args.text + '"?', requestedSchema: { type: 'object', properties: {} } } });
  }
  if (message.id === 'approval-1') {
    const done = message.result.action === 'accept';
    return send({ jsonrpc: '2.0', id: pending, result: { isError: !done, content: [{ type: 'text', text: done ? 'note written' : 'Not done: you declined.' }] } });
  }
});
