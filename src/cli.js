#!/usr/bin/env node
// Headless dependency query over the DOM-free core: ask what an asset depends
// on, who depends on it, its bundle closure, find one by name, or dump its
// record. In-place editing of existing prefab/scene files lives in editCli.js;
// shared resolution/location helpers live in shared.js. Data goes to stdout
// (pipe/parse-friendly); `-o json` emits a structured form.
//
// Run on the current dir, or point elsewhere with `-C <projectDir>` (git-style).
//   coir deps    <asset> [--in|--out] [--depth N] [--type T[,T2]] [--where] [-o json] [--limit N]
//   coir uses    <asset> [--depth N] [--type T] [--where] [-o json] [--limit N]   (= deps --in)
//   coir closure <asset> [--type T] [--list] [-o json]
//   coir find    <query> [--type T] [-o json] [--limit N]
//   coir info    <asset> [-o json]
//   coir edit    <file> <op> …   [--dry-run] [--backup] [-o json]   (see editCli.js)
//
// <asset> resolves by full path, basename, uuid, or uuid@sub; an ambiguous
// basename prints the candidates and exits 2.
//
// --type T[,T2,…] keeps only the chosen asset types. On the deps/uses TREE it
// prunes to branches that REACH one of those types — the matching nodes plus
// the intermediate hops leading to them stay, dead branches are dropped (the
// root is always kept). On closure/find/`-o json` it just filters the flat list.

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { scanProject } from './core/scan.js';
import { closureReport } from './core/analyze.js';
import { mainUuid } from './core/uuid.js';
import { knownTypes } from './core/meta.js';
import { PLUGINS, dedupePlugins } from './core/plugins/index.js';
import { loadConfigPlugins, loadPluginFiles } from './node/loadPlugins.js';
import { makeFsProvider } from './node/fsProvider.js';
import { base, kb, resolveAsset, edgeMaps, orphansOf, locText, edgeSort } from './shared.js';
import { depsData, infoData, analyzeData, analyzeAll, ANALYZE_SECTIONS } from './query.js';
import { cmdEdit } from './editCli.js';

const COIR_ROOT = fileURLToPath(new URL('../', import.meta.url)); // <repo>/ (cli.js is in src/)
const VERSION = (() => { try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; } catch { return '?'; } })();

const KNOWN_TYPES = knownTypes(PLUGINS);
const VIA_W = 12;

// Typed value flags for `edit set` (explicit, never inferred). parseArgs grabs
// the following non-`--` tokens into flags.value; editCli resolves them.
const VALUE_FLAGS = {
  '--str': 'str', '--int': 'int', '--num': 'num', '--enum': 'enum', '--bool': 'bool',
  '--uuid': 'uuid', '--color': 'color', '--vec2': 'vec2', '--vec3': 'vec3',
  '--vec4': 'vec4', '--size': 'size', '--quat': 'quat', '--json': 'json',
};
// How many tokens each value flag consumes — so a flag stops at its arity and
// doesn't swallow trailing positionals (color #hex is 1, rgba is up to 4).
const VALUE_ARITY = { str: 1, int: 1, num: 1, enum: 1, bool: 1, uuid: 1, json: 1, color: 4, vec2: 2, vec3: 3, vec4: 4, size: 2, quat: 4 };

const USAGE = `coir ${VERSION} — headless asset-dependency query + in-place prefab/scene editor for Cocos Creator 3.x.

Usage:  coir <command> [args] [flags]      (runs on the current dir; point elsewhere with -C <projectDir>)
        also runnable as:  node src/cli.js …   /   npm run cli -- …

Query (read-only; prints to stdout, pipe-friendly):
  coir deps    <asset> [--in|--out] [--depth N] [--type T[,T2]] [--kind K[,K2]] [--where] [-o json] [--limit N]
  coir uses    <asset> [--depth N] [--type T] [--kind K] [--where] [-o json] [--limit N]   (= deps --in)
  coir closure <asset> [--type T] [--list] [-o json]
  coir find    <query> [--type T] [-o json] [--limit N]
  coir info    <asset> [-o json]
  coir analyze [section] [-o json]   project-wide audit; section = stats|unused|orphans|atlas|size (none = all)
                                     stats=counts/edge-kinds/health  unused=0-referrer assets  orphans [--dropped]
                                     atlas=frame utilization  size [--type T] [--list]=per-type/largest totals

Edit (in-place — WRITES the file; preview with --dry-run, snapshot with --backup, --force overrides the concurrent-change guard):
  coir edit <file> <op> …            [--dry-run] [--backup] [-o json]
  coir edit --all swap-uuid <oldAsset> <newAsset>     (project-wide repoint)
    op:  tree      [--with <Type>] [--under <sel>] [--depth N]   list the node tree + each node's components (read-only; -o json gives ready selectors)
         get       <sel>                          read a value/node/component (-o json round-trips into set --json)
         set       <sel> <value-flag>             set a property (sel = nodePath:Type.prop)
         set-uuid  <sel> <asset>                  point a property at an asset
         swap-uuid <oldAsset> <newAsset>          repoint every ref onto another asset (whole file)
         rename    <nodeSel> <newName>
         set-active/set-layer <nodeSel> --bool|--int <v>
         set-pos/set-scale/set-rot <nodeSel> --vec3 x y z          (set-rot = euler degrees)
         set-parent <nodeSel> <newParentSel> [--index i]
         add-node   <parentSel> <name> [--index i]   rm-node <nodeSel>        (real delete + compaction)
         add-component <nodeSel> <ccType>            rm-component <sel:Type>
    value-flags: --str --int --num --enum --bool --color #RRGGBBAA --vec2/3/4 --size --quat --uuid <asset> --null
                 --json '<json>'  (set a whole object/array; a class-name __type__ → compressed token)

MCP (for AI agents / no-shell hosts — typed tools over the SAME query+edit logic, hand-rolled, zero deps):
  coir mcp                           start a JSON-RPC/stdio MCP server on this project (see docs/MCP.md)

<asset>: full path / basename / uuid / uuid@sub.   <sel>: nodePath then :Type then .prop, e.g.
         "Canvas/Title:cc.Label._string"; [i] disambiguates same-name nodes / same-type components /
         array elements; #N is the raw array index.
Output:  text (default), or -o json for machine-readable (every query + edit confirmation).

Examples:  (run inside your Cocos project, or add -C <projectDir>)
  coir find Coin                                              # locate an asset by name
  coir uses art/coin.png --where                             # who references it + exactly where
  coir deps scene/Main.scene --type prefab                   # which prefabs the scene pulls in
  coir edit Shop.prefab swap-uuid old.png new.png --dry-run  # preview a repoint (no write)
  coir edit Shop.prefab get "Title:cc.Label._string" -o json # read a value
  coir edit Shop.prefab set "Title:cc.Label._string" --str "Start" --backup
  coir deps art/coin.png -C ../OtherGame                     # run against a project elsewhere

Exit codes:  0 ok (incl. no-op)    1 usage/value error    2 not found / ambiguous / refused guard

--type   : keep only the given asset types (comma-separated); on the deps/uses tree it keeps the
           intermediate path leading to those types. known: ${KNOWN_TYPES.join(' ')}
--plugin <file> : load an extra plugin module (repeatable). Auto-loaded: <coirRoot>/coir.plugins.mjs
           (global) and <projectDir>/coir.plugins.mjs (per project; both gitignored).
-C <dir> : the Cocos project dir (git-style; default is the current directory).   -h/--help    -v/--version`;

// Query-side user-facing text (CLI is fixed English). Resolution errors live in
// shared.resolveAsset; edit messages live in editCli.
const M = {
  scanFail: (m) => `scan failed: ${m}`,
  scanHint: '  (no assets/ here — run inside your Cocos project, or pass -C <projectDir>)',
  unknownTypes: (ts) => `⚠ unknown type(s) (won't match anything): ${ts}`,
  availTypes: (ts) => `  available types: ${ts}`,
  unknownCmd: (c) => `unknown command "${c}"`,
  needTarget: (c) => `command "${c}" needs a target`,
  metaDerived: '(meta-derived — no nodePath)',
  matched: ' (matched)',
  missingSrc: '(missing source)',
  listHint: '  (add --list to print each asset)',
  noMatch: (q) => `(no match for "${q}")`,
  findMore: (n) => `  … ${n} more (raise --limit)`,
  unknownSection: (s, list) => `unknown analyze section "${s}" — use one of: ${list.join(' ')}  (or none for the full report)`,
  moreItems: (n) => `   … ${n} more (--limit / -o json)`,
};

function parseArgs(argv) {
  const flags = { dir: null, depth: null, where: false, json: false, list: false, limit: Infinity, types: new Set(), kinds: new Set(), plugins: [], dryRun: false, backup: false, value: null, index: null, all: false, help: false, version: false, project: null, with: null, under: null, force: false, dropped: false };
  const addTypes = (s) => { for (const t of String(s || '').split(',')) { const v = t.trim(); if (v) flags.types.add(v); } };
  const addKinds = (s) => { for (const t of String(s || '').split(',')) { const v = t.trim(); if (v) flags.kinds.add(v); } };
  const pos = []; // positionals, in order, from anywhere in argv
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') flags.help = true;
    else if (a === '-v' || a === '--version') flags.version = true;
    else if (a === '-C' || a === '--project') { if (argv[i + 1] !== undefined) flags.project = argv[++i]; } // project dir (git-style; alternative to the leading positional)
    else if (a.startsWith('--project=')) flags.project = a.slice(10);
    else if (a === '--in') flags.dir = 'in';
    else if (a === '--out') flags.dir = 'out';
    else if (a === '--where' || a === '-w') flags.where = true;
    else if (a === '--dry-run' || a === '-n') flags.dryRun = true;
    else if (a === '--backup') flags.backup = true;
    else if (a === '--force') flags.force = true; // edit: bypass the concurrent-change (mtime) guard
    else if (a === '--all') flags.all = true;
    else if (a === '-o' || a === '--output') { if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) flags.json = argv[++i] === 'json'; } // output format (text default)
    else if (a.startsWith('--output=')) flags.json = a.slice(9) === 'json';
    else if (a === '--list') flags.list = true;
    else if (a === '--dropped') flags.dropped = true; // analyze orphans: also list dropped source-less metas
    else if (a === '--depth') flags.depth = parseInt(argv[++i], 10) || 1;
    else if (a.startsWith('--depth=')) flags.depth = parseInt(a.slice(8), 10) || 1;
    else if (a === '--limit') flags.limit = parseInt(argv[++i], 10) || Infinity;
    else if (a.startsWith('--limit=')) flags.limit = parseInt(a.slice(8), 10) || Infinity;
    else if (a === '--index') { const v = parseInt(argv[++i], 10); flags.index = Number.isNaN(v) ? null : v; }
    else if (a.startsWith('--index=')) { const v = parseInt(a.slice(8), 10); flags.index = Number.isNaN(v) ? null : v; }
    else if (a === '--with') { if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) flags.with = argv[++i]; } // edit tree: keep nodes with this component
    else if (a.startsWith('--with=')) flags.with = a.slice(7);
    else if (a === '--under') { if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) flags.under = argv[++i]; } // edit tree: scope to a subtree
    else if (a.startsWith('--under=')) flags.under = a.slice(8);
    else if (a === '--type') { if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) addTypes(argv[++i]); }
    else if (a.startsWith('--type=')) addTypes(a.slice(7));
    else if (a === '--kind') { if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) addKinds(argv[++i]); } // deps/uses: keep only these edge KINDS
    else if (a.startsWith('--kind=')) addKinds(a.slice(7));
    else if (a === '--plugin') { if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) flags.plugins.push(argv[++i]); }
    else if (a.startsWith('--plugin=')) flags.plugins.push(a.slice(9));
    else if (a === '--null') flags.value = { type: 'null', args: [] };
    else if (VALUE_FLAGS[a]) { // typed value for `edit set …`; grab up to arity non-flag tokens (so --vec3 0 0 1 works incl. negatives, but extra positionals aren't swallowed)
      const type = VALUE_FLAGS[a];
      let max = VALUE_ARITY[type] || 1;
      const args = [];
      while (args.length < max && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) {
        args.push(argv[++i]);
        if (type === 'color' && args.length === 1 && args[0].startsWith('#')) max = 1; // #hex is a single token
      }
      flags.value = { type, args };
    }
    else if (!a.startsWith('-')) pos.push(a);
  }
  // Project dir from `-C <dir>` (default: the current directory, git-style). The
  // first positional is the command — no leading <projectDir> positional.
  const projectDir = flags.project != null ? flags.project : '.';
  const command = pos.shift();
  return { projectDir, command, target: pos[0], pos, flags };
}

// An edge passes the --kind filter when no kinds are set, or its kind is chosen.
const matchesKind = (flags, e) => !flags.kinds.size || flags.kinds.has(e.kind);

// ---- dependency tree: build → (optionally) prune by type → render ---------
// Build the side tree with the SAME global-seen / depth / limit rules as before
// (a revisited node is shown with ↻ and not re-expanded). Returns a node tree.
function buildEdgeTree(scan, maps, rootUuid, dir, flags) {
  const seen = new Set([rootUuid]);
  // When filtering by type, build full breadth and let pruneByType apply --limit
  // to the SURVIVORS, so a match that sorts past --limit is never dropped before
  // the type filter sees it. Unfiltered, --limit caps breadth here as before.
  const breadth = flags.types.size ? Infinity : flags.limit;
  const maxDepth = flags.depth == null ? 1 : flags.depth; // deps/uses default to 1 hop (edit tree uses its own)
  return (function recur(uuid, depth) {
    const edges = ((dir === 'out' ? maps.out.get(uuid) : maps.inc.get(uuid)) || [])
      .filter((e) => matchesKind(flags, e)).slice().sort(edgeSort(scan, dir)).slice(0, breadth);
    const nodes = [];
    for (const e of edges) {
      const other = dir === 'out' ? e.to : e.from;
      const revisit = seen.has(other);
      let children = [];
      if (depth < maxDepth && !revisit) { seen.add(other); children = recur(other, depth + 1); }
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
  if (flags.json) { console.log(JSON.stringify(depsData(scan, maps, uuid, { showOut, showIn, types: flags.types, kinds: flags.kinds, limit: flags.limit }))); return; }

  const filtTag = `${filt ? `   [type: ${[...flags.types].join(',')}]` : ''}${flags.kinds.size ? `   [kind: ${[...flags.kinds].join(',')}]` : ''}`;
  const lines = [`${a.path} (${a.type})${filtTag}`];
  if (showOut) {
    const tree = sideTree(scan, maps, uuid, 'out', flags);
    const orph = (filt || flags.kinds.size) ? [] : orphansOf(scan, uuid); // orphans are untyped/kind-less → dropped when filtering
    const n = filt ? countMatches(scan, tree, flags.types) : (maps.out.get(uuid) || []).filter((e) => matchesKind(flags, e)).length + orph.length;
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
    const n = filt ? countMatches(scan, tree, flags.types) : (maps.inc.get(uuid) || []).filter((e) => matchesKind(flags, e)).length;
    let head = n ? `  used-by ${n}${filt ? M.matched : ''}:` : `  used-by 0${filt ? M.matched : ''}`;
    if (!n && !filt && !a.inResources && a.type !== 'scene') head += '   ⚠ unreferenced';
    lines.push(head);
    renderTreeText(scan, tree, 'in', flags, lines);
  }
  console.log(lines.join('\n'));
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

// ---- info: dump one asset's record (the headless `project_get_asset_info`) ---
// type/uuid/ext/importer/size, the in/out degrees, its sub-assets, and the raw
// meta userData (the "properties"). Resolution is the shared resolveAsset, so
// path / basename / uuid / uuid@sub and the ambiguity exit-2 come for free.
function cmdInfo(scan, uuid, flags) {
  const a = scan.assets.get(uuid);
  if (flags.json) { console.log(JSON.stringify(infoData(a))); return; }
  const lines = [`${a.path} (${a.type})`];
  const row = (k, v) => lines.push(`  ${k.padEnd(10)} ${v}`);
  row('uuid', a.uuid);
  row('ext', a.ext || '—');
  row('importer', a.importer);
  row('size', a.size ? kb(a.size) : '—');
  row('resources', a.inResources ? 'yes' : 'no');
  row('degree', `used-by ${a.in}  depends-on ${a.out}`);
  if (a.subAssets.length) {
    lines.push(`  subAssets ${a.subAssets.length}:`);
    for (const s of a.subAssets) lines.push(`    ${s.kind.padEnd(14)} ${(s.name || '').padEnd(14)} ${s.uuid || ''}`);
  }
  if (a.userData && Object.keys(a.userData).length) row('userData', JSON.stringify(a.userData));
  console.log(lines.join('\n'));
}

// ---- analyze: project-wide audit (the node-run.js report, as CLI sections) ---
// `coir analyze [section]` — section ∈ stats/unused/orphans/atlas/size, or none
// for the full report. Pure data comes from query.analyzeData (shared with the
// MCP `analyze` tool); the text rendering below is CLI-only.
const histo = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('  ');
function renderStats(d, lines) {
  lines.push(`stats: ${d.assets} assets, ${d.edges} edges, orphanRefs=${d.orphanRefs}, metaErrors=${d.metaErrors}${d.metaErrors === 0 ? '   ✓ healthy' : '   ⚠'}`);
  lines.push(`  by type:    ${histo(d.byType)}`);
  lines.push(`  edge kinds: ${histo(d.edgeKinds)}`);
}
function renderUnused(d, lines) {
  lines.push(`unused: ${d.total} assets, ${kb(d.totalSize)}  (non-resources, 0 referrers)`);
  if (d.total) lines.push(`  ${histo(d.byType)}`);
  for (const i of d.items) lines.push(`   ${kb(i.size).padStart(10)}  ${i.type.padEnd(8)} ${i.path}`);
  if (d.total > d.items.length) lines.push(M.moreItems(d.total - d.items.length));
}
function renderOrphans(d, lines) {
  lines.push(`orphans: ${d.total} dangling refs (${d.missingSourceCount} missing-source)`);
  for (const i of d.items) lines.push(`   ${i.path ? `${i.path}  ${M.missingSrc}` : i.ref}  ← ${i.count} ref(s), e.g. ${i.referrers[0]}`);
  if (d.total > d.items.length) lines.push(M.moreItems(d.total - d.items.length));
  if (d.dropped) {
    lines.push(`  dropped metas: ${d.dropped.total} (${d.dropped.referencedCount} still referenced)`);
    for (const m of d.dropped.items) lines.push(`   ${m.referenced ? 'referenced' : 'orphan   '}  ${m.path}`);
  }
}
function renderAtlas(d, lines) {
  lines.push(`atlas: ${d.total} atlases/multi-frame`);
  for (const i of d.items) {
    const tag = !i.referenced ? '[unreferenced]' : i.wholeReferenced ? '[whole/dynamic]' : '';
    lines.push(`   ${`${i.used}/${i.total}`.padStart(8)} used (${(i.ratio * 100).toFixed(0)}%) ${tag.padEnd(15)} ${i.path}`);
  }
  if (d.total > d.items.length) lines.push(M.moreItems(d.total - d.items.length));
}
function renderSize(d, lines) {
  lines.push(`size: ${d.total} files, ${kb(d.totalSize)}`);
  for (const [t, v] of Object.entries(d.byType).sort((a, b) => b[1].size - a[1].size)) lines.push(`   ${t.padEnd(8)} ${String(v.count).padStart(4)} files  ${kb(v.size).padStart(11)}`);
  if (d.items) for (const i of d.items) lines.push(`     ${kb(i.size).padStart(10)}  ${i.type.padEnd(8)} ${i.path}`);
  else lines.push(M.listHint);
}
const RENDER = { stats: renderStats, unused: renderUnused, orphans: renderOrphans, atlas: renderAtlas, size: renderSize };

function cmdAnalyze(scan, section, flags) {
  if (section && !ANALYZE_SECTIONS.includes(section)) { console.error(M.unknownSection(section, ANALYZE_SECTIONS)); process.exit(1); }
  const limit = flags.limit === Infinity ? 30 : flags.limit;
  const opts = { types: flags.types, limit, dropped: flags.dropped, list: flags.list };
  if (!section) { // full report (all sections)
    const all = analyzeAll(scan, opts);
    if (flags.json) { console.log(JSON.stringify(all)); return; }
    const lines = [];
    for (const s of ANALYZE_SECTIONS) { RENDER[s](all[s], lines); lines.push(''); }
    console.log(lines.join('\n').trimEnd());
    return;
  }
  const d = analyzeData(scan, section, opts);
  if (flags.json) { console.log(JSON.stringify(d)); return; }
  const lines = [];
  RENDER[section](d, lines);
  console.log(lines.join('\n'));
}

async function main() {
  const { projectDir, command, target, pos, flags } = parseArgs(process.argv.slice(2));
  if (flags.help) { console.log(USAGE); process.exit(0); }
  if (flags.version) { console.log(`coir ${VERSION}`); process.exit(0); }
  if (!projectDir || !command) { console.error(USAGE); process.exit(1); }

  // Built-ins + coir-root global config + project-local config + --plugin files.
  // External plugins thus live outside the coir repo (most specific last).
  const sameAsRoot = path.resolve(projectDir) === path.resolve(COIR_ROOT);
  const plugins = dedupePlugins([
    ...PLUGINS,
    ...await loadConfigPlugins(COIR_ROOT),                       // cross-project / global
    ...(sameAsRoot ? [] : await loadConfigPlugins(projectDir)), // this project only
    ...await loadPluginFiles(flags.plugins),                    // --plugin <file>
  ]);

  // `coir mcp` is a long-lived MCP server (it manages its own scan + fs.watch),
  // not a one-shot query — hand off before the single scan below.
  if (command === 'mcp') { const { startMcpServer } = await import('./mcp/server.js'); await startMcpServer(projectDir, { plugins }); return; }

  let scan;
  try { scan = await scanProject(makeFsProvider(path.join(projectDir, 'assets')), { plugins }); }
  catch (e) {
    console.error(M.scanFail(e.message));
    if (flags.project == null && /ENOENT/.test(e.message)) console.error(M.scanHint); // default cwd had no assets/ → likely meant -C
    process.exit(1);
  }

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
  if (command === 'analyze') { cmdAnalyze(scan, target, flags); return; } // project-wide; target = the section (or none)
  if (command === 'edit') { cmdEdit(scan, projectDir, flags, pos); return; }

  if (!['deps', 'uses', 'closure', 'info'].includes(command)) {
    console.error(`${M.unknownCmd(command)}\n\n${USAGE}`); process.exit(1);
  }
  if (!target) { console.error(`${M.needTarget(command)}\n\n${USAGE}`); process.exit(1); }

  const uuid = resolveAsset(scan, target); // prints candidates / not-found and exits 2 on miss

  if (command === 'info') { cmdInfo(scan, uuid, flags); return; }
  if (command === 'closure') { cmdClosure(scan, uuid, flags); return; }
  const f = { ...flags };
  if (command === 'uses') f.dir = 'in';
  cmdDeps(scan, edgeMaps(scan), uuid, f);
}

main().catch((e) => { console.error(e); process.exit(1); });
