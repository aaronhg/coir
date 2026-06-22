# coir 功能深度評估（Depth Assessment）

> 一次對 coir 自身的「深度體檢」：每個功能**夠不夠深**、有哪些 cap／拒絕／heuristic／缺口。
> 評估方法：**直接讀原始碼驗證**（不採信 README/CLAUDE.md 的宣稱）。
> 原始稽核：**2026-06-22**（commit 線 `daccf1c` 之後）。本檔已隨後續修正**刷新**（見「本輪修正」）。
>
> **範圍說明：動態載入盲區不列為缺口。** 靜態分析**刻意**不追執行期載入
> （`resources.load`／`director.loadScene`／字串鍵／config 表）——這是設計決定，不是缺陷。
> 恢復某條動態邊是**專案慣例**問題，交給 per-project plugin（`docs/DYNAMIC-EDGES.md` 的 recipe
> ＋外部 coir-plugins 的 `resources-load`）。核心保持 zero-heuristic、可預測。下面的評估在此前提下進行。

## 本輪修正（changelog，相對原始稽核）

- **陣列元素結構編輯**：✅ 完成——`add-array-item`/`rm-array-item`/`reorder-array`
  （value/uuid/ref/clone/`--class` stub/`--json`；rm 會 GC 被孤立的 owned 物件、絕不碰仍被引用的
  node/component；kind 不符給非阻擋警告），CLI＋MCP＋batch；離線＋live 編輯器＋edge case 全驗
  （`docs/EDITING.md §11b`、edit-verification `PLAN-array.md`/`RESULTS-array.md`）。
- **規模（清單/報告截斷）**：✅ 清單表改 **topo 式視窗虛擬化**（無上限、量測列高、只畫可見列、
  游標以 model 為準）＋自帶 `Ctrl/⌘+F` 尋找；報告各區塊**移除靜默 slice**（預設全部）。
- **圖集位元組級浪費**：✅ `atlasUtilizationReport` 加 `areaRatio`／`wastedArea`（px²）。
- **多 bundle 環**：✅ `bundleCycleGroups`（Tarjan SCC）抓 3+ 環，驅動規則／CLI／瀏覽器 banner。
- **`forbid-dep` 表達力**：✅ 加 `pathRegex`/`basenameRegex`（regex）、`not`（否定）、`transitive`（間接可達＋路徑）。
- **roundtrip op 矩陣**：✅ `probeInvertible` 擴為**套組**（加/刪節點、加/刪元件、setParent 來回）。
- **CLI／MCP 對齊**：✅ MCP 補 `native_verify` 工具（與 CLI 共用 `nativeVerifyData`）；`deps` 加 `depth`
  多跳樹（CLI/MCP 同形，建構移入 seam，無重複）。
- **plugin／endpoint 韌性與安全**：✅ `edges()` 包 try-catch（單一 plugin 拋例外記入 `scan.pluginErrors`、不拖垮 scan）；
  ✅ 專案 `coir.plugins.mjs` 加信任開關（預設載入；`--no-trust-project-plugins`/`COIR_TRUST_PROJECT_PLUGINS=0` 退出）；
  ✅ native-verify endpoint 加 `X-Coir-Token`（除 `/ready` 外全要，擋瀏覽器 CSRF 打 `/fixture`）。
- **CLI 無檔名崩潰**：✅ `verify`/`native-verify` 不帶 `<file>` 改乾淨用法錯誤。
- **`refs.js` 死碼**：✅ 移除 `extractTsImports`/`resolveImportPath`/`walkJsonRefs`。

## 總結論

> **coir 的「靜態序列化分析核心」與「既有檔案編輯引擎」確實夠深、防禦完整。動態載入是刻意交給
> per-project plugin（非核心缺口）。本輪修正後，剩下的真缺口只剩兩處：**①** 多層巢狀 prefab 的
> instance-內部結構編輯（目前正確拒絕、不會寫錯，但是個天花板）；**②** 瀏覽器無障礙（a11y）。**
> 其餘多為「夠用、可再深」的收尾。

評分尺度：**深**＝紮實 ／ **夠用**＝堪用但有已知軟肋 ／ **淺**＝能跑但薄 ／ **缺口**＝結構性缺失。

---

## 1. 分析側

| 功能 | 評分 | 理由 |
|---|---|---|
| 靜態依賴圖（`__uuid__`／`__type__`／meta 邊／Spine 多頁／button event） | **深** | 帶 usage location；ClickEvent 拆成 `click→method()`；Spine 多頁從 `.atlas` 解析 |
| 動態載入參照（`resources.load`／`director.loadScene`／字串鍵） | **設計（plugin）** | 刻意不追；由 per-project plugin 補（見頂部範圍說明）。靜態看不到＝預期行為，非缺口 |
| script→script `import` 邊 | 淺（低優先） | 只有 `extends`＋序列化 `__type__` 連腳本；純 import 邊未建（對資產依賴不重要；死碼已清） |
| component-script 分類（`.ts` 是否元件） | 夠用 | regex 啟發式有防呆（要求 class context）；同名 class 跨檔會撞、別名 import 會漏 |
| UUID 壓縮/解壓 | **深** | 23/22 兩形式都對，解出後一定回查資產索引才建邊（防偽陽） |
| 未使用／孤兒偵測 | 夠用 | 政策好（任何 bundle 不報 unused、改記 `candidates`）；精度上限取決於動態邊由 plugin 補足多少 |
| 圖集利用率 | 夠用→**深** ✅ | 框數比例 **＋** 面積加權（`areaRatio`/`wastedArea` px²）；`wholeReferenced` 仍誠實拒答 |
| 重複偵測 A 位元組 | **深** | size 桶 → hash → **逐位元組驗證**，永不偽陽；import 設定不同標 `mergeable:false` |
| 重複 B 結構 | 夠用 | normalize＋stable-stringify 精確比對；但**只把 `fileId` 當揮發欄位** |
| 重複 C 跨圖集 | 夠用 | name＋尺寸啟發式；pixel 確認 browser-only（核心無解碼，自述刻意非目標） |
| 重複 D 跨 bundle | 夠用 | build 放置的**靜態近似**（main/resources 視為 priority 0），未對真實 build 驗證 |
| bundle 圖 | **深** ✅ | 平行圖乾淨、可回溯到實際檔案；**3+ 環**（SCC `cycleGroups`）已抓，不只兩兩互環 |
| CI 規則引擎（`check`） | 夠用→**深** ✅ | 13+ checker、config-error 紮實；`forbid-dep` 已具 regex／否定／transitive（dependency-cruiser 級） |

---

## 2. 編輯 / 驗證側

| 功能 | 評分 | 理由 |
|---|---|---|
| selector 文法（`path:Comp.prop`／`[i]`／`#N`） | **深** | longest-match 白名單＋字面優先＋歧義拒絕；唯一限制是無 fileId-stable 定址（`[i]` 會位移） |
| rm-node/component ＋ `__id__` 全域壓縮 | **深** | `ownedClosure`＋`scrubRefs` 是引擎最硬的部分（real-delete、無殘渣） |
| set／set-rot／set-parent／add-node | 夠用→深 | `eulerToQuat` 與引擎逐位元一致；set-parent 拒環/自身；template-by-example clone |
| **陣列元素結構編輯**（add/rm/reorder array-item） | **深/夠用** ✅ | 三個 op 完成；value/uuid/ref/clone/`--class`/`--json`；rm GC owned-孤兒、不碰共享；`--class`/含 fileId 的 clone 標 `needsReimport`；live＋edge-case 全驗 |
| 巢狀 prefab P1／P2-root／P3a／P3b | 夠用（單層） | 只支援單一 `fileId`、`sourceInfo` 永遠 `null` |
| **多層巢狀 ＋ instance 內部增刪節點** | **缺口** ⚠️ | `mountedChildren`／`mountedComponents`／`removedComponents` 未實作（但**正確拒絕、不會默默寫錯**）——剩下最大的編輯天花板 |
| set-ref／cross-ref（TargetOverrideInfo／fileId） | 夠用 | P3b 一律 `needsReimport`（inline null）；單層 `localID` only |
| batch 原子性 | **深** | load 一次 → 套 N op → 一次寫；任一失敗什麼都不寫 |
| 防護（mtime／atomic／欄位存在／value-kind） | **深** | 四 host 一致；`set`/`set-uuid`/array-item 都有 kind 警告（transforms 走旗標 arity） |
| verify（離線結構） | **深**（結構） | refs-in-range／back-ref／null-gap／orphan／`__type__` 可解性全查；本質看不到引擎語意與 `fileId` 有效性 |
| roundtrip（byte round-trip＋invertible probe） | 夠用→**深** ✅ | probe 已是**套組**（node/component/setParent 來回）；byte 分歧仍只 WARN |
| native-verify（live editor） | 夠用 | 證明「能 import＋引擎建得出節點/元件」；回讀只比 name/active/有無元件＋owned `<type>`，看不到屬性值與 ref 目標身分；instance 內部跳過 |
| `cc.Nope`／拼錯型別 | 小缺口 | 離線一律放行（無內建 registry）；`--class` stub 同此風險，只有 native-verify 抓得到 |

---

## 3. 介面 / 擴充側

| 功能 | 評分 | 理由 |
|---|---|---|
| 拓撲視圖（虛擬化／篩選／find） | **深** | 垂直虛擬化＋路徑剪枝＋in-topo find；固定 5 欄＋`DEEP=24`（re-centre 為逃生口） |
| 體積樹圖 | **深** | squarified＋手勢縮放＋鍵盤游標＋非同步縮圖；`CAP=80`／`MINPX=3` 是合理守門 |
| reports／palette／usage | **深** | 報告分頁、palette 多源模糊索引＋虛擬化結果列 |
| 清單表 ＋ 報告區塊 | **深** ✅ | 清單改 topo 式視窗虛擬化（無上限）＋自帶 find；報告移除靜默 slice |
| 快照／viewer | 夠用 | 降級聰明、跨 Node/browser 編碼器；本質 depth≤5 鄰域、無報告無縮圖、`MAX_BLOB_CHARS=256KB` |
| MCP server | 夠用 | 薄而正確的 zero-dep adapter；已補 `native_verify`＋`deps depth`；傳輸仍不完整（無 batch／parse-error／cancel／crash 防護） |
| CLI | 夠用 | 介面完整、JSON 可 round-trip；無檔名崩潰已修 |
| plugin 系統 | 讀**深** / 寫有牆 | edges／commands／rules／reports 強；`edges()` 已包 try-catch；但**無 edit-op、無自訂 tab、rule ctx 無 I/O**（仍是設計牆） |
| cocos extension（3.5–3.8） | 夠用 | 依賴選單／goto／native-verify endpoint 實用；`/fixture` 已加 token；sub-3.8 相容仍是斷言非測試 |
| i18n | **深** | zh-Hant＋en 雙語對稱完整、plugin 可擴充 |
| 無障礙（a11y） | **淺/缺口** ⚠️ | 虛擬化全是不可聚焦 `<div>`、近乎零 ARIA、縮圖無 alt——螢幕報讀器幾乎無法用 |

---

## 4. 剩下值得補的缺口（排除動態載入＝plugin；已完成項見「本輪修正」）

### 第一級（真缺口）
1. **多層巢狀 prefab ＋ instance 內部結構編輯**：`mountedChildren`/`mountedComponents`/`removedComponents`
   未實作；多層 `localID`、`sourceInfo` 也未支援。目前一律**正確拒絕**（不會寫錯），但要做這類編輯只能回 Cocos 編輯器。這是編輯引擎剩下最大的天花板。
2. **瀏覽器無障礙（a11y）**：虛擬化 UI 全是不可聚焦 `<div>`、近乎零 ARIA、縮圖無 alt。鍵盤操作雖豐富，但建在非聚焦元素上，螢幕報讀器跟不上。

### 第二級（夠用、可再深）
3. **native-verify 回讀粒度**：只比 name/active/有無元件＋owned `<type>`，看不到屬性值與 ref 目標身分（runtime uuid 不可映射）；instance 內部跳過。
4. **重複偵測**：B 只把 `fileId` 當揮發欄位；D 是 build 放置的靜態近似（未對真實 build 驗證）。
5. **MCP 傳輸完整度**：無 batch／parse-error／cancel／process-crash 防護（薄而堪用）。
6. **快照**：depth≤5 鄰域、無報告無縮圖、256KB 上限。
7. **`cc.Nope`／`--class` 拼錯型別離線無法判定**（無 registry）；靠 native-verify 抓。
8. extension sub-3.8 相容是斷言非測試；script→script import 邊（低優先）。

---

## 5. 底線

- **核心兩塊夠深**：靜態序列化分析（UUID 處理、位元組去重、編輯的 `__id__` 壓縮、四 host 一致的寫入防護）
  配 verify／roundtrip／native-verify 三層驗證，工程品質高；本輪又補上陣列結構編輯、規模虛擬化、
  forbid-dep、roundtrip 套組、CLI/MCP 對齊、plugin/endpoint 韌性。
- **動態載入交給 plugin 是設計，不是缺口**：核心保持可預測、zero-heuristic；要恢復哪條動態邊由專案慣例決定。
- **剩下的真缺口只剩兩處**：多層巢狀 prefab 的 instance-內部結構編輯（編輯天花板）、與瀏覽器 a11y。
  其餘是「夠用、可再深」的收尾（native-verify 回讀粒度、dedup B/D 近似、MCP 傳輸、快照）。

---

## 附錄：關鍵程式碼證據（file:line）

> 注：以下多為 **2026-06-22 原稽核**時的位置；本輪修正後，標 ✅ 的項目位置已變動（陣列 op 新增於
> `editPrefab.js`/`ops.js`；`refs.js` 死碼已移除；清單已虛擬化；`forbid-dep`/`bundleCycleGroups`/
> `atlasUtilizationReport`/`probeInvertible`/`nativeVerifyData` 皆已擴充）。仍保留作為原始評分依據。

**分析側**
- 動態載入：核心無 load 啟發式（設計）；plugin recipe 在 `docs/DYNAMIC-EDGES.md`＋外部 coir-plugins `resources-load`。
- usage location 重建：`src/core/refs.js`（`_parent` 鏈爬升、cycle guard、ClickEvent `click→method()`）。
- component 分類 regex 與 fixpoint：`src/core/scan.js`（同名 class `definers` 撞號）。
- UUID 防偽陽回查：`src/core/scan.js:189-193`、`src/core/uuid.js`。
- unused 政策：`src/core/analyze.js`（bundle → `candidates`）。
- 圖集利用率＋面積：`src/core/analyze.js` `atlasUtilizationReport`（`frameArea`/`areaRatio`/`wastedArea`；`wholeReferenced` 拒答）。
- 去重 A 逐位元組驗證 / B 只 strip `fileId` / C heuristic / D 近似：`src/core/duplicates.js`、`src/core/analyze.js`、`src/core/plugins/{spine,atlas}.js`。
- bundle 平行圖＋SCC 環：`src/core/bundleGraph.js`（`bundleCycleGroups`）、`src/core/analyze.js` `bundleReport`。
- rules＋`forbid-dep`（regex/not/transitive）：`src/core/rules.js`。

**編輯/驗證側**
- selector：`src/edit/editPrefab.js`（`#N`／字面優先／longest-match／`[i]` 拒歧義）。
- 陣列 op：`src/edit/editPrefab.js` `reorderArray`/`rmArrayItem`/`addArrayItem`、`src/edit/ops.js` `applyArrayOp` 三 case；`rmArrayItem` 重用 `ownedClosure`+`removeEntries` GC 孤兒。
- rm 壓縮：`ownedClosure`/`scrubRefs`/`removeEntries`（`editPrefab.js`）。
- 巢狀拒絕集：`editableGuard`/`instanceWrite`/`subtreeHasInstance`（`ops.js`）；單層 `localID`/`sourceInfo:null`（`editPrefab.js` `setCrossRef`/`setRootOverride`）。
- 防護：`writeAtomic`/mtime（`editPrefab.js`）；`missingObjectProp`/`valueKind`（`ops.js`）。
- verify／roundtrip 套組：`verifyDoc`/`probeInvertible`（`editPrefab.js`，套組含 node/component/setParent）、`auditRoundtripData`（`ops.js`）。
- native-verify：`src/verify/nativeVerify.js` `nativeVerifyData`（CLI `cmdNativeVerify` ＋ MCP `native_verify` 共用）；endpoint 在 `cocos-extension/`（`X-Coir-Token`）。

**介面/擴充側**
- topo 虛擬化：`src/browser/topo.js`（`ROW_H=30`、5 欄、`DEEP=24`）。
- sizemap cap：`src/browser/sizemap.js`（`CAP=80`、`MINPX=3`）。
- 清單虛擬化＋find：`src/browser/list.js`（`paintList`/spacer/`runListFind`）；報告移除 slice：`src/browser/reports.js`。
- 快照 cap：`src/core/topohash.js`（`MAX_BLOB_CHARS=256KB`）。
- MCP 傳輸：`src/mcp/server.js`（debounce 150ms、cancel no-op、parse-error `catch{return}`）。
- plugin 牆：唯一 pipeline hook `src/core/scan.js`（已包 try-catch → `scan.pluginErrors`）；rule ctx 無 `readText`：`types/index.d.ts`。
- extension：`cocos-extension/assets-menu.js`（`DEPTH=2`）；`/fixture` token：`cocos-extension/main.js`。
- a11y：`index.html` 寥寥 ARIA、`src/browser/` 近乎無 `aria-*`、虛擬化 cell 無 `role/tabindex`。

> 缺口的官方來源文件：`docs/DYNAMIC-EDGES.md`（動態載入＝plugin）、`docs/NESTED-PREFABS.md`（多層巢狀）、
> `docs/EDITING.md §11b`（array-item，已完成）。
