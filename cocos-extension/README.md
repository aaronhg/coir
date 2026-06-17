# coir — Cocos Creator 3.5–3.8 extension

Right-click an asset in the **Assets** panel → **`Coir 依賴拓撲  ←L2 ←L1 →L1 →L2`** with a
submenu listing its **dependencies (→) then dependents (←) as indented trees** —
depth is shown by **indentation** (each deeper layer nested one tab under its
parent; no per-node cap, no "層N" labels). Click an entry to **jump to that asset**
in the editor, or **開啟拓撲圖** to open its dependency topology in your browser (the
graph rides in the viewer's URL hash `#topo=…` — no server, no upload). An asset
with no neighbours is a flat item that opens the topology directly.

It runs [coir](https://github.com/aaronhg/coir)'s core **in-process** (cached
scan), so the menu is instant and stays fresh as the project changes. The scan
also loads `coir.plugins.mjs` from the **coir repo root** (global) and the
**project root** — exactly like the CLI/browser — so editor-side edges include
custom plugin edges (e.g. audio-call `audioPlay('x')` → `x.mp3`); the active
plugins are logged as `source.name` (`global.audio-call`, `project.…`).

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
./install.sh                        # → ../../NewProject_386 (default)
./install.sh /path/to/CocosProject  # → that project
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
