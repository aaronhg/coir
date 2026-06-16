# coir — Cocos Creator 3.8 extension

Right-click an asset in the **Assets** panel → **`Coir 依賴拓撲 ←used-by →uses`** →
opens that asset's **dependency topology** in your browser. The label shows the
asset's live direct degrees; the topology rides in the viewer's URL hash
(`#topo=…`) — no server, no upload.

It runs [coir](https://github.com/aaronhg/coir)'s core **in-process** (cached
scan), so the menu is instant and stays fresh as the project changes.

## How it works

```
right-click asset → onAssetMenu(assetInfo)            (assets-menu.js, renderer)
   └─ await degrees(uuid)  → label "←in →out"
   click → open-topo(uuid)
                                                       (main.js, editor process)
main: cached scanProject(<project>/assets) via coir-core
   degrees(uuid)   → asset.in / asset.out
   open-topo(uuid) → encodeTopo(scan, uuid) → shell.openExternal(VIEWER + '#topo=' + blob)
   invalidate on asset-db changes (re-scan lazily)
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

- **Async menu label**: `onAssetMenu` is `async` and awaits the degree count.
  Cocos contribution messages are Promise-based, so this should work; if your
  build does NOT await async menu builders, switch to the **synchronous
  degree-cache** variant commented at the bottom of `assets-menu.js`.
- **asset-db change events**: `main.js` invalidates the scan on
  `asset-db:asset-add/-change/-delete` — confirm those broadcast names against
  the 3.8 asset-db message reference for your editor version (the listeners are
  wrapped in try/catch, so a wrong name just means you re-open to refresh).
- **Viewer URL**: defaults to the hosted build. For offline use, serve a copy of
  coir and change `VIEWER` in `main.js`.
- **Snapshot size**: the neighborhood auto-shrinks its depth to keep the URL
  under coir's `MAX_BLOB_CHARS` cap; boundary nodes (trimmed neighbours) are
  marked `⋯` in the viewer.
