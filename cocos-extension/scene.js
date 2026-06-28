'use strict';
// coir native-verify — SCENE-process readback (the one primitive that must run
// where the engine + scene graph live). `coirRead` loads a prefab, instantiates
// it in memory, reads back ONLY the requested coir selectors (nodePath /
// nodePath:Type / nodePath:Type.prop), and destroys the instance — so it never
// pollutes the open scene. Values are JSON-sanitized + terse (no 25 KB dumps):
// the reply is exactly the selectors you asked for.
//
// Selector grammar mirrors coir's: "A/B" (node) · "A/B:cc.Sprite" (component
// presence) · "A/B:cc.Sprite._enabled" (a property); [i] disambiguates same-name
// siblings / same-type components. The leading segment may be the prefab root's
// own name (it's consumed if it matches the instantiated root).

exports.methods = {
  // Which scene is open in the editor right now — read straight off the live engine
  // (`cc.director.getScene()`), the same object copse sees at runtime. Returns name +
  // uuid + the root's child node names, so a runtime driver (copse) can identify WHICH
  // coir scene it is driving (match by uuid/name, or confirm by `rootChildren` structure —
  // copse's runtime tree is rooted at these same children). No mutation; safe to poll.
  currentScene() {
    const cc = globalThis.cc;
    if (!cc || !cc.director || !cc.director.getScene) return { error: 'cc.director unavailable in this scene context' };
    const s = cc.director.getScene();
    if (!s) return { error: 'no scene loaded' };
    // Drop editor-only gizmo layers ("Editor Scene Foreground/Background") so `rootChildren`
    // is the AUTHORED roots — comparable to what a runtime driver (copse) sees (which instead
    // carries its own tool node, "PROFILER_NODE"). name/uuid stay the primary identifier.
    const rootChildren = (s.children || []).map((c) => c && c.name).filter((n) => n && !/^Editor Scene /.test(n));
    return { ok: true, name: s.name || '', uuid: s.uuid || s._id || null, rootChildren };
  },
  async coirRead(uuid, selectors) {
    const cc = globalThis.cc;
    if (!cc || !cc.assetManager) return { error: 'cc/assetManager unavailable in this scene context' };
    let prefab;
    try {
      prefab = await new Promise((ok, no) => cc.assetManager.loadAny({ uuid }, (e, a) => (e ? no(e) : ok(a))));
    } catch (e) { return { error: `load failed: ${e && e.message ? e.message : e}` }; }
    let root;
    try { root = cc.instantiate(prefab); } catch (e) { return { error: `instantiate failed: ${e && e.message ? e.message : e}` }; }
    try {
      const values = {};
      for (const sel of selectors || []) values[sel] = readSel(root, sel);
      return { ok: true, values };
    } finally {
      try { root.destroy(); } catch (e) { /* best-effort cleanup */ }
    }
  },
};

function parseSeg(s) {
  const m = /^(.*?)(?:\[(\d+)\])?$/.exec(s) || [];
  return { name: m[1] != null ? m[1] : s, idx: m[2] != null ? Number(m[2]) : null };
}

// Walk a coir nodePath from the instantiated root → the cc.Node (or null).
function walk(root, nodePath) {
  const segs = String(nodePath).split('/').filter(Boolean);
  if (!segs.length) return root;
  let i = 0;
  if (parseSeg(segs[0]).name === root.name) i = 1; // path includes the root's own name
  let node = root;
  for (; i < segs.length; i++) {
    const { name, idx } = parseSeg(segs[i]);
    const matches = (node.children || []).filter((c) => c.name === name);
    node = matches[idx == null ? 0 : idx];
    if (!node) return null;
  }
  return node;
}

function readSel(root, sel) {
  const cc = globalThis.cc;
  const ci = sel.indexOf(':');
  const node = walk(root, ci < 0 ? sel : sel.slice(0, ci));
  if (!node) return { missing: 'node' };
  if (ci < 0) {
    return { name: node.name, active: node.active, pos: safe(node.position), euler: safe(node.eulerAngles), scale: safe(node.scale) };
  }
  // rest = Type[.prop] — but Type itself contains dots (e.g. "cc.SkinnedMeshRenderer"),
  // so we can't split on the first ".". Match `rest` against the node's ACTUAL
  // component class names (cc.js.getClassName), longest wins — mirrors coir's
  // longest-match selector resolution. Then [i] (same-type) + .prop follow.
  const rest = sel.slice(ci + 1);
  const comps = (node.getComponents && node.getComponents(cc.Component)) || [];
  let best = null;
  for (const c of comps) {
    let name; try { name = cc.js.getClassName(c); } catch (e) { name = c.constructor && c.constructor.name; }
    if (name && (rest === name || rest.startsWith(name + '.') || rest.startsWith(name + '['))
        && (!best || name.length > best.name.length)) best = { comp: c, name };
  }
  if (!best) return { missing: 'component', sel: rest };
  let comp = best.comp;
  let after = rest.slice(best.name.length);          // '' | '.prop' | '[i]' | '[i].prop'
  const bm = /^\[(\d+)\]/.exec(after);
  if (bm) { const all = node.getComponents(best.name) || []; comp = all[Number(bm[1])] || comp; after = after.slice(bm[0].length); }
  if (!after) return { present: true, type: best.name };
  return { value: safe(deepGet(comp, after.replace(/^\./, ''))) };
}

function deepGet(obj, propPath) {
  const parts = String(propPath).replace(/\[(\d+)\]/g, '.$1').split('.').filter((p) => p !== '');
  let cur = obj;
  for (const k of parts) { if (cur == null) return undefined; cur = cur[k]; }
  return cur;
}

// JSON-safe + terse: scalars pass; asset refs → {uuid}; Vec/Quat → {x,y,z[,w]};
// Color → {r,g,b,a}; arrays → first few sanitized; any other engine object →
// an opaque {<type>} tag (avoids circular JSON, keeps the reply small).
function safe(v, depth = 0) {
  if (v == null || typeof v !== 'object') return v;
  if (typeof v.uuid === 'string') return { uuid: v.uuid };
  if (typeof v._uuid === 'string') return { uuid: v._uuid };
  if ('x' in v && 'y' in v) return v.w !== undefined ? { x: v.x, y: v.y, z: v.z, w: v.w } : { x: v.x, y: v.y, z: v.z };
  if ('r' in v && 'g' in v && 'b' in v) return { r: v.r, g: v.g, b: v.b, a: v.a };
  if (Array.isArray(v)) return depth > 0 ? `[${v.length}]` : v.slice(0, 16).map((x) => safe(x, depth + 1));
  return { '<type>': (v.constructor && v.constructor.name) || 'object' };
}
