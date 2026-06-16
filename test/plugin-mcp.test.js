// Tests that a plugin `commands` entry carrying an `inputSchema` ALSO surfaces as
// an MCP tool (src/mcp/server.js) — one registration, two hosts. Drives the real
// MCP server over JSON-RPC/stdio: the tool shows up in tools/list and runs via
// tools/call, receiving the cached scan + ctx.readText (env 'mcp'), returning
// { data } (not printing — stdout is the protocol channel). Built-ins win on a
// name collision. Run: node --test test/plugin-mcp.test.js
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

async function mk() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'coir-pmcp-'));
  dirs.push(dir);
  await fs.mkdir(path.join(dir, 'assets'), { recursive: true });
  await fs.writeFile(path.join(dir, 'assets', 'coin.png'), 'PNG');
  await fs.writeFile(path.join(dir, 'assets', 'coin.png.meta'), JSON.stringify({ importer: 'image', uuid: 'c0c0c0c0-c0c0-c0c0-c0c0-c0c0c0c0c0c0' }));
  const pluginFile = path.join(dir, 'cmd.plugin.mjs');
  await fs.writeFile(
    pluginFile,
    `export default {
  name: 'hello-mcp-plugin',
  commands: [
    {
      name: 'hello',
      description: 'greet (test mcp tool)',
      inputSchema: { type: 'object', properties: { who: { type: 'string' } } },
      positional: ['who'],
      run(ctx) { return { data: { who: ctx.args.who || null, assets: ctx.scan.assets.size, hasReadText: typeof ctx.readText, env: ctx.env } }; },
    },
    { name: 'find', description: 'SHADOW', inputSchema: { type: 'object' }, run() { return { data: 'SHADOW' }; } },
  ],
};
`
  );
  return { dir, pluginFile };
}

// Spawn `coir mcp -C dir --plugin file`, send JSON-RPC lines, collect by id.
function rpc(dir, pluginFile, requests) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI, 'mcp', '-C', dir, '--plugin', pluginFile], { stdio: ['pipe', 'pipe', 'pipe'] });
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
const dataOf = (resp) => JSON.parse(resp.result.content[0].text);

test('mcp: a plugin command with inputSchema is listed as a tool; built-in not shadowed', async () => {
  const { dir, pluginFile } = await mk();
  const r = await rpc(dir, pluginFile, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ]);
  const tools = r[2].result.tools;
  const hello = tools.find((t) => t.name === 'hello');
  assert.ok(hello, 'plugin tool "hello" should be listed');
  assert.match(hello.description, /test mcp tool/);
  const find = tools.find((t) => t.name === 'find');
  assert.ok(find, 'built-in "find" still present');
  assert.doesNotMatch(find.description, /SHADOW/); // plugin cannot override the built-in
});

test('mcp: the plugin command runs via tools/call (env mcp, scan + readText in ctx)', async () => {
  const { dir, pluginFile } = await mk();
  const r = await rpc(dir, pluginFile, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'hello', arguments: { who: 'aaron' } } },
  ]);
  const d = dataOf(r[2]);
  assert.equal(d.who, 'aaron');
  assert.equal(d.env, 'mcp');
  assert.ok(d.assets >= 1); // scan ran (coin.png asset present)
  assert.equal(d.hasReadText, 'function');
});
