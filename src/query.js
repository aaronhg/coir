// @ts-check
// Pure, side-effect-free data builders for the read/query side — the structured
// (`-o json`) form of each query command, with NO console/exit. cli.js's text
// commands and the MCP server both call these, so the query data model is one
// place. (The CLI's text rendering stays in cli.js; this is the json substance.)
import { mainUuid } from './core/uuid.js';
import { closureReport } from './core/analyze.js';
import { base, edgeSort, orphansOf, locJson } from './shared.js';

/**
 * Direct (1-hop) dependency record for an asset, regardless of any tree depth —
 * the `deps`/`uses` json. `--type` filters the direct neighbours by type;
 * locations come verbatim. (The multi-hop TREE is a text-only concern in cli.js.)
 * @param {any} scan
 * @param {{out:Map<string,any[]>, inc:Map<string,any[]>}} maps  edgeMaps(scan)
 * @param {string} uuid
 * @param {{showOut?:boolean, showIn?:boolean, types?:Set<string>, limit?:number}} [opts]
 */
export function depsData(scan, maps, uuid, { showOut = true, showIn = true, types = new Set(), limit = Infinity } = {}) {
  const a = scan.assets.get(uuid);
  const o = { node: a.path, type: a.type, uuid };
  const typeOk = (oa) => !types.size || (oa && types.has(oa.type));
  const side = (dir) => ((dir === 'out' ? maps.out.get(uuid) : maps.inc.get(uuid)) || [])
    .slice().sort(edgeSort(scan, dir))
    .filter((e) => typeOk(scan.assets.get(dir === 'out' ? e.to : e.from)))
    .slice(0, limit)
    .map((e) => {
      const oa = scan.assets.get(dir === 'out' ? e.to : e.from);
      return { path: oa.path, type: oa.type, via: e.kind, weight: e.weight,
        locations: e.locations.map((l) => locJson(scan, l)) };
    });
  if (showOut) {
    o.dependsOn = side('out');
    const orph = types.size ? [] : orphansOf(scan, uuid);
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
    size: a.size, inResources: a.inResources, in: a.in, out: a.out,
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
