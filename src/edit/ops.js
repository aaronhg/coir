// @ts-check
// The pure WRITE seam for in-place prefab/scene edits: resolve → load → mutate
// (via the editPrefab engine) → return {json, writes}. NO console / process.exit
// / printing of its own. editCli (CLI text rendering) and the MCP server both
// drive these same functions, so the edit logic lives in ONE place; only the
// presentation differs. Every asset/file name is resolved here, so callers just
// pass strings. Errors come back as {error, code, candidates?} — never thrown
// (except writeAtomic's concurrent-change guard, surfaced by commitWrites).
import path from 'node:path';
import { componentName, typeToken } from '../core/selector.js';
import { resolveTarget } from '../shared.js';
import { loadDoc, planSwapUuid, serialize, writeAtomic, resolveSelector, getDeep, setDeep,
  eulerToQuat, setParent, removeNode, removeComponent, addNode, addComponent,
  nestedInstanceRoot, subtreeHasInstance, listNodes } from './editPrefab.js';

// Operation-level messages — byte-identical to the CLI's prior strings so output
// is unchanged. (Usage / value-flag messages stay CLI-side in editCli's EM.)
export const OM = {
  notPrefab: (f, t) => `✗ "${f}" is a ${t}, not a prefab/scene — edit only touches prefab/scene files`,
  badFile: (f, m) => `✗ cannot edit ${f}: ${m}`,
  notFound: (q) => `✗ not found: "${q}"`,
  ambiguous: (q, n) => `✗ "${q}" matches ${n} assets — use the full path:`,
  unknownType: (names) => `✗ unknown __type__ class(es): ${names.join(', ')} — no matching script asset in the project`,
  needProp: (s) => `✗ "${s}" must select a property (…:Type.prop) for set`,
  needNode: (s) => `✗ "${s}" must select a node for this op`,
  needComp: (s) => `✗ "${s}" must select a component (…:Type) for this op`,
  instanceGuard: (name) => `✗ "${name}" is (in) a nested prefab instance — edit its source prefab directly, not here`,
  subtreeInstance: (sel) => `✗ "${sel}" contains a nested prefab instance — rm it in its source prefab, not here`,
  selErr: (e) => `✗ ${e}`,
};

const assetPath = (scan, uuid) => scan.assets.get(uuid)?.path || uuid;
const compNameFor = (scan) => (raw) => componentName(scan, raw);

/**
 * Deep-convert every `__type__` class name in a value to the token Cocos
 * serializes (builtins / already-compressed pass through), collecting unknown
 * custom classes into `unknown` so the caller can refuse. Shared by the CLI
 * `--json` flag and the MCP `value` input.
 * @param {any} scan @param {any} v @param {string[]} unknown
 */
export function resolveRawTypes(scan, v, unknown) {
  if (Array.isArray(v)) { for (const el of v) resolveRawTypes(scan, el, unknown); return; }
  if (v && typeof v === 'object') {
    if (typeof v.__type__ === 'string') {
      const tok = typeToken(scan, v.__type__);
      if (tok === null) unknown.push(v.__type__); else v.__type__ = tok;
    }
    for (const k of Object.keys(v)) if (k !== '__type__') resolveRawTypes(scan, v[k], unknown);
  }
}

// ---- resolution helpers (return data, never exit) --------------------------
function resolveAssetData(scan, query) {
  const r = resolveTarget(scan, query);
  if (r.notFound) return { error: OM.notFound(query), code: 2 };
  if (r.candidates) {
    const lines = r.candidates.slice(0, 20);
    if (r.candidates.length > 20) lines.push(`… ${r.candidates.length - 20} more`);
    return { error: OM.ambiguous(query, r.candidates.length), code: 2, candidates: lines };
  }
  return { uuid: r.uuid };
}
function resolveEditFile(scan, projectDir, file) {
  const ra = resolveAssetData(scan, file);
  if (ra.error) return ra;
  const asset = scan.assets.get(ra.uuid);
  if (!asset || (asset.type !== 'prefab' && asset.type !== 'scene')) return { error: OM.notPrefab(file, asset ? asset.type : '?'), code: 2 };
  return { asset, absPath: path.join(projectDir, 'assets', asset.path) };
}
function loadOrErr(absPath, asset) {
  try { return { doc: loadDoc(absPath) }; }
  catch (e) { return { error: OM.badFile(asset.path, e instanceof Error ? e.message : String(e)), code: 2 }; }
}
const selError = (res) => ({ error: OM.selErr(res.error), code: 2, candidates: (res.candidates || []).slice(0, 20) });
function editableGuard(arr, index) {
  const root = nestedInstanceRoot(arr, index);
  return root != null ? { error: OM.instanceGuard((arr[root] && arr[root]._name) || `#${root}`), code: 2 } : null;
}
// Resolve a selector to an editable NODE index, or an error result.
function resolveNode(arr, sel, compName) {
  const res = resolveSelector(arr, sel, compName);
  if ('error' in res) return selError(res);
  if (res.kind !== 'node') return { error: OM.needNode(sel), code: 2 };
  const g = editableGuard(arr, res.index); if (g) return g;
  return { index: res.index };
}

/**
 * Run one in-place edit op. `params.file` + any asset-name params are resolved
 * here. Returns { ok, asset, json, writes } on success (writes = [{absPath,text,
 * mtime}], the planned write(s) — caller commits via commitWrites respecting
 * dry-run), or { error, code, candidates? } on any failure.
 * @param {any} scan @param {string} projectDir @param {string} op @param {any} params
 */
export function runEdit(scan, projectDir, op, params) {
  const compName = compNameFor(scan);
  const rf = resolveEditFile(scan, projectDir, params.file);
  if (rf.error) return rf;
  const { asset, absPath } = rf;
  const ld = loadOrErr(absPath, asset);
  if (ld.error) return ld;
  const { doc } = ld;
  const W = (text) => [{ absPath, text, mtime: doc.mtime }];
  const done = (json, writes) => ({ ok: true, asset, json, writes });
  const reserialize = () => serialize(doc.arr, doc.raw);

  switch (op) {
    case 'swap-uuid': {
      const ro = resolveAssetData(scan, params.old); if (ro.error) return ro;
      const rn = resolveAssetData(scan, params.new); if (rn.error) return rn;
      const { text, count } = planSwapUuid(doc.raw, ro.uuid, rn.uuid);
      return done({ op, from: assetPath(scan, ro.uuid), to: assetPath(scan, rn.uuid), fromUuid: ro.uuid, toUuid: rn.uuid, count },
        count ? W(text) : []);
    }
    case 'set': case 'set-uuid': {
      const res = resolveSelector(doc.arr, params.selector, compName);
      if ('error' in res) return selError(res);
      if (res.kind !== 'property') return { error: OM.needProp(params.selector), code: 2 };
      const g = editableGuard(doc.arr, res.index); if (g) return g;
      let value, json;
      if (op === 'set-uuid') {
        const ra = resolveAssetData(scan, params.asset); if (ra.error) return ra;
        value = { __uuid__: ra.uuid };
        json = { op, selector: params.selector, prop: res.prop, to: assetPath(scan, ra.uuid), toUuid: ra.uuid };
      } else {
        value = params.value;
        json = { op, selector: params.selector, prop: res.prop, value };
      }
      const r = setDeep(doc.arr[res.index], res.prop, value);
      if ('error' in r) return { error: OM.selErr(r.error), code: 2 };
      return done(json, W(reserialize()));
    }
    case 'rename': case 'set-active': case 'set-layer': case 'set-pos': case 'set-scale': {
      const res = resolveSelector(doc.arr, params.selector, compName);
      if ('error' in res) return selError(res);
      if (res.kind !== 'node') return { error: OM.needNode(params.selector), code: 2 };
      const g = editableGuard(doc.arr, res.index); if (g) return g;
      const field = { rename: '_name', 'set-active': '_active', 'set-layer': '_layer', 'set-pos': '_lpos', 'set-scale': '_lscale' }[op];
      doc.arr[res.index][field] = params.value;
      return done({ op, node: params.selector, field, value: params.value }, W(reserialize()));
    }
    case 'set-rot': {
      const res = resolveSelector(doc.arr, params.selector, compName);
      if ('error' in res) return selError(res);
      if (res.kind !== 'node') return { error: OM.needNode(params.selector), code: 2 };
      const g = editableGuard(doc.arr, res.index); if (g) return g;
      const e = params.value; const node = doc.arr[res.index];
      node._euler = e; node._lrot = eulerToQuat(e.x, e.y, e.z);
      return done({ op, node: params.selector, euler: [e.x, e.y, e.z], lrot: node._lrot }, W(reserialize()));
    }
    case 'set-parent': {
      const res = resolveSelector(doc.arr, params.selector, compName);
      if ('error' in res) return selError(res);
      if (res.kind !== 'node') return { error: OM.needNode(params.selector), code: 2 };
      const pres = resolveSelector(doc.arr, params.parent, compName);
      if ('error' in pres) return selError(pres);
      if (pres.kind !== 'node') return { error: OM.needNode(params.parent), code: 2 };
      let g = editableGuard(doc.arr, res.index); if (g) return g;
      g = editableGuard(doc.arr, pres.index); if (g) return g;
      const r = setParent(doc.arr, res.index, pres.index, params.index);
      if ('error' in r) return { error: OM.selErr(r.error), code: 2 };
      return done({ op, node: params.selector, newParent: params.parent, index: params.index ?? -1 }, W(reserialize()));
    }
    case 'add-node': {
      const ni = resolveNode(doc.arr, params.parent, compName); if (ni.error) return ni;
      const r = addNode(doc.arr, ni.index, params.name, params.index);
      if ('error' in r) return { error: OM.selErr(r.error), code: 2 };
      return done({ op, parent: params.parent, name: params.name, index: r.index }, W(reserialize()));
    }
    case 'rm-node': {
      const res = resolveSelector(doc.arr, params.selector, compName);
      if ('error' in res) return selError(res);
      if (res.kind !== 'node') return { error: OM.needNode(params.selector), code: 2 };
      const g = editableGuard(doc.arr, res.index); if (g) return g;
      if (subtreeHasInstance(doc.arr, res.index)) return { error: OM.subtreeInstance(params.selector), code: 2 };
      const r = removeNode(doc.arr, res.index);
      if ('error' in r) return { error: OM.selErr(r.error), code: 2 };
      return done({ op, node: params.selector, removed: r.removed, cleared: r.cleared }, W(serialize(r.newArr, doc.raw)));
    }
    case 'add-component': {
      const ni = resolveNode(doc.arr, params.selector, compName); if (ni.error) return ni;
      const r = addComponent(doc.arr, ni.index, params.type);
      if ('error' in r) return { error: OM.selErr(r.error), code: 2 };
      return done({ op, node: params.selector, type: params.type, index: r.index }, W(reserialize()));
    }
    case 'rm-component': {
      const res = resolveSelector(doc.arr, params.selector, compName);
      if ('error' in res) return selError(res);
      if (res.kind !== 'component') return { error: OM.needComp(params.selector), code: 2 };
      const g = editableGuard(doc.arr, res.index); if (g) return g;
      const r = removeComponent(doc.arr, res.index);
      if ('error' in r) return { error: OM.selErr(r.error), code: 2 };
      return done({ op, component: params.selector, removed: r.removed, cleared: r.cleared }, W(serialize(r.newArr, doc.raw)));
    }
    default: return { error: `unknown edit op "${op}"`, code: 1 };
  }
}

/**
 * Project-wide repoint of one asset onto another across EVERY prefab/scene.
 * Unparseable files are skipped (reported in `skipped`, never silently).
 * Returns { ok, json, writes, hits, skipped } or { error, code, candidates? }.
 */
export function runSwapAll(scan, projectDir, oldQuery, newQuery) {
  const ro = resolveAssetData(scan, oldQuery); if (ro.error) return ro;
  const rn = resolveAssetData(scan, newQuery); if (rn.error) return rn;
  const files = [...scan.assets.values()]
    .filter((a) => a.type === 'prefab' || a.type === 'scene')
    .sort((a, b) => a.path.localeCompare(b.path));
  const hits = []; const skipped = []; let totalRefs = 0;
  for (const a of files) {
    const abs = path.join(projectDir, 'assets', a.path);
    let doc; try { doc = loadDoc(abs); } catch { skipped.push(a.path); continue; }
    const { text, count } = planSwapUuid(doc.raw, ro.uuid, rn.uuid);
    if (count > 0) { hits.push({ file: a.path, absPath: abs, text, mtime: doc.mtime, count }); totalRefs += count; }
  }
  const json = { op: 'swap-uuid', scope: 'all', from: assetPath(scan, ro.uuid), to: assetPath(scan, rn.uuid),
    fromUuid: ro.uuid, toUuid: rn.uuid, files: hits.map((h) => ({ file: h.file, count: h.count })),
    totalFiles: hits.length, totalRefs, skipped };
  return { ok: true, json, writes: hits.map((h) => ({ absPath: h.absPath, text: h.text, mtime: h.mtime })), hits, skipped };
}

/**
 * Commit a runEdit/runSwapAll write plan. With `force`, the concurrent-change
 * mtime guard is skipped; otherwise writeAtomic refuses if the file changed on
 * disk since it was read (throws — caller handles).
 * @param {Array<{absPath:string,text:string,mtime:number}>} writes
 * @param {{backup?:boolean, force?:boolean}} [opts]
 */
export function commitWrites(writes, { backup = false, force = false } = {}) {
  for (const w of writes) writeAtomic(w.absPath, w.text, { backup, expectMtime: force ? null : w.mtime });
}

// ---- reads over a prefab/scene file (get / tree) — also resolution-owning ---
// Read the value/node/component at a selector → {ok,value,kind} | {error,code,candidates?}.
export function getData(scan, projectDir, file, selector) {
  const rf = resolveEditFile(scan, projectDir, file);
  if (rf.error) return rf;
  const ld = loadOrErr(rf.absPath, rf.asset); if (ld.error) return ld;
  const res = resolveSelector(ld.doc.arr, selector, compNameFor(scan));
  if ('error' in res) return selError(res);
  if (res.kind === 'property') {
    const r = getDeep(ld.doc.arr[res.index], res.prop);
    if ('error' in r) return { error: OM.selErr(r.error), code: 2 };
    return { ok: true, value: r.value, kind: res.kind };
  }
  return { ok: true, value: ld.doc.arr[res.index], kind: res.kind };
}

// Node hierarchy + component selectors (structure discovery) → {ok,file,nodeCount,nodes} | {error,code,candidates?}.
export function treeData(scan, projectDir, file, { withType = null, under = null, depth = Infinity } = {}) {
  const rf = resolveEditFile(scan, projectDir, file);
  if (rf.error) return rf;
  const ld = loadOrErr(rf.absPath, rf.asset); if (ld.error) return ld;
  const compName = compNameFor(scan);
  let underIdx = null;
  if (under) {
    const res = resolveSelector(ld.doc.arr, under, compName);
    if ('error' in res) return selError(res);
    if (res.kind !== 'node') return { error: OM.needNode(under), code: 2 };
    underIdx = res.index;
  }
  let nodes = listNodes(ld.doc.arr, compName, { depth, under: underIdx });
  if (withType) nodes = nodes.filter((n) => n.components.some((c) => c.type === withType));
  return { ok: true, file: rf.asset.path, nodeCount: nodes.length, nodes };
}
