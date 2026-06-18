# Development History — Cocos Asset Dependency Topology Tool

This document records the development history of **Coir** (working name `assets-graph` during development): how the requirements evolved, what technical decisions were made, what pitfalls we hit, and where the design eventually landed.

---

## 0. The Goal in One Sentence

Load a **Cocos Creator 3.8.x** project and, entirely in the browser, build out a view of **asset usage** and **dependency topology** covering images, atlases (TexturePacker plist / Spine), bitmap fonts, prefabs, scenes, and component scripts. Real cases are validated against local Cocos projects (not committed to the repo).

---

## 1. Research and Scoping

### 1.1 Survey First, Then Build
We started by using real projects (local Cocos projects) to nail down the format rather than relying on memory. Key findings:

- A fair number of the older projects on hand are **2.4.6** (`.fire` scenes, old meta), but the actual target is **3.8.6** (later also compatible with 3.5.2). The local machine happened to have several **3.8.x** samples (some `project.json` files say 3.8.5, which is format-identical to 3.8.6).
- **The 2.x and 3.x formats differ substantially**, so everything had to be re-validated against 3.x.

### 1.2 Key 3.x Format Facts (validated against a 3.8.x sample)
- png `.meta` importer `image`; sub-assets use short ids → `uuid@6c48a` (texture), `uuid@f9941` (spriteFrame).
- plist `.meta` importer `sprite-atlas`; each frame is `uuid@<id>`, and `userData.imageUuidOrDatabaseUri` links back to the source image.
- fnt `.meta` importer `bitmap-font`, with `userData.textureUuid` linking to the png.
- Spine: skeleton `.json` (spine-data) + `.atlas` (importer `*`, can be multi-page) + png.
- The `__uuid__` in prefabs/scenes is a **full uuid** (optionally with `@subid`, never compressed); custom script components appear as a **compressed uuid** in `__type__`.

### 1.3 The Only Unknown: uuid Compression
3.x compresses the script uuid into a 23-char token placed in `__type__`. The user provided `compressUuid`/`decompressUuid` (a reference implementation of the Cocos v2.0.10 algorithm). **End-to-end validation**: a `__type__` in a scene, once decompressed, maps exactly back to the real `.ts.meta` uuid (matching a component script in the project). Feasibility confirmed.

---

## 2. Architecture Decisions

### 2.1 Decoupling the Core from the Browser
We deliberately built the parsing logic as a **DOM-free `src/core/`** shared by both the browser and Node. The benefit: the hardest part — parsing — can be **validated headless**. `test/node-run.js` uses an `fs` FileProvider to run the same core against real projects.

```
src/core/   uuid / meta / refs / scan / graph / analyze   ← pure logic, no DOM
src/browser/ fsapi (File System Access) / ui              ← interface
src/node/   fsProvider                                    ← Node-side FileProvider
test/node-run.js                                          ← headless validator
```

The `FileProvider` interface: `listFiles() / readText(path) / size(path)`, with paths relative to `assets/`.

### 2.2 The Parsing Model
- Scan every `.meta` → a uuid index (including `uuid@sub` sub-assets).
- Walk the JSON of prefabs/scenes/anims/mtls to find `__uuid__` (asset edges) and `__type__` (compressed script uuids).
- Derive atlas→png, font→png, and the Spine triple from meta.
- Deduplicate edges by `(from, to, kind)`.

---

## 3. Tech-Stack Evolution (CDN → esbuild → webpack; cytoscape arrives and departs)

| Stage | Approach | Why it changed |
|---|---|---|
| 1 | Graph visualization via **cytoscape + fcose (CDN)** | Quick to get started |
| 2 | User wanted **offline/bundled** → switched to npm install + **esbuild** bundle | Drop the CDN dependency |
| 3 | User wanted **webpack + dev server** | Hot reload during development |
| 4 | User said "drop the graph feature" → **removed the whole cytoscape/fcose family** | Switched to a pure-DOM tree, bundle 565KB→~20KB |

The lesson: third-party runtime libraries were ultimately **all removed**, and the UI became pure DOM. webpack is kept (`webpack.config.cjs`, CommonJS because the package is type:module).

---

## 4. The Many Big Reworks of the Visualization

This is the part that iterated the most, evolving along with user feedback:

1. **Force-directed graph (cytoscape)**: any node can be the center, single-click to expand, double-click to set as center, expand/collapse one level.
2. → **Finder-style columns (Miller columns)**: a single path, drilling right column by column.
3. → **Tree × columns**: one column per level, multiple branches on the same level can be expanded simultaneously, and a child aligns to the row of its parent (the first-child-shares-row algorithm, unit-tested against an ASCII diagram the user drew).
4. → **Fixed 5-column sliding window**: always 5 columns, centered on the selected item's "offset from center", sliding accordingly (`dependent2|dependent1|layer0|dependency1|dependency2` → slide right → `dependent1|layer0|dependency1|dependency2|dependency3`).
5. → **Bidirectional, fully expanded, 5 equal-width columns filling the space**: dependents fan left, dependencies fan right, layer 0 centered; no more collapsing (everything in the window is expanded, with cycle guards); column width `1fr` to fill; the selected item centered both horizontally and vertically (sticky header + `padding-block:45vh` + scrollIntoView center).
6. → **Left/right keys go spatial**: move to the adjacent column and select "the item nearest the vertical center of the viewport".

The final form: **three banner tabs (List / Topology / Reports)**, with Topology being the bidirectional tree described above.

---

## 5. Pitfalls in Core Parsing (and Their Fixes)

| Pitfall | Symptom | Fix |
|---|---|---|
| Directory metas | `importer:"directory"` was treated as a node | Skip `importer==='directory'` during scanning (validated across 10 projects: 0 directory nodes) |
| Spine multi-page atlas | `spine_bg2..40.png` was wrongly flagged as unused | Parse the `.atlas` text to get all page pngs (basename matching would miss some) |
| Whole-atlas dynamic use | All atlases showed 0% utilization | Distinguish "whole atlas used dynamically as a SpriteAtlas (cannot be statically determined)" vs. individual frame references |
| **Component detection misfire** | `Utils.ts` was treated as a component | The `extends Component` regex misfired on the **generic constraint** `getCacheObj<T extends Component>`. Changed it to require actual **class inheritance** `class Name<…> extends Component`; at the same time, generic bases/subclasses are now detected correctly |
| Nested prefab node path | The nodePath of `PrefabInfo.asset` was empty | `PrefabInfo`/`KeyAtlas` have no `node` field → use the **reverse `{__id__}` walk upward** to find the node that owns it; also skip empty `_name` |

Component detection ultimately uses three signals: a direct `extends Component`, being referenced by `__type__`, and the **transitive closure over the extends chain (fixpoint)**. Plain util/enum/config modules are removed from the index.

---

## 6. Interactive Features (Added Incrementally)

- **Keyboard navigation** (Topology): `↑↓` within a column, `←→` across columns, `Enter` to set as center. Navigation is derived entirely from the `selectedKey` string to compute parent/child, avoiding the "jump to the first item when the cell can't be found" bug.
- **`/` quick open**: VSCode Ctrl+P style, filtering by filename.
- **`r` restore**: the selected path + direction is saved to `localStorage`; pressing `r` rebuilds and focuses it.
- **Ctrl/Cmd+C**: copy the selected node's name (when there is a text selection, let the browser copy normally).
- **Mac two-finger swipe**: intercept horizontal `wheel`, `preventDefault` to block the "back" gesture, and translate it into ←/→ (plus `overscroll-behavior:none` as a safeguard).

---

## 7. Dependency-Context Expansion ("where it's used, how it's used")

### 7.1 Multi-Agent Feasibility Research First
The user asked us to do a **feasibility study** before implementing (ultracode → multi-agent workflow, run against a real sample project):
- The core key: scenes/prefabs are flat arrays, `{__id__:N}===arr[N]`; while walking `__uuid__` we can also record the **(component, property path)**, and follow the component's `node.__id__` along `_parent/_name` up to the root → the **node path**.
- Quantified: of 239 asset references, ~86% are clean `component.property`, ~14% are hard cases (prefab instance overrides, etc.), and exactly 1 is unsolvable (a dead fileId).

### 7.2 Phase 1 Implementation
- `refs.js extractContextRefs()` captures each edge's `locations:[{nodePath, component, property, subName}]`.
- Empirically: `animation.anim → Canvas/UIRoot/InfoBar/Node · cc.Animation._clips.0`.

### 7.3 Redesigning the popup based on feedback
The user found the "global usage list" too noisy. Changed to:
- **Show only the current relationship in the topology**: the location of the edge between the selected item and its tree parent (the parent is sliced out via `selectedKey`).
- Keep only the **location details** (don't repeat the asset name already visible in the tree); a component's own reference (empty property) shows only the node path.
- **Auto-hide** root/structural edges (e.g. plist→png with no node location).
- Removed the ⓘ button and the `i` key → **it appears automatically on selection**, positioned below the selected cell (flipping above if there isn't room).
- Fixed nested prefabs: a certain `Item.prefab` at `CommonPanel/bottom/node/control/node · cc.PrefabInfo.asset`.

---

## 8. `extends` Replaces `import`

The "show script import edges" toggle was deemed useless → removed the toggle and the import edges (too many, too noisy), replacing them with meaningful **class-inheritance edges**: each component links to its base class (`Widget.ts → WidgetBase.ts`, reusing the `baseName`/`definers` from component detection). On the sample project: import 0, extends 64.

---

## 9. Validation Methodology (Throughout)

- **Headless core validation**: every change to `src/core/` is run against a real sample project via `node test/node-run.js <project>` or a throwaway node script, confirming that parsing, edges, and locations are correct (e.g. validating the three cases the user gave, item by item).
- **Algorithm unit tests**: the tree layout's row/depth is validated against a diagram the user drew; keyboard navigation is validated against simulated sequences to confirm "← returns to the correct parent node".
- **Build/serve**: `node --check`, `npm run build`, checking that every `$('id')` exists in the HTML, and that `webpack serve` returns 200.
- **Cross-project robustness**: scan all 10 of the 3.8.x projects and confirm `metaErrors=0`.

---

## 10. Headless CLI (Dependency Query)

Since the core is DOM-free and runs headless, it was natural to wrap it in a CLI that "can query by name and emit parseable output", letting a person or an agent directly ask "what does asset X depend on / who depends on X" without opening a browser.

### 10.1 Design Exploration (Converging on Feedback)

- **Starting from "dependencies", using png as the example**: we quickly found the query should be **type-agnostic** — for a leaf node (png) the interesting direction is "who uses it" (`in`), for a prefab/scene it's "what it depends on" (`out`), and atlas/spine have content in both directions. Conclusion: the main command `deps` **prints both directions by default**, `uses` = an alias for `deps --in`, with no special-casing by type.
- **Lean output**: use **path as the identifier** (don't print the uuid); `via` = the edge kind; `→` dependency / `←` dependent, `(N×)` weight, `↻` cycle, `⚠` unreferenced, `↯` orphan.
- **Hooking up "where it's used"**: `extractContextRefs` from another session already made each edge carry `locations:[{nodePath, component, property, subName}]`. The CLI's `--where` simply expands it (no recomputation); the compressed `__type__` of custom script components is restored to a script path via `decompressUuid`; meta/spine/font and other derived edges have no location and are marked `(meta-derived)`. This became the **contract** between the CLI and `refs.js`.

### 10.2 Decisions and Rationale

| Decision | Rationale |
|---|---|
| Stateless full scan, no cache (the sample project is ~70ms) | Fast enough, avoids cache-invalidation headaches; revisit with `--fast` (skip size/script file reads) or a resident index for high-frequency queries |
| `--where` reads `edge.locations`, the CLI builds its own `edgeMaps` index over `scan.edges` | `graph.js`'s adjacency deliberately drops `locations`; only `closure` borrows `closureReport`/`buildAdjacency` |
| Target resolution accepts path / basename / uuid / `uuid@sub` | On a name collision, **don't guess** — print candidates (capped at 20) and `exit 2` |
| JSON fixed at 1-hop (unaffected by `--depth`) | Multi-level tree JSON is for later |
| Exit codes `0`/`1`/`2`, stdout=data, stderr=messages | Easy to pipe / for an agent to parse |

`makeFsProvider` was extracted from `test/node-run.js` into `src/node/fsProvider.js`, shared by the CLI and the tests.

### 10.3 Validation

We tested every command against the sample project: `deps`/`uses` in both directions, `closure` (scene → 208 assets / 29.5 MB), `find`; `--where` printed real nodePaths (`Canvas/UIRoot/InfoBar/Node · cc.Animation._clips.0`) and frame names; a custom script `__type__` was restored correctly (the `Boot.ts` on the `Boot` node); `--depth 2` expanded with indentation, revisits marked `↻`; a name collision on `config.json` (44 hits) printed candidates + `exit 2`; the exit codes were all in place.

We then added **automated tests** (`test/cli.test.js`, the built-in `node:test`, zero dependencies): run the real `src/cli.js` in a subprocess against a **synthetic project built in a temp directory** (format-correct `.meta` + prefab/scene JSON, with `__type__` generated via a real `compressUuid`). It depends on no local sample project, so it's reproducible and CI-safe. Coverage: `find`, `deps --json` (out edges / orphan / in edges), `--where` (nodePath · property · frame · compressed `__type__` restoration), the empty `locations` of meta-derived edges, `⚠` restricted to outside `resources/`, `closure` counts, name-collision/not-found `exit 2`, usage/unknown-command `exit 1`, and resolving the target by uuid and `uuid@sub`. `npm test` runs it in one go (the glob `test/*.test.js` won't pick up `test/node-run.js`).

### 10.4 Distribution (without `npm run cli`)

`src/cli.js` got a shebang and `chmod +x`; `package.json` registers the `bin` (`coir`) and sets `files` to `["src","README.md"]`. Because of **zero runtime dependencies**, the package is only ~28KB and works offline.

| Audience | Method |
|---|---|
| Teammates (with the repo) | `npm link` → global `coir`; `npm unlink -g coir` to remove |
| No repo | `npm i -g <git-url>` |
| No install | `npx <git-url> deps <asset> -C <projectDir>` (or omit `-C` inside the project) |
| Public release | `npm publish` → `npm i -g` / `npx` |
| Just want to clone | `node src/cli.js …` or `./src/cli.js …` |

### 10.5 To Do

CLI report commands (`summary`/`unused`/`orphans`/`atlas`/`size`, the functions already exist in `analyze.js`), `--fast` scanning, multi-level tree JSON, an index cache for high-frequency queries, and a single-file self-contained bundle (`dist/cli.cjs`).

---

## 11. Recent Expansions

### 11.1 Global Type-Filter Bar + Topology Pruning (Preserving Intermediate Paths)
The trigger: set some `.fnt` as the center, but having first clicked the `font` badge to find it, both sides of the topology were empty — because its neighbors are png/scene, which were filtered out along with the "list type filter". We first **decoupled filtering from the topology** (type badges only filter the list), confirming the data was actually correct; then, following the user's new idea, we changed it to a better version:

- The type badges were **pulled from the list tab to a global bar under the banner**, shared across all three tabs via a single `selectedTypes`.
- For **List/Reports** = show only that type; for **Topology** = **prune to the branches that "reach that type"**: nodes matching the type plus the intermediate nodes leading to them are kept, dead branches are dropped, and **layer 0 is always kept**. When filtering, we build the **full tree** (cycle-bounded DEEP) so that matching nodes deeper than the 5-column window still keep their connecting path. `neighborsOf` itself does no filtering (it preserves the real structure); pruning is done after the tree is built.

### 11.2 CLI `--type` (Same Pruning)
`src/cli.js` got `--type T[,T2]`: the `deps`/`uses` tree does the same "preserve the intermediate path leading to that type" pruning (refactored into `buildEdgeTree → pruneByType → renderTreeText`, **byte-for-byte identical output when `--type` is absent**, locked down by tests); `closure`/`find`/`--json` filter the flat list.

### 11.3 List Closure Columns + Reports Directory Column + Small Fixes
- The List got two **transitive-closure** columns, `被依賴∑` (`dependentClosure` = blast radius) / `依賴∑` (`dependencyClosure` = bundle size), computed once in `setScan` (~0ms / 500 assets), styled lighter than the direct in/out.
- Each Reports row got a **directory column**; the sticky header was pushed out by "padding on top of the scroll container", leaving a seam through which data rows leaked above the header — removing the top padding on the container fixed it.
- **Atlas utilization is computed only for `type='atlas'`** (sprite-atlas .plist), excluding pure pngs like `decal.png` whose meta carries 2 sprite-frames.

### 11.4 Source-less Metas (Residual Metas of Deleted Assets)
- An asset whose source was deleted, leaving only the `.meta`, is **not indexed** (same treatment as directory metas). Validation after removal: **0 new orphans** — anything that referenced it went through the guarded derived-texture edge and disappeared cleanly.
- We record `scan.missing` (uuid + sub-uuid → path), so anything still referencing it from a prefab/scene via `__uuid__` surfaces as a **named "missing source" orphan** (not a bare uuid); the UI flags it red, the CLI prints the path, and `--json` adds `path/missingSource`.
- Reports got a **collapsible "source-less metas (skipped)" audit section** (`droppedMetaReport`): it lists all of them, marked "still referenced (a broken link to fix) / unreferenced (a leftover that can be deleted)". The accuracy relies on `scan.missingReferenced` — recorded at **every point that resolves an asset** (`resolveUuid` + the atlas/font derived edges + path-based spine via `missingByPath`), so it catches cases that JSON-only inspection would miss, like a live `.atlas` still listing a deleted page.

### 11.5 Major Upgrade to `/` Quick Search
Went from "matching filenames only" to **multi-source fuzzy search**: `buildSearchIndex` flattens three kinds — asset / frame (sprite-frame name) / usage (edge.locations) — and every entry's `target` is a real asset uuid. Matching switched to subsequence fuzzy (`matchScore`: exact > prefix > substring > subsequence), with **VSCode-style highlighting of matched characters** (`fuzzyMatch` returns positions and marks all occurrences, so `prefab` lights up in both the filename and the directory). Scope prefixes `@`frame `#`type `>`usage, and pasting a uuid jumps directly; each entry's right column shows `←被依賴∑ →依賴∑` (0 not drawn); typing scrolls back to the top.

### 11.6 Naming **Coir** + Release
- Naming: `Cocos` is itself a genus of coconut palm, and with the dependency-tree⇄coconut-tree pun → "Coir (coconut husk fiber)". Updated `package.json`/`bin` (`cag`→`coir`)/`localStorage`/`<title>`/docs; renamed the directory `assets-graph`→`coir` (gave the user a `rename-to-coir.sh` that also moves the `.claude` memory).
- **Stale `dist/*.LICENSE.txt`**: webpack didn't clean `dist/`, leaving the old cytoscape/fcose bezier/spring license banners — contradicting "no third-party dependencies" → deleted them and added `output.clean:true`; production turns off sourcemaps, and `publicPath:'auto'` makes it gh-pages friendly.
- GitHub Pages: `index.html` + the committed `dist/app.bundle.js` go live directly from `main`/root (added `.nojekyll`, the MIT `LICENSE`), and the README has a Live Demo badge.

### 11.7 Internationalization + First-Run UX
- **i18n** (Traditional Chinese + English, zero dependencies): all visible strings are centralized in `src/browser/i18n.js` (`MESSAGES` + `t(key,vars)` with `{var}` interpolation), and static HTML uses `data-i18n` / `data-i18n-html` / `data-i18n-ph` / `data-i18n-title` (the Chinese kept as the fallback). The banner dropdown switches → `relocalize()` rescans + re-renders; auto-detects `navigator.language`. `src/core/` has zero strings; **the CLI is fixed English**, centralized in the `USAGE` + `M` object (one test assertion changed to `(missing source)`).
- **First-run card**: a floating card in the center on entry (a pick button + intro), with a full-screen mask; only the language selector / `?` / GitHub are raised above the mask (z-index 48) and clickable.
- **Help modal** (`?`, z-index 55): tabs / topology / search / shortcuts, with a GitHub link at the bottom; the 🥥 favicon (emoji SVG) and the banner GitHub icon.
- The topology column headers changed to symbols `←層N`/`→層N` + layer-0 tinting (to avoid clashing in meaning with the palette's `←count`); the usage popup got a copy button in its top-right corner.

### 11.8 Pluginization (Types + Edges Are Extensible)
Motivation: make it easy for others to add new asset types and new edges without touching the `scan.js` core. The previously inline meta-derived edges (the atlas/font/particle/spine triple) were extracted into **one-type-per-file** plugins under `src/core/plugins/` (each file carries that type's `importerTypes`/`typeByExt`, `edges(ctx)`, and `colors`), with `index.js` exporting `BUILTIN_PLUGINS` / `PLUGINS` (the built-ins are the full set; external plugins are composed by the caller).

- **Interface**: a plugin is a plain object `{ name, importerTypes?, typeByExt?, jsonSourceExts?, rootTypes?, colors?, messages?, edges(ctx)? }`; `edges` **uses only `ctx`** (the index + `addEdge`/`resolveUuid`/`readText`/`mapLimit`/`uuid.*`/the read-only `scripts`) and imports nothing → a third-party plugin has zero build step.
- **Wiring**: `scanProject(fp,{plugins=PLUGINS})` defaults to the registry, so **the CLI / node-run / browser all get the same set**; `meta.js` switched to `buildTypeResolver(plugins)` + `knownTypes(plugins)` (removing the static `KNOWN_TYPES`/`normalizeType`, with the baseline `IMPORTER_TYPE` no longer including atlas/font/particle/spine — those moved back into their respective plugins); `analyze.js`'s root types union `scan.rootTypes`; `ui.js` merges plugin `colors` into `TYPE_COLOR` and `messages` into the i18n catalog via the new `registerMessages` (both before `setScan`'s first render).
- **Registration paths** (precedence: built-in → global → project → `--plugin`): built-in → add a file to `index.js`; **out-of-repo** (CLI/node, `src/node/loadPlugins.js`) → `coir.plugins.mjs` auto-loads (coir root = cross-project global, the scanned project's root = that project) plus `--plugin <file>`, all gitignored and out of the repo; rebuild-free (browser) → `window.coir.use(plugin)` (a userscript can persist across projects). `local.js` retired (it overlapped with the repo-root `coir.plugins.mjs`, which is cleaner: outside `src/`, rebuild-free).
- **Deliberately kept in core**: the JSON `__uuid__`/`__type__` engine (3a–3c) and component pruning + `extends` (3b/3e) are too tightly coupled to pluginize, but a plugin can read them via `ctx.scripts` (read-only).
- **Validation**: the existing 18 tests pass byte-for-byte (the atlas/script/prefab/scene paths are byte-identical), `npm run build` passes, and a synthetic project additionally confirms that the relocated font/particle/spine edges (including multi-page atlas→page texture) are all produced.

### 11.9 Typing (JSDoc + `.d.ts`, not converting to `.ts`)
We evaluated a full TS conversion, but it would collide with two of this project's bottom lines (zero runtime dependencies, and "clone and `node src/cli.js` runs directly"). We took a middle road instead: **keep the files as `.js`, with types via JSDoc + a single hand-written `types/index.d.ts`**, adding only the two **devDeps** `typescript`/`@types/node` (runtime stays dependency-free).

- **Types**: `types/index.d.ts` declares the data model (`Asset`/`SubAsset`/`Edge`/`EdgeLocation`/`ScanResult`/`Adjacency`) and the **plugin contract** (`Plugin`/`PluginContext`), shipped with the package via `package.json` `"types"` — a plugin author gets autocomplete and checking for `ctx.addEdge`/`ctx.assets` with a single `/** @type {import('coir').Plugin} */`.
- **Configuration**: `tsconfig.json` `allowJs` + `checkJs:false` + `strict:false` + `noEmit`; checking is **opt-in per file** via `// @ts-check`, currently covering every non-browser file (`src/core/**`, `src/node/**`); the DOM-heavy `src/browser/**` is deliberately unchecked (low return on investment). `npm run typecheck` = `tsc --noEmit`.
- **What doesn't change**: no `.ts`, no loader, no build step — `node src/cli.js`, `node --test`, and webpack all stay as they were; JSDoc vanishes after compilation and runtime is unaffected.
- **Validation**: `typecheck` 0 errors (and by injecting a `ctx.addEge` typo we confirmed `// @ts-check` really takes effect and the contract types really catch it); `npm test` 18/18, `npm run build` bundle unchanged, the CLI runs unchanged. To tighten later, flip `checkJs:true`/`strict:true` and annotate the browser files.

### 11.10 Out-of-Repo Plugin Loading + Topology Navigation Enhancements
**External plugin loading** (letting project-specific rules live outside coir): a `coir.plugins.mjs` config auto-loads from the **coir root** (global / cross-project) and the **scanned project's root** (that project), plus `--plugin <file>` (CLI) and `window.coir.use()` (browser runtime). CLI/node go through `src/node/loadPlugins.js`; **the browser** added `loadGlobalPlugins` (a `webpackIgnore` dynamic import of the one the dev server serves) + `loadProjectPlugins` (reads the one in the selected project via the File System Access handle, blob-URL imported, re-read per project pick). The four sources are converged by `dedupePlugins` (general→specific, a later same-name plugin overriding), and after opening a project the status line lists the active non-built-in plugins tagged `source.name` (`global`/`project`/`use`).

**Topology/List navigation** (a string of keyboard/mouse refinements): in Topology, `−`/`+` for undo/redo (the centre+selection history of `navHistory`/`navForward`), `Delete` to return to List, each cell shows a copy-full-path button on hover, same-name sibling rows auto-append "the shortest distinguishing directory" (`distinguishingDirs`); in List, `↑↓` for the keyboard cursor, single-click to select, double-click/`Enter` to set as center, and switching back to List scrolls to the selected/center row and flashes it; the type filter + search string persist to `localStorage` (`coir.filter`, intersected with the project's actual types on restore). `Tab` cycles the three tabs, `Esc` clears the filter, `Ctrl/⌘+P` = quick search, `Ctrl/⌘+R` = pick directory.

**Fixed by one round of code review**: `−`/`+` got a modifier guard (don't intercept `Cmd/Ctrl±` zoom), the CLI `--plugin` got a `!startsWith('-')` guard (don't swallow a following flag), and `Esc` got a typing check (don't clear the filter mid-typing).

### 11.11 Topology / Quick-Search Virtualization + In-Topology Find
The topology stutters when there are many items — `renderTopo` used `inWin` to limit only the **columns** (fixed 5), not the **rows**: a texture depended on by hundreds of prefabs spits hundreds of cells into the DOM for that column. Changed to **vertical virtualization** (fixed 30px row height, mathematically exact):

- `topo.js` splits "build tree" from "paint" — `buildSide` runs once per center/selection/filter change and caches into `S.topo`; on scroll, only `paintTopo()` repaints the **rows in the window** (rAF-throttled), a spacer at the bottom holds the total scroll height, and the DOM is always about one screen of cells. Cell clicks switched to **event delegation**; ←→ navigation and centering switched to computing on cell **data** (row) rather than DOM rects (off-screen cells are no longer in the DOM).
- **Adaptive padding**: it was a fixed `padding-block:45vh`, leaving a small graph floating in a large blank. Changed to JS setting `viewport height/2 − row height/2` — every row can scroll to the exact center of the viewport, a short tree is centered without leftover empty scroll area, and `reflowTopo` re-fits on resize.
- `/` quick search got the same virtualization (32px row height, delegation, spacer), and the **100-result cap was lifted** in passing, so every match is reachable by scrolling.
- **In-topology `Ctrl/⌘+F` find**: after virtualization, nodes scrolled off-screen aren't in the DOM and native Ctrl+F can't find them → a custom find searches cell **data** (all cells in the displayed columns, including the center), highlighting matches in **amber**, `Enter`/`⇧Enter` for next/previous, `Esc` to close, **scrolling only vertically to that node** (without changing the center or rebuilding the tree, so the matches don't move). The find bar is a sibling of `#topo`, so `renderTopo`'s innerHTML rewrite won't clear it.

### 11.12 CI build + GitHub Pages Deploy (dist no longer in the repo)
Originally Pages served the entire repo directly from `main`/root, so `dist/app.bundle.js` had to be committed (which incidentally exposed `src/` and `test/` too). Switched to using **GitHub Actions** as the Pages source: `.github/workflows/deploy.yml` runs `npm ci` → typecheck → test → build on push to main, then publishes a **precise** static site (`index.html` + `dist/` + `img/coir-topology.png` + robots/sitemap, **excluding `.md`**). So **`dist/` is now gitignored and `git rm --cached`'d out of the repo** — it's a pure build artifact that CI rebuilds itself each time. At the same time, screenshots moved from `docs/` to `img/` (`docs/` keeps markdown only, no longer `cp`'d together with `.md` on publish, and the 900K README-only editor screenshot is no longer published), with og:image and README links repointed to `img/`.

### 11.13 Topology Presentation Enhancements: Connector Overlay / Selection-Chain Highlight / Top Bar (Filter + Breadcrumb)
The topology flattens a DAG into a tree and originally had **no connectors**; column membership was only hinted by position (the first child shares its parent's row), which gets hard to read once it's deep. Added three things:

- **Parent-child connectors**: `paintTopo` builds an `<svg class="edges">` on the fly from the grid coordinates of the **visible** cells (each parent→child a cubic bezier crossing the column boundary). `.tree` is set `position:relative`, the connectors are `z-index:0` + `pointer-events:none`, and cells are `z-index:1` on top of the lines. Coordinate alignment uses `padTop + row*ROW_H + ROW_H/2` (the same scheme as the cells' actual positions). The lines are **always grey** (per user feedback, to avoid stealing the spotlight).
- **Selection-chain highlight**: when a node is selected, `computeSelPath` walks along `parentKeyOf` to the **ancestor chain (root→selection) + direct children** (`pathSet`/`childSet`), cells get `.onpath`/`.kid` and chain connectors get `.hot`, all in grey tones; the actual "selected/center" stays blue.
- **Top bar `#topobar`** (appears only after a center is chosen): on the left a **filter box** = **actually hide non-matching nodes** (shares the `buildSide` pruning with the type filter: type ∧ path keyword, builds the deep tree `DEEP` when either filter is active, debounced input, clearing or `Esc` restores the full tree); on the right a **breadcrumb** = the whole chain from the selected item to the center, **always ordered "dependent → dependency"** (sorted by the signed `offsetOfKey`, so it never flips regardless of which side the selection is on), each crumb clickable to re-select, with a **copy button** beside it that copies the whole chain as **one full path per line**, and a **link button** (`copyCrumbLink`) that copies a `#topo=` topology-snapshot link for this center (see §11.15). The original `Ctrl/⌘+F` **find** (highlight + jump) was **restored** to a **floating box in the top-right corner** of the tree region — to do this, `#topo` was wrapped in the positioned container `#topowrap`, with the find box a sibling of `#topo` (`renderTopo`'s rewrite of `#topo.innerHTML` won't clear it). The division of labor is clear: **the filter narrows the scope, the find locates within the results**.

### 11.14 Plugin Commands (One Definition for CLI + MCP) + `src/seam/` Cleanup
We opened another plugin dimension: beyond types/edges, a plugin can also contribute **commands** (`commands: [{ name, usage?, description?, inputSchema?, positional?, run(ctx) }]`). Following coir's existing "one logic, two hosts" seam philosophy — `run(ctx)` **returns `{data,text}` / `{error}` and never prints**, the CLI prints text (`-o json` prints data), and one carrying `inputSchema` **is also automatically an MCP tool** returning data; **register once, two interfaces**. `ctx` is consistent across hosts (`env` / `args` (CLI positionals mapped via `positional` into the same shape as MCP JSON) / `scan` / `readText` / `resolveAsset` (the CLI prints candidates + exit 2, MCP throws → a clean tool error) / `edgeMaps` / `uuid.*` / `util`). Built-in commands always win (a colliding name is ignored with a warning); zero runtime dependencies are unchanged (`pluginCommands.js` is a pure registry). Both hosts are tested (`test/plugin-command.test.js` for the CLI, `test/plugin-mcp.test.js` for MCP). **The proof**: `timeline-viewer/coir-plugin` used it to add `coir timeline <prefab>` (also a `timeline` MCP tool), parsing the engine-free TimeLineTool structure of a Cocos prefab — one plugin holds up a substantial headless command without forking coir.

In passing, the headless logic seam was **gathered into `src/seam/`**: `query.js` (reads), `shared.js` (resolve / edgeMaps / helpers), `pluginCommands.js` (command registry). The top level keeps only `cli.js` / `editCli.js` (CLI presentation) + the feature directories (`core` / `browser` / `node` / `edit` / `mcp` / `seam`); the write-side `edit/ops.js` stays co-located with `editPrefab.js`. A pure move: 10 imports updated, all tests green.

### 11.15 URL-Snapshot Viewer + Embedding Outlet + Cocos Extension
To "point at an asset and see its topology directly", embedded into other tools (especially the Cocos editor):

- **URL-snapshot viewer** (`src/core/topohash.js`): compresses an asset's **neighborhood subgraph** into the URL hash `#topo=<blob>` (integer-indexed nodes + interned types/kinds + gzip + base64url; `CompressionStream` / `btoa` exist in both Node and the browser, while old Node (e.g. Cocos 3.5's Electron) has neither, falling back to bare `zlib` + `globalThis.Buffer` (interoperable gzip, equivalent base64) → zero dependencies, shared by both ends). When the browser sees `#topo=` it decodes → paints the topology, **never touching File System Access** → non-Chromium browsers (Firefox/Safari/mobile) can view it too, with only "pick a directory and scan" requiring FSA. `encodeTopo` automatically shrinks the depth from ±5 down to fit `MAX_BLOB_CHARS` (default 256KB, tunable); if even depth 1 overflows, it drops the usage sites and **always returns a link**; boundary nodes are marked `⋯`, usage sites are kept only for the nearest ±2 layers, and an "unloaded" hint is given for outer layers. The round-trip / shrinking / boundary / old-Node fallback are covered by `test/topohash.test.js`.
- **Embedding outlet**: `package.json` added `exports` (`.` → the `src/index.js` barrel), so a host gets `scanProject` / `buildAdjacency` / `encodeTopo` / `decodeTopo` / `makeFsProvider` / `PLUGINS` / `dedupePlugins` / `loadConfigPlugins` / `COIR_ROOT`… with one line `import('coir')` (Node side; the browser still goes through `app.js`).
- **Cocos Creator 3.5–3.8 extension** (`cocos-extension/`, `editor: >=3.5.0`; 3.5 relies on the zlib/Buffer fallback above): **right-click** an asset → a submenu lists **dependencies (→) / dependents (←)**, each jumping to that asset on click (`Editor.Selection.select`), with the top level opening a topology snapshot (`encodeTopo` → `shell.openExternal('…#topo=')`). The extension's main process **runs coir-core in-process** (cached scan, invalidated on asset-db change); the menu must be built synchronously → relying on a graph cache pushed in by main (`request` warm-up + `coir:graph` broadcast updates); en/zh i18n (`Editor.I18n.t`); `install.sh` one-click copies + symlinks coir (no npm link). Pitfall: `onAssetMenu` **can't be async** (the editor doesn't await → the whole menu vanishes), so it switched to synchronous + caching.

### 11.16 Viewer Tabs + Extension Loads Project Plugins + Indented-Tree Menu
A few polish items after §11.15 shipped (none touched the `src/core/` tests, 117 still green):

- **The viewer keeps the List + Topology tabs**: the `#topo=` viewer originally only offered the topology; changed so `body.viewer` only hides **Reports** + the pick-directory button, and `cycleTab` also skips Reports in the viewer, **keeping the List** — the List lists the snapshot's nodes, and clicking a row resets the center (a snapshot has no project-level reports, so Reports stays hidden).
- **The extension loads `coir.plugins.mjs`**: the barrel added the exports `loadConfigPlugins` / `loadPluginFiles` / `COIR_ROOT` (= the repo root, derived from `import.meta.url`); `main.js`'s `getScan` composes `dedupePlugins([...PLUGINS, ...loadConfigPlugins(COIR_ROOT), ...loadConfigPlugins(projectPath)])` like the CLI/browser before feeding `scanProject` — so the extension's right-click also picks up custom edges like audio-call (previously it only ran built-in plugins, so it missed them). **Active plugins are printed as `source.name`** (`global.audio-call` / `project.…`, the same style as the browser status line: non-built-ins after dedupe + a source tag). Node caches imports (the ESM module cache is **process-level**, and reloading the extension won't clear it), so a settings change requires **restarting the editor** to be re-read (hit in §11.17).
- **The right-click menu changed to an indented tree** (`assets-menu.js`): the `L1/L2` text labels → **indentation** (`PAD` = NBSP×4, chosen as NBSP so the editor doesn't collapse it); `treeOf` first BFS-assigns the shortest depth + parent, then walks pre-order → each L2 is nested under its L1; both directions are "L1 flush-left, one step right per deeper level" (`depth-1`); block order `→` first, `←` second; the **per-node cap was removed** (all neighbors are listed).
- **3.5 install validation**: `install.sh` reinstalled into the 3.8 and 3.5.2 test projects, `import('coir')` resolves from each project's `node_modules/coir` symlink back to the repo (15 exports, `COIR_ROOT` correct), and the audio-call edge (a component script → a same-name audio file) is indeed generated under the extension's full path.

### 11.17 anim/skel Plugins + Plugin `assetMenus` (Asset Right-Click to See Animation Duration)

Hooking the external [coir-plugins](https://github.com/aaronhg/coir-plugins) `anim`/`skel` command plugins (reading `.anim` clips, reading the Spine binary `.skel` + a vendored spine 3.8 runtime) into the editor's right-click. Requirement: right-click a `.anim` to see `Coir anim 0.33s`, right-click a `.skel` to list each animation's name/duration.

- **Added an `assetMenus` plugin contribution point** (**independent** of `commands` — initially I hung it on a command, but per feedback split it into a plugin-level field of its own, so a pure asset-menu plugin needn't have a command): `{ ext?, types?, label?, rows(ctx) }`, with `rows(ctx)` computed from the asset itself (`ctx = { asset, scan, projectDir, readText }`). The contract goes into `types/index.d.ts` (`AssetMenu`/`AssetMenuContext`). CLI/MCP ignore it.
- **Extension-side budget + push** (same scheme as the graph, since the menu must be synchronous): `main.js`'s `assetMenuSnapshot()` runs `rows(ctx)` in the background over assets matching `ext`/`type`, `mapLimit(8)` + a **`uuid:mtime` cache** (don't re-parse an unchanged `.skel`), broadcast via `coir:asset-menus` + primed with `all-asset-menus`; `assets-menu.js` renders synchronously by table lookup. **A single row collapses to a flat item** (`Coir anim  0.33s`), **multiple rows stay a submenu** (`Coir skel ▸ idle / 2s · …`) — changed from "always a submenu" per feedback.
- **Two pitfalls hit**: ① After adding it to the global `coir.plugins.mjs` there was no right-click response — `loadConfigPlugins` uses `import(fileURL)` with no cache-bust, and the editor process's **ESM cache** kept using the old settings (the log had `global.resources-sprite` but not `global.anim/skel`); **reloading the extension won't clear the cache, you must fully restart the editor**. ② `install.sh` **copies** the extension into the project (only `node_modules/coir` is a symlink), so changing `main.js`/`assets-menu.js` requires a **reinstall** to take effect. ③ The `.animation` of a glTF/FBX model is a **sub-asset** (`uuid@sub`, not a top-level asset, not `cc.AnimationClip` JSON) → currently unsupported (only hand-authored `.anim`).

### 11.18 Goto Panel

A dockable **`Coir 跳轉`** ("Coir goto") panel (`panels/goto.js`; menu Panels→Coir→Jump to node… or `Ctrl+Alt+G`) connects coir's location strings ⇄ editor selection, **bidirectionally**:

- **Type/paste → select**: ① a **node path** (`nodePath` (+`[i]`)) → walks the **live scene tree** (`scene` `query-node-tree`, no file reads) and selects that node; ② ending in `.ext` (`xxx.prefab`/`ui/foo.png`) → goes through `asset-db` to select the **asset** in the Assets panel (matching basename or path suffix, requiring a more complete path on a collision).
- **Reverse backfill**: selecting a node/asset in the editor → the input auto-fills its coir `nodePath` (with `[i]` disambiguation) / filename — but it won't overwrite while you're typing in the input (`document.activeElement` check).
- **Syntax**: matches what coir prints (`--where`, the browser "where used", the breadcrumb); strips a trailing `:Comp`/`.prop` (the editor has no API to highlight a single component card); a same-name sibling with no `[i]` → resolves to `[0]`; `#N` is unsupported (the live scene has no serialized absolute index). Enter is caught via native `keydown` (`ui-input`'s `confirm` only fires when the value changed → a second Enter previously did nothing).

---

## 12. Final State

- **Form**: pure frontend (HTML+JS, no third-party runtime libraries, ~60KB), the Chrome File System Access API to pick a project directory; webpack-bundled, `npm run dev` hot reload; public on GitHub + GitHub Pages (MIT, auto-built + deployed by **GitHub Actions**, `dist/` not in the repo); the welcome / help page prints a **build stamp** (the commit·date injected by webpack, a dev build marked `dev`).
- **Name**: **Coir** (CLI `coir`). The interface switches between **Traditional Chinese / English**, with a welcome card on first run + `?` help.
- **Three tabs + a global type-filter bar**: List (a sortable asset table = layer 0, with in/out and the `∑` closure columns) / Topology (the bidirectional 5-column sliding-window tree, **vertically virtualized**, grey parent-child connectors, selection-chain highlight, a top bar = filter box (hide non-matching) + breadcrumb (dependent→dependency) + copy the whole chain, a floating `Ctrl/⌘+F` find in the top-right, with the type filter preserving paths) / Reports (unused, orphan references, atlas utilization, size, source-less-meta audit).
- **Dependency model**: images, plist/Spine atlases, fnt, particle, prefab, scene, component, with edges covering sprite-frame/texture/script/extends/prefab/anim/font… and ClickEvent wiring; every edge carries its usage location (node path · component.property · frame). Source-less metas are not indexed but their broken links are still traceable.
- **Headless CLI** (`src/cli.js`, `bin` registered as `coir`, zero runtime dependencies): dependency queries `deps`/`uses`/`closure`/`find`/`info` + a project-level audit `analyze` (stats/unused/orphans/atlas/size, = the node-run.js report) (`--where` prints locations as a selector you can paste back into edit, `--type` does type pruning, `-o json` for structured output) + **in-place editing of prefabs/scenes** `edit` (`tree` (structure discovery) / `get` / `set` / `swap-uuid` / `rename` / `set-parent` / `add` / `rm-*` …; real-delete + index compaction, template-by-example, nested-instance guards, atomic + mtime write guards; design in `docs/EDITING.md`). The read/write logic is extracted into a shared seam (`src/edit/ops.js` + `src/seam/query.js`), with the CLI and the **MCP server** (`coir mcp`, a hand-rolled zero-dependency JSON-RPC/stdio, typed tools: reads unprefixed / writes `edit_*`, namespaced as `coir__<tool>` in a host; see `docs/MCP.md`) sharing one source. **Plugins can further contribute commands** (`coir <name>`, and one carrying `inputSchema` automatically becomes an MCP tool; see §11.14) **and asset right-click menus** (`assetMenus`, independent of commands; see §11.17). The project directory is given via `-C <dir>` or defaults to the current directory. `npm test` runs `test/*.test.js` (synthetic projects, CI-safe, **117 cases**: CLI 98 + MCP 6 + plugin commands 6 + topohash 5 + plugin node / search index 1 each, with dual 3.5.2/3.8.6 cross-version fixtures); `test/node-run.js` runs the full report against real projects as a regression.
- **Embedding / sharing**: the `#topo=<blob>` **URL-snapshot viewer** (a neighborhood subgraph packed into the hash → open the link to see the topology directly, **no File API needed, cross-browser**; `encodeTopo`/`decodeTopo` in `src/core/topohash.js`, auto-shrinking depth to fit 256KB); the `import('coir')` **embedding outlet** (`exports` → `src/index.js`); the **Cocos Creator 3.5–3.8 extension** (`cocos-extension/`: right-click an asset to see layered dependents/dependencies + goto + open a topology snapshot + plugin asset menus (e.g. anim/skel showing animation duration), running coir-core in-process, deployed by `install.sh`).
- **Usage**: the browser version is `npm install && npm run dev` → open `localhost:8080` in Chrome → pick a Cocos project directory; the CLI version is `coir deps <asset>` inside the project (or `-C <project dir>` to point elsewhere; `coir --help` for everything and examples).

> See `README.md` for detailed features and the data model; see `docs/EDITING.md` for the edit design and `docs/SERIALIZATION.md` for the serialization contract; see above in this file and `CLAUDE.md` for development commands and extension methods.
