# Cocos scene/prefab 序列化契約

> coir 讀這個格式,coir 的編輯功能(見 [EDITING.md](EDITING.md))也寫這個格式。這頁記下那份契約的細節:**哪些欄位 coir 真正依賴、哪些可以無視**,以及「就地寫這個格式」的兩種做法各自的取捨。改 `scan`、寫 plugin、或維護 edit 功能前,先看這頁。

適用 **Cocos Creator 3.5.2 / 3.8.x**(meta `ver` 多為 `1.1.50`)。3.5.2 與 3.8.x 在這份契約上一致;差異是「加欄位」而非「改表示法」。

---

## 1. 基本契約

scene(`.scene`)與 prefab(`.prefab`)都是**一個 JSON 陣列**,每個元素是一個序列化物件。物件間用三種引用互指:

| 寫法 | 意義 | coir 怎麼處理 |
|---|---|---|
| `{"__id__": N}` | **同檔內部**引用 = 陣列下標 N | 走 prefab/scene 樹建立 `edge.locations`(nodePath · component.property · frame) |
| `{"__uuid__": "<full-uuid>[@sub]"}` | **外部資源**引用(SpriteFrame / Prefab / AudioClip / 腳本…) | 抓出 → 解析成依賴 **edge** |
| `"__type__": "<23 字壓縮 token>"` | **自訂腳本 / 自訂序列化類別**的型別 | `decompressUuid` 還原成腳本路徑 → `script` edge(見 §3) |

> 內建元件/型別的 `__type__` 是明文類名(`cc.Sprite`、`cc.Label`、`cc.Vec3`…);只有自訂類別(腳本、`@ccclass` 序列化物件)的 `__type__` 是壓縮 uuid。

陣列下標即身分,衍生一條鐵律:**只能 append,不能重排或實刪**——否則所有 `__id__` 全錯。唯一能安全刪的方法是「移除後全域 remap」(coir 的編輯器就這麼做,見 §6;不這麼做的工具只能軟刪,見 §5)。

---

## 2. coir 依賴哪些欄位 / 可以無視哪些

coir 的依賴拓撲**只**從少數欄位長出來;其餘大量欄位是引擎/編輯器的內部簿記,coir 完全不看。

### coir **依賴**(動到會改變拓撲)

| 欄位 / 來源 | 用途 |
|---|---|
| 任意層級的 `{"__uuid__": …}` | 依賴邊的主要來源 |
| 腳本/自訂類別的 `"__type__"`(壓縮) | 解壓 → `script` edge;也用於 component-script pruning |
| `.meta` 的 `importer` | → 正規化 `type`(meta.js 查表) |
| `.meta` 的 `uuid` / `subMetas[*].uuid` | 資源索引的鍵;`uuid@subId` 子資源定址 |
| `subMetas[*].userData.imageUuidOrDatabaseUri` | atlas→texture 邊(plugin) |
| `.meta` `userData.textureUuid` / `spriteFrameUuid` 等 | font→texture、particle→texture 邊(plugin) |
| 是否有 source 檔(`hasSource`) | 無 source 的 meta 會被丟棄,但記進 `scan.missing` 供具名 orphan 解析 |

### coir **無視**(怎麼填都不影響拓撲)

| 欄位 | 屬於 |
|---|---|
| `cc.PrefabInfo`(`root` / `asset` / `instance` / `targetOverrides` / `nestedPrefabInstanceRoots`) | prefab 實例化簿記 |
| `cc.CompPrefabInfo`、元件的 `__prefab` | 同上(每元件一個) |
| `fileId` | prefab 內部 id |
| `__editorExtras__`、`_mobility`、`_id`、`_objFlags` | 編輯器/節點內部欄位 |
| `_lpos` / `_lrot` / `_lscale` / `_euler` / `_layer` / `_active` | 變換與旗標 |
| `_name`、`asyncLoadAssets`、`optimizationPolicy`、`persistent` | 資源雜項 |

**推論:** 兩份 prefab 只要 `__uuid__` 與壓縮 `__type__` 相同,coir 算出的依賴拓撲就**完全一致**,不管 PrefabInfo/CompPrefabInfo/fileId 寫得多完整或多殘缺。這也是為什麼 coir 的編輯器能就地改檔而不打亂拓撲(§6)。

---

## 3. UUID 壓縮(`__type__`)

自訂類別的 `__type__` 用 **Cocos v2.0.10 base64 壓縮**:前 5 個 hex 字元保持不變,其餘 27 字壓成 18 字(總長 23;`min` 模式 22)。

- coir:`src/core/uuid.js` 的 `compressUuid` / `decompressUuid` / `looksCompressed`。`looksCompressed` 只是啟發式閘門,解壓後仍會對資源索引驗證才建邊。
- coir 的 edit 功能也用這套:讀 selector 時 `decompressUuid`(壓縮 `__type__` → 類名),`--json` 寫自訂值時 `compressUuid`(類名 → 壓縮 token)。

> ⚠️ 易錯:`__uuid__` 資源引用是**完整**帶連字號 uuid(可加 `@subId`),**永不壓縮**;只有 `__type__` 才壓縮。別把兩者搞混。

---

## 4. 「就地寫這個格式」的兩種做法

業界寫這個格式的工具大致分兩派,取捨剛好相反——理解它們有助於維護 coir 的編輯器:

- **編輯器內(editor-API)**:在 Cocos 進程內透過 editor 訊息 API 操作,但 prefab 那塊仍會**手刻 JSON 再 reimport** 讓編輯器收尾。產物接近官方:完整 `PrefabInfo`/`CompPrefabInfo`、`__editorExtras__`/`_mobility`,但留半成品(`_id:""`、隨機 `fileId`)靠 reimport 校正。前提:必須開編輯器。
- **headless(直寫 JSON)**:不開編輯器,直接讀寫陣列。產物是**最小骨架**,缺的欄位賭引擎載入時補預設。快、不用編輯器,但結構殘缺、且(若不做索引壓縮)只能軟刪。

逐欄位差異(同一個 prefab):

| 欄位 | editor-API | headless |
|---|---|---|
| `cc.Prefab` `__editorExtras__:{}` / `asyncLoadAssets` | 前者有、後者有(常各漏一個) | — |
| `cc.Node` `__editorExtras__` / `_mobility` | ✓ | **缺** |
| `cc.Node` `_id` | `""`(靠 reimport 補) | 22 字隨機 |
| `cc.PrefabInfo` | 完整(`root`/`asset`/`instance`/`targetOverrides`/`nestedPrefabInstanceRoots`) | 常只有 `{__type__, fileId}` |
| per-component `cc.CompPrefabInfo` | ✓ | 常**完全沒有** |
| `fileId` 形狀 | 22 字(對),但隨機 | 有的直接塞完整 uuid(**錯形狀**) |
| `.meta` | `ver:1.1.50` / `importer:prefab` / `files:[".json"]`… | 幾乎逐字相同 |

**對 coir 的意義:** 上表的差異**全都在 coir 無視的欄位裡**(§2)。所以 coir 掃哪一派產出的 prefab,拓撲結果都一致。差別只在「實例覆寫/revert/apply 連動」——headless 的最小骨架缺 per-node/per-component 簿記,當靜態模板用沒事,要像編輯器那樣改實例再 apply 回去會出問題。coir 的編輯器走 template-by-example(§6),避開這個坑。

---

## 5. Interop 陷阱(會影響 coir 的分析)

### 軟刪殘留(污染未使用偵測)

因為陣列下標即身分(§1),不做索引壓縮的工具只能**軟刪**:把節點從父的 `_children` 拔掉、`_active=false`、清 `_parent`,但**物件仍留在陣列裡**。若該死節點身上還有 `__uuid__` 資源引用,coir 掃描時會把那些資源算成**仍被使用**。

> **後果:** 用軟刪工具大量編輯過的專案,coir 的「未使用」報告會偏少(被幽靈節點撐住)。**coir 自己的編輯器走真刪+壓縮(§6),不會留這種垃圾。**

### prefab 簿記不影響拓撲

`PrefabInfo` / `CompPrefabInfo` / `fileId` / `__editorExtras__` 全走 `__id__`/`fileId` 內部引用,**不產生資源依賴邊**(§2 推論)。

### source-less meta

刪了 source 卻留下 `.meta` 時,coir 會把該 meta 丟出索引,但記進 `scan.missing`,讓仍指向它的 prefab/scene 解析成**具名的 missing-source orphan**(而非裸 uuid)。健康掃描 `metaErrors=0`。

---

## 6. coir 自己怎麼寫這個格式

edit 功能(見 [EDITING.md](EDITING.md))就地改既有檔時,刻意避開 §4/§5 的坑:

- **真刪 + 索引壓縮**:刪節點/元件後從陣列移除,再全域 remap 所有 `{__id__}`,並把指向被刪集合的跨引用 null 掉、把該被刪卻只被刪集合引用的 sub-object(ClickEvent / PrefabInstance)一併移除。→ 不留軟刪垃圾、無懸空 `__id__`。
- **Template-by-example**:新增節點/元件/PrefabInfo 時**複製同檔既有同類物件的骨架**,只重設身分欄位(`fileId`/`root`/`asset`/`instance`/`nestedPrefabInstanceRoots`/`_id`)。→ 該檔(該版本)所有欄位自動正確,零版本分支。
- **最小 diff**:純資源重指(`swap-uuid`)走引號定錨文字替換,不重排不重序列化。

換句話說,coir 的編輯器在「結構完整度」上靠 template-by-example 貼近官方,在「真刪」上勝過軟刪派——而這一切只依賴本頁 §1 的契約,不依賴任何 §2 的無視欄位。

---

## 參考

- coir 內部:`src/core/scan.js`(掃描管線)、`src/core/meta.js`(importer→type)、`src/core/uuid.js`(壓縮)、`src/core/selector.js`(`__type__` ↔ 類名)、`src/edit/editPrefab.js`(寫入引擎)、`CLAUDE.md`(架構總覽)。
