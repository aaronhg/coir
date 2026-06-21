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
import { mainUuid, subOf, looksCompressed, decompressUuid } from './core/uuid.js';
import { knownTypes } from './core/meta.js';
import { PLUGINS, dedupePlugins } from './core/plugins/index.js';
import { collectPluginCommands, mapPositionals } from './seam/pluginCommands.js';
import { loadConfigPlugins, loadPluginFiles } from './node/loadPlugins.js';
import { makeFsProvider } from './node/fsProvider.js';
import { base, kb, resolveAsset, edgeMaps, orphansOf, locText, edgeSort, shareData } from './seam/shared.js';
import { depsData, infoData, analyzeData, analyzeAll, ANALYZE_SECTIONS } from './seam/query.js';
import { duplicatesData } from './core/duplicates.js';
import { evaluateRules, DEFAULT_RULES, needsDuplicates, collectPluginCheckers } from './core/rules.js';
import { cmdEdit, cmdVerify, cmdVerifyAll, cmdRoundtrip, cmdNativeVerify } from './editCli.js';

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
  coir share   <asset> [--depth N] [--base <url>] [--blob] [-o json]   shareable #topo= snapshot link of its neighbourhood
  coir analyze [section] [-o json]   project-wide audit; section = stats|unused|orphans|atlas|size|bundles (none = all)
                                     stats=counts/edge-kinds/health  unused=0-referrer assets  orphans [--dropped]
                                     atlas=frame utilization  size [--type T] [--list]  bundles=cross-bundle deps/cycles/dup
  coir duplicates [files|configs] [--type T] [-o json]   redundant assets: byte-identical files / structurally
                                     identical prefab·material·anim (none = both). Pair with edit --all swap-uuid.
  coir check [--rules <file>] [-o json]   declarative CI gate — evaluates coir.rules.json (no-bundle-cycle,
                                     max-duplication, no-dangling-refs, no-orphans, …); EXITS 1 on error, 2 on bad config.

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

Validate:
  coir verify <file> [-o json]               offline structural check (also: edit <file> verify); EXITS 1 on a broken file
  coir verify --all [-o json]                same check over EVERY prefab/scene (no target) — one CI gate for project structural health; EXITS 1 if any file is broken
  coir verify --all --roundtrip [-o json]    offline, read-only edit-engine audit (no editor) over every prefab/scene:
                                     byte round-trip (serializer fidelity, WARN) + add-then-remove invertible probe
                                     (compaction/clone corruption, ERROR); per-file with <file>; EXITS 1 on any failure
  coir native-verify <file> [--port N] [-o json]   verify's LIVE twin — the running Cocos editor (the coir
                                     extension's opt-in endpoint) reimports+instantiates the file and confirms the engine
                                     builds what coir parsed; EXITS 1 on mismatch, 2 if unreachable / wrong project
                                     (start it: Cocos Creator menu Coir ▸ native-verify: start, or the goto-panel toggle)

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
  const flags = { dir: null, depth: null, where: false, json: false, list: false, limit: Infinity, types: new Set(), kinds: new Set(), plugins: [], dryRun: false, backup: false, value: null, index: null, all: false, help: false, version: false, project: null, with: null, under: null, force: false, dropped: false, base: null, blob: false };
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
    else if (a === '--values') flags.values = true; // edit tree: inline node/component values (deep read)
    else if (a === '--diff') flags.diff = true; // edit: print a unified diff of the change (works with --dry-run)
    else if (a === '--verify') flags.verify = true; // edit: structurally validate the result before writing
    else if (a === '--roundtrip') flags.roundtrip = true; // verify: serializer-fidelity + invertible-edit audit (with --all = whole project)
    else if (a === '--port') flags.port = parseInt(argv[++i], 10) || undefined; // native-verify: endpoint port (default: auto-probe 3789..3809)
    else if (a.startsWith('--port=')) flags.port = parseInt(a.slice(7), 10) || undefined;
    else if (a === '-o' || a === '--output') { if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) flags.json = argv[++i] === 'json'; } // output format (text default)
    else if (a.startsWith('--output=')) flags.json = a.slice(9) === 'json';
    else if (a === '--list') flags.list = true;
    else if (a === '--dropped') flags.dropped = true; // analyze orphans: also list dropped source-less metas
    else if (a === '--depth') flags.depth = parseInt(argv[++i], 10) || 1;
    else if (a.startsWith('--depth=')) flags.depth = parseInt(a.slice(8), 10) || 1;
    else if (a === '--limit') flags.limit = parseInt(argv[++i], 10) || Infinity;
    else if (a.startsWith('--limit=')) flags.limit = parseInt(a.slice(8), 10) || Infinity;
    else if (a === '--base') { if (argv[i + 1] !== undefined) flags.base = argv[++i]; } // share: viewer base URL
    else if (a.startsWith('--base=')) flags.base = a.slice(7);
    else if (a === '--blob') flags.blob = true; // share: output the bare #topo= blob, not the full URL
    else if (a === '--rules') { if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) flags.rules = argv[++i]; } // check: rules file path
    else if (a.startsWith('--rules=')) flags.rules = a.slice(8);
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
  row('bundle', a.bundle || '—');
  row('resources', a.inResources ? 'yes' : 'no');
  row('degree', `used-by ${a.in}  depends-on ${a.out}`);
  if (a.subAssets.length) {
    lines.push(`  subAssets ${a.subAssets.length}:`);
    for (const s of a.subAssets) lines.push(`    ${s.kind.padEnd(14)} ${(s.name || '').padEnd(14)} ${s.uuid || ''}`);
  }
  if (a.userData && Object.keys(a.userData).length) row('userData', JSON.stringify(a.userData));
  console.log(lines.join('\n'));
}

// ---- share: a #topo= snapshot link of an asset's neighbourhood (headless) ----
// The CLI equivalent of the browser's "copy topology link" — `shareData` runs the
// shared `encodeTopo` and builds the viewer URL (same as the MCP `share` tool).
async function cmdShare(scan, uuid, flags) {
  const a = scan.assets.get(uuid);
  const r = await shareData(scan, uuid, { depth: flags.depth, base: flags.base, title: a ? base(a.path) : undefined });
  if (flags.json) { console.log(JSON.stringify(r)); return; }
  console.log(flags.blob ? `#topo=${r.blob}` : r.url);
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
  lines.push(`unused: ${d.total} assets, ${kb(d.totalSize)}  (unbundled, 0 referrers)`);
  if (d.total) lines.push(`  ${histo(d.byType)}`);
  for (const i of d.items) lines.push(`   ${kb(i.size).padStart(10)}  ${i.type.padEnd(8)} ${i.path}`);
  if (d.total > d.items.length) lines.push(M.moreItems(d.total - d.items.length));
  if (d.candidatesTotal) { // 0-referrer assets inside a bundle — runtime-load candidates, not flagged
    lines.push(`  bundle assets with 0 static referrers (loaded by path? — not flagged): ${d.candidatesTotal}`);
    for (const i of d.candidates) lines.push(`   ${kb(i.size).padStart(10)}  ${i.type.padEnd(8)} ${i.path}  [${i.bundle}]`);
    if (d.candidatesTotal > d.candidates.length) lines.push(M.moreItems(d.candidatesTotal - d.candidates.length));
  }
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
function renderBundles(d, lines) {
  if (!d.total) { lines.push('bundles: none (no Asset Bundles configured)'); return; }
  lines.push(`bundles: ${d.total}${d.cycles.length ? `, ${d.cycles.length} cycle(s) ⚠` : ''}`);
  for (const b of d.bundles) lines.push(`   ${kb(b.size).padStart(11)}  ${String(b.members).padStart(4)} files  ${b.name.padEnd(16)} (deps ${b.out}, dependents ${b.in})`);
  if (d.cycles.length) { lines.push('  cycles (linked both ways — a leaky boundary):'); for (const c of d.cycles) lines.push(`   ${c.a} ⇄ ${c.b}`); }
  if (d.dup && d.dup.totalWasted > 0) {
    lines.push(`  duplication: ${kb(d.dup.totalWasted)} wasted across ${d.dup.total} assets copied into ≥2 same-priority bundles`);
    for (const i of d.dup.items) lines.push(`   ${kb(i.wasted).padStart(11)}  ×${i.copies}  ${i.type.padEnd(8)} ${i.path}  [${i.bundles.join(', ')}]`);
    if (d.dup.total > d.dup.items.length) lines.push(M.moreItems(d.dup.total - d.dup.items.length));
  }
  if (d.links.length) {
    lines.push('  cross-bundle references:');
    for (const l of d.links) {
      lines.push(`   ${l.from} → ${l.to}  (${l.refsTotal})${l.cycle ? '  ⇄' : ''}`);
      for (const r of l.refs) lines.push(`      ${r.from}  --${r.kind}-->  ${r.to}`);
      if (l.refsTotal > l.refs.length) lines.push(M.moreItems(l.refsTotal - l.refs.length));
    }
  }
}
const RENDER = { stats: renderStats, unused: renderUnused, orphans: renderOrphans, atlas: renderAtlas, size: renderSize, bundles: renderBundles };

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

// ---- duplicates: redundant assets (needs I/O, so not an analyze section) ------
// `coir duplicates [files|configs]` — files = byte-identical sources, configs =
// structurally identical prefab/material/anim. Pair with `edit --all swap-uuid`.
function renderDupGroups(groups, lines, label) {
  lines.push(`${label}: ${groups.length} group(s), ${kb(groups.reduce((s, g) => s + g.reclaimable, 0))} reclaimable`);
  for (const g of groups) {
    const flags = g.warnings.length ? `  [${g.warnings.join(', ')}]` : (g.mergeable ? '' : '  [not-mergeable]');
    lines.push(`  ${g.key}${g.size ? ` ${kb(g.size)}` : ''} ×${g.count} · save ${kb(g.reclaimable)}${flags}`);
    for (const m of g.members) lines.push(`      ${m.uuid === g.canonical ? '✓ keep ' : '  drop '} ${m.path}${m.in ? `  (${m.in} ref)` : ''}`);
  }
}
async function cmdDuplicates(scan, fp, section, flags) {
  if (section && !['files', 'configs'].includes(section)) { console.error(`unknown section '${section}' (files|configs)`); process.exit(1); }
  const readers = { readBytes: fp.bytes ? (p) => fp.bytes(p) : undefined, readText: (p) => fp.readText(p) };
  const d = await duplicatesData(scan, readers, { section, types: flags.types });
  if (flags.json) { console.log(JSON.stringify(d)); return; }
  const lines = [];
  if (d.files) renderDupGroups(d.files, lines, 'files (byte-identical)');
  if (d.files && d.configs) lines.push('');
  if (d.configs) renderDupGroups(d.configs, lines, 'configs (structurally identical)');
  if (!d.files && !d.configs) lines.push('nothing to check');
  lines.push('', `total reclaimable: ${kb(d.summary.reclaimable)}  ·  merge with: coir edit --all swap-uuid <drop> <keep>`);
  console.log(lines.join('\n'));
}

// check: declarative CI gate. Loads coir.rules.json (or --rules <file>, else a
// default health ruleset at warn level), evaluates the pure rule engine, prints
// each violation, and EXITS non-zero on failure (error → 1, config error → 2) so
// it can gate CI. -o json emits { violations, errors, warns, configErrors }.
async function cmdCheck(scan, fp, projectDir, flags, plugins) {
  const rulesPath = flags.rules || path.join(projectDir, 'coir.rules.json');
  let raw = null, usedDefault = false;
  try { raw = JSON.parse(readFileSync(rulesPath, 'utf8')); }
  catch (e) { if (flags.rules) { console.error(`✗ cannot read rules file: ${rulesPath}`); process.exit(2); } }
  let rules = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.rules) ? raw.rules : null);
  if (!rules) { rules = DEFAULT_RULES; usedDefault = true; }

  const ctx = {};
  if (needsDuplicates(rules)) {
    const readers = { readBytes: fp.bytes ? (p) => fp.bytes(p) : undefined, readText: (p) => fp.readText(p) };
    ctx.duplicates = await duplicatesData(scan, readers, {});
  }
  const res = evaluateRules(scan, rules, ctx, collectPluginCheckers(plugins));
  if (flags.json) { console.log(JSON.stringify(res)); }
  else {
    const ICON = { error: '✗', warn: '⚠', config: '⚙' };
    if (usedDefault) console.log('(no coir.rules.json — default health checks at warn level; add rules to gate CI)');
    for (const v of res.violations) console.log(`${ICON[v.level] || '·'} ${v.rule.padEnd(18)} ${v.message}`);
    if (!res.violations.length) console.log('✓ all rules passed');
    else {
      const parts = [];
      if (res.errors) parts.push(`${res.errors} error(s)`);
      if (res.warns) parts.push(`${res.warns} warning(s)`);
      if (res.configErrors) parts.push(`${res.configErrors} config error(s)`);
      console.log(`\n${parts.join(', ')}`);
    }
  }
  process.exit(res.configErrors ? 2 : res.errors ? 1 : 0);
}

// --- Plugin-contributed commands -------------------------------------------
// A plugin adds `commands: [{ name, usage?, description?, inputSchema?, positional?,
// run(ctx) }]`. Registration is ONCE: the same command also becomes an MCP tool
// when it carries an `inputSchema` (see src/mcp/server.js). `run(ctx)` RETURNS a
// result (never prints) so one definition serves both hosts — here the CLI prints
// it (text, or JSON on -o json); MCP returns it. `collectPluginCommands` +
// `mapPositionals` are shared with the MCP server (src/pluginCommands.js).
function renderPluginCommandsHelp(cmds) {
  if (!cmds.size) return '';
  const lines = [...cmds.values()].map((c) => `  ${c.usage}`);
  return `\n\nPlugin commands:\n${lines.join('\n')}`;
}

// The context a plugin command's run(ctx) gets in the CLI. `args` is the named
// object (CLI positionals mapped via the command's `positional` names) — the same
// shape the MCP host passes — so one `run` works in both. `env` lets a command
// branch if it must; `flags` is the parsed CLI flags (CLI only).
function makeCmdCtx({ cmd, pos, flags, projectDir, scan, fp }) {
  return {
    env: 'cli',
    command: cmd.name,
    args: mapPositionals(cmd, pos), // named args (matches the MCP JSON shape)
    argv: pos,                      // raw positionals (escape hatch)
    flags,
    projectDir,
    scan,
    readText: (p) => fp.readText(p),            // read any source under assets/ (POSIX-relative)
    resolveAsset: (q) => resolveAsset(scan, q), // path/basename/uuid[@sub] → uuid; prints candidates + exits 2 on miss
    edgeMaps: () => edgeMaps(scan),
    uuid: { mainUuid, subOf, looksCompressed, decompressUuid },
    util: { base, kb },
  };
}

async function main() {
  const { projectDir, command, target, pos, flags } = parseArgs(process.argv.slice(2));
  if (flags.version) { console.log(`coir ${VERSION}`); process.exit(0); }

  // Built-ins + coir-root global config + project-local config + --plugin files.
  // External plugins thus live outside the coir repo (most specific last).
  const sameAsRoot = path.resolve(projectDir) === path.resolve(COIR_ROOT);
  const plugins = dedupePlugins([
    ...PLUGINS,
    ...await loadConfigPlugins(COIR_ROOT),                       // cross-project / global
    ...(sameAsRoot ? [] : await loadConfigPlugins(projectDir)), // this project only
    ...await loadPluginFiles(flags.plugins),                    // --plugin <file>
  ]);
  // Plugin-contributed CLI commands (built-ins always win); also appended to --help.
  const pluginCommands = collectPluginCommands(plugins);
  const helpText = USAGE + renderPluginCommandsHelp(pluginCommands);

  if (flags.help) { console.log(helpText); process.exit(0); }
  if (!projectDir || !command) { console.error(helpText); process.exit(1); }

  // `coir mcp` is a long-lived MCP server (it manages its own scan + fs.watch),
  // not a one-shot query — hand off before the single scan below.
  if (command === 'mcp') { const { startMcpServer } = await import('./mcp/server.js'); await startMcpServer(projectDir, { plugins }); return; }

  let scan;
  const fp = makeFsProvider(path.join(projectDir, 'assets'));
  try { scan = await scanProject(fp, { plugins }); }
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
  if (command === 'duplicates') { await cmdDuplicates(scan, fp, target, flags); return; } // redundant assets (byte / structural)
  if (command === 'check') { await cmdCheck(scan, fp, projectDir, flags, plugins); return; } // declarative CI gate (exits non-zero on failure)
  if (command === 'edit') { cmdEdit(scan, projectDir, flags, pos); return; }
  if (command === 'verify') { if (flags.roundtrip) cmdRoundtrip(scan, projectDir, flags, [target]); else if (flags.all) cmdVerifyAll(scan, projectDir, flags); else cmdVerify(scan, projectDir, flags, [target]); return; } // offline structural validation (--all: whole project · --roundtrip: serializer-fidelity / invertible-edit audit)
  if (command === 'roundtrip') { cmdRoundtrip(scan, projectDir, flags, [target]); return; } // alias: verify --roundtrip
  if (command === 'native-verify') { await cmdNativeVerify(scan, projectDir, flags, [target]); return; } // live-engine cross-check (needs the cocos-extension endpoint)

  // Plugin-contributed commands run after the built-ins (a plugin cannot shadow a built-in).
  const pcmd = pluginCommands.get(command);
  if (pcmd) {
    const res = await pcmd.run(makeCmdCtx({ cmd: pcmd, pos, flags, projectDir, scan, fp }));
    if (res && res.error) {
      console.error(`✗ ${res.error}`);
      if (Array.isArray(res.candidates) && res.candidates.length) console.error(res.candidates.join('\n'));
      process.exit(2);
    }
    if (res && (res.data !== undefined || res.text !== undefined)) {
      console.log(flags.json ? JSON.stringify(res.data ?? null) : (res.text ?? JSON.stringify(res.data ?? null, null, 2)));
    }
    return;
  }

  if (!['deps', 'uses', 'closure', 'info', 'share'].includes(command)) {
    console.error(`${M.unknownCmd(command)}\n\n${helpText}`); process.exit(1);
  }
  if (!target) { console.error(`${M.needTarget(command)}\n\n${USAGE}`); process.exit(1); }

  const uuid = resolveAsset(scan, target); // prints candidates / not-found and exits 2 on miss

  if (command === 'info') { cmdInfo(scan, uuid, flags); return; }
  if (command === 'closure') { cmdClosure(scan, uuid, flags); return; }
  if (command === 'share') { await cmdShare(scan, uuid, flags); return; }
  const f = { ...flags };
  if (command === 'uses') f.dir = 'in';
  cmdDeps(scan, edgeMaps(scan), uuid, f);
}

main().catch((e) => { console.error(e); process.exit(1); });
