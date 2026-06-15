// End-to-end tests for src/cli.js, driven as a subprocess against a synthetic
// — but format-valid — Cocos 3.x project written to a temp dir. Self-contained:
// no dependency on any on-disk sample project. Uses node:test (built-in,
// no third-party deps). Run: `npm test` or `node --test test/cli.test.js`.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import fsSync from 'node:fs';
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
  editme: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  editFrom: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
  editTo: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
  editAlt: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
  editNode: '10101010-1010-1010-1010-101010101010',
  editTree: '20202020-2020-2020-2020-202020202020',
  editXref: '30303030-3030-3030-3030-303030303030',
  allShared: '40404040-4040-4040-4040-404040404040',
  allOther: '50505050-5050-5050-5050-505050505050',
  allLonely: '60606060-6060-6060-6060-606060606060',
  aInst: '70707070-7070-7070-7070-707070707070',
  spriteConfig: 'a1a1a1a1-b2b2-c3c3-d4d4-e5e5e5e5e5e5',
  treeDup: '12121212-1212-1212-1212-121212121212',
  xv35: '35353535-3535-3535-3535-353535353535',
  xv38: '38383838-3838-3838-3838-383838383838',
};
const SCRIPT_TYPE = compressUuid(U.script); // compressed __type__ stored in the prefab
const CFG_TYPE = compressUuid(U.spriteConfig); // a custom serializable's compressed __type__

let projectDir; // temp project root (contains assets/)

// Run the CLI against the temp project (via -C); returns {stdout, stderr, status}.
function cli(...args) {
  const r = spawnSync('node', [CLI, '-C', projectDir, ...args], { encoding: 'utf8' });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}
// Run with raw argv (no auto project dir) — for usage/no-arg cases.
function cliRaw(...args) {
  const r = spawnSync('node', [CLI, ...args], { encoding: 'utf8' });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}
const json = (res) => JSON.parse(res.stdout.trim());
// Synchronous read of an asset file (edit tests check on-disk content directly).
const readAsset = (rel) => fsSync.readFileSync(path.join(projectDir, 'assets', rel), 'utf8');
const parseAsset = (rel) => JSON.parse(readAsset(rel));
// Every {__id__} must point in-range at an entry that has a __type__ (mirrors validate_scene).
function refIntegrity(arr) {
  const issues = [];
  (function walk(v, p) {
    if (Array.isArray(v)) { v.forEach((el, i) => walk(el, `${p}[${i}]`)); return; }
    if (v && typeof v === 'object') {
      if (typeof v.__id__ === 'number') {
        if (v.__id__ < 0 || v.__id__ >= arr.length) issues.push(`${p}: __id__ ${v.__id__} out of range`);
        else if (!arr[v.__id__] || !arr[v.__id__].__type__) issues.push(`${p}: __id__ ${v.__id__} → no __type__`);
      }
      for (const k of Object.keys(v)) if (k !== '__id__') walk(v[k], `${p}.${k}`);
    }
  })(arr, '');
  return issues;
}
const typesIn = (arr, t) => arr.filter((o) => o && o.__type__ === t);
const nodeNamed = (arr, name) => arr.find((o) => o && o.__type__ === 'cc.Node' && o._name === name);

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

  // Dedicated, isolated fixtures for the `edit` tests — three images nothing
  // else references or asserts on, plus a prefab pointing at `from` twice. This
  // keeps swap-uuid mutations from perturbing the read-only fixtures' degrees.
  await write('edit/from.png', 'X');
  await write('edit/from.png.meta', { importer: 'image', uuid: U.editFrom });
  await write('edit/to.png', 'X');
  await write('edit/to.png.meta', { importer: 'image', uuid: U.editTo });
  await write('edit/alt.png', 'X');
  await write('edit/alt.png.meta', { importer: 'image', uuid: U.editAlt });
  await write('EditMe.prefab', [
    { __type__: 'cc.Prefab', _name: 'EditMe' },
    { __type__: 'cc.Node', _name: 'EditMe', _parent: null, _components: [{ __id__: 2 }] },
    { __type__: 'cc.Sprite', node: { __id__: 1 }, _spriteFrame: { __uuid__: U.editFrom }, _extra: { __uuid__: U.editFrom } },
  ]);
  await write('EditMe.prefab.meta', { importer: 'prefab', uuid: U.editme });

  // richer prefab for the P1 (selector + set / node-op) tests:
  //   [1] Root  (cc.Sprite @3)   [2] Root/Title (cc.Label @4)
  await write('EditNode.prefab', [
    { __type__: 'cc.Prefab', _name: 'EditNode' },
    { __type__: 'cc.Node', _name: 'Root', _parent: null, _children: [{ __id__: 2 }, { __id__: 5 }, { __id__: 6 }, { __id__: 7 }], _components: [{ __id__: 3 }],
      _active: true, _layer: 33554432, _lpos: { __type__: 'cc.Vec3', x: 0, y: 0, z: 0 }, _lscale: { __type__: 'cc.Vec3', x: 1, y: 1, z: 1 },
      _euler: { __type__: 'cc.Vec3', x: 0, y: 0, z: 0 }, _lrot: { __type__: 'cc.Quat', x: 0, y: 0, z: 0, w: 1 } },
    { __type__: 'cc.Node', _name: 'Title', _parent: { __id__: 1 }, _children: [], _components: [{ __id__: 4 }], _active: true },
    { __type__: 'cc.Sprite', node: { __id__: 1 }, _spriteFrame: { __uuid__: U.editFrom }, _clickish: [{ h: 'old0' }, { h: 'old1' }] },
    { __type__: 'cc.Label', node: { __id__: 2 }, _string: 'Hi', _color: { __type__: 'cc.Color', r: 255, g: 255, b: 255, a: 255 } },
    { __type__: 'cc.Node', _name: 'Box', _parent: { __id__: 1 }, _children: [], _components: [] },
    { __type__: 'cc.Node', _name: 'Drag', _parent: { __id__: 1 }, _children: [], _components: [] },
    { __type__: 'cc.Node', _name: 'Weird[0]', _parent: { __id__: 1 }, _children: [], _components: [], _active: true }, // literal bracket name (#5)
  ]);
  await write('EditNode.prefab.meta', { importer: 'prefab', uuid: U.editNode });

  // a REALISTIC prefab (with PrefabInfo + CompPrefabInfo) for the P2 structural
  // tests — so template-by-example has skeletons to clone and rm has the full
  // owned-entry closure to compact.
  //  [1] Root(sprite@3, pi@4) → [2] Child(label@5, pi@6); comp infos @7,@8
  await write('EditTree.prefab', [
    { __type__: 'cc.Prefab', _name: 'EditTree', data: { __id__: 1 } },
    { __type__: 'cc.Node', _name: 'Root', _parent: null, _children: [{ __id__: 2 }], _components: [{ __id__: 3 }], _prefab: { __id__: 4 }, _active: true, __editorExtras__: {}, _mobility: 0, _id: 'rootxxxxxxxxxxxxxxxxxx' },
    { __type__: 'cc.Node', _name: 'Child', _parent: { __id__: 1 }, _children: [], _components: [{ __id__: 5 }], _prefab: { __id__: 6 }, _active: true, __editorExtras__: {}, _mobility: 0, _id: 'childxxxxxxxxxxxxxxxxx' },
    { __type__: 'cc.Sprite', node: { __id__: 1 }, _enabled: true, __prefab: { __id__: 7 }, _spriteFrame: { __uuid__: U.editFrom }, _id: 'sprxxxxxxxxxxxxxxxxxxx' },
    { __type__: 'cc.PrefabInfo', root: { __id__: 1 }, asset: { __id__: 0 }, fileId: 'rootFidxxxxxxxxxxxxxxx', instance: null, targetOverrides: null, nestedPrefabInstanceRoots: [{ __id__: 1 }] },
    { __type__: 'cc.Label', node: { __id__: 2 }, _enabled: true, __prefab: { __id__: 8 }, _string: 'Hi', _id: 'lblxxxxxxxxxxxxxxxxxxx' },
    { __type__: 'cc.PrefabInfo', root: { __id__: 1 }, asset: { __id__: 0 }, fileId: 'childFidxxxxxxxxxxxxxx', instance: null, targetOverrides: null, nestedPrefabInstanceRoots: null },
    { __type__: 'cc.CompPrefabInfo', fileId: 'sprFidxxxxxxxxxxxxxxxx' },
    { __type__: 'cc.CompPrefabInfo', fileId: 'lblFidxxxxxxxxxxxxxxxx' },
  ]);
  await write('EditTree.prefab.meta', { importer: 'prefab', uuid: U.editTree });

  // prefab where a SURVIVING component cross-references a node that gets deleted
  // (MyComp._ref → B). rm-node B must null that ref, not leave it dangling.
  await write('EditXref.prefab', [
    { __type__: 'cc.Prefab', _name: 'EditXref', data: { __id__: 1 } },
    { __type__: 'cc.Node', _name: 'Root', _parent: null, _children: [{ __id__: 2 }, { __id__: 3 }], _components: [{ __id__: 4 }], _prefab: null, _active: true },
    { __type__: 'cc.Node', _name: 'A', _parent: { __id__: 1 }, _children: [], _components: [], _prefab: null, _active: true },
    { __type__: 'cc.Node', _name: 'B', _parent: { __id__: 1 }, _children: [], _components: [], _prefab: null, _active: true },
    { __type__: 'cc.MyComp', node: { __id__: 1 }, _enabled: true, __prefab: null, _ref: { __id__: 3 } },
  ]);
  await write('EditXref.prefab.meta', { importer: 'prefab', uuid: U.editXref });

  // `--all` (project-wide swap) fixtures: one shared asset referenced by two
  // prefabs + a scene; plus a lonely asset nothing references.
  for (const [name, uuid] of [['all/shared.png', U.allShared], ['all/other.png', U.allOther], ['all/lonely.png', U.allLonely]]) {
    await write(name, 'X'); await write(`${name}.meta`, { importer: 'image', uuid });
  }
  await write('AllA.prefab', [
    { __type__: 'cc.Prefab', _name: 'AllA' },
    { __type__: 'cc.Node', _name: 'A', _parent: null, _components: [{ __id__: 2 }] },
    { __type__: 'cc.Sprite', node: { __id__: 1 }, _a: { __uuid__: U.allShared }, _b: { __uuid__: U.allShared } },
  ]);
  await write('AllA.prefab.meta', { importer: 'prefab', uuid: '41414141-4141-4141-4141-414141414141' });
  await write('AllB.prefab', [
    { __type__: 'cc.Prefab', _name: 'AllB' },
    { __type__: 'cc.Node', _name: 'B', _parent: null, _components: [{ __id__: 2 }] },
    { __type__: 'cc.Sprite', node: { __id__: 1 }, _a: { __uuid__: U.allShared } },
  ]);
  await write('AllB.prefab.meta', { importer: 'prefab', uuid: '42424242-4242-4242-4242-424242424242' });
  await write('AllScene.scene', [
    { __type__: 'cc.Scene', _name: 'AllScene', _children: [{ __id__: 1 }] },
    { __type__: 'cc.Node', _name: 'N', _parent: { __id__: 0 }, _components: [{ __id__: 2 }] },
    { __type__: 'cc.Sprite', node: { __id__: 1 }, _a: { __uuid__: U.allShared } },
  ]);
  await write('AllScene.scene.meta', { importer: 'scene', uuid: '43434343-4343-4343-4343-434343434343' });

  // a prefab A containing a NESTED prefab instance (BInst, under an A-own Holder):
  // A-own nodes editable; the instance — and any subtree containing it — refused.
  await write('AInst.prefab', [
    { __type__: 'cc.Prefab', _name: 'AInst', data: { __id__: 1 } },
    { __type__: 'cc.Node', _name: 'Root', _parent: null, _children: [{ __id__: 2 }], _components: [{ __id__: 4 }], _prefab: { __id__: 5 }, _active: true },
    { __type__: 'cc.Node', _name: 'Holder', _parent: { __id__: 1 }, _children: [{ __id__: 3 }], _components: [], _prefab: { __id__: 6 }, _active: true },
    { __type__: 'cc.Node', _name: 'BInst', _parent: { __id__: 2 }, _children: [], _components: [], _prefab: { __id__: 7 }, _active: true },
    { __type__: 'cc.Label', node: { __id__: 1 }, _enabled: true, __prefab: null, _string: 'A' },
    { __type__: 'cc.PrefabInfo', root: { __id__: 1 }, asset: { __id__: 0 }, fileId: 'aRootxxxxxxxxxxxxxxxxx', instance: null },
    { __type__: 'cc.PrefabInfo', root: { __id__: 1 }, fileId: 'holdrxxxxxxxxxxxxxxxxx', instance: null },
    { __type__: 'cc.PrefabInfo', root: { __id__: 3 }, fileId: 'bInstxxxxxxxxxxxxxxxxx', instance: { __id__: 8 } },
    { __type__: 'cc.PrefabInstance', fileId: 'pinstxxxxxxxxxxxxxxxxx', mountedChildren: [], propertyOverrides: [] },
  ]);
  await write('AInst.prefab.meta', { importer: 'prefab', uuid: U.aInst });

  // a prefab whose Button owns two cc.ClickEvent ENTRIES (separate array items) —
  // rm must collect them too (ownedClosure), not leave orphans.
  await write('EditBtn.prefab', [
    { __type__: 'cc.Prefab', _name: 'EditBtn', data: { __id__: 1 } },
    { __type__: 'cc.Node', _name: 'Root', _parent: null, _children: [{ __id__: 2 }] },
    { __type__: 'cc.Node', _name: 'Panel', _parent: { __id__: 1 }, _children: [], _components: [{ __id__: 3 }] },
    { __type__: 'cc.Button', node: { __id__: 2 }, _enabled: true, __prefab: null, clickEvents: [{ __id__: 4 }, { __id__: 5 }] },
    { __type__: 'cc.ClickEvent', target: { __id__: 1 }, component: 'X', handler: 'a' },
    { __type__: 'cc.ClickEvent', target: { __id__: 1 }, component: 'X', handler: 'b' },
  ]);
  await write('EditBtn.prefab.meta', { importer: 'prefab', uuid: '80808080-8080-8080-8080-808080808080' });

  // a prefab whose source is valid JSON but NOT an array (loadDoc rejects it) —
  // --all must skip it WITH a warning, never silently.
  await write('BadShape.prefab', { __type__: 'cc.Prefab', note: 'not an array' });
  await write('BadShape.prefab.meta', { importer: 'prefab', uuid: '90909090-9090-9090-9090-909090909090' });

  // a custom serializable (SpriteConfig) used as a PROPERTY VALUE — for the --json
  // flag (class-name __type__ → compressed token). Referenced as a __type__ here
  // so the script survives component-script pruning and resolves by class name.
  await write('SpriteConfig.ts', 'export class SpriteConfig { frameName = ""; keys = []; }\n');
  await write('SpriteConfig.ts.meta', { importer: 'typescript', uuid: U.spriteConfig });
  await write('CfgEdit.prefab', [
    { __type__: 'cc.Prefab', _name: 'CfgEdit', data: { __id__: 1 } },
    { __type__: 'cc.Node', _name: 'Root', _parent: null, _components: [{ __id__: 2 }] },
    { __type__: 'cc.Sprite', node: { __id__: 1 }, _enabled: true, _cfg: { __type__: CFG_TYPE, frameName: 'old', keys: ['a'] } },
  ]);
  await write('CfgEdit.prefab.meta', { importer: 'prefab', uuid: 'b1b1b1b1-1111-2222-3333-444444444444' });

  // structure-discovery fixture for `tree`: two same-name sibling nodes ("Slot")
  // and a node carrying two same-type components (cc.Sprite) — so the emitted
  // path/selector must disambiguate with [i]. Nothing else mutates it.
  await write('TreeDup.prefab', [
    { __type__: 'cc.Prefab', _name: 'TreeDup', data: { __id__: 1 } },
    { __type__: 'cc.Node', _name: 'Root', _parent: null, _children: [{ __id__: 2 }, { __id__: 5 }], _components: [{ __id__: 3 }, { __id__: 7 }], _active: true },
    { __type__: 'cc.Node', _name: 'Slot', _parent: { __id__: 1 }, _children: [], _components: [{ __id__: 4 }], _active: true },
    { __type__: 'cc.Sprite', node: { __id__: 1 }, _enabled: true },
    { __type__: 'cc.Label', node: { __id__: 2 }, _string: 'first' },
    { __type__: 'cc.Node', _name: 'Slot', _parent: { __id__: 1 }, _children: [], _components: [{ __id__: 6 }], _active: true },
    { __type__: 'cc.Label', node: { __id__: 5 }, _string: 'second' },
    { __type__: 'cc.Sprite', node: { __id__: 1 }, _enabled: true },
  ]);
  await write('TreeDup.prefab.meta', { importer: 'prefab', uuid: U.treeDup });

  // CROSS-VERSION fixtures, modelled on real NewProject_352 (3.5.2) and
  // NewProject_386 (3.8.6) prefabs: a 3.5.2 cc.Node carries `_level` (no
  // `_mobility`/`__editorExtras__`); a 3.8.x cc.Node carries `_mobility` +
  // `__editorExtras__` (no `_level`). add-node clones the same-file skeleton, so
  // the SAME code must reproduce each version's field set — no version branches.
  const vec3 = (x, y, z) => ({ __type__: 'cc.Vec3', x, y, z });
  await write('XV35.prefab', [
    { __type__: 'cc.Prefab', _name: 'XV35', data: { __id__: 1 } },
    { __type__: 'cc.Node', _name: 'Root', _objFlags: 0, _parent: null, _children: [], _active: true, _level: 0, _components: [], _prefab: { __id__: 2 }, _lpos: vec3(0, 0, 0), _lrot: { __type__: 'cc.Quat', x: 0, y: 0, z: 0, w: 1 }, _lscale: vec3(1, 1, 1), _layer: 33554432, _euler: vec3(0, 0, 0), _id: 'xv35rootxxxxxxxxxxxxxx' },
    { __type__: 'cc.PrefabInfo', root: { __id__: 1 }, asset: { __id__: 0 }, fileId: 'xv35fxxxxxxxxxxxxxxxxx', instance: null },
  ]);
  await write('XV35.prefab.meta', { importer: 'prefab', uuid: U.xv35 });
  await write('XV38.prefab', [
    { __type__: 'cc.Prefab', _name: 'XV38', data: { __id__: 1 } },
    { __type__: 'cc.Node', _name: 'Root', _objFlags: 0, __editorExtras__: {}, _parent: null, _children: [], _active: true, _components: [], _prefab: { __id__: 2 }, _lpos: vec3(0, 0, 0), _lrot: { __type__: 'cc.Quat', x: 0, y: 0, z: 0, w: 1 }, _lscale: vec3(1, 1, 1), _mobility: 0, _layer: 33554432, _euler: vec3(0, 0, 0), _id: 'xv38rootxxxxxxxxxxxxxx' },
    { __type__: 'cc.PrefabInfo', root: { __id__: 1 }, asset: { __id__: 0 }, fileId: 'xv38fxxxxxxxxxxxxxxxxx', instance: null },
  ]);
  await write('XV38.prefab.meta', { importer: 'prefab', uuid: U.xv38 });
});

after(async () => { if (projectDir) await fs.rm(projectDir, { recursive: true, force: true }); });

test('find: substring matches by name', () => {
  const out = cli('find', 'icon').stdout;
  assert.match(out, /a\/icon\.png/);
  assert.match(out, /b\/icon\.png/);
});

test('find --json: structured array with path/type/uuid', () => {
  const items = json(cli('find', 'coin', '-o', 'json'));
  const coin = items.find((i) => i.path === 'coin.png');
  assert.ok(coin, 'coin.png present');
  assert.equal(coin.type, 'image');
  assert.equal(coin.uuid, U.coin);
});

test('deps --json: prefab out-edges, orphan, and in-edge', () => {
  const o = json(cli('deps', 'Shop.prefab', '-o', 'json'));
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
  assert.match(out, /Shop\/Icon:ShopCtrl\b/); // selector form: nodePath:Comp (decompressed script class, no .ts)
  assert.match(out, /Shop:cc\.Sprite\._spriteFrame/); // nodePath:Comp.prop selector
  assert.match(out, /"coin_frame"/);        // sub-asset (frame) name
  assert.match(out, /↯/);                   // orphan marker
  assert.ok(out.includes(U.missing), 'orphan uuid shown');
});

test('uses --json: meta-derived in-edge has empty locations', () => {
  const o = json(cli('uses', 'coin.png', '-o', 'json'));
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
  const o = json(cli('closure', 'Game.scene', '-o', 'json'));
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
  assert.equal(json(cli('deps', U.prefab, '-o', 'json')).node, 'Shop.prefab');
  assert.equal(json(cli('deps', `${U.coin}@f9941`, '-o', 'json')).node, 'coin.png');
});

// ---- info: dump one asset's record (sub-assets, degrees, userData) ----------
test('info --json: record with type, degrees and sub-assets', () => {
  const o = json(cli('info', 'coin.png', '-o', 'json'));
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
  assert.equal(json(cli('info', 'resources/dyn.png', '-o', 'json')).inResources, true);
  assert.equal(json(cli('info', 'unused.png', '-o', 'json')).inResources, false);
  assert.equal(json(cli('info', `${U.coin}@6c48a`, '-o', 'json')).path, 'coin.png'); // sub → owner
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
  const o = json(cli('deps', 'Shop.prefab', '--out', '--type', 'script', '-o', 'json'));
  assert.ok(o.dependsOn.length > 0);
  assert.ok(o.dependsOn.every((e) => e.type === 'script'), 'only script neighbours');
  assert.ok(o.dependsOn.some((e) => e.path === 'ShopCtrl.ts'));
  assert.ok(!o.orphanRefs, 'orphans are untyped → omitted when filtering by type');
});

test('closure --type: filters the bundle to the chosen types', () => {
  const o = json(cli('closure', 'Game.scene', '--type', 'image', '-o', 'json'));
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
  const o = json(cli('deps', 'Shop.prefab', '--out', '-o', 'json'));
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

// ---- edit swap-uuid (Tier 0): in-place reference repoint -------------------
// These mutate EditMe.prefab in sequence; they run after every read-only test.
test('edit swap-uuid --dry-run: reports count, leaves the file byte-identical', () => {
  const before = readAsset('EditMe.prefab');
  const out = cli('edit', 'EditMe.prefab', 'swap-uuid', 'edit/from.png', 'edit/to.png', '--dry-run').stdout;
  assert.match(out, /2 reference/);
  assert.match(out, /dry-run/);
  assert.equal(readAsset('EditMe.prefab'), before, 'dry-run must not write');
});

test('edit swap-uuid: rewrites both references in place and topology follows', () => {
  const r = cli('edit', 'EditMe.prefab', 'swap-uuid', 'edit/from.png', 'edit/to.png');
  assert.equal(r.status, 0);
  const after = readAsset('EditMe.prefab');
  assert.ok(after.includes(U.editTo), 'new uuid written');
  assert.ok(!after.includes(U.editFrom), 'old uuid gone');
  const o = json(cli('deps', 'EditMe.prefab', '-o', 'json'));
  assert.ok(o.dependsOn.some((e) => e.path === 'edit/to.png'), 'now depends on edit/to.png');
  assert.ok(!o.dependsOn.some((e) => e.path === 'edit/from.png'), 'no longer depends on edit/from.png');
});

test('edit swap-uuid: no-op (exit 0) when the old asset is not referenced', () => {
  // EditMe now points at edit/to.png; edit/from.png is no longer present → nothing to do
  const r = cli('edit', 'EditMe.prefab', 'swap-uuid', 'edit/from.png', 'edit/alt.png');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /nothing changed/);
  assert.ok(readAsset('EditMe.prefab').includes(U.editTo), 'file untouched on no-op');
});

test('edit swap-uuid --json: structured result, dry-run does not write', () => {
  const o = json(cli('edit', 'EditMe.prefab', 'swap-uuid', 'edit/to.png', 'edit/alt.png', '-o', 'json', '--dry-run'));
  assert.equal(o.op, 'swap-uuid');
  assert.equal(o.count, 2);
  assert.equal(o.dryRun, true);
  assert.equal(o.from, 'edit/to.png');
  assert.equal(o.to, 'edit/alt.png');
  assert.ok(readAsset('EditMe.prefab').includes(U.editTo), 'dry-run --json must not write');
});

test('edit --backup: writes <file>.bak before mutating', () => {
  const r = cli('edit', 'EditMe.prefab', 'swap-uuid', 'edit/to.png', 'edit/alt.png', '--backup');
  assert.equal(r.status, 0);
  assert.ok(fsSync.existsSync(path.join(projectDir, 'assets', 'EditMe.prefab.bak')), '.bak created');
  assert.ok(readAsset('EditMe.prefab').includes(U.editAlt), 'swap applied');
});

test('edit: refuses a non-prefab/scene target (exit 2)', () => {
  const r = cli('edit', 'edit/from.png', 'swap-uuid', 'edit/to.png', 'edit/alt.png');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not a prefab\/scene/);
});

test('edit: unknown op (exit 1)', () => {
  assert.equal(cli('edit', 'EditMe.prefab', 'frobnicate').status, 1);
});

// ---- edit Tier 1/2: selector + set / node-ops (P1) -------------------------
test('edit set --str: sets a component property by selector', () => {
  const r = cli('edit', 'EditNode.prefab', 'set', 'Root/Title:cc.Label._string', '--str', 'Hello');
  assert.equal(r.status, 0);
  assert.equal(parseAsset('EditNode.prefab')[4]._string, 'Hello');
});

test('edit set --int: sets a nested property (_color.r)', () => {
  cli('edit', 'EditNode.prefab', 'set', 'Root/Title:cc.Label._color.r', '--int', '10');
  assert.equal(parseAsset('EditNode.prefab')[4]._color.r, 10);
});

test('edit set --color: writes a wrapped cc.Color', () => {
  cli('edit', 'EditNode.prefab', 'set', 'Root/Title:cc.Label._color', '--color', '#20304080');
  const c = parseAsset('EditNode.prefab')[4]._color;
  assert.deepEqual([c.__type__, c.r, c.g, c.b, c.a], ['cc.Color', 0x20, 0x30, 0x40, 0x80]);
});

test('edit set-uuid: points a property at an asset', () => {
  cli('edit', 'EditNode.prefab', 'set-uuid', 'Root:cc.Sprite._spriteFrame', 'edit/to.png');
  assert.equal(parseAsset('EditNode.prefab')[3]._spriteFrame.__uuid__, U.editTo);
});

test('edit set-active / set-layer: node fields', () => {
  cli('edit', 'EditNode.prefab', 'set-active', 'Root/Title', '--bool', 'false');
  cli('edit', 'EditNode.prefab', 'set-layer', 'Root', '--int', '1073741824');
  const arr = parseAsset('EditNode.prefab');
  assert.equal(arr[2]._active, false);
  assert.equal(arr[1]._layer, 1073741824);
});

test('edit set-pos --vec3: writes _lpos (negatives ok)', () => {
  cli('edit', 'EditNode.prefab', 'set-pos', 'Root', '--vec3', '5', '-3', '0');
  const p = parseAsset('EditNode.prefab')[1]._lpos;
  assert.deepEqual([p.__type__, p.x, p.y, p.z], ['cc.Vec3', 5, -3, 0]);
});

test('edit set-rot --vec3: writes _euler and the matching _lrot quaternion (Z=90)', () => {
  cli('edit', 'EditNode.prefab', 'set-rot', 'Root', '--vec3', '0', '0', '90');
  const arr = parseAsset('EditNode.prefab');
  assert.deepEqual([arr[1]._euler.x, arr[1]._euler.y, arr[1]._euler.z], [0, 0, 90]);
  const q = arr[1]._lrot; const near = (a, b) => Math.abs(a - b) < 1e-4;
  assert.ok(near(q.x, 0) && near(q.y, 0) && near(q.z, 0.7071068) && near(q.w, 0.7071068), `quat ${JSON.stringify(q)}`);
});

test('edit set-rot: single-axis X matches Cocos Quat.fromEuler', () => {
  cli('edit', 'EditNode.prefab', 'set-rot', 'Root', '--vec3', '90', '0', '0');
  const q = parseAsset('EditNode.prefab')[1]._lrot; const near = (a, b) => Math.abs(a - b) < 1e-4;
  assert.ok(near(q.x, 0.7071068) && near(q.y, 0) && near(q.z, 0) && near(q.w, 0.7071068), `quat ${JSON.stringify(q)}`);
});

test('edit set-parent: reparents a node and fixes both _children lists', () => {
  assert.equal(cli('edit', 'EditNode.prefab', 'set-parent', 'Root/Drag', 'Root/Box').status, 0);
  const arr = parseAsset('EditNode.prefab');
  assert.equal(arr[6]._parent.__id__, 5);                        // Drag now under Box
  assert.ok(arr[5]._children.some((c) => c.__id__ === 6));       // Box gained Drag
  assert.ok(!arr[1]._children.some((c) => c.__id__ === 6));      // Root lost Drag
  // the moved node resolves under its new path
  assert.equal(cli('edit', 'EditNode.prefab', 'set-active', 'Root/Box/Drag', '--bool', 'false').status, 0);
  assert.equal(parseAsset('EditNode.prefab')[6]._active, false);
});

test('edit set-parent: refuses a cycle (node into its own descendant, exit 2)', () => {
  const r = cli('edit', 'EditNode.prefab', 'set-parent', 'Root/Box', 'Root/Box/Drag');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /descendant|itself|cycle/);
});

// ---- edit Tier 3: structural add / remove (P2) — on EditTree.prefab --------
test('edit add-node: appends a node (cloned skeleton) + PrefabInfo, wired to parent', () => {
  const before = parseAsset('EditTree.prefab').length;
  assert.equal(cli('edit', 'EditTree.prefab', 'add-node', 'Root', 'Extra').status, 0);
  const arr = parseAsset('EditTree.prefab');
  const extra = nodeNamed(arr, 'Extra');
  assert.ok(extra, 'Extra node created');
  assert.notEqual(extra.__editorExtras__, undefined, 'version fields cloned from template');
  assert.ok(extra._prefab && typeof extra._prefab.__id__ === 'number', 'PrefabInfo created (prefab file)');
  const pi = arr[extra._prefab.__id__]; // #3: cloned PrefabInfo must drop the template's own refs
  assert.equal(pi.nestedPrefabInstanceRoots, null, 'stale nestedPrefabInstanceRoots reset');
  assert.equal(pi.asset.__id__, 0, 'asset → the cc.Prefab');
  assert.equal(pi.root.__id__, arr.indexOf(nodeNamed(arr, 'Root')), 'root → the prefab root node');
  const root = nodeNamed(arr, 'Root');
  assert.ok(root._children.some((c) => c.__id__ === arr.indexOf(extra)), 'wired into Root._children');
  assert.deepEqual(refIntegrity(arr), []);
  assert.equal(arr.length, before + 2, 'node + PrefabInfo appended');
});

test('edit add-component: appends a component + CompPrefabInfo, wired to node', () => {
  const before = parseAsset('EditTree.prefab').length;
  assert.equal(cli('edit', 'EditTree.prefab', 'add-component', 'Root/Child', 'cc.Widget').status, 0);
  const arr = parseAsset('EditTree.prefab');
  const w = arr.find((o) => o && o.__type__ === 'cc.Widget');
  assert.ok(w, 'Widget added');
  assert.ok(w.__prefab && typeof w.__prefab.__id__ === 'number', 'CompPrefabInfo created');
  const child = nodeNamed(arr, 'Child');
  assert.ok(child._components.some((c) => c.__id__ === arr.indexOf(w)), 'wired into Child._components');
  assert.deepEqual(refIntegrity(arr), []);
  assert.equal(arr.length, before + 2);
});

test('edit rm-component: real-deletes the component + its CompPrefabInfo, compacts', () => {
  const before = parseAsset('EditTree.prefab').length;
  assert.equal(cli('edit', 'EditTree.prefab', 'rm-component', 'Root:cc.Sprite').status, 0);
  const arr = parseAsset('EditTree.prefab');
  assert.equal(typesIn(arr, 'cc.Sprite').length, 0, 'Sprite gone');
  assert.deepEqual(refIntegrity(arr), [], 'all refs renumbered & valid');
  const root = nodeNamed(arr, 'Root');
  assert.ok(!(root._components || []).length, 'Root._components emptied');
  assert.equal(arr.length, before - 2, 'sprite + CompPrefabInfo removed');
});

test('edit rm-node: real-deletes a subtree (node+comps+infos), compacts, no orphans', () => {
  const before = parseAsset('EditTree.prefab').length;
  assert.equal(cli('edit', 'EditTree.prefab', 'rm-node', 'Root/Child').status, 0);
  const arr = parseAsset('EditTree.prefab');
  assert.equal(nodeNamed(arr, 'Child'), undefined, 'Child gone');
  assert.equal(typesIn(arr, 'cc.Label').length, 0, 'Child label gone');
  assert.equal(typesIn(arr, 'cc.Widget').length, 0, 'widget on Child gone too');
  assert.deepEqual(refIntegrity(arr), [], 'refs intact after compaction');
  const root = nodeNamed(arr, 'Root');
  assert.ok(!(root._children || []).some((c) => arr[c.__id__] && arr[c.__id__]._name === 'Child'), 'Root no longer references Child');
  assert.ok(arr.length < before, 'entries removed');
});

test('edit rm-node: refuses the root node (exit 2)', () => {
  const r = cli('edit', 'EditTree.prefab', 'rm-node', 'Root');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /root/);
});

test('edit rm-component: errors when the selector is a node, not a component (exit 2)', () => {
  const r = cli('edit', 'EditTree.prefab', 'rm-component', 'Root');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /component/);
});

test('edit rm-node: nulls dangling cross-references on surviving entries', () => {
  const r = json(cli('edit', 'EditXref.prefab', 'rm-node', 'Root/B', '-o', 'json'));
  assert.equal(r.cleared, 1, 'the surviving cross-ref to B was cleared');
  const arr = parseAsset('EditXref.prefab');
  assert.equal(nodeNamed(arr, 'B'), undefined, 'B removed');
  assert.equal(arr.find((o) => o && o.__type__ === 'cc.MyComp')._ref, null, 'cross-ref nulled, not dangling');
  assert.deepEqual(refIntegrity(arr), []);
});

// ---- P3a: project-wide --all swap-uuid + nested-instance guard --------------
test('edit --all swap-uuid --dry-run: previews across files, writes nothing', () => {
  const o = json(cli('edit', '--all', 'swap-uuid', 'all/shared.png', 'all/other.png', '-o', 'json', '--dry-run'));
  assert.equal(o.scope, 'all');
  assert.equal(o.totalFiles, 3);
  assert.equal(o.totalRefs, 4);                 // AllA×2 + AllB×1 + AllScene×1
  assert.equal(o.dryRun, true);
  assert.ok(readAsset('AllA.prefab').includes(U.allShared), 'dry-run did not write');
});

test('edit --all swap-uuid: rewrites every prefab/scene referrer', () => {
  assert.equal(cli('edit', '--all', 'swap-uuid', 'all/shared.png', 'all/other.png').status, 0);
  for (const f of ['AllA.prefab', 'AllB.prefab', 'AllScene.scene']) {
    assert.ok(readAsset(f).includes(U.allOther), `${f} repointed`);
    assert.ok(!readAsset(f).includes(U.allShared), `${f} old gone`);
  }
});

test('edit --all swap-uuid: no-op when nothing references the asset', () => {
  const r = cli('edit', '--all', 'swap-uuid', 'all/lonely.png', 'all/other.png');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /nothing changed/);
});

test('edit --all: rejects non-swap ops (selector ops are per-file)', () => {
  const r = cli('edit', '--all', 'set', 'X:cc.Label._string', '--str', 'x');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /only swap-uuid/);
});

test('edit: A-own node editable, but a nested prefab instance is refused', () => {
  assert.equal(cli('edit', 'AInst.prefab', 'set', 'Root:cc.Label._string', '--str', 'X').status, 0);
  assert.equal(parseAsset('AInst.prefab')[4]._string, 'X');
  const r = cli('edit', 'AInst.prefab', 'rename', 'Root/Holder/BInst', 'Foo');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /nested prefab instance/);
});

test('edit rm-node: refuses a subtree that CONTAINS a nested instance (#14)', () => {
  // Root/Holder is A-own, but its subtree holds the BInst instance → refuse.
  const r = cli('edit', 'AInst.prefab', 'rm-node', 'Root/Holder');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /nested prefab instance/);
});

test('edit set #index escape hatch sets a property on a raw entry', () => {
  cli('edit', 'EditNode.prefab', 'set', '#4._string', '--str', 'ByIndex');
  assert.equal(parseAsset('EditNode.prefab')[4]._string, 'ByIndex');
});

test('edit set: array element via [i] (and .i still works)', () => {
  cli('edit', 'EditNode.prefab', 'set', 'Root:cc.Sprite._clickish[1].h', '--str', 'BRACKET');
  cli('edit', 'EditNode.prefab', 'set', 'Root:cc.Sprite._clickish.0.h', '--str', 'DOTTED');
  const arr = parseAsset('EditNode.prefab');
  assert.equal(arr[3]._clickish[0].h, 'DOTTED');   // .i form
  assert.equal(arr[3]._clickish[1].h, 'BRACKET');  // [i] form
});

test('edit set --json + --dry-run: structured result, no write', () => {
  const before = readAsset('EditNode.prefab');
  const o = json(cli('edit', 'EditNode.prefab', 'set', 'Root/Title:cc.Label._string', '--str', 'NOPE', '-o', 'json', '--dry-run'));
  assert.equal(o.op, 'set');
  assert.equal(o.value, 'NOPE');
  assert.equal(o.dryRun, true);
  assert.equal(readAsset('EditNode.prefab'), before, 'dry-run must not write');
});

test('edit set: errors when the selector is not a property (exit 2)', () => {
  const r = cli('edit', 'EditNode.prefab', 'set', 'Root/Title', '--str', 'x');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /property/);
});

test('edit set: errors on an unknown component (exit 2)', () => {
  const r = cli('edit', 'EditNode.prefab', 'set', 'Root:cc.Nope._x', '--int', '1');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no component matching/);
});

test('edit: an ambiguous same-type component without [i] is refused, not silently [0]', () => {
  // TreeDup's Root has two cc.Sprite — like same-name nodes, this must error (not pick #0)
  const r = cli('edit', 'TreeDup.prefab', 'get', 'Root:cc.Sprite');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /2 cc\.Sprite components — add \[i\]/);
  assert.equal(cli('edit', 'TreeDup.prefab', 'get', 'Root:cc.Sprite[1]', '-o', 'json').status, 0); // explicit [i] still resolves
});

// rename last: it changes the path Title resolves under
test('edit rename: changes _name; the node resolves under the new path', () => {
  assert.equal(cli('edit', 'EditNode.prefab', 'rename', 'Root/Title', 'Heading').status, 0);
  assert.equal(parseAsset('EditNode.prefab')[2]._name, 'Heading');
  assert.equal(cli('edit', 'EditNode.prefab', 'set', 'Root/Title:cc.Label._string', '--str', 'x').status, 2);
  assert.equal(cli('edit', 'EditNode.prefab', 'set', 'Root/Heading:cc.Label._string', '--str', 'Renamed').status, 0);
  assert.equal(parseAsset('EditNode.prefab')[4]._string, 'Renamed');
});

// ---- code-review fix coverage (A + B) --------------------------------------
test('fix#1 set --color: rejects invalid hex (exit 1), no null channel written', () => {
  const before = readAsset('EditNode.prefab');
  const r = cli('edit', 'EditNode.prefab', 'set', '#4._color', '--color', '#GGGGGG');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /hex color/);
  assert.equal(readAsset('EditNode.prefab'), before, 'file untouched on bad value');
});

test('fix#2/#7 node ops reject a mismatched value flag (exit 1)', () => {
  assert.equal(cli('edit', 'EditNode.prefab', 'set-pos', 'Root', '--int', '5').status, 1);     // Vec3 field, int flag
  assert.equal(cli('edit', 'EditNode.prefab', 'set-active', 'Root', '--vec3', '0', '0', '0').status, 1);
  assert.match(cli('edit', 'EditNode.prefab', 'set-pos', 'Root', '--int', '5').stderr, /vec3/);
});

test('fix#6 set --uuid with no asset errors cleanly, not a crash', () => {
  const r = cli('edit', 'EditNode.prefab', 'set', '#3._spriteFrame', '--uuid');
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stderr, /TypeError|Cannot read/);
  assert.match(r.stderr, /uuid/);
});

test('fix#9 rename accepts an empty string (a legal _name)', () => {
  assert.equal(cli('edit', 'EditNode.prefab', 'rename', 'Root/Box', '').status, 0);
  assert.equal(nodeNamed(parseAsset('EditNode.prefab'), '')._parent.__id__, 1); // the (now empty-named) Box still under Root
});

test('fix#10 swap-uuid onto the same asset is a no-op (not a rewrite)', () => {
  const before = readAsset('EditMe.prefab');
  const r = cli('edit', 'EditMe.prefab', 'swap-uuid', 'edit/to.png', 'edit/to.png');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /nothing changed/);
  assert.equal(readAsset('EditMe.prefab'), before);
});

test('fix#11 rm-component #N refuses a PrefabInfo (not a real component)', () => {
  const r = cli('edit', 'AInst.prefab', 'rm-component', '#5'); // index 5 = a cc.PrefabInfo
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not a component/);
});

test('fix#12 rm-component removes the Button AND its owned cc.ClickEvent entries', () => {
  assert.equal(cli('edit', 'EditBtn.prefab', 'rm-component', 'Root/Panel:cc.Button').status, 0);
  const arr = parseAsset('EditBtn.prefab');
  assert.equal(typesIn(arr, 'cc.Button').length, 0, 'Button gone');
  assert.equal(typesIn(arr, 'cc.ClickEvent').length, 0, 'owned ClickEvents gone too, not orphaned');
  assert.deepEqual(refIntegrity(arr), []);
});

test('fix#5 a node literally named "Weird[0]" resolves by its real name', () => {
  assert.equal(cli('edit', 'EditNode.prefab', 'set-active', 'Root/Weird[0]', '--bool', 'false').status, 0);
  assert.equal(nodeNamed(parseAsset('EditNode.prefab'), 'Weird[0]')._active, false);
});

test('fix#8 --all warns (not silently skips) an unparseable referrer', () => {
  const r = cli('edit', '--all', 'swap-uuid', 'all/lonely.png', 'all/shared.png', '-o', 'json', '--dry-run');
  assert.match(r.stderr, /skipped/);
  assert.ok(JSON.parse(r.stdout).skipped.includes('BadShape.prefab'), 'skip is surfaced in --json');
});

// ---- --json value flag: whole object/array, class-name __type__ → token ------
test('set --json: sets a custom-typed object, class-name __type__ → compressed token', () => {
  const raw = JSON.stringify({ __type__: 'SpriteConfig', frameName: 'new', keys: ['z'] });
  assert.equal(cli('edit', 'CfgEdit.prefab', 'set', 'Root:cc.Sprite._cfg', '--json', raw).status, 0);
  const cfg = parseAsset('CfgEdit.prefab')[2]._cfg;
  assert.equal(cfg.__type__, CFG_TYPE, 'class name converted to the compressed token');
  assert.equal(cfg.frameName, 'new');
  assert.deepEqual(cfg.keys, ['z']);
});

test('set --json: an already-compressed __type__ passes through unchanged', () => {
  const raw = JSON.stringify({ __type__: CFG_TYPE, frameName: 'tok' });
  cli('edit', 'CfgEdit.prefab', 'set', 'Root:cc.Sprite._cfg', '--json', raw);
  assert.equal(parseAsset('CfgEdit.prefab')[2]._cfg.__type__, CFG_TYPE);
});

test('set --json: builtin and nested __type__ are handled correctly', () => {
  const raw = JSON.stringify({ __type__: 'SpriteConfig', sub: { __type__: 'cc.Vec2', x: 1, y: 2 } });
  cli('edit', 'CfgEdit.prefab', 'set', 'Root:cc.Sprite._cfg', '--json', raw);
  const cfg = parseAsset('CfgEdit.prefab')[2]._cfg;
  assert.equal(cfg.__type__, CFG_TYPE, 'outer custom class → token');
  assert.equal(cfg.sub.__type__, 'cc.Vec2', 'builtin __type__ untouched');
});

test('set --json: arrays/scalars work too (set a keys array)', () => {
  cli('edit', 'CfgEdit.prefab', 'set', 'Root:cc.Sprite._cfg.keys', '--json', '["p","q"]');
  assert.deepEqual(parseAsset('CfgEdit.prefab')[2]._cfg.keys, ['p', 'q']);
});

test('set --json: guards an unknown __type__ class (exit 1, no write)', () => {
  const before = readAsset('CfgEdit.prefab');
  const r = cli('edit', 'CfgEdit.prefab', 'set', 'Root:cc.Sprite._cfg', '--json', '{"__type__":"NoSuchClass","x":1}');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown __type__/);
  assert.equal(readAsset('CfgEdit.prefab'), before, 'no write on unknown type');
});

test('set --json: invalid JSON errors cleanly (exit 1)', () => {
  const r = cli('edit', 'CfgEdit.prefab', 'set', 'Root:cc.Sprite._cfg', '--json', 'not json');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /invalid JSON/);
});

// ---- get: the read pair for set --------------------------------------------
test('edit get: reads a scalar property (text + raw -o json)', () => {
  cli('edit', 'EditNode.prefab', 'set', '#4._string', '--str', 'GETME');
  assert.match(cli('edit', 'EditNode.prefab', 'get', '#4._string').stdout, /GETME/);
  assert.equal(json(cli('edit', 'EditNode.prefab', 'get', '#4._string', '-o', 'json')), 'GETME');
});

test('edit get: a __uuid__ property resolves to its asset path (raw via -o json)', () => {
  cli('edit', 'EditNode.prefab', 'set-uuid', 'Root:cc.Sprite._spriteFrame', 'edit/to.png');
  const out = cli('edit', 'EditNode.prefab', 'get', 'Root:cc.Sprite._spriteFrame').stdout;
  assert.match(out, /edit\/to\.png/);
  assert.equal(json(cli('edit', 'EditNode.prefab', 'get', 'Root:cc.Sprite._spriteFrame', '-o', 'json')).__uuid__, U.editTo);
});

test('edit get -o json round-trips into set --json (compressed __type__ preserved)', () => {
  cli('edit', 'CfgEdit.prefab', 'set', 'Root:cc.Sprite._cfg', '--json', JSON.stringify({ __type__: 'SpriteConfig', frameName: 'RT' }));
  const raw = json(cli('edit', 'CfgEdit.prefab', 'get', 'Root:cc.Sprite._cfg', '-o', 'json'));
  assert.equal(raw.__type__, CFG_TYPE);
  assert.equal(cli('edit', 'CfgEdit.prefab', 'set', 'Root:cc.Sprite._cfg', '--json', JSON.stringify(raw)).status, 0);
  assert.equal(parseAsset('CfgEdit.prefab')[2]._cfg.frameName, 'RT');
});

test('edit get: text form annotates a compressed __type__ with the class name', () => {
  assert.match(cli('edit', 'CfgEdit.prefab', 'get', 'Root:cc.Sprite._cfg').stdout, /SpriteConfig/);
});

test('edit get: missing property → (no such property); node selector → whole object', () => {
  assert.match(cli('edit', 'EditNode.prefab', 'get', '#4._nope').stdout, /no such property/);
  const o = json(cli('edit', 'EditNode.prefab', 'get', 'Root', '-o', 'json'));
  assert.equal(o.__type__, 'cc.Node');
  assert.equal(o._name, 'Root');
});

// ---- tree: structure discovery (node hierarchy + component selectors) ------
test('edit tree -o json: nodes carry a full record + each component a ready selector', () => {
  const d = json(cli('edit', 'TreeDup.prefab', 'tree', '-o', 'json')); // dedicated, unmutated
  assert.equal(d.file, 'TreeDup.prefab');
  assert.equal(d.nodeCount, 3);
  assert.deepEqual(d.nodes.find((n) => n.path === 'Root'), {
    index: 1, path: 'Root', name: 'Root', depth: 0, active: true, instance: false,
    components: [{ index: 3, type: 'cc.Sprite', selector: 'Root:cc.Sprite[0]' },
      { index: 7, type: 'cc.Sprite', selector: 'Root:cc.Sprite[1]' }],
  });
  const slot = d.nodes.find((n) => n.path === 'Root/Slot[0]');
  assert.deepEqual(slot.components, [{ index: 4, type: 'cc.Label', selector: 'Root/Slot[0]:cc.Label' }]);
  // a literal-bracket node NAME is preserved verbatim (not mistaken for an [i] suffix)
  assert.ok(json(cli('edit', 'EditNode.prefab', 'tree', '-o', 'json')).nodes.some((n) => n.path === 'Root/Weird[0]'));
});

test('edit tree: text form is an indented hierarchy with #index + component tokens', () => {
  const out = cli('edit', 'TreeDup.prefab', 'tree').stdout;
  assert.match(out, /TreeDup\.prefab — 3 nodes/);
  assert.match(out, /^ {2}Root\b.*#1.*cc\.Sprite\[0\] cc\.Sprite\[1\]/m);
  assert.match(out, /^ {4}Slot\[0\].*#2.*cc\.Label/m); // child indented one level deeper
});

test('edit tree: disambiguates same-name siblings and same-type components with [i]', () => {
  const d = json(cli('edit', 'TreeDup.prefab', 'tree', '-o', 'json'));
  const slots = d.nodes.filter((n) => n.name === 'Slot').map((n) => n.path).sort();
  assert.deepEqual(slots, ['Root/Slot[0]', 'Root/Slot[1]']);
  const root = d.nodes.find((n) => n.path === 'Root');
  assert.deepEqual(root.components.map((c) => c.selector), ['Root:cc.Sprite[0]', 'Root:cc.Sprite[1]']);
  // and those disambiguated selectors actually resolve back (round-trip)
  assert.equal(json(cli('edit', 'TreeDup.prefab', 'get', 'Root/Slot[1]:cc.Label._string', '-o', 'json')), 'second');
  assert.equal(json(cli('edit', 'TreeDup.prefab', 'get', 'Root:cc.Sprite[1]', '-o', 'json')).node.__id__, 1);
});

test('edit tree --with <Type>: keeps only nodes carrying that component, flat full paths', () => {
  const d = json(cli('edit', 'TreeDup.prefab', 'tree', '--with', 'cc.Label', '-o', 'json'));
  assert.deepEqual(d.nodes.map((n) => n.path).sort(), ['Root/Slot[0]', 'Root/Slot[1]']);
  assert.ok(d.nodes.every((n) => n.components.some((c) => c.type === 'cc.Label')));
  const out = cli('edit', 'TreeDup.prefab', 'tree', '--with', 'cc.Label').stdout;
  assert.match(out, /with cc\.Label/);
  assert.match(out, /Root\/Slot\[0\]/); // flat: full path shown
});

test('edit tree --under <sel>: scopes to a subtree (that node becomes depth 0)', () => {
  const d = json(cli('edit', 'AInst.prefab', 'tree', '--under', 'Root/Holder', '-o', 'json'));
  assert.equal(d.nodes[0].path, 'Root/Holder');
  assert.equal(d.nodes[0].depth, 0);
  assert.ok(!d.nodes.some((n) => n.path === 'Root')); // the parent is excluded
  // --under a non-node is refused
  assert.equal(cli('edit', 'TreeDup.prefab', 'tree', '--under', 'Root:cc.Sprite').status, 2);
});

test('edit tree --depth N: limits levels (root = 0)', () => {
  const full = json(cli('edit', 'AInst.prefab', 'tree', '-o', 'json'));
  assert.equal(full.nodeCount, 3); // Root → Holder → BInst (default: whole tree)
  const d1 = json(cli('edit', 'AInst.prefab', 'tree', '--depth', '1', '-o', 'json'));
  assert.deepEqual(d1.nodes.map((n) => n.path), ['Root', 'Root/Holder']); // BInst (depth 2) dropped
});

test('edit tree: flags a nested prefab-instance root (edit it in its source prefab)', () => {
  const d = json(cli('edit', 'AInst.prefab', 'tree', '-o', 'json'));
  const binst = d.nodes.find((n) => n.name === 'BInst');
  assert.equal(binst.instance, true);
  assert.equal(d.nodes.find((n) => n.name === 'Root').instance, false);
  assert.match(cli('edit', 'AInst.prefab', 'tree').stdout, /BInst.*\[prefab instance\]/);
});

// ---- deps --kind: filter edges by edge KIND --------------------------------
test('deps --kind keeps only the chosen edge kinds (drops other kinds + orphans)', () => {
  const all = json(cli('deps', 'Shop.prefab', '--out', '-o', 'json'));
  assert.ok(all.dependsOn.some((d) => d.via === 'sprite-frame'));
  assert.ok(all.orphanRefs && all.orphanRefs.length, 'Shop has orphan refs normally');

  const k = json(cli('deps', 'Shop.prefab', '--out', '--kind', 'sprite-frame', '-o', 'json'));
  assert.ok(k.dependsOn.length && k.dependsOn.every((d) => d.via === 'sprite-frame'));
  assert.equal(k.orphanRefs, undefined); // kind-less orphans are dropped under --kind

  const none = json(cli('deps', 'Shop.prefab', '--out', '--kind', 'texture', '-o', 'json'));
  assert.equal(none.dependsOn.length, 0); // Shop has no texture edge

  assert.match(cli('deps', 'Shop.prefab', '--out', '--kind', 'sprite-frame').stdout, /\[kind: sprite-frame\]/);
});

// ---- analyze: project-wide audit sections ----------------------------------
test('analyze stats: counts + edge-kinds + health (text + json)', () => {
  assert.match(cli('analyze', 'stats').stdout, /stats: \d+ assets.*metaErrors=0\s+✓ healthy/s);
  const d = json(cli('analyze', 'stats', '-o', 'json'));
  assert.ok(d.assets > 0);
  assert.equal(d.metaErrors, 0);
  assert.ok(d.byType.image >= 1);
  assert.ok(d.edgeKinds && typeof d.edgeKinds === 'object'); // edge-kind histogram is part of stats
});

test('analyze unused: lists 0-referrer non-resources assets (incl. unused.png); --type filters', () => {
  const d = json(cli('analyze', 'unused', '-o', 'json'));
  assert.ok(d.total >= 1);
  assert.ok(d.items.some((i) => /unused\.png/.test(i.path)));
  assert.ok(d.byType && typeof d.totalSize === 'number');
  const imgs = json(cli('analyze', 'unused', '--type', 'image', '-o', 'json'));
  assert.ok(imgs.items.length && imgs.items.every((i) => i.type === 'image'));
});

test('analyze orphans: dangling refs; --dropped adds the source-less-meta audit', () => {
  const d = json(cli('analyze', 'orphans', '-o', 'json'));
  assert.ok(d.total >= 1); // the prefab points at U.missing / U.ghost
  assert.equal(d.dropped, undefined); // not present without the flag
  const dd = json(cli('analyze', 'orphans', '--dropped', '-o', 'json'));
  assert.ok(dd.dropped && Array.isArray(dd.dropped.items));
});

test('analyze atlas: per-atlas frame utilization (the .plist)', () => {
  const a = json(cli('analyze', 'atlas', '-o', 'json')).items.find((i) => /ui\.plist/.test(i.path));
  assert.ok(a, 'ui.plist not in atlas report');
  assert.equal(a.total, 1); // one sprite-frame
  assert.equal(a.used, 1);  // referenced as @f1234
});

test('analyze size: per-type totals; --list adds the largest files', () => {
  const d = json(cli('analyze', 'size', '-o', 'json'));
  assert.ok(d.byType.image && d.totalSize >= 0);
  assert.equal(d.items, undefined); // no item list without --list
  assert.ok(Array.isArray(json(cli('analyze', 'size', '--list', '-o', 'json')).items));
});

test('analyze (no section) = full report of every section; a bogus section exits 1', () => {
  const d = json(cli('analyze', '-o', 'json'));
  assert.deepEqual(Object.keys(d).sort(), ['atlas', 'orphans', 'size', 'stats', 'unused']);
  const r = cli('analyze', 'bogus');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown analyze section/);
});

// ---- cross-version (3.5.2 vs 3.8.x): template-by-example, one code path ------
test('add-node clones the same-file skeleton → 3.5.2 fields on a 3.5.2 prefab', () => {
  assert.equal(cli('edit', 'XV35.prefab', 'add-node', 'Root', 'New35').status, 0);
  const n = nodeNamed(parseAsset('XV35.prefab'), 'New35');
  assert.ok('_level' in n, '3.5.2 node must carry _level');
  assert.ok(!('_mobility' in n) && !('__editorExtras__' in n), '3.8.x-only fields must be absent');
  assert.ok(n._prefab && n._prefab.__id__ != null, 'a PrefabInfo is attached');
  assert.deepEqual(n._lpos, { __type__: 'cc.Vec3', x: 0, y: 0, z: 0 }); // identity fields reset
});

test('add-node clones the same-file skeleton → 3.8.x fields on a 3.8.x prefab', () => {
  assert.equal(cli('edit', 'XV38.prefab', 'add-node', 'Root', 'New38').status, 0);
  const n = nodeNamed(parseAsset('XV38.prefab'), 'New38');
  assert.ok('_mobility' in n && '__editorExtras__' in n, '3.8.x node must carry _mobility + __editorExtras__');
  assert.ok(!('_level' in n), '3.5.2-only field must be absent');
  assert.ok(n._prefab && n._prefab.__id__ != null, 'a PrefabInfo is attached');
});

test('both versions stay ref-valid after add-node + add-component (refIntegrity)', () => {
  for (const f of ['XV35.prefab', 'XV38.prefab']) {
    cli('edit', f, 'add-component', 'Root', 'cc.UITransform');
    assert.deepEqual(refIntegrity(parseAsset(f)), []); // every {__id__} in-range → has a __type__
  }
});

// ---- entry-point ergonomics: --help / --version / -C ----------------------
test('--version prints the version and exits 0', () => {
  const r = cliRaw('--version');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /coir \d+\.\d+/);
});

test('--help / -h prints usage (with examples + exit codes) and exits 0', () => {
  for (const f of ['--help', '-h']) {
    const r = cliRaw(f);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Usage:/);
    assert.match(r.stdout, /Examples:/);
    assert.match(r.stdout, /Exit codes:/);
  }
});

test('-C <dir> supplies the project dir (verb-first), either position', () => {
  // -C after the command (verb-first)
  assert.match(cliRaw('find', 'coin', '-C', projectDir).stdout, /coin\.png/);
  // -C before the command
  assert.match(cliRaw('-C', projectDir, 'find', 'coin').stdout, /coin\.png/);
  // and edit works with -C too
  assert.equal(json(cliRaw('-C', projectDir, 'edit', 'EditNode.prefab', 'get', 'Root', '-o', 'json')).__type__, 'cc.Node');
});
