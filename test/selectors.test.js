// Selector-grammar conformance for coir's parser — the MIRROR of copse's
// test/selectors.test.js. coir owns the canonical grammar (docs/EDITING.md §3); its runtime
// sibling copse implements a SUBSET. This file pins coir's side of the shared contract AND
// the features copse deliberately drops, using the same interop corpus, so the two parsers
// can't drift silently. coir parses against a serialized `__id__` array (a prefab/scene doc);
// copse parses against the live cc tree — same vocabulary, different substrate. See copse's
// docs/SELECTORS.md for the matrix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSelector } from '../src/edit/editPrefab.js';

// A serialized prefab `arr` rooted at a node named "Canvas" (so the interop corpus strings
// match copse's, whose paths start at the scene-root's children). `__type__` is the class
// name directly, so compName is identity. Indices are commented; node._children/_components
// hold {__id__} refs.
const N = (name, kids = [], comps = []) => ({ __type__: 'cc.Node', _name: name, _children: kids.map((i) => ({ __id__: i })), _components: comps.map((i) => ({ __id__: i })) });
const C = (type, extra = {}) => ({ __type__: type, ...extra });
const arr = [
  /* 0  */ { ...N('Canvas', [1, 3, 4, 6, 7, 8, 9, 10, 13]), _parent: null },
  /* 1  */ { ...N('Score', [], [2]), _parent: { __id__: 0 } },
  /* 2  */ C('cc.Label', { string: 'hi' }),
  /* 3  */ { ...N('Panel'), _parent: { __id__: 0 } },
  /* 4  */ { ...N('Mgr', [], [5]), _parent: { __id__: 0 } },
  /* 5  */ C('ShopController', { gold: 100 }),
  /* 6  */ { ...N('Item'), _parent: { __id__: 0 } },
  /* 7  */ { ...N('Item'), _parent: { __id__: 0 } },
  /* 8  */ { ...N('Item'), _parent: { __id__: 0 } },
  /* 9  */ { ...N('Slot[0]'), _parent: { __id__: 0 } }, // a node whose NAME literally contains [0]
  /* 10 */ { ...N('Fx', [], [11, 12]), _parent: { __id__: 0 } },
  /* 11 */ C('cc.Sprite'),
  /* 12 */ C('cc.Sprite'),
  /* 13 */ { ...N('BuyBtn', [], [14]), _parent: { __id__: 0 } },
  /* 14 */ C('cc.Button', { clickEvents: [{ handler: 'buy' }] }),
];
const compName = (t) => t || null; // __type__ is already the matchable class name

const sel = (s) => resolveSelector(arr, s, compName);

// ---- shared core (resolves identically in copse) ---------------------------------------
test('grammar: nested path resolves to its node', () => {
  assert.deepEqual(sel('Canvas/Score'), { index: 1, kind: 'node' });
});

test('grammar: [i] picks the i-th same-name sibling (0-based); out-of-range → error', () => {
  assert.equal(sel('Canvas/Item[0]').index, 6);
  assert.equal(sel('Canvas/Item[1]').index, 7);
  assert.equal(sel('Canvas/Item[2]').index, 8);
  assert.ok(sel('Canvas/Item[3]').error); // only three Items
});

test('grammar: path:Type → component; path:Type.prop → property', () => {
  assert.deepEqual(sel('Canvas/Score:cc.Label'), { index: 2, kind: 'component', node: 1 });
  assert.deepEqual(sel('Canvas/Score:cc.Label.string'), { index: 2, kind: 'property', prop: 'string', node: 1 });
});

// ---- DIVERGENCES: features coir has that copse deliberately drops -----------------------
test('DIVERGENCE: bare same-name path is AMBIGUOUS → error (copse silently picks the first)', () => {
  // copse's resolve returns same[0]; coir refuses and asks for [i] — the stricter contract.
  const r = sel('Canvas/Item');
  assert.ok(r.error, 'coir should refuse an ambiguous bare same-name path');
  assert.match(r.error, /same-name/);
});

test('DIVERGENCE: #N absolute array index is supported (copse has no stable runtime index)', () => {
  assert.deepEqual(sel('#1'), { index: 1, kind: 'node' });          // arr[1] = Score node
  assert.equal(sel('#2').kind, 'component');                        // arr[2] = cc.Label
  assert.equal(sel('#2.string').kind, 'property');                  // #N may carry a .prop
  assert.ok(sel('#999').error);                                     // out of range
});

test('DIVERGENCE: literal-first — a node named "Slot[0]" IS addressable (copse always index-parses [i])', () => {
  // coir tries an exact literal path before stripping a trailing [i]; copse cannot reach this node.
  assert.deepEqual(sel('Canvas/Slot[0]'), { index: 9, kind: 'node' });
});

test('DIVERGENCE: [i] on same-type components (copse addresses one component by class name only)', () => {
  assert.ok(sel('Canvas/Fx:cc.Sprite').error);                     // two Sprites → ambiguous without [i]
  assert.deepEqual(sel('Canvas/Fx:cc.Sprite[1]'), { index: 12, kind: 'component', node: 10 });
});

test('DIVERGENCE: array-element property path (copse reads a whole member, no array index)', () => {
  assert.deepEqual(sel('Canvas/BuyBtn:cc.Button.clickEvents[0].handler'),
    { index: 14, kind: 'property', prop: 'clickEvents[0].handler', node: 13 });
});

// ---- interop corpus: the SAME node paths copse must resolve also resolve here -----------
// (Identical strings to copse/test/selectors.test.js — the shared subset round-trips both ways.)
const SHARED = ['Canvas/Score', 'Canvas/Item[0]', 'Canvas/Item[2]', 'Canvas/Mgr'];
test('interop corpus: shared node paths resolve in coir too (no error, kind:node)', () => {
  for (const s of SHARED) {
    const r = sel(s);
    assert.ok(!r.error, `coir should resolve shared "${s}" (got ${r.error})`);
    assert.equal(r.kind, 'node');
  }
});
