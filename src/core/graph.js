// @ts-check
// Graph helpers over the scan result: adjacency, neighbour lookup and the
// transitive dependency closure used for "what does this scene/prefab bundle".

export function buildAdjacency(edges) {
  const out = new Map(); // uuid -> [{to, kind, weight}]
  const inc = new Map(); // uuid -> [{from, kind, weight}]
  for (const e of edges) {
    if (!out.has(e.from)) out.set(e.from, []);
    if (!inc.has(e.to)) inc.set(e.to, []);
    out.get(e.from).push({ to: e.to, kind: e.kind, weight: e.weight });
    inc.get(e.to).push({ from: e.from, kind: e.kind, weight: e.weight });
  }
  return { out, inc };
}

export function neighbors(adj, uuid, dir) {
  if (dir === 'out') return adj.out.get(uuid) || [];
  if (dir === 'in') return adj.inc.get(uuid) || [];
  return [...(adj.out.get(uuid) || []).map((n) => ({ ...n, dir: 'out' })),
          ...(adj.inc.get(uuid) || []).map((n) => ({ to: n.from, kind: n.kind, weight: n.weight, dir: 'in' }))];
}

// Transitive set of assets reachable from `root` following out-edges
// (i.e. everything that would be pulled in when `root` is loaded).
export function dependencyClosure(adj, root) {
  const seen = new Set([root]);
  const stack = [root];
  while (stack.length) {
    const u = stack.pop();
    for (const n of adj.out.get(u) || []) {
      if (!seen.has(n.to)) { seen.add(n.to); stack.push(n.to); }
    }
  }
  seen.delete(root);
  return seen;
}

// Transitive set of assets that (directly or indirectly) depend on `target`.
export function dependentClosure(adj, target) {
  const seen = new Set([target]);
  const stack = [target];
  while (stack.length) {
    const u = stack.pop();
    for (const n of adj.inc.get(u) || []) {
      if (!seen.has(n.from)) { seen.add(n.from); stack.push(n.from); }
    }
  }
  seen.delete(target);
  return seen;
}
