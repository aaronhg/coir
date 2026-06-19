// Validates the dynamic-edge recipe pattern (the resources-load plugin now lives
// in the external coir-plugins repo; this re-implements its core inline so the
// test stays self-contained / CI-safe) — a component calling resources.load gets
// `resource-load` edges to the loaded assets, so they gain a referrer. Exercises
// ctx.bundles / ctx.files / ctx.readText / ctx.byPath / ctx.addEdge / ctx.addNode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanProject } from '../src/core/scan.js';
import { PLUGINS } from '../src/core/plugins/index.js';

const memFP = (files) => ({
  listFiles: async () => Object.keys(files),
  readText: async (p) => files[p],
  size: async (p) => Buffer.byteLength(String(files[p] ?? '')),
});
const meta = (o) => JSON.stringify(o);
const U = (n) => `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-${n}${n}${n}${n}-${n}${n}${n}${n}-${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}`;

// The recipe's core (see coir-plugins/resources-load.mjs): scan .ts for literal
// resources.load/loadDir, resolve via an ext-less index, add `resource-load` edges.
const resourcesLoad = {
  name: 'resources-load',
  async edges(ctx) {
    const byNoExt = new Map();
    for (const a of ctx.assets.values()) if (a.hasSource) byNoExt.set(a.path.replace(/\.[^/.]+$/, ''), a);
    const RE = /\bresources\.(load|loadDir)\s*\(\s*['"`]([^'"`]+)['"`]/g;
    const srcs = ctx.files.filter((f) => /\.ts$/.test(f) && !f.endsWith('.d.ts'));
    await ctx.mapLimit(srcs, 16, async (path) => {
      let text; try { text = await ctx.readText(path); } catch { return; }
      const asset = ctx.byPath.get(path);
      const from = asset ? asset.uuid : ctx.addNode({ path: 'dynamic-load', type: 'dynamic' });
      for (const [, kind, rel] of text.matchAll(RE)) {
        const targets = kind === 'loadDir'
          ? [...byNoExt].filter(([p]) => p.startsWith(`resources/${rel}/`)).map(([, a]) => a)
          : [byNoExt.get(`resources/${rel}`)];
        for (const t of targets) if (t) ctx.addEdge(from, t.uuid, 'resource-load', null, `resources.${kind}('${rel}')`);
      }
    });
  },
};

test('dynamic edges: resources.load/loadDir literals become resource-load edges', async () => {
  const COIN = U('2'), BGM = U('3');
  const files = {
    'scripts/Loader.ts': "import { Component, resources } from 'cc';\nexport class Loader extends Component { start(){ resources.load('ui/Coin'); resources.loadDir('audio'); } }",
    'scripts/Loader.ts.meta': meta({ importer: 'typescript', uuid: U('1') }),
    'resources/ui/Coin.png': 'PNG', 'resources/ui/Coin.png.meta': meta({ importer: 'image', uuid: COIN }),
    'resources/audio/bgm.mp3': 'MP3', 'resources/audio/bgm.mp3.meta': meta({ importer: 'audio-clip', uuid: BGM }),
  };
  const scan = await scanProject(memFP(files), { plugins: [...PLUGINS, resourcesLoad] });

  const loader = [...scan.assets.values()].find((a) => a.path === 'scripts/Loader.ts');
  assert.ok(loader, 'the component loader stays in the index');
  const e = scan.edges.find((x) => x.from === loader.uuid && x.to === COIN);
  assert.ok(e && e.kind === 'resource-load', "resources.load('ui/Coin') → an edge to Coin.png");
  assert.ok(scan.edges.some((x) => x.from === loader.uuid && x.to === BGM && x.kind === 'resource-load'), "loadDir('audio') reaches bgm.mp3");

  // the loaded asset now has a referrer → not a false "unused"
  assert.equal(scan.assets.get(COIN).in, 1);
});

test('PluginContext exposes ctx.bundles (the descriptor list)', async () => {
  let seen = null;
  const probe = { name: 'probe', edges: (ctx) => { seen = ctx.bundles; } };
  await scanProject(memFP({ 'x.png': 'A', 'x.png.meta': meta({ importer: 'image', uuid: U('1') }) }), { plugins: [probe] });
  assert.ok(Array.isArray(seen) && seen.some((b) => b.name === 'main'), 'ctx.bundles is the bundle descriptor array');
});
