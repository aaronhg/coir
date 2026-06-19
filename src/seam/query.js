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
