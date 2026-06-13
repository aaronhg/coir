// Extract outgoing references from asset source files / metas.

// Recursively walk a deserialized prefab/scene/anim/mtl JSON, reporting every
// `__uuid__` target and every `__type__` token. Cocos 3.x serializes asset
// references as { "__uuid__": "<uuid>" } or { "__uuid__": "<uuid>@<subid>" },
// and custom component classes as { "__type__": "<compressed-uuid>" }.
export function walkJsonRefs(root, onUuid, onType) {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (node == null || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (const v of node) if (v && typeof v === 'object') stack.push(v);
      continue;
    }
    const u = node.__uuid__;
    if (typeof u === 'string' && u) onUuid(u);
    const t = node.__type__;
    if (typeof t === 'string' && t) onType(t);
    for (const k in node) {
      const v = node[k];
      if (v && typeof v === 'object') stack.push(v);
    }
  }
}

// Extract references WITH usage context. For a scene/prefab (a flat array where
// {"__id__":N} === arr[N]) each ref gets a location {nodePath, component,
// property}: the owning component's node path (via node.__id__ then the
// _parent/_name chain), the component __type__, and the property path that led
// to the ref (e.g. "_spriteFrame", "_clips.0"). For anim/material (an object)
// nodePath/component are null.
export function extractContextRefs(json) {
  const uuidRefs = [];
  const typeRefs = [];
  if (Array.isArray(json)) {
    // reverse {__id__} index: who references each entry (first referencer wins).
    const refBy = new Map();
    for (let i = 0; i < json.length; i++) collectIdRefs(json[i], i, refBy);
    const cache = new Map();
    const nodePath = (idx) => {
      if (cache.has(idx)) return cache.get(idx);
      const names = []; let cur = idx, guard = 0; const seen = new Set();
      while (cur != null && json[cur] && guard++ < 500 && !seen.has(cur)) {
        seen.add(cur);
        const o = json[cur];
        if (o._name) names.unshift(o._name); // skip empty/override-blank names
        cur = o._parent && o._parent.__id__ != null ? o._parent.__id__ : null;
      }
      const p = names.join('/');
      cache.set(idx, p);
      return p;
    };
    // The owning node for an entry: a component's `node`, the node itself, or —
    // for entries with no `node` (cc.PrefabInfo, KeyAtlas…) — climb the reverse
    // reference to whatever holds it.
    const hostCache = new Map();
    const hostOf = (idx, depth) => {
      if (hostCache.has(idx)) return hostCache.get(idx);
      const o = json[idx];
      let h = null;
      if (o && o.node && o.node.__id__ != null) h = o.node.__id__;
      else if (o && (o.__type__ === 'cc.Node' || o.__type__ === 'cc.Scene')) h = idx;
      else if ((depth || 0) < 6 && refBy.has(idx)) h = hostOf(refBy.get(idx), (depth || 0) + 1);
      hostCache.set(idx, h);
      return h;
    };
    for (let i = 0; i < json.length; i++) {
      const o = json[i];
      if (!o || typeof o !== 'object') continue;
      const host = hostOf(i, 0);
      const np = host != null ? nodePath(host) : null;
      const comp = typeof o.__type__ === 'string' ? o.__type__ : null;
      walkOwn(o, [],
        (ref, prop) => uuidRefs.push({ ref, loc: { nodePath: np, component: comp, property: prop || null } }),
        (tok, prop) => typeRefs.push({ token: tok, loc: { nodePath: np, component: comp, property: prop || null } }));
      // cc.Button / EventHandler wiring: `_componentId` is the handler script
      // (a compressed uuid, like __type__), `handler` the method name. np here
      // resolves (via the reverse climb) to the button's node.
      if (typeof o._componentId === 'string' && o._componentId) {
        const h = typeof o.handler === 'string' ? o.handler : '';
        typeRefs.push({ token: o._componentId, loc: { nodePath: np, component: null, property: h ? `click → ${h}()` : 'click handler' } });
      }
    }
  } else if (json && typeof json === 'object') {
    walkOwn(json, [],
      (ref, prop) => uuidRefs.push({ ref, loc: { nodePath: null, component: null, property: prop || null } }),
      (tok, prop) => typeRefs.push({ token: tok, loc: { nodePath: null, component: null, property: prop || null } }));
  }
  return { uuidRefs, typeRefs };
}

// Record, for every {__id__:N} found inside `node`, that entry `owner` holds it.
function collectIdRefs(node, owner, refBy) {
  if (node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const v of node) collectIdRefs(v, owner, refBy); return; }
  if (node.__id__ != null) { if (!refBy.has(node.__id__)) refBy.set(node.__id__, owner); return; }
  for (const k in node) { const v = node[k]; if (v && typeof v === 'object') collectIdRefs(v, owner, refBy); }
}

// Walk one array entry's OWN content (do not follow {__id__} to other entries),
// reporting __uuid__ leaves and __type__ tokens with their property path.
function walkOwn(node, path, onUuid, onType) {
  if (node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((v, i) => { if (v && typeof v === 'object') walkOwn(v, path.concat(i), onUuid, onType); });
    return;
  }
  if (typeof node.__uuid__ === 'string' && node.__uuid__) { onUuid(node.__uuid__, path.join('.')); return; }
  if (node.__id__ != null) return; // reference to another array entry — not this object's content
  if (typeof node.__type__ === 'string') onType(node.__type__, path.join('.'));
  for (const k in node) {
    if (k === '__type__') continue;
    const v = node[k];
    if (v && typeof v === 'object') walkOwn(v, path.concat(k), onUuid, onType);
  }
}

const IMPORT_RE = /\bimport\b(?:[^'"]*?\bfrom\b)?\s*['"]([^'"]+)['"]/g;
const REQUIRE_RE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

// Pull relative import/require specifiers out of TypeScript/JavaScript source.
export function extractTsImports(text) {
  const specs = new Set();
  let m;
  while ((m = IMPORT_RE.exec(text))) {
    if (m[1].startsWith('.')) specs.add(m[1]);
  }
  while ((m = REQUIRE_RE.exec(text))) {
    if (m[1].startsWith('.')) specs.add(m[1]);
  }
  return [...specs];
}

// Resolve a relative module specifier (from a .ts file) to a candidate asset
// source path, normalizing "." / ".." segments. Returns the resolved path
// WITHOUT extension; the caller tries ".ts" and "/index.ts".
export function resolveImportPath(fromPath, spec) {
  const dir = fromPath.slice(0, fromPath.lastIndexOf('/'));
  const parts = (dir ? dir.split('/') : []).concat(spec.split('/'));
  const out = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
}
