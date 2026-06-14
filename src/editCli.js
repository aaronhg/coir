// Edit commands: in-place mutation of an EXISTING prefab/scene (never a
// from-scratch generator). The write engine is node/editPrefab.js; this is the
// CLI presentation layer (arg shapes, messages, dry-run/json/backup). core
// stays read-only. See docs/EDITING.md.
//
//   edit <file> swap-uuid <oldAsset> <newAsset>       repoint every ref onto another asset (whole file)
//   edit <file> set       <sel:Type.prop> <value>     set a component property
//   edit <file> set-uuid  <sel:Type.prop> <asset>     point a property at an asset
//   edit <file> rename    <nodeSel> <newName>
//   edit <file> set-active/set-layer/set-pos/set-scale <nodeSel> <value-flag>
import path from 'node:path';
import { mainUuid } from './core/uuid.js';
import { componentName, typeToken } from './core/selector.js';
import { resolveAsset, edgeMaps, locText } from './cliShared.js';
import { loadDoc, planSwapUuid, writeAtomic, resolveSelector, getDeep, setDeep, serialize, eulerToQuat, setParent,
  removeNode, removeComponent, addNode, addComponent, nestedInstanceRoot, subtreeHasInstance } from './node/editPrefab.js';

// Edit-specific messages (CLI is fixed English; shared not-found/ambiguous text
// lives in cliShared.resolveAsset).
const EM = {
  editUsage: 'edit needs: <file> <op> …   (op: get / set / set-uuid / swap-uuid / rename / set-active / set-layer / set-pos / set-scale / set-rot / set-parent / add-node / rm-node / add-component / rm-component)',
  editNotPrefab: (f, t) => `✗ "${f}" is a ${t}, not a prefab/scene — edit only touches prefab/scene files`,
  editUnknownOp: (op) => `unknown edit op "${op}"`,
  editBadFile: (f, m) => `✗ cannot edit ${f}: ${m}`,
  swapUsage: 'swap-uuid needs: <file> swap-uuid <oldAsset> <newAsset>',
  swapNoop: (q) => `(no references to "${q}" in this file — nothing changed)`,
  dryRunSuffix: '   [dry-run — not written]',
  written: (bak) => `  ✓ written${bak ? ' (.bak saved)' : ''}`,
  getUsage: 'get needs: <file> get <selector>   (reads the value/node/component; -o json for raw, round-trips into set --json)',
  setUsage: 'set needs: <file> set <selector:Comp.prop> <value-flag>   (e.g. --str/--int/--vec3/--uuid)',
  setUuidUsage: 'set-uuid needs: <file> set-uuid <selector:Comp.prop> <asset>',
  needProp: (s) => `✗ "${s}" must select a property (…:Type.prop) for set`,
  needNode: (s) => `✗ "${s}" must select a node for this op`,
  noValue: (op) => `✗ ${op} needs a value flag (--str/--int/--num/--bool/--enum/--color/--vec2/3/4/--size/--quat/--uuid/--json/--null)`,
  nodeOpUsage: (op) => `${op} needs: <file> ${op} <nodeSelector> ${op === 'rename' ? '<newName>' : '<value-flag>'}`,
  rotNeedsVec3: 'set-rot needs --vec3 <x> <y> <z> (euler degrees)',
  setParentUsage: 'set-parent needs: <file> set-parent <nodeSelector> <newParentSelector> [--index i]',
  addNodeUsage: 'add-node needs: <file> add-node <parentSelector> <name> [--index i]',
  addCompUsage: 'add-component needs: <file> add-component <nodeSelector> <ccType>',
  needComp: (s) => `✗ "${s}" must select a component (…:Type) for this op`,
  wrongFlag: (op, want) => `✗ ${op} needs a ${want.join('/')} value (a different --flag was given)`,
  unknownType: (names) => `✗ unknown __type__ class(es): ${names.join(', ')} — no matching script asset in the project`,
  instanceGuard: (name) => `✗ "${name}" is (in) a nested prefab instance — edit its source prefab directly, not here`,
  subtreeInstance: (sel) => `✗ "${sel}" contains a nested prefab instance — rm it in its source prefab, not here`,
  allSkipped: (n, files) => `⚠ skipped ${n} unparseable file(s): ${files.join(', ')}`,
  allOnlySwap: (op) => `--all currently supports only swap-uuid (selector ops like "${op}" are per-file)`,
  allHead: (from, to) => `swap ${from} → ${to}   (project-wide)`,
  allNoop: (q) => `(no references to "${q}" anywhere — nothing changed)`,
  allWritten: (n, bak) => `  ✓ ${n} file(s) written${bak ? ' (.bak saved)' : ''}`,
  selErr: (e) => `✗ ${e}`,
  badValue: (m) => `✗ bad value: ${m}`,
};

const assetPath = (scan, uuid) => scan.assets.get(uuid)?.path || uuid;

export function cmdEdit(scan, projectDir, flags, pos) {
  if (flags.all) return cmdEditAll(scan, projectDir, flags, pos); // project-wide: pos = [op, …]
  const file = pos[0]; const op = pos[1];
  if (!file || !op) { console.error(EM.editUsage); process.exit(1); }
  const asset = scan.assets.get(resolveAsset(scan, file));
  if (!asset || (asset.type !== 'prefab' && asset.type !== 'scene')) {
    console.error(EM.editNotPrefab(file, asset ? asset.type : '?')); process.exit(2);
  }
  const absPath = path.join(projectDir, 'assets', asset.path);
  switch (op) {
    case 'swap-uuid': return cmdSwapUuid(scan, absPath, asset, flags, pos);
    case 'get': return cmdGet(scan, absPath, asset, flags, pos);
    case 'set': return cmdSet(scan, absPath, asset, flags, pos);
    case 'set-uuid': return cmdSetUuid(scan, absPath, asset, flags, pos);
    case 'rename': case 'set-active': case 'set-layer': case 'set-pos': case 'set-scale': case 'set-rot':
      return nodeOp(scan, absPath, asset, flags, pos, op);
    case 'set-parent': return cmdSetParent(scan, absPath, asset, flags, pos);
    case 'add-node': return cmdAddNode(scan, absPath, asset, flags, pos);
    case 'rm-node': return cmdRmNode(scan, absPath, asset, flags, pos);
    case 'add-component': return cmdAddComponent(scan, absPath, asset, flags, pos);
    case 'rm-component': return cmdRmComponent(scan, absPath, asset, flags, pos);
    default: console.error(EM.editUnknownOp(op)); process.exit(1);
  }
}

// ---- helpers ---------------------------------------------------------------
// The selector whitelist's component-name resolver — the shared canonical form
// (cliShared/browser show the very same name, so a displayed location pastes back).
function compNameFor(scan) {
  return (raw) => componentName(scan, raw);
}
// Turn a typed value spec (from a --flag) into the JS value Cocos serializes.
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
// Deep-convert every __type__ class name in a --json value to the token Cocos
// serializes; collect unknown custom classes so the caller can refuse.
function resolveRawTypes(scan, v, unknown) {
  if (Array.isArray(v)) { for (const el of v) resolveRawTypes(scan, el, unknown); return; }
  if (v && typeof v === 'object') {
    if (typeof v.__type__ === 'string') {
      const tok = typeToken(scan, v.__type__);
      if (tok === null) unknown.push(v.__type__); else v.__type__ = tok;
    }
    for (const k of Object.keys(v)) if (k !== '__type__') resolveRawTypes(scan, v[k], unknown);
  }
}
function loadDocOrExit(absPath, asset) {
  try { return loadDoc(absPath); }
  catch (e) { console.error(EM.editBadFile(asset.path, e.message)); process.exit(2); }
}
// Refuse selector ops that target a nested prefab instance (edit B in B.prefab).
function assertEditable(arr, index) {
  const root = nestedInstanceRoot(arr, index);
  if (root != null) { console.error(EM.instanceGuard((arr[root] && arr[root]._name) || `#${root}`)); process.exit(2); }
}
function selErrorExit(res) {
  console.error(EM.selErr(res.error));
  for (const c of (res.candidates || []).slice(0, 20)) console.error(`    ${c}`);
  process.exit(2);
}
// Write (unless --dry-run) the mutated doc and report. `summary` = {desc, json}.
function applyTreeEdit(asset, absPath, doc, flags, summary) {
  if (!flags.dryRun) writeAtomic(absPath, serialize(doc.arr, doc.raw), { backup: flags.backup });
  if (flags.json) { console.log(JSON.stringify({ file: asset.path, ...summary.json, dryRun: !!flags.dryRun })); return; }
  const lines = [summary.desc + (flags.dryRun ? EM.dryRunSuffix : '')];
  if (!flags.dryRun) lines.push(EM.written(flags.backup));
  console.log(lines.join('\n'));
}

// ---- Tier 0: swap-uuid (text patch) ----------------------------------------
function cmdSwapUuid(scan, absPath, asset, flags, pos) {
  if (!pos[2] || !pos[3]) { console.error(EM.swapUsage); process.exit(1); }
  const oldUuid = resolveAsset(scan, pos[2]);
  const newUuid = resolveAsset(scan, pos[3]);
  const doc = loadDocOrExit(absPath, asset);
  const { text, count } = planSwapUuid(doc.raw, oldUuid, newUuid);

  if (flags.json) {
    if (count && !flags.dryRun) writeAtomic(absPath, text, { backup: flags.backup });
    console.log(JSON.stringify({ file: asset.path, op: 'swap-uuid',
      from: assetPath(scan, oldUuid), to: assetPath(scan, newUuid),
      fromUuid: oldUuid, toUuid: newUuid, count, dryRun: !!flags.dryRun }));
    return;
  }
  const head = `${asset.path}: swap ${assetPath(scan, oldUuid)} → ${assetPath(scan, newUuid)}`;
  if (count === 0) { console.log(`${head}\n  ${EM.swapNoop(pos[2])}`); return; }
  const lines = [head, `  ${count} reference(s)${flags.dryRun ? EM.dryRunSuffix : ''}`];
  const outs = (edgeMaps(scan).out.get(asset.uuid) || []).filter((e) => mainUuid(e.to) === oldUuid);
  for (const e of outs) for (const loc of e.locations) lines.push(`    ${locText(scan, loc)}`);
  if (!flags.dryRun) { writeAtomic(absPath, text, { backup: flags.backup }); lines.push(EM.written(flags.backup)); }
  console.log(lines.join('\n'));
}

// ---- Tier 1: set a component property --------------------------------------
// ---- get: read the value/node/component at a selector (set's read pair) ----
// Read-only. `-o json` prints the RAW value (round-trips into `set --json`); the
// default text form annotates a __uuid__ with its asset path and a compressed
// __type__ with its class name.
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
function cmdGet(scan, absPath, asset, flags, pos) {
  const sel = pos[2];
  if (!sel) { console.error(EM.getUsage); process.exit(1); }
  const doc = loadDocOrExit(absPath, asset);
  const res = resolveSelector(doc.arr, sel, compNameFor(scan));
  if (res.error) selErrorExit(res);
  let value;
  if (res.kind === 'property') {
    const r = getDeep(doc.arr[res.index], res.prop);
    if (r.error) { console.error(EM.selErr(r.error)); process.exit(2); }
    value = r.value;
  } else { value = doc.arr[res.index]; } // node / component → the whole object
  if (flags.json) { console.log(JSON.stringify(value ?? null)); return; }
  console.log(renderGet(scan, value));
}

function cmdSet(scan, absPath, asset, flags, pos) {
  const sel = pos[2];
  if (!sel) { console.error(EM.setUsage); process.exit(1); }
  if (!flags.value) { console.error(EM.noValue('set')); process.exit(1); }
  const doc = loadDocOrExit(absPath, asset);
  const res = resolveSelector(doc.arr, sel, compNameFor(scan));
  if (res.error) selErrorExit(res);
  if (res.kind !== 'property') { console.error(EM.needProp(sel)); process.exit(2); }
  assertEditable(doc.arr, res.index);
  const value = resolveValueSpec(scan, flags.value);
  const r = setDeep(doc.arr[res.index], res.prop, value);
  if (r.error) { console.error(EM.selErr(r.error)); process.exit(2); }
  applyTreeEdit(asset, absPath, doc, flags, {
    desc: `${asset.path}: ${sel} = ${JSON.stringify(value)}`,
    json: { op: 'set', selector: sel, prop: res.prop, value },
  });
}

function cmdSetUuid(scan, absPath, asset, flags, pos) {
  const sel = pos[2];
  if (!sel || !pos[3]) { console.error(EM.setUuidUsage); process.exit(1); }
  const uuid = resolveAsset(scan, pos[3]);
  const doc = loadDocOrExit(absPath, asset);
  const res = resolveSelector(doc.arr, sel, compNameFor(scan));
  if (res.error) selErrorExit(res);
  if (res.kind !== 'property') { console.error(EM.needProp(sel)); process.exit(2); }
  assertEditable(doc.arr, res.index);
  const r = setDeep(doc.arr[res.index], res.prop, { __uuid__: uuid });
  if (r.error) { console.error(EM.selErr(r.error)); process.exit(2); }
  applyTreeEdit(asset, absPath, doc, flags, {
    desc: `${asset.path}: ${sel} → ${assetPath(scan, uuid)}`,
    json: { op: 'set-uuid', selector: sel, prop: res.prop, to: assetPath(scan, uuid), toUuid: uuid },
  });
}

// ---- Tier 2: rename / set-active / set-layer / set-pos / set-scale / set-rot -
function nodeOp(scan, absPath, asset, flags, pos, op) {
  const sel = pos[2];
  if (!sel) { console.error(EM.nodeOpUsage(op)); process.exit(1); }
  const doc = loadDocOrExit(absPath, asset);
  const res = resolveSelector(doc.arr, sel, compNameFor(scan));
  if (res.error) selErrorExit(res);
  if (res.kind !== 'node') { console.error(EM.needNode(sel)); process.exit(2); }
  assertEditable(doc.arr, res.index);
  const node = doc.arr[res.index];

  // set-rot is the one node op that touches two fields: _euler (what you pass)
  // and _lrot (the quaternion the transform actually uses).
  if (op === 'set-rot') {
    if (!flags.value || flags.value.type !== 'vec3') { console.error(EM.rotNeedsVec3); process.exit(1); }
    const e = resolveValueSpec(scan, flags.value);
    node._euler = e;
    node._lrot = eulerToQuat(e.x, e.y, e.z);
    applyTreeEdit(asset, absPath, doc, flags, {
      desc: `${asset.path}: ${sel} euler = ${e.x},${e.y},${e.z}  (→ _lrot)`,
      json: { op, node: sel, euler: [e.x, e.y, e.z], lrot: node._lrot },
    });
    return;
  }

  const field = { rename: '_name', 'set-active': '_active', 'set-layer': '_layer', 'set-pos': '_lpos', 'set-scale': '_lscale' }[op];
  // each node op expects a specific value shape — reject a mismatched flag so a
  // scalar can't be written into a Vec3 field (or vice versa), which Cocos
  // cannot deserialize. (rename takes a positional name, allowing '').
  const WANT = { 'set-active': ['bool'], 'set-layer': ['int', 'num', 'enum'], 'set-pos': ['vec3'], 'set-scale': ['vec3'] };
  let value;
  if (op === 'rename') {
    if (pos[3] === undefined) { console.error(EM.nodeOpUsage(op)); process.exit(1); } // '' is a legal name
    value = pos[3];
  } else {
    if (!flags.value) { console.error(EM.noValue(op)); process.exit(1); }
    if (!WANT[op].includes(flags.value.type)) { console.error(EM.wrongFlag(op, WANT[op])); process.exit(1); }
    value = resolveValueSpec(scan, flags.value);
  }
  node[field] = value;
  applyTreeEdit(asset, absPath, doc, flags, {
    desc: `${asset.path}: ${sel} ${field} = ${JSON.stringify(value)}`,
    json: { op, node: sel, field, value },
  });
}

// ---- Tier 2: set-parent (reparent) — structural but no renumbering ----------------
function cmdSetParent(scan, absPath, asset, flags, pos) {
  const sel = pos[2]; const parentSel = pos[3];
  if (!sel || !parentSel) { console.error(EM.setParentUsage); process.exit(1); }
  const doc = loadDocOrExit(absPath, asset);
  const compName = compNameFor(scan);
  const res = resolveSelector(doc.arr, sel, compName);
  if (res.error) selErrorExit(res);
  if (res.kind !== 'node') { console.error(EM.needNode(sel)); process.exit(2); }
  const pres = resolveSelector(doc.arr, parentSel, compName);
  if (pres.error) selErrorExit(pres);
  if (pres.kind !== 'node') { console.error(EM.needNode(parentSel)); process.exit(2); }
  assertEditable(doc.arr, res.index); assertEditable(doc.arr, pres.index);
  const r = setParent(doc.arr, res.index, pres.index, flags.index);
  if (r.error) { console.error(EM.selErr(r.error)); process.exit(2); }
  applyTreeEdit(asset, absPath, doc, flags, {
    desc: `${asset.path}: set-parent ${sel} → under ${parentSel}${flags.index != null ? ` [${flags.index}]` : ''}`,
    json: { op: 'set-parent', node: sel, newParent: parentSel, index: flags.index ?? -1 },
  });
}

// ---- Tier 3: structural add / remove ---------------------------------------
// Resolve a selector to a node index, or print the error and exit 2.
function resolveNodeIndex(scan, doc, sel) {
  const res = resolveSelector(doc.arr, sel, compNameFor(scan));
  if (res.error) selErrorExit(res);
  if (res.kind !== 'node') { console.error(EM.needNode(sel)); process.exit(2); }
  assertEditable(doc.arr, res.index);
  return res.index;
}

function cmdAddNode(scan, absPath, asset, flags, pos) {
  const parentSel = pos[2]; const name = pos[3];
  if (!parentSel || !name) { console.error(EM.addNodeUsage); process.exit(1); }
  const doc = loadDocOrExit(absPath, asset);
  const parentIndex = resolveNodeIndex(scan, doc, parentSel);
  const r = addNode(doc.arr, parentIndex, name, flags.index);
  if (r.error) { console.error(EM.selErr(r.error)); process.exit(2); }
  applyTreeEdit(asset, absPath, doc, flags, {
    desc: `${asset.path}: add node "${name}" under ${parentSel}  (#${r.index})`,
    json: { op: 'add-node', parent: parentSel, name, index: r.index },
  });
}

function cmdAddComponent(scan, absPath, asset, flags, pos) {
  const sel = pos[2]; const type = pos[3];
  if (!sel || !type) { console.error(EM.addCompUsage); process.exit(1); }
  const doc = loadDocOrExit(absPath, asset);
  const nodeIndex = resolveNodeIndex(scan, doc, sel);
  const r = addComponent(doc.arr, nodeIndex, type);
  if (r.error) { console.error(EM.selErr(r.error)); process.exit(2); }
  applyTreeEdit(asset, absPath, doc, flags, {
    desc: `${asset.path}: add ${type} on ${sel}  (#${r.index})`,
    json: { op: 'add-component', node: sel, type, index: r.index },
  });
}

function cmdRmNode(scan, absPath, asset, flags, pos) {
  const sel = pos[2];
  if (!sel) { console.error(EM.nodeOpUsage('rm-node')); process.exit(1); }
  const doc = loadDocOrExit(absPath, asset);
  const res = resolveSelector(doc.arr, sel, compNameFor(scan));
  if (res.error) selErrorExit(res);
  if (res.kind !== 'node') { console.error(EM.needNode(sel)); process.exit(2); }
  assertEditable(doc.arr, res.index);
  // guard the whole subtree, not just the target: deleting an A-own node whose
  // subtree contains a nested prefab instance would mangle that instance.
  if (subtreeHasInstance(doc.arr, res.index)) { console.error(EM.subtreeInstance(sel)); process.exit(2); }
  const r = removeNode(doc.arr, res.index);
  if (r.error) { console.error(EM.selErr(r.error)); process.exit(2); }
  doc.arr = r.newArr; // compacted (renumbered) array
  applyTreeEdit(asset, absPath, doc, flags, {
    desc: `${asset.path}: removed ${sel}  (${r.removed} entries, ${r.cleared} dangling ref(s) cleared)`,
    json: { op: 'rm-node', node: sel, removed: r.removed, cleared: r.cleared },
  });
}

function cmdRmComponent(scan, absPath, asset, flags, pos) {
  const sel = pos[2];
  if (!sel) { console.error(EM.addCompUsage); process.exit(1); }
  const doc = loadDocOrExit(absPath, asset);
  const res = resolveSelector(doc.arr, sel, compNameFor(scan));
  if (res.error) selErrorExit(res);
  if (res.kind !== 'component') { console.error(EM.needComp(sel)); process.exit(2); }
  assertEditable(doc.arr, res.index);
  const r = removeComponent(doc.arr, res.index);
  if (r.error) { console.error(EM.selErr(r.error)); process.exit(2); }
  doc.arr = r.newArr;
  applyTreeEdit(asset, absPath, doc, flags, {
    desc: `${asset.path}: removed component ${sel}  (${r.removed} entries, ${r.cleared} dangling ref(s) cleared)`,
    json: { op: 'rm-component', component: sel, removed: r.removed, cleared: r.cleared },
  });
}

// ---- project-wide (`--all`): currently swap-uuid only ----------------------
// Repoint one asset onto another across EVERY prefab/scene that references it.
// Only uuid-keyed ops generalize across files; selector ops are per-file.
function cmdEditAll(scan, projectDir, flags, pos) {
  const op = pos[0];
  if (op !== 'swap-uuid') { console.error(EM.allOnlySwap(op || '?')); process.exit(1); }
  if (!pos[1] || !pos[2]) { console.error(EM.swapUsage); process.exit(1); }
  const oldUuid = resolveAsset(scan, pos[1]);
  const newUuid = resolveAsset(scan, pos[2]);

  // Every prefab/scene whose text actually contains the old uuid (the text patch
  // catches both whole and @sub refs, so this is exact). Sorted for stable output.
  const files = [...scan.assets.values()]
    .filter((a) => a.type === 'prefab' || a.type === 'scene')
    .sort((a, b) => a.path.localeCompare(b.path));
  const hits = []; const skipped = [];
  let totalRefs = 0;
  for (const a of files) {
    const abs = path.join(projectDir, 'assets', a.path);
    let doc; try { doc = loadDoc(abs); } catch { skipped.push(a.path); continue; } // unparseable → not silent (warned below)
    const { text, count } = planSwapUuid(doc.raw, oldUuid, newUuid);
    if (count > 0) { hits.push({ path: a.path, abs, text, count }); totalRefs += count; }
  }
  // A repoint that skips files is partial — never silent.
  if (skipped.length) console.error(EM.allSkipped(skipped.length, skipped));

  if (flags.json) {
    if (!flags.dryRun) for (const h of hits) writeAtomic(h.abs, h.text, { backup: flags.backup });
    console.log(JSON.stringify({ op: 'swap-uuid', scope: 'all',
      from: assetPath(scan, oldUuid), to: assetPath(scan, newUuid), fromUuid: oldUuid, toUuid: newUuid,
      files: hits.map((h) => ({ file: h.path, count: h.count })), totalFiles: hits.length, totalRefs, skipped, dryRun: !!flags.dryRun }));
    return;
  }

  if (!hits.length) { console.log(EM.allNoop(pos[1])); return; }
  const lines = [EM.allHead(assetPath(scan, oldUuid), assetPath(scan, newUuid)),
    `  ${hits.length} files, ${totalRefs} references${flags.dryRun ? EM.dryRunSuffix : ''}`];
  for (const h of hits) lines.push(`    ${h.path.padEnd(32)} ${h.count}${flags.dryRun ? '' : '   ✓'}`);
  if (!flags.dryRun) { for (const h of hits) writeAtomic(h.abs, h.text, { backup: flags.backup }); lines.push(EM.allWritten(hits.length, flags.backup)); }
  console.log(lines.join('\n'));
}
