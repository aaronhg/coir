#!/usr/bin/env node
// Headless dependency query over the DOM-free core: ask what an asset depends
// on, who depends on it, its bundle closure, or find one by name. Data goes to
// stdout (pipe/parse-friendly); --json emits a structured form. Progress, if
// any, would go to stderr — kept silent here since a full scan is ~tens of ms.
//
//   node src/cli.js <projectDir> deps    <asset> [--in|--out] [--depth N] [--type T[,T2]] [--where] [--json] [--limit N]
//   node src/cli.js <projectDir> uses    <asset> [--depth N] [--type T] [--where] [--json] [--limit N]   (= deps --in)
//   node src/cli.js <projectDir> closure <asset> [--type T] [--list] [--json]
//   node src/cli.js <projectDir> find    <query> [--type T] [--json] [--limit N]
//
// <asset> resolves by full path, basename, uuid, or uuid@sub; an ambiguous
// basename prints the candidates and exits 2.
//
// --type T[,T2,…] keeps only the chosen asset types. On the deps/uses TREE it
// prunes to branches that REACH one of those types — the matching nodes plus
// the intermediate hops leading to them stay, dead branches are dropped (the
// root is always kept). On closure/find/--json it just filters the flat list.

import path from 'node:path';
import { scanProject } from './core/scan.js';
import { closureReport } from './core/analyze.js';
import { looksCompressed, decompressUuid, mainUuid } from './core/uuid.js';
import { KNOWN_TYPES } from './core/meta.js';
import { makeFsProvider } from './node/fsProvider.js';

const VIA_W = 12;
const base = (p) => p.slice(p.lastIndexOf('/') + 1);
const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`);

const USAGE = `Usage:
  node src/cli.js <projectDir> deps    <asset> [--in|--out] [--depth N] [--type T[,T2]] [--where] [--json] [--limit N]
  node src/cli.js <projectDir> uses    <asset> [--depth N] [--type T] [--where] [--json] [--limit N]
  node src/cli.js <projectDir> closure <asset> [--type T] [--list] [--json]
  node src/cli.js <projectDir> find    <query> [--type T] [--json] [--limit N]

<asset>: full path / basename / uuid / uuid@sub
--type : keep only the given asset types (comma-separated); on the deps/uses tree it
         keeps the intermediate path leading to those types.
         types = asset types (not the edge kinds shown in the listing); known: ${KNOWN_TYPES.join(' ')}
         (a project may add extension-derived types like 'text'; a wrong --type prints the full list)`;

// All other user-facing CLI text, centralized (CLI is fixed English).
const M = {
  scanFail: (m) => `scan failed: ${m}`,
  unknownTypes: (ts) => `⚠ unknown type(s) (won't match anything): ${ts}`,
  availTypes: (ts) => `  available types: ${ts}`,
  unknownCmd: (c) => `unknown command "${c}"`,
  needTarget: (c) => `command "${c}" needs a target`,
  notFound: (q) => `✗ not found: "${q}"`,
  ambiguous: (q, n) => `✗ "${q}" matches ${n} assets — use the full path:`,
  more: (n) => `    … ${n} more`,
  metaDerived: '(meta-derived — no nodePath)',
  matched: ' (matched)',
  missingSrc: '(missing source)',
  listHint: '  (add --list to print each asset)',
  noMatch: (q) => `(no match for "${q}")`,
  findMore: (n) => `  … ${n} more (raise --limit)`,
};

function parseArgs(argv) {
  const [projectDir, command, ...rest] = argv;
  const flags = { dir: null, depth: 1, where: false, json: false, list: false, limit: Infinity, types: new Set() };
  const addTypes = (s) => { for (const t of String(s || '').split(',')) { const v = t.trim(); if (v) flags.types.add(v); } };
  const pos = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--in') flags.dir = 'in';
    else if (a === '--out') flags.dir = 'out';
    else if (a === '--where' || a === '-w') flags.where = true;
    else if (a === '--json') flags.json = true;
    else if (a === '--list') flags.list = true;
    else if (a === '--depth') flags.depth = parseInt(rest[++i], 10) || 1;
    else if (a.startsWith('--depth=')) flags.depth = parseInt(a.slice(8), 10) || 1;
    else if (a === '--limit') flags.limit = parseInt(rest[++i], 10) || Infinity;
    else if (a.startsWith('--limit=')) flags.limit = parseInt(a.slice(8), 10) || Infinity;
    else if (a === '--type') { if (rest[i + 1] !== undefined && !rest[i + 1].startsWith('-')) addTypes(rest[++i]); }
    else if (a.startsWith('--type=')) addTypes(a.slice(7));
    else if (!a.startsWith('-')) pos.push(a);
  }
  return { projectDir, command, target: pos[0], flags };
}

// ---- target resolution: path / basename / uuid / uuid@sub ----------------
function resolveTarget(scan, query) {
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

// scan.edges carry `locations`; graph.js adjacency drops them, so index here.
function edgeMaps(scan) {
  const out = new Map(); const inc = new Map();
  for (const e of scan.edges) {
    (out.get(e.from) || out.set(e.from, []).get(e.from)).push(e);
    (inc.get(e.to) || inc.set(e.to, []).get(e.to)).push(e);
  }
  return { out, inc };
}
const orphansOf = (scan, uuid) => scan.orphanRefs.filter((o) => o.from === uuid);

// A location's `component` is a serialized __type__: cc.Sprite for builtins,
// a compressed uuid for custom scripts — resolve the latter to its script path.
function compLabel(scan, comp) {
  if (!comp) return '';
  if (looksCompressed(comp)) { const a = scan.assets.get(decompressUuid(comp)); return a ? base(a.path) : comp; }
  return comp;
}
function locText(scan, loc) {
  const comp = compLabel(scan, loc.component);
  const prop = loc.property || '';
  const cp = comp && prop ? `${comp}.${prop}` : (comp || prop || '?');
  return `${loc.nodePath || '—'}  ${cp}${loc.subName ? `  "${loc.subName}"` : ''}`;
}
function locJson(scan, loc) {
  const o = { nodePath: loc.nodePath ?? null, component: loc.component ?? null,
    property: loc.property ?? null, subName: loc.subName ?? null };
  if (loc.component && looksCompressed(loc.component)) {
    const a = scan.assets.get(decompressUuid(loc.component));
    if (a) o.componentScript = a.path;
  }
  return o;
}
const edgeSort = (scan, dir) => (x, y) => {
  const ax = scan.assets.get(dir === 'out' ? x.to : x.from);
  const ay = scan.assets.get(dir === 'out' ? y.to : y.from);
  return ax.type.localeCompare(ay.type) || base(ax.path).localeCompare(base(ay.path));
};

// ---- dependency tree: build → (optionally) prune by type → render ---------
// Build the side tree with the SAME global-seen / depth / limit rules as before
// (a revisited node is shown with ↻ and not re-expanded). Returns a node tree.
function buildEdgeTree(scan, maps, rootUuid, dir, flags) {
  const seen = new Set([rootUuid]);
  // When filtering by type, build full breadth and let pruneByType apply --limit
  // to the SURVIVORS, so a match that sorts past --limit is never dropped before
  // the type filter sees it. Unfiltered, --limit caps breadth here as before.
  const breadth = flags.types.size ? Infinity : flags.limit;
  return (function recur(uuid, depth) {
    const edges = ((dir === 'out' ? maps.out.get(uuid) : maps.inc.get(uuid)) || [])
      .slice().sort(edgeSort(scan, dir)).slice(0, breadth);
    const nodes = [];
    for (const e of edges) {
      const other = dir === 'out' ? e.to : e.from;
      const revisit = seen.has(other);
      let children = [];
      if (depth < flags.depth && !revisit) { seen.add(other); children = recur(other, depth + 1); }
      nodes.push({ e, other, depth, revisit, children });
    }
    return nodes;
  })(rootUuid, 1);
}
// Keep only branches that REACH one of `types`: a node stays if it is itself a
// match or has a kept descendant (中間節點). A revisited (↻) node carries no
// children of its own, so we remember whether each uuid's first (expanded)
// occurrence reaches a match (`reaches`) and let later ↻ occurrences inherit that
// verdict — matching the unfiltered view, which still prints the ↻ pointer row.
// `limit` caps the SURVIVORS at each level (post-filter), so a match within the
// limit is never dropped before the type filter runs.
function pruneByType(scan, nodes, types, limit, reaches = new Map()) {
  const out = [];
  for (const n of nodes) {
    const kids = pruneByType(scan, n.children, types, limit, reaches);
    const oa = scan.assets.get(n.other);
    const reach = !!((oa && types.has(oa.type)) || kids.length || (n.revisit && reaches.get(n.other)));
    if (!n.revisit) reaches.set(n.other, reach);
    if (reach) out.push({ ...n, children: kids });
  }
  return out.slice(0, limit);
}
function renderTreeText(scan, tree, dir, flags, lines) {
  const arrow = dir === 'out' ? '→' : '←';
  (function walk(nodes) {
    for (const n of nodes) {
      const oa = scan.assets.get(n.other);
      const indent = '    '.repeat(n.depth);
      lines.push(`${indent}${n.e.kind.padEnd(VIA_W)} ${arrow} ${oa.path}` +
        `${n.e.weight > 1 ? `  (${n.e.weight}×)` : ''}${n.revisit ? '  ↻' : ''}`);
      if (flags.where) {
        if (n.e.locations.length) for (const loc of n.e.locations) lines.push(`${indent}    ${locText(scan, loc)}`);
        else lines.push(`${indent}    ${M.metaDerived}`);
      }
      walk(n.children);
    }
  })(tree);
}
function sideTree(scan, maps, rootUuid, dir, flags) {
  const tree = buildEdgeTree(scan, maps, rootUuid, dir, flags);
  return flags.types.size ? pruneByType(scan, tree, flags.types, flags.limit) : tree;
}
// Number of nodes whose own type matches — i.e. how many 符合 lines are actually
// rendered (at every depth), so the header agrees with the tree printed below it.
function countMatches(scan, tree, types) {
  let c = 0;
  (function walk(nodes) {
    for (const n of nodes) {
      const oa = scan.assets.get(n.other);
      if (oa && types.has(oa.type)) c++;
      walk(n.children);
    }
  })(tree);
  return c;
}

function cmdDeps(scan, maps, uuid, flags) {
  const a = scan.assets.get(uuid);
  const showOut = flags.dir !== 'in';
  const showIn = flags.dir !== 'out';
  const filt = flags.types.size;
  if (flags.json) { console.log(JSON.stringify(depsJson(scan, maps, uuid, showOut, showIn, flags))); return; }

  const lines = [`${a.path} (${a.type})${filt ? `   [type: ${[...flags.types].join(',')}]` : ''}`];
  if (showOut) {
    const tree = sideTree(scan, maps, uuid, 'out', flags);
    const orph = filt ? [] : orphansOf(scan, uuid); // orphans are untyped → dropped when filtering
    const n = filt ? countMatches(scan, tree, flags.types) : (maps.out.get(uuid) || []).length + orph.length;
    lines.push(n ? `  depends-on ${n}${filt ? M.matched : ''}:` : `  depends-on 0${filt ? M.matched : ''}`);
    renderTreeText(scan, tree, 'out', flags, lines);
    for (const o of orph.slice(0, flags.limit)) {
      const known = scan.missing && scan.missing.get(mainUuid(o.ref));
      lines.push(`    ${'↯ orphan'.padEnd(VIA_W)} → ${known ? `${known}  ${M.missingSrc}` : o.ref}`);
      if (flags.where && o.loc) lines.push(`        ${locText(scan, o.loc)}`);
    }
  }
  if (showIn) {
    const tree = sideTree(scan, maps, uuid, 'in', flags);
    const n = filt ? countMatches(scan, tree, flags.types) : (maps.inc.get(uuid) || []).length;
    let head = n ? `  used-by ${n}${filt ? M.matched : ''}:` : `  used-by 0${filt ? M.matched : ''}`;
    if (!n && !filt && !a.inResources && a.type !== 'scene') head += '   ⚠ unreferenced';
    lines.push(head);
    renderTreeText(scan, tree, 'in', flags, lines);
  }
  console.log(lines.join('\n'));
}

// JSON is always direct (1-hop) regardless of --depth; locations come verbatim.
// --type filters the direct neighbours by type (no intermediate-path concept at 1 hop).
function depsJson(scan, maps, uuid, showOut, showIn, flags) {
  const a = scan.assets.get(uuid);
  const o = { node: a.path, type: a.type, uuid };
  const typeOk = (oa) => !flags.types.size || (oa && flags.types.has(oa.type));
  const side = (dir) => ((dir === 'out' ? maps.out.get(uuid) : maps.inc.get(uuid)) || [])
    .slice().sort(edgeSort(scan, dir))
    .filter((e) => typeOk(scan.assets.get(dir === 'out' ? e.to : e.from)))
    .slice(0, flags.limit)
    .map((e) => {
      const oa = scan.assets.get(dir === 'out' ? e.to : e.from);
      return { path: oa.path, type: oa.type, via: e.kind, weight: e.weight,
        locations: e.locations.map((l) => locJson(scan, l)) };
    });
  if (showOut) {
    o.dependsOn = side('out');
    const orph = flags.types.size ? [] : orphansOf(scan, uuid);
    if (orph.length) o.orphanRefs = orph.map((x) => {
      const known = scan.missing && scan.missing.get(mainUuid(x.ref));
      return { ref: x.ref, path: known || null, missingSource: !!known, location: x.loc ? locJson(scan, x.loc) : null };
    });
  }
  if (showIn) o.usedBy = side('in');
  return o;
}

function cmdClosure(scan, uuid, flags) {
  const c = closureReport(scan, uuid);
  let { items, byType, totalSize, count } = c;
  if (flags.types.size) { // filter the flat closure to the chosen types
    items = c.items.filter((i) => flags.types.has(i.type));
    byType = {}; totalSize = 0;
    for (const i of items) { byType[i.type] = (byType[i.type] || 0) + 1; totalSize += i.size || 0; }
    count = items.length;
  }
  if (flags.json) {
    const o = { root: c.root, count, totalSize, byType };
    if (flags.types.size) o.type = [...flags.types];
    if (flags.list) o.items = items;
    console.log(JSON.stringify(o)); return;
  }
  const bt = Object.entries(byType).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k}:${v}`).join('  ');
  const filt = flags.types.size ? `  [type: ${[...flags.types].join(',')}]` : '';
  const lines = [`${c.root} → ${count} assets, ${kb(totalSize)}${filt}`, `  ${bt}`];
  if (flags.list) for (const i of items) lines.push(`    ${kb(i.size).padStart(10)}  ${i.type.padEnd(8)} ${i.path}`);
  else lines.push(M.listHint);
  console.log(lines.join('\n'));
}

function cmdFind(scan, query, flags) {
  const q = (query || '').toLowerCase();
  const matches = [...scan.assets.values()]
    .filter((a) => a.path.toLowerCase().includes(q) && (!flags.types.size || flags.types.has(a.type)))
    .sort((a, b) => {
      const ai = base(a.path).toLowerCase().indexOf(q); const bi = base(b.path).toLowerCase().indexOf(q);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi) || a.path.localeCompare(b.path);
    });
  const lim = flags.limit === Infinity ? 50 : flags.limit;
  const shown = matches.slice(0, lim);
  if (flags.json) { console.log(JSON.stringify(shown.map((a) => ({ path: a.path, type: a.type, uuid: a.uuid })))); return; }
  if (!matches.length) { console.log(M.noMatch(query)); return; }
  const lines = shown.map((a) => `  ${a.type.padEnd(10)} ${a.path}`);
  if (matches.length > shown.length) lines.push(M.findMore(matches.length - shown.length));
  console.log(lines.join('\n'));
}

async function main() {
  const { projectDir, command, target, flags } = parseArgs(process.argv.slice(2));
  if (!projectDir || !command) { console.error(USAGE); process.exit(1); }

  let scan;
  try { scan = await scanProject(makeFsProvider(path.join(projectDir, 'assets'))); }
  catch (e) { console.error(M.scanFail(e.message)); process.exit(1); }

  // --type matches an asset's TYPE, not the edge KIND printed on each row. Warn on
  // values that no asset carries (typos, or edge kinds like `texture`/`sprite-frame`
  // that map to a different asset type) — they would silently match nothing.
  if (flags.types.size) {
    const known = new Set();
    for (const a of scan.assets.values()) known.add(a.type);
    const unknown = [...flags.types].filter((t) => !known.has(t));
    if (unknown.length) {
      console.error(M.unknownTypes(unknown.join(', ')));
      console.error(M.availTypes([...known].sort().join(' ')));
    }
  }

  if (command === 'find') { cmdFind(scan, target, flags); return; }

  if (!['deps', 'uses', 'closure'].includes(command)) {
    console.error(`${M.unknownCmd(command)}\n\n${USAGE}`); process.exit(1);
  }
  if (!target) { console.error(`${M.needTarget(command)}\n\n${USAGE}`); process.exit(1); }

  const r = resolveTarget(scan, target);
  if (r.notFound) { console.error(M.notFound(target)); process.exit(2); }
  if (r.candidates) {
    console.error(M.ambiguous(target, r.candidates.length));
    for (const p of r.candidates.slice(0, 20)) console.error(`    ${p}`);
    if (r.candidates.length > 20) console.error(M.more(r.candidates.length - 20));
    process.exit(2);
  }

  if (command === 'closure') { cmdClosure(scan, r.uuid, flags); return; }
  const f = { ...flags };
  if (command === 'uses') f.dir = 'in';
  cmdDeps(scan, edgeMaps(scan), r.uuid, f);
}

main().catch((e) => { console.error(e); process.exit(1); });
