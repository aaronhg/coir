// Unit tests for the .atlas region parser that backs spine-dup's crop specs
// (src/core/plugins/spine.js). The geometry is the riskiest part of Phase 2: the
// page rect must be ready to crop (rotated regions swap on the page), while the
// match dims stay rotation-independent. Pure — no scan, no DOM, no subprocess.
//   node --test test/spine-regions.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import spine, { parseAtlasRegions } from '../src/core/plugins/spine.js';

test('classic: page rect from xy/size, original from orig; page-header size ignored', () => {
  const atlas = [
    'sheet.png', 'size: 256,256', 'format: RGBA8888', 'filter: Linear,Linear', 'repeat: none',
    'glow', '  rotate: false', '  xy: 4, 8', '  size: 100, 60', '  orig: 100, 60', '  offset: 0, 0', '  index: -1',
    '',
  ].join('\n');
  const r = parseAtlasRegions(atlas);
  assert.equal(r.length, 1); // the page's own "size: 256,256" must NOT become a region
  assert.deepEqual(
    { name: r[0].name, page: r[0].page, x: r[0].x, y: r[0].y, w: r[0].w, h: r[0].h, rotate: r[0].rotate, mw: r[0].mw, mh: r[0].mh },
    { name: 'glow', page: 'sheet.png', x: 4, y: 8, w: 100, h: 60, rotate: false, mw: 100, mh: 60 },
  );
});

test('rotated classic region: on-page rect is size SWAPPED; match dims stay original', () => {
  const atlas = ['sheet.png', 'size: 256,256', 'gun', '  rotate: true', '  xy: 2, 2', '  size: 100, 40', '  orig: 100, 40', ''].join('\n');
  const [g] = parseAtlasRegions(atlas);
  assert.equal(g.rotate, true);
  assert.equal(g.w, 40); assert.equal(g.h, 100); // swapped on the page
  assert.equal(g.mw, 100); assert.equal(g.mh, 40); // original orientation, rotation-independent
});

test('new format: bounds is the page rect as-is, offsets carries the original size', () => {
  const atlas = ['sheet.png', 'size: 256, 256', 'spark', '  bounds: 10, 20, 50, 30', '  offsets: 1, 2, 64, 48', ''].join('\n');
  const [s] = parseAtlasRegions(atlas);
  assert.equal(s.x, 10); assert.equal(s.y, 20);
  assert.equal(s.w, 50); assert.equal(s.h, 30);
  assert.equal(s.mw, 64); assert.equal(s.mh, 48);
});

test('multiple regions per page; a region name ends the previous one', () => {
  const atlas = ['p.png', 'a', '  xy: 0,0', '  size: 8,8', '  orig: 8,8', 'b', '  xy: 8,0', '  size: 8,8', '  orig: 8,8'].join('\n');
  assert.deepEqual(parseAtlasRegions(atlas).map((x) => x.name), ['a', 'b']);
});

// The `reports` hook (Plugin.reports) — the browser-facing P2 contract. build()
// must return VisualReport groups whose members carry a CropSpec (page path +
// rect + focus uuid), so the host can draw thumbnails / confirm by pixels. Pure:
// a fake scan + an in-memory readText, no DOM.
test('reports hook: build() yields a VisualReport with per-member crop specs', async () => {
  const mk = (uuid, path, type) => ({ uuid, path, type, hasSource: true });
  const scan = {
    assets: new Map([
      ['A', mk('A', 'char/hero.atlas', 'spine-atlas')],
      ['B', mk('B', 'char/boss.atlas', 'spine-atlas')],
      ['SA', mk('SA', 'char/hero.json', 'spine')],
      ['SB', mk('SB', 'char/boss.json', 'spine')],
    ]),
    edges: [
      { from: 'SA', to: 'A', kind: 'spine-atlas' },
      { from: 'SB', to: 'B', kind: 'spine-atlas' },
    ],
  };
  const texts = {
    'char/hero.atlas': 'hero.png\nsize: 256,256\nglow\n  rotate: false\n  xy: 2, 2\n  size: 100, 100\n  orig: 100, 100\nbody_h\n  xy: 2,104\n  size: 50,50\n  orig: 50,50\n',
    'char/boss.atlas': 'boss.png\nsize: 256,256\nglow\n  rotate: false\n  xy: 5, 5\n  size: 100, 100\n  orig: 100, 100\nbody_b\n  xy: 2,104\n  size: 60,60\n  orig: 60,60\n',
  };
  const sec = spine.reports.find((r) => r.id === 'spine-dup');
  const report = await sec.build({ scan, readText: async (p) => texts[p] });

  assert.equal(report.groups.length, 1);
  const g = report.groups[0];
  assert.equal(g.key, 'glow');
  assert.equal(g.badge, 'likely'); // dims agree → likely (host confirms to confirmed/different)
  assert.equal(g.members.length, 2);
  const byUuid = Object.fromEntries(g.members.map((m) => [m.focusUuid, m]));
  assert.deepEqual(byUuid.A.crop, { page: 'char/hero.png', x: 2, y: 2, w: 100, h: 100, rotate: false });
  assert.deepEqual(byUuid.B.crop, { page: 'char/boss.png', x: 5, y: 5, w: 100, h: 100, rotate: false });
});
