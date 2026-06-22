// The PARALLEL bundle graph (src/core/bundleGraph.js): synthetic bundle nodes,
// containment edges, and bundle→bundle edges aggregated from cross-bundle asset
// references. Runs the real core over an in-memory FileProvider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanProject } from '../src/core/scan.js';
import { buildBundleGraph, bundleKey, isBundleKey } from '../src/core/bundleGraph.js';
import { bundleDuplication, bundleReport } from '../src/core/analyze.js';
import { evaluateRules } from '../src/core/rules.js';

const memFP = (files) => ({
  listFiles: async () => Object.keys(files),
  readText: async (p) => files[p],
  size: async (p) => Buffer.byteLength(String(files[p] ?? '')),
});
const meta = (o) => JSON.stringify(o);
const U = (n) => `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-${n}${n}${n}${n}-${n}${n}${n}${n}-${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}`;

test('bundle graph: containment + cross-bundle dep edges + degrees', async () => {
  const BG = U('b'); // battle/bg.png uuid
  const files = {
    // bundle 'ui' (priority 1) — a prefab that references an asset in 'battle'
    'ui.meta': meta({ importer: 'directory', uuid: U('a'), userData: { isBundle: true, bundleName: 'ui', priority: 1 } }),
    'ui/panel.prefab': JSON.stringify([{ __type__: 'cc.Prefab' }, { __type__: 'cc.Sprite', _spriteFrame: { __uuid__: BG } }]),
    'ui/panel.prefab.meta': meta({ importer: 'prefab', uuid: U('1') }),
    // bundle 'battle' (priority 2) — the referenced image lives here (cross-bundle)
    'battle.meta': meta({ importer: 'directory', uuid: U('c'), userData: { isBundle: true, bundleName: 'battle', priority: 2 } }),
    'battle/bg.png': 'PNGPNGPNG', 'battle/bg.png.meta': meta({ importer: 'image', uuid: BG }),
    // an unbundled asset → 'main'
    'loose.png': 'PNG', 'loose.png.meta': meta({ importer: 'image', uuid: U('4') }),
  };
  const scan = await scanProject(memFP(files));
  const bg = buildBundleGraph(scan);

  // the cross-bundle reference ui/panel.prefab → battle/bg.png made an edge
  assert.ok(scan.edges.some((e) => e.to === BG), 'the prefab→image asset edge exists');

  // nodes: ui, battle, main — all virtual, keyed 'bundle:<name>'
  const node = (name) => bg.nodes.find((n) => n.path === name);
  assert.ok(node('ui') && node('battle') && node('main'));
  assert.ok(node('ui').virtual && !node('ui').hasSource && node('ui').type === 'bundle');
  assert.equal(node('ui').uuid, bundleKey('ui'));
  assert.ok(isBundleKey(node('ui').uuid));
  assert.equal(node('battle').size, Buffer.byteLength('PNGPNGPNG')); // bundle size = Σ member bytes
  assert.equal(node('ui').memberCount, 1);

  // bundle→bundle dep edge ui → battle (aggregated from the asset ref)
  const dep = bg.depEdges.find((e) => e.from === bundleKey('ui') && e.to === bundleKey('battle'));
  assert.ok(dep, 'ui depends on battle');
  assert.equal(dep.kind, 'bundle-dep');
  // the dep edge carries the contributing asset references (for the UI popup)
  assert.ok(dep.refs.some((r) => r.from === U('1') && r.to === BG), 'refs name the actual prefab→image edge');
  // degrees reflect the dep edge
  assert.equal(node('ui').out, 1);
  assert.equal(node('battle').in, 1);
  assert.equal(node('battle').out, 0);

  // containment: bundle → its members (NOT in scan.edges — parallel graph)
  assert.ok(bg.containEdges.some((e) => e.from === bundleKey('ui') && e.to === U('1') && e.kind === 'contains'));
  assert.ok(bg.containEdges.some((e) => e.from === bundleKey('battle') && e.to === BG));
  assert.ok(!scan.edges.some((e) => e.kind === 'contains'), 'containment never pollutes scan.edges');
});

test('axis D: a shared asset reached by two SAME-priority bundles is duplicated', async () => {
  const SH = U('5'); // shared.png, lives in main
  const files = {
    // two custom bundles at the SAME priority (5), each a prefab → the shared asset
    'a.meta': meta({ importer: 'directory', uuid: U('a'), userData: { isBundle: true, bundleName: 'A', priority: 5 } }),
    'a/pa.prefab': JSON.stringify([{ __type__: 'cc.Prefab' }, { __type__: 'cc.Sprite', _spriteFrame: { __uuid__: SH } }]),
    'a/pa.prefab.meta': meta({ importer: 'prefab', uuid: U('1') }),
    'b.meta': meta({ importer: 'directory', uuid: U('b'), userData: { isBundle: true, bundleName: 'B', priority: 5 } }),
    'b/pb.prefab': JSON.stringify([{ __type__: 'cc.Prefab' }, { __type__: 'cc.Sprite', _spriteFrame: { __uuid__: SH } }]),
    'b/pb.prefab.meta': meta({ importer: 'prefab', uuid: U('2') }),
    'shared.png': '0123456789', 'shared.png.meta': meta({ importer: 'image', uuid: SH }), // in main
  };
  const scan = await scanProject(memFP(files));
  const dup = bundleDuplication(scan);
  const it = dup.items.find((i) => i.path === 'shared.png');
  assert.ok(it, 'shared.png is duplicated');
  assert.equal(it.copies, 2);
  assert.deepEqual(it.bundles, ['A', 'B']);
  assert.equal(it.wasted, Buffer.byteLength('0123456789')); // size × (copies−1)
  assert.equal(dup.totalWasted, it.wasted);
});

test('axis D: DIFFERENT priorities → placed in the top one, no duplication', async () => {
  const SH = U('5');
  const files = {
    'a.meta': meta({ importer: 'directory', uuid: U('a'), userData: { isBundle: true, bundleName: 'A', priority: 9 } }),
    'a/pa.prefab': JSON.stringify([{ __type__: 'cc.Prefab' }, { __type__: 'cc.Sprite', _spriteFrame: { __uuid__: SH } }]),
    'a/pa.prefab.meta': meta({ importer: 'prefab', uuid: U('1') }),
    'b.meta': meta({ importer: 'directory', uuid: U('b'), userData: { isBundle: true, bundleName: 'B', priority: 3 } }),
    'b/pb.prefab': JSON.stringify([{ __type__: 'cc.Prefab' }, { __type__: 'cc.Sprite', _spriteFrame: { __uuid__: SH } }]),
    'b/pb.prefab.meta': meta({ importer: 'prefab', uuid: U('2') }),
    'shared.png': '0123456789', 'shared.png.meta': meta({ importer: 'image', uuid: SH }),
  };
  const dup = bundleDuplication(await scanProject(memFP(files)));
  assert.equal(dup.totalWasted, 0, 'unique top priority → a single home + stubs, no copy');
});

test('bundle graph: a 3-bundle cycle A→B→C→A is detected (cycleGroups); pairwise cycles misses it', async () => {
  const IMGA = U('7'), IMGB = U('8'), IMGC = U('9');
  const pf = (ref) => JSON.stringify([{ __type__: 'cc.Prefab' }, { __type__: 'cc.Sprite', _spriteFrame: { __uuid__: ref } }]);
  const files = {
    'A.meta': meta({ importer: 'directory', uuid: U('a'), userData: { isBundle: true, bundleName: 'A', priority: 1 } }),
    'A/pa.prefab': pf(IMGB), 'A/pa.prefab.meta': meta({ importer: 'prefab', uuid: U('1') }), // A → B
    'A/imga.png': 'A', 'A/imga.png.meta': meta({ importer: 'image', uuid: IMGA }),
    'B.meta': meta({ importer: 'directory', uuid: U('b'), userData: { isBundle: true, bundleName: 'B', priority: 1 } }),
    'B/pb.prefab': pf(IMGC), 'B/pb.prefab.meta': meta({ importer: 'prefab', uuid: U('2') }), // B → C
    'B/imgb.png': 'B', 'B/imgb.png.meta': meta({ importer: 'image', uuid: IMGB }),
    'C.meta': meta({ importer: 'directory', uuid: U('c'), userData: { isBundle: true, bundleName: 'C', priority: 1 } }),
    'C/pc.prefab': pf(IMGA), 'C/pc.prefab.meta': meta({ importer: 'prefab', uuid: U('3') }), // C → A
    'C/imgc.png': 'C', 'C/imgc.png.meta': meta({ importer: 'image', uuid: IMGC }),
  };
  const scan = await scanProject(memFP(files));
  const rep = bundleReport(scan);
  assert.equal(rep.cycleGroups.length, 1, 'one cyclic group');
  assert.deepEqual(rep.cycleGroups[0], ['A', 'B', 'C']);
  assert.deepEqual(rep.cycles, [], 'no mutual A⇄B pair — the old pairwise check would miss this loop entirely');
  const res = evaluateRules(scan, [{ name: 'no-bundle-cycle', level: 'error' }]);
  assert.equal(res.errors, 1);
  assert.ok(/A ⇄ B ⇄ C/.test(res.violations[0].message), res.violations[0] && res.violations[0].message);
});

test('bundle graph: a project with no bundles produces nothing (no lone "main")', async () => {
  const files = {
    'a.png': 'PNG', 'a.png.meta': meta({ importer: 'image', uuid: U('1') }),
    'b.png': 'PNG', 'b.png.meta': meta({ importer: 'image', uuid: U('2') }),
  };
  const scan = await scanProject(memFP(files));
  const bg = buildBundleGraph(scan);
  assert.equal(bg.nodes.length, 0);
  assert.equal(bg.containEdges.length, 0);
  assert.equal(bg.depEdges.length, 0);
});
