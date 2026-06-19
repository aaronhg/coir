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

### 11.19 Asset Bundle Model (`a.bundle`)

The first step of the §12 bundle plan: give every asset a first-class **owning bundle**, so the List / size map / CLI / future CI rules can all speak in bundles instead of re-deriving paths.

- **Harvest** (`scan.js` step 1): directory metas are still dropped as non-assets, but a bundle folder's directory meta is now mined first — `userData.isBundle` → a descriptor `{ name: bundleName || folderName, root: dirPath, priority: userData.priority ?? 1 }` pushed to `bundleDefs`.
- **Assign** (new step 1b): `a.bundle` = the **deepest** bundle `root` that prefixes the asset's path (so a nested bundle wins over its ancestor), else `'main'`. `resources` is always a built-in bundle (added unless a user bundle already claims that root); `main` is the implicit catch-all and is never a prefix match (root `''`). `scan.bundles` is the descriptor list (`main` + `resources` + user bundles).
- **Deliberately additive / zero behaviour change**: `a.inResources` stays **path-based** (`resources` / `resources/…`), so the unused policy and every existing report are byte-for-byte unchanged. `a.bundle` is a new orthogonal field; virtual plugin nodes get `bundle: null`.
- **Consumers wired now**: the 清單 gets a sortable **Bundle** column (`state.js` `COLS` + `list.js` body cell + `i18n` `col.bundle`); CLI `info` prints a `bundle` row and the shared `infoData` (so the MCP `info` tool too) returns `bundle`. The `#topo=` viewer's synthetic scan carries `bundle:null` + `bundles:[]` for shape-consistency (a snapshot has no bundle data).
- **Types**: `types/index.d.ts` adds `Asset.bundle`, a `Bundle` interface, and `ScanResult.bundles`.
- **Validation**: a new `test/bundle.test.js` (in-memory FileProvider) covers custom / nested / resources / main assignment + `scan.bundles` + priority; `test/cli.test.js` asserts the `info` bundle field.

### 11.20 Bundles as First-Class Nodes (the Parallel Bundle Graph)

The follow-up the user asked for: make a bundle a **node you can list and centre**, not just a per-asset field. The design question was "isn't bundle just another type?" — no: **type is what an asset is, bundle is where it lives** (two orthogonal axes), and a bundle relates to other nodes by **containment**, not by reference. So bundles get their own **parallel graph**, deliberately kept out of the asset reference graph.

- **The hard invariant** (`src/core/bundleGraph.js`): bundle nodes + their edges **never enter `scan.edges` and never bump `a.in/a.out`**. Folding `contains` (bundle → asset) edges into the main graph would give every asset a phantom in-edge from its bundle and **zero out the unused report** (nothing would have `in===0`), plus pollute every closure/∑. So `buildBundleGraph(scan)` returns a SEPARATE `{ nodes, containEdges, depEdges }`: synthetic pseudo-assets (`type:'bundle'`, `virtual:true`, `hasSource:false`, key `bundle:<name>`, `size` = Σ member bytes), `contains` edges (bundle → each member), and `bundle-dep` edges (bundle → bundle, aggregated from the cross-bundle asset refs — the seed for axis D).
- **Injection, not pollution**: `ui.js` `setScan` injects the pseudo-nodes into `scan.assets` (so every existing `scan.assets.get` — status / breadcrumb / usage / nodeIndex / palette — just works, and the reports skip them because they're `virtual`/`!hasSource`, already enforced by `unusedReport`/`sizeReport`/`atlasUtilizationReport`). It then builds `S.bundleAdj` (contains + bundle-dep, for topology) and `S.bundleDepAdj` (bundle-only, for the list's ∑ columns). `S.adj` (from `scan.edges`) stays byte-for-byte pure.
- **Topology**: `neighborsOf` merges the bundle adjacency **only when the node is a bundle key** — so centring a bundle shows its **contained assets + dependency bundles**, but an asset never shows its container (no clutter), and drilling from a member re-enters the normal asset graph.
- **List / size map / colours**: bundles appear under a `bundle` type chip (size = bundle weight, in/out = bundle-dep degree, ∑ over the bundle graph); `typeColor.bundle` = amber; the 體積圖 of a bundle centre shows its members (`sizeMapBody` special-cases a bundle scope); `currentTypeCounts` counts a bundle centre's members.
- **Explaining a bundle→bundle link in the UI**: each `bundle-dep` edge carries `refs` (the asset edges behind it); the browser keys them in `S.bundleDepRefs`, and the topology "used where" popup (`usage.js` `showBundleRefs`) lists the exact cross-bundle references when a dependency bundle is selected — so a `folder-001 ↔ main` cycle is traceable to the real prefab/material/texture files without leaving the UI. (Found in the wild on `NewProject_386`: materials lived in `main` while their textures + the soldier prefab lived in `folder-001` → a leaky boundary that shows up as a cycle.)

### 11.21 Bundle Audit Everywhere: `analyze bundles` + a 報告 Sub-Tab

The bundle finding was promoted from a throwaway diagnostic into a first-class audit on all three surfaces, from one pure builder.

- **Core**: `bundleReport(scan, {limit})` in `analyze.js` (over `buildBundleGraph`) — per-bundle `{name,size,members,in,out}`, the cross-bundle `links` (each `{from,to,weight,cycle,refsTotal,refs}`, refs resolved to paths + capped by `limit`), and `cycles` (unordered pairs linked both ways). Empty for an unbundled project.
- **CLI + MCP**: `'bundles'` added to `ANALYZE_SECTIONS`, so it's a section of `coir analyze bundles` (text via `renderBundles` — bundles, then cycles flagged ⚠, then per-link refs) and the MCP `analyze` tool (`{section:'bundles'}` / part of `all`), from the one `analyzeData` dispatch. One logic, two hosts (the existing seam).
- **Browser 報告**: a **跨 bundle 依賴** sub-tab (`reports.js` `bundleSection`, built from `buildBundleGraph(S.scan)` so refs keep their uuids) — a cycle banner up top, then each link as a `<details>` (cycles auto-`open`), every ref a click-to-focus `.ref` row. Only appears when the project has bundles; placed before the source-less-meta tab.
- **Validation**: on the real `NewProject_386`, `coir analyze bundles` reproduces the diagnostic exactly (folder-001 ⇄ main cycle, the mtl↔texture / prefab↔material refs in both directions, plus a `main → grass` link). `test/cli.test.js` (full-report keys now include `bundles`; a `bundles` section assertion) + `test/mcp.test.js` (the `all` keys) updated. Suite **142** green, typecheck clean, build OK. The throwaway `scripts/` diagnostic was deleted (superseded).

### 11.22 Bundle Line, Round Two: Duplication Cost (axis D) · bundle-aware Unused · size-map by-bundle · snapshot bundle field

Four follow-ups on the bundle work (the user picked A1/A2/A3/A5; the `main`-centre depth cap A4 was deferred).

- **A1 — Cross-bundle duplication cost (axis D)** (`bundleDuplication` in `analyze.js`): the bytes the build physically copies. `needers(asset)` = bundles whose content closure (members + their out-deps, one multi-source BFS each) reaches it; Cocos places a shared asset in the **highest-priority** needer, and a **tie at the top tier → a copy into each** (lower priorities keep a stub). So an asset is duplicated when ≥2 same-top-priority bundles reach it; `wasted = size × (copies−1)`. A documented static approximation (main/resources = priority 0). Folded into `bundleReport().dup` (→ CLI `renderBundles` "duplication:" block, MCP, and the 報告 sub-tab's red banner), and surfaced in the **體積圖 as a red `tmdup` outline** on each duplicated cell (`S.bundleDupMap`, computed once in `setScan`). On `NewProject_386` this is 0 — folder-001/main/grass have *different* priorities, so the cross-bundle refs are load-order contracts, not copies (correct, and an honest distinction).
- **A2 — bundle-aware Unused policy**: `unusedReport` now skips **any** bundle (`a.bundle !== 'main'`), not just `resources/`, splitting 0-referrer bundle assets into `candidates` (informational, never flagged) — fixes the false "unused" for a prefab only loaded dynamically from a custom bundle. Surfaced as a muted sub-list in the CLI / 報告 unused section (each tagged with its bundle). On `NewProject_386`: `tree-001.png` [folder-001] + `grass.prefab` [grass] correctly become candidates instead of "unused".
- **A3 — 體積圖 group-by bundle**: a `#smGroup` toggle (`S.sizemapGroup`, shown only when the project has bundles) flips the treemap's outer grouping type ↔ bundle (per-bundle hued backdrop + a region label; inner cells stay type-coloured). Type mode stays byte-identical. A bundle centre forces type grouping.
- **A5 — snapshot carries bundle**: the `#topo=` node tuple grew to `[path, typeIdx, bytes, boundary(0/1), bundleIdx]` + an interned `bd[]` table (another breaking `v:1` change), so the viewer's 清單 Bundle column + size-map by-bundle work off a shared snapshot (the viewer carries the field but does NOT build the bundle graph — a snapshot is a partial neighbourhood).
- **Deferred**: A4 (cap a `main`-centre topology to depth-1 containment so it doesn't expand the whole project). **Explained, not built**: A2's deeper cousin and **C — dynamic-load annotation** (a config/source-scan to shrink the `load(path)` static blind spot — coir's one inherent limitation).
- **Validation**: `test/bundle-graph.test.js` adds two axis-D cases (same-priority → duplicated with the right `wasted`; different-priority → 0); `test/cli.test.js` asserts a bundle asset is a candidate, not flagged. Suite **144** green, typecheck clean, build OK.

### 11.23 Declarative CI Rules — `coir check` (B, phase 1)

The bundle/duplicate/unused analysis was promoted from *reports* into a *gate*: a `coir.rules.json` the CI can fail on. The whole point is **zero new analysis** — it's a thin layer over the builders already shipped.

- **Pure engine** (`src/core/rules.js`): a registry of named **checkers** `(scan, rule, ctx) → violations[]`, driven by `evaluateRules(scan, rules, ctx) → { violations, errors, warns, configErrors }`. Each reads an existing report (`orphanRefReport`/`unusedReport`/`bundleReport`) — no parsing, no printing, no I/O. Phase-1 checkers: `max-meta-errors`, `no-dangling-refs`, `no-orphans` (`type?`), `no-bundle-cycle`, `max-duplication` (`maxBytes`), `no-duplicate-files` (`axis?`). An unknown rule / bad param / thrown checker becomes a `config` violation (never a silent pass).
- **The one I/O input**: `no-duplicate-files` needs file bytes, which the pure engine can't read → the host precomputes `duplicatesData` into `ctx.duplicates` (and only when that rule is configured — `needsDuplicates(rules)`). Engine stays pure.
- **CLI `coir check`** (`cmdCheck`): loads `coir.rules.json` (or `--rules <file>`; accepts `[...]` or `{rules:[...]}`), falls back to a warn-only `DEFAULT_RULES` health set when there's none (useful out of the box, never fails CI without opt-in), prints each violation with an icon, and **exits `1` on any error, `2` on a config error, `0` clean**. `-o json` emits the raw result. Added to `BUILTIN_COMMANDS` (a plugin can't shadow it).
- **Committed, not gitignored**: unlike `coir.plugins.mjs`, `coir.rules.json` is the team's policy → lives in the repo so CI reads it.
- **Validation**: `test/rules.test.js` (pure — cycle/orphan/meta-errors/unknown-rule, the `ctx.duplicates` path, `max-duplication` threshold) + a `test/cli.test.js` exit-code case (default→0, error rule→1, bad rule→2). On real `NewProject_386`: default = 4 dangling-ref warns (exit 0); a rules file with `no-bundle-cycle` correctly flags `folder-001 ⇄ main` (exit 1). Suite **148** green, typecheck clean, build OK.
- **Phases 2–3** (now §11.24): the `forbid-dep` from/to matcher + `no-cross-bundle` + `atlas-min-util`; an MCP `check` tool; plugin-contributed checkers.

### 11.24 CI Rules, Phases 2–3 (general matchers · MCP `check` · plugin checkers)

- **`forbid-dep`** — the dependency-cruiser-style general rule: a `matchAsset(asset, spec)` helper (`type`/`bundle`/`pathStartsWith`/`pathContains`/`basename`, each string-or-array, ANDed; absent spec = any) over `scan.edges`, reporting each offending edge with paste-able `locSelector` locations. Throws (→ a config violation) if neither `from` nor `to` is given.
- **`no-cross-bundle`** (`from`/`to` bundle name(s), omit = any → all cross-bundle links) and **`atlas-min-util`** (`min`, skips whole-/dynamic-referenced atlases) — both thin wrappers over `bundleReport().links` / `atlasUtilizationReport`.
- **Plugin checkers** (phase 3): `Plugin.rules: [{ name, check(scan, rule, ctx) }]` (same pure `→ violations[]` contract); `collectPluginCheckers(plugins)` folds them into an `extra` map that `evaluateRules(scan, rules, ctx, extra)` consults after the built-ins (which win on a name clash). Both hosts pass it — the CLI `cmdCheck(…, plugins)`, and the MCP server via a new `state.plugins`. Contract in `types/index.d.ts` (`RuleChecker`/`RuleViolation`).
- **MCP `check` tool** (phase 3): `{ rules? (inline), rulesPath? }` → the same `evaluateRules` result (no exit code — the agent decides). Inline `rules` is the agent-friendly path; else it reads the file like the CLI.
- **Validation**: `test/rules.test.js` adds phase-2 cases (forbid-dep incl. the neither-matcher config error, no-cross-bundle, a half-used atlas at 50%) + a plugin-checker case; `test/mcp.test.js` drives the `check` tool over JSON-RPC. On real `NewProject_386`: `no-cross-bundle folder-001→main` and `forbid-dep {from:scene, to:{bundle:folder-001}}` both correctly fire (exit 1). Suite **151** green, typecheck clean, build OK.

### 11.25 Dynamic-Load Edges = a Plugin Recipe (C, scoped down)

The dynamic-load blind spot (`resources.load('x')` etc. — runtime path strings static analysis can't follow) was the one feature we **deliberately did NOT build into core**. Per the user's call, recovering these edges is left to a **per-project plugin** — which is exactly what the pluggable-edges design is for, and more correct than baked-in heuristics (every project's loader conventions differ).

- **No new core machinery**: the existing `PluginContext` already suffices — `ctx.files` + `ctx.readText` (read **any** `.ts`, including the non-component utility loaders the core prunes from the index), `ctx.assets`/`ctx.byPath` (resolve a literal path), `ctx.addEdge`/`ctx.addNode`. The only addition was **(b) `ctx.bundles`** (one line — the `scan.bundles` descriptor list), so a plugin can resolve a `bundle.load('x')` against `b.root`.
- **(a) The recipe**: `docs/DYNAMIC-EDGES.md` (the write-up) + the **`resources-load` plugin in the external [coir-plugins](https://github.com/aaronhg/coir-plugins) repo** (its natural home, alongside audio-call/resources-sprite) — scans `.ts` for `resources.load/loadDir('literal')` and `someBundle.load('literal')` (paired with a `loadBundle('name')` in the same file), resolves via an ext-less path index, and adds `resource-load` edges. Util loaders (not graph nodes) attribute their loads to a virtual `dynamic-load` node so the target still gains a referrer; computed paths (`load('ui/'+name)`) are declared explicitly in the plugin's `DECLARED` list.
- **What it buys**: a dynamically-loaded asset gains an in-edge → it stops being a false "unused" and appears in the topology/closure/blast-radius; the edge's `resource-load` kind is filterable / `~`-searchable / `deps --kind`-queryable.
- **Deliberately NOT built**: a built-in dynload scanner, a `coir.dynload.json`, auto-tightening of the unused policy, an unresolved-call report. The blind spot stays the project's responsibility, via its own plugin.
- **Validation**: `test/dynamic-edges.test.js` re-implements the recipe's core inline (so it stays CI-safe — the actual plugin lives in the sibling coir-plugins repo) and runs it end-to-end (a `resources.load`/`loadDir` component → `resource-load` edges + the target's `in` becomes 1) and asserts `ctx.bundles` is exposed. Suite **153** green, typecheck clean, build OK.

### 11.26 In-App Help → Markdown (so it stops going stale)

The `?` help body had drifted (it never mentioned the bundle work) — predictably, because it was one giant escaped-HTML string concatenated across ~15 lines in `i18n.js` (×2 for zh/en), the kind of thing nobody remembers to touch. Moved it to **Markdown source + a tiny renderer**, within the zero-dep invariant.

- **Source**: `src/browser/help/help.{zh-Hant,en}.md` — real Markdown (`### `/`- `/`**bold**`/`` `code` ``/```fenced```/`[links]`), with raw `<kbd>…</kbd>` inline (Markdown passes raw HTML through). Updated with the session's features (清單 Bundle column, 體積圖 group-by + red overlay, 報告 cross-bundle tab, `analyze bundles`/`coir check` in the CLI blurb).
- **Renderer**: `src/browser/md.js` `mdToHtml` — ~45 lines, no dep, output matched to the existing `.help-body` CSS. Code spans are stashed behind a NUL sentinel so a bare number in prose can't be mistaken for a placeholder; fenced/inline code is escaped, other inline text passes raw HTML (trusted, build-time content). Unit-tested (`test/md.test.js`).
- **Wiring**: webpack imports `.md` as a raw string (`{ test: /\.md$/, type: 'asset/source' }` — built-in, no loader); `ui.js` `renderHelp()` renders the current locale into `#helpBody` on open; the two `help.body` catalog strings are gone.
- **The Node-test trap**: a top-level `import x from './x.md'` in `ui.js` made every Node test that transitively imports `ui.js` (e.g. `search.test.js`) throw `ERR_UNKNOWN_FILE_EXTENSION` — Node has no `.md` loader. Fix: a **dynamic `import(/* webpackMode:"eager" */ …md)`** inside `renderHelp` — webpack inlines it (single `dist` file preserved, no extra chunk), but the import isn't evaluated at module-load, so Node only trips it if `renderHelp` is actually called (tests never do). `types/index.d.ts` got an ambient `declare module '*.md'` for tsc.
- **Validation**: `test/md.test.js` (renderer) + the real help md rendered cleanly (h3/b/code/kbd/pre, escaped `<…>` path); build emits one bundle. Suite **155** green, typecheck clean, build OK.

---

## 12. Declarative CI Rules Layer (`coir check`) — SHIPPED (§11.23–§11.24)

> **Status**: fully shipped. Engine + `coir check` + 9 built-in checkers (phase 1 §11.23, phase 2 §11.24), the MCP `check` tool, and plugin-contributed checkers (phase 3 §11.24). The original design note is kept below for reference. Possible future work: a config schema/validation, rule `exclude`/`allow` lists, and a `--fix` for the mechanical ones (e.g. swap-uuid the duplicate groups).

A forward-looking note (the original design). Today `analyze` is **reportive** — it tells you "12 unused assets, 3 duplicate groups, an atlas at 18% utilization" but never **fails**. The plan was to add a thin **declarative gate** on top of the data the scan already computes, so a project can encode its own red lines and have CI turn them red.

Inspiration is **dependency-cruiser**: you don't write a script to query, you **declare the dependency rules** in a config; the tool checks them, prints every violation, and **exits non-zero** so CI breaks.

### Shape (proposed)
- A new top-level command `coir -C <dir> check` (and, since it carries an `inputSchema`, an automatic `check` **MCP tool** — same "one `run`, two hosts" seam as the other commands, §11.14). It could even ship as a **plugin command** rather than a built-in, since the rules engine needs no parsing internals — only the finished `scan` + the existing `analyze`/`duplicates` data.
- Rules live in a gitignored config (a `coir.rules.json`, or a `rules:` export alongside `coir.plugins.mjs`), so policy is per-project and out of the repo, exactly like plugins.
- Each rule has a `name`, a `level` (`error` → non-zero exit / `warn` → printed only), and a predicate over the graph. Output: a list of `{ rule, level, asset, detail, locations? }` (locations as paste-able `nodePath:Comp.prop` selectors, reusing `src/core/selector.js`), text for the CLI and `data` for MCP/`-o json`.

### Example rules
```jsonc
{
  "rules": [
    { "name": "no-dev-in-scene", "level": "error",         // ship-blocker: prod scenes must not pull test assets
      "from": { "type": "scene" }, "to": { "pathStartsWith": ["dev/", "temp/"] }, "forbid": true },
    { "name": "no-orphans",      "level": "error", "forbidUnused": true },              // = analyze unused, as a gate
    { "name": "no-duplicates",   "level": "error", "forbidDuplicates": ["files", "configs"] }, // = duplicates, as a gate
    { "name": "atlas-waste",     "level": "warn",  "atlasUtilizationBelow": 0.5 },      // = analyze atlas, as a gate
    { "name": "no-cross-bundle", "level": "error",                                      // see prerequisite below
      "from": { "bundle": "a" }, "to": { "bundle": "b" }, "forbid": true }
  ]
}
```

### Why it's cheap to build
The hard part is already done. `scan.edges`/`scan.adjacency`, `analyzeData`/`analyzeAll` (unused/orphans/atlas/size), and `duplicatesData` all return structured facts. A rule is just "match these facts against a declared predicate", so the engine is a pure function over existing data — no new parsing, no core changes, zero new runtime deps (a registry like `pluginCommands.js`). Selectors for the violation sites come free from `src/core/selector.js`.

### Prerequisite for the bundle rules: real Asset Bundle awareness
`no-cross-bundle` (and any rule keyed on `bundle`) needs coir to actually **know the bundles**. This lands in two steps:
1. **Bundle model** — ✅ **done (§11.19)**: `a.bundle` + `scan.bundles` exist. What's **still open** here: the bundle-aware *unused policy* (treat every bundle's assets as runtime-load roots, not just `resources/`, so a prefab loaded dynamically from a custom bundle stops being a false "unused"), and the **cross-bundle duplication detector (axis D)** that the priority field feeds.
2. **Then the rules layer** — now that `a.bundle` exists, `from.bundle`/`to.bundle` predicates and the cross-bundle-leak check are straightforward.

### Cross-bundle leak (axis D) — the detector that consumes the bundle model
A **cross-bundle edge** is `from → to` where `bundleOf(from) ≠ bundleOf(to)`. Not all are problems — classify by Cocos's build behaviour (priorities decide where a shared asset physically lands):
- **Duplication (error)** — when the referring bundles' top priority tier has ≥2 bundles, Cocos **copies** `to` into each → redundant bytes + duplicate runtime instances. **Statically sound**: redundant cost = `size(closure(to)) × (copies − 1)`; summed = the project's total bundle bloat → can be drawn into the 體積圖 (the cells duplicated per bundle, tinted). This is `duplicates` **axis D** (build-layer dup), distinct from axes A/B/C (author-layer).
- **Load-order contract (warn)** — when `to`'s bundle is strictly higher priority, it lands there and other bundles keep a stub, but that bundle must be **loaded first**. coir can flag the contract but can't verify load order (it doesn't see `loadBundle` calls) — a hazard list, not a proof.
- **Safe (info)** — `to` in `main` (loaded at startup).

---

## 13. Final State

- **Form**: pure frontend (HTML+JS, no third-party runtime libraries, ~60KB), the Chrome File System Access API to pick a project directory; webpack-bundled, `npm run dev` hot reload; public on GitHub + GitHub Pages (MIT, auto-built + deployed by **GitHub Actions**, `dist/` not in the repo); the welcome / help page prints a **build stamp** (the commit·date injected by webpack, a dev build marked `dev`).
- **Name**: **Coir** (CLI `coir`). The interface switches between **Traditional Chinese / English**, with a welcome card on first run + `?` help.
- **Three tabs + a global type-filter bar**: List (a sortable asset table = layer 0, with in/out and the `∑` closure columns) / Topology (the bidirectional 5-column sliding-window tree, **vertically virtualized**, grey parent-child connectors, selection-chain highlight, a top bar = filter box (hide non-matching) + breadcrumb (dependent→dependency) + copy the whole chain, a floating `Ctrl/⌘+F` find in the top-right, with the type filter preserving paths) / Reports (unused, orphan references, atlas utilization, size, source-less-meta audit).
- **Dependency model**: images, plist/Spine atlases, fnt, particle, prefab, scene, component, with edges covering sprite-frame/texture/script/extends/prefab/anim/font… and ClickEvent wiring; every edge carries its usage location (node path · component.property · frame). Source-less metas are not indexed but their broken links are still traceable.
- **Headless CLI** (`src/cli.js`, `bin` registered as `coir`, zero runtime dependencies): dependency queries `deps`/`uses`/`closure`/`find`/`info` + a project-level audit `analyze` (stats/unused/orphans/atlas/size, = the node-run.js report) (`--where` prints locations as a selector you can paste back into edit, `--type` does type pruning, `-o json` for structured output) + **in-place editing of prefabs/scenes** `edit` (`tree` (structure discovery) / `get` / `set` / `swap-uuid` / `rename` / `set-parent` / `add` / `rm-*` …; real-delete + index compaction, template-by-example, nested-instance guards, atomic + mtime write guards; design in `docs/EDITING.md`). The read/write logic is extracted into a shared seam (`src/edit/ops.js` + `src/seam/query.js`), with the CLI and the **MCP server** (`coir mcp`, a hand-rolled zero-dependency JSON-RPC/stdio, typed tools: reads unprefixed / writes `edit_*`, namespaced as `coir__<tool>` in a host; see `docs/MCP.md`) sharing one source. **Plugins can further contribute commands** (`coir <name>`, and one carrying `inputSchema` automatically becomes an MCP tool; see §11.14) **and asset right-click menus** (`assetMenus`, independent of commands; see §11.17). The project directory is given via `-C <dir>` or defaults to the current directory. `npm test` runs `test/*.test.js` (synthetic projects, CI-safe, **117 cases**: CLI 98 + MCP 6 + plugin commands 6 + topohash 5 + plugin node / search index 1 each, with dual 3.5.2/3.8.6 cross-version fixtures); `test/node-run.js` runs the full report against real projects as a regression.
- **Embedding / sharing**: the `#topo=<blob>` **URL-snapshot viewer** (a neighborhood subgraph packed into the hash → open the link to see the topology directly, **no File API needed, cross-browser**; `encodeTopo`/`decodeTopo` in `src/core/topohash.js`, auto-shrinking depth to fit 256KB); the `import('coir')` **embedding outlet** (`exports` → `src/index.js`); the **Cocos Creator 3.5–3.8 extension** (`cocos-extension/`: right-click an asset to see layered dependents/dependencies + goto + open a topology snapshot + plugin asset menus (e.g. anim/skel showing animation duration), running coir-core in-process, deployed by `install.sh`).
- **Usage**: the browser version is `npm install && npm run dev` → open `localhost:8080` in Chrome → pick a Cocos project directory; the CLI version is `coir deps <asset>` inside the project (or `-C <project dir>` to point elsewhere; `coir --help` for everything and examples).

> See `README.md` for detailed features and the data model; see `docs/EDITING.md` for the edit design and `docs/SERIALIZATION.md` for the serialization contract; see above in this file and `CLAUDE.md` for development commands and extension methods.
