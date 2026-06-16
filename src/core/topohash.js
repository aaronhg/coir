// Compact topology snapshot for the URL hash (`#topo=<blob>`): a neighborhood
// subgraph around a center asset, so the browser viewer can render a topology with
// NO File System Access and NO server — the graph slice rides in the URL itself.
// The encoder runs in Node (CLI / a Cocos extension) AND the browser
// (CompressionStream is a Web API present in both); zero runtime deps.
//
// payload v1:
//   { v, t?, d, ty[], k[], n[ [path, tyIdx, bnd?] ], e[ [from, to, kIdx, use|1?] ], c }
//     ty / k   interned type / edge-kind tables; nodes & edges reference them by index
//     n        nodes; array position = node id; bnd=1 → real neighbours were trimmed
//     e        edges; 4th slot = array of [nodePath,comp,prop,sub] (usage detail, only
//              within locDepth) · the number 1 (has usage, omitted) · absent (structural)
//     c        center node id (the node to focus)
import { buildAdjacency } from './graph.js';
import { componentName } from './selector.js';

// URL hash size cap (base64url chars ≈ bytes). Tunable — encodeTopo shrinks the
// neighbourhood depth until the blob fits, trading snapshot breadth for URL size.
export const MAX_BLOB_CHARS = 256 * 1024;

// ---- gzip + base64url (Web APIs; present in the browser and Node 18+) -------
async function streamBytes(readable) {
  const reader = readable.getReader();
  const chunks = []; let total = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); total += value.length; }
  const out = new Uint8Array(total); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
async function gzip(bytes) {
  if (typeof CompressionStream === 'undefined') { // old Node (e.g. Cocos 3.5's Electron) → node:zlib
    const { gzipSync } = await import(/* webpackIgnore: true */ 'node:zlib');
    return new Uint8Array(gzipSync(bytes));
  }
  const cs = new CompressionStream('gzip');
  const w = cs.writable.getWriter(); w.write(bytes); w.close();
  return streamBytes(cs.readable);
}
async function gunzip(bytes) {
  if (typeof DecompressionStream === 'undefined') { // gzip is interoperable, so a zlib- or stream-made blob decodes either way
    const { gunzipSync } = await import(/* webpackIgnore: true */ 'node:zlib');
    return new Uint8Array(gunzipSync(bytes));
  }
  const ds = new DecompressionStream('gzip');
  const w = ds.writable.getWriter(); w.write(bytes); w.close();
  return streamBytes(ds.readable);
}
function toB64url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(str) {
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Asset-typed neighbours of a node (mirrors the topo view: only keys present in
// scan.assets are real graph nodes), deduped across both directions.
function assetNeighbors(scan, adj, key) {
  const s = new Set();
  for (const n of adj.out.get(key) || []) if (scan.assets.has(n.to)) s.add(n.to);
  for (const n of adj.inc.get(key) || []) if (scan.assets.has(n.from)) s.add(n.from);
  return s;
}
// BFS ±depth (both directions) from center → ordered keys (center first) + dist map.
function neighborhood(scan, adj, center, depth) {
  const dist = new Map([[center, 0]]);
  const order = [center];
  let frontier = [center];
  for (let d = 1; d <= depth; d++) {
    const next = [];
    for (const u of frontier) for (const v of assetNeighbors(scan, adj, u)) {
      if (!dist.has(v)) { dist.set(v, d); order.push(v); next.push(v); }
    }
    if (!next.length) break;
    frontier = next;
  }
  return { order, dist };
}

function buildPayload(scan, adj, center, depth, locDepth, title) {
  const { order, dist } = neighborhood(scan, adj, center, depth);
  const inSet = new Set(order);
  const idx = new Map(order.map((k, i) => [k, i]));
  const tyTab = [], tyMap = new Map(), kTab = [], kMap = new Map();
  const intern = (tab, map, v) => { let i = map.get(v); if (i === undefined) { i = tab.length; tab.push(v); map.set(v, i); } return i; };
  const n = order.map((key) => {
    const a = scan.assets.get(key);
    const row = [a ? a.path : key, intern(tyTab, tyMap, a ? a.type : 'orphan')];
    for (const nb of assetNeighbors(scan, adj, key)) if (!inSet.has(nb)) { row.push(1); break; } // boundary
    return row;
  });
  const e = [];
  for (const ed of scan.edges) {
    if (!inSet.has(ed.from) || !inSet.has(ed.to)) continue;
    const row = [idx.get(ed.from), idx.get(ed.to), intern(kTab, kMap, ed.kind)];
    const sites = ed.locations || [];
    if (sites.length) {
      if (locDepth >= 0 && Math.max(dist.get(ed.from), dist.get(ed.to)) <= locDepth) {
        row.push(sites.map((l) => {
          const r = [l.nodePath || '', componentName(scan, l.component) || '', l.property || '', l.subName || ''];
          while (r.length && r[r.length - 1] === '') r.pop();
          return r;
        }));
      } else row.push(1); // has usage detail, omitted (beyond locDepth)
    }
    e.push(row);
  }
  const payload = { v: 1, d: depth, ty: tyTab, k: kTab, n, e, c: idx.get(center) };
  if (title) payload.t = title;
  return payload;
}
async function encodePayload(payload) {
  return toB64url(await gzip(new TextEncoder().encode(JSON.stringify(payload))));
}

// Encode a neighbourhood snapshot around `centerKey`. Shrinks depth maxDepth→1 to
// fit `cap`; if even depth 1 overflows, ships depth 1 WITHOUT usage detail — so it
// ALWAYS returns a link. → { blob, depth, nodes, edges, bytes, droppedLoc, over }.
export async function encodeTopo(scan, centerKey, opts = {}) {
  const maxDepth = opts.maxDepth ?? 5;
  const locDepth = opts.locDepth ?? 2;
  const cap = opts.cap ?? MAX_BLOB_CHARS;
  const adj = scan.adjacency || buildAdjacency(scan.edges);
  if (!scan.assets.has(centerKey)) throw new Error(`center not in scan: ${centerKey}`);
  for (let depth = maxDepth; depth >= 1; depth--) {
    const payload = buildPayload(scan, adj, centerKey, depth, locDepth, opts.title);
    const blob = await encodePayload(payload);
    if (blob.length <= cap) return { blob, depth, nodes: payload.n.length, edges: payload.e.length, bytes: blob.length, droppedLoc: false, over: false };
  }
  const payload = buildPayload(scan, adj, centerKey, 1, -1, opts.title); // last resort: depth 1, no usage detail
  const blob = await encodePayload(payload);
  return { blob, depth: 1, nodes: payload.n.length, edges: payload.e.length, bytes: blob.length, droppedLoc: true, over: blob.length > cap };
}

export async function decodeTopo(blob) {
  return JSON.parse(new TextDecoder().decode(await gunzip(fromB64url(blob))));
}
