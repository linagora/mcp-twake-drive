// Runs the built server as a real process: what vitest cannot see at load, and what reaches stdout.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'mcp-twake-drive-start-'));
const server = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/settings/disk-usage')) return res.end(JSON.stringify({ data: { id: 'u', attributes: { used: '1' } } }));
    if (req.method === 'POST') return res.end(JSON.stringify({ data: { id: 'n', attributes: { type: 'file', name: 'd.docx' } } }));
    return res.end(JSON.stringify({ data: { id: 'io.cozy.files.root-dir', attributes: { type: 'directory', name: '', path: '/' } } }));
  });
}).listen(0, '127.0.0.1');
await new Promise((done) => server.once('listening', done));

let child;
try {
  // A dependency that logs through console.log must never reach stdout, which carries JSON-RPC.
  const noise = join(tmp, 'noise.cjs');
  writeFileSync(noise, "process.on('SIGUSR2', () => console.log('noise on stdout'));\n");
  child = spawn(process.execPath, ['--require', noise, resolve('build/index.js')], {
    cwd: tmp,
    env: { PATH: process.env.PATH, HOME: tmp, TWAKE_DRIVE_URL: `http://127.0.0.1:${server.address().port}`, TWAKE_DRIVE_TOKEN: 't' },
    stdio: ['pipe', 'pipe', 'ignore'],
  });

  const lines = [];
  const waiting = new Map();
  let rest = '';
  child.stdout.on('data', (chunk) => {
    const parts = (rest + chunk).split('\n');
    rest = parts.pop();
    for (const line of parts) {
      lines.push(line);
      const message = JSON.parse(line);
      waiting.get(message.id)?.(message.result);
    }
  });
  let id = 0;
  const request = (method, params) =>
    new Promise((done, fail) => {
      const current = ++id;
      const timer = setTimeout(() => fail(new Error(`no answer to ${method}`)), 15000);
      waiting.set(current, (result) => {
        clearTimeout(timer);
        done(result);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: current, method, params })}\n`);
    });

  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  child.kill('SIGUSR2');
  assert.equal((await request('tools/list', {})).tools.length, 31);
  const call = async (name, args) => {
    const result = await request('tools/call', { name, arguments: args });
    assert.ok(!result.isError, `${name}: ${result.content[0].text}`);
  };
  await call('get_drive_info', {});
  await call('list_folder', {});
  await new Promise((done) => setTimeout(done, 100));
  assert.ok(lines.every((line) => line.startsWith('{')), 'stdout only carries JSON-RPC');
  console.log('start smoke test ok');
} finally {
  child?.kill();
  server.close();
  rmSync(tmp, { recursive: true, force: true });
}
