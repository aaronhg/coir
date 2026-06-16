// Round-trip + depth-shrink + boundary/omitted-usage markers for the URL-hash
// topology snapshot (src/core/topohash.js). Headless — CompressionStream is a
// global in Node 18+, so encode/decode run without a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeTopo, decodeTopo } from '../src/core/topohash.js';
import { buildAdjacency } from '../src/core/graph.js';

// A line graph out from the center n0: n0→n1→…→n6, plus one dependent d1→n0.
// Depth 5 from n0 reaches n1..n5 + d1; n6 (depth 6) is trimmed → n5 is a boundary.
function fixture() {
  const A = (uuid, type) => ({ uuid, path: `p/${uuid}.${type}`, type });
  const assets = ['n0', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'd1'].map((u) => A(u, u === 'n0' ? 'prefab' : 'texture'));
  const edges = [
    { from: 'd1', to: 'n0', kind: 'prefab', locations: [{ nodePath: 'Canvas/Root', component: 'cc.Sprite', property: 'spriteFrame', subName: 'coin' }] },
    { from: 'n0', to: 'n1', kind: 'texture', locations: [{ nodePath: 'Canvas/Btn', component: 'cc.Button', property: 'normalSprite' }] },
    { from: 'n1', to: 'n2', kind: 'texture', locations: [{ nodePath: 'A', component: 'cc.Sprite' }] },
    { from: 'n2', to: 'n3', kind: 'texture', locations: [{ nodePath: 'B', component: 'cc.Sprite' }] }, // dist 2→3, beyond locDepth 2
    { from: 'n3', to: 'n4', kind: 'texture' },
    { from: 'n4', to: 'n5', kind: 'texture' },
    { from: 'n5', to: 'n6', kind: 'texture' },
  ];
  const scan = { assets: new Map(assets.map((a) => [a.uuid, a])), byPath: new Map(), edges };
  scan.adjacency = buildAdjacency(edges);
  return scan;
}

test('encode → decode round-trips the neighbourhood (center, nodes, depth)', async () => {
  const scan = fixture();
  const { blob, depth } = await encodeTopo(scan, 'n0', { title: 'Demo' });
  const p = await decodeTopo(blob);
  assert.equal(p.v, 1);
  assert.equal(p.t, 'Demo');
  assert.equal(depth, 5);
  assert.equal(p.d, 5);
  // n0..n5 + d1 included (7 nodes); n6 (depth 6) trimmed
  const paths = p.n.map((row) => row[0]);
  assert.equal(p.n.length, 7);
  assert.ok(paths.includes('p/n5.texture'));
  assert.ok(!paths.includes('p/n6.texture'));
  // center is the focus
  assert.equal(p.n[p.c][0], 'p/n0.prefab');
});

test('usage detail: included within locDepth, omitted (=1) beyond it', async () => {
  const scan = fixture();
  const p = await decodeTopo((await encodeTopo(scan, 'n0')).blob);
  const idxOf = (path) => p.n.findIndex((r) => r[0] === path);
  const find = (fromP, toP) => p.e.find((r) => r[0] === idxOf(fromP) && r[1] === idxOf(toP));
  // n0→n1 (dist 0→1, within locDepth 2): 4th slot is the usage array, round-tripped
  const near = find('p/n0.texture', 'p/n1.texture') || find('p/n0.prefab', 'p/n1.texture');
  assert.ok(Array.isArray(near[3]), 'near edge keeps usage detail');
  assert.equal(near[3][0][0], 'Canvas/Btn');
  assert.equal(near[3][0][1], 'cc.Button');
  // n2→n3 (dist 2→3, beyond locDepth 2) has usage but it is omitted → flag 1
  const far = find('p/n2.texture', 'p/n3.texture');
  assert.equal(far[3], 1, 'far edge marks usage omitted');
  // n3→n4 has no usage at all → no 4th slot
  const none = find('p/n3.texture', 'p/n4.texture');
  assert.equal(none.length, 3);
});

test('boundary nodes are flagged when real neighbours are trimmed', async () => {
  const scan = fixture();
  const p = await decodeTopo((await encodeTopo(scan, 'n0')).blob);
  const n5 = p.n.find((r) => r[0] === 'p/n5.texture');
  assert.equal(n5[2], 1, 'n5 is a boundary (n6 was trimmed)');
  const n1 = p.n.find((r) => r[0] === 'p/n1.texture');
  assert.equal(n1.length, 2, 'n1 is interior, not a boundary');
});

test('auto-shrink: a tiny cap forces depth down and (last resort) drops usage detail', async () => {
  const scan = fixture();
  const tight = await encodeTopo(scan, 'n0', { cap: 10 }); // impossibly small → depth 1, no usage
  assert.equal(tight.depth, 1);
  assert.equal(tight.droppedLoc, true);
  const p = await decodeTopo(tight.blob);
  assert.ok(p.n.length < 7, 'shrunk to a depth-1 slice');
  assert.ok(!p.e.some((r) => Array.isArray(r[3])), 'no usage arrays after drop');
});
