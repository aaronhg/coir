// Tests `coir duplicates` end-to-end (src/core/duplicates.js via the CLI): byte-
// identical files (with a mergeable flag from import settings) and structurally
// identical configs (prefab/material normalized past their volatile fileIds).
// Self-contained temp fixture, no real project.
//   node --test test/duplicates.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'src', 'cli.js');
let dir;

async function asset(rel, content, meta) {
  const abs = path.join(dir, 'assets', rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
  await fs.writeFile(`${abs}.meta`, JSON.stringify(meta));
}

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'coir-dup-'));
  await fs.mkdir(path.join(dir, 'assets'), { recursive: true });
  // byte-identical pair, identical meta → mergeable
  await asset('ui/coin.png', 'PNGDATA_COIN_AAAA', { importer: 'image', uuid: 'aaaaaaaa-0000-0000-0000-000000000001' });
  await asset('hud/coin.png', 'PNGDATA_COIN_AAAA', { importer: 'image', uuid: 'aaaaaaaa-0000-0000-0000-000000000002' });
  // byte-identical pair, DIFFERENT import settings → not mergeable
  await asset('ui/star.png', 'PNGDATA_STAR_BB', { importer: 'image', uuid: 'bbbbbbbb-0000-0000-0000-000000000001', userData: { wrapMode: 'clamp' } });
  await asset('hud/star.png', 'PNGDATA_STAR_BB', { importer: 'image', uuid: 'bbbbbbbb-0000-0000-0000-000000000002', userData: { wrapMode: 'repeat' } });
  // a unique file → never grouped
  await asset('ui/uniq.png', 'ZZZ', { importer: 'image', uuid: 'cccccccc-0000-0000-0000-000000000001' });
  // two prefabs identical except their per-node fileId → structural dup
  await asset('p/a.prefab', JSON.stringify([{ __type__: 'cc.Prefab', _name: 'A' }, { __type__: 'cc.Node', _name: 'root', fileId: 'abc123' }]), { importer: 'prefab', uuid: 'dddddddd-0000-0000-0000-000000000001' });
  await asset('p/b.prefab', JSON.stringify([{ __type__: 'cc.Prefab', _name: 'A' }, { __type__: 'cc.Node', _name: 'root', fileId: 'XYZ789' }]), { importer: 'prefab', uuid: 'dddddddd-0000-0000-0000-000000000002' });
  // two materials, byte-DIFFERENT (key order) but structurally identical → a
  // config dup that byte-hashing would miss (the whole point of axis B).
  await asset('p/m1.mtl', JSON.stringify({ __type__: 'cc.Material', _name: 'M', _props: [{}] }), { importer: 'material', uuid: 'eeeeeeee-0000-0000-0000-000000000001' });
  await asset('p/m2.mtl', JSON.stringify({ _name: 'M', _props: [{}], __type__: 'cc.Material' }), { importer: 'material', uuid: 'eeeeeeee-0000-0000-0000-000000000002' });
});
after(async () => { await fs.rm(dir, { recursive: true, force: true }); });

function cli(...args) {
  const r = spawnSync('node', [CLI, '-C', dir, 'duplicates', ...args], { encoding: 'utf8' });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}

test('files: byte-identical pairs grouped; mergeable flag reflects import settings; unique skipped', () => {
  const r = cli('files', '-o', 'json');
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout.trim());
  assert.equal(o.files.length, 2);
  const coin = o.files.find((g) => g.key === 'coin.png');
  const star = o.files.find((g) => g.key === 'star.png');
  assert.ok(coin && star);
  assert.equal(coin.count, 2);
  assert.equal(coin.mergeable, true);
  assert.equal(star.mergeable, false); // differing userData
  assert.ok(star.warnings.includes('import-settings-differ'));
  assert.ok(coin.canonical && coin.redundant.length === 1); // one keep, one drop
  assert.ok(!JSON.stringify(o.files).includes('uniq.png'));
});

test('configs: prefab + material structural duplicates (past volatile fileId)', () => {
  const r = cli('configs', '-o', 'json');
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout.trim());
  assert.equal(o.configs.length, 2);
  const prefab = o.configs.find((g) => g.key === 'prefab');
  const material = o.configs.find((g) => g.key === 'material');
  assert.ok(prefab && prefab.count === 2, 'prefabs grouped despite different fileId');
  assert.ok(material && material.count === 2);
});

test('no section = both axes + a reclaimable total in text output', () => {
  const r = cli();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /files \(byte-identical\)/);
  assert.match(r.stdout, /configs \(structurally identical\)/);
  assert.match(r.stdout, /total reclaimable/);
  assert.match(r.stdout, /swap-uuid/); // points at the merge workflow
});
