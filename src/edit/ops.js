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
import { resolveTarget, fmtDidYouMean } from '../seam/shared.js';
import { loadDoc, planSwapUuid, serialize, writeAtomic, resolveSelector, getDeep, setDeep,
  eulerToQuat, setParent, removeNode, removeComponent, addNode, addComponent,
  nestedInstanceRoot, subtreeHasInstance, listNodes, verifyDoc, roundTrip, probeInvertible,
  findInstanceOverrides, findPreviewCanvasLeaks, setRootOverride, setCrossRef,
  reorderArray, rmArrayItem, addArrayItem } from './editPrefab.js';

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
  deepInstanceEdit: (name) => `✗ that property is INSIDE the nested prefab instance "${name}" — only the instance ROOT's own properties can be overridden here (edit deeper values in the source prefab)`,
  subtreeInstance: (sel) => `✗ "${sel}" contains a nested prefab instance — rm it in its source prefab, not here`,
  refNotNode: (s) => `✗ set-ref target "${s}" must select a node or component (…/Node or …:Type), not a property`,
  refNeedInstance: (s) => `✗ set-ref --into needs "${s}" to be a nested-instance ROOT (the instance you reference a node inside of)`,
  noSuchProp: (sel, prop) => `✗ "${sel}" has no existing property "${prop}" — coir only edits fields that already exist (a typo, or a field Cocos Creator hasn't written yet). Add it in the editor first, or pass --force to create it (the result then needs a Creator reimport).`,
  notRefField: (sel, kind) => `✗ "${sel}" currently holds a ${kind} value, not a reference — set-ref only points a property that is a node/component reference (its existing value is null or a {__id__}). Use set/set-uuid for a value/asset, or --force to override.`,
  needArrayProp: (s) => `✗ "${s}" must select an array property (…:Type.arrayProp) for this op`,
  arrayRoute: (p) => `✗ "${p}" is a structural node/component list — use add-node/rm-node/set-parent (_children) or add-component/rm-component (_components), not the array-item ops`,
  addArraySource: '✗ add-array-item needs an element source: a value-flag (--str/--int/--json…) / --uuid <asset> / --ref <node|comp> / --clone / --type <Class>',
  selErr: (e) => `✗ ${e}`,
};

// Coarse "kind" of a serialized value — for type-sanity checks against a field's
// existing value (the field's prior value is the type the editor wrote).
function valueKind(v) {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean') return t;
  if (t === 'object') {
    if (typeof v.__uuid__ === 'string') return 'asset';    // {__uuid__} asset ref
    if (typeof v.__id__ === 'number') return 'ref';        // {__id__} node/component ref
    if (typeof v.__type__ === 'string') return v.__type__; // cc.Vec3 / cc.Color / custom class
    return 'object';
  }
  return 'object';
}
// The kind of the value currently AT `prop` on entry `idx` ('null' if absent).
function kindAt(arr, idx, prop) {
  const gd = getDeep(arr[idx], prop);
  return ('error' in gd) ? 'null' : valueKind(gd.value);
}

// Edits whose offline result is NOT yet what the editor would produce — Cocos
// Creator finishes them on the next open/reimport. Surfaced as result.reimportReason.
export const REIMPORT = {
  template: (kind) => `the new node's ${kind} was cloned from a minimal fallback (no existing one to template) — open in Cocos Creator to complete it`,
  crossRef: 'a cross-boundary reference (cc.TargetOverrideInfo, no baked branch) was written — reimport in Cocos Creator to refresh the library + let the editor bake its display branch',
  newField: (prop) => `a new property "${prop}" was force-created — coir can't tell a real @property from a typo, so reimport in Cocos Creator to reconcile (accept it, or drop it on save)`,
  arrayElement: 'the new array element is not yet editor-canonical (a {__type__} stub, or a clone with a regenerated fileId) — reimport in Cocos Creator to finalize it (fill the class @property defaults / a real fileId)',
};

// True if `propPath` targets a MISSING object key on `obj` (intermediate missing
// or final key absent). Array indices are excluded — setDeep's bounds check
// governs those. Drives the "only edit existing fields" guard.
function missingObjectProp(obj, propPath) {
  const parts = String(propPath).replace(/\[(\d+)\]/g, '.$1').split('.').filter((p) => p !== '');
  const last = parts[parts.length - 1];
  if (/^\d+$/.test(last)) return false;                 // array index, not an object-key typo
  const gd = getDeep(obj, propPath);
  return ('error' in gd) || gd.value === undefined;     // intermediate missing OR final key absent
}

// A node's own fileId (from its PrefabInfo); null if it has none.
function fileIdOf(arr, nodeIndex) {
  const n = arr[nodeIndex];
  const pi = n && n._prefab && typeof n._prefab.__id__ === 'number' ? arr[n._prefab.__id__] : null;
  return pi && typeof pi.fileId === 'string' ? pi.fileId : null;
}
// P3b — resolve a node sub-path INSIDE the instance's SOURCE prefab to its fileId.
// The instance carries its source via PrefabInfo.asset.__uuid__; we load that prefab
// and resolve the sub-path against it. Returns { fileId, sourcePath } | { error }.
function resolveSourceFileId(scan, projectDir, arr, instRootIdx, subPath) {
  const node = arr[instRootIdx];
  const pi = node && node._prefab && typeof node._prefab.__id__ === 'number' ? arr[node._prefab.__id__] : null;
  const uuid = pi && pi.asset && typeof pi.asset.__uuid__ === 'string' ? pi.asset.__uuid__.split('@')[0] : null;
  if (!uuid) return { error: 'the instance has no source-prefab asset uuid' };
  const srcAsset = scan.assets.get(uuid);
  if (!srcAsset || !srcAsset.path) return { error: `source prefab ${uuid} not found in the project` };
  let srcDoc; try { srcDoc = loadDoc(path.join(projectDir, 'assets', srcAsset.path)); } catch { return { error: `cannot load source prefab ${srcAsset.path}` }; }
  const r = resolveSelector(srcDoc.arr, subPath, compNameFor(scan));
  if ('error' in r) return { error: `"${subPath}" not found in source prefab ${srcAsset.path}: ${r.error}` };
  if (r.kind !== 'node') return { error: `"${subPath}" in the source prefab must select a node` };
  const fid = fileIdOf(srcDoc.arr, r.index);
  return fid ? { fileId: fid, sourcePath: srcAsset.path } : { error: `target "${subPath}" in the source prefab has no fileId` };
}

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
  if (r.notFound) return { error: OM.notFound(query) + fmtDidYouMean(r.suggestions), code: 2 };
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
// P2 classification for a node-property write on a NODE index: { root:true } = it
// IS a nested-instance root (→ author a propertyOverride); { root:false } = not in
// any instance (→ write the node directly); { error } = DEEPER than the root (→
// refused, the same line the `no-deep-instance-override` check draws).
function instanceWrite(arr, index) {
  const root = nestedInstanceRoot(arr, index);
  if (root == null) return { root: false };
  if (root === index) return { root: true };
  return { error: OM.deepInstanceEdit((arr[root] && arr[root]._name) || `#${root}`), code: 2 };
}
// Array-item ops only touch arbitrary array PROPERTIES — the structural node/
// component lists have their own ops. Route those away rather than corrupt them.
function arrayRouteGuard(prop) {
  const last = String(prop).split('.').pop();
  return (last === '_children' || last === '_components') ? { error: OM.arrayRoute(prop), code: 2 } : null;
}
// The shared head of every array-item op: resolve to a property on an editable
// (non-instance, non-structural-list) entry. Returns { res } or an error result.
function resolveArrayTarget(arr, selector, compName) {
  const res = resolveSelector(arr, selector, compName);
  if ('error' in res) return selError(res);
  if (res.kind !== 'property') return { error: OM.needArrayProp(selector), code: 2 };
  const g = editableGuard(arr, res.index); if (g) return g;
  const ag = arrayRouteGuard(res.prop); if (ag) return ag;
  return { res };
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
 * Apply ONE array-mutating edit op to `doc.arr` in place (rm ops reassign
 * `doc.arr` to the compacted array). Returns { json } | { error, code,
 * candidates? } — NO serialization or file I/O. swap-uuid is NOT here (it's a
 * raw-text patch, handled in runEdit). Selectors are resolved against the CURRENT
 * `doc.arr`, so this composes: runBatch calls it N times on one loaded doc.
 * @param {any} scan @param {{arr:any[], raw:string, mtime:number}} doc @param {string} op @param {any} params
 */
function applyArrayOp(scan, doc, op, params, projectDir) {
  const compName = compNameFor(scan);
  switch (op) {
    case 'set': case 'set-uuid': {
      const res = resolveSelector(doc.arr, params.selector, compName);
      if ('error' in res) return selError(res);
      if (res.kind !== 'property') return { error: OM.needProp(params.selector), code: 2 };
      const g = editableGuard(doc.arr, res.index); if (g) return g;
      // Only edit fields that already exist (a missing object key = a typo, or a
      // field Creator hasn't written). --force creates it but the result is then
      // needsReimport (coir can't tell a real @property from junk).
      let needsReimport, reimportReason;
      if (missingObjectProp(doc.arr[res.index], res.prop)) {
        if (!params.force) return { error: OM.noSuchProp(params.selector, res.prop), code: 2 };
        needsReimport = true; reimportReason = REIMPORT.newField(res.prop);
      }
      let value, json;
      if (op === 'set-uuid') {
        const ra = resolveAssetData(scan, params.asset); if (ra.error) return ra;
        value = { __uuid__: ra.uuid };
        json = { op, selector: params.selector, prop: res.prop, to: assetPath(scan, ra.uuid), toUuid: ra.uuid };
      } else {
        value = params.value;
        json = { op, selector: params.selector, prop: res.prop, value };
      }
      // type sanity (existing fields only): warn if the new value's kind differs
      // from what the field currently holds (the type Creator wrote). Soft — a few
      // properties are legitimately polymorphic; null clears anything.
      let warning;
      if (!needsReimport) {
        const cur = kindAt(doc.arr, res.index, res.prop), now = valueKind(value);
        if (cur !== 'null' && now !== 'null' && now !== cur) warning = `value kind "${now}" ≠ the field's current "${cur}" — possible type mismatch`;
      }
      const r = setDeep(doc.arr[res.index], res.prop, value);
      if ('error' in r) return { error: OM.selErr(r.error), code: 2 };
      return { json, needsReimport, reimportReason, warning };
    }
    case 'rename': case 'set-active': case 'set-layer': case 'set-pos': case 'set-scale': {
      const res = resolveSelector(doc.arr, params.selector, compName);
      if ('error' in res) return selError(res);
      if (res.kind !== 'node') return { error: OM.needNode(params.selector), code: 2 };
      const field = { rename: '_name', 'set-active': '_active', 'set-layer': '_layer', 'set-pos': '_lpos', 'set-scale': '_lscale' }[op];
      const ig = instanceWrite(doc.arr, res.index); if (ig.error) return ig; // P2: instance root → override; deeper → refused
      if (ig.root) {
        const r = setRootOverride(doc.arr, res.index, [field], params.value);
        if ('error' in r) return { error: OM.selErr(r.error), code: 2 };
        return { json: { op, node: params.selector, field, value: params.value, override: true } };
      }
      doc.arr[res.index][field] = params.value;
      return { json: { op, node: params.selector, field, value: params.value } };
    }
    case 'set-rot': {
      const res = resolveSelector(doc.arr, params.selector, compName);
      if ('error' in res) return selError(res);
      if (res.kind !== 'node') return { error: OM.needNode(params.selector), code: 2 };
      const e = params.value; const node = doc.arr[res.index]; const lrot = eulerToQuat(e.x, e.y, e.z);
      const ig = instanceWrite(doc.arr, res.index); if (ig.error) return ig;
      if (ig.root) { // P2: author overrides for both _euler and _lrot
        let r = setRootOverride(doc.arr, res.index, ['_euler'], e); if ('error' in r) return { error: OM.selErr(r.error), code: 2 };
        r = setRootOverride(doc.arr, res.index, ['_lrot'], lrot); if ('error' in r) return { error: OM.selErr(r.error), code: 2 };
        return { json: { op, node: params.selector, euler: [e.x, e.y, e.z], lrot, override: true } };
      }
      node._euler = e; node._lrot = lrot;
      return { json: { op, node: params.selector, euler: [e.x, e.y, e.z], lrot: node._lrot } };
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
      return { json: { op, node: params.selector, newParent: params.parent, index: params.index ?? -1 } };
    }
    case 'set-ref': {
      // Reference a node/component. P1: an intra-file {__id__} (same prefab, not in
      // an instance). P3a: a target baked inside a nested instance → inline {__id__}
      // + a cc.TargetOverrideInfo. P3b (`into`): a target only in the instance's
      // SOURCE prefab → just the TargetOverrideInfo (engine resolves it; needsReimport).
      const res = resolveSelector(doc.arr, params.selector, compName);
      if ('error' in res) return selError(res);
      if (res.kind !== 'property') return { error: OM.needProp(params.selector), code: 2 };
      const g = editableGuard(doc.arr, res.index); if (g) return g; // source not in a nested instance
      const prop = res.prop.split('.');
      // only edit existing fields — the source reference property must already exist
      let fieldReimport, fieldReason;
      if (missingObjectProp(doc.arr[res.index], res.prop)) {
        if (!params.force) return { error: OM.noSuchProp(params.selector, res.prop), code: 2 };
        fieldReimport = true; fieldReason = REIMPORT.newField(res.prop);
      } else if (!params.force) { // the field exists → it must already be a reference (null or {__id__})
        const k = kindAt(doc.arr, res.index, res.prop);
        if (k !== 'null' && k !== 'ref') return { error: OM.notRefField(params.selector, k), code: 2 };
      }

      if (params.into != null) { // P3b — target is a sub-path in the instance's source prefab
        const inst = resolveSelector(doc.arr, params.target, compName);
        if ('error' in inst) return { error: OM.selErr(inst.error), code: 2, candidates: (inst.candidates || []).slice(0, 20) };
        if (inst.kind !== 'node' || nestedInstanceRoot(doc.arr, inst.index) !== inst.index) return { error: OM.refNeedInstance(params.target), code: 2 };
        const fi = resolveSourceFileId(scan, projectDir, doc.arr, inst.index, params.into);
        if (fi.error) return { error: OM.selErr(fi.error), code: 2 };
        const r = setCrossRef(doc.arr, res.index, prop, inst.index, fi.fileId, null);
        if ('error' in r) return { error: OM.selErr(r.error), code: 2 };
        return { json: { op, selector: params.selector, prop: res.prop, instance: params.target, into: params.into, sourceFileId: fi.fileId, mode: 'P3b' }, needsReimport: true, reimportReason: REIMPORT.crossRef };
      }

      const tgt = resolveSelector(doc.arr, params.target, compName);
      if ('error' in tgt) return { error: OM.selErr(tgt.error), code: 2, candidates: (tgt.candidates || []).slice(0, 20) };
      if (tgt.kind === 'property') return { error: OM.refNotNode(params.target), code: 2 };
      const tRoot = nestedInstanceRoot(doc.arr, tgt.index);
      if (tRoot == null) { // P1 — intra-file reference
        const r = setDeep(doc.arr[res.index], res.prop, { __id__: tgt.index });
        if ('error' in r) return { error: OM.selErr(r.error), code: 2 };
        return { json: { op, selector: params.selector, prop: res.prop, target: params.target, targetKind: tgt.kind, targetIndex: tgt.index, mode: 'P1' }, needsReimport: fieldReimport, reimportReason: fieldReason };
      }
      // P3a — target is a baked node inside an instance; fileId from its PrefabInfo
      const fid = fileIdOf(doc.arr, tgt.index);
      if (!fid) return { error: OM.selErr(`baked target "${params.target}" has no fileId`), code: 2 };
      const r = setCrossRef(doc.arr, res.index, prop, tRoot, fid, tgt.index);
      if ('error' in r) return { error: OM.selErr(r.error), code: 2 };
      return { json: { op, selector: params.selector, prop: res.prop, target: params.target, targetKind: tgt.kind, targetIndex: tgt.index, sourceFileId: fid, mode: 'P3a' }, needsReimport: fieldReimport, reimportReason: fieldReason };
    }
    case 'add-node': {
      const ni = resolveNode(doc.arr, params.parent, compName); if (ni.error) return ni;
      const r = addNode(doc.arr, ni.index, params.name, params.index);
      if ('error' in r) return { error: OM.selErr(r.error), code: 2 };
      const out = { json: { op, parent: params.parent, name: params.name, index: r.index } };
      if (r.fallback) { out.needsReimport = true; out.reimportReason = REIMPORT.template(r.fallback); }
      return out;
    }
    case 'rm-node': {
      const res = resolveSelector(doc.arr, params.selector, compName);
      if ('error' in res) return selError(res);
      if (res.kind !== 'node') return { error: OM.needNode(params.selector), code: 2 };
      const g = editableGuard(doc.arr, res.index); if (g) return g;
      if (subtreeHasInstance(doc.arr, res.index)) return { error: OM.subtreeInstance(params.selector), code: 2 };
      const r = removeNode(doc.arr, res.index);
      if ('error' in r) return { error: OM.selErr(r.error), code: 2 };
      doc.arr = r.newArr;
      return { json: { op, node: params.selector, removed: r.removed, cleared: r.cleared } };
    }
    case 'add-component': {
      const ni = resolveNode(doc.arr, params.selector, compName); if (ni.error) return ni;
      // Validate/resolve the type the SAME way `set --json` does (typeToken): a
      // cc.* builtin / already-compressed token passes through; a project-script
      // CLASS NAME resolves to its compressed uuid token (the serialized form a
      // component needs); an unknown non-cc name → null → refuse. cc.* names are
      // trusted (no offline builtin registry), so e.g. cc.Nope still passes.
      const tok = typeToken(scan, params.type);
      if (tok === null) return { error: OM.unknownType([params.type]), code: 1 };
      const r = addComponent(doc.arr, ni.index, tok);
      if ('error' in r) return { error: OM.selErr(r.error), code: 2 };
      return { json: { op, node: params.selector, type: params.type, resolved: tok, index: r.index } };
    }
    case 'rm-component': {
      const res = resolveSelector(doc.arr, params.selector, compName);
      if ('error' in res) return selError(res);
      if (res.kind !== 'component') return { error: OM.needComp(params.selector), code: 2 };
      const g = editableGuard(doc.arr, res.index); if (g) return g;
      const r = removeComponent(doc.arr, res.index);
      if ('error' in r) return { error: OM.selErr(r.error), code: 2 };
      doc.arr = r.newArr;
      return { json: { op, component: params.selector, removed: r.removed, cleared: r.cleared } };
    }
    case 'reorder-array': {
      const t = resolveArrayTarget(doc.arr, params.selector, compName); if (t.error) return t;
      const r = reorderArray(doc.arr, t.res.index, t.res.prop, params.perm);
      if ('error' in r) return { error: OM.selErr(r.error), code: 2 };
      return { json: { op, selector: params.selector, prop: t.res.prop, perm: params.perm, len: r.len } };
    }
    case 'rm-array-item': {
      const t = resolveArrayTarget(doc.arr, params.selector, compName); if (t.error) return t;
      const r = rmArrayItem(doc.arr, t.res.index, t.res.prop, params.index);
      if ('error' in r) return { error: OM.selErr(r.error), code: 2 };
      if (r.newArr) doc.arr = r.newArr; // GC'd a now-orphaned owned sub-object → swap in the compacted array
      return { json: { op, selector: params.selector, prop: t.res.prop, index: params.index, gc: r.gc || 0 } };
    }
    case 'add-array-item': {
      const t = resolveArrayTarget(doc.arr, params.selector, compName); if (t.error) return t;
      let spec;
      if (params.clone) spec = { clone: true };
      else if (params.elemType != null) spec = { stub: params.elemType };          // --class: minimal {__type__} stub (verbatim name)
      else if (params.asset != null) { const ra = resolveAssetData(scan, params.asset); if (ra.error) return ra; spec = { value: { __uuid__: ra.uuid } }; }
      else if (params.ref != null) {                                              // --ref: {__id__} to an existing node/component (intra-file)
        const tr = resolveSelector(doc.arr, params.ref, compName);
        if ('error' in tr) return { error: OM.selErr(tr.error), code: 2, candidates: (tr.candidates || []).slice(0, 20) };
        if (tr.kind === 'property') return { error: OM.refNotNode(params.ref), code: 2 };
        if (nestedInstanceRoot(doc.arr, tr.index) != null) return { error: OM.instanceGuard(params.ref), code: 2 }; // P1 only — no cross-instance ref
        spec = { value: { __id__: tr.index } };
      } else if ('value' in params) spec = { value: params.value };               // a value-flag / --json literal
      else return { error: OM.addArraySource, code: 1 };
      // Non-blocking kind warning (like set/set-uuid): inserting an element whose
      // kind differs from the array's existing elements is allowed (you may mean it)
      // but flagged — catches a scalar dropped into a {__id__}/{__uuid__} array etc.
      const cur = getDeep(doc.arr[t.res.index], t.res.prop);
      const existingKind = (cur && !('error' in cur) && Array.isArray(cur.value) && cur.value.length) ? valueKind(cur.value[0]) : null;
      const insertedKind = (spec.clone || spec.stub) ? 'ref' : valueKind(spec.value);
      const r = addArrayItem(doc.arr, t.res.index, t.res.prop, params.at == null ? null : params.at, spec);
      if ('error' in r) return { error: OM.selErr(r.error), code: 2 };
      const out = { op, selector: params.selector, prop: t.res.prop, at: r.index };
      const warning = (existingKind && existingKind !== insertedKind) ? `inserted a ${insertedKind} element into an array of ${existingKind} — kind mismatch (the engine may ignore or degrade it)` : undefined;
      return r.needsReimport ? { json: out, needsReimport: true, reimportReason: REIMPORT.arrayElement, warning } : { json: out, warning };
    }
    default: return { error: `unknown edit op "${op}"`, code: 1 };
  }
}

/**
 * Run one in-place edit op. `params.file` + any asset-name params are resolved
 * here. Returns { ok, asset, json, writes } on success (writes = [{absPath,text,
 * oldText,mtime}], the planned write(s) — caller commits via commitWrites
 * respecting dry-run; `oldText` is the pre-edit content for `--diff`), or
 * { error, code, candidates? } on any failure.
 * @param {any} scan @param {string} projectDir @param {string} op @param {any} params
 */
export function runEdit(scan, projectDir, op, params) {
  const rf = resolveEditFile(scan, projectDir, params.file);
  if (rf.error) return rf;
  const { asset, absPath } = rf;
  const ld = loadOrErr(absPath, asset);
  if (ld.error) return ld;
  const { doc } = ld;
  const W = (text) => [{ absPath, text, oldText: doc.raw, mtime: doc.mtime }];
  if (op === 'swap-uuid') {
    const ro = resolveAssetData(scan, params.old); if (ro.error) return ro;
    const rn = resolveAssetData(scan, params.new); if (rn.error) return rn;
    const { text, count } = planSwapUuid(doc.raw, ro.uuid, rn.uuid);
    const json = { op, from: assetPath(scan, ro.uuid), to: assetPath(scan, rn.uuid), fromUuid: ro.uuid, toUuid: rn.uuid, count };
    return { ok: true, asset, json, writes: count ? W(text) : [] };
  }
  const r = applyArrayOp(scan, doc, op, params, projectDir);
  if (r.error) return r;
  return { ok: true, asset, json: r.json, writes: W(serialize(doc.arr, doc.raw)), needsReimport: !!r.needsReimport, reimportReason: r.reimportReason, warning: r.warning };
}

/**
 * Apply MANY ops to one prefab/scene atomically: load once, apply each op to the
 * in-memory array (re-resolving selectors against the running state), and emit ONE
 * write. If any op fails, NOTHING is written (the caller just doesn't commit) — so
 * a structural refactor is all-or-nothing. swap-uuid is rejected (it's a text
 * patch; use swap-uuid / --all). `ops` = [{op, …params}] (no `file`).
 * @param {any} scan @param {string} projectDir @param {string} file @param {Array<any>} ops
 */
export function runBatch(scan, projectDir, file, ops) {
  if (!Array.isArray(ops) || ops.length === 0) return { error: '✗ batch needs a non-empty array of ops', code: 1 };
  const rf = resolveEditFile(scan, projectDir, file);
  if (rf.error) return rf;
  const { asset, absPath } = rf;
  const ld = loadOrErr(absPath, asset);
  if (ld.error) return ld;
  const { doc } = ld;
  const applied = []; const reasons = []; const warns = [];
  for (let i = 0; i < ops.length; i++) {
    const { op, ...params } = ops[i] || {};
    if (op === 'swap-uuid') return { error: `✗ batch op #${i}: swap-uuid is not supported in a batch (use swap-uuid or --all)`, code: 1, opIndex: i };
    const r = applyArrayOp(scan, doc, op, params, projectDir);
    if (r.error) return { error: `✗ batch op #${i} (${op || '?'}): ${String(r.error).replace(/^✗\s*/, '')}`, code: r.code || 2, candidates: r.candidates, opIndex: i };
    applied.push(r.json);
    if (r.needsReimport && r.reimportReason) reasons.push(r.reimportReason);
    if (r.warning) warns.push(`#${i}: ${r.warning}`);
  }
  const json = { op: 'batch', file: asset.path, count: applied.length, ops: applied };
  return { ok: true, asset, json, writes: [{ absPath, text: serialize(doc.arr, doc.raw), oldText: doc.raw, mtime: doc.mtime }],
    needsReimport: reasons.length > 0, reimportReason: reasons.length ? [...new Set(reasons)].join('; ') : undefined,
    warning: warns.length ? warns.join(' · ') : undefined };
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
    if (count > 0) { hits.push({ file: a.path, absPath: abs, text, oldText: doc.raw, mtime: doc.mtime, count }); totalRefs += count; }
  }
  const json = { op: 'swap-uuid', scope: 'all', from: assetPath(scan, ro.uuid), to: assetPath(scan, rn.uuid),
    fromUuid: ro.uuid, toUuid: rn.uuid, files: hits.map((h) => ({ file: h.file, count: h.count })),
    totalFiles: hits.length, totalRefs, skipped };
  return { ok: true, json, writes: hits.map((h) => ({ absPath: h.absPath, text: h.text, oldText: h.oldText, mtime: h.mtime })), hits, skipped };
}

/**
 * Offline structural validation of a prefab/scene file (no live engine needed).
 * Returns { ok, file, entries, errors, warnings, valid } or { error, code }.
 * @param {any} scan @param {string} projectDir @param {string} file
 */
export function verifyData(scan, projectDir, file) {
  const rf = resolveEditFile(scan, projectDir, file);
  if (rf.error) return rf;
  const ld = loadOrErr(rf.absPath, rf.asset); if (ld.error) return ld;
  const { errors, warnings } = verifyDoc(ld.doc.arr, { compName: compNameFor(scan) });
  return { ok: true, file: rf.asset.path, entries: ld.doc.arr.length, errors, warnings, valid: errors.length === 0 };
}

/**
 * Project-wide structural validation: run verifyDoc over EVERY prefab/scene and
 * aggregate. Unlike the per-file form this needs no target, so CI can gate the
 * whole project's structural health in one call (the offline counterpart of a
 * project-wide health check). A file that won't even load (not a 3.x array doc)
 * is a failure here — verify is about file validity (cf. roundtrip, which skips
 * such files since it audits the EDIT engine). Returns { ok, scope, total,
 * passed, failures, warnCount, valid }.
 * @param {any} scan @param {string} projectDir
 */
export function verifyAllData(scan, projectDir) {
  const assets = [...scan.assets.values()]
    .filter((a) => (a.type === 'prefab' || a.type === 'scene') && a.hasSource && a.path && !a.virtual)
    .sort((a, b) => a.path.localeCompare(b.path));
  const compName = compNameFor(scan);
  const failures = []; let warnCount = 0;
  for (const a of assets) {
    const abs = path.join(projectDir, 'assets', a.path);
    let doc;
    try { doc = loadDoc(abs); } catch (e) { failures.push({ file: a.path, errors: [{ code: 'unloadable', msg: e instanceof Error ? e.message : String(e) }] }); continue; }
    const { errors, warnings } = verifyDoc(doc.arr, { compName });
    warnCount += warnings.length;
    if (errors.length) failures.push({ file: a.path, errors });
  }
  return { ok: true, scope: 'all', total: assets.length, passed: assets.length - failures.length, failures, warnCount, valid: failures.length === 0 };
}

/**
 * Offline, READ-ONLY round-trip audit of prefab/scene files — the headless,
 * editor-free trust proof for the edit engine (complements `native-verify`,
 * which needs the live engine). For each file: (a) BYTE round-trip — does coir's
 * serializer reproduce the source verbatim (diff hygiene, WARN); (b) INVERTIBLE
 * probe — add-then-remove a node through the real engine and require the result
 * to equal the original (compaction/clone corruption, ERROR), plus a verifyDoc
 * on the probed result. Never writes. `all` sweeps every prefab/scene; else one
 * `file`. Returns { ok, scope, total, passed, byteDivergent[], failures[],
 * unprobed[], valid } or { error, code }.
 * @param {any} scan @param {string} projectDir @param {{all?:boolean, file?:string|null}} [opts]
 */
export function auditRoundtripData(scan, projectDir, { all = false, file = null } = {}) {
  let assets;
  if (all) {
    assets = [...scan.assets.values()]
      .filter((a) => (a.type === 'prefab' || a.type === 'scene') && a.hasSource && a.path && !a.virtual)
      .sort((a, b) => a.path.localeCompare(b.path));
  } else {
    const rf = resolveEditFile(scan, projectDir, file);
    if (rf.error) return rf;
    assets = [rf.asset];
  }
  const compName = compNameFor(scan);
  const byteDivergent = []; const failures = []; const unprobed = [];
  for (const a of assets) {
    const abs = path.join(projectDir, 'assets', a.path);
    let doc;
    try { doc = loadDoc(abs); } catch (e) { unprobed.push({ file: a.path, reason: 'unloadable' }); continue; } // not a 3.x array doc — plain `verify` owns it
    // Round-trip audits whether the engine safely edits OTHERWISE-VALID files; a
    // file that's already structurally broken is plain `verify`'s job, not this —
    // skip it (its missing/dangling refs would make any add/remove behave oddly).
    if (verifyDoc(doc.arr, { compName }).errors.length) { unprobed.push({ file: a.path, reason: 'pre-broken' }); continue; }
    const rt = roundTrip(doc.raw);
    if ('error' in rt) { unprobed.push({ file: a.path, reason: rt.code }); continue; } // defensive: loadDoc already guaranteed an array
    if (!rt.byteEqual) byteDivergent.push({ file: a.path, bytesIn: rt.bytesIn, bytesOut: rt.bytesOut });
    const pr = probeInvertible(doc.arr, { compName });
    if ('error' in pr) {
      // rm-failed = added a node but couldn't remove it → a genuine engine asymmetry.
      // no-node / no-template (add-failed) = the file just has nothing to probe → skip.
      if (pr.code === 'rm-failed') failures.push({ file: a.path, kind: pr.code, detail: pr.error });
      else unprobed.push({ file: a.path, reason: pr.code === 'add-failed' ? 'no-template' : pr.code });
      continue;
    }
    if (!pr.invertible) failures.push({ file: a.path, kind: 'not-invertible', detail: `${(pr.brokeProbes || []).join(', ') || 'a probe'} did not restore the original (compaction/clone/rewire bug)` });
    else if (pr.verifyErrors.length) failures.push({ file: a.path, kind: 'verify', detail: `${pr.verifyErrors.length} structural error(s) after a probe edit: ${pr.verifyErrors.slice(0, 3).map((e) => e.msg).join('; ')}` });
  }
  const failed = new Set(failures.map((f) => f.file));
  const skipped = new Set(unprobed.map((u) => u.file));
  const passed = assets.length - failed.size - skipped.size;
  return { ok: true, scope: all ? 'all' : 'file', total: assets.length, passed, byteDivergent, failures, unprobed, valid: failures.length === 0 };
}

/**
 * Host-side I/O collector for the `no-deep-instance-override` check rule: load
 * every prefab/scene and classify its nested-instance propertyOverrides
 * (`findInstanceOverrides`). Returns `[{ file, overrides[] }]` for the files that
 * have any — the rules engine stays pure and just reads this off `ctx`.
 * @param {any} scan @param {string} projectDir
 */
export function collectInstanceOverridesData(scan, projectDir) {
  const assets = [...scan.assets.values()]
    .filter((a) => (a.type === 'prefab' || a.type === 'scene') && a.hasSource && a.path && !a.virtual)
    .sort((a, b) => a.path.localeCompare(b.path));
  const out = [];
  for (const a of assets) {
    let doc;
    try { doc = loadDoc(path.join(projectDir, 'assets', a.path)); } catch { continue; }
    const overrides = findInstanceOverrides(doc.arr);
    if (overrides.length) out.push({ file: a.path, type: a.type, overrides });
  }
  return out;
}

/**
 * Host-side I/O collector for the `no-editor-preview-leak` check rule: load every
 * prefab/scene and flag any that contains a leaked editor preview Canvas
 * (`findPreviewCanvasLeaks`). Returns `[{ file, nodes[] }]`.
 * @param {any} scan @param {string} projectDir
 */
export function collectPreviewLeaksData(scan, projectDir) {
  const assets = [...scan.assets.values()]
    .filter((a) => (a.type === 'prefab' || a.type === 'scene') && a.hasSource && a.path && !a.virtual)
    .sort((a, b) => a.path.localeCompare(b.path));
  const out = [];
  for (const a of assets) {
    let doc;
    try { doc = loadDoc(path.join(projectDir, 'assets', a.path)); } catch { continue; }
    const nodes = findPreviewCanvasLeaks(doc.arr);
    if (nodes.length) out.push({ file: a.path, nodes });
  }
  return out;
}

/**
 * Verify the SERIALIZED text an edit would write (used by `--verify` to gate a
 * commit). Returns { errors, warnings } (a parse failure is an error).
 * @param {any} scan @param {string} text
 */
export function verifyText(scan, text) {
  let arr; try { arr = JSON.parse(text); } catch (e) { return { errors: [{ code: 'parse', msg: e instanceof Error ? e.message : String(e) }], warnings: [] }; }
  return verifyDoc(arr, { compName: compNameFor(scan) });
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
export function treeData(scan, projectDir, file, { withType = null, under = null, depth = Infinity, values = false } = {}) {
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
  // `values`: inline each node's + component's RAW serialized object (the deep
  // read — structure AND values in one call, no per-node `get` round-trips).
  if (values) nodes = nodes.map((nd) => ({
    ...nd,
    value: ld.doc.arr[nd.index],
    components: nd.components.map((c) => ({ ...c, value: ld.doc.arr[c.index] })),
  }));
  return { ok: true, file: rf.asset.path, nodeCount: nodes.length, nodes };
}
