# coir MCP server

把 coir 的查詢 + 就地編輯能力包成 **MCP server**(Model Context Protocol),讓 AI agent / 沒有 shell 的 GUI host(Claude Desktop 等)透過**型別化工具**呼叫。

> 它**不是第二套實作** —— 是 `cmdDeps`/`runEdit` 那層共用邏輯(`src/query.js` + `src/edit/ops.js`)之上的薄轉接層,**邏輯一份**,跟 CLI 同層的另一個出口。`src/mcp/server.js` 只管傳輸 + scan 生命週期,`src/mcp/tools.js` 是工具表。

## 為什麼用 MCP(而不是直接 CLI)

CLI 本來就 agent-friendly(stdout / `-o json` / exit code);有 shell 的 agent 直接呼叫即可。MCP 多給三件 CLI 給不了的:

1. **逐工具權限邊界** —— 每個寫操作是**獨立、具名、可單獨核准**的工具(`edit_rm_node` 跟 `edit_set` 分開把關)。
2. **型別化 schema** —— host LLM 拿到參數驗證 + 自動補全。
3. **無 shell 的 host** 也能用。

## 啟動

`coir mcp` 子命令(沿用 `-C`/cwd 與同一套外掛組合),長駐、講 **JSON-RPC 2.0 over stdio**(換行分隔)。stdout 專供協定;所有 log 走 stderr。

```jsonc
// Claude Desktop / Code 等 host 的 MCP 設定
{
  "mcpServers": {
    "coir": { "command": "npx", "args": ["coir", "mcp", "-C", "/path/to/CocosProject"] }
  }
}
```
（已 `npm link`/全域安裝可直接 `coir`;在專案目錄內可省略 `-C`。手刻零依賴,不需 `@modelcontextprotocol/sdk`。）

## 工具面(read 8 + write 12)

工具名不帶 server 前綴(server 名 `coir` 已 namespace —— host 裡顯示為 `coir__<工具>`,如 `coir__tree`)。讀工具直接是 `find`/`deps`/…(host 可全放行),寫工具一律 `edit_*`(逐一把關)。

**讀(無前綴)**

| 工具 | 作用 |
|---|---|
| `find(query, type?)` | 依名稱找資產 |
| `deps(asset, direction?, type?, limit?)` | 依賴(誰依賴它 / 它依賴誰)+ 使用位置 selector |
| `closure(asset, type?, list?)` | 打包閉包(blast radius) |
| `info(asset)` | 單一資產 record |
| **`tree(file, with?, under?, depth?)`** | 結構發現:節點階層 + 每個元件的現成 `nodePath:Type` selector |
| `get(file, selector)` | 讀某 selector 的值/節點/元件(可餵回 `edit_set`) |
| `status` / `rescan` | 伺服器狀態 / 強制重掃 |

**寫(`edit_*`,都有 `dryRun?`/`backup?`/`force?`)**

`set` · `set_uuid` · `swap_uuid`(`all?` 全專案)· `rename` · `set_active` · `set_layer` · `transform`(pos/scale/rot)· `set_parent` · `add_node` · `rm_node` · `add_component` · `rm_component`

> agent 典型流程:**`tree` 探索 → `get` 細讀 → `edit_*` 改**,全程不必 parse 檔案。`set` 的 `value` 收完整 JSON(純量 / 包裝物件 / `{"__uuid__"}` / 類名 `__type__` 的自訂型別),`get` 的輸出可直接餵回。

## 新鮮度 & 併發安全(零依賴)

Cocos Creator 同時在跑、會改檔,所以:

- **`fs.watch(assets, {recursive})` 失效快取**(debounce):編輯器存檔/import 等任何變動 → 標 dirty → 下次工具呼叫前 `ensureFresh()` 才重掃。只在真的有變動時重掃。
- **編輯一律 load fresh**:每次寫都直接讀當下磁碟內容再 mutate → atomic write;快取只拿來解析資產,不當被編輯檔的內容。
- **mtime guard**(預設開):寫前比對檔案 mtime,若自讀取後被改過(編輯器存了檔)→ **中止**不覆寫;要強制覆寫傳 `force: true`。
- **工具序列化**:一次跑一個工具,杜絕兩個寫互踩 / 讀撞重掃。
- **逃生口**:`rescan` 強制重掃;`status` 看狀態。

**平台 caveat**:`fs.watch({recursive})` 只在 macOS/Windows 支援遞迴;Linux 退化(不遞迴)→ 讀的自動新鮮度降級,但**寫入仍安全**(load fresh + mtime guard),必要時用 `rescan`。

**無法解的那一半**:編輯器若手上有未存的記憶體版本、在我們寫**之後**才存 → 它會蓋掉我們(反之亦然)。沒有檔案鎖能擋 → **別對編輯器正開著且 dirty 的檔案下 MCP 寫**;先存或先關,並靠 `backup`/`dryRun`/mtime guard 兜底。

> 注意:stdout 是協定通道。server 已把 `console.log` 轉到 stderr,避免多話的外掛污染 JSON-RPC 串流;第三方外掛若直接寫 stdout 仍會破壞協定 —— 外掛請只用 `ctx`,別 `process.stdout.write`。

## 非目標

一個 server 一個專案;不暴露瀏覽器 UI;`propertyOverrides` 覆寫仍排除;不開 Cocos 編輯器。

## 架構

```
src/mcp/server.js   手刻 JSON-RPC/stdio loop + initialize/tools.list/tools.call + 序列化 queue + fs.watch 失效 + scan 快取
src/mcp/tools.js    工具 schema 表 + 各工具 → runEdit / query / ops(commitWrites 在這層落地,遵守 dryRun/backup/force)
src/edit/ops.js     共用寫 seam runEdit/runSwapAll/getData/treeData(CLI 與 MCP 同源)
src/query.js    共用讀 seam depsData/infoData/findData/closureData
```

測試:`test/mcp.test.js`(node:test,真的 spawn server 講 JSON-RPC)涵蓋 initialize/tools.list、讀工具、`set` 的 dry-run vs 實寫(讀回驗證)、結構編輯(rename→新 selector 解析、add-component)、錯誤回成 `isError` 不崩。
