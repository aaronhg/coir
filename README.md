# Coir — Cocos 資源依賴拓撲

[![Live Demo](https://img.shields.io/badge/Live_Demo-open-4fc3f7?style=flat-square)](https://aaronhg.github.io/coir/) [![License: MIT](https://img.shields.io/badge/License-MIT-3fb950?style=flat-square)](LICENSE) ![Cocos Creator](https://img.shields.io/badge/Cocos_Creator-3.8.x-9575cd?style=flat-square) ![runtime deps](https://img.shields.io/badge/runtime_deps-0-3fb950?style=flat-square)

> *Coir（椰殼纖維）：像梳理交織的椰纖一樣，把專案裡盤根錯節的資產依賴理出來；與 Cocos（椰子屬）同源。*

**▶ 線上試用（需 Chrome / Edge）：<https://aaronhg.github.io/coir/>** — 開啟後選你的 Cocos 專案目錄即可；全程在瀏覽器端執行，**不上傳任何檔案**。

載入一個 **Cocos Creator 3.8.x** 專案，於瀏覽器端建立資產的**使用情形**與**依賴拓撲圖**，涵蓋圖檔、圖集（TexturePacker plist / Spine）、點陣字（fnt）、prefab、scene、與 Cocos component 腳本。

純前端（HTML + JS，無後端、無建置步驟），透過 Chrome 的 **File System Access API** 直接讀取本機專案目錄。

> 📖 開發歷程、技術決策與踩過的坑見 [DEVELOPMENT.md](DEVELOPMENT.md)。

## 執行需求

- Chromium 系瀏覽器（Chrome / Edge）— File System Access API 限定。
- 需在 **安全內容** 下開啟（`http://localhost` 或 https），不可用 `file://`。

## 開始使用

```bash
npm install      # 只裝 webpack 工具鏈（無第三方執行期相依），僅首次
npm run dev      # 啟動 webpack dev server：http://localhost:8080（存檔自動重編譯＋熱重載）
# 正式打包： npm run build  → 產出 dist/app.bundle.js（minified，可用任意靜態伺服器部署）
```

瀏覽器開 `http://localhost:8080` → 點「選擇 Cocos 專案目錄」→ 選遊戲專案根目錄（含 `assets/` 的那層；直接選 `assets/` 亦可）。

> 純前端，**無第三方執行期相依**（先前的 cytoscape 力導向圖檢視已移除，只剩純 DOM）。由 **webpack** 打包（production bundle ~27KB）；開發用 `npm run dev`（webpack-dev-server，改 `src/` 即時重載），設定在 `webpack.config.cjs`（`.cjs` 因為 `package.json` 是 `type:module`）。

## 功能

介面是 **banner 上三個分頁（清單 / 拓撲 / 報告）共用一個內容區**，banner 下方一條**全域「類型篩選」bar**（同時作用於三個分頁）。

### 清單（＝層0）
- 可排序資產表：名稱／目錄／類型／大小／**被依賴**／**被依賴∑**／**依賴**／**依賴∑**。「目錄」欄只顯示資料夾（`a/b/c.prefab` → `a/b/`）。
- `被依賴` / `依賴` 是**直接**度數；帶 `∑` 的兩欄是**傳遞閉包**大小——`依賴∑` = 載入它會被帶進的資產總數（打包量）、`被依賴∑` = 改它會牽動的資產總數（影響範圍）。
- 點一列＝選為拓撲中心（該列高亮）。搜尋框可即時過濾路徑。

### 拓撲
- **雙向、固定 5 欄滑動視窗、永遠全展**的依賴樹：被依賴往左展、依賴往右展、層0 置中；視窗以選中項的「距中心位移」滑動；偵測循環顯示 `↻`。只列資產。
- 選中一個節點會**自動浮出「用在哪」**：它與樹中相鄰父節點那條邊的使用位置（節點路徑 · 元件.屬性 · frame；按鈕 ClickEvent 顯示 `▶ 方法()`）。
- **鍵盤／手勢**：`↑↓` 同欄、`←→`（或 Mac 兩指橫滑）跨欄並選「畫面垂直中央最近」者、`Enter` 設為新中心、`Ctrl/Cmd+C` 複製名稱、`/` 依檔名快速開啟、`r` 還原上次位置（存於 `localStorage`）。

### 全域類型篩選（bar）
- 型別徽章「首次點選＝單獨，之後＝累加」，三個分頁共用。
- 對**清單／報告**＝只顯示該型別；對**拓撲**＝**保留通往該型別的路徑**：符合型別的節點與通往它的中間節點留著、死枝剪掉，層0 永遠保留。

### 報告
- **未使用 / 孤兒資源**：`resources/` 以外、零參照的資產（`resources/` 一律略過，視為執行期動態載入）。
- **孤兒參照**：指向不存在 uuid 的失效參照；若那個 uuid 來自一個「來源被刪、只剩 `.meta`」的資產，會以**檔名 + 「缺來源檔」**標示（而非裸 uuid）。
- **圖集利用率**：每個 plist 有多少 sprite-frame 實際被個別引用；整圖被當 `SpriteAtlas` 動態取用者另標「整圖動態取用」（無法靜態判定）。
- **資產體積**：各類型總量與最大檔案排行（含目錄欄）。
- **缺來源檔的 meta（已略過）**：摺疊清單，列出所有「只剩 `.meta`、來源檔已刪」而被忽略的項目，標示「仍被引用」（斷掉的依賴要修）或「無人引用」（殘留可刪）。

### 解析原則
- **只收錄 Component 腳本**：`.ts` 僅保留 Cocos component（class `extends Component`／被序列化 `__type__` 引用／extends 鏈傳遞閉包），純工具模組（utils／enums／config）不納入拓撲；component 之間以**類別繼承 `extends` 邊**相連。
- **缺來源檔的 meta 不索引**：來源檔已刪、只剩 `.meta` 的資產不視為真資產（同資料夾 meta 的處理），但仍記住其 `uuid→path`，讓還在引用它的 prefab/scene 浮現為具名的「缺來源檔」斷線。

## 分析的資料模型（3.8.x）

| 節點 | 副檔名 | `.meta` importer | 說明 |
|---|---|---|---|
| 圖檔 | `.png` | `image` | 子資產 `uuid@<id>`：texture / spriteFrame |
| 圖集 (TexturePacker) | `.plist` | `sprite-atlas` | 每框 `uuid@<id>` 為 sprite-frame，`imageUuidOrDatabaseUri` 連底圖 |
| 圖集 (Spine) | `.atlas`/`.json`/`.png` | `*` / `spine-data` / `image` | skeleton→atlas→（多頁）png，自 `.atlas` 文字解析頁面 |
| 點陣字 | `.fnt` | `bitmap-font` | `userData.textureUuid` 連底圖 |
| Prefab / Scene | `.prefab` / `.scene` | `prefab` / `scene` | JSON，`__uuid__`（可帶 `@子id`）參照資產 |
| 動畫 | `.anim` | `animation-clip` | JSON |
| Component 腳本 | `.ts` | `typescript` | 於 prefab/scene 以**壓縮 uuid** 進 `__type__` |

依賴邊：
- `"__uuid__": "<uuid>"` 或 `"<uuid>@<子id>"` → 資產 / 子資產（完整 uuid，不壓縮）。
- `"__type__": "<23字壓縮uuid>"` → 腳本元件，以 `decompressUuid` 還原（Cocos v2.0.10 演算法，3.x `__type__` 沿用）。
- 推導邊：圖集→底圖、字型→底圖、粒子→底圖、spine 三件組；以及 component → 基底 component 的 `extends`（類別繼承）邊。
- cc.Button 的 ClickEvent 接線：`_componentId`（壓縮的處理腳本 uuid）+ `handler`（方法名）→ 一條 script 邊，位置記為 `click → 方法()`。

## 無頭工具（Node）

核心解析與瀏覽器解耦，可在 Node 下直接跑。

**整份報告驗證**（改 `src/core/` 後用它對真實專案回歸）：

```bash
node test/node-run.js <專案目錄> [中心uuid或路徑]
# 例：node test/node-run.js ../my-cocos-project scene/Main.scene
```
輸出資產/邊統計、邊種類分佈、未使用、孤兒參照、圖集利用率、體積與依賴閉包。

**單一資產的依賴查詢 CLI**（`src/cli.js`，輸出到 stdout、可 pipe/解析；註冊為 `coir`）：

```bash
npm run cli -- <專案目錄> deps    <資產> [--in|--out] [--depth N] [--type T[,T2]] [--where] [--json] [--limit N]
npm run cli -- <專案目錄> uses    <資產>            # = deps --in（誰參照它）
npm run cli -- <專案目錄> closure <資產> [--type T] [--list] [--json]   # 打包閉包
npm run cli -- <專案目錄> find    <查詢> [--type T]                     # 依名稱找候選
```

`<資產>` 可用完整路徑／basename／uuid／`uuid@sub` 指定（撞名印候選並 `exit 2`）。`--where` 展開每條邊的使用位置（節點路徑 · 元件.屬性 · frame）。`--type` 只保留指定型別：在 `deps`/`uses` **樹**上會**保留通往該型別的中間路徑**（同瀏覽器拓撲的篩選），在 `closure`/`find`/`--json` 上則是過濾平面清單。

## 架構

```
src/core/      # 與 DOM/瀏覽器無關的純核心，Node 與瀏覽器共用
  uuid.js      #   壓縮/解壓縮 uuid（含 @子資產處理）
  meta.js      #   解析 .meta → 資產 + 子資產
  refs.js      #   從 prefab/scene/anim/mtl 抽取參照（含使用位置 locations）
  scan.js      #   掃描 FileProvider → 資產索引 + 依賴邊
  graph.js     #   鄰接表、依賴/被依賴閉包
  analyze.js   #   未使用、孤兒、圖集利用率、體積、閉包、缺來源檔 meta 報告
src/browser/   # 瀏覽器層（純 DOM，無第三方執行期庫）
  fsapi.js     #   File System Access → FileProvider
  ui.js        #   三分頁（清單／拓撲／報告）+ 全域類型篩選 + 互動
  app.js       #   進入點
src/node/
  fsProvider.js #  Node fs → FileProvider（node-run.js 與 cli.js 共用）
src/cli.js        # 無頭依賴查詢 CLI（deps/uses/closure/find，bin: coir）
test/node-run.js  # 整份報告的無頭驗證器
test/cli.test.js  # node:test：對合成專案跑 cli.js 端對端
index.html        # 應用外殼 + CSS（載入 dist/app.bundle.js）
webpack.config.cjs # webpack 設定（entry=src/browser/app.js、dev server）
dist/app.bundle.js # webpack 打包輸出（純 DOM，~27KB）
```

`FileProvider` 介面：`listFiles()` / `readText(path)` / `size(path)`，路徑相對於 `assets/`。瀏覽器（`fsapi.js`）與 Node（`node/fsProvider.js`）各有一份實作，因此解析邏輯可無頭測試（`npm test`）。

## 已知限制

- **動態載入灰區**：以字串路徑於執行期載入者（`resources/` 下的 `loadDir`、或程式碼自行 `load('xxx')`）無法靜態追蹤。故未使用判定一律略過 `resources/`；但 `resources/` 外、純由程式載入的資產（例如某些以程式挑選的點陣數字圖集）可能被列為「未使用」——這是靜態掃描的本質盲區，不一定是真的沒用到。
- 整圖被當 `SpriteAtlas` 取用時，個別框的使用情形無法靜態得知（已標記「整圖動態取用」）。
- 目前針對 **3.8.x** 格式；3.5.2 序列化格式相容，核心可直接套用（如遇差異於 `meta.js` / `scan.js` 微調）。**不**支援 2.x（`.fire` 場景、舊版 meta）。
- 圖集利用率的位元組級「浪費面積」尚未計算（目前以框數比例呈現）。
