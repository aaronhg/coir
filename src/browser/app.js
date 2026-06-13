// App entry: wire the directory picker -> core scan -> UI.
import { fsApiSupported, pickProjectDirectory, makeProvider } from './fsapi.js';
import { scanProject } from '../core/scan.js';
import { buildAdjacency } from '../core/graph.js';
import { initUI } from './ui.js';

const ui = initUI({ onPick: handlePick });

if (!fsApiSupported()) {
  ui.setStatus('此瀏覽器不支援 File System Access API — 請用 Chrome / Edge，並透過 http://localhost 開啟');
  document.getElementById('pickBtn').disabled = true;
}

async function handlePick() {
  try {
    const root = await pickProjectDirectory();
    ui.setStatus('讀取目錄…');
    const provider = await makeProvider(root);
    ui.setStatus(`掃描 ${provider.fileCount} 個檔案…`);
    const scan = await scanProject(provider, { onProgress: ui.onProgress });
    scan.adjacency = buildAdjacency(scan.edges);
    ui.setScan(scan, provider.projectName);
  } catch (e) {
    if (e && e.name === 'AbortError') return; // user cancelled the picker
    console.error(e);
    ui.setStatus('錯誤：' + ((e && e.message) || e));
  }
}
