# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A pure-frontend tool that loads a **Cocos Creator 3.8.x** project (via Chrome's File System Access API, no backend) and builds an asset-usage + dependency-topology view: images, plist/Spine atlases, bitmap fonts, prefabs, scenes, and component scripts. The parsing core is DOM-free and runs identically in the browser and under Node, so it can be validated headless.

## Commands

```bash
npm install                         # webpack toolchain only (see "No runtime deps" below)
npm run dev                         # webpack-dev-server on http://localhost:8080, hot reload on src/ edits
npm run build                       # production bundle → dist/app.bundle.js
npm test                            # node:test suite (test/*.test.js) — currently the CLI, synthetic fixture
node --test test/cli.test.js        # run one test FILE
node --test --test-name-pattern '<regex>' test/cli.test.js   # run a SINGLE test by name
npm run scan -- <projectDir> [center]   # full headless report (alias for node test/node-run.js)
node test/node-run.js <projectDir> [centerUuidOrPath]

# Headless dependency query (src/cli.js) — single-asset, parse-friendly:
npm run cli -- <projectDir> deps    <asset> [--in|--out] [--depth N] [--type T[,T2]] [--where] [--json] [--limit N]
npm run cli -- <projectDir> uses    <asset>   # = deps --in (who references this asset)
npm run cli -- <projectDir> closure <asset> [--type T] [--list] [--json]   # bundle closure
npm run cli -- <projectDir> find    <query> [--type T]   # resolve name → candidates
```

`src/cli.js` answers "what does X depend on / who depends on X" for one asset. `<asset>` resolves by full path, basename, uuid, or `uuid@sub`; an ambiguous basename prints candidates and exits 2. Data goes to **stdout** (`--json` for structured), so it is safe to pipe/parse. `--where` expands each edge to its usage sites (`edge.locations`: nodePath · component.property · frame); custom-script components (a compressed `__type__`) are decompressed back to the script path. Meta-derived edges (atlas→texture, font→texture, the Spine triple) and `extends` edges have no `locations`. `--type T[,T2]` (mirrors the browser's global type-filter bar) keeps only the chosen asset types: on the `deps`/`uses` **tree** it prunes to branches that *reach* one of those types — matching nodes **plus the intermediate hops leading to them** stay, dead branches drop, the queried root is always kept (build via `buildEdgeTree` → `pruneByType` → `renderTreeText`, leaving unfiltered output byte-identical); on `closure`/`find`/`--json` it just filters the flat list.

The app **must** be served over a secure context (`http://localhost` or https) — the File System Access API is unavailable on `file://` and outside Chromium.

Two complementary test paths:
- `npm test` runs `node --test` over `test/*.test.js`. Currently `test/cli.test.js` covers `src/cli.js` end-to-end (subprocess) against a **synthetic, in-temp-dir fixture** it builds itself (format-valid `.meta` + prefab/scene JSON, with a real `compressUuid`'d `__type__`) — no dependency on any on-disk project, so it is deterministic/CI-safe. Add core unit tests as `test/*.test.js` and they are picked up automatically. (The glob excludes `test/node-run.js`, which is not a `*.test.js` file and would otherwise error on missing argv.)
- `test/node-run.js` is the **headless core validation against real projects**: it runs the real core against an on-disk project and prints summary, edge-kind histogram, unused/orphan/atlas/size reports, and a closure for one center node. Use it to verify any change to `src/core/`. Point it at any local **3.8.x** project (3.8.5 is format-identical to 3.8.6); 2.4.6 `.fire`-format projects will not parse. A healthy scan reports `metaErrors=0` — a nonzero count is a regression.

```bash
node test/node-run.js ../my-cocos-project scene/Main.scene
```

## Architecture

The single most important design fact: parsing is decoupled from the environment through a **`FileProvider`** interface — `listFiles()`, `readText(path)`, `size(path)`, with all paths POSIX-relative to the project's `assets/` root. There are two implementations and the core depends only on the interface:

- `src/core/` — DOM-free, no I/O of its own. Shared by browser and Node.
- `src/browser/fsapi.js` — wraps a File System Access directory handle into a FileProvider (auto-detects whether the user picked the project root or `assets/` directly).
- `src/node/fsProvider.js` — wraps `node:fs` into a FileProvider; shared by `test/node-run.js` (full report) and `src/cli.js` (dependency query).

Note `src/cli.js` reads `edge.locations` for `--where`; the `graph.js` adjacency intentionally drops `locations`, so the CLI indexes `scan.edges` directly for neighbour lookups (and reuses `closureReport`/`buildAdjacency` for the transitive `closure` command).

Entry/data flow: `app.js` (or `node-run.js`) picks a directory → builds a provider → `scanProject(provider)` → attaches `buildAdjacency(edges)` as `scan.adjacency` → hands the scan to `initUI`/the reporter. The scan result object (`{ assets, byPath, edges, subOwner, subUsage, orphanRefs, metaErrors, missing, missingReferenced, files }`, assets keyed by uuid; `missing` = uuid→path of dropped source-less metas, `missingReferenced` = the subset of those paths something still points at) is the contract between core and presentation. The 報告 tab surfaces the dropped metas in a collapsed "缺來源檔的 meta（已略過）" section (`droppedMetaReport`), each flagged 仍被引用 (a broken dependency to fix) vs 無人引用 (a stray meta).

### The scan pipeline (`src/core/scan.js`) — read this first

`scanProject` runs phases in a deliberate order; the ordering is load-bearing:

1. **Parse every `.meta`** (`meta.js`) into asset records keyed by uuid. `importer` → normalized `type` via a lookup table; `subMetas` flatten (recursively) into `subAssets`, each addressable as `uuid@subId`. Directory metas (`importer === 'directory'`) are dropped — they are not assets. **Source-less metas are also dropped**: a `.meta` whose source file is gone (only the stale meta lingers, `!hasSource`) is not indexed, but its `uuid → path` (plus sub-uuids) is remembered in `scan.missing` so a prefab/scene still pointing at it resolves (in 3c) to a *named* missing-source orphan ref rather than a bare uuid.
2. **File sizes** for assets that have a source file.
3. **Collect references RAW, then resolve.** Prefab/scene/anim/mtl JSON is walked once (`walkJsonRefs`) into `rawRefs` (`__uuid__`) and `rawTypes` (`__type__`) **without resolving them yet**. This matters because step 3b mutates the asset index.
   - **3b — component-script pruning** (the subtle part, see below) deletes non-component `.ts` assets from the index.
   - **3c** resolves the raw refs *after* pruning, so edges never point at a script that was just removed.
   - **3d–3g** add the non-JSON edge kinds: atlas→texture (`subAsset.userData.imageUuidOrDatabaseUri`), font→texture (`meta.userData.textureUuid`), particle→texture (`meta.userData.spriteFrameUuid`/`textureUuid`, routed through `resolveUuid` so a missing target is flagged as an orphan), the Spine triple (skeleton `.json` → `.atlas` → page `.png`s, where multi-page PNGs are parsed out of the `.atlas` text, not guessed by basename), and component→base-component `extends` edges (class inheritance, reusing the `baseName`/`definers` maps built during pruning — there is no longer an `import`/`require` edge kind).
4. **Degree bookkeeping** sets each asset's `in`/`out` counts.

### Two non-obvious things that are easy to break

**Component-script filtering.** A `.ts` is kept only if it is a Cocos *component*: it (a) is a class `extends Component`, (b) is referenced as a serialized `__type__`, or (c) transitively extends a component (resolved by fixpoint over the extends chain). The `EXTENDS_COMPONENT` regex deliberately requires **class context** (`\bclass\s+Name(?:<...>)?\s+extends\s+...Component`). Do not loosen it to a bare `extends Component`: a generic *constraint* like `getCacheObj<T extends Component>` in a utility module would then misclassify the util as a component. The `<[^{}]*?>` allowance also lets generic component bases/subclasses be detected. Plain util/enum/config modules must stay out of the topology.

**UUID compression** (`src/core/uuid.js`). Cocos serializes two different forms:
- `__uuid__` asset references are **full** hyphenated UUIDs, optionally `@subId` — never compressed.
- `__type__` script-component references are **compressed** 23-char (or 22-char `min`) tokens using the Cocos v2.0.10 base64 scheme. `decompressUuid` restores them; `looksCompressed` is a heuristic gate (a decompressed value is still verified against the asset index before an edge is created).

### Browser UI (`src/browser/ui.js`)

Pure DOM, one file, no framework. Three banner tabs over one content area: **清單** (sortable asset table — this *is* layer 0; click a row to pick the center), **拓撲** (a bidirectional, always-fully-expanded tree rendered as a **fixed 5-column sliding window** centered on the selected node's signed offset: dependents fan left as negative offsets, dependencies fan right as positive), **報告** (the reports). `selectedKey` is the single source of truth for tree navigation — arrow keys/swipes construct keys rather than toggling an `expanded` set. `/` opens a quick-open palette by filename; `r` restores the path saved in `localStorage` (`coir.sel`). Selecting a tree node auto-shows a "used where" popup (the location(s) of the edge between it and its tree-parent).

A **global type-filter bar** (`#filterbar`) sits under the banner, shared by all three tabs (one `selectedTypes` Set). It filters 清單/報告 rows to the chosen types; on 拓撲 it **prunes to branches that reach a matching type** — matching nodes plus their intermediate ancestors stay, dead branches drop, layer 0 is always kept (`buildSide` builds the full tree when filtering so deep matches keep their connecting path). The 清單 table also carries, beside the direct `被依賴`/`依賴` (in/out) degrees, two transitive-closure columns `被依賴∑`/`依賴∑` (`dependentClosure`/`dependencyClosure` sizes, computed once in `setScan`).

## Scope & conventions

- **3.8.x format only.** 3.5.2 is forward-compatible (tweak `meta.js`/`scan.js` if a field differs). **Not** 2.x — `.fire` scenes and old meta layout are unsupported.
- **One project at a time.**
- **Unused policy:** an asset is "unused" only if it has zero referrers **and** lives outside `resources/`. Everything under `resources/` is assumed to be loaded dynamically by path string at runtime and is never flagged. Scenes are always roots, never unused.
- **Atlas utilization:** scored only for `type === 'atlas'` (sprite-atlas `.plist`) — a multi-frame png (e.g. `decal.png`, whose meta carries 2 sprite-frames) is not an atlas and is excluded. An atlas referenced as a whole `SpriteAtlas` (an edge of kind `atlas`, no `@sub`) has its frames picked by name at runtime, so per-frame usage is unknowable — these are flagged (`wholeReferenced`), not reported as 0%.
- **No third-party runtime deps.** An earlier cytoscape/fcose graph view was removed; the bundle is now pure DOM (~27 KB). `package.json` lists only the webpack toolchain, and the webpack entry pulls in only `src/core` + `src/browser`.
- `webpack.config.cjs` is `.cjs` (not `.js`) because `package.json` is `"type": "module"`.
