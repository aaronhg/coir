// @ts-check
// Headless, in-place editor for EXISTING Cocos prefab/scene files — never a
// from-scratch generator. P0 = Tier 0: asset-reference swaps via quote-anchored
// text patching, so the edit is minimal-diff and version-agnostic (3.5.2 ≡
// 3.8.6 — only the `__uuid__` string moves, no structure is touched). The
// DOM-free core stays read-only; all writing lives here in the Node layer.
//
// See docs/EDITING.md for the full design.
import fs from 'node:fs';

/**
 * Read a scene/prefab and verify it is a 3.x file (a JSON array of tagged
 * objects). Returns the raw text (for text-patching) and the parsed array (for
 * checks). Throws on bad JSON or a non-array (e.g. a 2.x `.fire`, a stray file).
 * `mtime` (the source's mtimeMs at read) lets a writer detect a concurrent
 * change (e.g. Cocos Creator saving the same file) before clobbering it.
 * @param {string} absPath
 * @returns {{ raw: string, arr: any[], mtime: number }}
 */
export function loadDoc(absPath) {
  const raw = fs.readFileSync(absPath, 'utf8');
  let arr;
  try { arr = JSON.parse(raw); }
  catch (e) { throw new Error(`not valid JSON (${e instanceof Error ? e.message : e})`); }
  if (!Array.isArray(arr)) throw new Error('not a 3.x scene/prefab (expected a JSON array of objects)');
  return { raw, arr, mtime: fs.statSync(absPath).mtimeMs };
}

/**
 * Plan a uuid swap as two quote-anchored literal replacements:
 *   "<old>"   → "<new>"    (a whole-asset reference)
 *   "<old>@   → "<new>@    (a sub-asset reference; the shared sub-id is kept)
 * A full 36-char uuid only ever appears as a `__uuid__` value in a scene/prefab
 * — a script's `__type__` is the *compressed* form, a different string — so a
 * quote-anchored replace touches references and nothing else. No reformatting,
 * no reordering: every other byte is preserved.
 * @param {string} raw
 * @param {string} oldUuid
 * @param {string} newUuid
 * @returns {{ text: string, count: number }}
 */
export function planSwapUuid(raw, oldUuid, newUuid) {
  if (oldUuid === newUuid) return { text: raw, count: 0 }; // same asset → no-op (don't rewrite)
  const whole = `"${oldUuid}"`;
  const sub = `"${oldUuid}@`;
  const count = (raw.split(whole).length - 1) + (raw.split(sub).length - 1);
  const text = raw.split(whole).join(`"${newUuid}"`).split(sub).join(`"${newUuid}@`);
  return { text, count };
}

/**
 * Write atomically (temp file → rename) so a crash never leaves a half-written
 * prefab. With `backup`, the original is copied to `<file>.bak` first. With
 * `expectMtime`, the on-disk mtime is re-checked just before the rename — if it
 * differs from what was read, the file changed underneath us (e.g. Cocos Creator
 * saved it) and the write is REFUSED rather than clobbering that change.
 * @param {string} absPath
 * @param {string} text
 * @param {{ backup?: boolean, expectMtime?: number|null }} [opts]
 */
export function writeAtomic(absPath, text, { backup = false, expectMtime = null } = {}) {
  if (expectMtime != null) {
    let cur = null;
    try { cur = fs.statSync(absPath).mtimeMs; } catch { /* gone → treat as changed */ }
    if (cur !== expectMtime) throw new Error('file changed on disk since it was read — re-read and retry (or force)');
  }
  if (backup) fs.copyFileSync(absPath, `${absPath}.bak`);
  const tmp = `${absPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, absPath);
}

// ===========================================================================
//  Tier 1/2 — selector resolution + in-object mutation (parse-rewrite)
//  Non-structural edits: change one value/field on an existing object, then
//  re-serialize. No `__id__` is added or removed, so nothing needs renumbering.
// ===========================================================================

const isNodeType = (t) => t === 'cc.Node' || t === 'cc.Scene';

/** node path (`/`-joined `_name` from the root) for the node at `idx`. */
function nodePathOf(arr, idx) {
  const names = []; let cur = idx; const seen = new Set();
  while (cur != null && !seen.has(cur)) {
    seen.add(cur);
    const o = arr[cur];
    if (!o || !isNodeType(o.__type__)) break;
    names.push(o._name ?? '');
    const p = o._parent;
    cur = p && typeof p.__id__ === 'number' ? p.__id__ : null;
  }
  return names.reverse().join('/');
}

/** Map node path → [arrayIndex…]; a path with >1 entry means same-name siblings. */
export function buildNodeIndex(arr) {
  /** @type {Map<string, number[]>} */
  const byPath = new Map();
  arr.forEach((o, i) => {
    if (o && isNodeType(o.__type__)) {
      const p = nodePathOf(arr, i);
      const list = byPath.get(p) || byPath.set(p, []).get(p);
      /** @type {number[]} */(list).push(i);
    }
  });
  return byPath;
}

/** "Canvas/Item[2]" → { path:'Canvas/Item', sib:2 } */
function parseNodePart(s) {
  const m = /^(.*?)(?:\[(\d+)\])?$/.exec(s) || [];
  return { path: m[1] ?? s, sib: m[2] !== undefined ? Number(m[2]) : null };
}

/**
 * Resolve a selector against a parsed doc.
 *   <nodePath>[i]                       → a node
 *   <nodePath>:<Type>[i]                → a component
 *   <nodePath>:<Type>[i].<prop.path>    → a property
 *   #<arrayIndex>                       → escape hatch
 * `compName(rawType)` maps a `__type__` to its matchable name (a builtin class
 * string, or a custom script's class name) — the whitelist used for longest
 * match, so a namespaced type (`cc.Label`) is split from the property cleanly.
 * @returns {{index:number, kind:'node'|'component'|'property', node?:number, prop?:string} | {error:string, candidates?:string[]}}
 */
export function resolveSelector(arr, sel, compName) {
  if (sel.startsWith('#')) {
    const m = /^#(\d+)(.*)$/.exec(sel);
    if (!m) return { error: `bad #index selector "${sel}"` };
    const i = Number(m[1]);
    if (i < 0 || i >= arr.length) return { error: `#${m[1]} out of range [0,${arr.length})` };
    let rest = m[2]; if (rest.startsWith('.')) rest = rest.slice(1);
    if (rest) return { index: i, kind: 'property', prop: rest };
    return { index: i, kind: arr[i] && isNodeType(arr[i].__type__) ? 'node' : 'component' };
  }
  const colon = sel.indexOf(':');
  const nodeSel = colon < 0 ? sel : sel.slice(0, colon);
  const compSel = colon < 0 ? '' : sel.slice(colon + 1);

  const byPath = buildNodeIndex(arr);
  let nodeIndex;
  if (byPath.has(nodeSel)) { // exact literal path first — a node may be named e.g. "Slot[0]"
    const hits = /** @type {number[]} */ (byPath.get(nodeSel));
    if (hits.length > 1) return { error: `"${nodeSel}" matches ${hits.length} same-name nodes — add [i]` };
    nodeIndex = hits[0];
  } else { // else strip a trailing [i] as sibling-order disambiguation
    const { path, sib } = parseNodePart(nodeSel);
    const hits = byPath.get(path) || [];
    if (!hits.length) return { error: `no node "${path}"`, candidates: [...byPath.keys()].filter(Boolean).sort() };
    if (sib != null) {
      if (sib >= hits.length) return { error: `sibling [${sib}] out of range for "${path}" (${hits.length})` };
      nodeIndex = hits[sib];
    } else if (hits.length > 1) {
      return { error: `"${path}" matches ${hits.length} same-name nodes — add [i]` };
    } else nodeIndex = hits[0];
  }

  if (!compSel) return { index: nodeIndex, kind: 'node' };

  const node = arr[nodeIndex];
  const refs = (node._components || []).map((r) => r && r.__id__).filter((x) => typeof x === 'number');
  const named = refs.map((ci) => ({ ci, name: compName(arr[ci] && arr[ci].__type__) })).filter((c) => c.name);
  let typeName = null, rest = compSel;
  for (const { name } of [...named].sort((a, b) => b.name.length - a.name.length)) {
    if (compSel === name || compSel.startsWith(`${name}.`) || compSel.startsWith(`${name}[`)) { typeName = name; rest = compSel.slice(name.length); break; }
  }
  if (!typeName) return { error: `node "${nodeSel}" has no component matching "${compSel}"`, candidates: [...new Set(named.map((c) => c.name))] };

  const sameType = named.filter((c) => c.name === typeName).map((c) => c.ci);
  const mt = /^\[(\d+)\]/.exec(rest);
  if (mt) rest = rest.slice(mt[0].length);
  // Ambiguity is refused, not silently resolved — same rule as same-name nodes
  // above: 2+ components of one type on a node require an explicit [i].
  else if (sameType.length > 1) return { error: `"${nodeSel}" has ${sameType.length} ${typeName} components — add [i]` };
  const typeIdx = mt ? Number(mt[1]) : 0;
  if (typeIdx >= sameType.length) return { error: `${typeName}[${typeIdx}] out of range (${sameType.length})` };
  const compIndex = sameType[typeIdx];

  if (rest.startsWith('.')) rest = rest.slice(1);
  if (!rest) return { index: compIndex, kind: 'component', node: nodeIndex };
  return { index: compIndex, kind: 'property', prop: rest, node: nodeIndex };
}

/**
 * Read a (possibly nested / [i]-bracketed) property — the read complement of
 * setDeep, sharing the same `[i]`→`.i` normalization.
 * @returns {{value:any}|{error:string}}
 */
export function getDeep(obj, propPath) {
  const parts = propPath.replace(/\[(\d+)\]/g, '.$1').split('.').filter((p) => p !== '');
  let cur = obj;
  for (const k of parts) {
    if (cur == null || typeof cur !== 'object') return { error: `path "${propPath}" stops before "${k}"` };
    cur = cur[k];
  }
  return { value: cur };
}

/**
 * Enumerate the node hierarchy for STRUCTURE DISCOVERY (the `tree` command) —
 * the read complement to the selector grammar. Every node carries its
 * DISAMBIGUATED selector path (a same-name sibling gets the `[i]` it needs) and
 * its components, each with a ready `nodePath:Type` selector (a same-type pair
 * gets `[i]` too); a component whose type can't be named falls back to `#index`.
 * So every `path`/`selector` here pastes straight back into another `edit` op.
 * Nodes come in depth-first child order with a relative `depth` (root = 0, for
 * indentation), an `active` flag, and an `instance` flag marking a nested-prefab
 * -instance root (edit those in their source prefab, never here).
 * @param {any[]} arr
 * @param {(rawType:any)=>string} compName  __type__ → canonical class name ('' if unnameable)
 * @param {{depth?:number, under?:number|null}} [opts]  depth = levels below the root to include; under = subtree root index
 * @returns {Array<{index:number, path:string, name:string, depth:number, active:boolean, instance:boolean, components:Array<{index:number, type:string, selector:string}>}>}
 */
export function listNodes(arr, compName, { depth = Infinity, under = null } = {}) {
  const byPath = buildNodeIndex(arr);
  const pathSel = (idx) => {
    const p = nodePathOf(arr, idx);
    const g = byPath.get(p);
    return g && g.length > 1 ? `${p}[${g.indexOf(idx)}]` : p; // same-name sibling → trailing [i]
  };
  const isInst = (idx) => {
    const node = arr[idx];
    const pi = node && isRef(node._prefab) ? arr[node._prefab.__id__] : null;
    return !!(pi && pi.__type__ === 'cc.PrefabInfo' && pi.instance != null);
  };
  const compsOf = (idx, sel) => {
    const refs = ((arr[idx] && arr[idx]._components) || []).filter(isRef).map((r) => r.__id__);
    /** @type {Record<string, number>} */ const total = {};
    for (const ci of refs) { const n = compName(arr[ci] && arr[ci].__type__); if (n) total[n] = (total[n] || 0) + 1; }
    /** @type {Record<string, number>} */ const seen = {};
    return refs.map((ci) => {
      const n = compName(arr[ci] && arr[ci].__type__);
      if (!n) return { index: ci, type: String((arr[ci] && arr[ci].__type__) ?? '?'), selector: `#${ci}` };
      const k = (seen[n] = (seen[n] === undefined ? 0 : seen[n] + 1));
      const part = total[n] > 1 ? `${n}[${k}]` : n; // same-type sibling → [i]
      return { index: ci, type: n, selector: `${sel}:${part}` };
    });
  };
  const out = [];
  const seen = new Set();
  const visit = (idx, d) => {
    const node = arr[idx];
    if (!node || !isNodeType(node.__type__) || seen.has(idx)) return; // guard a corrupt _children cycle / shared child
    seen.add(idx);
    const sel = pathSel(idx);
    out.push({ index: idx, path: sel, name: node._name ?? '', depth: d,
      active: node._active !== false, instance: isInst(idx), components: compsOf(idx, sel) });
    if (d >= depth) return; // depth limit, root = 0
    for (const ch of node._children || []) if (isRef(ch)) visit(ch.__id__, d + 1);
  };
  if (under != null) visit(under, 0);
  else arr.forEach((o, i) => { if (o && isNodeType(o.__type__) && !isRef(o._parent)) visit(i, 0); });
  return out;
}

/**
 * Set a (possibly nested, dot-separated) property on an object.
 * @returns {{ok:true, old:any}|{error:string}}
 */
export function setDeep(obj, propPath, value) {
  // Unify indexing: array elements use the same [i] bracket as node/component
  // disambiguation (e.g. clickEvents[0].handler). The component [i] was already
  // consumed in resolveSelector, so any remaining bracket is an array index.
  // `.i` keeps working (it's the normalized form), so both notations resolve.
  const parts = propPath.replace(/\[(\d+)\]/g, '.$1').split('.').filter((p) => p !== '');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (cur[k] == null || typeof cur[k] !== 'object') return { error: `path "${propPath}" stops at "${k}"` };
    cur = cur[k];
  }
  const last = parts[parts.length - 1];
  const old = cur[last];
  cur[last] = value;
  return { ok: true, old };
}

/** Serialize the array back to text (2-space, matching Cocos), preserving a trailing newline. */
export function serialize(arr, raw) {
  const text = JSON.stringify(arr, null, 2);
  return raw && raw.endsWith('\n') ? `${text}\n` : text;
}

/**
 * Euler angles (degrees) → a `cc.Quat`. Order and signs are verbatim from
 * cocos-engine v3.8 `Quat.fromEuler` (halfToRad = 0.5·π/180; x/y add, z/w
 * subtract), so the result is bit-compatible with what the editor would write.
 * set-rot writes BOTH `_lrot` (this) and `_euler`, since `_lrot` is the
 * transform's source of truth and a stale one would render the old rotation.
 */
export function eulerToQuat(ex, ey, ez) {
  const h = 0.5 * Math.PI / 180;
  const x = ex * h, y = ey * h, z = ez * h;
  const sx = Math.sin(x), cx = Math.cos(x);
  const sy = Math.sin(y), cy = Math.cos(y);
  const sz = Math.sin(z), cz = Math.cos(z);
  return {
    __type__: 'cc.Quat',
    x: sx * cy * cz + cx * sy * sz,
    y: cx * sy * cz + sx * cy * sz,
    z: cx * cy * sz - sx * sy * cz,
    w: cx * cy * cz - sx * sy * sz,
  };
}

// Is `candidateIdx` somewhere below `ancestorIdx` in the node tree? (walk up)
function isDescendant(arr, ancestorIdx, candidateIdx) {
  let cur = candidateIdx; const seen = new Set();
  while (cur != null && !seen.has(cur)) {
    seen.add(cur);
    const p = arr[cur] && arr[cur]._parent;
    cur = p && typeof p.__id__ === 'number' ? p.__id__ : null;
    if (cur === ancestorIdx) return true;
  }
  return false;
}

/**
 * Re-parent a node: detach from its current parent's `_children`, point its
 * `_parent` at the new one, and insert into the new parent's `_children` (at
 * `siblingIndex`, or appended). No `__id__` is added/removed, so no renumbering.
 * Refuses the root, self-moves, and cycles (moving into a descendant).
 * @returns {{ok?:boolean, error?:string}}
 */
export function setParent(arr, nodeIndex, newParentIndex, siblingIndex = -1) {
  const node = arr[nodeIndex];
  const parent = arr[newParentIndex];
  if (!node || !isNodeType(node.__type__)) return { error: `#${nodeIndex} is not a node` };
  if (!parent || !isNodeType(parent.__type__)) return { error: `#${newParentIndex} is not a node` };
  if (nodeIndex === newParentIndex) return { error: 'cannot move a node into itself' };
  if (isDescendant(arr, nodeIndex, newParentIndex)) return { error: 'cannot move a node into its own descendant' };

  const oldRef = node._parent;
  if (!oldRef || typeof oldRef.__id__ !== 'number') return { error: 'cannot move the root node' };
  const old = arr[oldRef.__id__];
  if (old && Array.isArray(old._children)) old._children = old._children.filter((c) => !(c && c.__id__ === nodeIndex));

  node._parent = { __id__: newParentIndex };
  if (!Array.isArray(parent._children)) parent._children = [];
  const ref = { __id__: nodeIndex };
  if (siblingIndex == null || siblingIndex < 0 || siblingIndex >= parent._children.length) parent._children.push(ref);
  else parent._children.splice(siblingIndex, 0, ref);
  return { ok: true };
}

// ===========================================================================
//  Tier 3 — structural add / remove (real delete + index compaction,
//  template-by-example for adds). The two hard parts the design called for.
// ===========================================================================

const isRef = (v) => v != null && typeof v === 'object' && typeof v.__id__ === 'number';
const pad22 = (s) => `${s}xxxxxxxxxxxxxxxxxxxxxx`.slice(0, 22);
const isPrefabFile = (arr) => !!(arr[0] && arr[0].__type__ === 'cc.Prefab');
// Deep-clone the first entry of a given __type__ (template-by-example), or null.
function cloneOf(arr, typeName) {
  const found = arr.find((o) => o && o.__type__ === typeName);
  return found ? JSON.parse(JSON.stringify(found)) : null;
}

// Every array index owned by a node's subtree: the node, its PrefabInfo, each
// component + that component's CompPrefabInfo, recursively for children.
function collectNodeSubtree(arr, nodeIndex) {
  const set = new Set();
  (function visit(ni) {
    if (set.has(ni)) return;
    const node = arr[ni]; if (!node) return;
    set.add(ni);
    if (isRef(node._prefab)) set.add(node._prefab.__id__);
    for (const cref of node._components || []) {
      if (!isRef(cref)) continue;
      set.add(cref.__id__);
      const comp = arr[cref.__id__];
      if (comp && isRef(comp.__prefab)) set.add(comp.__prefab.__id__);
    }
    for (const ch of node._children || []) if (isRef(ch)) visit(ch.__id__);
  })(nodeIndex);
  return set;
}

// Call cb(toIndex) for every {__id__:toIndex} reference under `v`.
function eachRef(v, cb) {
  if (Array.isArray(v)) { for (const el of v) eachRef(el, cb); return; }
  if (v && typeof v === 'object') {
    if (typeof v.__id__ === 'number') cb(v.__id__);
    for (const k of Object.keys(v)) if (k !== '__id__') eachRef(v[k], cb);
  }
}

// Grow a removal seed to also include entries EXCLUSIVELY owned by it — every
// referrer is already in the set (a Button's cc.ClickEvent entries, a
// PrefabInfo's cc.PrefabInstance, nested value objects). Without this they'd be
// left as unreachable orphan entries after compaction. A shared/cross-referenced
// entry (kept alive by a surviving _children/node back-ref) stays out.
function ownedClosure(arr, seed) {
  /** @type {Map<number, Set<number>>} */
  const referrers = new Map();
  arr.forEach((o, i) => eachRef(o, (to) => {
    const s = referrers.get(to) || referrers.set(to, new Set()).get(to);
    /** @type {Set<number>} */ (s).add(i);
  }));
  const set = new Set(seed);
  for (let changed = true; changed;) {
    changed = false;
    for (const [x, refs] of referrers) {
      if (set.has(x)) continue;
      if ([...refs].every((r) => set.has(r))) { set.add(x); changed = true; }
    }
  }
  return set;
}

/** True if a node's subtree contains a nested prefab instance (PrefabInfo.instance != null). */
export function subtreeHasInstance(arr, nodeIndex) {
  for (const i of collectNodeSubtree(arr, nodeIndex)) {
    const o = arr[i];
    if (o && isNodeType(o.__type__)) {
      const pi = isRef(o._prefab) ? arr[o._prefab.__id__] : null;
      if (pi && pi.__type__ === 'cc.PrefabInfo' && pi.instance != null) return true;
    }
  }
  return false;
}

// Drop ref-elements pointing into `removeSet` from arrays (e.g. _children /
// _components) and null out ref-properties pointing into it (dangling cross-
// references, like a ClickEvent.target on a surviving node). Counts the latter.
function scrubRefs(v, removeSet, counter) {
  if (Array.isArray(v)) {
    const out = [];
    for (const el of v) {
      if (isRef(el)) { if (!removeSet.has(el.__id__)) out.push(el); }
      else out.push(scrubRefs(el, removeSet, counter));
    }
    return out;
  }
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) {
      const child = v[k];
      if (isRef(child)) { if (removeSet.has(child.__id__)) { v[k] = null; counter.n++; } }
      else v[k] = scrubRefs(child, removeSet, counter);
    }
    return v;
  }
  return v;
}

/**
 * Remove a set of array indices and compact: scrub references into the removed
 * set (drop from owner lists, null dangling cross-refs), then renumber every
 * surviving `{__id__}` to its new position. The append-only invariant means
 * this is the ONLY operation that renumbers — and it does so globally, so no
 * stale index survives. Returns the new array + how many cross-refs were nulled.
 * @returns {{ keep:any[], cleared:number }}
 */
export function removeEntries(arr, removeSet) {
  const counter = { n: 0 };
  for (let i = 0; i < arr.length; i++) if (!removeSet.has(i)) arr[i] = scrubRefs(arr[i], removeSet, counter);
  /** @type {Map<number, number>} */
  const oldToNew = new Map();
  const keep = [];
  for (let i = 0; i < arr.length; i++) if (!removeSet.has(i)) { oldToNew.set(i, keep.length); keep.push(arr[i]); }
  remapIds(keep, oldToNew);
  return { keep, cleared: counter.n };
}

// Renumber every `{__id__}` under `v` via the old→new index map (in place).
/** @param {any} v @param {Map<number, number>} oldToNew */
function remapIds(v, oldToNew) {
  if (Array.isArray(v)) { for (const el of v) remapIds(el, oldToNew); return; }
  if (v && typeof v === 'object') {
    if (typeof v.__id__ === 'number') { const nn = oldToNew.get(v.__id__); if (nn !== undefined) v.__id__ = nn; }
    for (const k of Object.keys(v)) if (k !== '__id__') remapIds(v[k], oldToNew);
  }
}

/** Real-delete a node subtree (node + descendants + their components + Prefab/CompPrefabInfo). */
export function removeNode(arr, nodeIndex) {
  const node = arr[nodeIndex];
  if (!node || !isNodeType(node.__type__)) return { error: `#${nodeIndex} is not a node` };
  if (node.__type__ === 'cc.Scene') return { error: 'cannot remove the scene root' };
  if (!isRef(node._parent)) return { error: 'cannot remove the root node' };
  const set = ownedClosure(arr, collectNodeSubtree(arr, nodeIndex));
  const { keep, cleared } = removeEntries(arr, set);
  return { ok: true, newArr: keep, removed: set.size, cleared };
}

/** Real-delete one component (+ its CompPrefabInfo + any inline-owned objects). */
export function removeComponent(arr, compIndex) {
  const comp = arr[compIndex];
  // a real component is node-bearing — rejects nodes, cc.Prefab, and meta
  // objects (PrefabInfo/CompPrefabInfo/PrefabInstance/ClickEvent) reached via #N.
  if (!comp || isNodeType(comp.__type__) || comp.__type__ === 'cc.Prefab' || !isRef(comp.node)) {
    return { error: `#${compIndex} is not a component` };
  }
  const seed = new Set([compIndex]);
  if (isRef(comp.__prefab)) seed.add(comp.__prefab.__id__);
  const set = ownedClosure(arr, seed);
  const { keep, cleared } = removeEntries(arr, set);
  return { ok: true, newArr: keep, removed: set.size, cleared };
}

/** Append a new empty node under a parent, cloning an existing node's skeleton. */
export function addNode(arr, parentIndex, name, siblingIndex = -1) {
  const parent = arr[parentIndex];
  if (!parent || !isNodeType(parent.__type__)) return { error: `#${parentIndex} is not a node` };
  const node = cloneOf(arr, 'cc.Node');
  if (!node) return { error: 'no existing cc.Node to use as a template' };
  node._name = name;
  node._parent = { __id__: parentIndex };
  node._children = [];
  node._components = [];
  node._prefab = null;
  if ('_id' in node) node._id = pad22(`n${arr.length}`);
  if (node._lpos) node._lpos = { __type__: 'cc.Vec3', x: 0, y: 0, z: 0 };
  if (node._lscale) node._lscale = { __type__: 'cc.Vec3', x: 1, y: 1, z: 1 };
  if (node._lrot) node._lrot = { __type__: 'cc.Quat', x: 0, y: 0, z: 0, w: 1 };
  if (node._euler) node._euler = { __type__: 'cc.Vec3', x: 0, y: 0, z: 0 };
  if ('_active' in node) node._active = true;
  const nodeIndex = arr.length; arr.push(node);

  if (isPrefabFile(arr)) { // give it a PrefabInfo (clone skeleton for version-correct fields)
    const pi = cloneOf(arr, 'cc.PrefabInfo') || { __type__: 'cc.PrefabInfo', fileId: '' };
    const rootIdx = isRef(arr[0].data) ? arr[0].data.__id__ : 1; // the prefab's root cc.Node
    // Reset every identity/link field so the clone carries none of the template's
    // own refs (a stale root/asset, or a dangling nestedPrefabInstanceRoots __id__).
    if ('fileId' in pi) pi.fileId = pad22(`f${nodeIndex}`);
    if ('root' in pi) pi.root = { __id__: rootIdx };
    if ('asset' in pi) pi.asset = { __id__: 0 };
    if ('instance' in pi) pi.instance = null;
    if ('targetOverrides' in pi) pi.targetOverrides = null;
    if ('nestedPrefabInstanceRoots' in pi) pi.nestedPrefabInstanceRoots = null;
    const piIndex = arr.length; arr.push(pi);
    node._prefab = { __id__: piIndex };
  }
  if (!Array.isArray(parent._children)) parent._children = [];
  const ref = { __id__: nodeIndex };
  if (siblingIndex == null || siblingIndex < 0 || siblingIndex >= parent._children.length) parent._children.push(ref);
  else parent._children.splice(siblingIndex, 0, ref);
  return { ok: true, index: nodeIndex };
}

/**
 * If `index` (a node or component) sits at/under a NESTED prefab instance, return
 * that instance-root node's index; else null. A nested instance root is a node
 * whose PrefabInfo has a non-null `instance` (a cc.PrefabInstance). We only edit
 * A's own nodes and edit B via B.prefab — never an instance's overrides inline —
 * so callers refuse when this is non-null. (A's own/top PrefabInfo has instance=null.)
 */
export function nestedInstanceRoot(arr, index) {
  const obj = arr[index];
  let cur = (obj && !isNodeType(obj.__type__) && isRef(obj.node)) ? obj.node.__id__ : index; // component → its node
  const seen = new Set();
  while (cur != null && !seen.has(cur)) {
    seen.add(cur);
    const node = arr[cur]; if (!node) break;
    const pi = isRef(node._prefab) ? arr[node._prefab.__id__] : null;
    if (pi && pi.__type__ === 'cc.PrefabInfo' && pi.instance != null) return cur;
    const p = node._parent;
    cur = p && typeof p.__id__ === 'number' ? p.__id__ : null;
  }
  return null;
}

/** Append a (minimal, defaults-on-load) component to a node; CompPrefabInfo in prefabs. */
export function addComponent(arr, nodeIndex, typeName) {
  const node = arr[nodeIndex];
  if (!node || !isNodeType(node.__type__)) return { error: `#${nodeIndex} is not a node` };
  const comp = { __type__: typeName, _name: '', _objFlags: 0, node: { __id__: nodeIndex }, _enabled: true, __prefab: null, _id: pad22(`c${arr.length}`) };
  const compIndex = arr.length; arr.push(comp);
  if (isPrefabFile(arr)) {
    const ci = cloneOf(arr, 'cc.CompPrefabInfo') || { __type__: 'cc.CompPrefabInfo', fileId: '' };
    if ('fileId' in ci) ci.fileId = pad22(`f${compIndex}`);
    const ciIndex = arr.length; arr.push(ci);
    comp.__prefab = { __id__: ciIndex };
  }
  if (!Array.isArray(node._components)) node._components = [];
  node._components.push({ __id__: compIndex });
  return { ok: true, index: compIndex };
}
