// @ts-check
// Reports derived from a scan result.

import { buildAdjacency, dependencyClosure } from './graph.js';
import { mainUuid } from './uuid.js';

// Scenes are loaded by name at runtime, so they are roots, never "unused".
// Scripts with no editor reference are flagged separately (they may be entry
// points, autoloaded, or referenced only dynamically). Plugins may add more
// root types via `scan.rootTypes` (see isRootType).
const ROOT_TYPES = new Set(['scene']);
const isRootType = (scan, type) => ROOT_TYPES.has(type) || !!(scan.rootTypes && scan.rootTypes.has(type));

// Unused = source asset OUTSIDE the resources bundle with zero referrers.
// Per project policy, everything under resources/ is treated as runtime-loaded
// (by path string) and is never flagged.
export function unusedReport(scan) {
  const items = [];
  for (const a of scan.assets.values()) {
    if (a.inResources) continue;
    if (isRootType(scan, a.type)) continue;
    if (a.in > 0) continue;
    if (!a.hasSource) continue;
    items.push({ uuid: a.uuid, path: a.path, type: a.type, size: a.size });
  }
  items.sort((x, y) => y.size - x.size);
  const totalSize = items.reduce((s, i) => s + (i.size || 0), 0);
  const byType = countBy(items, (i) => i.type);
  return { items, totalSize, byType };
}

// Dangling `__uuid__` references. Two flavours: the target uuid is in no .meta
// at all (truly unknown / external), or a stale source-less .meta still names it
// (`scan.missing`) — a deleted file that a prefab/scene still points at. The
// latter is labelled with its known path so the broken reference is actionable.
export function orphanRefReport(scan) {
  const missing = scan.missing || new Map();
  const byRef = new Map();
  for (const { from, ref } of scan.orphanRefs) {
    let g = byRef.get(ref);
    if (!g) byRef.set(ref, (g = { ref, referrers: new Set() }));
    g.referrers.add(from);
  }
  const items = [...byRef.values()].map((g) => {
    const known = missing.get(g.ref) || missing.get(mainUuid(g.ref)) || null;
    return {
      ref: g.ref,
      path: known,                 // intended source path if a stale meta lingers
      missingSource: !!known,      // a deleted file still referenced (vs unknown uuid)
      referrers: [...g.referrers].map((u) => pathOf(scan, u)),
      count: g.referrers.size,
    };
  });
  // missing-source first (fixable broken refs), then by referrer count.
  items.sort((a, b) => Number(b.missingSource) - Number(a.missingSource) || b.count - a.count);
  return { items, total: items.length, missingSourceCount: items.filter((i) => i.missingSource).length };
}

// Audit of dropped source-less metas: a `.meta` whose source file is gone. Each
// is flagged `referenced` if something in the project still points at it (a
// broken dependency to fix) vs nobody (a stray .meta safe to delete too).
export function droppedMetaReport(scan) {
  const refd = scan.missingReferenced || new Set();
  const paths = new Set((scan.missing || new Map()).values()); // dedupe (uuid+subs share a path)
  const items = [...paths]
    .map((p) => ({ path: p, referenced: refd.has(p) }))
    .sort((a, b) => Number(b.referenced) - Number(a.referenced) || a.path.localeCompare(b.path));
  return { items, total: items.length, referencedCount: items.filter((i) => i.referenced).length };
}

// Per-atlas / multi-frame-image utilization: how many sprite-frames are used.
export function atlasUtilizationReport(scan) {
  // Atlases referenced AS A WHOLE (a SpriteAtlas object, no @sub) have their
  // frames picked by name in code at runtime, so per-frame utilization is
  // unknowable — flag rather than report them as 0% used.
  const wholeRef = new Set();
  for (const e of scan.edges) if (e.kind === 'atlas') wholeRef.add(e.to);

  const items = [];
  for (const a of scan.assets.values()) {
    if (a.type !== 'atlas') continue; // only sprite-atlas (.plist) — not multi-frame pngs
    const frames = a.subAssets.filter((s) => s.kind === 'sprite-frame');
    if (frames.length === 0) continue;
    const used = scan.subUsage.get(a.uuid) || new Set();
    const unusedFrames = frames.filter((f) => !used.has(f.subId)).map((f) => f.name);
    items.push({
      uuid: a.uuid,
      path: a.path,
      type: a.type,
      size: a.size,
      total: frames.length,
      used: frames.length - unusedFrames.length,
      ratio: frames.length ? (frames.length - unusedFrames.length) / frames.length : 0,
      unusedFrames,
      referenced: a.in > 0,
      wholeReferenced: wholeRef.has(a.uuid), // frames accessed dynamically by name
    });
  }
  // Surface genuine waste first: referenced-but-low-utilization atlases whose
  // frames are addressed individually (not whole-atlas dynamic access).
  items.sort((x, y) => Number(x.wholeReferenced) - Number(y.wholeReferenced) || x.ratio - y.ratio);
  return { items };
}

// Every asset by size, with per-type totals.
export function sizeReport(scan) {
  const items = [...scan.assets.values()]
    .filter((a) => a.hasSource)
    .map((a) => ({ uuid: a.uuid, path: a.path, type: a.type, size: a.size, inResources: a.inResources }))
    .sort((x, y) => y.size - x.size);
  const byType = {};
  for (const i of items) {
    const t = (byType[i.type] ||= { count: 0, size: 0 });
    t.count++; t.size += i.size || 0;
  }
  const totalSize = items.reduce((s, i) => s + (i.size || 0), 0);
  return { items, byType, totalSize };
}

// Bundle closure for a chosen root (scene/prefab/anything).
export function closureReport(scan, rootUuid) {
  const adj = scan.adjacency || (scan.adjacency = buildAdjacency(scan.edges));
  const set = dependencyClosure(adj, rootUuid);
  const items = [...set].map((u) => {
    const a = scan.assets.get(u);
    return a ? { uuid: u, path: a.path, type: a.type, size: a.size } : { uuid: u, path: '(missing)', type: 'orphan', size: 0 };
  }).sort((x, y) => y.size - x.size);
  const totalSize = items.reduce((s, i) => s + (i.size || 0), 0);
  const byType = countBy(items, (i) => i.type);
  return { root: pathOf(scan, rootUuid), items, totalSize, byType, count: items.length };
}

export function summary(scan) {
  const byType = {};
  for (const a of scan.assets.values()) byType[a.type] = (byType[a.type] || 0) + 1;
  return {
    assets: scan.assets.size,
    edges: scan.edges.length,
    orphanRefs: scan.orphanRefs.length,
    metaErrors: scan.metaErrors.length,
    byType,
  };
}

function countBy(items, key) {
  const m = {};
  for (const i of items) m[key(i)] = (m[key(i)] || 0) + 1;
  return m;
}
function pathOf(scan, uuid) {
  const a = scan.assets.get(uuid);
  return a ? a.path : uuid;
}
