// End-to-end tests for src/cli.js, driven as a subprocess against a synthetic
// — but format-valid — Cocos 3.x project written to a temp dir. Self-contained:
// no dependency on any on-disk sample project. Uses node:test (built-in,
// no third-party deps). Run: `npm test` or `node --test test/cli.test.js`.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compressUuid } from '../src/core/uuid.js';
import { scanProject } from '../src/core/scan.js';
import { droppedMetaReport } from '../src/core/analyze.js';
import { makeFsProvider } from '../src/node/fsProvider.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'src', 'cli.js');

// Distinct, valid 32-hex uuids for the fixture.
const U = {
  coin: '11111111-1111-1111-1111-111111111111',
  plist: '22222222-2222-2222-2222-222222222222',
  prefab: '33333333-3333-3333-3333-333333333333',
  scene: '44444444-4444-4444-4444-444444444444',
  script: '55555555-5555-5555-5555-555555555555',
  unused: '66666666-6666-6666-6666-666666666666',
  iconA: '77777777-7777-7777-7777-777777777777',
  iconB: '88888888-8888-8888-8888-888888888888',
  res: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  missing: '99999999-9999-9999-9999-999999999999',
  ghost: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
};
const SCRIPT_TYPE = compressUuid(U.script); // compressed __type__ stored in the prefab

let projectDir; // temp project root (contains assets/)

// Run the CLI with the temp project pre-pended; returns {stdout, stderr, status}.
function cli(...args) {
  const r = spawnSync('node', [CLI, projectDir, ...args], { encoding: 'utf8' });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}
// Run with raw argv (no auto project dir) — for usage/no-arg cases.
function cliRaw(...args) {
  const r = spawnSync('node', [CLI, ...args], { encoding: 'utf8' });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}
const json = (res) => JSON.parse(res.stdout.trim());

before(async () => {
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'coir-test-'));
  const root = path.join(projectDir, 'assets');
  const write = async (rel, body) => {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, typeof body === 'string' ? body : JSON.stringify(body));
  };

  // png with texture + sprite-frame sub-assets
  await write('coin.png', 'PNGDATA');
  await write('coin.png.meta', { importer: 'image', uuid: U.coin, subMetas: {
    '6c48a': { importer: 'texture', uuid: `${U.coin}@6c48a`, name: 'texture' },
    f9941: { importer: 'sprite-frame', uuid: `${U.coin}@f9941`, name: 'spriteFrame' },
  } });

  // plist atlas whose one frame points back at the png (meta-derived atlas->texture edge)
  await write('ui.plist', 'PLIST');
  await write('ui.plist.meta', { importer: 'sprite-atlas', uuid: U.plist, subMetas: {
    f1234: { importer: 'sprite-frame', uuid: `${U.plist}@f1234`, name: 'coin_frame',
      userData: { imageUuidOrDatabaseUri: U.coin } },
  } });

  // custom component script (extends Component → survives pruning)
  await write('ShopCtrl.ts', "import { Component } from 'cc';\nexport class ShopCtrl extends Component {}\n");
  await write('ShopCtrl.ts.meta', { importer: 'typescript', uuid: U.script });

  // prefab: cc.Sprite on node "Shop" references the atlas frame + a dangling uuid;
  // the script component sits on child node "Shop/Icon" (compressed __type__).
  await write('Shop.prefab', [
    { __type__: 'cc.Prefab', _name: 'Shop' },
    { __type__: 'cc.Node', _name: 'Shop', _parent: null, _children: [{ __id__: 2 }], _components: [{ __id__: 3 }] },
    { __type__: 'cc.Node', _name: 'Icon', _parent: { __id__: 1 }, _components: [{ __id__: 4 }] },
    { __type__: 'cc.Sprite', node: { __id__: 1 }, _spriteFrame: { __uuid__: `${U.plist}@f1234` }, _missing: { __uuid__: U.missing }, _ghost: { __uuid__: U.ghost } },
    { __type__: SCRIPT_TYPE, node: { __id__: 2 } },
  ]);
  await write('Shop.prefab.meta', { importer: 'prefab', uuid: U.prefab });

  // scene: a component on node "Game/Manager" references the prefab
  await write('Game.scene', [
    { __type__: 'cc.Scene', _name: 'Game', _children: [{ __id__: 1 }] },
    { __type__: 'cc.Node', _name: 'Manager', _parent: { __id__: 0 }, _components: [{ __id__: 2 }] },
    { __type__: 'GameManager', node: { __id__: 1 }, _myPrefab: { __uuid__: U.prefab } },
  ]);
  await write('Game.scene.meta', { importer: 'scene', uuid: U.scene });

  // a meta whose SOURCE file was deleted (only the stale .meta lingers) but a
  // prefab still references it → dropped from the index, surfaced as a NAMED
  // missing-source orphan ref. (note: no ghost.png written)
  await write('ghost.png.meta', { importer: 'image', uuid: U.ghost });

  // unreferenced asset outside resources/ (→ ⚠ unreferenced)
  await write('unused.png', 'X');
  await write('unused.png.meta', { importer: 'image', uuid: U.unused });

  // unreferenced asset inside resources/ (→ NO ⚠, runtime-loaded by policy)
  await write('resources/dyn.png', 'X');
  await write('resources/dyn.png.meta', { importer: 'image', uuid: U.res });

  // duplicate basename across two dirs (→ ambiguity)
  await write('a/icon.png', 'X');
  await write('a/icon.png.meta', { importer: 'image', uuid: U.iconA });
  await write('b/icon.png', 'X');
  await write('b/icon.png.meta', { importer: 'image', uuid: U.iconB });
});

after(async () => { if (projectDir) await fs.rm(projectDir, { recursive: true, force: true }); });

test('find: substring matches by name', () => {
  const out = cli('find', 'icon').stdout;
  assert.match(out, /a\/icon\.png/);
  assert.match(out, /b\/icon\.png/);
});

test('find --json: structured array with path/type/uuid', () => {
  const items = json(cli('find', 'coin', '--json'));
  const coin = items.find((i) => i.path === 'coin.png');
  assert.ok(coin, 'coin.png present');
  assert.equal(coin.type, 'image');
  assert.equal(coin.uuid, U.coin);
});

test('deps --json: prefab out-edges, orphan, and in-edge', () => {
  const o = json(cli('deps', 'Shop.prefab', '--json'));
  assert.equal(o.node, 'Shop.prefab');
  const frame = o.dependsOn.find((e) => e.path === 'ui.plist');
  assert.ok(frame, 'edge to ui.plist');
  assert.equal(frame.via, 'sprite-frame');
  const scriptEdge = o.dependsOn.find((e) => e.path === 'ShopCtrl.ts');
  assert.ok(scriptEdge, 'edge to ShopCtrl.ts');
  assert.equal(scriptEdge.via, 'script');
  assert.ok(o.orphanRefs.some((r) => r.ref === U.missing), 'dangling uuid surfaced');
  const usedBy = o.usedBy.find((e) => e.path === 'Game.scene');
  assert.ok(usedBy, 'used by Game.scene');
  assert.equal(usedBy.via, 'prefab');
});

test('--where: nodePath, property, frame name, and decompressed component', () => {
  const out = cli('deps', 'Shop.prefab', '--out', '--where').stdout;
  assert.match(out, /Shop\/Icon/);          // script component's node path
  assert.match(out, /ShopCtrl\.ts/);        // compressed __type__ resolved to script
  assert.match(out, /_spriteFrame/);        // property path
  assert.match(out, /"coin_frame"/);        // sub-asset (frame) name
  assert.match(out, /↯/);                   // orphan marker
  assert.ok(out.includes(U.missing), 'orphan uuid shown');
});

test('uses --json: meta-derived in-edge has empty locations', () => {
  const o = json(cli('uses', 'coin.png', '--json'));
  assert.ok(!o.dependsOn, 'uses = in-direction only');
  const e = o.usedBy.find((x) => x.path === 'ui.plist');
  assert.ok(e, 'coin used by ui.plist');
  assert.equal(e.via, 'texture');
  assert.deepEqual(e.locations, []); // atlas->texture is derived from meta, not a node tree
});

test('⚠ unreferenced only outside resources/', () => {
  assert.match(cli('uses', 'unused.png').stdout, /⚠/);
  assert.doesNotMatch(cli('uses', 'dyn.png').stdout, /⚠/); // resources/ → runtime-loaded, not flagged
});

test('closure: transitive bundle of the scene', () => {
  const o = json(cli('closure', 'Game.scene', '--json'));
  assert.equal(o.count, 4); // prefab + plist + script + coin
  assert.deepEqual(
    Object.keys(o.byType).sort(),
    ['atlas', 'image', 'prefab', 'script'],
  );
});

test('exit 2: ambiguous basename prints candidates', () => {
  const r = cli('deps', 'icon.png');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /a\/icon\.png/);
  assert.match(r.stderr, /b\/icon\.png/);
});

test('exit 2: target not found', () => {
  assert.equal(cli('deps', 'zzz.png').status, 2);
});

test('exit 1: usage (no command) and unknown command', () => {
  assert.equal(cliRaw().status, 1);          // no project/command
  assert.equal(cli('frobnicate', 'x').status, 1);
  assert.equal(cli('deps').status, 1);       // command without a target
});

test('resolves a target by uuid and by uuid@sub', () => {
  assert.equal(json(cli('deps', U.prefab, '--json')).node, 'Shop.prefab');
  assert.equal(json(cli('deps', `${U.coin}@f9941`, '--json')).node, 'coin.png');
});

// ---- info: dump one asset's record (sub-assets, degrees, userData) ----------
test('info --json: record with type, degrees and sub-assets', () => {
  const o = json(cli('info', 'coin.png', '--json'));
  assert.equal(o.path, 'coin.png');
  assert.equal(o.type, 'image');
  assert.equal(o.uuid, U.coin);
  assert.equal(o.subAssets.length, 2);
  assert.ok(o.subAssets.some((s) => s.kind === 'sprite-frame' && s.uuid === `${U.coin}@f9941`));
  assert.equal(o.in, 1);  // used by the atlas->texture edge from ui.plist
  assert.equal(typeof o.out, 'number');
});

test('info: text form shows uuid, degree line and sub-assets', () => {
  const out = cli('info', 'coin.png').stdout;
  assert.match(out, /coin\.png \(image\)/);
  assert.ok(out.includes(U.coin));
  assert.match(out, /used-by 1 +depends-on/);
  assert.match(out, /sprite-frame/);
});

test('info: resources flag, and resolves by uuid@sub to the owning asset', () => {
  assert.equal(json(cli('info', 'resources/dyn.png', '--json')).inResources, true);
  assert.equal(json(cli('info', 'unused.png', '--json')).inResources, false);
  assert.equal(json(cli('info', `${U.coin}@6c48a`, '--json')).path, 'coin.png'); // sub → owner
});

// ---- --type filter: prune to branches reaching the chosen type(s) ----------
test('deps --type: keeps the path to a matching type, prunes dead branches', () => {
  // Game.scene → Shop.prefab → ui.plist → coin.png(image); the ShopCtrl.ts
  // (script) branch reaches no image, so it is dropped — but the intermediate
  // prefab + atlas leading to the image stay.
  const out = cli('deps', 'Game.scene', '--depth', '5', '--type', 'image').stdout;
  assert.match(out, /\[type: image\]/);
  assert.match(out, /coin\.png/);          // the matching leaf
  assert.match(out, /Shop\.prefab/);       // intermediate hop kept
  assert.match(out, /ui\.plist/);          // intermediate hop kept
  assert.doesNotMatch(out, /ShopCtrl\.ts/); // dead branch pruned
});

test('deps --json --type: filters direct neighbours, drops untyped orphans', () => {
  const o = json(cli('deps', 'Shop.prefab', '--out', '--type', 'script', '--json'));
  assert.ok(o.dependsOn.length > 0);
  assert.ok(o.dependsOn.every((e) => e.type === 'script'), 'only script neighbours');
  assert.ok(o.dependsOn.some((e) => e.path === 'ShopCtrl.ts'));
  assert.ok(!o.orphanRefs, 'orphans are untyped → omitted when filtering by type');
});

test('closure --type: filters the bundle to the chosen types', () => {
  const o = json(cli('closure', 'Game.scene', '--type', 'image', '--json'));
  assert.equal(o.count, 1);                        // only coin.png of the 4-asset bundle
  assert.deepEqual(Object.keys(o.byType), ['image']);
  assert.deepEqual(o.type, ['image']);
});

test('find --type: combines the name query with a type filter', () => {
  assert.match(cli('find', 'coin', '--type', 'image').stdout, /coin\.png/);
  assert.doesNotMatch(cli('find', 'coin', '--type', 'script').stdout, /coin\.png/);
});

// ---- source-less metas: dropped, but a referenced one is a NAMED orphan -----
test('source-less meta is dropped from the index (not a real asset)', () => {
  // ghost.png.meta exists but ghost.png does not → must not resolve as an asset
  assert.equal(cli('deps', 'ghost.png').status, 2); // not found
  assert.doesNotMatch(cli('find', 'ghost').stdout, /ghost\.png/);
});

test('orphan to a source-less meta is labelled with its known path', () => {
  const o = json(cli('deps', 'Shop.prefab', '--out', '--json'));
  const ghost = o.orphanRefs.find((r) => r.ref === U.ghost);
  assert.ok(ghost, 'ghost surfaced as an orphan ref');
  assert.equal(ghost.missingSource, true);
  assert.equal(ghost.path, 'ghost.png');         // filename recovered from the stale meta
  const unknown = o.orphanRefs.find((r) => r.ref === U.missing);
  assert.equal(unknown.missingSource, false);    // no meta at all → truly unknown uuid
  assert.equal(unknown.path, null);
  // text form prints the path for the known one, the raw uuid for the unknown
  const txt = cli('deps', 'Shop.prefab', '--out').stdout;
  assert.match(txt, /ghost\.png  \(missing source\)/);
  assert.ok(txt.includes(U.missing));
});

test('dropped-meta audit lists source-less metas and flags referenced ones', async () => {
  const scan = await scanProject(makeFsProvider(path.join(projectDir, 'assets')));
  const r = droppedMetaReport(scan);
  const ghost = r.items.find((i) => i.path === 'ghost.png');
  assert.ok(ghost, 'ghost.png appears in the dropped-meta audit');
  assert.equal(ghost.referenced, true);     // Shop.prefab still points at it
  assert.ok(r.referencedCount >= 1);
});
