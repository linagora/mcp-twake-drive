// Live test of the prior approval of writes on a REAL Twake Drive. The script answers the approval
// prompts itself: a refusal first (nothing must be written), then accepts for writes it undoes. Works
// in a temporary folder of My Drive, which it destroys at the end. Prints ids, counts and prompts.
//   TWAKE_DRIVE_URL=… TWAKE_DRIVE_TOKEN_COMMAND=… [LIVE_SHARED_DRIVE=<drive_id>] node scripts/live-approval.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const answers = [];
const prompts = [];
const client = new Client({ name: 'live-approval', version: '0' }, { capabilities: { elicitation: { form: {} } } });
client.setRequestHandler(ElicitRequestSchema, async (req) => {
  prompts.push(req.params.message);
  const action = answers.shift() ?? 'decline';
  return action === 'accept' ? { action, content: {} } : { action };
});
await client.connect(
  new StdioClientTransport({ command: process.execPath, args: [new URL('../build/index.js', import.meta.url).pathname], env: { ...process.env, TWAKE_DRIVE_APPROVAL: 'elicit' }, stderr: 'ignore' })
);
const call = async (name, args, answer) => {
  if (answer) answers.push(answer);
  const r = await client.callTool({ name, arguments: args });
  return { isError: Boolean(r.isError), text: r.content[0].text, data: (() => { try { return JSON.parse(r.content[0].text); } catch { return undefined; } })() };
};
const ok = (c, s) => console.log(`${c ? 'ok  ' : 'FAIL'} ${s}`);
const exists = async (path) => !(await call('get_item', { path })).isError;

const folder = `/MCP approval test ${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}`;
let r = await call('create_folder', { path: folder }, 'decline');
ok(/^Not done: the user refused/.test(r.text) && !(await exists(folder)), 'create_folder refused: folder absent');
console.log('--- prompt of the refused folder ---\n' + prompts[0] + '\n---');

r = await call('create_folder', { path: folder }, 'accept');
ok(!r.isError && (await exists(folder)), 'create_folder accepted: folder created');
const folderId = r.data?.id;
r = await call('upload_file', { name: 'note.txt', content: 'live test', parent_path: folder }, 'decline');
ok(/^Not done/.test(r.text) && !(await exists(`${folder}/note.txt`)), 'upload_file refused: file absent');
r = await call('upload_file', { name: 'note.txt', content: 'live test', parent_path: folder }, 'accept');
ok(!r.isError && (await exists(`${folder}/note.txt`)), 'upload_file accepted');
r = await call('update_file_content', { path: `${folder}/note.txt`, content: 'live test v2' }, 'accept');
ok(!r.isError, 'update_file_content accepted');
r = await call('rename_item', { path: `${folder}/note.txt`, new_name: 'note-renamed.txt' }, 'decline');
ok(/^Not done/.test(r.text) && (await exists(`${folder}/note.txt`)), 'rename_item refused: name unchanged');
r = await call('rename_item', { path: `${folder}/note.txt`, new_name: 'note-renamed.txt' }, 'accept');
ok(!r.isError && (await exists(`${folder}/note-renamed.txt`)), 'rename_item accepted');
r = await call('set_tags', { path: `${folder}/note-renamed.txt`, tags: ['mcp-test'] }, 'accept');
ok(!r.isError, 'set_tags accepted');

r = await call('trash_item', { path: folder }, 'decline');
ok(/^Not done/.test(r.text) && (await exists(folder)), 'trash_item refused: folder still there');
r = await call('trash_item', { path: folder }, 'accept');
ok(!r.isError && !(await exists(folder)), 'trash_item accepted: folder in the trash');
r = await call('delete_permanently', { id: folderId }, 'decline');
ok(/^Not done/.test(r.text), 'delete_permanently refused');
r = await call('delete_permanently', { id: folderId }, 'accept');
ok(!r.isError && (await call('get_item', { id: folderId })).isError, 'delete_permanently accepted: folder destroyed');

if (process.env.LIVE_SHARED_DRIVE) {
  const before = prompts.length;
  r = await call('list_folder', { drive_id: process.env.LIVE_SHARED_DRIVE });
  ok(!r.isError && prompts.length === before, `list_folder on the shared drive root (no prompt): ${r.isError ? r.text.slice(0, 120) : `${r.data.count} items, folder ${r.data.folder.id}`}`);
}
ok(new Set(prompts.map((p) => /(?:Ref\.|Réf\.) (\w+)/.exec(p)?.[1])).size === prompts.length, `${prompts.length} prompts, each with its own reference`);
await client.close();
