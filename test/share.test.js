// Tests `coir share <asset>` (src/cli.js + seam/shared.js `shareData`): produces a
// shareable #topo= snapshot link of an asset's dependency neighbourhood, and the
// blob round-trips through decodeTopo. Self-contained temp fixture.
//   node --test test/share.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeTopo } from '../src/core/topohash.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'src', 'cli.js');
const PNG = 'aaaaaaaa-0000-0000-0000-0000000000a1';
const PREFAB = 'bbbbbbbb-0000-0000-0000-0000000000b1';
let dir;

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'coir-share-'));
  await fs.mkdir(path.join(dir, 'assets', 'ui'), { recursive: true });
  await fs.writeFile(path.join(dir, 'assets', 'ui', 'Coin.png'), 'PNG');
  await fs.writeFile(path.join(dir, 'assets', 'ui', 'Coin.png.meta'), JSON.stringify({ importer: 'image', uuid: PNG }));
  // a prefab that references the png (a real __uuid__ edge → a 2-node neighbourhood)
  await fs.writeFile(path.join(dir, 'assets', 'ui', 'Coin.prefab'), JSON.stringify([{ __type__: 'cc.Node', _name: 'Coin', icon: { __uuid__: PNG } }]));
  await fs.writeFile(path.join(dir, 'assets', 'ui', 'Coin.prefab.meta'), JSON.stringify({ importer: 'prefab', uuid: PREFAB }));
});
after(async () => { await fs.rm(dir, { recursive: true, force: true }); });

function cli(...args) {
  const r = spawnSync('node', [CLI, '-C', dir, 'share', ...args], { encoding: 'utf8' });
  return { stdout: (r.stdout || '').trim(), stderr: r.stderr || '', status: r.status };
}

test('default output is the hosted viewer URL with a #topo= blob', () => {
  const r = cli('ui/Coin.prefab');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^https:\/\/aaronhg\.github\.io\/coir\/#topo=.+/);
});

test('--base overrides the viewer; --blob gives the bare fragment', () => {
  assert.match(cli('ui/Coin.prefab', '--base', 'http://localhost:8080/').stdout, /^http:\/\/localhost:8080\/#topo=/);
  assert.match(cli('ui/Coin.prefab', '--blob').stdout, /^#topo=.+/);
});

test('-o json: centre + blob, and the blob decodes back to the centred neighbourhood', async () => {
  const r = cli('ui/Coin.prefab', '-o', 'json');
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout);
  assert.equal(o.center, PREFAB);
  assert.ok(o.url.includes('#topo=') && o.blob && o.nodes >= 2);
  const payload = await decodeTopo(o.blob);
  const paths = (payload.n || []).map((nd) => nd[0]);
  assert.ok(paths.includes('ui/Coin.prefab') && paths.includes('ui/Coin.png'), 'snapshot holds the prefab + its texture');
});
