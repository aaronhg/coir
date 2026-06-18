// Tests the built-in spine plugin's `spine-dup` command (src/core/plugins/spine.js)
// end-to-end on the CLI. Two skeletons each ship their own atlas; both atlases
// pack a region named "glow" (same 100x100) plus a region unique to each. The
// command must surface "glow" (in 2 atlases, used by 2 spines, confidence
// "likely" because dims agree) and must NOT surface the per-atlas regions.
// Whole-file content hashing can't see this — the two page PNGs differ — so this
// is the region-level path. Self-contained: builds a temp project, no real deps.
//   node --test test/spine-dup.test.js
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

// A skeleton (.json, importer spine-data → type 'spine') + its atlas (.atlas,
// wildcard importer '*' → type 'spine-atlas' via typeByExt). `extra`/`extraDim`
// is the region unique to this skeleton; every atlas also carries the shared glow.
async function skeleton(rel, uuid, atlasUuid, extra, extraDim) {
  const aDir = path.join(dir, 'assets', path.dirname(rel));
  await fs.mkdir(aDir, { recursive: true });
  const base = path.join(dir, 'assets', rel);
  await fs.writeFile(`${base}.json`, JSON.stringify({ skeleton: { spine: '3.8.99' } }));
  await fs.writeFile(`${base}.json.meta`, JSON.stringify({ importer: 'spine-data', uuid }));
  const png = `${path.basename(rel)}.png`;
  const atlas = [
    png,
    'size: 256,256',
    'format: RGBA8888',
    'filter: Linear,Linear',
    'repeat: none',
    'glow',
    '  rotate: false',
    '  xy: 2, 2',
    '  size: 100, 100',
    '  orig: 100, 100',
    '  offset: 0, 0',
    '  index: -1',
    extra,
    '  rotate: false',
    '  xy: 2, 104',
    `  size: ${extraDim}, ${extraDim}`,
    `  orig: ${extraDim}, ${extraDim}`,
    '  offset: 0, 0',
    '  index: -1',
    '',
  ].join('\n');
  await fs.writeFile(`${base}.atlas`, atlas);
  await fs.writeFile(`${base}.atlas.meta`, JSON.stringify({ importer: '*', uuid: atlasUuid }));
}

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'coir-spinedup-'));
  await fs.mkdir(path.join(dir, 'assets'), { recursive: true });
  await skeleton('char/hero', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'body_hero', 50);
  await skeleton('char/boss', 'bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000b1', 'body_boss', 60);
});

after(async () => { await fs.rm(dir, { recursive: true, force: true }); });

function cli(...args) {
  const r = spawnSync('node', [CLI, '-C', dir, ...args], { encoding: 'utf8' });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}

test('spine-dup text: reports the shared glow across both atlases, not the unique regions', () => {
  const r = cli('spine-dup');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /glow/);
  assert.match(r.stdout, /in 2 atlases/);
  assert.match(r.stdout, /likely/);          // dims agree (100x100) → corroborated
  assert.match(r.stdout, /char\/hero\.atlas/);
  assert.match(r.stdout, /char\/boss\.atlas/);
  assert.doesNotMatch(r.stdout, /body_hero/); // packed into one atlas only
  assert.doesNotMatch(r.stdout, /body_boss/);
});

test('spine-dup -o json: one group, both atlases + both spines, dims confirmed', () => {
  const r = cli('spine-dup', '-o', 'json');
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout.trim());
  assert.equal(o.total, 1);
  assert.equal(o.atlasesScanned, 2);
  const g = o.groups[0];
  assert.equal(g.name, 'glow');
  assert.equal(g.atlasCount, 2);
  assert.equal(g.dimsConsistent, true);
  assert.equal(g.confidence, 'likely');
  assert.deepEqual(g.dims, ['100x100']);
  assert.deepEqual(g.spines.sort(), ['char/boss.json', 'char/hero.json']);
});
