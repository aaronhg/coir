// App entry: wire the directory picker -> core scan -> UI.
import { fsApiSupported, pickProjectDirectory, makeProvider } from './fsapi.js';
import { scanProject } from '../core/scan.js';
import { buildAdjacency } from '../core/graph.js';
import { initUI } from './ui.js';
import { t } from './i18n.js';

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
    const scan = await scanProject(provider, { onProgress: ui.onProgress });
    scan.adjacency = buildAdjacency(scan.edges);
    ui.setScan(scan, provider.projectName);
  } catch (e) {
    if (e && e.name === 'AbortError') return; // user cancelled the picker
    console.error(e);
    ui.setStatus(t('status.error', { msg: (e && e.message) || e }));
  }
}
