'use strict';
// Asset right-click menu (Assets panel, renderer). MUST return synchronously, so
// it BFS's a cached graph (pushed by main: primed via request, kept fresh via the
// `coir:graph` broadcast). Builds:
//   Coir 依賴拓撲  ←a →b→c          (← dependents layers · → dependencies layers)
//     開啟拓撲圖                      → open the topology viewer (URL hash)
//     ←層1 <name> …                  → select/reveal that dependent in the Assets panel
//     →層1 <name> …                  → … that dependency
// If the asset has no dependents AND no dependencies, it's a FLAT item (no ▸) that
// opens the topology directly on click. (A submenu item can't also fire on click,
// so when there IS a submenu, "open" is its first entry.)
const DEPTH = 2;  // layers to list per direction
const CAP = 25;   // max items per layer (keep the menu sane)

// i18n via the editor (follows its language); falls back to zh-Hant if the
// extension's i18n/ isn't loaded.
const T = (k, fb) => { try { const s = Editor.I18n.t(`coir.${k}`); return s && s !== `coir.${k}` ? s : fb; } catch (e) { return fb; } };

let G = null;     // { uuids, names, out, inc, idx }
const setGraph = (g) => { if (g && g.uuids) { g.idx = new Map(g.uuids.map((u, i) => [u, i])); G = g; } };
try {
  Editor.Message.request('coir', 'all-graph').then(setGraph).catch(() => {}); // prime
  Editor.Message.addBroadcastListener('coir:graph', setGraph);                 // refresh
} catch (e) { /* messaging unavailable → menu still opens the topology */ }

// BFS from node index `i` over G[dir] ('out' = dependencies, 'inc' = dependents)
// → [layer1 indices, layer2 indices, …] up to DEPTH.
function layersOf(i, dir) {
  const adj = (G && G[dir]) || [];
  const seen = new Set([i]);
  const layers = [];
  let frontier = [i];
  for (let d = 1; d <= DEPTH; d++) {
    const next = [];
    for (const u of frontier) for (const v of adj[u] || []) if (!seen.has(v)) { seen.add(v); next.push(v); }
    if (!next.length) break;
    layers.push(next);
    frontier = next;
  }
  return layers;
}

exports.onAssetMenu = function (assetInfo) {
  if (!assetInfo || assetInfo.isDirectory) return [];
  const openTopo = () => Editor.Message.request('coir', 'open-topo', assetInfo.uuid);

  const i = G ? G.idx.get(assetInfo.uuid) : undefined;
  const dependents = i === undefined ? [] : layersOf(i, 'inc');   // ← used-by
  const deps = i === undefined ? [] : layersOf(i, 'out');         // → uses

  const title = T('menu_title', 'Coir 依賴拓撲');
  // Nothing to list (no neighbours, or cold cache) → flat item, click opens the topology.
  if (!dependents.length && !deps.length) return [{ label: title, click: openTopo }];

  const parts = [];
  if (dependents.length) parts.push(`←${dependents.map((l) => l.length).join('←')}`);
  if (deps.length) parts.push(`→${deps.map((l) => l.length).join('→')}`);

  const layer = T('layer', '層');
  const submenu = [{ label: T('open', '開啟拓撲圖'), click: openTopo }];
  const addLayers = (layers, arrow) => layers.forEach((lyr, li) => {
    for (const v of lyr.slice(0, CAP)) {
      const uuid = G.uuids[v];
      submenu.push({ label: `${arrow}${layer}${li + 1} ${G.names[v]}`, click() { Editor.Selection.select('asset', uuid); } });
    }
    if (lyr.length > CAP) submenu.push({ label: `${arrow}${layer}${li + 1}  …+${lyr.length - CAP}`, enabled: false });
  });
  addLayers(dependents, '←');
  addLayers(deps, '→');

  return [{ label: `${title}  ${parts.join(' ')}`, submenu }];
};
