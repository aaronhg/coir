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
    } catch (e) { console.error('coir: global coir.plugins.mjs failed to parse —', e); return []; }
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
