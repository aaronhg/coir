// Headless validation: run the browser-agnostic core against a real on-disk
// Cocos project and print a summary + spot-checks.
//
//   node test/node-run.js <projectDir> [centerUuidOrPath]
//
// <projectDir> is a Cocos project root (must contain an assets/ folder).

import path from 'node:path';
import { scanProject } from '../src/core/scan.js';
import { buildAdjacency } from '../src/core/graph.js';
import {
  summary, unusedReport, orphanRefReport, atlasUtilizationReport, sizeReport, closureReport,
} from '../src/core/analyze.js';
import { fileURLToPath } from 'node:url';
import { makeFsProvider } from '../src/node/fsProvider.js';
import { PLUGINS, dedupePlugins } from '../src/core/plugins/index.js';
import { loadConfigPlugins } from '../src/node/loadPlugins.js';

const COIR_ROOT = fileURLToPath(new URL('../', import.meta.url)); // <repo>/ (node-run.js is in test/)
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

async function main() {
  const projectDir = process.argv[2];
  if (!projectDir) { console.error('usage: node test/node-run.js <projectDir> [center]'); process.exit(1); }
  const assetsRoot = path.join(projectDir, 'assets');

  const sameAsRoot = path.resolve(projectDir) === path.resolve(COIR_ROOT);
  const plugins = dedupePlugins([
    ...PLUGINS,
    ...await loadConfigPlugins(COIR_ROOT),
    ...(sameAsRoot ? [] : await loadConfigPlugins(projectDir)),
  ]);

  const t0 = Date.now();
  const scan = await scanProject(makeFsProvider(assetsRoot), {
    plugins,
    env: 'cli',
    onProgress: ({ phase, done, total }) => {
      if (done === total) process.stderr.write(`  ${phase}: ${done}/${total}\n`);
    },
  });
  scan.adjacency = buildAdjacency(scan.edges);
  const ms = Date.now() - t0;

  const s = summary(scan);
  console.log(`\n=== ${path.basename(projectDir)} — scanned in ${ms}ms ===`);
  console.log(`assets=${s.assets} edges=${s.edges} orphanRefs=${s.orphanRefs} metaErrors=${s.metaErrors}`);
  console.log('by type:', Object.entries(s.byType).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('  '));

  // Edge kind histogram.
  const kinds = {};
  for (const e of scan.edges) kinds[e.kind] = (kinds[e.kind] || 0) + 1;
  console.log('edge kinds:', Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('  '));

  const unused = unusedReport(scan);
  console.log(`\n[unused] ${unused.items.length} non-resources assets with 0 referrers (${kb(unused.totalSize)})`);
  console.log('  by type:', JSON.stringify(unused.byType));
  for (const i of unused.items.slice(0, 8)) console.log(`   - ${i.type.padEnd(8)} ${kb(i.size).padStart(10)}  ${i.path}`);

  const orphans = orphanRefReport(scan);
  console.log(`\n[orphan refs] ${orphans.total} dangling uuid targets`);
  for (const i of orphans.items.slice(0, 5)) console.log(`   - ${i.ref}  <- ${i.count} referrer(s), e.g. ${i.referrers[0]}`);

  const atlas = atlasUtilizationReport(scan);
  console.log(`\n[atlas utilization] ${atlas.items.length} atlases/multi-frame images`);
  for (const i of atlas.items.slice(0, 10)) {
    const tag = !i.referenced ? '[unreferenced]' : i.wholeReferenced ? '[whole/dynamic]' : '';
    console.log(`   - ${(i.used + '/' + i.total).padStart(8)} used (${(i.ratio * 100).toFixed(0)}%) ${tag.padEnd(15)} ${i.path}`);
  }

  const size = sizeReport(scan);
  console.log('\n[size] per-type totals:');
  for (const [t, v] of Object.entries(size.byType).sort((a, b) => b[1].size - a[1].size)) {
    console.log(`   - ${t.padEnd(8)} ${String(v.count).padStart(4)} files  ${kb(v.size).padStart(11)}`);
  }
  console.log(`   total: ${kb(size.totalSize)}`);

  // Closure for a chosen center (default: first scene).
  let center = process.argv[3];
  if (center && !scan.assets.has(center)) {
    const hit = [...scan.assets.values()].find((a) => a.path === center || a.path.endsWith('/' + center) || a.path.endsWith(center));
    center = hit && hit.uuid;
  }
  if (!center) center = ([...scan.assets.values()].find((a) => a.type === 'scene') || {}).uuid;
  if (center) {
    const c = closureReport(scan, center);
    console.log(`\n[closure] ${c.root} pulls in ${c.count} assets (${kb(c.totalSize)})`);
    console.log('  by type:', JSON.stringify(c.byType));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
