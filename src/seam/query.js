// @ts-check
// Pure, side-effect-free data builders for the read/query side — the structured
// (`-o json`) form of each query command, with NO console/exit. cli.js's text
// commands and the MCP server both call these, so the query data model is one
// place. (The CLI's text rendering stays in cli.js; this is the json substance.)
import { mainUuid } from '../core/uuid.js';
import { closureReport, summary, unusedReport, orphanRefReport, droppedMetaReport, atlasUtilizationReport, sizeReport, bundleReport } from '../core/analyze.js';
import { base, edgeSort, orphansOf, locJson } from './shared.js';

/**
 * Direct (1-hop) dependency record for an asset, regardless of any tree depth —
 * the `deps`/`uses` json. `--type` filters the direct neighbours by type;
 * locations come verbatim. (The multi-hop TREE is a text-only concern in cli.js.)
 * @param {any} scan
 * @param {{out:Map<string,any[]>, inc:Map<string,any[]>}} maps  edgeMaps(scan)
 * @param {string} uuid
 * @param {{showOut?:boolean, showIn?:boolean, types?:Set<string>, kinds?:Set<string>, limit?:number}} [opts]
 */
export function depsData(scan, maps, uuid, { showOut = true, showIn = true, types = new Set(), kinds = new Set(), limit = Infinity } = {}) {
  const a = scan.assets.get(uuid);
  const o = { node: a.path, type: a.type, uuid };
  const typeOk = (oa) => !types.size || (oa && types.has(oa.type));
  const kindOk = (e) => !kinds.size || kinds.has(e.kind);
  const side = (dir) => ((dir === 'out' ? maps.out.get(uuid) : maps.inc.get(uuid)) || [])
    .slice().sort(edgeSort(scan, dir))
    .filter((e) => kindOk(e) && typeOk(scan.assets.get(dir === 'out' ? e.to : e.from)))
    .slice(0, limit)
    .map((e) => {
      const oa = scan.assets.get(dir === 'out' ? e.to : e.from);
      return { path: oa.path, type: oa.type, via: e.kind, weight: e.weight,
        locations: e.locations.map((l) => locJson(scan, l)) };
    });
  if (showOut) {
    o.dependsOn = side('out');
    const orph = (types.size || kinds.size) ? [] : orphansOf(scan, uuid);
    if (orph.length) o.orphanRefs = orph.map((x) => {
      const known = scan.missing && scan.missing.get(mainUuid(x.ref));
      return { ref: x.ref, path: known || null, missingSource: !!known, location: x.loc ? locJson(scan, x.loc) : null };
    });
  }
  if (showIn) o.usedBy = side('in');
  return o;
}

// Multi-hop dependency tree from `rootUuid`, following edges in `dir`
// ('out'|'in') up to `depth` hops. ONE global seen-set → a revisited node shows
// once (revisit:true) and is not re-expanded. `kinds` filters edges; `breadth`
// caps neighbours per level (Infinity when type-filtering — pruneTreeByType caps
// the survivors instead). Presentation-free nodes { other, kind, weight,
// locations, depth, revisit, children }. The CLI's text `deps`/`uses` tree AND the
// json (depsTreeData / the MCP deps depth) build on this ONE builder.
/**
 * @param {any} scan @param {{out:Map<string,any[]>, inc:Map<string,any[]>}} maps
 * @param {string} rootUuid @param {'out'|'in'} dir
 * @param {{depth?:number, kinds?:Set<string>, breadth?:number}} [opts]
 */
export function buildEdgeTree(scan, maps, rootUuid, dir, { depth = 1, kinds = new Set(), breadth = Infinity } = {}) {
  const seen = new Set([rootUuid]);
  const kindOk = (e) => !kinds.size || kinds.has(e.kind);
  return (function recur(uuid, d) {
    const edges = ((dir === 'out' ? maps.out.get(uuid) : maps.inc.get(uuid)) || [])
      .filter(kindOk).slice().sort(edgeSort(scan, dir)).slice(0, breadth);
    const nodes = [];
    for (const e of edges) {
      const other = dir === 'out' ? e.to : e.from;
      const revisit = seen.has(other);
      let children = [];
      if (d < depth && !revisit) { seen.add(other); children = recur(other, d + 1); }
      nodes.push({ other, kind: e.kind, weight: e.weight, locations: e.locations || [], depth: d, revisit, children });
    }
    return nodes;
  })(rootUuid, 1);
}
// Keep only branches that REACH one of `types`: a node stays if it (or a kept
// descendant) matches. A revisited (↻) node carries no children, so the first
// (expanded) occurrence's verdict is remembered (`reaches`) and inherited. `limit`
// caps the SURVIVORS per level (post-filter), so a match past `limit` isn't dropped.
export function pruneTreeByType(scan, nodes, types, limit = Infinity, reaches = new Map()) {
  const out = [];
  for (const n of nodes) {
    const kids = pruneTreeByType(scan, n.children, types, limit, reaches);
    const oa = scan.assets.get(n.other);
    const reach = !!((oa && types.has(oa.type)) || kids.length || (n.revisit && reaches.get(n.other)));
    if (!n.revisit) reaches.set(n.other, reach);
    if (reach) out.push({ ...n, children: kids });
  }
  return out.slice(0, limit);
}
function serializeTree(scan, nodes) {
  return nodes.map((n) => {
    const oa = scan.assets.get(n.other);
    return { path: oa ? oa.path : n.other, type: oa ? oa.type : null, uuid: n.other, via: n.kind, weight: n.weight, revisit: n.revisit,
      locations: (n.locations || []).map((l) => locJson(scan, l)), children: serializeTree(scan, n.children) };
  });
}
/**
 * Serializable MULTI-HOP dependency tree — the structured form of the CLI's
 * `deps --depth N` view, so `coir deps -o json --depth N` and the MCP `deps` (with
 * a depth arg) return the SAME shape. depth 1 should use depsData (the flat form).
 * @param {any} scan @param {{out:Map<string,any[]>, inc:Map<string,any[]>}} maps @param {string} uuid
 * @param {{showOut?:boolean, showIn?:boolean, depth?:number, types?:Set<string>, kinds?:Set<string>, limit?:number}} [opts]
 */
export function depsTreeData(scan, maps, uuid, { showOut = true, showIn = true, depth = 2, types = new Set(), kinds = new Set(), limit = Infinity } = {}) {
  const a = scan.assets.get(uuid);
  const side = (dir) => {
    let tree = buildEdgeTree(scan, maps, uuid, dir, { depth, kinds, breadth: types.size ? Infinity : limit });
    if (types.size) tree = pruneTreeByType(scan, tree, types, limit);
    return serializeTree(scan, tree);
  };
  const o = { node: a ? a.path : uuid, type: a ? a.type : null, uuid, depth };
  if (showOut) o.dependsOn = side('out');
  if (showIn) o.usedBy = side('in');
  return o;
}

/**
 * One asset's record (the `info` json): type/uuid/ext/importer/size, degrees,
 * sub-assets, raw meta userData.
 * @param {any} a  an asset record (scan.assets value)
 */
export function infoData(a) {
  return {
    path: a.path, type: a.type, uuid: a.uuid, ext: a.ext, importer: a.importer,
    size: a.size, inResources: a.inResources, bundle: a.bundle ?? null, in: a.in, out: a.out,
    subAssets: a.subAssets.map((s) => ({ subId: s.subId, uuid: s.uuid, kind: s.kind, name: s.name })),
    userData: a.userData ?? null,
  };
}

/**
 * Name → candidate assets (the `find` json), same ranking as the CLI.
 * @param {any} scan @param {string} query @param {{types?:Set<string>, limit?:number}} [opts]
 */
export function findData(scan, query, { types = new Set(), limit = 50 } = {}) {
  const q = (query || '').toLowerCase();
  return [...scan.assets.values()]
    .filter((a) => a.path.toLowerCase().includes(q) && (!types.size || types.has(a.type)))
    .sort((a, b) => {
      const ai = base(a.path).toLowerCase().indexOf(q); const bi = base(b.path).toLowerCase().indexOf(q);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi) || a.path.localeCompare(b.path);
    })
    .slice(0, limit)
    .map((a) => ({ path: a.path, type: a.type, uuid: a.uuid }));
}

/**
 * Transitive bundle closure (the `closure` json), optionally type-filtered.
 * @param {any} scan @param {string} uuid @param {{types?:Set<string>, list?:boolean}} [opts]
 */
export function closureData(scan, uuid, { types = new Set(), list = false } = {}) {
  const c = closureReport(scan, uuid);
  let { items, byType, totalSize, count } = c;
  if (types.size) {
    items = c.items.filter((i) => types.has(i.type));
    byType = {}; totalSize = 0;
    for (const i of items) { byType[i.type] = (byType[i.type] || 0) + 1; totalSize += i.size || 0; }
    count = items.length;
  }
  const o = { root: c.root, count, totalSize, byType };
  if (types.size) o.type = [...types];
  if (list) o.items = items;
  return o;
}

// ---- project-wide audit (`analyze <section>`) ------------------------------
// The structured form of each node-run.js report section, over the shared
// analyze.js builders. cli.js renders these as text; the MCP `analyze` tool
// returns them verbatim. One logic, two front-ends.
export const ANALYZE_SECTIONS = ['stats', 'unused', 'orphans', 'atlas', 'size', 'bundles'];

const sizeByType = (items) => { const m = {}; for (const i of items) { const t = (m[i.type] ||= { count: 0, size: 0 }); t.count++; t.size += i.size || 0; } return m; };

/**
 * One audit section. `limit` caps the item list (the `total` reports the full
 * count); `types` filters unused/size; `dropped` adds the source-less-meta audit
 * to orphans; `list` adds the largest-files list to size.
 * @param {any} scan @param {string} section
 * @param {{types?:Set<string>, limit?:number, dropped?:boolean, list?:boolean}} [opts]
 */
export function analyzeData(scan, section, { types = new Set(), limit = Infinity, dropped = false, list = false } = {}) {
  switch (section) {
    case 'stats': return summary(scan); // assets/edges/orphanRefs/metaErrors/byType/edgeKinds
    case 'unused': {
      const r = unusedReport(scan);
      const items = types.size ? r.items.filter((i) => types.has(i.type)) : r.items;
      const totalSize = types.size ? items.reduce((s, i) => s + (i.size || 0), 0) : r.totalSize;
      const byType = types.size ? countByType(items) : r.byType;
      const cand = types.size ? r.candidates.filter((i) => types.has(i.type)) : r.candidates;
      return { items: items.slice(0, limit), total: items.length, totalSize, byType, candidates: cand.slice(0, limit), candidatesTotal: cand.length };
    }
    case 'orphans': {
      const r = orphanRefReport(scan);
      const o = { items: r.items.slice(0, limit), total: r.total, missingSourceCount: r.missingSourceCount };
      if (dropped) o.dropped = droppedMetaReport(scan);
      return o;
    }
    case 'atlas': {
      const r = atlasUtilizationReport(scan);
      return { items: r.items.slice(0, limit), total: r.items.length };
    }
    case 'size': {
      const r = sizeReport(scan);
      const items = types.size ? r.items.filter((i) => types.has(i.type)) : r.items;
      const byType = types.size ? sizeByType(items) : r.byType;
      const totalSize = types.size ? items.reduce((s, i) => s + (i.size || 0), 0) : r.totalSize;
      const o = { byType, totalSize, total: items.length };
      if (list) o.items = items.slice(0, limit);
      return o;
    }
    case 'bundles': return bundleReport(scan, { limit }); // per-bundle stats + cross-bundle links + cycles
    default: return null; // unknown section
  }
}

/** All sections at once (the no-section `analyze` / full report). */
export function analyzeAll(scan, opts) {
  const o = {};
  for (const s of ANALYZE_SECTIONS) o[s] = analyzeData(scan, s, opts);
  return o;
}

function countByType(items) { const m = {}; for (const i of items) m[i.type] = (m[i.type] || 0) + 1; return m; }
