'use strict';
// coir Cocos Creator 3.8 extension — main (editor) process.
// Runs coir headless IN-PROCESS (cached scan). The asset right-click menu is
// synchronous, so it can't await — we push a compact graph (out-adjacency +
// names) to it (request + broadcast); it BFS's the clicked asset's dependency
// layers locally. `open-topo` encodes the neighborhood into the viewer URL hash.
const path = require('path');
const fs = require('fs');
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
      return { scan, plugins };
    })().catch((e) => { scanP = null; throw e; }); // don't cache a failed scan
  }
  const { scan, plugins } = await scanP;
  return { coir, scan, plugins };
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

// ── plugin asset-menu contributions (anim/skel/…) ────────────────────────────
// A plugin contributes asset right-click menus via `plugin.assetMenus` — its own
// thing, independent of `commands`: each is { ext?, types?, label?, rows(ctx) }.
// The menu render is SYNC, so — exactly like the graph — we precompute every
// matching asset's rows here (eagerly, in the background) and push them;
// assets-menu.js just looks the clicked uuid up. `rows(ctx)` gets the matched
// asset + scan/IO and returns the submenu rows directly.
const rowsCache = new Map(); // `${uuid}:${mtimeMs}` → rows[]  (skips re-parsing unchanged heavy assets, e.g. .skel)

async function mapLimit(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx]); }
  });
  await Promise.all(workers);
}

// uuid → [{ label, rows:[{label}] }]  (one entry per matching asset-menu).
async function assetMenuSnapshot() {
  const { coir, scan, plugins } = await getScan();
  const menus = [];
  for (const p of plugins || []) for (const m of (p.assetMenus || [])) {
    if (m && typeof m.rows === 'function') menus.push(m);
  }
  const out = {};
  if (!menus.length) return out;

  const assetsDir = path.join(Editor.Project.path, 'assets');
  const fp = coir.makeFsProvider(assetsDir);
  const makeCtx = (asset) => ({ asset, scan, projectDir: Editor.Project.path, readText: (rp) => fp.readText(rp) });

  // Flatten (asset-menu × matching asset) into one work list, then run with a cap.
  const jobs = [];
  for (const menu of menus) {
    const exts = (menu.ext || []).map((e) => String(e).toLowerCase());
    const types = new Set(menu.types || []);
    for (const a of scan.assets.values()) {
      if (!a.path) continue;
      const ext = (a.ext || a.path.slice(a.path.lastIndexOf('.'))).toLowerCase();
      if (exts.includes(ext) || types.has(a.type)) jobs.push({ menu, a });
    }
  }

  await mapLimit(jobs, 8, async ({ menu, a }) => {
    let key = `${a.uuid}|${menu.label || ''}`;
    try { key = `${key}:${fs.statSync(path.join(assetsDir, a.path)).mtimeMs}`; } catch (e) { /* mtime unknown → key without it */ }
    let rows = rowsCache.get(key);
    if (!rows) {
      try { rows = (await menu.rows(makeCtx(a))) || []; } catch (e) { rows = []; }
      rowsCache.set(key, rows);
    }
    if (rows.length) (out[a.uuid] || (out[a.uuid] = [])).push({ label: menu.label || 'Coir', rows });
  });
  return out;
}
async function broadcastAssetMenus() {
  try { Editor.Message.broadcast('coir:asset-menus', await assetMenuSnapshot()); }
  catch (e) { console.error('[coir] asset-menus broadcast failed:', e); }
}

let invT = null;
function invalidate() { scanP = null; clearTimeout(invT); invT = setTimeout(() => { broadcastGraph(); broadcastAssetMenus(); }, 300); } // debounce a burst of changes

exports.methods = {
  // The (sync) asset menu primes its graph cache from this on load.
  async allGraph() { try { return await graphSnapshot(); } catch (e) { console.error('[coir] allGraph failed:', e); return { uuids: [], names: [], out: [], inc: [] }; } },
  // …and its plugin asset-menu cache (anim/skel/…) from this.
  async allAssetMenus() { try { return await assetMenuSnapshot(); } catch (e) { console.error('[coir] allAssetMenus failed:', e); return {}; } },
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
  // Open the "跳轉到節點" panel (menu item / shortcut → here). The panel itself
  // does the scene-tree walk + selection; main just opens it.
  async openGoto() {
    try { await Editor.Panel.open('coir.goto'); }
    catch (e) { console.error('[coir] openGoto failed:', e); }
  },
};

exports.load = function () {
  broadcastGraph(); // warm the scan + push the graph so the first right-click has it
  broadcastAssetMenus(); // …and the anim/skel/… submenu rows
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
