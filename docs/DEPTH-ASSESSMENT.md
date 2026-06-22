# coir 功能深度評估（Depth Assessment）

> 一次對 coir 自身的「深度體檢」：每個功能**夠不夠深**、有哪些 cap／拒絕／heuristic／缺口。
> 評估方法：**直接讀原始碼驗證**（不採信 README/CLAUDE.md 的宣稱），由四條並行稽核線分別深挖
> 分析側、編輯/驗證側、介面/擴充側，並從 `DEVELOPMENT.md`／`docs/`／程式碼註解收集所有已述限制。
> 評估日期：**2026-06-22**。對應 commit 線：`daccf1c`（skill(edit-verify)）之後。

## 更新（2026-06-22 後續修正）

本評估之後已著手修正的項目（其餘維持上方評分）：

- **動態載入盲區**：仍是最大缺口，**尚未**處理（待內建 `director.loadScene` 預設 recovery ＋ 盲區可見化）。
- **陣列元素結構編輯**：仍為缺口，**尚未**處理。
- **plugin / endpoint 韌性與安全**：✅ `edges()` 已包 try-catch（單一 plugin 拋例外不再拖垮整個 scan，記入 `scan.pluginErrors`）；✅ 專案內 `coir.plugins.mjs` 改為**信任邊界**（`--trust-project-plugins` / `COIR_TRUST_PROJECT_PLUGINS=1` 才載入）；✅ native-verify endpoint 加 **`X-Coir-Token`**（除 `/ready` 外每條路由都要，擋瀏覽器 CSRF 對 `/fixture` 的破壞）。
- **`forbid-dep` 表達力**：✅ 已加 `pathRegex`/`basenameRegex`（regex）、`not`（否定）、`transitive`（間接可達，回報路徑）。
- **roundtrip op 矩陣**：✅ `probeInvertible` 由單一「加/刪節點」擴為**套組**（加/刪節點、加/刪元件、setParent 來回），各自需可逆還原；次要 probe 無法 setup 時跳過、不誤報。
- **CLI 無檔名崩潰**：✅ `verify`/`native-verify` 不帶 `<file>` 改為乾淨用法錯誤（`resolveTarget` null-guard ＋ 指令層檢查）。
- **`refs.js` 死碼**：✅ 已移除 `extractTsImports`/`resolveImportPath`/`walkJsonRefs`。
- **規模（清單/報告截斷）**：✅ 清單表改為 **topo 式視窗虛擬化**（無上限、量測列高、只畫可見列、游標以 model 為準）＋自帶 `Ctrl/⌘+F` 尋找（虛擬化後原生尋找看不到畫面外的列，故比照 topo 自做）；報告各區塊**移除靜默 slice**（預設全部）。
- **圖集利用率位元組級浪費**：✅ `atlasUtilizationReport` 新增 `areaRatio`／`wastedArea`（px²，由 sprite-frame 尺寸算；尺寸未知時為 null），CLI/瀏覽器報告都顯示，排序以浪費面積 tie-break。
- **多 bundle 環偵測**：✅ `bundleCycleGroups`（Tarjan SCC）抓 3+ 環（A→B→C→A），驅動 `no-bundle-cycle` 規則／CLI summary／瀏覽器 banner；pairwise `cycles` 保留相容。
- **CLI／MCP 對齊**：✅ 補上 MCP `native_verify` 工具（與 `coir native-verify` 共用 `nativeVerifyData`）；`deps` 加 `depth` 參數回傳多跳樹（CLI `-o json --depth N` 與 MCP 同形），多跳樹建構移入 seam（`buildEdgeTree`/`pruneTreeByType`/`depsTreeData`，CLI 文字樹也共用、無重複）。

## 總結論

> **coir 的「靜態序列化分析核心」與「既有檔案編輯引擎」確實夠深、而且防禦得很好；
> 深度不足的地方全部集中在系統的『邊緣』——動態參照、陣列結構編輯、多層巢狀 prefab，
> 以及規模／安全／無障礙的收尾。其中唯一會實質影響正確性的真缺口是『動態載入盲區』。**

評分尺度：**深**＝紮實 ／ **夠用**＝堪用但有已知軟肋 ／ **淺**＝能跑但薄 ／ **缺口**＝結構性缺失。

---

## 1. 分析側

| 功能 | 評分 | 理由 |
|---|---|---|
| 靜態依賴圖（`__uuid__`／`__type__`／meta 邊／Spine 多頁／button event） | **深** | 帶 usage location；ClickEvent 拆成 `click→method()`；Spine 多頁從 `.atlas` 解析而非猜檔名 |
| **動態載入參照**（`resources.load`／`director.loadScene`／字串鍵） | **缺口** ⚠️ | 核心完全不追。實測真實無 bundle 專案：**188/358（52%）資產被誤報 unused** |
| script→script `import` 邊 | **淺/缺口** | `refs.js` 的 `extractTsImports`／`walkJsonRefs` 是**死碼、零呼叫者**；目前只有 `extends`＋序列化 `__type__` 連得起腳本 |
| component-script 分類（`.ts` 是否元件） | 夠用 | regex 啟發式有防呆（要求 class context），但同名 class 跨檔會撞、別名 import 會漏 |
| UUID 壓縮/解壓 | **深** | 23/22 兩種形式都對，且解出後一定回查資產索引才建邊（防偽陽） |
| 未使用／孤兒偵測 | 夠用 | 政策設計好（任何 bundle 一律不報 unused、改記 `candidates`）；但精度被動態盲區封頂，入口/autoload 元件會誤報 |
| 圖集利用率 | 夠用 | 只算 `.plist`；`wholeReferenced` 是誠實拒答；但只算**框數比例、尚未算位元組級浪費面積** |
| 重複偵測 A 位元組 | **深** | size 桶 → 32-bit hash → **逐位元組驗證**，hash 碰撞永不偽陽；import 設定不同時標 `mergeable:false` |
| 重複 B 結構 | 夠用 | normalize 後 stable-stringify＋字串精確比對；但**只把 `fileId` 當揮發欄位**，其他每實例揮發欄位未處理 |
| 重複 C 跨圖集 | 夠用 | name＋尺寸啟發式；pixel 確認是 browser-only（核心無解碼，自述為刻意非目標） |
| 重複 D 跨 bundle | 夠用 | build 放置的**靜態近似**（main/resources 視為 priority 0），未對真實 build 驗證 |
| bundle 圖 | 夠用（架構**深**） | 平行圖設計乾淨、可回溯到實際檔案；但**只偵測兩兩互環（A⇄B），3+ 環會漏** |
| CI 規則引擎（`check`） | 夠用 | 13 個 checker、config-error 處理紮實、純引擎/IO 分離乾淨；但 `forbid-dep` 只比**直接邊**、欄位只能 **AND**（無 transitive／regex／否定） |

---

## 2. 編輯 / 驗證側

| 功能 | 評分 | 理由 |
|---|---|---|
| selector 文法（`path:Comp.prop`／`[i]`／`#N`） | **深** | longest-match 白名單＋字面優先＋歧義一律拒絕（不亂猜）；唯一結構限制是無 fileId-stable 定址（`[i]` 依序、會位移） |
| rm-node/component ＋ `__id__` 全域壓縮 | **深** | `ownedClosure`＋`scrubRefs` 是整個引擎最硬的部分（real-delete、無 soft-delete 殘渣） |
| set／set-rot／set-parent／add-node | 夠用→深 | `eulerToQuat` 與引擎逐位元一致；set-parent 拒環/自身；add-node 用 template-by-example clone |
| **陣列元素結構編輯**（insert／remove／reorder array-item） | **缺口** ⚠️ | `set` 只能**取代既有索引或尾端追加**；無法增刪/重排 `clickEvents`／`_materials`——最大的缺漏 op 類別（EDITING.md §12 列為首要 future） |
| 巢狀 prefab P1／P2-root／P3a／P3b | 夠用（單層） | 只支援單一 `fileId`、`sourceInfo` 永遠 `null` |
| **多層巢狀 ＋ instance 內部增刪節點** | **缺口** | `mountedChildren`／`mountedComponents`／`removedComponents` 完全未實作（但**正確拒絕、不會默默寫錯**） |
| set-ref／cross-ref（TargetOverrideInfo／fileId） | 夠用 | P3b 一律 `needsReimport`（inline null）；單層 `localID` only |
| batch 原子性 | **深** | load 一次 → 套 N op → 一次寫；任一失敗什麼都不寫 |
| 防護（mtime guard／atomic write／欄位存在／value-kind） | **深** | 四個 host（CLI／MCP／`--all`）一致套用；唯 value-kind 警告僅 set/set-uuid 有，transforms 無 |
| verify（離線結構） | **深**（結構） | refs-in-range／node↔child↔parent back-ref／null-gap／orphan／`__type__` 可解性全查；本質上看不到引擎語意與 `fileId` 有效性 |
| roundtrip（byte round-trip＋invertible probe） | 夠用但**窄** | 只 probe「加一個再刪一個節點」這組固定 op，沒掃整個 op 矩陣；byte 分歧只是 WARN |
| native-verify（live editor） | 夠用 | 證明「能 import＋引擎建得出節點/元件」，但回讀只比 name/active/有無元件，看不到屬性值與 ref 目標身分；instance 內部跳過 |
| `cc.Nope` 這種拼錯的內建型別 | 小缺口 | 離線一律放行（無內建 cc 元件登錄），只有 native-verify 抓得到 |

---

## 3. 介面 / 擴充側

| 功能 | 評分 | 理由 |
|---|---|---|
| 拓撲視圖（虛擬化／篩選／find） | **深** | 垂直虛擬化＋路徑剪枝＋in-topo find；唯固定 5 欄＋篩選深度 `DEEP=24` 上限（re-centre 為逃生口） |
| 體積樹圖 | **深** | squarified＋手勢縮放＋鍵盤游標＋非同步縮圖，逼近 UE Size Map；`CAP=80`／`MINPX=3` 是合理 DOM 守門 |
| reports／palette／usage | **深** | 報告分頁、palette 多源模糊索引＋虛擬化結果列（舊 100 上限已解除） |
| **清單表 ＋ 報告區塊** | 夠用/淺（規模） | **清單硬上限 1000 列、報告 slice 300/200/100 且未虛擬化**——大專案會被截斷（其餘面都已虛擬化） |
| 快照／viewer | 夠用 | 「永遠回傳連結」的降級很聰明、編碼器跨 Node/browser；但本質是 depth≤5 鄰域、無報告無縮圖、`MAX_BLOB_CHARS=256KB` |
| MCP server | 夠用 | 薄而正確的 zero-dep adapter；傳輸不完整（無 batch／parse-error／cancel／crash 防護）、無 `native_verify` 工具、`deps` 只 1-hop |
| CLI | 夠用 | 介面完整、JSON 可 round-trip 回 `set --json`；但 `verify`／`native-verify` 不帶檔名會**未捕捉 TypeError 噴 stack**（一行可修） |
| plugin 系統 | 讀**深** / 寫有牆 | edges／commands／rules／reports 很強；但**無 edit-op、無自訂 tab、`edges()` 無 try-catch（拋例外會整個 scan 崩）、無沙箱（開不信任專案＝執行任意碼）** |
| cocos extension（3.5–3.8） | 夠用 | 依賴選單（`DEPTH=2`）／goto／native-verify endpoint 實用；但 `/fixture`（增刪資產）**零認證**，sub-3.8 相容是斷言非測試 |
| i18n | **深** | zh-Hant＋en 雙語對稱完整、plugin 可擴充 |
| 無障礙（a11y） | **淺/缺口** | 虛擬化全是不可聚焦 `<div>`、近乎零 ARIA、縮圖無 alt——螢幕報讀器幾乎無法用 |

---

## 4. 真正值得補的缺口（依重要性排序）

### 第一級（會實質影響工具價值）

1. **動態載入盲區 — 唯一的「正確性」缺口。** 實測無 bundle 真實專案造成 **52% 假性 unused**；
   出貨的 `resources-load.mjs` plugin **連 `director.loadScene` 與任何計算路徑都沒涵蓋**，
   使用者得自己逆向載入慣例並手維護映射表。**最低限度該做兩件事**：
   (a) 內建 `director.loadScene` 的預設 recovery；
   (b) 掃出所有 `load(...)` 呼叫點、印一行「偵測到 N 處動態載入無法靜態解析」——
   **讓使用者知道分析少了多少**，而不是默默把資產報成死的。

2. **陣列元素的結構編輯（add／remove／reorder array-item）。**
   編輯引擎最大的缺漏 op 類別——目前無法對 `clickEvents`／`_materials` 這類陣列增刪重排，只能取代既有索引或尾端追加。

### 第二級（真實但較窄）

3. **多層巢狀 prefab ＋ instance 內部增刪**（目前正確拒絕、不會寫錯，但是個天花板）。
4. **plugin / endpoint 安全與韌性**：`edges()` 包 try-catch（避免單一 plugin 拖垮整個 scan）、
   開專案自動執行 `coir.plugins.mjs` 的信任邊界、native-verify `/fixture` 破壞性路由加 token。
5. **規模**：清單表與報告區塊虛擬化（目前 1000 列上限／300-200-100 slice）。

### 第三級（收尾）

6. `forbid-dep` 加 transitive／regex／否定；多 bundle 環偵測；roundtrip 擴到整個 op 矩陣；
   圖集位元組級浪費；無障礙 ARIA；CLI 無檔名崩潰（一行修）；
   清掉 `refs.js` 死碼（或把 script-import 邊真的接起來）。

---

## 5. 底線

- **核心兩塊夠深**：靜態序列化分析（UUID 處理、位元組去重、編輯的 `__id__` 壓縮、四 host 一致的寫入防護）
  是最紮實、防禦最完整的部分，配 verify／roundtrip／native-verify 三層驗證，工程品質高。
- **深度不足都在邊緣**：動態參照、陣列結構編輯、多層巢狀、規模/安全/a11y——
  正是「靜態、zero-dep、單人開發工具」典型會少投資的地方。
- **唯一該優先處理的是動態載入盲區**：它不是收尾問題，是會讓 unused／拓撲結果「安靜地不完整」的結構性限制。
  文件很誠實地一直點名它，但**出貨預設的覆蓋率幾乎是 0**——把這塊從「全推給使用者寫 plugin」
  改成「內建常見 idiom ＋ 明確標示缺多少」，CP 值最高。

---

## 附錄：關鍵程式碼證據（file:line）

直接讀原始碼得到的、支撐上面評分的最具代表性位置（非窮舉）：

**分析側**
- 動態載入：核心無任何 load 啟發式；唯一 string-load 邏輯在 `test/dynamic-edges.test.js` 與外部 coir-plugins；`docs/DYNAMIC-EDGES.md` 自述為唯一 inherent limitation。
- 死碼：`src/core/refs.js` 的 `extractTsImports`／`resolveImportPath`／`walkJsonRefs` 全無呼叫者（被 `extractContextRefs` 取代）。
- usage location 重建：`src/core/refs.js:43-83`（`_parent` 鏈爬升、cycle guard `guard<500`、ClickEvent `click→method()`）。
- component 分類 regex 與 fixpoint：`src/core/scan.js:227,236,241-248`（同名 class `definers` 撞號於 `:236/:285`）。
- UUID 防偽陽回查：`src/core/scan.js:189-193`、`src/core/uuid.js:42-57,82`。
- unused 政策：`src/core/analyze.js:21-76`（bundle → `candidates`）；root types 僅 scene＋plugin（`:12`）。
- 圖集利用率：`src/core/analyze.js:79-110`（`wholeReferenced` 拒答 `:82-84,103`）。
- 去重 A 逐位元組驗證：`src/core/duplicates.js:43-51,103-125`；B 只 strip `fileId`：`:139-147`；C heuristic 自述：`src/core/plugins/spine.js:30,115`、`atlas.js:29`；D 近似＋priority：`src/core/analyze.js:146-178`、`scan.js:78`。
- bundle 平行圖不入 `scan.edges`：`src/core/bundleGraph.js`；只兩兩環：`analyze.js:201-207`。
- rules 13 checker＋config-error：`src/core/rules.js:29-116,159-173`；`forbid-dep` matcher AND-only：`:18-26`。

**編輯/驗證側**
- selector：`src/edit/editPrefab.js:118-174`（`#N`／字面優先／longest-match／`[i]` 拒歧義 `:136,146,166`）。
- 陣列 op：`src/edit/ops.js:180-343`；`setDeep` 取代/追加、gap `>len` 拒絕：`editPrefab.js:268`。
- rm 壓縮：`ownedClosure`/`scrubRefs`/`removeEntries` `editPrefab.js:392-498`。
- 巢狀拒絕集：`editableGuard`/`instanceWrite`/`subtreeHasInstance` `ops.js:146-159,315`；單層 `localID`/`sourceInfo:null` `editPrefab.js:754,759,796,800`。
- 防護：`writeAtomic`/mtime `editPrefab.js:62-72`；`missingObjectProp`/`valueKind` `ops.js:40-76,208,272`。
- verify 範圍與盲點：`verifyDoc` `editPrefab.js:595-656`（`cc.*` 略過 `:650`）；`localID`/`fileId` 不可驗：`docs/NESTED-PREFABS.md §9`。
- roundtrip 單組 op：`probeInvertible` `editPrefab.js:705-719`；`auditRoundtripData` `ops.js:484-523`。
- native-verify：`src/editCli.js:291-347`（跳過 `#index` `:318`、跳過 instance 內部 `:321,335`）；endpoint 在 `cocos-extension/`。

**介面/擴充側**
- topo 虛擬化＋上限：`src/browser/topo.js:190,218-220`（`ROW_H=30`、5 欄、`DEEP=24`）。
- sizemap cap：`src/browser/sizemap.js:19-20`（`CAP=80`、`MINPX=3`）。
- 清單/報告未虛擬化截斷：`src/browser/list.js:21`（`cap=1000`）、`reports.js:76,79,83,107`（300/200/100）。
- 快照 cap：`src/core/topohash.js:20,134-146`（`MAX_BLOB_CHARS=256KB`、自動降 depth）。
- MCP 傳輸：`src/mcp/server.js:46-48,109,139-143`（debounce 150ms、cancel no-op、parse-error `catch{return}`）。
- CLI 無檔名崩潰：`src/seam/shared.js:30-31`（`query.includes('@')` on undefined）。
- plugin 牆：唯一 pipeline hook `src/core/scan.js:277`（無 try-catch）；rule ctx 無 `readText`：`types/index.d.ts:236`。
- extension：`cocos-extension/assets-menu.js:13`（`DEPTH=2`）；`/fixture` 無認證：`main.js:165`。
- a11y：`index.html` 僅 4 個 ARIA、`src/browser/` 僅 2 個 `aria-label`；topo cell 無 `role/tabindex`：`topo.js:176`。

> 注：`docs/DYNAMIC-EDGES.md`（動態載入限制與 plugin 配方）、`docs/EDITING.md §12`（array-item 等 future）、
> `DEVELOPMENT.md §11.22/§12`（bundle A4/dynamic C、CI rules future-work）是這些缺口的官方來源；本文是它們的一次集中評估。
