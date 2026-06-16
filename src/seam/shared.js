// Shared CLI helpers used by both the query commands (cli.js) and the edit
// commands (editCli.js): asset resolution, edge indexing, location text. Kept
// framework-free and side-effect-free except resolveAsset (which exits on a bad
// target, the universal CLI behaviour). Mirrors cli.js's unchecked JS style.
import { looksCompressed, decompressUuid } from '../core/uuid.js';
import { componentName, locSelector } from '../core/selector.js';

export const base = (p) => p.slice(p.lastIndexOf('/') + 1);
export const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`);

// ---- target resolution: path / basename / uuid / uuid@sub ----------------
export function resolveTarget(scan, query) {
  const main = query.includes('@') ? query.slice(0, query.indexOf('@')) : query;
  if (scan.assets.has(main)) return { uuid: main };
  const exact = scan.byPath.get(query);
  if (exact) return { uuid: exact.uuid };
  const matches = [...scan.assets.values()].filter(
    (a) => a.path === query || a.path.endsWith(`/${query}`) || base(a.path) === query);
  if (matches.length === 1) return { uuid: matches[0].uuid };
  if (matches.length > 1) return { candidates: matches.map((a) => a.path).sort() };
  return { notFound: true };
}

// Resolve a query to a uuid, or print not-found / candidates and exit 2.
// Shared by the query dispatch and every edit op that names an asset.
export function resolveAsset(scan, query) {
  const r = resolveTarget(scan, query);
  if (r.notFound) { console.error(`✗ not found: "${query}"`); process.exit(2); }
  if (r.candidates) {
    console.error(`✗ "${query}" matches ${r.candidates.length} assets — use the full path:`);
    for (const p of r.candidates.slice(0, 20)) console.error(`    ${p}`);
    if (r.candidates.length > 20) console.error(`    … ${r.candidates.length - 20} more`);
    process.exit(2);
  }
  return r.uuid;
}

// scan.edges carry `locations`; graph.js adjacency drops them, so index here.
export function edgeMaps(scan) {
  const out = new Map(); const inc = new Map();
  for (const e of scan.edges) {
    (out.get(e.from) || out.set(e.from, []).get(e.from)).push(e);
    (inc.get(e.to) || inc.set(e.to, []).get(e.to)).push(e);
  }
  return { out, inc };
}
export const orphansOf = (scan, uuid) => scan.orphanRefs.filter((o) => o.from === uuid);

// `--where` location → a paste-able `nodePath:Comp.prop` selector + a frame
// tail. componentName/locSelector are the shared canonical form (same as the
// browser usage popup and the edit selector whitelist), so a printed line can
// be copied straight into `coir edit <file> set <thatSelector> …`.
export function locText(scan, loc) {
  const sel = locSelector(scan, loc);
  if (sel) return `${sel}${loc.subName ? `  "${loc.subName}"` : ''}`;
  // No nodePath (meta-derived / structural) — show what we can, not a selector.
  const comp = componentName(scan, loc.component);
  const cp = comp && loc.property ? `${comp}.${loc.property}` : (comp || loc.property || '?');
  return `—  ${cp}${loc.subName ? `  "${loc.subName}"` : ''}`;
}
export function locJson(scan, loc) {
  const o = { nodePath: loc.nodePath ?? null, component: loc.component ?? null,
    property: loc.property ?? null, subName: loc.subName ?? null };
  if (loc.component && looksCompressed(loc.component)) {
    const a = scan.assets.get(decompressUuid(loc.component));
    if (a) o.componentScript = a.path;
  }
  return o;
}
export const edgeSort = (scan, dir) => (x, y) => {
  const ax = scan.assets.get(dir === 'out' ? x.to : x.from);
  const ay = scan.assets.get(dir === 'out' ? y.to : y.from);
  return ax.type.localeCompare(ay.type) || base(ax.path).localeCompare(base(ay.path));
};
