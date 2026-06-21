// CLI presentation layer for in-place prefab/scene editing: arg shapes, value
// flags, text rendering, dry-run/json/backup. The actual edit logic (resolve →
// load → mutate → {json, writes}) lives in the pure seam src/edit/ops.js, shared
// verbatim with the MCP server — so this file only parses args, coerces value
// flags, renders text, and commits writes. core stays read-only. See docs/EDITING.md.
//
//   edit <file> tree [--with T] [--under sel] [--depth N]   list structure (read-only)
//   edit <file> get  <sel>                                  read a value/node/component
//   edit <file> set  <sel:Type.prop> <value-flag>           set a component property
//   edit <file> rename / set-active / set-pos / set-parent / add-node / rm-node / …
import { mainUuid } from './core/uuid.js';
import { componentName } from './core/selector.js';
import { resolveAsset, edgeMaps, locText } from './seam/shared.js';
import { runEdit, runSwapAll, runBatch, commitWrites, resolveRawTypes, getData, treeData, verifyData, verifyText } from './edit/ops.js';
import { unifiedDiff } from './edit/diff.js';
import fs from 'node:fs';

// CLI-only messages: usage + value-flag errors. Operation errors (bad selector,
// instance guard, not-a-prefab, …) come back from ops.js verbatim and are printed
// by failExit, so they live in ONE place (ops.OM) shared with the MCP server.
const EM = {
  editUsage: 'edit needs: <file> <op> …   (op: tree / get / set / set-uuid / swap-uuid / rename / set-active / set-layer / set-pos / set-scale / set-rot / set-parent / add-node / rm-node / add-component / rm-component)',
  editUnknownOp: (op) => `unknown edit op "${op}"`,
  swapUsage: 'swap-uuid needs: <file> swap-uuid <oldAsset> <newAsset>',
  swapNoop: (q) => `(no references to "${q}" in this file — nothing changed)`,
  dryRunSuffix: '   [dry-run — not written]',
  written: (bak) => `  ✓ written${bak ? ' (.bak saved)' : ''}`,
  conflict: (m) => `✗ ${m}`,
  getUsage: 'get needs: <file> get <selector>   (reads the value/node/component; -o json for raw, round-trips into set --json)',
  setUsage: 'set needs: <file> set <selector:Comp.prop> <value-flag>   (e.g. --str/--int/--vec3/--uuid)',
  setUuidUsage: 'set-uuid needs: <file> set-uuid <selector:Comp.prop> <asset>',
  noValue: (op) => `✗ ${op} needs a value flag (--str/--int/--num/--bool/--enum/--color/--vec2/3/4/--size/--quat/--uuid/--json/--null)`,
  nodeOpUsage: (op) => `${op} needs: <file> ${op} <nodeSelector> ${op === 'rename' ? '<newName>' : '<value-flag>'}`,
  rotNeedsVec3: 'set-rot needs --vec3 <x> <y> <z> (euler degrees)',
  setParentUsage: 'set-parent needs: <file> set-parent <nodeSelector> <newParentSelector> [--index i]',
  addNodeUsage: 'add-node needs: <file> add-node <parentSelector> <name> [--index i]',
  addCompUsage: 'add-component needs: <file> add-component <nodeSelector> <ccType>',
  wrongFlag: (op, want) => `✗ ${op} needs a ${want.join('/')} value (a different --flag was given)`,
  unknownType: (names) => `✗ unknown __type__ class(es): ${names.join(', ')} — no matching script asset in the project`,
  allSkipped: (n, files) => `⚠ skipped ${n} unparseable file(s): ${files.join(', ')}`,
  allOnlySwap: (op) => `--all currently supports only swap-uuid (selector ops like "${op}" are per-file)`,
  allHead: (from, to) => `swap ${from} → ${to}   (project-wide)`,
  allNoop: (q) => `(no references to "${q}" anywhere — nothing changed)`,
  allWritten: (n, bak) => `  ✓ ${n} file(s) written${bak ? ' (.bak saved)' : ''}`,
  badValue: (m) => `✗ bad value: ${m}`,
};

const assetPath = (scan, uuid) => scan.assets.get(uuid)?.path || uuid;

// Stashed so the shared commit chokepoint (commitOrExit) can run `--verify`
// (verifyText needs the scan) without threading it through every applyResult call.
let _scan = null;

export function cmdEdit(scan, projectDir, flags, pos) {
  _scan = scan;
  if (flags.all) return cmdEditAll(scan, projectDir, flags, pos); // project-wide: pos = [op, …]
  const file = pos[0]; const op = pos[1];
  if (!file || !op) { console.error(EM.editUsage); process.exit(1); }
  switch (op) {
    case 'swap-uuid': return cmdSwapUuid(scan, projectDir, flags, pos);
    case 'tree': return cmdTree(scan, projectDir, flags, pos);
    case 'get': return cmdGet(scan, projectDir, flags, pos);
    case 'verify': return cmdVerify(scan, projectDir, flags, pos);
    case 'batch': return cmdBatch(scan, projectDir, flags, pos);
    case 'set': return cmdSet(scan, projectDir, flags, pos);
    case 'set-uuid': return cmdSetUuid(scan, projectDir, flags, pos);
    case 'rename': case 'set-active': case 'set-layer': case 'set-pos': case 'set-scale': case 'set-rot':
      return nodeOp(scan, projectDir, flags, pos, op);
    case 'set-parent': return cmdSetParent(scan, projectDir, flags, pos);
    case 'add-node': return cmdAddNode(scan, projectDir, flags, pos);
    case 'rm-node': return cmdRmNode(scan, projectDir, flags, pos);
    case 'add-component': return cmdAddComponent(scan, projectDir, flags, pos);
    case 'rm-component': return cmdRmComponent(scan, projectDir, flags, pos);
    default: console.error(EM.editUnknownOp(op)); process.exit(1);
  }
}

// ---- helpers ---------------------------------------------------------------
// Print an ops error result (its message + any candidate lines) and exit.
function failExit(r) { console.error(r.error); for (const c of r.candidates || []) console.error(`    ${c}`); process.exit(r.code); }
// Commit the write plan (mtime-guarded unless --force), then exit 2 on a
// concurrent-change conflict so a caller never clobbers an editor's save.
// --diff: print a unified diff of each planned write (works in dry-run too — it's
// the preview). Text-mode only (so it never corrupts -o json output).
function printDiff(flags, writes) {
  if (!flags.diff || flags.json || !writes) return;
  for (const w of writes) {
    if (w == null || w.oldText == null) continue;
    if (writes.length > 1) console.log(`# ${w.absPath}`);
    const d = unifiedDiff(w.oldText, w.text);
    console.log(d || '(no textual change)');
  }
}
function commitOrExit(r, flags) {
  // --verify: structurally validate the planned text BEFORE writing; abort on errors.
  if (flags.verify) {
    for (const w of r.writes || []) {
      const v = verifyText(_scan, w.text);
      if (v.errors.length) {
        console.error(`✗ verify: ${v.errors.length} structural error(s) — not written`);
        for (const e of v.errors.slice(0, 10)) console.error(`    ${e.msg}`);
        process.exit(2);
      }
    }
  }
  try { commitWrites(r.writes, { backup: flags.backup, force: flags.force }); }
  catch (e) { console.error(EM.conflict(e instanceof Error ? e.message : String(e))); process.exit(2); }
}
// The post-mutation half: commit (unless dry-run) + print desc/json. `desc` is
// the CLI text body; the json is r.json plus {file, dryRun}.
function applyResult(flags, r, desc) {
  printDiff(flags, r.writes);
  if (!flags.dryRun) commitOrExit(r, flags);
  if (flags.json) { console.log(JSON.stringify({ file: r.asset.path, ...r.json, dryRun: !!flags.dryRun })); return; }
  const lines = [desc + (flags.dryRun ? EM.dryRunSuffix : '')];
  if (!flags.dryRun) lines.push(EM.written(flags.backup));
  console.log(lines.join('\n'));
}
// Turn a typed value spec (from a --flag) into the JS value Cocos serializes.
// CLI-only (exits on a bad value); the MCP server takes typed values directly.
function resolveValueSpec(scan, spec) {
  const a = spec.args || [];
  const n = (x) => { const v = Number(x); if (Number.isNaN(v)) { console.error(EM.badValue(`"${x}" is not a number`)); process.exit(1); } return v; };
  switch (spec.type) {
    case 'null': return null;
    case 'str': return a[0] ?? '';
    case 'int': case 'enum': return Math.trunc(n(a[0]));
    case 'num': return n(a[0]);
    case 'bool': return a[0] === 'true' || a[0] === '1';
    case 'uuid':
      if (!a[0]) { console.error(EM.badValue('--uuid needs an asset')); process.exit(1); }
      return { __uuid__: resolveAsset(scan, a[0]) };
    case 'color': {
      if (a[0] && a[0].startsWith('#')) {
        const h = a[0].slice(1);
        if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(h)) { console.error(EM.badValue(`bad hex color "${a[0]}" (#RRGGBB or #RRGGBBAA)`)); process.exit(1); }
        const p = (i) => parseInt(h.slice(i, i + 2), 16);
        return { __type__: 'cc.Color', r: p(0), g: p(2), b: p(4), a: h.length >= 8 ? p(6) : 255 };
      }
      return { __type__: 'cc.Color', r: n(a[0]), g: n(a[1]), b: n(a[2]), a: a[3] !== undefined ? n(a[3]) : 255 };
    }
    case 'vec2': return { __type__: 'cc.Vec2', x: n(a[0]), y: n(a[1]) };
    case 'vec3': return { __type__: 'cc.Vec3', x: n(a[0]), y: n(a[1]), z: n(a[2]) };
    case 'vec4': return { __type__: 'cc.Vec4', x: n(a[0]), y: n(a[1]), z: n(a[2]), w: n(a[3]) };
    case 'size': return { __type__: 'cc.Size', width: n(a[0]), height: n(a[1]) };
    case 'quat': return { __type__: 'cc.Quat', x: n(a[0]), y: n(a[1]), z: n(a[2]), w: n(a[3]) };
    case 'json': {
      if (a[0] === undefined) { console.error(EM.badValue('--json needs a JSON value')); process.exit(1); }
      let v; try { v = JSON.parse(a[0]); } catch (e) { console.error(EM.badValue(`invalid JSON: ${e.message}`)); process.exit(1); }
      const unknown = [];
      resolveRawTypes(scan, v, unknown); // class-name __type__ → compressed token (builtins/tokens pass through)
      if (unknown.length) { console.error(EM.unknownType([...new Set(unknown)])); process.exit(1); }
      return v;
    }
    default: console.error(EM.badValue(spec.type)); process.exit(1);
  }
}

// ---- Tier 0: swap-uuid (text patch, special output) ------------------------
function cmdSwapUuid(scan, projectDir, flags, pos) {
  if (!pos[2] || !pos[3]) { console.error(EM.swapUsage); process.exit(1); }
  const r = runEdit(scan, projectDir, 'swap-uuid', { file: pos[0], old: pos[2], new: pos[3] });
  if (r.error) failExit(r);
  const { from, to, fromUuid, count } = r.json;
  if (flags.json) {
    if (count && !flags.dryRun) commitOrExit(r, flags);
    console.log(JSON.stringify({ file: r.asset.path, ...r.json, dryRun: !!flags.dryRun }));
    return;
  }
  const head = `${r.asset.path}: swap ${from} → ${to}`;
  if (count === 0) { console.log(`${head}\n  ${EM.swapNoop(pos[2])}`); return; }
  const lines = [head, `  ${count} reference(s)${flags.dryRun ? EM.dryRunSuffix : ''}`];
  const outs = (edgeMaps(scan).out.get(r.asset.uuid) || []).filter((e) => mainUuid(e.to) === fromUuid);
  for (const e of outs) for (const loc of e.locations) lines.push(`    ${locText(scan, loc)}`);
  printDiff(flags, r.writes);
  if (!flags.dryRun) { commitOrExit(r, flags); lines.push(EM.written(flags.backup)); }
  console.log(lines.join('\n'));
}

// ---- tree: list the node hierarchy + each node's components (read-only) -----
// Structure discovery — every node's disambiguated path + each component's ready
// `nodePath:Type` selector, so an agent finds every editable point WITHOUT
// parsing the file. `-o json` is the machine form; `--with`/`--under`/`--depth`.
function cmdTree(scan, projectDir, flags, pos) {
  const depth = flags.depth == null ? Infinity : flags.depth; // tree defaults to the whole tree
  const r = treeData(scan, projectDir, pos[0], { withType: flags.with, under: flags.under, depth, values: !!flags.values });
  if (r.error) failExit(r);
  if (flags.json) { console.log(JSON.stringify({ file: r.file, nodeCount: r.nodeCount, nodes: r.nodes })); return; }

  // text: indented tree (leaf · #index · component tokens). --with breaks the
  // hierarchy, so it renders flat with the full path shown (still copy-pasteable).
  const flat = !!flags.with;
  const lines = [`${r.file} — ${r.nodeCount} node${r.nodeCount === 1 ? '' : 's'}`
    + (flags.with ? ` with ${flags.with}` : '') + (flags.under ? ` under ${flags.under}` : '')];
  const tok = (c) => c.selector.slice(c.selector.lastIndexOf(':') + 1); // "Type[i]" or "#index"
  for (const n of r.nodes) {
    const indent = flat ? '  ' : `  ${'  '.repeat(n.depth)}`;
    const name = flat ? n.path : (n.path.slice(n.path.lastIndexOf('/') + 1) || n.name || '(root)');
    const marks = (n.active ? '' : ' (off)') + (n.instance ? ' [prefab instance]' : '');
    const comps = n.instance ? '' : n.components.map(tok).join(' ');
    lines.push(`${`${indent}${name}${marks}`.padEnd(38)} #${n.index}${comps ? `   ${comps}` : ''}`);
    // --values (text): one compact line per component with its serialized value.
    if (flags.values && !n.instance) for (const c of n.components) lines.push(`${indent}    ${tok(c)} = ${JSON.stringify(c.value)}`);
  }
  console.log(lines.join('\n'));
}

// ---- verify: offline structural validation of a prefab/scene (no live engine) -
export function cmdVerify(scan, projectDir, flags, pos) {
  const r = verifyData(scan, projectDir, pos[0]);
  if (r.error) failExit(r);
  if (flags.json) { console.log(JSON.stringify(r)); process.exit(r.valid ? 0 : 1); }
  console.log(`${r.file} — ${r.entries} entries: ${r.valid ? '✓ structurally valid' : `✗ ${r.errors.length} error(s)`}`
    + (r.warnings.length ? `, ${r.warnings.length} warning(s)` : ''));
  for (const e of r.errors) console.log(`  ✗ [${e.code}] ${e.msg}`);
  for (const w of r.warnings) console.log(`  ⚠ [${w.code}] ${w.msg}`);
  process.exit(r.valid ? 0 : 1); // non-zero on structural errors → CI-gateable
}

// ---- batch: apply many ops to one file atomically (all-or-nothing) -----------
// `edit <file> batch <ops.json>` — opsArg is a path to a JSON file OR inline JSON,
// an array of {op, …params} (the same params each edit op takes, minus `file`).
function cmdBatch(scan, projectDir, flags, pos) {
  const file = pos[0]; const opsArg = pos[2];
  if (!opsArg) { console.error('batch needs: <file> batch <ops.json>   (a JSON file or inline JSON array of {op,…})'); process.exit(1); }
  let text; try { text = fs.readFileSync(opsArg, 'utf8'); } catch { text = opsArg; } // path → read; else treat as inline JSON
  let ops; try { ops = JSON.parse(text); } catch (e) { console.error(EM.badValue(`invalid ops JSON: ${e instanceof Error ? e.message : e}`)); process.exit(1); }
  const r = runBatch(scan, projectDir, file, ops);
  if (r.error) failExit(r);
  applyResult(flags, r, `${r.asset.path}: batch — ${r.json.count} op(s) applied`);
}

// ---- get: read the value/node/component at a selector (set's read pair) ----
// `-o json` prints the RAW value (round-trips into `set --json`); the default
// text annotates a __uuid__ with its asset path and a compressed __type__ with
// its class name.
function renderGet(scan, v) {
  if (v === undefined) return '(no such property)';
  if (v && typeof v === 'object' && typeof v.__uuid__ === 'string') {
    return `${assetPath(scan, mainUuid(v.__uuid__))}   (uuid ${v.__uuid__})`;
  }
  const out = JSON.stringify(v ?? null, null, 2);
  if (v && typeof v === 'object' && typeof v.__type__ === 'string') {
    const name = componentName(scan, v.__type__);
    if (name && name !== v.__type__) return `// ${name}\n${out}`; // show class name for a compressed __type__
  }
  return out;
}
function cmdGet(scan, projectDir, flags, pos) {
  const sel = pos[2];
  if (!sel) { console.error(EM.getUsage); process.exit(1); }
  const r = getData(scan, projectDir, pos[0], sel);
  if (r.error) failExit(r);
  if (flags.json) { console.log(JSON.stringify(r.value ?? null)); return; }
  console.log(renderGet(scan, r.value));
}

// ---- Tier 1: set a component property --------------------------------------
function cmdSet(scan, projectDir, flags, pos) {
  const sel = pos[2];
  if (!sel) { console.error(EM.setUsage); process.exit(1); }
  if (!flags.value) { console.error(EM.noValue('set')); process.exit(1); }
  const value = resolveValueSpec(scan, flags.value);
  const r = runEdit(scan, projectDir, 'set', { file: pos[0], selector: sel, value });
  if (r.error) failExit(r);
  applyResult(flags, r, `${r.asset.path}: ${sel} = ${JSON.stringify(value)}`);
}

function cmdSetUuid(scan, projectDir, flags, pos) {
  const sel = pos[2];
  if (!sel || !pos[3]) { console.error(EM.setUuidUsage); process.exit(1); }
  const r = runEdit(scan, projectDir, 'set-uuid', { file: pos[0], selector: sel, asset: pos[3] });
  if (r.error) failExit(r);
  applyResult(flags, r, `${r.asset.path}: ${sel} → ${r.json.to}`);
}

// ---- Tier 2: rename / set-active / set-layer / set-pos / set-scale / set-rot -
function nodeOp(scan, projectDir, flags, pos, op) {
  const sel = pos[2];
  if (!sel) { console.error(EM.nodeOpUsage(op)); process.exit(1); }
  let value;
  if (op === 'set-rot') {
    if (!flags.value || flags.value.type !== 'vec3') { console.error(EM.rotNeedsVec3); process.exit(1); }
    value = resolveValueSpec(scan, flags.value);
  } else if (op === 'rename') {
    if (pos[3] === undefined) { console.error(EM.nodeOpUsage(op)); process.exit(1); } // '' is a legal name
    value = pos[3];
  } else {
    if (!flags.value) { console.error(EM.noValue(op)); process.exit(1); }
    // each node op expects a specific value shape — reject a mismatched flag so a
    // scalar can't be written into a Vec3 field (or vice versa).
    const WANT = { 'set-active': ['bool'], 'set-layer': ['int', 'num', 'enum'], 'set-pos': ['vec3'], 'set-scale': ['vec3'] };
    if (!WANT[op].includes(flags.value.type)) { console.error(EM.wrongFlag(op, WANT[op])); process.exit(1); }
    value = resolveValueSpec(scan, flags.value);
  }
  const r = runEdit(scan, projectDir, op, { file: pos[0], selector: sel, value });
  if (r.error) failExit(r);
  const desc = op === 'set-rot'
    ? `${r.asset.path}: ${sel} euler = ${value.x},${value.y},${value.z}  (→ _lrot)`
    : `${r.asset.path}: ${sel} ${r.json.field} = ${JSON.stringify(value)}`;
  applyResult(flags, r, desc);
}

// ---- Tier 2: set-parent (reparent) -----------------------------------------
function cmdSetParent(scan, projectDir, flags, pos) {
  const sel = pos[2]; const parentSel = pos[3];
  if (!sel || !parentSel) { console.error(EM.setParentUsage); process.exit(1); }
  const r = runEdit(scan, projectDir, 'set-parent', { file: pos[0], selector: sel, parent: parentSel, index: flags.index });
  if (r.error) failExit(r);
  applyResult(flags, r, `${r.asset.path}: set-parent ${sel} → under ${parentSel}${flags.index != null ? ` [${flags.index}]` : ''}`);
}

// ---- Tier 3: structural add / remove ---------------------------------------
function cmdAddNode(scan, projectDir, flags, pos) {
  const parentSel = pos[2]; const name = pos[3];
  if (!parentSel || !name) { console.error(EM.addNodeUsage); process.exit(1); }
  const r = runEdit(scan, projectDir, 'add-node', { file: pos[0], parent: parentSel, name, index: flags.index });
  if (r.error) failExit(r);
  applyResult(flags, r, `${r.asset.path}: add node "${name}" under ${parentSel}  (#${r.json.index})`);
}

function cmdAddComponent(scan, projectDir, flags, pos) {
  const sel = pos[2]; const type = pos[3];
  if (!sel || !type) { console.error(EM.addCompUsage); process.exit(1); }
  const r = runEdit(scan, projectDir, 'add-component', { file: pos[0], selector: sel, type });
  if (r.error) failExit(r);
  applyResult(flags, r, `${r.asset.path}: add ${type} on ${sel}  (#${r.json.index})`);
}

function cmdRmNode(scan, projectDir, flags, pos) {
  const sel = pos[2];
  if (!sel) { console.error(EM.nodeOpUsage('rm-node')); process.exit(1); }
  const r = runEdit(scan, projectDir, 'rm-node', { file: pos[0], selector: sel });
  if (r.error) failExit(r);
  applyResult(flags, r, `${r.asset.path}: removed ${sel}  (${r.json.removed} entries, ${r.json.cleared} dangling ref(s) cleared)`);
}

function cmdRmComponent(scan, projectDir, flags, pos) {
  const sel = pos[2];
  if (!sel) { console.error(EM.addCompUsage); process.exit(1); }
  const r = runEdit(scan, projectDir, 'rm-component', { file: pos[0], selector: sel });
  if (r.error) failExit(r);
  applyResult(flags, r, `${r.asset.path}: removed component ${sel}  (${r.json.removed} entries, ${r.json.cleared} dangling ref(s) cleared)`);
}

// ---- project-wide (`--all`): currently swap-uuid only ----------------------
function cmdEditAll(scan, projectDir, flags, pos) {
  const op = pos[0];
  if (op !== 'swap-uuid') { console.error(EM.allOnlySwap(op || '?')); process.exit(1); }
  if (!pos[1] || !pos[2]) { console.error(EM.swapUsage); process.exit(1); }
  const r = runSwapAll(scan, projectDir, pos[1], pos[2]);
  if (r.error) failExit(r);
  if (r.skipped.length) console.error(EM.allSkipped(r.skipped.length, r.skipped)); // partial repoint is never silent

  if (flags.json) {
    if (!flags.dryRun) commitOrExit(r, flags);
    console.log(JSON.stringify({ ...r.json, dryRun: !!flags.dryRun }));
    return;
  }
  if (!r.hits.length) { console.log(EM.allNoop(pos[1])); return; }
  const lines = [EM.allHead(r.json.from, r.json.to), `  ${r.hits.length} files, ${r.json.totalRefs} references${flags.dryRun ? EM.dryRunSuffix : ''}`];
  for (const h of r.hits) lines.push(`    ${h.file.padEnd(32)} ${h.count}${flags.dryRun ? '' : '   ✓'}`);
  if (!flags.dryRun) { commitOrExit(r, flags); lines.push(EM.allWritten(r.hits.length, flags.backup)); }
  console.log(lines.join('\n'));
}
