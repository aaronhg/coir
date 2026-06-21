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
  // a structurally broken prefab (dangling _children #99) for the verify tool.
  await w('Broken.prefab', [
    { __type__: 'cc.Prefab', _name: 'Broken' },
    { __type__: 'cc.Node', _name: 'Root', _parent: null, _children: [{ __id__: 99 }], _components: [], _active: true },
  ]);
  await w('Broken.prefab.meta', { importer: 'prefab', uuid: 'b0b0b0b0-b0b0-b0b0-b0b0-b0b0b0b0b0b0' });
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

test('mcp: analyze tool returns audit sections (stats default + a named section)', async () => {
  const dir = await mk();
  const r = await rpc(dir, [
    call(1, 'analyze', {}),                       // default section = stats
    call(2, 'analyze', { section: 'size' }),
    call(3, 'analyze', { section: 'all' }),
  ]);
  const stats = dataOf(r[1]);
  assert.equal(stats.metaErrors, 0);
  assert.ok(stats.assets >= 2 && stats.edgeKinds);
  assert.ok(dataOf(r[2]).byType.prefab); // size section
  assert.deepEqual(Object.keys(dataOf(r[3])).sort(), ['atlas', 'bundles', 'orphans', 'size', 'stats', 'unused']);
});

test('mcp: check tool evaluates an inline ruleset → { violations, errors, warns }', async () => {
  const dir = await mk();
  const r = await rpc(dir, [
    call(1, 'check', { rules: [{ name: 'max-meta-errors', level: 'error', max: 0 }, { name: 'no-orphans', level: 'warn' }] }),
    call(2, 'check', { rules: [{ name: 'no-such-rule' }] }),
  ]);
  const d = dataOf(r[1]);
  assert.ok(Array.isArray(d.violations) && typeof d.errors === 'number' && typeof d.warns === 'number');
  assert.equal(dataOf(r[2]).configErrors, 1); // unknown rule
});

test('mcp: a bad selector comes back as an isError tool result, not a crash', async () => {
  const dir = await mk();
  const r = await rpc(dir, [
    call(1, 'get', { file: 'Foo.prefab', selector: 'Root/Nope:cc.Label._string' }),
    call(2, 'status', {}),
  ]);
  assert.equal(r[1].result.isError, true);
  assert.match(r[1].result.content[0].text, /no node/);
  assert.equal(dataOf(r[2]).assets, 3); // coin.png + Foo.prefab + Broken.prefab
});

// FINDING-4 fix: some MCP hosts serialize an untyped `value` arg as a JSON STRING
// (false→"false", {obj}→stringified). edit_set must parse a JSON-shaped string back to
// its real type, so the prefab gets a boolean/number/object — not a string.
test('mcp: edit_set parses a JSON-string value back to its type; raw:true keeps a literal string', async () => {
  const dir = await mk();
  const r = await rpc(dir, [
    call(1, 'edit_set', { file: 'Foo.prefab', selector: 'Root:cc.Sprite._enabled', value: 'false' }),               // bool-as-string
    call(2, 'edit_set', { file: 'Foo.prefab', selector: 'Root:cc.Sprite._num', value: '42' }),                      // number-as-string
    call(3, 'edit_set', { file: 'Foo.prefab', selector: 'Root:cc.Sprite._col', value: '{"__type__":"cc.Color","r":255,"g":136,"b":0,"a":255}' }), // object-as-string
    call(4, 'edit_set', { file: 'Foo.prefab', selector: 'Root/Title:cc.Label._string', value: 'true', raw: true }), // literal string "true"
    call(5, 'edit_set', { file: 'Foo.prefab', selector: 'Root/Title:cc.Label._sub', value: 'hello world' }),        // non-JSON string → kept verbatim
  ]);
  for (const i of [1, 2, 3, 4, 5]) assert.equal(r[i].result.isError, undefined, `call ${i} should succeed`);
  const arr = JSON.parse(await fs.readFile(path.join(dir, 'assets', 'Foo.prefab'), 'utf8'));
  assert.strictEqual(arr[3]._enabled, false, '_enabled is boolean false, not the string "false"'); // the FINDING-4 case
  assert.strictEqual(arr[3]._num, 42, 'number parsed from string');
  assert.deepEqual(arr[3]._col, { __type__: 'cc.Color', r: 255, g: 136, b: 0, a: 255 }, 'object parsed from string');
  assert.strictEqual(arr[4]._string, 'true', 'raw:true keeps the literal JSON-shaped string');
  assert.strictEqual(arr[4]._sub, 'hello world', 'a non-JSON string is kept verbatim');
});

test('mcp: edit_set unknown-__type__ guard fires on a parsed object value (parse precedes the guard)', async () => {
  const dir = await mk();
  const r = await rpc(dir, [
    call(1, 'edit_set', { file: 'Foo.prefab', selector: 'Root:cc.Sprite._x', value: '{"__type__":"NotARealClassXyz","v":1}' }),
  ]);
  assert.equal(r[1].result.isError, true);
  assert.match(r[1].result.content[0].text, /unknown __type__/);
});

test('mcp: verify tool — sound prefab valid, broken prefab reports errors', async () => {
  const dir = await mk();
  const r = await rpc(dir, [
    call(1, 'verify', { file: 'Foo.prefab' }),
    call(2, 'verify', { file: 'Broken.prefab' }),
  ]);
  assert.equal(dataOf(r[1]).valid, true);
  const bad = dataOf(r[2]);
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.some((e) => e.code === 'bad-ref' || e.code === 'bad-child'));
});

test('mcp: verify all:true — project-wide structural gate flags the broken prefab', async () => {
  const dir = await mk();
  const r = await rpc(dir, [call(1, 'verify', { all: true })]);
  const d = dataOf(r[1]);
  assert.equal(d.scope, 'all');
  assert.equal(d.valid, false);
  assert.ok(d.failures.some((f) => f.file === 'Broken.prefab'));
});

test('mcp: roundtrip tool — sound prefab invertible; broken prefab skipped (pre-broken), all valid', async () => {
  const dir = await mk();
  const r = await rpc(dir, [
    call(1, 'roundtrip', { file: 'Foo.prefab' }),
    call(2, 'roundtrip', { file: 'Broken.prefab' }),
    call(3, 'roundtrip', { all: true }),
  ]);
  assert.equal(dataOf(r[1]).valid, true);
  assert.equal(dataOf(r[1]).passed, 1);
  const broken = dataOf(r[2]);
  assert.equal(broken.valid, true); // skipped, not failed — plain verify owns it
  assert.equal(broken.unprobed[0].reason, 'pre-broken');
  const all = dataOf(r[3]);
  assert.equal(all.scope, 'all');
  assert.equal(all.failures.length, 0);
  assert.ok(all.unprobed.some((u) => u.file === 'Broken.prefab'));
});

test('mcp: tree values:true inlines node + component raw values', async () => {
  const dir = await mk();
  const r = await rpc(dir, [call(1, 'tree', { file: 'Foo.prefab', values: true })]);
  const t = dataOf(r[1]);
  const root = t.nodes.find((n) => n.name === 'Root');
  assert.equal(root.value.__type__, 'cc.Node');
  assert.equal(root.components.find((c) => c.type === 'cc.Sprite').value.__type__, 'cc.Sprite');
});

test('mcp: edit_batch applies multiple ops atomically; a failing op writes nothing', async () => {
  const dir = await mk();
  const r = await rpc(dir, [
    // good batch: rename + add a node, one write
    call(1, 'edit_batch', { file: 'Foo.prefab', ops: [
      { op: 'rename', selector: 'Root/Title', value: 'Heading' },
      { op: 'add-node', parent: 'Root', name: 'Extra' },
    ] }),
    call(2, 'tree', { file: 'Foo.prefab' }),
    // bad batch: op 1 fails → nothing changes
    call(3, 'edit_batch', { file: 'Foo.prefab', ops: [
      { op: 'rename', selector: 'Root/Heading', value: 'WontStick' },
      { op: 'rename', selector: 'Root/Nope', value: 'X' },
    ] }),
    call(4, 'get', { file: 'Foo.prefab', selector: 'Root/Heading:cc.Label._string' }),
  ]);
  assert.equal(r[1].result.isError, undefined);
  assert.equal(dataOf(r[1]).count, 2);
  const names = dataOf(r[2]).nodes.map((n) => n.name);
  assert.ok(names.includes('Heading') && names.includes('Extra'));
  assert.equal(r[3].result.isError, true);          // bad batch refused
  assert.match(r[3].result.content[0].text, /batch op #1/);
  assert.equal(dataOf(r[4]).value, 'Hi');           // unchanged → atomic (Heading still there, not renamed)
});

test('mcp: edit_batch + diff returns a unified diff; dryRun does not write', async () => {
  const dir = await mk();
  const r = await rpc(dir, [
    call(1, 'edit_batch', { file: 'Foo.prefab', dryRun: true, diff: true, ops: [{ op: 'rename', selector: 'Root/Title', value: 'Z' }] }),
    call(2, 'get', { file: 'Foo.prefab', selector: 'Root/Title:cc.Label._string' }),
  ]);
  assert.equal(dataOf(r[1]).dryRun, true);
  assert.match(dataOf(r[1]).diff, /@@/);
  assert.equal(dataOf(r[2]).value, 'Hi'); // still there (dry-run)
});

// FINDING-3 fix: errors render with exactly one ✗ (engine-seam errors used to double-prefix).
test('mcp: error results carry exactly one ✗ (engine-seam and MCP-layer alike)', async () => {
  const dir = await mk();
  const r = await rpc(dir, [
    call(1, 'edit_set', { file: 'Foo.prefab', selector: 'Root', value: 1 }), // needProp — engine-seam (was ✗ ✗)
    call(2, 'deps', { asset: 'no-such-zzz' }),                               // not found — MCP-layer (single ✗)
  ]);
  for (const i of [1, 2]) {
    const t = r[i].result.content[0].text;
    assert.equal(r[i].result.isError, true);
    assert.ok(t.startsWith('✗ '), `call ${i} should start with one ✗: ${t}`);
    assert.ok(!/^✗\s+✗/.test(t), `call ${i} should not double-prefix ✗: ${t}`);
  }
});
