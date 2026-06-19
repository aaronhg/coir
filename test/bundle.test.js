// Asset Bundle model: directory metas with userData.isBundle are harvested into
// scan.bundles, and every asset gets a.bundle (nearest/deepest bundle root wins;
// 'resources' is built-in; unbundled → 'main'). Runs the core directly over an
// in-memory FileProvider — no temp dir, no subprocess.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanProject } from '../src/core/scan.js';

const memFP = (files) => ({
  listFiles: async () => Object.keys(files),
  readText: async (p) => files[p],
  size: async (p) => Buffer.byteLength(String(files[p] ?? '')),
});

const meta = (o) => JSON.stringify(o);
const U = (n) => `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-${n}${n}${n}${n}-${n}${n}${n}${n}-${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}`;

test('a.bundle: custom / nested / resources / main, and scan.bundles', async () => {
  const files = {
    // a custom bundle folder (explicit bundleName + priority)
    'ui.meta': meta({ importer: 'directory', uuid: U('a'), userData: { isBundle: true, bundleName: 'ui', priority: 3 } }),
    'ui/btn.png': 'PNG', 'ui/btn.png.meta': meta({ importer: 'image', uuid: U('1') }),
    // a NESTED bundle inside ui/ — no bundleName, so it defaults to the folder name 'inner'
    'ui/inner.meta': meta({ importer: 'directory', uuid: U('b'), userData: { isBundle: true, priority: 5 } }),
    'ui/inner/deep.png': 'PNG', 'ui/inner/deep.png.meta': meta({ importer: 'image', uuid: U('2') }),
    // resources/ is a built-in bundle
    'resources/dyn.png': 'PNG', 'resources/dyn.png.meta': meta({ importer: 'image', uuid: U('3') }),
    // a plain folder that is NOT a bundle → its assets fall through to 'main'
    'misc.meta': meta({ importer: 'directory', uuid: U('c') }),
    'misc/loose.png': 'PNG', 'misc/loose.png.meta': meta({ importer: 'image', uuid: U('4') }),
  };
  const scan = await scanProject(memFP(files));
  const bundleOfPath = (p) => [...scan.assets.values()].find((a) => a.path === p).bundle;

  assert.equal(bundleOfPath('ui/btn.png'), 'ui');
  assert.equal(bundleOfPath('ui/inner/deep.png'), 'inner', 'deepest/nested bundle root wins');
  assert.equal(bundleOfPath('resources/dyn.png'), 'resources');
  assert.equal(bundleOfPath('misc/loose.png'), 'main', 'a non-bundle folder → main');

  // scan.bundles = main + resources (built-ins) + the two user bundles
  const byName = new Map(scan.bundles.map((b) => [b.name, b]));
  assert.ok(byName.has('main') && byName.get('main').builtin);
  assert.ok(byName.has('resources') && byName.get('resources').builtin);
  assert.equal(byName.get('ui').root, 'ui');
  assert.equal(byName.get('ui').priority, 3);
  assert.equal(byName.get('inner').root, 'ui/inner');
  assert.equal(byName.get('inner').priority, 5);

  // inResources stays path-based (unused policy unchanged), and agrees with bundle here
  const res = [...scan.assets.values()].find((a) => a.path === 'resources/dyn.png');
  assert.equal(res.inResources, true);
});
