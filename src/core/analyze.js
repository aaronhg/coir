// @ts-check
// Reports derived from a scan result.

import { buildAdjacency, dependencyClosure } from './graph.js';
import { mainUuid } from './uuid.js';
import { buildBundleGraph, bundleName, bundleCycleGroups } from './bundleGraph.js';

// Scenes are loaded by name at runtime, so they are roots, never "unused".
// Scripts with no editor reference are flagged separately (they may be entry
// points, autoloaded, or referenced only dynamically). Plugins may add more
// root types via `scan.rootTypes` (see isRootType).
const ROOT_TYPES = new Set(['scene']);
const isRootType = (scan, type) => ROOT_TYPES.has(type) || !!(scan.rootTypes && scan.rootTypes.has(type));

// Unused = a 0-referrer source asset that is NOT in a bundle. Any bundle's assets
// (resources AND custom Asset Bundles) are loaded by path string at runtime, so a
// 0-referrer asset there is a runtime-load *candidate*, not a confirmed orphan —
// it is split into `candidates` (informational), never flagged. This generalizes
// the old resources/-only rule (a2): a prefab loaded dynamically from a custom
// bundle is no longer a false "unused". `main` (= unbundled) is still checked.
export function unusedReport(scan) {
  const items = [];      // flagged: 0-referrer, unbundled (main / no bundle)
  const candidates = []; // 0-referrer but inside a bundle → maybe loaded by path, maybe dead
  for (const a of scan.assets.values()) {
    if (a.virtual) continue; // a plugin's non-asset node is never an "unused file"
    if (isRootType(scan, a.type)) continue;
    if (!a.hasSource) continue;
    if (a.in > 0) continue;
    if (a.bundle && a.bundle !== 'main') { candidates.push({ uuid: a.uuid, path: a.path, type: a.type, size: a.size, bundle: a.bundle }); continue; }
    items.push({ uuid: a.uuid, path: a.path, type: a.type, size: a.size });
  }
  items.sort((x, y) => y.size - x.size);
  candidates.sort((x, y) => y.size - x.size);
  const totalSize = items.reduce((s, i) => s + (i.size || 0), 0);
  const byType = countBy(items, (i) => i.type);
  return { items, totalSize, byType, candidates };
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

// A sprite-frame's packed pixel area (trimmed), from its subMeta userData; 0 when
// the importer didn't record dimensions (then area-level numbers are unavailable).
function frameArea(f) {
  const ud = f.userData || {};
  const w = ud.width ?? (ud.rect && ud.rect.width) ?? ud.rawWidth ?? 0;
  const h = ud.height ?? (ud.rect && ud.rect.height) ?? ud.rawHeight ?? 0;
  return w > 0 && h > 0 ? w * h : 0;
}

// Per-atlas / multi-frame-image utilization: how many sprite-frames are used, AND
// — when the frames' dimensions are known — the area-weighted utilization, since
// a few large unused frames waste far more than many tiny ones. `wastedArea` is the
// summed pixel area of the unused frames (the atlas's real dead weight); `areaRatio`
// is used-area / total-area (null when no frame recorded a size).
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
    let totalArea = 0, usedArea = 0;
    for (const f of frames) { const ar = frameArea(f); totalArea += ar; if (used.has(f.subId)) usedArea += ar; }
    const areaKnown = totalArea > 0;
    items.push({
      uuid: a.uuid,
      path: a.path,
      type: a.type,
      size: a.size,
      total: frames.length,
      used: frames.length - unusedFrames.length,
      ratio: frames.length ? (frames.length - unusedFrames.length) / frames.length : 0,
      totalArea: areaKnown ? totalArea : null,            // px² across all frames (null = dimensions unknown)
      usedArea: areaKnown ? usedArea : null,
      wastedArea: areaKnown ? totalArea - usedArea : null, // px² of unused frames — the real dead weight
      areaRatio: areaKnown ? usedArea / totalArea : null,  // area-weighted utilization (null when unknown)
      unusedFrames,
      referenced: a.in > 0,
      wholeReferenced: wholeRef.has(a.uuid), // frames accessed dynamically by name
    });
  }
  // Surface genuine waste first: referenced-but-low-utilization atlases whose
  // frames are addressed individually (not whole-atlas dynamic access). Tie-break
  // by the absolute wasted AREA so a big atlas with dead frames outranks a tiny one.
  items.sort((x, y) => Number(x.wholeReferenced) - Number(y.wholeReferenced) || x.ratio - y.ratio || (y.wastedArea || 0) - (x.wastedArea || 0));
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

// Cross-bundle DUPLICATION (axis D): assets the build will physically bake into
// more than one bundle, and the bytes that wastes. Cocos places a shared asset in
// the highest-priority bundle among those that need it; a tie at the top tier →
// it is COPIED into each of them (different priorities → the lower ones keep a
// stub, no copy). So an asset is duplicated when ≥2 same-(top-)priority bundles
// reach it. `needers` = bundles whose content closure (members + their out-deps)
// contains the asset. Static approximation of the build's dedup (main/resources
// treated as priority 0); `wasted = size × (copies − 1)`.
export function bundleDuplication(scan) {
  const { nodes } = buildBundleGraph(scan);
  if (!nodes.length) return { items: [], totalWasted: 0 };
  const adj = scan.adjacency || (scan.adjacency = buildAdjacency(scan.edges));
  const prio = new Map((scan.bundles || []).map((b) => [b.name, b.priority || 0]));
  const members = new Map();
  for (const a of scan.assets.values()) {
    if (a.virtual || !a.bundle) continue;
    let m = members.get(a.bundle); if (!m) members.set(a.bundle, (m = [])); m.push(a.uuid);
  }
  const needers = new Map(); // assetUuid -> Set(bundleName) whose content reaches it
  for (const [name, uuids] of members) {
    const seen = new Set(uuids); const stack = [...uuids]; // multi-source out-closure
    while (stack.length) { const u = stack.pop(); for (const n of adj.out.get(u) || []) if (!seen.has(n.to)) { seen.add(n.to); stack.push(n.to); } }
    for (const u of seen) { let s = needers.get(u); if (!s) needers.set(u, (s = new Set())); s.add(name); }
  }
  const items = []; let totalWasted = 0;
  for (const [u, set] of needers) {
    if (set.size < 2) continue;
    const a = scan.assets.get(u);
    if (!a || a.virtual || !a.hasSource) continue;
    let top = -Infinity; for (const n of set) top = Math.max(top, prio.get(n) ?? 0);
    const tier = [...set].filter((n) => (prio.get(n) ?? 0) === top).sort();
    if (tier.length < 2) continue; // unique top → single home + stubs (no physical copy)
    const wasted = (a.size || 0) * (tier.length - 1);
    items.push({ uuid: u, path: a.path, type: a.type, size: a.size || 0, copies: tier.length, bundles: tier, wasted });
    totalWasted += wasted;
  }
  items.sort((x, y) => y.wasted - x.wasted);
  return { items, totalWasted };
}

// Asset Bundle audit: per-bundle size/members/degree + the cross-bundle
// dependency links (each with the contributing asset references) + cycles (pairs
// linked in both directions — a leaky boundary) + duplication (axis D). Pure over
// the parallel bundle graph; empty for a project with no real bundles. `limit`
// caps refs-per-link and the duplication list.
export function bundleReport(scan, { limit = Infinity } = {}) {
  const { nodes, depEdges } = buildBundleGraph(scan);
  const pathOf2 = (u) => { const a = scan.assets.get(u); return a ? a.path : u; };
  const bundles = nodes
    .map((n) => ({ name: n.path, size: n.size, members: n.memberCount, in: n.in, out: n.out }))
    .sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
  const linkSet = new Set(depEdges.map((d) => `${d.from} ${d.to}`));
  const inCycle = (d) => linkSet.has(`${d.to} ${d.from}`);
  const links = depEdges
    .map((d) => ({
      from: bundleName(d.from), to: bundleName(d.to), weight: d.weight, cycle: inCycle(d),
      refsTotal: d.refs.length,
      refs: d.refs.slice(0, limit).map((r) => ({ from: pathOf2(r.from), to: pathOf2(r.to), kind: r.kind })),
    }))
    .sort((a, b) => Number(b.cycle) - Number(a.cycle) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  // Every cycle = a strongly-connected component of size >=2 (catches A<->B AND a
  // longer loop A->B->C->A that the pairwise both-ways check below would miss).
  const cycleGroups = bundleCycleGroups(depEdges);
  // Unordered bundle pairs linked in BOTH directions (a backward-compatible subset).
  const seen = new Set(); const cycles = [];
  for (const d of depEdges) {
    if (!inCycle(d)) continue;
    const pair = [bundleName(d.from), bundleName(d.to)].sort();
    const k = pair.join(' ');
    if (!seen.has(k)) { seen.add(k); cycles.push({ a: pair[0], b: pair[1] }); }
  }
  const dd = bundleDuplication(scan); // axis D: bytes the build copies into ≥2 same-priority bundles
  const dup = { items: dd.items.slice(0, limit), total: dd.items.length, totalWasted: dd.totalWasted };
  return { bundles, links, cycles, cycleGroups, dup, total: bundles.length };
}

export function summary(scan) {
  const byType = {};
  for (const a of scan.assets.values()) byType[a.type] = (byType[a.type] || 0) + 1;
  const edgeKinds = {};
  for (const e of scan.edges) edgeKinds[e.kind] = (edgeKinds[e.kind] || 0) + 1;
  return {
    assets: scan.assets.size,
    edges: scan.edges.length,
    orphanRefs: scan.orphanRefs.length,
    metaErrors: scan.metaErrors.length,
    byType,
    edgeKinds,
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
