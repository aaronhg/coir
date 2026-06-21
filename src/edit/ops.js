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
import { resolveTarget } from '../seam/shared.js';
import { loadDoc, planSwapUuid, serialize, writeAtomic, resolveSelector, getDeep, setDeep,
  eulerToQuat, setParent, removeNode, removeComponent, addNode, addComponent,
  nestedInstanceRoot, subtreeHasInstance, listNodes, verifyDoc } from './editPrefab.js';

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
 * Apply ONE array-mutating edit op to `doc.arr` in place (rm ops reassign
 * `doc.arr` to the compacted array). Returns { json } | { error, code,
 * candidates? } — NO serialization or file I/O. swap-uuid is NOT here (it's a
 * raw-text patch, handled in runEdit). Selectors are resolved against the CURRENT
 * `doc.arr`, so this composes: runBatch calls it N times on one loaded doc.
 * @param {any} scan @param {{arr:any[], raw:string, mtime:number}} doc @param {string} op @param {any} params
 */
function applyArrayOp(scan, doc, op, params) {
  const compName = compNameFor(scan);
  switch (op) {
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
      return { json };
    }
    case 'rename': case 'set-active': case 'set-layer': case 'set-pos': case 'set-scale': {
      const res = resolveSelector(doc.arr, params.selector, compName);
      if ('error' in res) return selError(res);
      if (res.kind !== 'node') return { error: OM.needNode(params.selector), code: 2 };
      const g = editableGuard(doc.arr, res.index); if (g) return g;
      const field = { rename: '_name', 'set-active': '_active', 'set-layer': '_layer', 'set-pos': '_lpos', 'set-scale': '_lscale' }[op];
      doc.arr[res.index][field] = params.value;
      return { json: { op, node: params.selector, field, value: params.value } };
    }
    case 'set-rot': {
      const res = resolveSelector(doc.arr, params.selector, compName);
      if ('error' in res) return selError(res);
      if (res.kind !== 'node') return { error: OM.needNode(params.selector), code: 2 };
      const g = editableGuard(doc.arr, res.index); if (g) return g;
      const e = params.value; const node = doc.arr[res.index];
      node._euler = e; node._lrot = eulerToQuat(e.x, e.y, e.z);
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
    case 'add-node': {
      const ni = resolveNode(doc.arr, params.parent, compName); if (ni.error) return ni;
      const r = addNode(doc.arr, ni.index, params.name, params.index);
      if ('error' in r) return { error: OM.selErr(r.error), code: 2 };
      return { json: { op, parent: params.parent, name: params.name, index: r.index } };
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
  const r = applyArrayOp(scan, doc, op, params);
  if (r.error) return r;
  return { ok: true, asset, json: r.json, writes: W(serialize(doc.arr, doc.raw)) };
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
  const applied = [];
  for (let i = 0; i < ops.length; i++) {
    const { op, ...params } = ops[i] || {};
    if (op === 'swap-uuid') return { error: `✗ batch op #${i}: swap-uuid is not supported in a batch (use swap-uuid or --all)`, code: 1, opIndex: i };
    const r = applyArrayOp(scan, doc, op, params);
    if (r.error) return { error: `✗ batch op #${i} (${op || '?'}): ${String(r.error).replace(/^✗\s*/, '')}`, code: r.code || 2, candidates: r.candidates, opIndex: i };
    applied.push(r.json);
  }
  const json = { op: 'batch', file: asset.path, count: applied.length, ops: applied };
  return { ok: true, asset, json, writes: [{ absPath, text: serialize(doc.arr, doc.raw), oldText: doc.raw, mtime: doc.mtime }] };
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
