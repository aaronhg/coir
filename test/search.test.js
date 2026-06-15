// Unit test for the browser quick-open index (buildSearchIndex) — the parts the
// edge-search adds: usage entries carry edgeKind + a kind-bearing searchable
// text, and location-less edges (meta/convention/plugin) become `edge` entries
// with a plugin label or an endpoint-name fallback. Pure over a fake scan; the
// module imports cleanly in Node (no DOM at eval time).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchIndex } from '../src/browser/palette.js';
import { S } from '../src/browser/state.js';

test('buildSearchIndex: usage edgeKind/kind-in-text + location-less edge entries', () => {
  const A = (uuid, path, type) => [uuid, { uuid, path, type, subAssets: [] }];
  S.scan = {
    assets: new Map([
      A('p', 'ui/Foo.prefab', 'prefab'),
      A('c', 'img/coin.png', 'image'),
      A('b', 'audio/bgm.mp3', 'audio'),
      A('t', 'img/atlas.png', 'texture'),
    ]),
    edges: [
      // located edge → a usage entry (node path · component · property)
      { from: 'p', to: 'c', kind: 'sprite-frame', locations: [{ nodePath: 'Canvas/pic_btn_spin', component: 'cc.Sprite', property: '_spriteFrame' }] },
      // location-less custom edge with a plugin label
      { from: 'p', to: 'b', kind: 'audio-call', locations: [], label: 'plays bgm_win' },
      // location-less meta edge, no label → endpoint names
      { from: 't', to: 'c', kind: 'texture', locations: [] },
    ],
  };
  const idx = buildSearchIndex();

  const usage = idx.find((e) => e.kind === 'usage');
  assert.equal(usage.edgeKind, 'sprite-frame');     // the clean ~kind filter dimension
  assert.match(usage.text, /sprite-frame/);          // kind searchable
  assert.match(usage.text, /pic_btn_spin/);          // node path searchable
  assert.match(usage.text, /cc\.Sprite/);            // component searchable (was label-only before)

  const audio = idx.find((e) => e.kind === 'edge' && e.edgeKind === 'audio-call');
  assert.ok(audio, 'location-less custom edge becomes an edge entry');
  assert.equal(audio.label, 'plays bgm_win');        // plugin-supplied label used
  assert.equal(audio.target, 'b');
  assert.match(audio.text, /audio-call/);

  const tex = idx.find((e) => e.kind === 'edge' && e.edgeKind === 'texture');
  assert.equal(tex.label, 'atlas.png → coin.png');   // no label → endpoint basenames

  S.scan = null; // tidy the shared singleton
});
