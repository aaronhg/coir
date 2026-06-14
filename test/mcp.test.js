// End-to-end tests for the MCP server (src/mcp/server.js), driven as a real
// subprocess speaking JSON-RPC over stdio against a synthetic temp project.
// Verifies the protocol surface (initialize / tools/list / tools/call) and that
// tool calls route into the SAME shared edit/query logic the CLI uses.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'src', 'cli.js');
const dirs = [];
after(async () => { for (const d of dirs) await fs.rm(d, { recursive: true, force: true }); });

// A fresh synthetic project: Foo.prefab = Root(cc.Sprite) → Title(cc.Label "Hi").
async function mk() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'coir-mcp-'));
  dirs.push(dir);
  const w = async (rel, body) => {
    const abs = path.join(dir, 'assets', rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, typeof body === 'string' ? body : JSON.stringify(body));
  };
  await w('coin.png', 'PNG');
  await w('coin.png.meta', { importer: 'image', uuid: 'c0c0c0c0-c0c0-c0c0-c0c0-c0c0c0c0c0c0' });
  await w('Foo.prefab', [
    { __type__: 'cc.Prefab', _name: 'Foo', data: { __id__: 1 } },
    { __type__: 'cc.Node', _name: 'Root', _parent: null, _children: [{ __id__: 2 }], _components: [{ __id__: 3 }], _active: true },
    { __type__: 'cc.Node', _name: 'Title', _parent: { __id__: 1 }, _children: [], _components: [{ __id__: 4 }], _active: true },
    { __type__: 'cc.Sprite', node: { __id__: 1 }, _enabled: true },
    { __type__: 'cc.Label', node: { __id__: 2 }, _string: 'Hi' },
  ]);
  await w('Foo.prefab.meta', { importer: 'prefab', uuid: 'f0f0f0f0-f0f0-f0f0-f0f0-f0f0f0f0f0f0' });
  return dir;
}

// Spawn the server, send each request as a JSON-RPC line, close stdin, and
// collect the responses keyed by id. The server serialises, so requests in one
// batch run in order (a write then a read sees the write).
function rpc(projectDir, requests) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI, 'mcp', '-C', projectDir], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('close', () => {
      const byId = {};
      for (const line of out.split('\n')) {
        const s = line.trim(); if (!s) continue;
        const m = JSON.parse(s); if (m.id !== undefined) byId[m.id] = m;
      }
      resolve(byId);
    });
    for (const r of requests) child.stdin.write(`${JSON.stringify(r)}\n`);
    child.stdin.end();
  });
}
const call = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const dataOf = (resp) => JSON.parse(resp.result.content[0].text);

test('mcp: initialize + tools/list expose the read/write surface', async () => {
  const dir = await mk();
  const r = await rpc(dir, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ]);
  assert.equal(r[1].result.serverInfo.name, 'coir');
  assert.equal(r[1].result.protocolVersion, '2025-06-18'); // echoes the client's
  assert.ok(r[1].result.capabilities.tools);
  const names = r[2].result.tools.map((t) => t.name);
  for (const n of ['find', 'deps', 'tree', 'get', 'edit_set', 'edit_rm_node']) assert.ok(names.includes(n), `missing ${n}`);
  assert.ok(names.filter((n) => n.startsWith('edit_')).length >= 10); // the write surface
});

test('mcp: read tools (find / tree / get) return shared query data', async () => {
  const dir = await mk();
  const r = await rpc(dir, [
    call(1, 'find', { query: 'Foo' }),
    call(2, 'tree', { file: 'Foo.prefab', with: 'cc.Label' }),
    call(3, 'get', { file: 'Foo.prefab', selector: 'Root/Title:cc.Label._string' }),
  ]);
  assert.equal(dataOf(r[1])[0].path, 'Foo.prefab');
  const tree = dataOf(r[2]);
  assert.equal(tree.nodes[0].path, 'Root/Title');
  assert.equal(tree.nodes[0].components[0].selector, 'Root/Title:cc.Label');
  assert.equal(dataOf(r[3]).value, 'Hi');
});

test('mcp: edit_set — dry-run does not write, real write persists (verified by a follow-up read)', async () => {
  const dir = await mk();
  const r = await rpc(dir, [
    call(1, 'edit_set', { file: 'Foo.prefab', selector: 'Root/Title:cc.Label._string', value: 'X', dryRun: true }),
    call(2, 'get', { file: 'Foo.prefab', selector: 'Root/Title:cc.Label._string' }),
    call(3, 'edit_set', { file: 'Foo.prefab', selector: 'Root/Title:cc.Label._string', value: 'Bye' }),
    call(4, 'get', { file: 'Foo.prefab', selector: 'Root/Title:cc.Label._string' }),
  ]);
  assert.equal(dataOf(r[1]).dryRun, true);
  assert.equal(dataOf(r[2]).value, 'Hi'); // dry-run left it unchanged
  assert.equal(dataOf(r[3]).dryRun, false);
  assert.equal(dataOf(r[4]).value, 'Bye'); // real write is visible to a fresh read
  // and on disk
  const arr = JSON.parse(await fs.readFile(path.join(dir, 'assets', 'Foo.prefab'), 'utf8'));
  assert.equal(arr[4]._string, 'Bye');
});

test('mcp: structural edits route through the seam (rename, then the new selector resolves)', async () => {
  const dir = await mk();
  const r = await rpc(dir, [
    call(1, 'edit_rename', { file: 'Foo.prefab', node: 'Root/Title', name: 'Heading' }),
    call(2, 'get', { file: 'Foo.prefab', selector: 'Root/Heading:cc.Label._string' }),
    call(3, 'edit_add_component', { file: 'Foo.prefab', node: 'Root/Heading', type: 'cc.Widget' }),
    call(4, 'tree', { file: 'Foo.prefab', under: 'Root/Heading' }),
  ]);
  assert.equal(r[1].result.isError, undefined);
  assert.equal(dataOf(r[2]).value, 'Hi'); // same node, new path
  const sub = dataOf(r[4]);
  assert.ok(sub.nodes[0].components.some((c) => c.type === 'cc.Widget')); // component was added
});

test('mcp: a bad selector comes back as an isError tool result, not a crash', async () => {
  const dir = await mk();
  const r = await rpc(dir, [
    call(1, 'get', { file: 'Foo.prefab', selector: 'Root/Nope:cc.Label._string' }),
    call(2, 'status', {}),
  ]);
  assert.equal(r[1].result.isError, true);
  assert.match(r[1].result.content[0].text, /no node/);
  assert.equal(dataOf(r[2]).assets, 2); // coin.png + Foo.prefab
});
