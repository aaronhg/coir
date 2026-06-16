# Coir — Cocos 資源依賴拓撲

[![Live Demo](https://img.shields.io/badge/Live_Demo-open-4fc3f7?style=flat-square)](https://aaronhg.github.io/coir/) [![License: MIT](https://img.shields.io/badge/License-MIT-3fb950?style=flat-square)](LICENSE) ![Cocos Creator](https://img.shields.io/badge/Cocos_Creator-3.8.x-9575cd?style=flat-square) ![runtime deps](https://img.shields.io/badge/runtime_deps-0-3fb950?style=flat-square)

> *Coir（椰殼纖維）：像梳理交織的椰纖一樣，把專案裡盤根錯節的資源依賴理出來；與 Cocos（椰子屬）同源。*

**▶ 線上試用（需 Chrome / Edge）：<https://aaronhg.github.io/coir/>** — 開啟後選你的 Cocos 專案目錄即可；全程在瀏覽器端執行，**不上傳任何檔案**。

載入一個 **Cocos Creator 3.8.x** 專案，於瀏覽器端建立資源的**使用情形**與**依賴拓撲圖**，涵蓋圖檔、圖集（TexturePacker plist / Spine）、點陣字（fnt）、prefab、scene、與 Cocos component 腳本。

![Coir 拓撲檢視：把一個 Cocos Creator 專案的資源依賴攤成雙向依賴樹，含型別篩選與「用在哪」彈窗](img/coir-topology.png)

純前端（HTML + JS，無後端、無建置步驟），透過 Chrome 的 **File System Access API** 直接讀取本機專案目錄。分析對象就是一般的 Cocos Creator 專案：

![被分析的 Cocos Creator 專案（編輯器畫面）](img/cocos-project.png)

> 📖 開發歷程、技術決策與踩過的坑見 [DEVELOPMENT.md](DEVELOPMENT.md)。
> 🧬 Cocos scene/prefab 序列化契約(coir 依賴/無視哪些欄位)見 [docs/SERIALIZATION.md](docs/SERIALIZATION.md);headless CLI 編輯既有 prefab/scene 的設計見 [docs/EDITING.md](docs/EDITING.md)。

## 執行需求

- Chromium 系瀏覽器（Chrome / Edge）— File System Access API 限定。
- 需在 **安全內容** 下開啟（`http://localhost` 或 https），不可用 `file://`。

## 開始使用

```bash
npm install       # 裝 webpack 工具鏈 + typescript（皆 dev-only，無第三方執行期相依），僅首次
npm run dev       # 啟動 webpack dev server：http://localhost:8080（存檔自動重編譯＋熱重載）
npm run typecheck # tsc --noEmit：JSDoc 型別檢查（無產出、無執行期相依）
# 正式打包： npm run build  → 產出 dist/app.bundle.js（minified，可用任意靜態伺服器部署）
```

瀏覽器開 `http://localhost:8080` → 點「選擇 Cocos 專案目錄」→ 選遊戲專案根目錄（含 `assets/` 的那層；直接選 `assets/` 亦可）。

> 純前端，**無第三方執行期相依**（先前的 cytoscape 力導向圖檢視已移除，只剩純 DOM）。由 **webpack** 打包（production bundle ~60KB）；開發用 `npm run dev`（webpack-dev-server，改 `src/` 即時重載），設定在 `webpack.config.cjs`（`.cjs` 因為 `package.json` 是 `type:module`）。線上 demo 由 **GitHub Actions** 自動 build＋部署到 GitHub Pages，因此 **`dist/` 不進 repo**（純建置產物，`.github/workflows/deploy.yml`）。

## 功能

介面是 **banner 上三個分頁（清單 / 拓撲 / 報告）共用一個內容區**，banner 下方一條**全域「類型篩選」bar**（同時作用於三個分頁）。

### 清單（＝層0）
- 可排序資源表：名稱／目錄／類型／大小／**被依賴**／**被依賴∑**／**依賴**／**依賴∑**。「目錄」欄只顯示資料夾（`a/b/c.prefab` → `a/b/`）。
- `被依賴` / `依賴` 是**直接**度數；帶 `∑` 的兩欄是**傳遞閉包**大小——`依賴∑` = 載入它會被帶進的資源總數（打包量）、`被依賴∑` = 改它會牽動的資源總數（影響範圍）。
- **單擊**＝選中（該列高亮）、**雙擊**（或 `Enter`）＝設為拓撲中心；`↑↓` 在列間切換。搜尋框可即時過濾路徑。

### 拓撲
- **雙向、固定 5 欄滑動視窗、永遠全展**的依賴樹：被依賴往左展、依賴往右展、層0 置中；視窗以選中項的「距中心位移」滑動；偵測循環顯示 `↻`。只列資源。欄頭以符號表示方向＋層號（`←層2` `←層1` ◆ `→層1` `→層2`），層0 欄染色。父子之間以**灰色連線**相連（畫在 cell 底下的 SVG overlay）；選中一個節點時，它通往中心的**整條鏈（祖先）＋直接子節點**會以灰底淡入標示，連線一併加亮。
- **拓撲 bar**（選定中心後浮現於分頁頂端）：左邊一個**篩選框**——輸入即**真的隱藏非相符節點**（只留相符節點＋通往中心的連接路徑，與類型篩選同一套剪枝；清空或 `Esc` 即還原完整樹）；右邊一條**麵包屑**顯示選中項到中心的整條鏈，**方向固定為「被依賴 → 依賴」**（不會反向），每一節可點選即跳選，旁邊一顆**複製鈕**把整條鏈以**每行一個完整路徑**複製到剪貼簿、再一顆**連結鈕**複製此中心的拓撲快照連結（`#topo=`，可分享、見下「嵌入 / 整合」）。
- 選中一個節點會**自動浮出「用在哪」**：它與樹中相鄰父節點那條邊的使用位置（節點路徑 · 元件.屬性 · frame；按鈕 ClickEvent 顯示 `▶ 方法()`）。popup 右上角有**複製鈕**，把所有使用位置複製到剪貼簿。
- **鍵盤／手勢**：`Tab` 切換分頁、`Esc` 清空類型篩選、`/` 或 `Ctrl/Cmd+P` 快速搜尋、`Ctrl/Cmd+R` 選擇專案目錄；拓撲內 `↑↓` 同欄、`←→`（或 Mac 兩指橫滑）跨欄並選「畫面垂直中央最近」者、`Enter` 設為新中心、`−` 上一動、`+` 下一動、`Delete` 回清單、`Ctrl/Cmd+C` 複製名稱、`Ctrl/Cmd+F` 在當前拓撲中找尋（見下）。
- **虛擬化＋找尋**：拓撲與 `/` 清單都只繪製**可見列**（垂直虛擬化，hub 大圖／大量結果也不卡）。因為捲出畫面的節點不在 DOM、原生 `Ctrl+F` 找不到，拓撲內建 **`Ctrl/Cmd+F`** 找尋（樹區右上角浮動框）：直接搜 cell 資料、命中**琥珀色高亮**、`Enter`/`⇧Enter` 下／上一個、`Esc` 關閉（不改中心、只垂直捲到該節點）。與左側「篩選框」分工——**篩選**會隱藏非相符節點、**找尋**只高亮並捲動。
- **`/` 快速搜尋**：模糊比對（`mscn` 也能找到 `MainScene`），**命中字會高亮**；跨多種來源——檔名／路徑、**uuid**（貼上即跳）、**sprite-frame 名**（找某一格在哪張圖集）、**使用位置**（節點路徑·元件.屬性·ClickEvent）、**邊**（meta/慣例/外掛推導的邊，如 atlas→texture、`extends`、外掛的 audio-call）。範圍前綴：`@` frame、`#` 型別、`>` 用途、`~` 邊種類（單打 `~` 列出可選種類；`#`／`~` 為兩段式 `#型別 關鍵字`／`~種類 關鍵字`）；每一筆右側顯示 `←被依賴∑ →依賴∑`，選任何一筆都會跳到對應的資源。

### 全域類型篩選（bar）
- 型別徽章「首次點選＝單獨，之後＝累加」，三個分頁共用。
- 對**清單／報告**＝只顯示該型別；對**拓撲**＝**保留通往該型別的路徑**：符合型別的節點與通往它的中間節點留著、死枝剪掉，層0 永遠保留。拓撲 bar 的**文字篩選**走同一套 `buildSide` 剪枝（型別 ∧ 路徑關鍵字），兩者可疊加。

### 報告
- **未使用 / 孤兒資源**：`resources/` 以外、零參照的資源（`resources/` 一律略過，視為執行期動態載入）。
- **孤兒參照**：指向不存在 uuid 的失效參照；若那個 uuid 來自一個「來源被刪、只剩 `.meta`」的資源，會以**檔名 + 「缺來源檔」**標示（而非裸 uuid）。
- **圖集利用率**：每個 plist 有多少 sprite-frame 實際被個別引用；整圖被當 `SpriteAtlas` 動態取用者另標「整圖動態取用」（無法靜態判定）。
- **資源體積**：各類型總量與最大檔案排行（含目錄欄）。
- **缺來源檔的 meta（已略過）**：摺疊清單，列出所有「只剩 `.meta`、來源檔已刪」而被忽略的項目，標示「仍被引用」（斷掉的依賴要修）或「無人引用」（殘留可刪）。

### 介面雜項
- **多語系**：繁體中文 / English，banner 右上角下拉切換（自動偵測瀏覽器語言、記在 `localStorage`）。所有可見字串集中在 `src/browser/i18n.js`，零相依的 `t()`。
- **首次歡迎頁**：剛進來時中央浮一張卡片（按鈕＋簡短說明），全螢幕遮罩蓋住其餘，只有語系下拉、`?`、GitHub 可按；選好專案後消失。
- **說明 `?`**：右上角按鈕開啟說明 modal（分頁／拓撲／搜尋／快捷鍵），底部有 GitHub 連結。
- **GitHub 圖示**＋ 🥥 favicon（emoji SVG，零檔案）。

### 解析原則
- **只收錄 Component 腳本**：`.ts` 僅保留 Cocos component（class `extends Component`／被序列化 `__type__` 引用／extends 鏈傳遞閉包），純工具模組（utils／enums／config）不納入拓撲；component 之間以**類別繼承 `extends` 邊**相連。
- **缺來源檔的 meta 不索引**：來源檔已刪、只剩 `.meta` 的資源不視為真資源（同資料夾 meta 的處理），但仍記住其 `uuid→path`，讓還在引用它的 prefab/scene 浮現為具名的「缺來源檔」斷線。

## 分析的資料模型（3.8.x）

| 節點 | 副檔名 | `.meta` importer | 說明 |
|---|---|---|---|
| 圖檔 | `.png` | `image` | 子資源 `uuid@<id>`：texture / spriteFrame |
| 圖集 (TexturePacker) | `.plist` | `sprite-atlas` | 每框 `uuid@<id>` 為 sprite-frame，`imageUuidOrDatabaseUri` 連底圖 |
| 圖集 (Spine) | `.atlas`/`.json`/`.png` | `*` / `spine-data` / `image` | skeleton→atlas→（多頁）png，自 `.atlas` 文字解析頁面 |
| 點陣字 | `.fnt` | `bitmap-font` | `userData.textureUuid` 連底圖 |
| Prefab / Scene | `.prefab` / `.scene` | `prefab` / `scene` | JSON，`__uuid__`（可帶 `@子id`）參照資源 |
| 動畫 | `.anim` | `animation-clip` | JSON |
| Component 腳本 | `.ts` | `typescript` | 於 prefab/scene 以**壓縮 uuid** 進 `__type__` |

依賴邊：
- `"__uuid__": "<uuid>"` 或 `"<uuid>@<子id>"` → 資源 / 子資源（完整 uuid，不壓縮）。
- `"__type__": "<23字壓縮uuid>"` → 腳本元件，以 `decompressUuid` 還原（Cocos v2.0.10 演算法，3.x `__type__` 沿用）。
- 推導邊：圖集→底圖、字型→底圖、粒子→底圖、spine 三件組（皆為**內建外掛**，可再擴充，見下方「外掛」）；以及 component → 基底 component 的 `extends`（類別繼承）邊。
- cc.Button 的 ClickEvent 接線：`_componentId`（壓縮的處理腳本 uuid）+ `handler`（方法名）→ 一條 script 邊，位置記為 `click → 方法()`。

## 外掛（擴充型別、邊與命令）

型別與依賴邊都可外掛。內建的「圖集→底圖／字型→底圖／粒子→底圖／Spine 三件組」就是四個內建外掛（`src/core/plugins/{atlas,font,particle,spine}.js`，每檔同時帶該型別的對應、邊邏輯與顏色）。要新增一種資源型別或一種邊，寫一個 plugin 即可，不必動核心。

```js
/** @type {import('coir').Plugin} */   // 型別隨套件 ship（types/index.d.ts），一行就有 ctx autocomplete
export default {
  name: 'my-plugin',
  importerTypes: { 'my-importer': 'mytype' }, // importer → 型別
  typeByExt:     { '.xyz': 'mytype' },          // 副檔名 → 型別
  rootTypes:     ['mytype'],                     // 永不算「未使用」
  colors:        { mytype: '#26a69a' },          // 瀏覽器型別顏色
  async edges(ctx) {                             // 資源索引定版後產生邊
    for (const a of ctx.assets.values()) { /* ctx.addEdge(from, to, kind, loc?) */ }
  },
};
```

`edges(ctx)` 只用 `ctx`（資源索引＋`addEdge(from,to,kind,loc?,label?)`（`label`＝人類可讀的邊描述，供顯示／搜尋）／**`addNode({path,type,…})`**＝加**虛擬節點**（事件／通知／路由等無檔節點，進圖與度數但 `virtual:true`，資源健康報告會略過）／`resolveUuid`／`noteSub`／**`files`**（FileProvider 列出的所有資源相對路徑，配 `readText` 讀任意來源）／`readText`／`mapLimit`／`uuid.*`／唯讀 `scripts`），**不 import 任何東西** → 第三方 plugin 零 build step。

**註冊方式**（優先序：內建 → 全域 → 專案 → `--plugin`／`use()`；同名由更 specific 的覆蓋，`dedupePlugins`）：

| 方式 | 位置 | 生效範圍 |
|---|---|---|
| 內建 | `src/core/plugins/` + `index.js` | CLI＋瀏覽器（綁進 build） |
| 全域 | `<coir 根>/coir.plugins.mjs`（gitignore） | 每次掃描，跨專案 |
| 專案 | `<你的專案>/coir.plugins.mjs` | 只該專案 |
| 臨時 | `coir … --plugin <檔>` | 該次查詢 |
| 瀏覽器 runtime | `window.coir.use(plugin)`（選專案前） | 該頁 |

> 全域與專案的 `coir.plugins.mjs` **CLI 與瀏覽器都會自動載入** —— 瀏覽器透過 dev server 取得 coir 根那份、用 File System Access 讀被選專案那份（每次選專案重讀，要選含 `assets/` 的專案根目錄）。開啟專案後右上狀態列會列出生效的非內建 plugin，標成 `來源.名稱`（`global`／`project`／`use`）。

### 命令（commands）— 一份定義，CLI ＋ MCP 兩個介面

plugin 除了型別／邊，還能加**命令**：`commands: [{ name, usage?, description?, inputSchema?, positional?, run(ctx) }]`。一個命令**登記一次**就同時：在 **CLI** 跑 `coir <name> …`（列在 `coir --help` 的「Plugin commands」）；帶了 `inputSchema` 的話**也自動成為 MCP 工具**（`coir mcp`）。（命令是 headless 的，只在 CLI／MCP，不在瀏覽器。）

內建命令（`deps`/`uses`/`closure`/`find`/`info`/`analyze`/`edit`/`mcp`）永遠優先，撞名的 plugin 命令會被忽略＋警告。`run(ctx)` **回傳**結果、**從不印**——`{ data, text? }` 或 `{ error, candidates? }`：CLI 印 `text`（`-o json` 印 `data`）、MCP 回 `data`，所以同一個 `run` 兩邊通用。`ctx` 跨宿主一致：`env`（'cli'｜'mcp'）、`args`（具名物件——CLI positionals 經 `positional` 對映、MCP 是 JSON arguments）、`scan`、`readText`、`resolveAsset`（path/basename/uuid→uuid；CLI 撞名印候選 + `exit 2`、MCP throw → 乾淨 tool error）、`edgeMaps`、`uuid.*`、`util.{base,kb}`（CLI 另有 `flags`/`argv`）。

例如一個外部 plugin 可以這樣加 `coir timeline <prefab>`（也是 `timeline` MCP 工具），用一個 `run` 同時服務 CLI 與 agent，而不必 fork coir。註冊表在 `src/seam/pluginCommands.js`，契約見 `types/index.d.ts`（`PluginCommand`/`CommandContext`/`CommandResult`）。

### 範例：`audio-call`（把 `audioPlay('x')` 連到音檔）

「以字串名稱於執行期載入」的呼叫（如 `audioPlay('lobby_bgm')`）靜態看不出依賴。這個 plugin 掃 component 原始碼、把呼叫的名字對到同名音檔，連出 `Lobby.ts → lobby_bgm.mp3/.ogg`，補上「已知限制」裡動態載入灰區的一隅。完整可用、零相依：

```js
const FUNCS = ['audioPlay'];                       // 你專案的播放函式名（可多個）
const CALL_RE = new RegExp(String.raw`\b(?:${FUNCS.join('|')})\s*\(\s*['"\`]([^'"\`]+)['"\`]`, 'g');

/** @type {import('coir').Plugin} */
export default {
  name: 'audio-call',
  async edges(ctx) {
    const { assets, addEdge, scripts } = ctx;

    // 音檔 basename（去副檔名）→ [資源]，所以 .mp3 / .ogg 都對得上
    const byName = new Map();
    for (const a of assets.values()) {
      if (a.type !== 'audio') continue;
      const name = a.path.slice(a.path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(a);
    }
    if (!byName.size) return;

    for (const a of assets.values()) {
      if (a.type !== 'script') continue;            // ctx.assets 只含 component 腳本
      const text = scripts.text.get(a.uuid);         // 3b 已讀好的原始碼，不必重讀
      if (!text) continue;
      for (const m of text.matchAll(CALL_RE)) {
        const arg = m[1];
        const name = arg.slice(arg.lastIndexOf('/') + 1); // 'audio/lobby_bgm' → 'lobby_bgm'
        for (const audio of byName.get(name) || []) {
          addEdge(a.uuid, audio.uuid, 'audio', { nodePath: null, component: null, property: `audioPlay("${arg}")` });
        }
      }
    }
  },
};
```

放進 `<你的專案>/coir.plugins.mjs`（或 coir 根的全域檔）後，CLI 就查得到 —— 哪支腳本播某個音檔：

```text
$ coir ./MyGame uses audio/lobby_bgm.mp3 --where
audio/lobby_bgm.mp3 (audio)
  used-by 1:
    audio        ← script/Lobby.ts  (2×)
        —  audioPlay("lobby_bgm")
```

反向（某腳本播了哪些音）：`coir ./MyGame deps script/Lobby.ts --out --type audio --where`。

限制（刻意）：只看得到 **component 腳本**（純 util 模組已被剪枝）；只解**字串字面值**（`audioPlay(this.bgm)` 無法）；參數要對得上音檔 basename（撞名會連到全部同名音檔）。

## 無頭工具（Node）

核心解析與瀏覽器解耦，可在 Node 下直接跑。

**整份報告驗證**（改 `src/core/` 後用它對真實專案回歸）：

```bash
node test/node-run.js <專案目錄> [中心uuid或路徑]
# 例：node test/node-run.js ../my-cocos-project scene/Main.scene
```
輸出資源/邊統計、邊種類分佈、未使用、孤兒參照、圖集利用率、體積與依賴閉包。

**CLI**（`src/cli.js`，輸出到 stdout、可 pipe/解析；`bin` 註冊為 `coir`）：在 Cocos 專案目錄內直接跑，或用 `-C <專案目錄>` 指向別處（git 風格，預設當前目錄）。`coir --help` 印含範例與 exit code 的說明。

**依賴查詢（唯讀）：**

```bash
coir deps    <資源> [--in|--out] [--depth N] [--type T[,T2]] [--where] [-o json] [--limit N]
coir uses    <資源>            # = deps --in（誰參照它）
coir closure <資源> [--type T] [--list] [-o json]   # 打包閉包
coir find    <查詢> [--type T]                       # 依名稱找候選
coir info    <資源>                                  # 印單一資源的 record（型別/uuid/度數/子資源/userData）
coir analyze [section] [-o json]                     # 專案級稽核（= node-run.js 報告的 CLI 版）
#   section = stats（總覽/邊種類/健康）| unused（未使用）| orphans [--dropped] | atlas（圖集利用率）| size [--type T][--list]；無 section = 全部
```

`<資源>` 可用完整路徑／basename／uuid／`uuid@sub`（撞名印候選並 `exit 2`）。`--where` 把每條邊的使用位置印成**可直接貼回 `edit` 的 selector**（`nodePath:Comp.prop`，與瀏覽器「用在哪」彈窗共用一套）。`--type` 只保留指定型別：`deps`/`uses` 樹保留通往該型別的中間路徑，`closure`/`find` 過濾平面清單。輸出預設 text，`-o json` 給機器讀。

**就地編輯既有 prefab/scene**（會**寫檔**——先 `--dry-run` 預覽、`--backup` 留快照；不會憑空產生檔案）：

```bash
coir edit <檔> tree [--with <Type>] [--under <sel>] [--depth N]   # 列節點階層 + 現成 selector（唯讀；盲改的解法）
coir edit <檔> get <sel>                      # 讀某值／節點／元件（-o json 可餵回 set --json）
coir edit <檔> set <sel> <值旗標>             # 改屬性（--str/--int/--color/--vec3/--uuid/--json '<物件>' …）
coir edit <檔> swap-uuid <舊資源> <新資源>    # 重指引用（可 --all 全專案）
coir edit <檔> rename|set-active|set-pos|set-rot|set-parent|add-node|rm-node|add-component|rm-component …
```

`tree` 是結構探索:不必 parse JSON 就拿到任何 prefab 的全部可貼 selector(`tree`→`get`→`set` 三段式)。selector 同上（`nodePath:Type.prop`，`[i]` 消歧、`#N` 絕對索引）；`swap-uuid` 是最小 diff 文字補丁,其餘 parse-rewrite；**真刪會做索引壓縮**（不留軟刪垃圾）、新增走 **template-by-example**（複製同檔骨架→跨版本正確）；scene 裡的巢狀 prefab 實例會被偵測擋下；寫入是 atomic + **mtime guard**（檔案自讀取後被改過就中止，`--force` 覆寫）。完整設計見 **[docs/EDITING.md](docs/EDITING.md)**。

**MCP server**（給 AI agent / 沒有 shell 的 host）：`coir mcp` 啟一個**手刻、零依賴**的 JSON-RPC/stdio MCP server,把上面的查詢 + 編輯包成型別化工具（讀工具如 `tree`/`get`、寫工具 `edit_*`,逐一可核准；host 裡顯示為 `coir__<工具>`），跟 CLI **同一套邏輯**。帶 `fs.watch` 失效快取 + 工具序列化 + mtime 寫入護欄。host 設定與安全細節見 **[docs/MCP.md](docs/MCP.md)**。

外掛在 CLI 也生效：`<coir 根>/coir.plugins.mjs`（全域）與 `<專案>/coir.plugins.mjs`（該專案）會自動載入，或用 `--plugin <檔>` 指定（見「外掛」）。

## 嵌入 / 整合（viewer · embedder · Cocos 擴充）

核心 DOM-free、零相依，所以能把「指著一個資源直接看它的拓撲」嵌進別的工具。

### URL 快照 viewer（`#topo=`）
把某資源的**鄰域子圖**壓進網址 hash —— `https://aaronhg.github.io/coir/#topo=<blob>` —— 開連結就**直接進拓撲**、聚焦那個資源。資料全在 hash（節點整數索引 + gzip + base64url），所以**不需 File System Access、不需 server**：連非 Chromium（Firefox / Safari / 手機）都看得了（只有「選目錄掃描」那條才需 FSA）。可分享、可加書籤。`encodeTopo`/`decodeTopo` 在 `src/core/topohash.js`（Node 也能跑），會自動把深度從 ±5 縮到塞得進 `MAX_BLOB_CHARS`（預設 256KB、可調）、永遠回連結；鄰域外緣節點標 `⋯`、超出範圍的使用處給「未載入」提示。

### 嵌入出口（`import('coir')`）
`package.json` 的 `exports` 讓 Node host 一行 `import('coir')` 取得 `scanProject` / `buildAdjacency` / `encodeTopo` / `makeFsProvider` / `PLUGINS`（barrel 在 `src/index.js`；瀏覽器仍走 `app.js`）。

### Cocos Creator 3.5–3.8 擴充（`cocos-extension/`）
資源**右鍵** → 子選單按層列出 **被依賴（←）／依賴（→）**，每筆點了**跳到該資源**（`Editor.Selection.select`），頂層**開拓撲快照**。擴充主行程 in-process 跑 coir-core（快取 scan、隨 asset-db 變動失效），繁中／English i18n；`./cocos-extension/install.sh [專案路徑]` 一鍵安裝（複製 + symlink coir，免 npm link，預設裝到 `../NewProject_386`）。**3.5–3.8 通吃**（`editor: >=3.5.0`；`topohash` 對舊版 Node／Electron 有 `node:zlib` fallback，所以 3.5 也能產快照）。詳見 `cocos-extension/README.md`。

## 架構

```
src/core/      # 與 DOM/瀏覽器無關的純核心，Node 與瀏覽器共用
  uuid.js      #   壓縮/解壓縮 uuid（含 @子資源處理）
  meta.js      #   解析 .meta → 資源 + 子資源
  refs.js      #   從 prefab/scene/anim/mtl 抽取參照（含使用位置 locations）
  scan.js      #   掃描 FileProvider → 資源索引 + 依賴邊
  graph.js     #   鄰接表、依賴/被依賴閉包
  analyze.js   #   未使用、孤兒、圖集利用率、體積、閉包、缺來源檔 meta 報告
  topohash.js  #   鄰域子圖 ⇄ `#topo=` URL 快照（encode/decode；viewer + 嵌入共用）
  plugins/     #   內建外掛（atlas/font/particle/spine）+ registry（index.js）；型別與邊可外掛擴充
src/browser/   # 瀏覽器層（純 DOM，無第三方執行期庫）
  fsapi.js     #   File System Access → FileProvider
  state.js     #   單一可變狀態袋 S + DOM/共用小工具
  ui.js        #   orchestrator：三分頁 + 全域類型篩選 + 事件接線（initUI/setTab/onKey）
  topo.js list.js reports.js  #   三分頁；topo 垂直虛擬化（只畫可見列）+ Ctrl/F 找尋
  palette.js   #   `/` 快速搜尋（多來源索引、虛擬化清單）
  usage.js filterbar.js copy.js  #   「用在哪」popup／類型篩選 bar／複製
  i18n.js      #   多語系字典（繁中／English）+ t() + data-i18n 套用
  app.js       #   進入點
src/node/
  fsProvider.js #  Node fs → FileProvider（node-run.js 與 cli.js 共用）
  loadPlugins.js #  載入 repo 外的外掛（coir.plugins.mjs 全域/專案、--plugin）
src/cli.js        # 無頭 CLI（deps/uses/closure/find/info/analyze/edit/mcp，bin: coir）
src/seam/ edit/ mcp/  # 共用讀寫 seam + CLI/MCP 呈現（見 docs/EDITING.md、docs/MCP.md）
src/index.js      # 嵌入出口 barrel：`import('coir')`（package.json exports 對應）
cocos-extension/  # Cocos Creator 3.5–3.8 擴充（右鍵查依賴 + 開拓撲快照）+ install.sh
test/node-run.js  # 整份報告的無頭驗證器
test/cli.test.js  # node:test：對合成專案跑 cli.js 端對端
index.html        # 應用外殼 + CSS（載入 dist/app.bundle.js）
webpack.config.cjs # webpack 設定（entry=src/browser/app.js、dev server）
dist/app.bundle.js # webpack 打包輸出（純 DOM，~60KB）；gitignored — 由 CI build，不進 repo
.github/workflows/deploy.yml # GitHub Actions：build + 部署到 GitHub Pages
types/index.d.ts   # 型別宣告（資料模型 + Plugin/PluginContext 契約；隨套件 ship）
tsconfig.json      # 型別檢查設定（allowJs/checkJs，tsc --noEmit）
```

`FileProvider` 介面：`listFiles()` / `readText(path)` / `size(path)`，路徑相對於 `assets/`。瀏覽器（`fsapi.js`）與 Node（`node/fsProvider.js`）各有一份實作，因此解析邏輯可無頭測試（`npm test`）。

## 已知限制

- **動態載入灰區**：以字串路徑於執行期載入者（`resources/` 下的 `loadDir`、或程式碼自行 `load('xxx')`）無法靜態追蹤。故未使用判定一律略過 `resources/`；但 `resources/` 外、純由程式載入的資源（例如某些以程式挑選的點陣數字圖集）可能被列為「未使用」——這是靜態掃描的本質盲區，不一定是真的沒用到。若有固定慣例（如 `audioPlay('x')`、`load('dir/x')`），可寫一個 plugin 把這類字串呼叫解析成邊（見「外掛」），把部分灰區補回。
- 整圖被當 `SpriteAtlas` 取用時，個別框的使用情形無法靜態得知（已標記「整圖動態取用」）。
- 目前針對 **3.8.x** 格式；3.5.2 序列化格式相容，核心可直接套用（如遇差異於 `meta.js` / `scan.js` 微調）。**不**支援 2.x（`.fire` 場景、舊版 meta）。
- 圖集利用率的位元組級「浪費面積」尚未計算（目前以框數比例呈現）。
