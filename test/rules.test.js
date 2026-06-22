// The declarative rule engine (src/core/rules.js) — pure over a scan (+ optional
// ctx.duplicates). In-memory FileProvider, no subprocess.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanProject } from '../src/core/scan.js';
import { evaluateRules, collectPluginCheckers } from '../src/core/rules.js';
import { findInstanceOverrides } from '../src/edit/editPrefab.js';

const memFP = (files) => ({
  listFiles: async () => Object.keys(files),
  readText: async (p) => files[p],
  size: async (p) => Buffer.byteLength(String(files[p] ?? '')),
});
const meta = (o) => JSON.stringify(o);
const U = (n) => `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-${n}${n}${n}${n}-${n}${n}${n}${n}-${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}`;
const prefab = (refUuid) => JSON.stringify([{ __type__: 'cc.Prefab' }, { __type__: 'cc.Sprite', _spriteFrame: { __uuid__: refUuid } }]);

test('rules: cycle (error) + orphan (warn) + meta-errors (error) + unknown rule (config)', async () => {
  const X = U('7'), Y = U('8');
  const files = {
    // bundle A → B (pa references B/x.png); bundle B → A (pb references A/y.png) ⇒ cycle
    'a.meta': meta({ importer: 'directory', uuid: U('a'), userData: { isBundle: true, bundleName: 'A', priority: 1 } }),
    'a/pa.prefab': prefab(X), 'a/pa.prefab.meta': meta({ importer: 'prefab', uuid: U('1') }),
    'a/y.png': 'Y', 'a/y.png.meta': meta({ importer: 'image', uuid: Y }),
    'b.meta': meta({ importer: 'directory', uuid: U('b'), userData: { isBundle: true, bundleName: 'B', priority: 1 } }),
    'b/pb.prefab': prefab(Y), 'b/pb.prefab.meta': meta({ importer: 'prefab', uuid: U('2') }),
    'b/x.png': 'X', 'b/x.png.meta': meta({ importer: 'image', uuid: X }),
    // an unbundled 0-referrer asset → flagged unused; a malformed meta → metaErrors
    'unused.png': 'U', 'unused.png.meta': meta({ importer: 'image', uuid: U('3') }),
    'bad.png.meta': '{ not valid json',
  };
  const scan = await scanProject(memFP(files));
  assert.ok(scan.metaErrors.length >= 1, 'the malformed meta is recorded');

  const res = evaluateRules(scan, [
    { name: 'no-bundle-cycle', level: 'error' },
    { name: 'no-orphans', level: 'warn' },
    { name: 'max-meta-errors', level: 'error', max: 0 },
    { name: 'no-such-rule' },
  ]);
  assert.ok(res.violations.some((v) => v.rule === 'no-bundle-cycle' && v.level === 'error' && /A ⇄ B|B ⇄ A/.test(v.message)));
  assert.ok(res.violations.some((v) => v.rule === 'no-orphans' && v.level === 'warn' && /unused\.png/.test(v.message)));
  assert.ok(res.violations.some((v) => v.rule === 'max-meta-errors' && v.level === 'error'));
  assert.equal(res.configErrors, 1); // the unknown rule
  assert.ok(res.errors >= 2 && res.warns >= 1);
});

test('rules: no-duplicate-files reads ctx.duplicates (absent → no-op)', async () => {
  const scan = await scanProject(memFP({ 'x.png': 'A', 'x.png.meta': meta({ importer: 'image', uuid: U('1') }) }));
  assert.equal(evaluateRules(scan, [{ name: 'no-duplicate-files', level: 'error' }]).violations.length, 0, 'no ctx → no-op');
  const ctx = { duplicates: { files: [{ canonical: U('1'), redundant: [U('2')], reclaimable: 2048 }], configs: [] } };
  const r = evaluateRules(scan, [{ name: 'no-duplicate-files', level: 'error' }], ctx);
  assert.equal(r.errors, 1);
});

test('rules: max-duplication fires above the byte threshold, passes below', async () => {
  const SH = U('5');
  const files = {
    'a.meta': meta({ importer: 'directory', uuid: U('a'), userData: { isBundle: true, bundleName: 'A', priority: 5 } }),
    'a/pa.prefab': prefab(SH), 'a/pa.prefab.meta': meta({ importer: 'prefab', uuid: U('1') }),
    'b.meta': meta({ importer: 'directory', uuid: U('b'), userData: { isBundle: true, bundleName: 'B', priority: 5 } }),
    'b/pb.prefab': prefab(SH), 'b/pb.prefab.meta': meta({ importer: 'prefab', uuid: U('2') }),
    'shared.png': '0123456789', 'shared.png.meta': meta({ importer: 'image', uuid: SH }),
  };
  const scan = await scanProject(memFP(files));
  assert.equal(evaluateRules(scan, [{ name: 'max-duplication', level: 'error', maxBytes: 0 }]).errors, 1);
  assert.equal(evaluateRules(scan, [{ name: 'max-duplication', level: 'error', maxBytes: 1 << 20 }]).errors, 0);
});

test('rules phase 2: forbid-dep + no-cross-bundle + atlas-min-util', async () => {
  const X = U('7'), Y = U('8'), PL = U('9');
  const files = {
    // cycle A↔B
    'a.meta': meta({ importer: 'directory', uuid: U('a'), userData: { isBundle: true, bundleName: 'A', priority: 1 } }),
    'a/pa.prefab': prefab(X), 'a/pa.prefab.meta': meta({ importer: 'prefab', uuid: U('1') }),
    'a/y.png': 'Y', 'a/y.png.meta': meta({ importer: 'image', uuid: Y }),
    'b.meta': meta({ importer: 'directory', uuid: U('b'), userData: { isBundle: true, bundleName: 'B', priority: 1 } }),
    'b/pb.prefab': prefab(Y), 'b/pb.prefab.meta': meta({ importer: 'prefab', uuid: U('2') }),
    'b/x.png': 'X', 'b/x.png.meta': meta({ importer: 'image', uuid: X }),
    // a half-used atlas (a scene references 1 of its 2 frames → 50%)
    'ui.plist': 'PLIST',
    'ui.plist.meta': meta({ importer: 'sprite-atlas', uuid: PL, subMetas: {
      f1: { importer: 'sprite-frame', uuid: `${PL}@f1`, name: 'a' }, f2: { importer: 'sprite-frame', uuid: `${PL}@f2`, name: 'b' } } }),
    'Main.scene': JSON.stringify([{ __type__: 'cc.Scene' }, { __type__: 'cc.Sprite', _spriteFrame: { __uuid__: `${PL}@f1` } }]),
    'Main.scene.meta': meta({ importer: 'scene', uuid: U('3') }),
  };
  const scan = await scanProject(memFP(files));

  // forbid-dep: an A-bundle asset depending on a B-bundle asset
  const fd = evaluateRules(scan, [{ name: 'forbid-dep', level: 'error', from: { bundle: 'A' }, to: { bundle: 'B' } }]);
  assert.ok(fd.errors >= 1 && fd.violations.some((v) => /pa\.prefab → .*x\.png/.test(v.message)));
  assert.equal(evaluateRules(scan, [{ name: 'forbid-dep', level: 'error' }]).configErrors, 1, 'forbid-dep needs from/to');

  // no-cross-bundle A → B
  assert.ok(evaluateRules(scan, [{ name: 'no-cross-bundle', level: 'error', from: 'A', to: 'B' }]).violations.some((v) => /A → B/.test(v.message)));

  // atlas-min-util: ui.plist is 1/2 used (50%)
  assert.ok(evaluateRules(scan, [{ name: 'atlas-min-util', level: 'warn', min: 0.6 }]).warns >= 1);
  assert.equal(evaluateRules(scan, [{ name: 'atlas-min-util', level: 'warn', min: 0.4 }]).warns, 0);
});

test('rules: forbid-dep regex + negation + transitive', async () => {
  // chain A.prefab → B.prefab → art/c.png (two hops)
  const B = U('5'), C = U('6');
  const scan = await scanProject(memFP({
    'A.prefab': prefab(B), 'A.prefab.meta': meta({ importer: 'prefab', uuid: U('1') }),
    'B.prefab': prefab(C), 'B.prefab.meta': meta({ importer: 'prefab', uuid: B }),
    'art/c.png': 'C', 'art/c.png.meta': meta({ importer: 'image', uuid: C }),
  }));

  // regex: any .prefab → any .png  (direct) → only B→c (A does NOT directly depend on c.png)
  const re = evaluateRules(scan, [{ name: 'forbid-dep', level: 'error', from: { pathRegex: '\\.prefab$' }, to: { pathRegex: '\\.png$' } }]);
  assert.ok(re.violations.some((v) => /B\.prefab → art\/c\.png/.test(v.message)), 'regex matches B→c');
  assert.ok(!re.violations.some((v) => /A\.prefab → art\/c\.png/.test(v.message)), 'direct mode: A has no edge to c.png');

  // negation: a .prefab `from` that is NOT B.prefab → only A qualifies → A→B reported
  const neg = evaluateRules(scan, [{ name: 'forbid-dep', level: 'error', from: { pathRegex: '\\.prefab$', not: { basename: 'B.prefab' } }, to: { basename: 'B.prefab' } }]);
  assert.ok(neg.violations.some((v) => /A\.prefab → B\.prefab/.test(v.message)), 'A→B kept by negation');

  // transitive: A reaches c.png through B (2 hops) — direct mode misses this
  const tr = evaluateRules(scan, [{ name: 'forbid-dep', level: 'error', transitive: true, from: { basename: 'A.prefab' }, to: { basename: 'c.png' } }]);
  assert.equal(tr.errors, 1, 'one transitive violation');
  assert.ok(/A\.prefab ⇒ art\/c\.png/.test(tr.violations[0].message) && /2 hop/.test(tr.violations[0].message), 'reports the 2-hop path');

  // transitive needs BOTH from and to; an invalid regex is a config error
  assert.equal(evaluateRules(scan, [{ name: 'forbid-dep', level: 'error', transitive: true, from: { basename: 'A.prefab' } }]).configErrors, 1);
  assert.equal(evaluateRules(scan, [{ name: 'forbid-dep', level: 'error', from: { pathRegex: '[' }, to: { type: 'image' } }]).configErrors, 1);
});

test('rules phase 3: a plugin contributes a checker', async () => {
  const scan = await scanProject(memFP({ 'x.png': 'A', 'x.png.meta': meta({ importer: 'image', uuid: U('1') }) }));
  const plugin = { name: 'p', rules: [{ name: 'no-png', check: (s) => [...s.assets.values()].filter((a) => a.ext === '.png').map((a) => ({ message: `png: ${a.path}`, asset: a.path })) }] };
  const extra = collectPluginCheckers([plugin]);
  const res = evaluateRules(scan, [{ name: 'no-png', level: 'error' }], {}, extra);
  assert.equal(res.errors, 1);
  assert.ok(res.violations.some((v) => /x\.png/.test(v.message)));
  // without the plugin the same rule is an unknown-rule config error
  assert.equal(evaluateRules(scan, [{ name: 'no-png', level: 'error' }]).configErrors, 1);
});

// ---- no-deep-instance-override (nested-prefab edit policy) -----------------
test('findInstanceOverrides: root vs deep classified by localID == host PrefabInfo.fileId', () => {
  // a prefab with one nested instance carrying a ROOT override + a DEEP override
  const arr = [
    { __type__: 'cc.Prefab', _name: 'P' },                                   // 0
    { __type__: 'cc.Node', _name: 'P', _prefab: { __id__: 2 } },             // 1 own root
    { __type__: 'cc.PrefabInfo', fileId: 'OWN', instance: null },            // 2
    { __type__: 'cc.Node', _name: 'inst', _prefab: { __id__: 4 } },          // 3 instance host
    { __type__: 'cc.PrefabInfo', fileId: 'ROOT', instance: { __id__: 5 } },  // 4 host's PrefabInfo
    { __type__: 'cc.PrefabInstance', propertyOverrides: [{ __id__: 6 }, { __id__: 8 }] }, // 5
    { __type__: 'CCPropertyOverrideInfo', targetInfo: { __id__: 7 }, propertyPath: ['_lpos'], value: 1 }, // 6 ROOT
    { __type__: 'cc.TargetInfo', localID: ['ROOT'] },                        // 7
    { __type__: 'CCPropertyOverrideInfo', targetInfo: { __id__: 9 }, propertyPath: ['_name'], value: 'x' }, // 8 DEEP
    { __type__: 'cc.TargetInfo', localID: ['DEEP'] },                        // 9
  ];
  const ovs = findInstanceOverrides(arr);
  assert.equal(ovs.length, 2);
  const root = ovs.find((o) => o.prop === '_lpos'), deep = ovs.find((o) => o.prop === '_name');
  assert.equal(root.onRoot, true);   // localID ROOT == host fileId
  assert.equal(deep.onRoot, false);  // localID DEEP != host fileId → inside the instance
});

test('no-deep-instance-override: flags deep, allows root, respects files/ignoreProps defaults', () => {
  const scan = { assets: new Map(), edges: [], metaErrors: [] };
  const ctx = { instanceOverrides: [
    { file: 'A.prefab', type: 'prefab', overrides: [
      { instance: 'inst', prop: '_lpos', localID: ['ROOT'], onRoot: true },          // root → allowed
      { instance: 'inst', prop: 'x', localID: ['DEEP'], onRoot: false },             // deep → violation
      { instance: 'inst', prop: 'lightmapSettings', localID: ['D2'], onRoot: false },// deep but engine-baked → ignored by default
    ] },
    { file: 'S.scene', type: 'scene', overrides: [
      { instance: 'i', prop: 'foo', localID: ['D3'], onRoot: false },                // scene → off by default
    ] },
  ] };
  // default: prefab only + ignore baked → only "x"
  let res = evaluateRules(scan, [{ name: 'no-deep-instance-override', level: 'error' }], ctx);
  let v = res.violations.filter((r) => r.rule === 'no-deep-instance-override');
  assert.equal(v.length, 1);
  assert.ok(/"x"/.test(v[0].message));
  // files:all → the scene's "foo" too (lightmapSettings still ignored) = 2
  res = evaluateRules(scan, [{ name: 'no-deep-instance-override', level: 'error', files: 'all' }], ctx);
  assert.equal(res.violations.filter((r) => r.rule === 'no-deep-instance-override').length, 2);
  // ignoreProps:[] (don't skip baked) → x + lightmapSettings = 2 on the prefab
  res = evaluateRules(scan, [{ name: 'no-deep-instance-override', level: 'error', ignoreProps: [] }], ctx);
  assert.equal(res.violations.filter((r) => r.rule === 'no-deep-instance-override').length, 2);
});

// ---- no-editor-preview-leak (saved should_hide_in_hierarchy node) ----------
test('findPreviewCanvasLeaks: flags a saved should_hide_in_hierarchy node', async () => {
  const { findPreviewCanvasLeaks } = await import('../src/edit/editPrefab.js');
  const clean = [{ __type__: 'cc.Prefab' }, { __type__: 'cc.Node', _name: 'Root' }];
  const leaked = [{ __type__: 'cc.Prefab' }, { __type__: 'cc.Node', _name: 'should_hide_in_hierarchy' },
    { __type__: 'cc.Node', _name: 'UICamera_should_hide_in_hierarchy' }];
  assert.deepEqual(findPreviewCanvasLeaks(clean), []);
  assert.equal(findPreviewCanvasLeaks(leaked).length, 2);
});

test('no-editor-preview-leak: a leaked preview canvas → one violation per file', () => {
  const scan = { assets: new Map(), edges: [], metaErrors: [] };
  const ctx = { previewLeaks: [{ file: 'Bad.prefab', nodes: ['should_hide_in_hierarchy'] }] };
  const res = evaluateRules(scan, [{ name: 'no-editor-preview-leak', level: 'error' }], ctx);
  const v = res.violations.filter((r) => r.rule === 'no-editor-preview-leak');
  assert.equal(v.length, 1);
  assert.equal(v[0].asset, 'Bad.prefab');
  assert.equal(res.errors, 1);
  // no ctx → no-op (engine stays pure)
  assert.equal(evaluateRules(scan, [{ name: 'no-editor-preview-leak', level: 'error' }], {}).violations.length, 0);
});
