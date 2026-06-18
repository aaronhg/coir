// @ts-check
// Duplicate detection across two axes (both need I/O, so — unlike the pure
// `analyze` sections — these are async and take reader functions):
//
//   files   — byte-identical SOURCE files with different UUIDs (the same png/audio
//             imported twice). size-bucket (free, from the scan) → 32-bit hash of
//             only the size-colliding files → final byte-equality verify (so a
//             hash collision can never produce a false positive). Each group is
//             flagged `mergeable:false` when the members' import settings differ
//             (same bytes, different .meta → merging would change rendering).
//
//   configs — structurally identical CONFIG assets (prefab/material/anim): the
//             JSON is normalized (volatile per-instance `fileId` blanked, keys
//             sorted) → hashed → verified by exact normalized-string equality.
//             Catches editor copy-paste duplicates that byte-hashing misses
//             (each duplicate gets fresh fileIds, so the bytes differ).
//
// Group members carry enough to drive a merge: a suggested `canonical` (keep) and
// the rest as `redundant` — feed straight into `edit --all swap-uuid <r> <canon>`.

// Fast 32-bit FNV-1a (Math.imul) over bytes — only buckets; correctness comes from
// the byte/string verify below, so collisions just cost an extra compare.
export function hashBytes(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
export function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i) & 0xff; h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Split a hash-bucket into sub-groups that are TRULY equal (eq decides), so a hash
// collision never merges two different items. O(k²) within a bucket — fine, the
// buckets are tiny (only same-size-same-hash items reach here).
function splitExact(items, valueOf, eq) {
  const out = [];
  for (const it of items) {
    const v = valueOf(it);
    let g = out.find((grp) => eq(valueOf(grp[0]), v));
    if (g) g.push(it); else out.push([it]);
  }
  return out.filter((g) => g.length >= 2);
}

// Deep structural equality for import-settings (meta userData) comparison.
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a == null || b == null) return a === b;
  if (typeof a !== 'object') return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}

// Pick which member of a duplicate group to keep: most-referenced, else inside
// resources/ (its path is a runtime contract), else the shortest path.
function pickCanonical(members) {
  return [...members].sort((a, b) =>
    (b.in || 0) - (a.in || 0)
    || Number(!!b.inResources) - Number(!!a.inResources)
    || a.path.length - b.path.length
    || a.path.localeCompare(b.path))[0];
}

function makeGroup(scan, assets, key) {
  key = key || assets[0].path.slice(assets[0].path.lastIndexOf('/') + 1); // default: the shared basename
  const size = assets[0].size || 0;
  const members = assets.map((a) => ({ uuid: a.uuid, path: a.path, type: a.type, in: a.in || 0, inResources: !!a.inResources }));
  const canonical = pickCanonical(members);
  const mergeable = assets.every((a) => a.importer === assets[0].importer && deepEqual(a.userData || null, assets[0].userData || null));
  const spansResources = members.some((m) => m.inResources) && members.some((m) => !m.inResources);
  const warnings = [];
  if (!mergeable) warnings.push('import-settings-differ');
  if (spansResources) warnings.push('spans-resources');
  return {
    key,
    size,
    count: members.length,
    reclaimable: size * (members.length - 1),
    mergeable,
    warnings,
    canonical: canonical.uuid,
    members,
    redundant: members.filter((m) => m.uuid !== canonical.uuid).map((m) => m.uuid),
  };
}

/**
 * Byte-identical source files (axis A). `readBytes(path) → Uint8Array`.
 * @param {any} scan
 * @param {(p: string) => Promise<Uint8Array>} readBytes
 * @param {{types?: Set<string>}} [opts]
 */
export async function findFileDuplicates(scan, readBytes, { types } = {}) {
  const cand = [...scan.assets.values()].filter((a) =>
    a.hasSource && !a.virtual && (a.size || 0) > 0 && (!types || !types.size || types.has(a.type)));
  const bySize = new Map();
  for (const a of cand) { let g = bySize.get(a.size); if (!g) bySize.set(a.size, (g = [])); g.push(a); }

  const groups = [];
  for (const bucket of bySize.values()) {
    if (bucket.length < 2) continue; // unique size → can't be a byte-duplicate
    const withBytes = [];
    for (const a of bucket) { try { withBytes.push({ a, b: await readBytes(a.path) }); } catch { /* unreadable → skip */ } }
    const byHash = new Map();
    for (const x of withBytes) { const h = hashBytes(x.b); let g = byHash.get(h); if (!g) byHash.set(h, (g = [])); g.push(x); }
    for (const hb of byHash.values()) {
      if (hb.length < 2) continue;
      for (const exact of splitExact(hb, (x) => x.b, bytesEqual)) {
        groups.push(makeGroup(scan, exact.map((x) => x.a)));
      }
    }
  }
  groups.sort((x, y) => y.reclaimable - x.reclaimable || y.count - x.count);
  return groups;
}

// Config types whose JSON is worth a structural compare (text-only). Scenes are
// excluded — they are unique roots, not "duplicated".
const CONFIG_TYPES = new Set(['prefab', 'material', 'anim', 'particle']);

// Blank volatile per-instance ids (a fresh duplicate gets new fileIds) and
// stable-stringify with sorted keys, so two copy-pasted configs normalize equal.
function normalizeConfig(text) {
  let j;
  try { j = JSON.parse(text); } catch { return null; }
  strip(j);
  return stableStringify(j);
}
function strip(node) {
  if (Array.isArray(node)) { for (const v of node) strip(v); return; }
  if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) {
      if (k === 'fileId') node[k] = '';
      else strip(node[k]);
    }
  }
}
function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

/**
 * Structurally identical config assets (axis B). `readText(path) → string`.
 * @param {any} scan
 * @param {(p: string) => Promise<string>} readText
 * @param {{types?: Set<string>}} [opts]
 */
export async function findConfigDuplicates(scan, readText, { types } = {}) {
  const want = (types && types.size) ? new Set([...types].filter((t) => CONFIG_TYPES.has(t))) : CONFIG_TYPES;
  const cand = [...scan.assets.values()].filter((a) => a.hasSource && !a.virtual && want.has(a.type));

  const byHash = new Map(); // `${type}:${hash}` -> [{a, norm}]
  for (const a of cand) {
    let text; try { text = await readText(a.path); } catch { continue; }
    const norm = normalizeConfig(text);
    if (norm == null) continue;
    const key = `${a.type}:${hashString(norm)}`;
    let g = byHash.get(key); if (!g) byHash.set(key, (g = [])); g.push({ a, norm });
  }

  const groups = [];
  for (const hb of byHash.values()) {
    if (hb.length < 2) continue;
    for (const exact of splitExact(hb, (x) => x.norm, (p, q) => p === q)) {
      groups.push(makeGroup(scan, exact.map((x) => x.a), exact[0].a.type));
    }
  }
  groups.sort((x, y) => y.count - x.count || y.reclaimable - x.reclaimable);
  return groups;
}

/**
 * Both axes (or one). `readers = { readBytes?, readText }`. Returns
 * `{ files?, configs? }` plus a small summary. Files needs `readBytes` (a
 * binary-capable FileProvider) — absent → that axis is skipped.
 * @param {any} scan
 * @param {{readBytes?: (p:string)=>Promise<Uint8Array>, readText:(p:string)=>Promise<string>}} readers
 * @param {{section?: 'files'|'configs', types?: Set<string>}} [opts]
 */
export async function duplicatesData(scan, readers, { section, types } = {}) {
  const out = {};
  if ((!section || section === 'files') && readers.readBytes) out.files = await findFileDuplicates(scan, readers.readBytes, { types });
  if (!section || section === 'configs') out.configs = await findConfigDuplicates(scan, readers.readText, { types });
  const sum = (g) => (g || []).reduce((s, x) => s + x.reclaimable, 0);
  out.summary = {
    fileGroups: out.files ? out.files.length : 0,
    configGroups: out.configs ? out.configs.length : 0,
    reclaimable: sum(out.files) + sum(out.configs),
  };
  return out;
}
