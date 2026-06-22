// probeInvertible (src/edit/editPrefab.js) — the offline invertible-edit audit
// behind `verify --roundtrip`. It now runs a SUITE of op pairs (node add/remove,
// component add/remove, setParent there-and-back); each must restore the original.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeInvertible } from '../src/edit/editPrefab.js';

const node = (name, parent, children = []) => ({
  __type__: 'cc.Node', _name: name, _objFlags: 0, _parent: parent, _id: '',
  _children: children.map((i) => ({ __id__: i })), _components: [], _prefab: null,
  _lpos: { __type__: 'cc.Vec3', x: 0, y: 0, z: 0 }, _active: true,
});

test('probeInvertible: a valid multi-node prefab inverts under every probe', () => {
  // cc.Prefab + root + two children → all three probes (incl. setParent, which
  // needs a second node) actually RUN, not skip.
  const arr = [
    { __type__: 'cc.Prefab', data: { __id__: 1 } },
    node('root', null, [2, 3]),
    node('a', { __id__: 1 }),
    node('b', { __id__: 1 }),
  ];
  const before = JSON.stringify(arr);
  const r = probeInvertible(arr);
  assert.ok(!('error' in r), `should probe, got ${JSON.stringify(r)}`);
  assert.equal(r.invertible, true);
  assert.deepEqual(r.brokeProbes, []);
  assert.equal(r.verifyErrors.length, 0);
  assert.equal(JSON.stringify(arr), before, 'probeInvertible must NOT mutate its input');
});

test('probeInvertible: a single-node doc still inverts (setParent probe skips, not fails)', () => {
  const arr = [{ __type__: 'cc.Prefab', data: { __id__: 1 } }, node('root', null)];
  const r = probeInvertible(arr);
  assert.ok(!('error' in r));
  assert.equal(r.invertible, true);
  assert.deepEqual(r.brokeProbes, []);
});

test('probeInvertible: a doc with no node returns the no-node code', () => {
  const r = probeInvertible([{ __type__: 'cc.SpriteFrame' }]);
  assert.ok('error' in r && r.code === 'no-node');
});
