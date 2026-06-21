# coir — Cocos Creator 3.5–3.8 extension

Right-click an asset in the **Assets** panel → **`Coir 依賴拓撲  ←L2 ←L1 →L1 →L2`** with a
submenu listing its **dependencies (→) then dependents (←) as indented trees** —
depth is shown by **indentation** (each deeper layer nested one tab under its
parent; no per-node cap, no "層N" labels). Click an entry to **jump to that asset**
in the editor, or **開啟拓撲圖** to open its dependency topology in your browser (the
graph rides in the viewer's URL hash `#topo=…` — no server, no upload). An asset
with no neighbours is a flat item that opens the topology directly.

## Plugin asset menus (e.g. anim / skel)

A coir plugin contributes to this right-click menu via `plugin.assetMenus`
(`[{ ext?, types?, label?, rows(ctx) }]` — its own thing, independent of `commands`;
see coir's `types/index.d.ts`). A matching asset gets its own menu entry computed
by `rows(ctx)` from the asset itself — **a single row collapses to a flat item;
multiple rows stay a submenu**. The [`anim` and `skel`](https://github.com/aaronhg/coir-plugins)
plugins ship this:

```
right-click  walk.anim  →  Coir anim  0.33s          # one clip → flat (just the duration)
right-click  hero.skel  →  Coir skel ▸  idle / 2s    # many anims → submenu (name / duration)
                                        walk / 0.8s
                                        …
```

The menu render is synchronous, so `main.js` precomputes every matching asset's
rows in the background (calling each plugin's `assetMenus[].rows(ctx)`) and pushes
them, just like the graph; an mtime cache skips re-parsing unchanged files (e.g.
heavy `.skel` binaries). The plugins must be active in a `coir.plugins.mjs`
(repo-root or project) for the menu to appear — and because Node caches the ESM
import, **adding/editing a plugin needs a full editor restart** (an extension
reload doesn't clear the module cache).

## Go-to-node panel (跳轉)

There's also a dockable **`Coir 跳轉`** panel that turns a coir locator into an
editor selection — and back. Open it from **面板/Panel → Coir → 跳轉到節點…** or the
shortcut **`Ctrl+Alt+G`** (remappable in 偏好設定 → 快捷鍵).

**Type/paste → select:**
- a **node path** → selects the node in the *currently-open scene* (resolved against
  the live tree via `scene` `query-node-tree`, no file read);
- a **file** (ends in `.ext`, e.g. `xxx.prefab`, `ui/foo.png`) → selects the asset in
  the Assets panel (basename or path-suffix match; ambiguous → asks for a fuller path).

```
Canvas/Root/Panel/Title/Label      → select that node
…/Panel/Title/Label:cc.Label       → same node (:Comp/.prop stripped)
…/Root/Item[1]                     → 2nd same-name sibling (0-based [i])
foo.prefab                         → select that asset
```

It paste-matches what coir prints (`--where`, the browser usage popup, the topology
breadcrumb). Scope: `nodePath` + `[i]` sibling disambiguation; a trailing `:Component`
(and any `.prop`) is dropped (the editor has no API to highlight a single component
card); `#N` (the serialized absolute index) isn't supported (no live-scene equivalent).
The path is absolute (scene-root name first) but omitting that first segment also works;
a same-name sibling with no `[i]` resolves to `[0]`.

**Reverse:** selecting a node (or asset) in the editor backfills the input with its
coir `nodePath` (`[i]`-disambiguated) / filename — except while you're typing in it.

It runs [coir](https://github.com/aaronhg/coir)'s core **in-process** (cached
scan), so the menu is instant and stays fresh as the project changes. The scan
also loads `coir.plugins.mjs` from the **coir repo root** (global) and the
**project root** — exactly like the CLI/browser — so editor-side edges include
custom plugin edges (e.g. audio-call `audioPlay('x')` → `x.mp3`); the active
plugins are logged as `source.name` (`global.audio-call`, `project.…`).

## Native-verify endpoint (for `coir native-verify`)

A tiny **opt-in** localhost HTTP server that lets coir cross-check its read of a
prefab/scene against the **live engine** — the headless `coir verify` checks
structure offline; `coir native-verify <file>` asks *this* running editor to
reimport + instantiate the same file and confirm the engine builds what coir
parsed (catching a file that won't import, a silently-dropped `cc.*` component, a
missing script). It exposes exactly the **three primitives** a native verify needs
— and skips the rest of a general MCP bridge:

```
POST /reimport {url}                 asset-db reimport-asset      (validity gate)
POST /read     {uuid, selectors[]}   scene readback (scene.js)    (terse — only the asked selectors)
POST /fixture  {action,…}            asset-db copy/create/delete  (isolated test assets)
POST /ready                          → { ready, version, project }
POST /uuid     {url}                 → { uuid }
```

**Start it**: menu **Coir ▸ native-verify: start** (or the **toggle in the 跳轉
panel's footer**, which also shows the bound port + cocos version). 127.0.0.1
only, `unref`'d; it auto-increments from **3789** if the port is taken, so
several editor windows each get their own. The CLI client (`coir native-verify`)
probes 3789..3809 and picks the endpoint whose **open project matches** `-C`.

Implementation: `main.js` (the HTTP server + `asset-db` calls, runs in the editor
process where coir-core already lives) + **`scene.js`** (the readback — the one
piece that must run in the *scene* process, invoked via `execute-scene-script`).
`scene.js` resolves a component selector by **longest class-name match**
(`cc.js.getClassName`), so a dotted type like `cc.SkinnedMeshRenderer._enabled`
parses correctly. **Gotchas** (the reasons it's built this way): scene methods are
called via `Editor.Message.request('scene','execute-scene-script',{name,method,args})`
— NOT a bare `request('scene', method)`; **reimport must precede read** (asset-db
caches the imported version). See coir's DEVELOPMENT.md §11.27–§11.29.

## How it works

```
right-click asset → onAssetMenu(assetInfo)            (assets-menu.js, renderer)
   SYNC: BFS the cached graph ±2 layers from assetInfo.uuid → a pre-order tree
     label  Coir 依賴拓撲 ←…←… →…→…  + submenu (開啟拓撲圖 · → / ← <name>, indented by depth)
   click a dep/dependent → Editor.Selection.select('asset', uuid)
   click 開啟拓撲圖       → open-topo(uuid)
                                                       (main.js, editor process)
main: cached scanProject(<project>/assets, { plugins }) via coir-core (in-process),
      plugins = built-ins + coir-root + project coir.plugins.mjs (deduped)
   all-graph  → compact out/inc graph (uuids/names + indices), pushed to the
                menu (request to prime + `coir:graph` broadcast to refresh)
   all-asset-menus → plugin assetMenus rows (anim/skel/…), precomputed by calling
                each menu's rows(ctx) (request to prime + `coir:asset-menus`)
   open-topo  → encodeTopo(scan, uuid) → shell.openExternal(VIEWER + '#topo=' + blob)
   invalidate the scan on asset-db changes (re-scan lazily)
```

`assetInfo.uuid` is coir's node key directly (coir reads the same `.meta`), so no
translation is needed.

## Install (for local testing)

**Quickest — `install.sh`** (copies this folder into the project's `extensions/coir/`
and symlinks `node_modules/coir` → the checkout, so `import('coir')` resolves with
no npm link / env var):

```bash
cd cocos-extension
./install.sh /path/to/CocosProject  # install into that project
```

Then **enable it**: Cocos Creator → Extension Manager → it appears under the
project extensions → enable/reload (plain JS, no build step). Right-click any
asset → **Coir 依賴拓撲**.

### Manual (if you'd rather not run the script)

1. Copy this `cocos-extension/` folder to `<project>/extensions/coir/`.
2. Make `coir` importable from there: `cd /path/to/coir && npm link`, then
   `npm link coir` in the copied folder — or set `COIR_CORE=/path/to/coir/src/index.js`
   before launching the editor.
3. Enable it in the Extension Manager.

## Notes / to verify on your build

- **Synchronous menu (important)**: `onAssetMenu` MUST return synchronously — the
  editor does NOT await an async menu builder (it would silently render nothing).
  So the graph is pushed to the renderer (`all-graph` request to prime + the
  `coir:graph` broadcast to refresh) and the menu BFS's it locally.
- **asset-db change events**: `main.js` invalidates the scan on
  `asset-db:asset-add/-change/-delete` — confirm those broadcast names against
  the 3.8 asset-db message reference for your editor version (the listeners are
  wrapped in try/catch, so a wrong name just means you re-open to refresh).
- **Go-to-node panel — scene messages**: `panels/goto.js` uses
  `Editor.Message.request('scene', 'query-node-tree')` (the live hierarchy) and
  `Editor.Selection.select('node', uuid)`. These exist since 3.x, but confirm the
  message name / return shape (root = the scene node, fields `name`/`uuid`/`children`)
  on your editor version — both are wrapped so a wrong name just surfaces as
  「請先開啟一個場景」.
- **Viewer URL**: defaults to the hosted build. For offline use, serve a copy of
  coir and change `VIEWER` in `main.js`.
- **Snapshot size**: the neighborhood auto-shrinks its depth to keep the URL
  under coir's `MAX_BLOB_CHARS` cap; boundary nodes (trimmed neighbours) are
  marked `⋯` in the viewer.
- **Plugins**: the scan loads `coir.plugins.mjs` from the coir repo root (global)
  and the project root, like the CLI/browser, and logs the active ones. Node
  caches the import — edit the config, then RELOAD the extension to re-read it.
- **3.5–3.8**: `editor: ">=3.5.0"`. The editor APIs used (assets.menu / Message /
  Selection / I18n / Project.path) exist since 3.0; the Node-18 deps the snapshot
  needs (`CompressionStream` + `btoa`) have `zlib` + `globalThis.Buffer` fallbacks
  in coir, so 3.5's older Electron works too.
