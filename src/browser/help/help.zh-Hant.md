### 這是什麼
載入一個 **Cocos Creator 3.8.x** 專案，分析資源的**使用情形**與**依賴拓撲**。全程在瀏覽器端執行，不上傳任何檔案。

### 四個分頁
- **清單** — 可排序資源表。`被依賴`／`依賴` 是直接度數，帶 `∑` 的是傳遞閉包（影響範圍／打包量）；`Bundle` 欄是所屬 Asset Bundle（`main`＝未分包、`resources`＝動態載入）。單擊＝選中、雙擊（或 <kbd>Enter</kbd>）＝設為中心；<kbd>↑</kbd> <kbd>↓</kbd> 切換列。
- **拓撲** — 以選中資源為中心的雙向依賴樹：`←` 被依賴往左、`→` 依賴往右，固定 5 欄滑動視窗，父子間以灰色連線相連、選中時整條鏈（祖先）與直接子節點會加亮。選一個節點會自動顯示它「用在哪」。頂端 bar：左邊**篩選框**直接隱藏不相符的節點（清空或 <kbd>Esc</kbd> 即還原），右邊**麵包屑**顯示到中心的整條鏈（方向固定「被依賴 → 依賴」，每節可點跳選，旁邊按鈕複製整條鏈／拓撲快照連結）。
- **體積圖** — 把資源依大小攤成 treemap（方塊面積 ∝ bytes、按型別上色），**範圍＝拓撲中心的依賴 closure**（沒中心則整個專案），圖檔直接貼縮圖。可切換**按 Bundle 分組**；會被 build 跨 bundle 重複打包的資源方塊加**紅框**。**單擊**方塊鑽入它的依賴體積、**雙擊**跳到拓撲；hover 看名稱＋體積、**兩指縮放**＋滑動平移、方向鍵移動＋<kbd>Enter</kbd> 鑽入。
- **報告**（子分頁）— 未使用／孤兒參照、圖集利用率、資源體積、**跨 bundle 依賴**（循環＋冗餘）、缺來源檔的 meta，以及外掛貢獻的**跨圖集重複圖**（同一張美術被打進多個 Spine／.plist 圖集，並排縮圖＋逐像素確認）。

### 型別篩選
banner 下方的型別徽章各分頁共用：篩清單／報告／體積圖（體積圖的徽章數量還會跟著目前範圍變動）；在拓撲上保留「通往該型別」的路徑、剪掉無關的分支。

### 快速搜尋 <kbd>/</kbd>
模糊比對檔名／路徑／uuid，命中字會高亮。範圍前綴：<kbd>@</kbd> sprite-frame、<kbd>#</kbd> 型別、<kbd>></kbd> 引用處/節點、<kbd>~</kbd> 邊種類（單打 <kbd>~</kbd> 列出可選種類）；<kbd>#</kbd>／<kbd>~</kbd> 可兩段式（`#型別 關鍵字`、`~kind 關鍵字`）。貼上 uuid 直接跳。

### 快捷鍵
- <kbd>Tab</kbd> 切換分頁（<kbd>Delete</kbd> 反向）、<kbd>Esc</kbd> 清空類型篩選
- <kbd>/</kbd> 或 <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>P</kbd> 快速搜尋
- 拓撲：<kbd>↑</kbd> <kbd>↓</kbd> 同欄、<kbd>←</kbd> <kbd>→</kbd>（或兩指橫滑）跨欄、<kbd>Enter</kbd> 設為新中心、<kbd>−</kbd> 上一動、<kbd>+</kbd> 下一動、<kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>F</kbd> 在此拓撲中尋找、<kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>C</kbd> 複製名稱
- 體積圖：方向鍵移動方塊游標、<kbd>Enter</kbd> 鑽入、<kbd>−</kbd>／<kbd>+</kbd> 中心歷史；單擊鑽入、雙擊跳拓撲

### 命令列工具（headless）
除了這個網頁，coir 還有一套 **CLI**（查依賴、找重複資源、就地編輯 prefab/scene、`coir analyze bundles` 跨 bundle 稽核、`coir check` CI 守門員）與 **MCP server**。零執行期相依，一行安裝（把 `coir` 連到 PATH）：

```
curl -fsSL https://raw.githubusercontent.com/aaronhg/coir/main/install.sh | sh
```

Cocos Creator 擴充（右鍵查依賴）— 自包含安裝進專案：

```
curl -fsSL https://raw.githubusercontent.com/aaronhg/coir/main/install-extension.sh | sh -s -- <Cocos 專案路徑>
```
