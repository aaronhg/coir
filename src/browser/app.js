// App entry: wire the directory picker -> core scan -> UI.
import { fsApiSupported, pickProjectDirectory, makeProvider } from './fsapi.js';
import { scanProject } from '../core/scan.js';
import { buildAdjacency } from '../core/graph.js';
import { decodeTopo } from '../core/topohash.js';
import { PLUGINS, dedupePlugins } from '../core/plugins/index.js';
import { initUI } from './ui.js';
import { t } from './i18n.js';
import { listRecent, addRecent, removeRecent } from './recent.js';

// Runtime plugin registration (browser only — the CLI uses the registry). Call
// `window.coir.use(plugin)` before picking a project; built-ins + runtime
// plugins both feed the scan and the UI (colors/messages).
const runtimePlugins = [];
window.coir = {
  use(plugin) { runtimePlugins.push(plugin); return window.coir; },
  plugins() { return [...PLUGINS, ...runtimePlugins]; },
};

// Browser analogue of the CLI's coir-root global config (coir.plugins.mjs served
// next to the page). It's gitignored, so the dev server is the ONLY place it's
// ever served — a hosted build never has it. Browsers log a 404 for any request
// to a missing URL (fetch included, not just import), so we skip the request
// entirely off-localhost; on localhost we fetch + blob-import. Cached (shared).
const IS_DEV_HOST = ['localhost', '127.0.0.1', '[::1]', ''].includes(location.hostname);
let globalPluginsP = null;
function loadGlobalPlugins() {
  if (!globalPluginsP) globalPluginsP = (async () => {
    if (!IS_DEV_HOST) return []; // hosted build: no global config, don't request it
    const url = new URL('coir.plugins.mjs', document.baseURI).href;
    let res;
    try { res = await fetch(url); } catch { return []; }
    if (!res.ok) { console.info(`coir: no global coir.plugins.mjs (${res.status})`); return []; }
    const blob = URL.createObjectURL(new Blob([await res.text()], { type: 'text/javascript' }));
    try {
      const mod = await import(/* webpackIgnore: true */ blob);
      const exp = mod.default ?? mod.plugins;
      const arr = (exp == null ? [] : (Array.isArray(exp) ? exp : [exp])).filter((p) => p && typeof p === 'object');
      console.info(`coir: global coir.plugins.mjs loaded (${arr.length} plugin${arr.length === 1 ? '' : 's'})`);
      return arr;
    } catch (e) { console.info('coir: global coir.plugins.mjs skipped —', (e && e.message) || e); return []; } // non-fatal: fall back to built-ins
    finally { URL.revokeObjectURL(blob); }
  })();
  return globalPluginsP;
}
loadGlobalPlugins(); // warm it at startup so it's ready by the time a project is picked

// Per-project config: read `coir.plugins.mjs` from the picked directory handle
// (sibling of assets/) and import it via a blob URL — re-read each pick, so edits
// apply on reselect. Only works if the user picked the PROJECT root (not assets/).
async function loadProjectPlugins(root) {
  for (const name of ['coir.plugins.mjs', 'coir.plugins.js']) {
    let text;
    try { text = await (await (await root.getFileHandle(name)).getFile()).text(); }
    catch { continue; } // absent, or the user picked assets/ directly (no parent access)
    const url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
    try {
      const mod = await import(/* webpackIgnore: true */ url);
      const exp = mod.default ?? mod.plugins;
      const arr = exp == null ? [] : (Array.isArray(exp) ? exp : [exp]);
      return arr.filter((p) => p && typeof p === 'object');
    } catch (e) { console.info(`coir: ${name} skipped —`, (e && e.message) || e); return []; } // non-fatal: fall back to built-ins
    finally { URL.revokeObjectURL(url); }
  }
  return [];
}

const ui = initUI({ onPick: handlePick });

// Viewer mode: a `#topo=<blob>` URL carries a topology snapshot → render it
// directly (no File System Access, no project pick). Otherwise the normal flow.
function hashError(e) { // a bad #topo= blob → status line + (when it's still showing) the welcome card
  console.error(e);
  const msg = t('status.error', { msg: (e && e.message) || e });
  ui.setStatus(msg);
  const we = document.getElementById('welcomeErr'), w = document.getElementById('welcome');
  if (we && w && !w.hidden) { we.textContent = msg; we.hidden = false; }
}
function showHashTopo() {
  const m = location.hash.match(/^#topo=(.+)$/);
  if (!m) return false;
  const we = document.getElementById('welcomeErr'); if (we) we.hidden = true; // clear a previous error before retrying
  viewerFromHash(m[1]).catch(hashError);
  return true;
}
if (!showHashTopo()) {
  if (!fsApiSupported()) {
    ui.setStatus(t('err.noFsApi'));
    document.getElementById('pickBtn').disabled = true;
    document.getElementById('welcomeBtn').disabled = true;
  } else {
    renderRecents(); // one-click re-open of previously-picked projects
  }
}
// Live: editing / pasting a new #topo= in the address bar re-renders without a
// reload; clearing it while in the viewer returns to the normal app.
window.addEventListener('hashchange', () => {
  if (showHashTopo()) return;
  if (document.body.classList.contains('viewer')) location.reload();
});

// Scan + render a project from its root directory handle (shared by the picker
// and the recent-projects buttons). Persists the handle on success.
async function openRoot(root) {
  ui.setStatus(t('status.reading'));
  const provider = await makeProvider(root);
  ui.setStatus(t('status.scanning', { n: provider.fileCount }));
  // built-ins → coir-root global → project-local → window.coir.use() runtime
  // (most-specific last; dedupePlugins lets a later same-name plugin override).
  const globalP = await loadGlobalPlugins();
  const projectP = await loadProjectPlugins(root);
  const srcOf = new Map(); // plugin object -> source ('global' | 'project' | 'use')
  for (const p of globalP) srcOf.set(p, 'global');
  for (const p of projectP) srcOf.set(p, 'project');
  for (const p of runtimePlugins) srcOf.set(p, 'use');
  const plugins = dedupePlugins([...PLUGINS, ...globalP, ...projectP, ...runtimePlugins]);
  const scan = await scanProject(provider, { plugins, onProgress: ui.onProgress });
  scan.adjacency = buildAdjacency(scan.edges);
  ui.setScan(scan, provider.projectName, { plugins, provider });
  // Show the active NON-builtin plugins, each prefixed `source.name`.
  const ext = plugins.filter((p) => !PLUGINS.includes(p)).map((p) => `${srcOf.get(p) || '?'}.${p.name || '(unnamed)'}`);
  if (ext.length) ui.setStatus(t('status.plugins', { names: ext.join(', ') }));
  addRecent(root); // remember it (best-effort) for one-click re-open next time
}

async function handlePick() {
  let root;
  try { root = await pickProjectDirectory(); }
  catch (e) { if (e && e.name === 'AbortError') return; console.error(e); ui.setStatus(t('status.error', { msg: (e && e.message) || e })); return; }
  try { await openRoot(root); }
  catch (e) { console.error(e); ui.setStatus(t('status.error', { msg: (e && e.message) || e })); }
}

// Re-open a remembered project: re-check / re-request read permission (the button
// click is the required user gesture), then scan. A vanished folder is dropped.
async function openRecent(it) {
  try {
    const opts = { mode: 'read' };
    let perm = await it.handle.queryPermission(opts);
    if (perm !== 'granted') perm = await it.handle.requestPermission(opts);
    if (perm !== 'granted') { ui.setStatus(t('err.perm')); return; }
    await openRoot(it.handle);
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    console.error(e);
    ui.setStatus(t('status.error', { msg: (e && e.message) || e }));
    if (e && e.name === 'NotFoundError') { await removeRecent(it.id); renderRecents(); } // folder moved/deleted → drop it
  }
}

// List previously-opened projects as buttons on the welcome card.
async function renderRecents() {
  const box = document.getElementById('recentProjects');
  if (!box) return;
  if (!fsApiSupported()) { box.hidden = true; return; }
  const items = await listRecent();
  // Keep only the ones re-openable WITHOUT a permission prompt (still granted);
  // anything else (permission lapsed / folder gone) is purged from IndexedDB.
  const granted = [];
  for (const it of items) {
    let perm = 'denied';
    try { perm = await it.handle.queryPermission({ mode: 'read' }); } catch { /* ignore */ }
    if (perm === 'granted') granted.push(it);
    else removeRecent(it.id);
  }
  box.textContent = '';
  if (!granted.length) { box.hidden = true; return; }
  box.hidden = false;
  const h = document.createElement('div'); h.className = 'recents-h'; h.textContent = t('welcome.recent'); box.appendChild(h);
  for (const it of granted) {
    const b = document.createElement('button'); b.className = 'rbtn'; b.textContent = it.name; b.title = it.name;
    b.onclick = () => openRecent(it);
    box.appendChild(b);
  }
}

// ---- viewer mode (URL-hash topology snapshot) ----------------------------
// Rebuild a scan-like object from a #topo payload (synthetic integer ids,
// no File API). The topology UI consumes it like any scan; `boundary` flags nodes
// whose real neighbours were trimmed, `locMore` edges have usage detail not shipped.
function scanFromPayload(p) {
  const ty = p.ty || [], k = p.k || [], bd = p.bd || [];
  const assets = new Map(), byPath = new Map();
  (p.n || []).forEach((nd, i) => {
    const a = { uuid: String(i), path: nd[0], type: ty[nd[1]] ?? 'orphan', ext: '', importer: '', size: nd[2] || 0, bundle: bd[nd[4]] || null, in: 0, out: 0, subAssets: [], hasSource: true, boundary: nd[3] === 1 };
    assets.set(a.uuid, a); byPath.set(a.path, a);
  });
  const edges = (p.e || []).map(([from, to, kIdx, extra]) => {
    const e = { from: String(from), to: String(to), kind: k[kIdx] ?? '?', weight: 1, locations: [] };
    if (Array.isArray(extra)) e.locations = extra.map((l) => ({ nodePath: l[0] || '', component: l[1] || '', property: l[2] || '', subName: l[3] || '' }));
    else if (extra === 1) e.locMore = true; // has usage detail, omitted from this snapshot
    return e;
  });
  for (const e of edges) { const f = assets.get(e.from), tA = assets.get(e.to); if (f) f.out++; if (tA) tA.in++; }
  return { assets, byPath, edges, orphanRefs: [], metaErrors: [], missing: new Map(), missingReferenced: new Set(), files: [], rootTypes: new Set(), bundles: [], subOwner: new Map(), subUsage: new Map() };
}
async function viewerFromHash(blob) {
  const payload = await decodeTopo(blob);
  const scan = scanFromPayload(payload);
  scan.adjacency = buildAdjacency(scan.edges);
  ui.setScan(scan, payload.t || t('viewer.title'), { viewer: true, center: String(payload.c) });
  ui.setStatus(t('status.snapshot', { n: scan.assets.size }));
}
