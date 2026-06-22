// atlasUtilizationReport (src/core/analyze.js): frame-count utilization PLUS the
// area-weighted utilization + wasted pixel area (from the sprite-frames' sizes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanProject } from '../src/core/scan.js';
import { atlasUtilizationReport } from '../src/core/analyze.js';

const memFP = (files) => ({
  listFiles: async () => Object.keys(files),
  readText: async (p) => files[p],
  size: async (p) => Buffer.byteLength(String(files[p] ?? '')),
});
const meta = (o) => JSON.stringify(o);
const U = (n) => `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-${n}${n}${n}${n}-${n}${n}${n}${n}-${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}`;

test('atlas: area-weighted waste — one big frame unused dwarfs the count ratio', async () => {
  const PL = U('5');
  const scan = await scanProject(memFP({
    'ui.plist': 'PLIST',
    'ui.plist.meta': meta({ importer: 'sprite-atlas', uuid: PL, subMetas: {
      f1: { importer: 'sprite-frame', uuid: `${PL}@f1`, name: 'big', userData: { width: 100, height: 100 } },   // 10000 px²
      f2: { importer: 'sprite-frame', uuid: `${PL}@f2`, name: 'small', userData: { width: 10, height: 10 } },     // 100 px²
    } }),
    // a scene uses ONLY the small frame → half the frames, but ~1% of the area
    'Main.scene': JSON.stringify([{ __type__: 'cc.Scene' }, { __type__: 'cc.Sprite', _spriteFrame: { __uuid__: `${PL}@f2` } }]),
    'Main.scene.meta': meta({ importer: 'scene', uuid: U('3') }),
  }));
  const it = atlasUtilizationReport(scan).items.find((i) => i.path === 'ui.plist');
  assert.ok(it);
  assert.equal(it.total, 2);
  assert.equal(it.used, 1);
  assert.equal(it.ratio, 0.5);                 // frame-count says "half used"…
  assert.equal(it.totalArea, 10100);
  assert.equal(it.usedArea, 100);
  assert.equal(it.wastedArea, 10000);          // …but the big unused frame is the real dead weight
  assert.ok(it.areaRatio < 0.02 && it.areaRatio > 0); // ~0.0099
});

test('atlas: dimensions unknown → area fields are null (no false numbers)', async () => {
  const PL = U('6');
  const scan = await scanProject(memFP({
    'a.plist': 'PLIST',
    'a.plist.meta': meta({ importer: 'sprite-atlas', uuid: PL, subMetas: {
      f1: { importer: 'sprite-frame', uuid: `${PL}@f1`, name: 'a' }, // no userData width/height
      f2: { importer: 'sprite-frame', uuid: `${PL}@f2`, name: 'b' },
    } }),
  }));
  const it = atlasUtilizationReport(scan).items.find((i) => i.path === 'a.plist');
  assert.ok(it);
  assert.equal(it.areaRatio, null);
  assert.equal(it.wastedArea, null);
  assert.equal(it.totalArea, null);
  assert.equal(it.ratio, 0); // count ratio still computed (0 used / 2)
});
