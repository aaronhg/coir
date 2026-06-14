# Headless CLI 編輯 prefab / scene

> coir 的讀取核心是唯讀的;這頁是它的**就地編輯功能**:用 CLI 改既有的 Cocos prefab/scene 檔——**不憑空產生**,只編輯現有的。實作於 `src/editCli.js`(指令層)+ `src/edit/editPrefab.js`(寫入引擎)。格式契約見 [SERIALIZATION.md](SERIALIZATION.md)。

適用 **Cocos Creator 3.5.2 / 3.8.x**,同一條程式路徑(原因見 §2)。

## 0. 設計決策

- **只編輯既有檔**;不提供「從零產生 prefab」。
- **刪除 = 真刪 + 索引壓縮**(不軟刪、不留陣列垃圾)。
- **值型別 = 顯式旗標**(`--color` / `--vec3` / `--json` …,不自動推斷)。
- core 維持 DOM-free 唯讀;寫入只活在 Node 層(`editPrefab.js`)。
- 顯示與 selector 共用同一套定址(`nodePath:Comp.prop`),`--where`/web 印出來可直接貼進 `edit`。

## 1. 設計原則

1. **外科手術式** — parse 成陣列 → 只動目標 → 寫回,未觸碰物件儘量不變。
2. **Template-by-example** — 需要新增結構欄位(`PrefabInfo`/`CompPrefabInfo`/`_mobility`/`__editorExtras__`…)時,**複製同檔既有同類物件的骨架**再填值,只重設身分欄位。檔案自己教我們它的格式 → **3.5.2/3.8.x 自動正確、零版本分支**。
3. **真刪 + 索引壓縮** — 刪節點/元件後從陣列移除,全域 remap 所有 `{__id__}`,清懸空跨引用、收回被孤立的 sub-object。
4. **定址 = selector**(`nodePath:Comp.prop`),跟 `--where`/web 顯示同一套(`src/core/selector.js`)。
5. **dry-run 預覽** — 每個寫操作可 `--dry-run`,只定位不寫。

## 2. 為什麼跨版本幾乎免費

- coir 的 `meta.js`/`scan.js` **無任何版本分支**,靠 `importer`/`uuid`/`subMetas` 通用解析 → 讀取/定位本來就版本無關。
- 序列化三要素 `__id__`/`__uuid__`/壓縮 `__type__` 從 3.0→3.8 穩定;版本差異是「加欄位」非「改表示法」。
- 既然只改既有、保留其餘,新增欄位不影響我們;新增結構靠 template-by-example。
- **唯一**殘留的版本敏感點:enum 屬性的數值語義可能跨版不同 → `--enum` 由使用者負責,不自動轉換。

## 3. 定址模型(selector)

| 選取對象 | 語法 | 範例 |
|---|---|---|
| 節點 | `<nodePath>` | `Canvas/Panel/Title` |
| 同名消歧(兄弟序) | `<nodePath>[i]` | `Canvas/Item[2]` |
| 絕對索引(逃生口) | `#<arrayId>` | `#14`、`#4._string` |
| 元件 | `<nodePath>:<Type>` | `Canvas/Title:cc.Label`、`Player:ShopCtrl`(自訂腳本按類名) |
| 多同型元件 | `<nodePath>:<Type>[i]` | `Fx:cc.Sprite[1]` |
| 屬性(可巢狀) | `<nodePath>:<Type>.<prop>` | `Canvas/Title:cc.Label._string`、`Bg:cc.Sprite._color.r` |
| 陣列元素 | `…<prop>[i]`(或 `.<i>`) | `Btn:cc.Button.clickEvents[0].handler` |

**統一索引規則**:`[i]` 是 **0-based、陣列順序**的「相對」索引,出現在三個位置且語義一致——同名節點(leaf)、同型元件、陣列元素;`#N` 是**絕對陣列索引逃生口**(跳過所有比對,直接 `arr[N]`,可帶 `.prop`)。`prop[i]` 在 `setDeep` 正規化成 `prop.i`,故 `[i]` 與 `.i` 兩種寫法皆可。

**幾個解析規則:**
- **分隔符 `:`**(非 `@`):`@` 保留給 `uuid@sub`(子資產);選擇器用 `:` 表「節點的元件」,語義不重疊。
- **型別 `.` 與屬性 `.` 用白名單消歧**:`cc.Label` 自帶命名空間點,會跟屬性點相撞。解析時拿 scan 已知「該節點實際掛了哪些元件 `__type__`」當白名單,對 `:` 之後做**最長比對**(`cc.Label` 命中即型別,剩下 `_string` 即屬性)。自訂腳本以解壓 `__type__` 後的類名進白名單。
- **完整路徑優先**:先試 nodePath 字面完全匹配(節點若真叫 `Slot[0]` 能選到),再退回剝尾端 `[i]`。
- 解析不唯一 → **exit 2** 列候選。
- **歧義一律報錯(不靜默猜)**:`[i]` 省略且有多個匹配時——同名節點 *或* 同型多元件——都 **exit 2** 要求補 `[i]`(節點與元件一致)。單一匹配則直接命中,無需 `[i]`。

## 4. 值編碼(顯式旗標)

`set` / 節點 op 的值一律用旗標明示型別,**不推斷**:

| 旗標 | 產生 | 範例 |
|---|---|---|
| `--str <s>` | JSON 字串 | `--str "Hello"` |
| `--int <n>` / `--num <n>` / `--enum <n>` | 整數 / 浮點 / enum(語義使用者負責) | `--int 3` |
| `--bool <true\|false>` | 布林 | `--bool false` |
| `--color #RRGGBB[AA]` 或 `--color r g b a` | `cc.Color`(非法 hex → 報錯) | `--color #ff0000ff` |
| `--vec2/--vec3/--vec4 …` / `--size w h` / `--quat …` | 對應 `cc.*` 包裝型別 | `--vec3 0 0 1` |
| `--uuid <asset>` | `{__uuid__:…}`(經 `resolveAsset`;沒給資產 → 報錯) | `--uuid icons/coin.png` |
| `--null` | `null`(清除) | |
| `--json '<json>'` | 整顆物件/陣列/值;`__type__` 若是**類名**自動轉壓縮 token(builtin / 已壓縮 passthrough;未知類名 → 報錯) | `--json '{"__type__":"SpriteConfig","frameName":"x"}'` |

每個值旗標只吃自己 arity 的 token(`--vec3`=3、`#hex`=1…),不吞後續位置參數。

### 自訂型別(`SpriteConfig` 之類)

自訂序列化值在檔裡就是個 `{__type__:"<壓縮>", 欄位...}` 物件:
- **改欄位**:`set "…:Comp._cfg.frameName" --str x`、`._cfg.keys[0] --str y`(`__type__` 自動保留)。
- **整顆換/建**:`--json '{"__type__":"SpriteConfig",…}'`(類名自動轉壓縮 token)。
- 若該值是獨立 entry(`{__id__:N}`)而非 inline:用 `#N.frameName` 定址。

## 5. 操作目錄

共用旗標:`--dry-run`(只定位不寫)・`--backup`(寫前存 `.bak`)・`-o json`(結構化輸出;預設 text)。

### Tier 0 — 資產引用層(文字補丁、最小 diff、版本無關)
| 指令 | 作用 |
|---|---|
| `swap-uuid <oldAsset> <newAsset>` | 全檔重指引用 A→B(含 `A@sub`→`B@sub`;`old===new` 為 no-op) |

### 探索 — `tree`(唯讀,結構發現)
| 指令 | 作用 |
|---|---|
| `tree [--with <Type>] [--under <sel>] [--depth N]` | 列出節點階層 + 每節點的元件,**每條 path / selector 都已消歧、可直接貼回其他 op**(同名兄弟自動補 `[i]`、同型多元件補 `[i]`、自訂腳本顯示類名)。`-o json` 給 agent(每個元件附現成 `nodePath:Type` selector);`--with` 只留掛某元件的節點、`--under` 限定子樹、`--depth` 限層數(預設整棵)。標出 `(off)` 停用節點、`[prefab instance]` 巢狀實例 |

> `tree` 是「盲改」的解法:agent 不必 parse JSON 就能拿到任何 prefab 的全部可編輯 selector(`tree` 探索 → `get` 細讀 → `set`/結構 op 改,三段式)。`--with` 也讓「跨檔依型別改」變成乾淨 pipeline(`find .prefab` → 逐檔 `tree --with cc.Label -o json` → `set`)。

### Tier 1 — 屬性值層(parse-rewrite)
| 指令 | 作用 |
|---|---|
| `get <sel>` | **唯讀** —— 讀某 selector 的值/節點/元件。`-o json` 印原始值(可直接餵回 `set --json`);text 形式會把 `{__uuid__}` 標出資產路徑、把壓縮 `__type__` 標出類名 |
| `set <sel:Type.prop> <值旗標>` | 改基本值 / enum / 包裝型別 / `--json` 自訂物件 |
| `set-uuid <sel:Type.prop> <asset>` | 把某屬性指到某資產(清除用 `set … --null`) |

> `get`/`set` 是讀寫對:`coir edit X.prefab get "A:Comp._cfg" -o json` 拿到的物件,改完可用 `set "A:Comp._cfg" --json '<那串>'` 寫回(壓縮 `__type__` passthrough,閉環)。

### Tier 2 — 節點層(parse-rewrite)
| 指令 | 作用 |
|---|---|
| `rename <nodeSel> <newName>` | 改 `_name`(允許 `''`) |
| `set-active <nodeSel> --bool <b>` | 改 `_active` |
| `set-layer <nodeSel> --int <n>` | 改 `_layer` |
| `set-pos / set-scale <nodeSel> --vec3 x y z` | 改 `_lpos`/`_lscale` |
| `set-rot <nodeSel> --vec3 x y z`(歐拉度) | 同時寫 `_euler` + `_lrot`(四元數,公式與引擎 `Quat.fromEuler` 位元一致) |
| `set-parent <nodeSel> <newParentSel> [--index i]` | reparent(改兩邊 `_children` + `_parent`;拒循環/根) |

每個節點 op 會檢查值旗標型別(`set-pos` 只收 `--vec3`…),型別不符直接報錯,避免把純量塞進 Vec3 欄位。

### Tier 3 — 結構增刪(template-by-example + 索引壓縮)
| 指令 | 作用 |
|---|---|
| `add-node <parentSel> <name> [--index i]` | append 節點(複製同檔骨架)+ 其 PrefabInfo(重設 root/asset/…) |
| `rm-node <nodeSel>` | **真刪**子樹 + 各元件 + Prefab/CompPrefabInfo + 被孤立的 sub-object,remap 全部 `__id__` |
| `add-component <nodeSel> <ccType>` | 加最小元件(+ prefab 檔的 CompPrefabInfo) |
| `rm-component <sel:Type>` | 真刪元件 + 其 CompPrefabInfo + 被孤立 sub-object |

### 專案級(`--all`)
| 指令 | 作用 |
|---|---|
| `edit --all swap-uuid <oldAsset> <newAsset>` | 把**所有** prefab/scene 對某資產的引用重指(僅 prefab/scene;無法解析的檔會警告不靜默) |

`--all` 只支援 `swap-uuid`(uuid-keyed 才能跨檔通用);selector-based op 配 `--all` 直接報錯。

## 6. 寫入策略(兩種模式)

| 編輯種類 | 模式 | diff |
|---|---|---|
| `swap-uuid`(含 `--all`):純資產重指 | **文字外科補丁**(引號定錨字串替換) | 最小,不重排不重序列化 |
| 其餘全部(`set`/節點 op/結構增刪) | **parse → 改陣列 → `JSON.stringify(…,2)`**(+ 結構 op 做索引壓縮) | 動到值/拓撲,整體重序列化 |

### 文字補丁(swap-uuid)
`"<old>"`→`"<new>"` 與 `"<old>@`→`"<new>@`(子資產 sub-id 不動)。完整 uuid 在 prefab 裡只出現在 `__uuid__` 值(壓縮 `__type__` 是不同字串,碰不到),所以引號定錨安全。

### 索引壓縮(rm 的核心,`removeEntries`)
```
seed = 目標節點子樹 + 其所有元件 + 各自的 Prefab/CompPrefabInfo
set  = ownedClosure(seed)        // 再吸收「只被 seed 引用」的 sub-object(ClickEvent / PrefabInstance)
scrubRefs:  從擁有清單移除被刪 ref;指向被刪的「跨引用」屬性 null 掉
keep = arr 過濾掉 set;remapIds:每個 {__id__:N} → oldToNew[N]
```

### Template-by-example(add)
`cloneOf(arr, 'cc.Node' / 'cc.PrefabInfo' / 'cc.CompPrefabInfo')` 深拷貝同檔第一個同類,重設身分欄位(`_id`/`fileId`/`root`/`asset`/`instance`/`nestedPrefabInstanceRoots`)。`isPrefabFile` 決定要不要配 Prefab/CompPrefabInfo(scene 節點 `_prefab:null`)。

## 7. 安全機制

- `--dry-run`:寫前預覽(印 locations / 將寫入值)。
- **格式檢查**:`loadDoc` 確認是 3.x array-of-objects(擋 2.x `.fire`、非陣列)。
- **selector 唯一解析**:歧義 → exit 2 列候選。
- **值型別檢查**:節點 op 收錯型別旗標、`--color` 非法 hex、`--uuid` 缺資產、`--json` 未知類名 → 全部報錯**不寫檔**。
- **巢狀 prefab 實例護欄**:selector op 偵測目標(`assertEditable`)、`rm-node` 偵測**整個子樹**(`subtreeHasInstance`)有沒有 `PrefabInfo.instance ≠ null`,有就擋下並指路(去 source prefab 改)。`swap-uuid` 不受限(純重指,任何位置都安全)。
- **寫**:原子寫(temp → rename);`--backup` 存 `<file>.bak`。
- **rm-component 防呆**:只接受有 `node` back-ref 的真元件,`#N` 指到 PrefabInfo/CompPrefabInfo/ClickEvent 會被擋。

**巢狀 prefab 範圍定案**:A.prefab 內含 B.prefab 實例時,只支援「編輯 A 的非 B 部分」與「直接編輯 `B.prefab`」;A 裡那個 B 實例(及含它的子樹)一律擋下。**不碰** `propertyOverrides` 覆寫編輯。

## 8. 架構與模組

守住既有切分:`src/core/**` 唯讀,寫入活在 Node 層。**讀寫邏輯抽成共用 seam**,CLI(文字呈現)與 **MCP server**(JSON 工具)同源 —— 邏輯一份,只差呈現。

```
src/core/selector.js   ← 共用定址(DOM-free,browser + CLI 都用)
  componentName(scan, raw)   // __type__ → 類名(cc.Sprite / ScriptClass)
  locSelector(scan, loc)     // edge.location → 可貼的 nodePath:Comp.prop
  typeToken(scan, name)      // 類名 → 壓縮 token(--json 用;反向)

src/edit/editPrefab.js ← 純改檔「引擎」(@ts-check,無 process/CLI):byte-level mutate
  loadDoc(→{raw,arr,mtime}) / serialize / writeAtomic(mtime guard)
  planSwapUuid               // Tier0 文字補丁
  listNodes                  // tree:結構發現(消歧 path + 現成元件 selector)
  resolveSelector / buildNodeIndex / setDeep / getDeep
  eulerToQuat / setParent
  addNode / addComponent     // template-by-example(cloneOf)
  removeNode / removeComponent → {newArr, removed, cleared}
  removeEntries / ownedClosure   // 索引壓縮
  nestedInstanceRoot / subtreeHasInstance   // 實例護欄

src/edit/ops.js        ← 純「寫 seam」(@ts-check,無 print/exit;CLI 與 MCP 同源)
  runEdit(scan,dir,op,params) → {json, writes} | {error,code,candidates}  // resolve→load→mutate
  runSwapAll                 // --all 全專案
  getData / treeData         // 讀某檔的 selector / 結構
  commitWrites(writes,{backup,force})   // 落地 + mtime guard
  resolveRawTypes            // 類名 __type__ → token(set/--json 共用)
src/query.js       ← 純「讀 seam」:depsData / infoData / findData / closureData

src/shared.js       ← resolveTarget/resolveAsset、edgeMaps/orphansOf、locText/locJson、base/kb/edgeSort
src/editCli.js         ← edit 的 CLI 層:arg/值旗標解析 + 文字呈現 + commit;mutate 全委派 ops.js
src/cli.js             ← query 指令 + parseArgs + dispatch + USAGE + 攔 `coir mcp`
src/mcp/server.js      ← 手刻 JSON-RPC/stdio + queue + fs.watch 失效 + scan 快取(見 docs/MCP.md)
src/mcp/tools.js       ← 型別化工具表 → ops/query
```

CLI 入口:
```
coir edit <file> <op> <selector|args…> [值旗標] [--dry-run] [--backup] [--force] [-o json]
coir edit --all swap-uuid <oldAsset> <newAsset> [--dry-run] [--backup] [-o json]
```
（`--force` 跳過寫入前的 mtime guard;同一套 op 也由 `coir mcp` 的 MCP 工具暴露 —— 見 [docs/MCP.md](MCP.md)。）

## 9. 範例

```bash
# 探索:列出結構,拿到可貼的 selector(再餵給 get/set)
coir edit Shop.prefab tree                                  # 縮排階層 + #index + 元件
coir edit Shop.prefab tree --with cc.Label -o json          # 只列 Label 節點,附現成 selector
coir edit Shop.prefab tree --under "Canvas/Panel" --depth 2 # 限子樹 + 層數

# Tier0:把某資產的引用換成另一個(單檔 / 全專案)
coir edit Shop.prefab swap-uuid old/coin.png new/coin.png --dry-run
coir edit --all swap-uuid old/coin.png new/coin.png --backup

# Tier1:改 Label 文字 / 顏色 / 自訂值
coir edit Shop.prefab set "Canvas/Title:cc.Label._string" --str "開始"
coir edit Shop.prefab set "Bg:cc.Sprite._color" --color #1a1a1aff
coir edit Shop.prefab set "Icon:ResSprite._cfg" --json '{"__type__":"SpriteConfig","frameName":"coin"}'

# Tier2:改名 / 位移 / 旋轉 / 搬移
coir edit Main.scene rename "Canvas/OldName" NewName
coir edit Main.scene set-pos "Canvas/Player" --vec3 100 0 0
coir edit Main.scene set-parent "Canvas/A" "Canvas/B" --index 0

# Tier3:真刪節點(連子樹+元件+簿記,壓縮索引)/ 加元件
coir edit Shop.prefab rm-node "Canvas/Debug" --backup
coir edit Shop.prefab add-component "Canvas/Icon" cc.Widget
```

## 10. 測試

`test/cli.test.js`(node:test,subprocess 對自建 temp fixture,97 個案例):涵蓋每個 op、selector 各形式(`[i]`/`#N`/陣列/白名單、同型多元件無 `[i]` 報錯)、值旗標各型別、`--json` 自訂型別、`tree` 結構發現(消歧 path/selector 的 round-trip、`--with`/`--under`/`--depth`、實例標記)、`analyze` 各 section、**跨版本雙 fixture**(3.5.2/3.8.6 風格各一,鎖 template-by-example)、真刪+索引壓縮(`refIntegrity` 等同 `validate_scene`)、`ownedClosure`(ClickEvent 一併移除)、實例護欄、`--all`、以及一輪 code-review 抓到的邊界(非法 hex、型別不符、`--uuid` 缺值、`rm-component` 防呆、空名 rename、`swap old===new` no-op…)。`test/mcp.test.js` 另外真的 spawn `coir mcp` 講 JSON-RPC 驗證 MCP 工具(read、`set` dry-run vs 實寫、結構編輯、錯誤回 `isError`)。

**跨版本鎖定**:有專屬的雙版本 fixture(`XV35.prefab` 帶 `_level`、`XV38.prefab` 帶 `_mobility`+`__editorExtras__`,照真實 3.5.2 / 3.8.6 專案的格式建)—— 測 `add-node` 用**同一條程式路徑**在兩版各自產生版本正確的欄位集(template-by-example,零版本分支),且兩版加完都 `refIntegrity` 通過。

## 11. 已做 / 分期

| 階段 | 內容 | 狀態 |
|---|---|---|
| Tier 0 | `swap-uuid` + 文字補丁 | ✅ |
| Tier 1/2 | `set`/`set-uuid`/`rename`/`set-active`/`set-layer`/transform/`set-rot`/`set-parent` | ✅ |
| Tier 3 | `add/rm-node`、`add/rm-component` + 索引壓縮 + template-by-example | ✅ |
| 專案級 | `--all swap-uuid` + 巢狀實例護欄 | ✅ |
| 探索 | `tree`(結構發現 + 現成 selector;`--with`/`--under`/`--depth`)| ✅ |
| 共用 seam | 抽 `src/edit/ops.js`(`runEdit`…)+ `src/query.js`,CLI 與 MCP 同源;atomic+mtime 寫入護欄 | ✅ |
| MCP server | `coir mcp`:手刻零依賴 JSON-RPC/stdio,型別化工具(讀無前綴 / 寫 `edit_*`;host 裡 `coir__<工具>`)(見 [docs/MCP.md](MCP.md))| ✅ |
| 強化 | `--json` 自訂型別、`[i]` 統一、顯示↔selector 統一、code-review 修復 | ✅ |

## 12. 待議 / 未來

- **陣列結構編輯**(append/insert/remove/reorder 元素)—— Tier 1 `set` 只改既有值;這屬 Tier 3 類,需 `add-array-item`/`rm-array-item`。
- 瀏覽器端編輯(File System Access 可寫)—— Node 層 API 設計成可被 browser provider 復用。
- prefab 實例 `propertyOverrides` 覆寫編輯(刻意排除)。
- `set --all` 的「依型別跨檔比對」addressing —— `tree --with` 已補上「發現」這半(`find` → `tree --with -o json` → `set` 就能跑),剩一站式 `set --all :cc.Label._x` 還沒做;`--all` 是否納入 `.mtl`/`.anim`(目前定案:不納)。

### MCP server(已實作 → [docs/MCP.md](MCP.md))

MCP server **不是另一套實作**,而是共用 seam(`src/edit/ops.js` + `src/query.js`)之上的**薄型別化轉接層**(邏輯一份),跟 CLI 同層的另一個出口(`coir mcp`,手刻零依賴 JSON-RPC/stdio)。

- **價值**:① 寫操作的**逐工具權限邊界**(每個 `edit_rm_node` 是具名、可單獨核准的呼叫;`dryRun` 參數做唯讀預覽);② 觸及沒有 shell 的 GUI host;③ 型別化 schema。
- **生態定位**:少見的「headless、不開編輯器、既能深度讀分析又能就地編輯既有 prefab」的 Cocos MCP——現有的 Cocos MCP 工具多半要嘛只讀、要嘛要開編輯器、要嘛偏「從零生成」。
- **併發安全**:`fs.watch` 失效快取、編輯 load fresh、mtime 寫入護欄、工具序列化(細節見 docs/MCP.md)。
