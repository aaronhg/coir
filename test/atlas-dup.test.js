// Tests the atlas plugin's `.plist` frame parser + `atlas-dup` (same frame packed
// into more than one .plist sprite-atlas) — the Cocos analogue of spine-dup.
// Parser unit tests (format 2/3, rotated) + the reports-hook crop-spec contract
// (pure) + an end-to-end CLI run on a temp fixture.
//   node --test test/atlas-dup.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import atlas, { parsePlistFrames } from '../src/core/plugins/atlas.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'src', 'cli.js');

// minimal format-2 .plist with the given frames; each `frames[i] = [name, rectStr, srcStr, rotated?]`
function plist(texture, frames) {
  const body = frames.map(([n, rect, src, rot]) =>
    `\t\t<key>${n}</key>\n\t\t<dict>\n\t\t\t<key>frame</key>\n\t\t\t<string>${rect}</string>\n` +
    `\t\t\t<key>rotated</key>\n\t\t\t<${rot ? 'true' : 'false'}/>\n` +
    `\t\t\t<key>sourceSize</key>\n\t\t\t<string>${src}</string>\n\t\t</dict>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n\t<key>frames</key>\n\t<dict>\n${body}\n\t</dict>\n` +
    `\t<key>metadata</key>\n\t<dict>\n\t\t<key>format</key>\n\t\t<integer>2</integer>\n\t\t<key>textureFileName</key>\n\t\t<string>${texture}</string>\n\t</dict>\n</dict>\n</plist>\n`;
}

test('parsePlistFrames: page rect, source dims, texture name (format 2)', () => {
  const { texture, frames } = parsePlistFrames(plist('ui.png', [['coin.png', '{{2,2},{32,32}}', '{32,32}']]));
  assert.equal(texture, 'ui.png');
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], { name: 'coin.png', x: 2, y: 2, w: 32, h: 32, rotate: false, mw: 32, mh: 32 });
});

test('parsePlistFrames: a rotated frame swaps the on-page rect; source dims stay', () => {
  const { frames } = parsePlistFrames(plist('ui.png', [['gem.png', '{{4,4},{40,20}}', '{40,20}', true]]));
  assert.equal(frames[0].rotate, true);
  assert.equal(frames[0].w, 20); assert.equal(frames[0].h, 40); // swapped on page
  assert.equal(frames[0].mw, 40); assert.equal(frames[0].mh, 20); // source orientation
});

test('parsePlistFrames: format 3 keys (textureRect / textureRotated / spriteSourceSize)', () => {
  const p = `<plist version="1.0"><dict><key>frames</key><dict>` +
    `<key>star.png</key><dict>` +
    `<key>spriteSourceSize</key><string>{24,24}</string>` +
    `<key>textureRect</key><string>{{8,8},{24,24}}</string>` +
    `<key>textureRotated</key><true/>` +
    `</dict></dict>` +
    `<key>metadata</key><dict><key>realTextureFileName</key><string>sheet.png</string></dict></dict></plist>`;
  const { texture, frames } = parsePlistFrames(p);
  assert.equal(texture, 'sheet.png');
  assert.equal(frames[0].name, 'star.png');
  assert.equal(frames[0].rotate, true);
  assert.equal(frames[0].mw, 24);
});

test('reports hook: build() yields VisualReport with per-frame crop specs', async () => {
  const mk = (uuid, p, type) => ({ uuid, path: p, type, hasSource: true });
  const scan = {
    assets: new Map([['A', mk('A', 'ui/hud.plist', 'atlas')], ['B', mk('B', 'menu/menu.plist', 'atlas')]]),
    edges: [],
  };
  const texts = {
    'ui/hud.plist': plist('hud.png', [['coin.png', '{{2,2},{32,32}}', '{32,32}'], ['hud_bg.png', '{{40,2},{64,64}}', '{64,64}']]),
    'menu/menu.plist': plist('menu.png', [['coin.png', '{{5,5},{32,32}}', '{32,32}'], ['btn.png', '{{40,5},{50,50}}', '{50,50}']]),
  };
  const sec = atlas.reports.find((r) => r.id === 'atlas-dup');
  const report = await sec.build({ scan, readText: async (p) => texts[p] });
  assert.equal(report.groups.length, 1); // only coin.png is shared
  const g = report.groups[0];
  assert.equal(g.key, 'coin.png');
  assert.equal(g.badge, 'likely');
  const byUuid = Object.fromEntries(g.members.map((m) => [m.focusUuid, m]));
  assert.deepEqual(byUuid.A.crop, { page: 'ui/hud.png', x: 2, y: 2, w: 32, h: 32, rotate: false });
  assert.deepEqual(byUuid.B.crop, { page: 'menu/menu.png', x: 5, y: 5, w: 32, h: 32, rotate: false });
});

// ---- CLI end-to-end ----
let dir;
async function atlasAsset(rel, uuid, frames) {
  const abs = path.join(dir, 'assets', rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, plist(`${path.basename(rel, '.plist')}.png`, frames));
  await fs.writeFile(`${abs}.meta`, JSON.stringify({ importer: 'sprite-atlas', uuid }));
}
before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'coir-atlasdup-'));
  await fs.mkdir(path.join(dir, 'assets'), { recursive: true });
  await atlasAsset('ui/hud.plist', 'aaaaaaaa-0000-0000-0000-0000000000a1', [['coin.png', '{{2,2},{32,32}}', '{32,32}'], ['hud_bg.png', '{{40,2},{64,64}}', '{64,64}']]);
  await atlasAsset('menu/menu.plist', 'bbbbbbbb-0000-0000-0000-0000000000b1', [['coin.png', '{{5,5},{32,32}}', '{32,32}'], ['btn.png', '{{40,5},{50,50}}', '{50,50}']]);
});
after(async () => { await fs.rm(dir, { recursive: true, force: true }); });

test('CLI atlas-dup: reports the shared coin frame across both .plist atlases', () => {
  const r = spawnSync('node', [CLI, '-C', dir, 'atlas-dup', '-o', 'json'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout.trim());
  assert.equal(o.total, 1);
  const g = o.groups[0];
  assert.equal(g.name, 'coin.png');
  assert.equal(g.atlasCount, 2);
  assert.equal(g.dimsConsistent, true);
  assert.deepEqual(g.dims, ['32x32']);
});
