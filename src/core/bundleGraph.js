// @ts-check
// A PARALLEL graph over Asset Bundles, deliberately kept OUT of scan.edges so the
// asset-level reports (unused / closure / size / degrees) stay byte-for-byte pure.
//
// Nodes are synthetic pseudo-assets (type 'bundle', virtual:true, hasSource:false,
// key 'bundle:<name>'). Edges are two kinds:
//   - `contains`    bundle → each of its assets (membership, NOT a reference)
//   - `bundle-dep`  bundle → bundle, aggregated from the cross-bundle asset refs
//
// The browser injects the nodes into the scan index (so every existing
// scan.assets.get lookup — list / topology / status — just works) and builds
// adjacencies from the edge lists; reports skip them because they are virtual.
// Containment is the reason this MUST stay parallel: folding bundle→asset edges
// into scan.edges would give every asset a phantom in-edge from its bundle and
// zero out the unused report.

export const BUNDLE_PREFIX = 'bundle:';
export const bundleKey = (name) => BUNDLE_PREFIX + name;
export const isBundleKey = (k) => typeof k === 'string' && k.startsWith(BUNDLE_PREFIX);
export const bundleName = (key) => (isBundleKey(key) ? key.slice(BUNDLE_PREFIX.length) : key);

/**
 * @param {import('../../types/index.js').ScanResult} scan
 * @returns {{ nodes: any[], containEdges: {from:string,to:string,kind:string,weight:number}[], depEdges: {from:string,to:string,kind:string,weight:number,refs:{from:string,to:string,kind:string,locations:any[]}[]}[] }}
 */
export function buildBundleGraph(scan) {
  // Members per bundle (real assets only — skip virtual plugin/bundle nodes).
  const members = new Map(); // name -> { uuids: string[], size: number }
  for (const a of scan.assets.values()) {
    if (a.virtual || !a.bundle) continue;
    let m = members.get(a.bundle);
    if (!m) members.set(a.bundle, (m = { uuids: [], size: 0 }));
    m.uuids.push(a.uuid);
    m.size += a.size || 0;
  }
  // No real bundles in this project (everything is 'main') → no bundle graph at
  // all, so the asset count / type chips / list are unchanged for unbundled
  // projects. 'main' is only meaningful as a peer once other bundles exist.
  if (![...members.keys()].some((name) => name !== 'main')) return { nodes: [], containEdges: [], depEdges: [] };

  // Aggregate cross-bundle asset references into bundle → bundle edges.
  const dep = new Map(); // "A>B" -> edge
  for (const e of scan.edges) {
    const f = scan.assets.get(e.from), tt = scan.assets.get(e.to);
    if (!f || !tt) continue;
    const bf = f.bundle, bt = tt.bundle;
    if (!bf || !bt || bf === bt) continue; // intra-bundle or a virtual endpoint
    const k = `${bf}>${bt}`;
    let d = dep.get(k);
    if (!d) dep.set(k, (d = { from: bundleKey(bf), to: bundleKey(bt), kind: 'bundle-dep', weight: 0, refs: [] }));
    d.weight += e.weight || 1;
    d.refs.push({ from: e.from, to: e.to, kind: e.kind, locations: e.locations || [] }); // the asset edges behind this bundle→bundle link
  }
  const depEdges = [...dep.values()];

  // Bundle degrees over the dep edges (for the 清單 被依賴/依賴 columns).
  const din = new Map(), dout = new Map();
  for (const d of depEdges) { dout.set(d.from, (dout.get(d.from) || 0) + 1); din.set(d.to, (din.get(d.to) || 0) + 1); }

  const nodes = [];
  const containEdges = [];
  for (const [name, m] of members) {
    const key = bundleKey(name);
    nodes.push({
      uuid: key, path: name, metaPath: '', ext: '', importer: 'bundle', type: 'bundle',
      userData: null, subAssets: [], hasSource: false, size: m.size, inResources: false,
      bundle: null, virtual: true, isBundleNode: true, memberCount: m.uuids.length,
      in: din.get(key) || 0, out: dout.get(key) || 0,
    });
    for (const u of m.uuids) containEdges.push({ from: key, to: u, kind: 'contains', weight: 1 });
  }
  return { nodes, containEdges, depEdges };
}
