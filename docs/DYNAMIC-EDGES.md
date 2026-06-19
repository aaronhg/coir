# Recovering dynamic-load edges (a plugin recipe)

coir's dependency graph is **static**: it follows the `__uuid__` references serialized into prefabs/scenes/materials. It cannot see assets loaded at **runtime by path string** — `resources.load('ui/Coin')`, `bundle.load('Boss')`, `loadDir('audio')`, config-driven loads, etc. Those strings are resolved at runtime, so no static edge exists for them.

coir's built-in compromise is coarse: every asset under a bundle (`resources/` or a custom Asset Bundle) is treated as a runtime-load **root** and is never flagged unused (see the "Unused policy" in `CLAUDE.md`; 0-referrer bundle assets surface as informational *candidates* in `analyze unused`). That's safe but blunt — it can't tell *which* assets are actually loaded, so it can't draw the edges or confidently flag the truly-dead ones.

**coir deliberately bakes in no load heuristics.** Every project's loader conventions differ (`resources.load`, a wrapped `AssetMgr.loadUI('x')`, a config table of paths…), so the right place to recover these edges is a small **per-project plugin** — the asset *edges* are pluggable by design. This page is the recipe.

## The recipe

A ready-to-adapt plugin — **`resources-load`** — lives in the external [coir-plugins](https://github.com/aaronhg/coir-plugins) repo (`resources-load.mjs`), alongside `audio-call` / `resources-sprite` / etc. Load it with `--plugin ./resources-load.mjs`, or re-export it from a `coir.plugins.mjs` at the **coir root** (global) or your **project root** (per-project) — both auto-load (and are gitignored) for the CLI, browser, and the Cocos extension. Tweak its `── configure ──` block (`PATTERNS`/`DECLARED`) for your own loader wrappers.

The core of it:

```js
/** @type {import('coir').Plugin} */
export default {
  name: 'resources-load',
  async edges(ctx) {
    // ext-less source path -> asset, so 'resources/ui/Coin' resolves to Coin.png
    const byNoExt = new Map();
    for (const a of ctx.assets.values())
      if (a.hasSource) byNoExt.set(a.path.replace(/\.[^/.]+$/, ''), a);

    const RE = /\bresources\.(load|loadDir)\s*\(\s*['"`]([^'"`]+)['"`]/g;
    const srcs = ctx.files.filter((f) => /\.ts$/.test(f) && !f.endsWith('.d.ts'));

    await ctx.mapLimit(srcs, 16, async (path) => {
      const text = await ctx.readText(path);
      const asset = ctx.byPath.get(path);                         // component → real node; util → undefined
      const from = asset ? asset.uuid : ctx.addNode({ path: 'dynamic-load', type: 'dynamic' });
      for (const [, kind, rel] of text.matchAll(RE)) {
        const target = byNoExt.get(`resources/${rel}`);           // (loadDir = prefix match instead)
        if (target) ctx.addEdge(from, target.uuid, 'resource-load', null, `resources.${kind}('${rel}')`);
      }
    });
  },
};
```

## The `PluginContext` primitives it uses

Everything needed is already on `ctx` (a plugin imports nothing):

| Primitive | Use |
|---|---|
| `ctx.files` + `ctx.readText(p)` | read **any** `.ts` — including non-component utility loaders, which the core prunes from the *index* but keeps in the *file list* |
| `ctx.assets` (each `a.bundle`) / `ctx.byPath` | resolve a literal path to an asset; find the loader's own script node |
| `ctx.bundles` | bundle descriptors (`{ name, root, priority }`) — resolve a `bundle.load('x')` against `b.root` (pair it with a `loadBundle('name')` literal in the same file) |
| `ctx.addEdge(from, to, kind, loc?, label?)` | wire the recovered edge (kind `resource-load`) |
| `ctx.addNode({ path, type })` | a virtual node to attribute loads made from a pruned utility script |
| `ctx.mapLimit` | bounded-concurrency source reads |

## Two things to know

1. **Utility loaders are not graph nodes.** A `.ts` that isn't a Cocos *component* is pruned from the asset index (so `ctx.byPath.get(utilPath)` is `undefined`). Attribute its loads to a virtual `dynamic-load` node (the recipe does this) so the target still gains a referrer — or add `@cc.Component` to the loader to make it a real node and get precise attribution.
2. **Only string literals resolve.** `load('ui/' + name)` is unresolvable statically. Declare those explicitly (the example's `DECLARED` list) — you control the mapping; coir can't guess it.

## What you gain

- Dynamically-loaded assets gain an **in-edge**, so they stop being false-"unused" and appear in the **topology / closure / blast-radius**.
- The edge carries kind `resource-load` → it's filterable in the topology, searchable via the palette's `~` edge-kind scope, and queryable with `coir deps --kind resource-load`.
- Because it's your plugin, you decide the conventions, the confidence, and which gaps to declare — without forking coir.
