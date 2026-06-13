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

---

## 12. 最終狀態

- **形式**：純前端（HTML+JS，無第三方執行期庫，~27KB），Chrome File System Access API 選專案目錄；webpack 打包、`npm run dev` 熱重載。
- **三分頁 + 全域型別篩選 bar**：清單（可排序資產表＝層0，含 in/out 與 `∑` 閉包欄）/ 拓撲（雙向 5 欄滑動視窗樹，型別篩選會保留路徑）/ 報告（未使用、孤兒參照、圖集利用率、體積、缺來源檔 meta 審計）。
- **依賴模型**：圖檔、plist/Spine 圖集、fnt、particle、prefab、scene、component，邊含 sprite-frame/texture/script/extends/prefab/anim/font…與 ClickEvent 接線；每條邊帶使用位置（節點路徑·元件.屬性·frame）。來源缺檔的 meta 不索引但仍可追蹤其斷線。
- **無頭工具**：`test/node-run.js`（整份報告回歸）＋ `src/cli.js`（`deps`/`uses`/`closure`/`find`，`--where` 展開位置、`--type` 型別剪枝、`--json` 結構化；`bin` 註冊 `coir`，零執行期相依）。`npm test` 跑 `test/*.test.js`（合成專案、CI-safe，18 個案例）。
- **用法**：瀏覽器版 `npm install && npm run dev` → Chrome 開 `localhost:8080` → 選 Cocos 專案目錄；CLI 版 `npm run cli -- <專案> deps <資產>`（或 `coir …`）。

> 詳細功能與資料模型見 `README.md`；開發指令與擴充方式見本檔上方與 `CLAUDE.md`。

