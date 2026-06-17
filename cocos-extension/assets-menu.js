'use strict';
// Asset right-click menu (Assets panel, renderer). MUST return synchronously, so
// it BFS's a cached graph (pushed by main: primed via request, kept fresh via the
// `coir:graph` broadcast). Builds:
//   Coir 依賴拓撲  ←L2 ←L1 →L1 →L2  (centre-spread: dependents fan left, deps right)
//     開啟拓撲圖                      → open the topology viewer (URL hash)
//     → <name>                       → a dependency; depth shown by INDENT (not "層N"):
//         → <name>                     L1 flush, each deeper layer one tab in (L2 under L1)
//     ← <name>                       → a dependent, listed the same way
// If the asset has no dependents AND no dependencies, it's a FLAT item (no ▸) that
// opens the topology directly on click. (A submenu item can't also fire on click,
// so when there IS a submenu, "open" is its first entry.)
const DEPTH = 2;  // layers to list per direction
const PAD = '    '; // one indent level — NBSP×4 so the editor doesn't collapse leading whitespace

// i18n via the editor (follows its language); falls back to zh-Hant if the
// extension's i18n/ isn't loaded.
const T = (k, fb) => { try { const s = Editor.I18n.t(`coir.${k}`); return s && s !== `coir.${k}` ? s : fb; } catch (e) { return fb; } };

let G = null;     // { uuids, names, out, inc, idx }
const setGraph = (g) => { if (g && g.uuids) { g.idx = new Map(g.uuids.map((u, i) => [u, i])); G = g; } };
try {
  Editor.Message.request('coir', 'all-graph').then(setGraph).catch(() => {}); // prime
  Editor.Message.addBroadcastListener('coir:graph', setGraph);                 // refresh
} catch (e) { /* messaging unavailable → menu still opens the topology */ }

// Depth-limited (≤ DEPTH) tree from node `i` over G[dir] ('out' = dependencies,
// 'inc' = dependents). BFS first → each node's SHALLOWEST depth + its parent; then
// a pre-order walk emits {v, depth} with a node's deeper children listed right
// after it (so an L2 sits under its L1 parent). No cap — every neighbour is listed.
function treeOf(i, dir) {
  const adj = (G && G[dir]) || [];
  const depth = new Map([[i, 0]]);
  const kids = new Map(); // parent index → [child index] (BFS discovery order)
  let frontier = [i];
  for (let d = 1; d <= DEPTH; d++) {
    const next = [];
    for (const u of frontier) for (const v of adj[u] || []) {
      if (depth.has(v)) continue; // first (shallowest) parent wins
      depth.set(v, d);
      let arr = kids.get(u); if (!arr) kids.set(u, arr = []);
      arr.push(v);
      next.push(v);
    }
    if (!next.length) break;
    frontier = next;
  }
  const out = [];
  (function walk(u) {
    for (const v of kids.get(u) || []) { out.push({ v, depth: depth.get(v) }); walk(v); }
  })(i);
  return out;
}

exports.onAssetMenu = function (assetInfo) {
  if (!assetInfo || assetInfo.isDirectory) return [];
  const openTopo = () => Editor.Message.request('coir', 'open-topo', assetInfo.uuid);

  const i = G ? G.idx.get(assetInfo.uuid) : undefined;
  const dependents = i === undefined ? [] : treeOf(i, 'inc');   // ← used-by
  const deps = i === undefined ? [] : treeOf(i, 'out');         // → uses

  const title = T('menu_title', 'Coir 依賴拓撲');
  // Nothing to list (no neighbours, or cold cache) → flat item, click opens the topology.
  if (!dependents.length && !deps.length) return [{ label: title, click: openTopo }];

  // Header spreads around the (unshown) centre, one token per layer: dependents fan
  // LEFT deepest→shallowest, dependencies fan RIGHT shallowest→deepest — e.g.
  // "←L2 ←L1 →L1 →L2" (each Ln = that layer's count).
  const counts = (tree) => { // → [L1 count, L2 count, …]
    const m = new Map();
    for (const n of tree) m.set(n.depth, (m.get(n.depth) || 0) + 1);
    return [...m.keys()].sort((a, b) => a - b).map((d) => m.get(d));
  };
  const tokens = [];
  counts(dependents).reverse().forEach((c) => tokens.push(`←${c}`));
  counts(deps).forEach((c) => tokens.push(`→${c}`));

  // Depth shown by INDENT (not "層N"): both directions are a normal tree — L1 flush,
  // each deeper layer one tab further in, an L2 nested under its L1 parent.
  const submenu = [{ label: T('open', '開啟拓撲圖'), click: openTopo }];
  const emit = (tree, arrow) => {
    for (const n of tree) {
      const pad = PAD.repeat(n.depth - 1);
      const uuid = G.uuids[n.v];
      submenu.push({ label: `${pad}${arrow} ${G.names[n.v]}`, click() { Editor.Selection.select('asset', uuid); } });
    }
  };
  emit(deps, '→');
  emit(dependents, '←');

  return [{ label: `${title}  ${tokens.join(' ')}`, submenu }];
};
