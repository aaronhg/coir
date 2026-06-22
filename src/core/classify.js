// @ts-check
// Pure, DOM-free, NO-I/O classifiers over a parsed prefab/scene array. Kept here
// (not in editPrefab.js, which imports node:fs) so the BROWSER can import them too
// — the 報告 tab surfaces these, and the `coir check` rules consume them via the
// host's collectors. See docs/NESTED-PREFABS.md.

const isNodeType = (t) => t === 'cc.Node' || t === 'cc.Scene';
const refAt = (arr, ref) => (ref && typeof ref.__id__ === 'number') ? arr[ref.__id__] : null;

/**
 * nodePath of a node (by array index): walk `_parent` to the root, `/`-joined.
 * An unnamed node renders via `unnamed(i)` — default `#idx` (readable for display);
 * editPrefab passes `() => ''` (its selector-index map keys an unnamed node as '').
 * Pure. The one canonical implementation (editPrefab + the browser report share it).
 * @param {any[]} arr @param {number} index @param {(i:number)=>string} [unnamed]
 */
export function nodePathOf(arr, index, unnamed) {
  const segs = []; let i = index; const seen = new Set();
  while (i != null && !seen.has(i) && arr[i] && isNodeType(arr[i].__type__)) {
    seen.add(i);
    const nm = arr[i]._name;
    segs.push((nm != null && nm !== '') ? nm : (unnamed ? unnamed(i) : `#${i}`));
    const p = arr[i]._parent;
    i = (p && typeof p.__id__ === 'number') ? p.__id__ : null;
  }
  return segs.reverse().join('/');
}

/** Map a `PrefabInfo.fileId` to the owning node's nodePath within `arr` (e.g. the source prefab). Null if none. Pure. */
export function fileIdToPath(arr, fileId) {
  if (!Array.isArray(arr) || fileId == null) return null;
  for (let i = 0; i < arr.length; i++) {
    const n = arr[i];
    if (!n || !isNodeType(n.__type__) || !n._prefab) continue;
    const pi = refAt(arr, n._prefab);
    if (pi && pi.__type__ === 'cc.PrefabInfo' && pi.fileId === fileId) return nodePathOf(arr, i);
  }
  return null;
}

/**
 * Classify every nested-instance `propertyOverride` in a parsed prefab/scene as
 * **on-root** vs **deeper**. An override targets the instance ROOT iff its
 * `TargetInfo.localID` is the single fileId of the host instance node's
 * `PrefabInfo` — the placement/identity layer (`_lpos`/`_name`/… the editor pins
 * on every instance). Anything else (a different/longer `localID`) is a property
 * of a node/component **inside** the instance. `cc.TargetOverrideInfo` (reference
 * wiring) is NOT a propertyOverride and is intentionally ignored. Drives the
 * `no-deep-instance-override` check rule + the 報告 view. One record per override:
 * `{ instance, prop, localID, onRoot }`.
 * Each record also carries the host instance node's `instancePath` (its file-side
 * nodePath, nicer than a bare `#idx`) + `sourceUuid` (the instance's source prefab,
 * so a caller can resolve `localID` → the DEEP node's name via `fileIdToPath`).
 * @param {any[]} arr
 * @returns {Array<{instance:string, instancePath:string, sourceUuid:string|null, prop:string, localID:string[], onRoot:boolean}>}
 */
export function findInstanceOverrides(arr) {
  if (!Array.isArray(arr)) return [];
  const at = (ref) => refAt(arr, ref);
  // PrefabInstance index → { host node name/index, its PrefabInfo.fileId, source prefab uuid }
  const hostByInstance = new Map();
  arr.forEach((n, j) => {
    if (!n || !isNodeType(n.__type__) || !n._prefab) return;
    const pi = at(n._prefab);
    if (pi && pi.__type__ === 'cc.PrefabInfo' && pi.instance && typeof pi.instance.__id__ === 'number') {
      hostByInstance.set(pi.instance.__id__, { name: n._name || `#${j}`, index: j, fileId: pi.fileId, sourceUuid: (pi.asset && pi.asset.__uuid__) || null });
    }
  });
  const out = [];
  arr.forEach((o, i) => {
    if (!o || o.__type__ !== 'cc.PrefabInstance') return;
    const host = hostByInstance.get(i) || { name: `#${i}`, index: null, fileId: null, sourceUuid: null };
    for (const ref of o.propertyOverrides || []) {
      const ov = at(ref);
      if (!ov || ov.__type__ !== 'CCPropertyOverrideInfo') continue;
      const ti = at(ov.targetInfo);
      const localID = ti && Array.isArray(ti.localID) ? ti.localID : [];
      const onRoot = localID.length === 1 && host.fileId != null && localID[0] === host.fileId;
      out.push({ instance: host.name, instancePath: host.index != null ? nodePathOf(arr, host.index) : `#${i}`, sourceUuid: host.sourceUuid, prop: (ov.propertyPath || []).join('.'), localID, onRoot });
    }
  });
  return out;
}

/**
 * Find leaked editor-preview Canvas nodes. A node named `should_hide_in_hierarchy`
 * (or `…_should_hide_in_hierarchy`) is the hidden Canvas+Camera the editor injects
 * into the live tree to render a prefab in isolation (prefab edit mode). It is
 * `LockedInEditor` and must NEVER be saved into a file. Returns the offending node
 * names (empty = clean). Drives the `no-editor-preview-leak` rule. See docs/NESTED-PREFABS.md.
 * @param {any[]} arr @returns {string[]}
 */
export function findPreviewCanvasLeaks(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter((o) => o && isNodeType(o.__type__) && typeof o._name === 'string' && o._name.includes('should_hide_in_hierarchy'))
    .map((o) => o._name);
}
