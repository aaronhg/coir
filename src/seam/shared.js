// Shared CLI helpers used by both the query commands (cli.js) and the edit
// commands (editCli.js): asset resolution, edge indexing, location text. Kept
// framework-free and side-effect-free except resolveAsset (which exits on a bad
// target, the universal CLI behaviour). Mirrors cli.js's unchecked JS style.
import { looksCompressed, decompressUuid, mainUuid } from '../core/uuid.js';
import { componentName, locSelector } from '../core/selector.js';
import { encodeTopo } from '../core/topohash.js';

export const base = (p) => p.slice(p.lastIndexOf('/') + 1);
export const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`);

// Build a shareable #topo= snapshot of an asset's dependency neighbourhood — the
// headless equivalent of the browser's "copy topology link" + the extension's
// "open topology". One encoder (encodeTopo) serves browser/extension/CLI/MCP.
// Shared by the CLI `share` command and the MCP `share` tool. Centre on the main
// uuid (a sub-asset uuid@sub falls back to its owner node).
const DEFAULT_VIEWER = 'https://aaronhg.github.io/coir/';
export async function shareData(scan, uuid, { depth = null, cap = null, base: viewer = null, title = null } = {}) {
  const opts = {};
  if (depth != null) opts.maxDepth = depth;
  if (cap != null) opts.cap = cap;
  if (title) opts.title = title;
  const center = mainUuid(uuid);
  const r = await encodeTopo(scan, center, opts); // { blob, depth, nodes, edges, bytes, droppedLoc, over }
  const baseUrl = viewer || (typeof process !== 'undefined' && process.env && process.env.COIR_VIEWER) || DEFAULT_VIEWER;
  return { uuid, center, url: `${baseUrl}#topo=${r.blob}`, blob: r.blob, depth: r.depth, nodes: r.nodes, blobChars: r.blob.length, droppedLoc: r.droppedLoc };
}

// ---- target resolution: path / basename / uuid / uuid@sub ----------------
// Forgiving of the usual copy-paste slips, in two distinct layers:
//  · NORMALIZATION (lossless cleanup of the input, applied eagerly, no ambiguity
//    risk): surrounding quotes/whitespace, Windows `\`, doubled `/`, a leading
//    `db://`(editor "Copy URL") or `assets/` (asset paths are relative to
//    assets/), a trailing `/`, and a trailing `.meta` (a pasted sidecar file).
//  · RELAXATION (loosens the match, only as a fallback TIER so a precise
//    reference always wins; >1 hit at any tier is a genuine ambiguity →
//    `candidates`): tier 1 strict (exact path / path-suffix / basename-with-ext),
//    tier 2 extensionless, tier 3 case-insensitive (both forms).
// On a miss it also attaches `suggestions` (nearest names by edit distance) — a
// "did you mean", surfaced by every host but NEVER auto-resolved (a wrong auto-
// pick would corrupt the wrong file under `edit`).
const stripExt = (s) => s.replace(/\.[^./]+$/, ''); // drop a single trailing .ext
const clean = (q) => q.trim().replace(/^(["'])(.*)\1$/, '$2').trim(); // surrounding quotes/whitespace
function normPathQuery(q) {
  let s = q.replace(/\\/g, '/');            // Windows backslashes → POSIX
  s = s.replace(/^db:\/\//, '');            // editor "Copy URL": db://assets/… (or db://internal/…, which won't be in scope)
  s = s.replace(/\/{2,}/g, '/');            // collapse any leftover // (db:// already gone)
  s = s.replace(/^\.?\//, '');              // leading ./ or /
  if (s.startsWith('assets/')) s = s.slice('assets/'.length); // assets/ is the scan root
  s = s.replace(/\/+$/, '');                // trailing slash(es)
  s = s.replace(/\.meta$/, '');             // a pasted `.meta` sidecar → its asset
  return s;
}
// Iterative two-row Levenshtein — cheap, only ever run on the error (miss) path.
function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  const cur = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur.slice();
  }
  return prev[n];
}
// Up to `limit` asset paths whose basename (or stem) is closest to the query,
// within a length-relative tolerance — for a "did you mean" hint, not resolution.
function suggestNames(scan, query, limit = 5) {
  const qb = base(normPathQuery(clean(query)).toLowerCase());
  if (!qb) return [];
  const scored = [];
  for (const a of scan.assets.values()) {
    const b = base(a.path).toLowerCase();
    const d = Math.min(editDistance(qb, b), editDistance(qb, stripExt(b)));
    if (d <= Math.max(2, Math.floor(Math.max(qb.length, b.length) * 0.4))) scored.push({ p: a.path, d });
  }
  scored.sort((x, y) => x.d - y.d || x.p.localeCompare(y.p));
  return scored.slice(0, limit).map((s) => s.p);
}
// Shared "did you mean" suffix so every host renders the hint identically.
export const fmtDidYouMean = (suggestions) =>
  suggestions && suggestions.length ? `\n  did you mean:\n${suggestions.map((p) => `    ${p}`).join('\n')}` : '';

export function resolveTarget(scan, query) {
  if (typeof query !== 'string') return { notFound: true };
  const cleaned = clean(query);
  if (!cleaned) return { notFound: true }; // no/blank target — never throw (e.g. `verify` with no <file>)
  const main = cleaned.includes('@') ? cleaned.slice(0, cleaned.indexOf('@')) : cleaned;
  if (scan.assets.has(main)) return { uuid: main }; // uuid / uuid@sub — never path-normalized
  const q = normPathQuery(cleaned);
  const exact = scan.byPath.get(q) || scan.byPath.get(cleaned);
  if (exact) return { uuid: exact.uuid };
  const assets = [...scan.assets.values()];
  // Tier 1 — strict: exact path, path-suffix, or basename WITH extension.
  let matches = assets.filter(
    (a) => a.path === q || a.path.endsWith(`/${q}`) || base(a.path) === q);
  // Tier 2 — extensionless (only if strict matched nothing).
  if (matches.length === 0) matches = assets.filter((a) => {
    const noext = stripExt(a.path);
    return noext === q || noext.endsWith(`/${q}`) || stripExt(base(a.path)) === q;
  });
  // Tier 3 — case-insensitive, both with- and without-extension.
  if (matches.length === 0) {
    const ql = q.toLowerCase();
    matches = assets.filter((a) => {
      const p = a.path.toLowerCase(), b = base(a.path).toLowerCase();
      const pe = stripExt(p), be = stripExt(b);
      return p === ql || p.endsWith(`/${ql}`) || b === ql || pe === ql || pe.endsWith(`/${ql}`) || be === ql;
    });
  }
  if (matches.length === 1) return { uuid: matches[0].uuid };
  if (matches.length > 1) return { candidates: matches.map((a) => a.path).sort() };
  return { notFound: true, suggestions: suggestNames(scan, query) };
}

// Resolve a query to a uuid, or print not-found / candidates and exit 2.
// Shared by the query dispatch and every edit op that names an asset.
export function resolveAsset(scan, query) {
  const r = resolveTarget(scan, query);
  if (r.notFound) { console.error(`✗ not found: "${query}"${fmtDidYouMean(r.suggestions)}`); process.exit(2); }
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
