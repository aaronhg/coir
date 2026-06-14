// App entry: wire the directory picker -> core scan -> UI.
import { fsApiSupported, pickProjectDirectory, makeProvider } from './fsapi.js';
import { scanProject } from '../core/scan.js';
import { buildAdjacency } from '../core/graph.js';
import { PLUGINS, dedupePlugins } from '../core/plugins/index.js';
import { initUI } from './ui.js';
import { t } from './i18n.js';

// Runtime plugin registration (browser only — the CLI uses the registry). Call
// `window.coir.use(plugin)` before picking a project; built-ins + runtime
// plugins both feed the scan and the UI (colors/messages).
const runtimePlugins = [];
window.coir = {
  use(plugin) { runtimePlugins.push(plugin); return window.coir; },
  plugins() { return [...PLUGINS, ...runtimePlugins]; },
};

// Browser analogue of the CLI's coir-root global config: fetch coir.plugins.mjs
// served next to the page (the dev server serves it from the repo root). Absent
// on a hosted build (404) → none. webpackIgnore keeps it a NATIVE runtime import,
// not a bundled module. Cached so the in-flight fetch is shared.
let globalPluginsP = null;
function loadGlobalPlugins() {
  if (!globalPluginsP) globalPluginsP = (async () => {
    try {
      const url = new URL('coir.plugins.mjs', document.baseURI).href;
      const mod = await import(/* webpackIgnore: true */ url);
      const exp = mod.default ?? mod.plugins;
      const arr = exp == null ? [] : (Array.isArray(exp) ? exp : [exp]);
      return arr.filter((p) => p && typeof p === 'object');
    } catch { return []; } // not served (hosted), bad MIME, or parse error → none
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
    } catch (e) { console.error(`${name} failed to load:`, e); return []; }
    finally { URL.revokeObjectURL(url); }
  }
  return [];
}

const ui = initUI({ onPick: handlePick });

if (!fsApiSupported()) {
  ui.setStatus(t('err.noFsApi'));
  document.getElementById('pickBtn').disabled = true;
  document.getElementById('welcomeBtn').disabled = true;
}

async function handlePick() {
  try {
    const root = await pickProjectDirectory();
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
    ui.setScan(scan, provider.projectName, plugins);
    // Show the active NON-builtin plugins, each prefixed `source.name`.
    const ext = plugins.filter((p) => !PLUGINS.includes(p)).map((p) => `${srcOf.get(p) || '?'}.${p.name || '(unnamed)'}`);
    if (ext.length) ui.setStatus(t('status.plugins', { names: ext.join(', ') }));
  } catch (e) {
    if (e && e.name === 'AbortError') return; // user cancelled the picker
    console.error(e);
    ui.setStatus(t('status.error', { msg: (e && e.message) || e }));
  }
}
