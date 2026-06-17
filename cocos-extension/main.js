'use strict';
// coir Cocos Creator 3.8 extension — main (editor) process.
// Runs coir headless IN-PROCESS (cached scan). The asset right-click menu is
// synchronous, so it can't await — we push a compact graph (out-adjacency +
// names) to it (request + broadcast); it BFS's the clicked asset's dependency
// layers locally. `open-topo` encodes the neighborhood into the viewer URL hash.
const path = require('path');
const { shell } = require('electron'); // open the OS browser

// coir's embedder API (package.json "exports" → src/index.js). After the
// install.sh symlink / `npm link coir`, 'coir' resolves. Override with COIR_CORE.
const COIR = process.env.COIR_CORE || 'coir';
// Viewer — data rides in the URL hash → hosted build works with no server/upload.
// Point at http://localhost:8080/ for local dev (npm run dev in coir).
const VIEWER = 'https://aaronhg.github.io/coir/';

const base = (p) => p.slice(p.lastIndexOf('/') + 1);

let coirP = null; // import('coir') — cached
let scanP = null; // project scan — cached; invalidated on asset changes
const loadCoir = () => (coirP || (coirP = import(COIR)));

async function getScan() {
  const coir = await loadCoir();
  if (!scanP) {
    scanP = (async () => {
      const fp = coir.makeFsProvider(path.join(Editor.Project.path, 'assets'));
      // Honour coir.plugins.mjs the same way the CLI/browser do: the coir repo-root
      // GLOBAL config (cross-project — e.g. audio-call) + the PROJECT's own, most
      // specific last. Absent → built-ins only. Node caches the import, so edits to
      // either apply on an extension reload, not on a mere re-scan.
      const warn = (m) => console.warn('[coir]', m);
      const globalPlugins = coir.COIR_ROOT ? await coir.loadConfigPlugins(coir.COIR_ROOT, warn) : [];
      const projectPlugins = await coir.loadConfigPlugins(Editor.Project.path, warn);
      const srcOf = new Map(); // plugin object → source tag (project set last, so it wins on dedupe)
      for (const p of globalPlugins) srcOf.set(p, 'global');
      for (const p of projectPlugins) srcOf.set(p, 'project');
      const plugins = coir.dedupePlugins([...coir.PLUGINS, ...globalPlugins, ...projectPlugins]);
      // Log only the plugins that actually took effect (non-built-in, post-dedupe),
      // each tagged `source.name` — same as the browser UI's status line.
      const active = plugins.filter((p) => !coir.PLUGINS.includes(p)).map((p) => `${srcOf.get(p) || '?'}.${p.name || '(unnamed)'}`);
      if (active.length) console.log(`[coir] plugins: ${active.join(', ')}`);
      const scan = await coir.scanProject(fp, { plugins });
      scan.adjacency = coir.buildAdjacency(scan.edges);
      return scan;
    })().catch((e) => { scanP = null; throw e; }); // don't cache a failed scan
  }
  return { coir, scan: await scanP };
}

// Compact, integer-indexed out-graph for the (sync) menu: parallel arrays
// uuids[i] / names[i] / out[i] = [neighbour indices].
async function graphSnapshot() {
  const { scan } = await getScan();
  const uuids = [...scan.assets.keys()];
  const idx = new Map(uuids.map((u, i) => [u, i]));
  const names = uuids.map((u) => base(scan.assets.get(u).path));
  const out = uuids.map((u) => { // dependencies (→ uses)
    const set = new Set();
    for (const n of scan.adjacency.out.get(u) || []) { const j = idx.get(n.to); if (j !== undefined) set.add(j); }
    return [...set];
  });
  const inc = uuids.map((u) => { // dependents (← used-by)
    const set = new Set();
    for (const n of scan.adjacency.inc.get(u) || []) { const j = idx.get(n.from); if (j !== undefined) set.add(j); }
    return [...set];
  });
  return { uuids, names, out, inc };
}
async function broadcastGraph() {
  try { Editor.Message.broadcast('coir:graph', await graphSnapshot()); }
  catch (e) { console.error('[coir] graph broadcast failed:', e); }
}
let invT = null;
function invalidate() { scanP = null; clearTimeout(invT); invT = setTimeout(broadcastGraph, 300); } // debounce a burst of changes

exports.methods = {
  // The (sync) asset menu primes its graph cache from this on load.
  async allGraph() { try { return await graphSnapshot(); } catch (e) { console.error('[coir] allGraph failed:', e); return { uuids: [], names: [], out: [], inc: [] }; } },
  // Encode this asset's neighborhood → open the topology viewer at #topo=<blob>.
  async openTopo(uuid) {
    try {
      const { coir, scan } = await getScan();
      if (!scan.assets.has(uuid)) { console.warn('[coir] asset not in scan:', uuid); return; }
      const r = await coir.encodeTopo(scan, uuid, { title: path.basename(Editor.Project.path) });
      if (r.over) console.warn('[coir] snapshot over the size cap even at depth 1 — the link will be large');
      await shell.openExternal(`${VIEWER}#topo=${r.blob}`);
    } catch (e) { console.error('[coir] openTopo failed:', e); }
  },
};

exports.load = function () {
  broadcastGraph(); // warm the scan + push the graph so the first right-click has it
  // Invalidate on project changes so the menu stays live.
  // NOTE: confirm these broadcast names against the 3.8 asset-db message docs.
  for (const ev of ['asset-add', 'asset-change', 'asset-delete']) {
    try { Editor.Message.addBroadcastListener(`asset-db:${ev}`, invalidate); } catch (e) { /* name differs on this build */ }
  }
};
exports.unload = function () {
  for (const ev of ['asset-add', 'asset-change', 'asset-delete']) {
    try { Editor.Message.removeBroadcastListener(`asset-db:${ev}`, invalidate); } catch (e) { /* */ }
  }
};
