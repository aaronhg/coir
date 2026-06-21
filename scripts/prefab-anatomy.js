#!/usr/bin/env node
// @ts-check
// prefab-anatomy — inspect the NESTED-PREFAB structure of a .prefab/.scene:
// nested instances, their property overrides (CCPropertyOverrideInfo), and the
// cross-boundary reference wiring (cc.TargetOverrideInfo), with every fileId /
// __id__ resolved to a human-readable node/component. See docs/NESTED-PREFABS.md.
//
// Usage:
//   node scripts/prefab-anatomy.js <file.prefab|.scene> [projectDir]
//   node scripts/prefab-anatomy.js ../proj/assets/Foo.prefab
//
// projectDir is auto-derived from the path (the dir containing `assets/`); pass
// it explicitly if the file lives outside an `assets/` tree. The scan is only
// used to turn a compressed script `__type__` into its class name — if it can't
// scan, it degrades to showing the raw token.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);

// ---- args -----------------------------------------------------------------
const file = process.argv[2];
if (!file) { console.error('usage: node scripts/prefab-anatomy.js <file.prefab|.scene> [projectDir]'); process.exit(1); }
const abs = path.resolve(file);
if (!fs.existsSync(abs)) { console.error(`not found: ${abs}`); process.exit(1); }

// derive projectDir = the dir that CONTAINS `assets/` (so makeFsProvider sees the root)
function deriveProjectDir(p) {
  const parts = p.split(path.sep);
  const i = parts.lastIndexOf('assets');
  return i > 0 ? parts.slice(0, i).join(path.sep) : null;
}
const projectDir = process.argv[3] ? path.resolve(process.argv[3]) : deriveProjectDir(abs);

// ---- optional scan (for compressed __type__ → class name) ------------------
/** @type {any} */ let scan = null;
/** @type {(raw:string)=>string} */ let typeName = (raw) => raw;
try {
  const { scanProject, makeFsProvider, PLUGINS } = await import(path.join(ROOT, 'src/index.js'));
  const { componentName } = await import(path.join(ROOT, 'src/core/selector.js'));
  if (projectDir) {
    scan = await scanProject(makeFsProvider(projectDir), { plugins: PLUGINS });
    typeName = (raw) => { const n = componentName(scan, raw); return n && n !== raw ? n : raw; };
  }
} catch (e) { /* scan is best-effort; fall back to raw tokens */ }

// ---- load ------------------------------------------------------------------
const arr = JSON.parse(fs.readFileSync(abs, 'utf8'));
if (!Array.isArray(arr)) { console.error('not a 3.x prefab/scene (expected a JSON array of objects)'); process.exit(1); }
const T = (i) => (arr[i] && arr[i].__type__) || '?';
const isNode = (t) => t === 'cc.Node' || t === 'cc.Scene';

// ---- reverse maps: which node/component owns a PrefabInfo / CompPrefabInfo --
const piOwner = new Map(); // PrefabInfo index → node index
const ciOwner = new Map(); // CompPrefabInfo index → component index
arr.forEach((o, i) => {
  if (!o || typeof o !== 'object') return;
  if (isNode(o.__type__) && o._prefab && typeof o._prefab.__id__ === 'number') piOwner.set(o._prefab.__id__, i);
  if (o.__prefab && typeof o.__prefab.__id__ === 'number') ciOwner.set(o.__prefab.__id__, i);
});
// fileId → list of owning node/component descriptors (a fileId can repeat when
// two instances share the same source prefab's internal ids).
const byFileId = new Map();
arr.forEach((o, i) => {
  if (!o || typeof o.fileId !== 'string') return;
  const owner = o.__type__ === 'cc.CompPrefabInfo' ? ciOwner.get(i) : piOwner.get(i);
  if (owner == null) return;
  const list = byFileId.get(o.fileId) || byFileId.set(o.fileId, []).get(o.fileId);
  list.push(owner);
});

// ---- labels ----------------------------------------------------------------
function label(i) {
  const o = arr[i];
  if (!o || typeof o !== 'object') return `#${i} ?`;
  const t = o.__type__ || '?';
  if (isNode(t)) return `node #${i}${o._name ? ` "${o._name}"` : ''}`;
  if (typeof o.node === 'object' && o.node && typeof o.node.__id__ === 'number') {
    const n = typeName(t); return `comp #${i} <${n}>`;
  }
  return `#${i} ${t}`;
}
function resolveFileId(fid) {
  const owners = byFileId.get(fid);
  if (!owners || !owners.length) return `fileId ${fid} (unresolved — likely in the sub-prefab)`;
  if (owners.length === 1) return `fileId ${fid} → ${label(owners[0])}`;
  return `fileId ${fid} → ${owners.map(label).join(' / ')} (shared by ${owners.length} instances)`;
}
function fmtVal(v) {
  if (v && typeof v === 'object') {
    const t = v.__type__;
    if (t === 'cc.Vec3' || t === 'cc.Vec2') return `(${v.x ?? 0}, ${v.y ?? 0}${t === 'cc.Vec3' ? `, ${v.z ?? 0}` : ''})`;
    if (t === 'cc.Quat') return (v.x === 0 && v.y === 0 && v.z === 0 && v.w === 1) ? 'identity' : `(${v.x}, ${v.y}, ${v.z}, ${v.w})`;
    if (t === 'cc.Color') return `rgba(${v.r},${v.g},${v.b},${v.a})`;
    if (typeof v.__uuid__ === 'string') return `→asset ${v.__uuid__}`;
    if (typeof v.__id__ === 'number') return `→${label(v.__id__)}`;
  }
  return JSON.stringify(v);
}
const tinfo = (ref) => (ref && typeof ref.__id__ === 'number' && arr[ref.__id__]) ? arr[ref.__id__] : null;

// ---- report ----------------------------------------------------------------
const counts = {};
arr.forEach((o) => { const t = (o && o.__type__) || '?'; counts[t] = (counts[t] || 0) + 1; });
console.log(`${path.basename(abs)} — ${arr.length} entries`);
console.log(`  types: ${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${typeName(t)}×${n}`).join(', ')}`);
if (!scan) console.log('  (no project scan — compressed script __type__ shown as raw tokens)');

// nested instances: nodes whose PrefabInfo.instance != null
const instances = [];
arr.forEach((o, i) => {
  if (!o || !isNode(o.__type__) || !o._prefab) return;
  const pi = tinfo(o._prefab);
  if (pi && pi.__type__ === 'cc.PrefabInfo' && pi.instance && typeof pi.instance.__id__ === 'number') instances.push({ node: i, pi: o._prefab.__id__, inst: pi.instance.__id__ });
});

console.log(`\nNested instances (${instances.length}):`);
if (!instances.length) console.log('  (none — this is a flat prefab/scene)');
for (const { node, inst } of instances) {
  const pinst = arr[inst];
  console.log(`  ${label(node)}  ◂ PrefabInstance #${inst}  fileId ${pinst.fileId}`);
  const ovs = pinst.propertyOverrides || [];
  console.log(`    propertyOverrides (${ovs.length}) — instance-local VALUE overrides:`);
  for (const ref of ovs) {
    const ov = tinfo(ref); if (!ov) continue;
    const ti = tinfo(ov.targetInfo);
    const loc = ti && ti.localID ? ti.localID.join(' / ') : '?';
    console.log(`        ${(ov.propertyPath || []).join('.')} = ${fmtVal(ov.value)}   [${resolveFileId(ti && ti.localID && ti.localID[0])}]`);
  }
  const mc = (pinst.mountedChildren || []).length, rc = (pinst.removedComponents || []).length, mco = (pinst.mountedComponents || []).length;
  if (mc || rc || mco) console.log(`    mountedChildren: ${mc}  mountedComponents: ${mco}  removedComponents: ${rc}`);
}

// target overrides: cross-boundary REFERENCE wiring, on any PrefabInfo
const tovs = [];
arr.forEach((o, i) => {
  if (o && o.__type__ === 'cc.PrefabInfo' && Array.isArray(o.targetOverrides)) {
    for (const ref of o.targetOverrides) if (ref && typeof ref.__id__ === 'number') tovs.push({ pi: i, to: ref.__id__ });
  }
});
console.log(`\nTarget overrides (${tovs.length}) — cross-boundary REFERENCE wiring:`);
if (!tovs.length) console.log('  (none)');
for (const { pi, to } of tovs) {
  const ov = arr[to]; if (!ov) continue;
  const src = ov.source && typeof ov.source.__id__ === 'number' ? label(ov.source.__id__) : '?';
  const srcInfo = tinfo(ov.sourceInfo);
  const srcLoc = srcInfo && srcInfo.localID ? ` (inside an instance: ${srcInfo.localID.join(' / ')})` : '';
  const prop = (ov.propertyPath || []).join('.');
  const tgt = ov.target && typeof ov.target.__id__ === 'number' ? label(ov.target.__id__) : '?';
  const ti = tinfo(ov.targetInfo);
  const tloc = ti && ti.localID ? ti.localID[0] : null;
  console.log(`  [from PrefabInfo #${pi}]  ${src}${srcLoc} . ${prop}`);
  console.log(`        → into ${tgt} , ${resolveFileId(tloc)}`);
}
