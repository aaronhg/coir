// Unit tests for the plugin context's node/file surface: `ctx.addNode` (virtual
// non-asset nodes) and `ctx.files` (the formal file-list entry). Runs the core
// directly over an in-memory FileProvider — no temp dir, no subprocess.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanProject } from '../src/core/scan.js';
import { unusedReport } from '../src/core/analyze.js';

const memFP = (files) => ({
  listFiles: async () => Object.keys(files),
  readText: async (p) => files[p],
  size: async (p) => Buffer.byteLength(String(files[p] ?? '')),
});

test('plugin ctx.addNode + ctx.files: virtual nodes join the graph, stay out of health reports', async () => {
  const files = {
    'coin.png': 'PNG',
    'coin.png.meta': JSON.stringify({ importer: 'image', uuid: '11111111-1111-1111-1111-111111111111' }),
    'lonely.png': 'PNG',
    'lonely.png.meta': JSON.stringify({ importer: 'image', uuid: '22222222-2222-2222-2222-222222222222' }),
  };
  let sawFiles = 0, hasAddNode = false;
  const plugin = {
    name: 'test-virtual',
    edges(ctx) {
      hasAddNode = typeof ctx.addNode === 'function';                  // #1 ctx.addNode exposed
      sawFiles = Array.isArray(ctx.files) ? ctx.files.length : -1;     // #3 ctx.files exposed
      const coin = [...ctx.assets.values()].find((a) => a.path === 'coin.png');
      const k = ctx.addNode({ path: 'event/UserLogin', type: 'notification' });
      ctx.addEdge(coin.uuid, k, 'emits', null, 'coin emits UserLogin');  // a real asset → a virtual node, with a custom edge label
      ctx.addNode({ path: 'event/Orphan', type: 'notification' });     // 0 referrers — must NOT be flagged unused
    },
  };
  const scan = await scanProject(memFP(files), { plugins: [plugin] });

  assert.equal(hasAddNode, true);
  assert.equal(sawFiles, 4); // coin.png(.meta) + lonely.png(.meta)

  const login = [...scan.assets.values()].find((a) => a.path === 'event/UserLogin');
  assert.ok(login, 'virtual node is in the index');
  assert.equal(login.virtual, true);
  assert.equal(login.hasSource, false);
  assert.equal(login.in, 1); // degree counted from the coin → login edge
  const emit = scan.edges.find((e) => e.to === login.uuid && e.kind === 'emits');
  assert.ok(emit);
  assert.equal(emit.label, 'coin emits UserLogin'); // the plugin's custom edge label survives

  const unused = unusedReport(scan);
  assert.ok(unused.items.some((i) => i.path === 'lonely.png'), 'a real 0-referrer asset IS unused');
  assert.ok(!unused.items.some((i) => i.type === 'notification'), 'virtual nodes are NOT flagged unused');
});
