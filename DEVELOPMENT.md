# 開發過程 — Cocos 資源依賴拓撲工具

這份文件記錄 **Coir**（開發期暫名 `assets-graph`）的開發歷程：需求如何演進、做了哪些技術決策、踩過哪些坑、以及最後落腳的設計。

---

## 0. 一句話目標

載入一個 **Cocos Creator 3.8.x** 專案，在瀏覽器端做出**資源使用情形**與**依賴拓撲**，涵蓋圖檔、圖集（TexturePacker plist / Spine）、點陣字、prefab、scene、component 腳本。實際案例用本機的 Cocos 專案驗證（不放進 repo）。

---

## 1. 研究與範圍鎖定

### 1.1 先勘查再動手
一開始用實際專案（本機的 Cocos 專案）摸清格式，而不是憑記憶。重要發現：

- 手邊不少舊專案是 **2.4.6**（`.fire` 場景、舊 meta），但目標其實是 **3.8.6**（之後相容 3.5.2）。本機剛好有數個 **3.8.x** 樣本（其中有些 `project.json` 寫 3.8.5，格式同 3.8.6）。
- **2.x 與 3.x 格式差很多**，必須以 3.x 為準重新驗證。

### 1.2 3.x 格式關鍵（用一個 3.8.x 樣本驗證）
- png `.meta` importer `image`；子資產用短 id → `uuid@6c48a`(texture)、`uuid@f9941`(spriteFrame)。
- plist `.meta` importer `sprite-atlas`；每張 frame `uuid@<id>`，`userData.imageUuidOrDatabaseUri` 連回底圖。
- fnt `.meta` importer `bitmap-font`，`userData.textureUuid` 連 png。
- Spine：skeleton `.json`(spine-data) + `.atlas`(importer `*`、可多頁) + png。
- prefab/scene 的 `__uuid__` 是**完整 uuid**（可帶 `@subid`，不壓縮）；custom 腳本元件以**壓縮 uuid** 出現在 `__type__`。

### 1.3 唯一的未知：uuid 壓縮
3.x 把腳本 uuid 壓成 23 字放進 `__type__`。使用者提供了 `compressUuid`/`decompressUuid`（Cocos v2.0.10 演算法的參考實作）。**端對端驗證**：scene 裡的 `__type__` 解壓後正好對回真實 `.ts.meta` 的 uuid（對得上專案裡的 component 腳本）。可行性確認。

---

## 2. 架構決策

### 2.1 核心與瀏覽器解耦
刻意把解析邏輯做成 **DOM-free 的 `src/core/`**，瀏覽器與 Node 共用。好處：最難的解析能**無頭驗證**——`test/node-run.js` 用 `fs` FileProvider 跑同一套核心對真實專案測試。

```
src/core/   uuid / meta / refs / scan / graph / analyze   ← 純邏輯，無 DOM
src/browser/ fsapi（File System Access）/ ui              ← 介面
src/node/   fsProvider                                    ← Node 端 FileProvider
test/node-run.js                                          ← 無頭驗證器
```

`FileProvider` 介面：`listFiles() / readText(path) / size(path)`，路徑相對 `assets/`。

### 2.2 解析模型
- 掃所有 `.meta` → uuid 索引（含 `uuid@sub` 子資產）。
- 走 prefab/scene/anim/mtl 的 JSON 找 `__uuid__`（資產邊）與 `__type__`（壓縮腳本 uuid）。
- 從 meta 推導 atlas→png、font→png、spine 三件組。
- 邊去重為 `(from, to, kind)`。

---

## 3. 技術棧演進（CDN → esbuild → webpack；cytoscape 進場又退場）

| 階段 | 做法 | 為何改 |
|---|---|---|
| 1 | 圖視覺化用 **cytoscape + fcose（CDN）** | 起步快 |
| 2 | 使用者要求**離線/打包** → 改 npm 裝 + **esbuild** bundle | 不依賴 CDN |
| 3 | 使用者要求改 **webpack + dev server** | 熱重載開發 |
| 4 | 使用者說「圖的功能刪掉」→ **移除 cytoscape/fcose 全家桶** | 改純 DOM 樹狀，bundle 565KB→~20KB |

教訓：第三方執行期庫最後**全部移除**，UI 變成純 DOM。webpack 仍保留（`webpack.config.cjs`，CommonJS 因為 package 是 type:module）。

---

## 4. 視覺化的多次大改

這是迭代最多的部分，依使用者回饋一路演進：

1. **力導向圖（cytoscape）**：任意節點當中心、單擊展開、雙擊設中心、展開/縮回一層。
2. → **Finder 欄位式（Miller columns）**：單路徑、逐欄往右鑽。
3. → **樹狀 × 欄位**：每層一欄、同層多分支可同時展開、子節點對齊父節點所在列（first-child-shares-row 演算法，用使用者畫的 ASCII 圖做單元測試驗證）。
4. → **固定 5 欄滑動視窗**：永遠 5 欄，以選中項的「距中心位移」為中心滑動（`被依賴2|被依賴1|層0|依賴1|依賴2` → 往右 → `被依賴1|層0|依賴1|依賴2|依賴3`）。
5. → **雙向、全展、5 欄等寬填滿**：被依賴往左展、依賴往右展、層0 置中；不再折疊（視窗內全展，cycle 防護）；欄寬 `1fr` 填滿；選中項上下左右置中（sticky 標頭 + `padding-block:45vh` + scrollIntoView center）。
6. → **左右鍵改空間式**：移到相鄰欄、選「畫面垂直中央最近的項目」。

最終定案：**三個 banner 分頁（清單 / 拓撲 / 報告）**，拓撲是上述雙向樹。

---

## 5. 核心解析踩過的坑（與修法）

| 坑 | 症狀 | 修法 |
|---|---|---|
| 資料夾 meta | `importer:"directory"` 被當節點 | 掃描時略過 `importer==='directory'`（驗證 10 個專案皆 0 個目錄節點）|
| Spine 多頁 atlas | `spine_bg2..40.png` 被誤判未使用 | 解析 `.atlas` 文字取所有頁面 png（basename 比對會漏）|
| 圖集整圖動態取用 | 全部圖集顯示 0% 利用率 | 區分「整圖被當 SpriteAtlas 動態取用（無法靜態判定）」vs 個別 frame 引用 |
| **component 偵測誤判** | `Utils.ts` 被當 component | `extends Component` 正則誤中**泛型約束** `getCacheObj<T extends Component>`。改成必須是**類別繼承** `class Name<…> extends Component`；同時也讓泛型基底/子類別正確被偵測 |
| 巢狀 prefab 節點路徑 | `PrefabInfo.asset` 的 nodePath 是空 | `PrefabInfo`/`KeyAtlas` 沒有 `node` 欄位 → 用**反向 `{__id__}` 往上爬**找擁有它的節點；並略過空 `_name` |

component 偵測最終用三個訊號：直接 `extends Component`、被 `__type__` 引用、以及 **extends 鏈傳遞閉包（fixpoint）**。純 util/enum/config 從索引移除。

---

## 6. 互動功能（逐步加上）

- **鍵盤導覽**（拓撲）：`↑↓` 同欄、`←→` 跨欄、`Enter` 設為中心。導覽完全用 `selectedKey` 字串推導父/子，避免「找不到 cell 就跳到第一項」的 bug。
- **`/` 快速開啟**：VSCode Ctrl+P 風格、依檔名過濾。
- **`r` 還原**：選中路徑 + 方向存進 `localStorage`，按 `r` 重建並聚焦。
- **Ctrl/Cmd+C**：複製選中節點名稱（有文字選取時讓瀏覽器正常複製）。
- **Mac 兩指滑動**：攔截橫向 `wheel`、`preventDefault` 擋掉「上一頁」手勢，換算成 ←/→（再加 `overscroll-behavior:none` 保險）。

---

## 7. 依賴上下文擴充（「用在哪、怎麼用」）

### 7.1 先用多 agent 研究可行性
使用者要求前先做**可行性研究**（ultracode → 多 agent workflow，跑真實樣本專案）：
- 核心鑰匙：scene/prefab 是扁平陣列、`{__id__:N}===arr[N]`；走訪 `__uuid__` 時順手記下 **(元件, 屬性路徑)**，元件的 `node.__id__` 沿 `_parent/_name` 走到根 → **節點路徑**。
- 量化：239 個資產參照中 ~86% 是乾淨的 `元件.屬性`，~14% 是難解（prefab 實例 override 等），恰好 1 個無解（失效 fileId）。

### 7.2 Phase 1 實作
- `refs.js extractContextRefs()` 擷取每個邊的 `locations:[{nodePath, component, property, subName}]`。
- 實證：`animation.anim → Canvas/UIRoot/InfoBar/Node · cc.Animation._clips.0`。

### 7.3 依回饋重設計 popup
使用者覺得「全域使用清單」太雜。改成：
- **只顯示拓撲當下這條關係**：選中項 ↔ 它在樹中的父項目那條邊的位置（由 `selectedKey` 切出父）。
- 內容只留**位置細節**（樹上已看得到的資產名不重複）；元件本身的參照（property 為空）只顯示節點路徑。
- 根/結構邊（如 plist→png 無節點位置）**自動隱藏**。
- 拿掉 ⓘ 按鈕與 `i` 鍵 → **選中即自動出現**，位置算在選中格下方（不夠就翻上方）。
- 修了巢狀 prefab：某 `Item.prefab` 在 `CommonPanel/bottom/node/control/node · cc.PrefabInfo.asset`。

---

## 8. `extends` 取代 `import`

「顯示腳本 import 邊」開關被認為沒用 → 移除開關 + 移除 import 邊（多又雜），改成有意義的**類別繼承邊**：每個 component 連到它的基底類別（`Widget.ts → WidgetBase.ts`，重用 component 偵測的 `baseName`/`definers`）。樣本專案：import 0、extends 64。

---

## 9. 驗證方法（貫穿全程）

- **核心無頭驗證**：每次改 `src/core/` 都用 `node test/node-run.js <專案>` 或臨時 node 腳本對真實樣本專案跑，確認解析、邊、location 正確（例如逐項驗證使用者給的三個案例）。
- **演算法單元測試**：樹狀佈局用使用者畫的圖驗證 row/depth；鍵盤導覽用模擬序列驗證「← 回到正確父節點」。
- **建置/服務**：`node --check`、`npm run build`、檢查 `$('id')` 都存在於 HTML、`webpack serve` 回 200。
- **跨專案穩健度**：對全部 10 個 3.8.x 專案掃描，確認 `metaErrors=0`。

---

## 10. 無頭 CLI（依賴查詢）

核心既然 DOM-free 又能無頭跑,自然再包一層「能指名查詢、輸出可解析」的 CLI,讓人或 agent 直接問「某資產依賴誰 / 被誰依賴」,不必開瀏覽器。

### 10.1 設計探索（依回饋收斂）

- **從「依賴」開始,以 png 舉例**：很快發現查詢應**型別無關**——葉節點（png）是「被誰用」(`in`)有料,prefab/scene 是「依賴誰」(`out`)有料,atlas/spine 兩邊都有。結論：主命令 `deps` **預設兩方向一起印**,`uses` = `deps --in` 的別名,不為型別特例化。
- **精簡輸出**：以 **path 當識別**（不印 uuid）,`via` = 邊種類;`→` 依賴 / `←` 被依賴、`(N×)` weight、`↻` 循環、`⚠` 未被參照、`↯` orphan。
- **接上「用在哪」**：另一 session 的 `extractContextRefs` 已讓每條邊帶 `locations:[{nodePath, component, property, subName}]`。CLI 的 `--where` 直接展開它（不另算）;自訂腳本元件的壓縮 `__type__` 用 `decompressUuid` 還原成腳本路徑;meta/spine/font 等推導邊沒有 location,標 `(meta-derived)`。這成為 CLI 與 `refs.js` 之間的**契約**。

### 10.2 決策與理由

| 決策 | 理由 |
|---|---|
| 無狀態全掃,不做快取（樣本專案 ~70ms） | 夠快,省掉快取失效的麻煩;高頻查詢再考慮 `--fast`（跳過 size/script 讀檔）或常駐索引 |
| `--where` 讀 `edge.locations`,CLI 自建 `edgeMaps` 索引 `scan.edges` | `graph.js` 的 adjacency 故意丟掉 `locations`;只有 `closure` 借 `closureReport`/`buildAdjacency` |
| 目標解析接受 path / basename / uuid / `uuid@sub` | 撞名**不猜**,印候選（上限 20）並 `exit 2` |
| JSON 固定 1-hop（不受 `--depth`） | 多層樹狀 JSON 之後再說 |
| 結束碼 `0`/`1`/`2`,stdout=資料、stderr=訊息 | 方便 pipe / 給 agent 解析 |

`makeFsProvider` 從 `test/node-run.js` 抽到 `src/node/fsProvider.js`,CLI 與 test 共用。

### 10.3 驗證

對樣本專案實測每個命令:`deps`/`uses` 兩方向、`closure`（scene → 208 assets / 29.5 MB）、`find`;`--where` 印出真實 nodePath（`Canvas/UIRoot/InfoBar/Node · cc.Animation._clips.0`）與 frame 名;自訂腳本 `__type__` 正確還原（節點 `Boot` 上的 `Boot.ts`）;`--depth 2` 縮排展開、重訪標 `↻`;撞名 `config.json`(44 筆)印候選 + `exit 2`;結束碼齊全。

接著補上**自動化測試**(`test/cli.test.js`,`node:test` 內建、零相依):以子行程跑真實 `src/cli.js`,對著一份**自建於暫存目錄的合成專案**(格式正確的 `.meta` + prefab/scene JSON,`__type__` 用真實 `compressUuid` 產生)。不依賴任何本機樣本專案,可重現、CI-safe。涵蓋:`find`、`deps --json`(out 邊/orphan/in 邊)、`--where`(nodePath·屬性·frame·壓縮 `__type__` 還原)、meta 推導邊的空 `locations`、`⚠` 僅限 `resources/` 外、`closure` 計數、撞名/找不到 `exit 2`、用法/未知命令 `exit 1`、以 uuid 與 `uuid@sub` 解析目標。`npm test` 一鍵跑(glob `test/*.test.js` 不會掃到 `test/node-run.js`)。

### 10.4 分發（不靠 `npm run cli`）

`src/cli.js` 加 shebang、`chmod +x`;`package.json` 註冊 `bin`（`coir`）、`files` 設 `["src","README.md"]`。因**零執行期相依**,打包僅 ~28KB、可離線。

| 對象 | 方式 |
|---|---|
| 隊友(有 repo) | `npm link` → 全域 `coir`;`npm unlink -g coir` 移除 |
| 無 repo | `npm i -g <git-url>` |
| 免安裝 | `npx <git-url> <projectDir> deps <asset>` |
| 公開發佈 | `npm publish` → `npm i -g` / `npx` |
| 只想 clone | `node src/cli.js …` 或 `./src/cli.js …` |

### 10.5 待辦

CLI 報告類命令（`summary`/`unused`/`orphans`/`atlas`/`size`,函式已在 `analyze.js`）、`--fast` 掃描、多層樹狀 JSON、高頻查詢的索引快取、單檔自包含 bundle（`dist/cli.cjs`）。

---

## 11. 近期擴充

### 11.1 全域類型篩選 bar + 拓撲剪枝（保留中間路徑）
起因：把某個 `.fnt` 設為中心、又先點了 `font` 徽章來找它，拓撲兩邊全空——因為它的鄰居是 png/scene，被「清單型別篩選」連帶濾掉了。先**把篩選與拓撲解耦**（型別徽章只篩清單），確認資料其實正確；接著依使用者新點子改成更好的版本：

- 型別徽章從清單分頁**拉到 banner 下一條全域 bar**，三分頁共用一個 `selectedTypes`。
- 對**清單／報告**＝只顯示該型別；對**拓撲**＝**剪枝到「通往該型別」的分支**：符合型別的節點 + 通往它的中間節點留著、死枝丟掉、**層0 永遠保留**。篩選時建**完整樹**（cycle-bounded DEEP），讓比 5 欄視窗更深的符合節點仍保留連接路徑。`neighborsOf` 本身不過濾（維持真實結構），剪枝是建樹後做。

### 11.2 CLI `--type`（同款剪枝）
`src/cli.js` 加 `--type T[,T2]`：`deps`/`uses` 樹做同樣的「保留通往該型別中間路徑」剪枝（重構為 `buildEdgeTree → pruneByType → renderTreeText`，**未帶 `--type` 時輸出逐字不變**，由測試鎖住）；`closure`/`find`/`--json` 過濾平面清單。

### 11.3 清單閉包欄 + 報告目錄欄 + 小修
- 清單加 `被依賴∑`(`dependentClosure`＝影響範圍) / `依賴∑`(`dependencyClosure`＝打包量) 兩欄**傳遞閉包**，`setScan` 一次算完（~0ms/500 資產），樣式較直接 in/out 淡。
- 報告每列加**目錄欄**；sticky 表頭被「捲動容器上 padding」頂出一條縫、讓資料列從表頭上方漏出——拿掉容器上 padding 修掉。
- **圖集利用率只算 `type='atlas'`**（sprite-atlas .plist），排除像 `decal.png` 這種 meta 帶 2 個 sprite-frame 的純 png。

### 11.4 缺來源檔的 meta（已刪資產的殘留 meta）
- 來源被刪、只剩 `.meta` 的資產**不索引**（比照資料夾 meta）。驗證移除後 **0 個新孤兒**：被引用者全走有守門的衍生 texture 邊，乾淨消失。
- 記 `scan.missing`（uuid+子 uuid → path），讓仍被 prefab/scene 以 `__uuid__` 引用者浮現為**具名「缺來源檔」孤兒**（不是裸 uuid）；UI 紅標、CLI 印路徑、`--json` 加 `path/missingSource`。
- 報告加**摺疊「缺來源檔的 meta（已略過）」審計區**（`droppedMetaReport`）：列出全部、標「仍被引用（斷線要修）/ 無人引用（殘留可刪）」。精準度靠 `scan.missingReferenced`——在**所有指向資產的點**（`resolveUuid` + atlas/font 衍生邊 + 路徑型 spine via `missingByPath`）記錄，才抓得到「活著的 `.atlas` 仍列出一張已刪 page」這種只看 JSON 會漏的案例。

### 11.5 `/` 快速搜尋大升級
從「只比對檔名」變成**多來源模糊搜尋**：`buildSearchIndex` 攤平 asset／frame（sprite-frame 名）／usage（edge.locations）三種，每筆 `target` 都是真實資產 uuid。比對改子序列模糊（`matchScore`：精確>前綴>子字串>子序列），**命中字 VSCode 式高亮**（`fuzzyMatch` 回位置、標所有出現處，所以 `prefab` 連檔名與資料夾一起亮）。範圍前綴 `@`frame `#`type `>`usage、貼 uuid 直跳；每筆右欄顯示 `←被依賴∑ →依賴∑`（0 不畫）；打字回捲到頂。

### 11.6 命名 **Coir** + 發佈
- 取名：`Cocos` 本就是椰子屬，依賴樹⇄椰子樹的雙關 →「Coir（椰殼纖維）」。改 `package.json`/`bin`(`cag`→`coir`)/`localStorage`/`<title>`/docs；目錄 `assets-graph`→`coir`（給使用者一支 `rename-to-coir.sh`，順帶搬 `.claude` 記憶）。
- **stale `dist/*.LICENSE.txt`**：webpack 沒清 `dist/`，留著舊 cytoscape/fcose 的 bezier/spring 授權銘牌——與「無第三方相依」矛盾 → 刪掉並加 `output.clean:true`；production 關 sourcemap、`publicPath:'auto'` 讓 gh-pages 友善。
- GitHub Pages：`index.html`＋committed `dist/app.bundle.js` 直接從 `main`/root 上線（加 `.nojekyll`、MIT `LICENSE`），README 放 Live Demo badge。

### 11.7 多語系 + 首航 UX
- **i18n**（繁中＋English，零相依）：所有可見字串集中到 `src/browser/i18n.js`（`MESSAGES` + `t(key,vars)` `{var}` 插值），靜態 HTML 用 `data-i18n` / `data-i18n-html` / `data-i18n-ph` / `data-i18n-title`（中文留作 fallback）。banner 下拉切換 → `relocalize()` 重掃＋重繪；自動偵測 `navigator.language`。`src/core/` 零字串；**CLI 固定英文**、集中在 `USAGE`＋`M` 物件（一個測試斷言改 `(missing source)`）。
- **首航卡片**：剛進來中央浮卡片（選擇按鈕＋說明），全螢幕遮罩，只有語系/`?`/GitHub 抬到遮罩之上（z-index 48）可按。
- **說明 modal**（`?`，z-index 55）：分頁/拓撲/搜尋/快捷鍵，底部 GitHub 連結；🥥 favicon（emoji SVG）、banner GitHub 圖示。
- 拓撲欄頭改符號 `←層N`/`→層N`＋層0 染色（避免與 palette 的 `←數量` 撞義）；usage popup 右上角加複製鈕。

### 11.8 外掛化（型別＋邊可擴充）
動機：讓別人容易加新資產型別與新邊，而不必動 `scan.js` 核心。把原本 inline 的 meta 衍生邊（atlas/font/particle/spine 三件組）抽成 `src/core/plugins/` 下**一型一檔**的 plugin（每個檔同時帶該型別的 `importerTypes`/`typeByExt`、`edges(ctx)`、`colors`），`index.js` 匯出 `BUILTIN_PLUGINS`／`PLUGINS`（內建即全部，外部 plugin 由呼叫端組合）。

- **介面**：plugin 是純物件 `{ name, importerTypes?, typeByExt?, jsonSourceExts?, rootTypes?, colors?, messages?, edges(ctx)? }`；`edges` **只用 `ctx`**（index＋`addEdge`/`resolveUuid`／`readText`／`mapLimit`／`uuid.*`／唯讀 `scripts`），不 import 任何東西 → 第三方 plugin 零 build step。
- **接線**：`scanProject(fp,{plugins=PLUGINS})` 預設吃 registry，所以 **CLI／node-run／瀏覽器同一套**；`meta.js` 改 `buildTypeResolver(plugins)`＋`knownTypes(plugins)`（移除靜態 `KNOWN_TYPES`/`normalizeType`，baseline `IMPORTER_TYPE` 不含 atlas/font/particle/spine——那些回到各自 plugin）；`analyze.js` 的 root 型別 union `scan.rootTypes`；`ui.js` 把 plugin `colors` 併進 `TYPE_COLOR`、`messages` 經新增的 `registerMessages` 併進 i18n（皆在 `setScan` 首次繪製前）。
- **註冊路徑**（優先序：內建 → 全域 → 專案 → `--plugin`）：內建 → 加檔到 `index.js`；**repo 外**（CLI/node，`src/node/loadPlugins.js`）→ `coir.plugins.mjs` 自動載入(coir 根=跨專案全域、被掃專案根=該專案)＋`--plugin <file>`，皆 gitignore、不進 repo；免 rebuild（瀏覽器）→ `window.coir.use(plugin)`（userscript 可跨專案常駐）。`local.js` 已退場（與 repo 根的 `coir.plugins.mjs` 重疊，後者更乾淨：在 `src/` 外、免 rebuild）。
- **刻意留 core**：JSON `__uuid__`/`__type__` 引擎（3a–3c）與 component 剪枝＋`extends`（3b/3e）耦合太深、不外掛化,但 plugin 可經 `ctx.scripts` 唯讀取用。
- **驗證**：既有 18 個測試逐字綠（atlas/script/prefab/scene 路徑 byte-identical），`npm run build` 通過,另以合成專案確認搬移後的 font/particle/spine 邊（含多頁 atlas→page texture）全數產生。

### 11.9 型別化(JSDoc + `.d.ts`,不改成 `.ts`)
評估過全量 TS,但它會撞到本專案兩條底線(零 runtime 相依、clone 即可直跑 `node src/cli.js`)。改走中間路線:**檔案維持 `.js`,型別走 JSDoc + 一份手寫 `types/index.d.ts`**,只多 `typescript`/`@types/node` 兩個 **devDep**(runtime 仍零相依)。

- **型別**:`types/index.d.ts` 宣告資料模型(`Asset`/`SubAsset`/`Edge`/`EdgeLocation`/`ScanResult`/`Adjacency`)與**外掛契約**(`Plugin`/`PluginContext`),經 `package.json` `"types"` 隨套件 ship——外掛作者一行 `/** @type {import('coir').Plugin} */` 就有 `ctx.addEdge`/`ctx.assets` 的 autocomplete 與檢查。
- **設定**:`tsconfig.json` `allowJs`+`checkJs:false`+`strict:false`+`noEmit`;檢查**逐檔 opt-in** 靠 `// @ts-check`,目前涵蓋全部非瀏覽器檔(`src/core/**`、`src/node/**`);DOM 重的 `src/browser/**` 刻意不檢(投報率低)。`npm run typecheck`=`tsc --noEmit`。
- **不變的**:無 `.ts`、無 loader、無 build step——`node src/cli.js`、`node --test`、webpack 全部照舊;JSDoc 編譯後消失,runtime 不受影響。
- **驗證**:`typecheck` 0 error(並以注入 `ctx.addEge` typo 確認 `// @ts-check` 真的生效、契約型別真的擋得住);`npm test` 18/18、`npm run build` bundle 不變、CLI 直跑不變。之後要收緊就翻 `checkJs:true`/`strict:true` 並補 browser 檔。

### 11.10 repo 外的 plugin 載入 + 拓撲導覽強化
**外部 plugin 載入**(讓 project-specific 規則住在 coir 外):`coir.plugins.mjs` config 從 **coir 根**(全域/跨專案)與**被掃專案根**(該專案)自動載入,加上 `--plugin <檔>`(CLI)與 `window.coir.use()`(瀏覽器 runtime)。CLI/node 走 `src/node/loadPlugins.js`;**瀏覽器**新增:`loadGlobalPlugins`(`webpackIgnore` 動態 import dev server serve 的那份)+ `loadProjectPlugins`(用 File System Access handle 讀被選專案那份、blob URL import,每次選專案重讀)。四個來源由 `dedupePlugins` 收斂(general→specific,同名後者覆蓋),開啟專案後狀態列列出生效的非內建 plugin、標 `來源.名稱`(`global`/`project`/`use`)。

**拓撲/清單導覽**(一連串鍵盤/滑鼠回饋):拓撲 `−`/`+` 上一動/下一動(`navHistory`/`navForward` 的 centre+selection 歷史)、`Delete` 回清單、每個 cell hover 顯示複製完整路徑鈕、同名兄弟列自動補「彼此差異的最短目錄」(`distinguishingDirs`);清單 `↑↓` 鍵盤游標、單擊選中、雙擊/`Enter` 設為中心、切回清單時捲到選中/中心列並閃一下;型別篩選＋搜尋字串持久化到 `localStorage`(`coir.filter`,還原時與專案實際型別取交集)。`Tab` 循環三分頁、`Esc` 清篩選、`Ctrl/⌘+P`=快速搜尋、`Ctrl/⌘+R`=選目錄。

**一輪 code review 修掉的**:`−`/`+` 加 modifier 守門(不攔 `Cmd/Ctrl±` 縮放)、CLI `--plugin` 加 `!startsWith('-')` 守門(不吞後面旗標)、`Esc` 加 typing 判斷(打字中不清篩選)。

---

## 12. 最終狀態

- **形式**：純前端（HTML+JS，無第三方執行期庫，~40KB），Chrome File System Access API 選專案目錄；webpack 打包、`npm run dev` 熱重載；公開於 GitHub＋GitHub Pages（MIT）。
- **名稱**：**Coir**（CLI `coir`）。介面**繁中／English** 可切，首航有歡迎卡 + `?` 說明。
- **三分頁 + 全域型別篩選 bar**：清單（可排序資產表＝層0，含 in/out 與 `∑` 閉包欄）/ 拓撲（雙向 5 欄滑動視窗樹，型別篩選會保留路徑）/ 報告（未使用、孤兒參照、圖集利用率、體積、缺來源檔 meta 審計）。
- **依賴模型**：圖檔、plist/Spine 圖集、fnt、particle、prefab、scene、component，邊含 sprite-frame/texture/script/extends/prefab/anim/font…與 ClickEvent 接線；每條邊帶使用位置（節點路徑·元件.屬性·frame）。來源缺檔的 meta 不索引但仍可追蹤其斷線。
- **無頭工具**：`test/node-run.js`（整份報告回歸）＋ `src/cli.js`（`deps`/`uses`/`closure`/`find`，`--where` 展開位置、`--type` 型別剪枝、`--json` 結構化；`bin` 註冊 `coir`，零執行期相依）。`npm test` 跑 `test/*.test.js`（合成專案、CI-safe，18 個案例）。
- **用法**：瀏覽器版 `npm install && npm run dev` → Chrome 開 `localhost:8080` → 選 Cocos 專案目錄；CLI 版 `npm run cli -- <專案> deps <資產>`（或 `coir …`）。

> 詳細功能與資料模型見 `README.md`；開發指令與擴充方式見本檔上方與 `CLAUDE.md`。

