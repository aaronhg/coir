# coir MCP server

Wraps coir's query + in-place editing capabilities into an **MCP server** (Model Context Protocol), so AI agents / shell-less GUI hosts (Claude Desktop, etc.) can call them via **typed tools**.

> It is **not a second implementation** — it's a thin adapter on top of the shared logic behind `cmdDeps`/`runEdit` (`src/seam/query.js` + `src/edit/ops.js`); **one copy of the logic**, another exit at the same layer as the CLI. `src/mcp/server.js` only handles transport + scan lifecycle; `src/mcp/tools.js` is the tool table.

## Why MCP (rather than the CLI directly)

The CLI is already agent-friendly (stdout / `-o json` / exit codes); an agent that has a shell can just call it. MCP adds three things the CLI can't:

1. **Per-tool permission boundary** — each write operation is an **independent, named, separately-approvable** tool (`edit_rm_node` and `edit_set` are gated separately).
2. **Typed schema** — the host LLM gets parameter validation + autocomplete.
3. **Shell-less hosts** can use it too.

## Starting it

The `coir mcp` subcommand (using the same `-C`/cwd and the same plugin composition) runs as a long-lived process, speaking **JSON-RPC 2.0 over stdio** (newline-delimited). stdout is dedicated to the protocol; all logs go to stderr.

```jsonc
// MCP config for a host like Claude Desktop / Code
{
  "mcpServers": {
    "coir": { "command": "npx", "args": ["coir", "mcp", "-C", "/path/to/CocosProject"] }
  }
}
```
(If you've `npm link`'d / installed globally you can use `coir` directly; inside the project directory you can omit `-C`. Hand-rolled and zero-dependency — no `@modelcontextprotocol/sdk` needed.)

## Tool surface (10 built-in read + 12 write, plus plugin commands)

Tool names carry no server prefix (the server name `coir` already namespaces them — in the host they show as `coir__<tool>`, e.g. `coir__tree`). Read tools are plain `find`/`deps`/… (a host can allow them all); write tools are always `edit_*` (gated one by one).

**Read (no prefix)**

| Tool | Purpose |
|---|---|
| `find(query, type?)` | Find assets by name |
| `deps(asset, direction?, type?, limit?)` | Dependencies (who depends on it / what it depends on) + usage-site selectors |
| `closure(asset, type?, list?)` | Bundle closure (blast radius) |
| `info(asset)` | A single asset's record |
| `analyze(section?, type?, dropped?, list?)` | Project-wide audit: `stats`/`unused`/`orphans`/`atlas`/`size`/`all` (default `stats`) |
| `duplicates(section?)` | Redundant assets to merge; `section` = `files` (byte-identical source files, different uuids) or `configs` (structurally-identical prefab/material/anim); each group returns a suggested canonical + redundant + mergeable flag + reclaimable bytes. Pair with `edit_swap_uuid` (`all:true`). |
| **`tree(file, with?, under?, depth?)`** | Structure discovery: node hierarchy + a ready `nodePath:Type` selector for every component |
| `get(file, selector)` | Read the value/node/component at a selector (can be fed back into `edit_set`) |
| `status` / `rescan` | Server status / force a rescan |

**Write (`edit_*`, all with `dryRun?`/`backup?`/`force?`)**

`set` · `set_uuid` · `swap_uuid` (`all?` project-wide) · `rename` · `set_active` · `set_layer` · `transform` (pos/scale/rot) · `set_parent` · `add_node` · `rm_node` · `add_component` · `rm_component`

> Typical agent flow: **`tree` to explore → `get` to read closely → `edit_*` to change**, never parsing the file. `set`'s `value` takes full JSON (scalar / wrapper object / `{"__uuid__"}` / a custom type with a class-name `__type__`); `get`'s output can be fed straight back in.

> **Plugin commands are tools too**: any plugin's `commands` (see the README's "Plugins") that carries an `inputSchema` is **automatically registered into `tools/list`/`tools/call`** at startup (built-in tool names always win; a name clash is ignored with a warning). The same `run(ctx)` serves the `coir <name>` CLI and this MCP tool, returning `data`; `ctx` provides `scan` / `readText` / `resolveAsset` (not-found / clash → throws into a clean tool error) / `edgeMaps` / `uuid.*` / `util`. The built-in plugins now ship such tools too: `spine-dup` and `atlas-dup` (cross-atlas duplicate frames/regions). Example: after `coir mcp -C <proj> --plugin .../coir-plugin/index.mjs` loads, `timeline` shows up in the tool table. Registry in `src/seam/pluginCommands.js`, contract in `types/index.d.ts`.

## Freshness & concurrency safety (zero-dependency)

Cocos Creator may be running at the same time and changing files, so:

- **`fs.watch(assets, {recursive})` cache invalidation** (debounced): any change — an editor save / import / etc. → mark dirty → only rescan in `ensureFresh()` before the next tool call. Rescans only when something actually changed.
- **Edits always load fresh**: every write reads the current on-disk contents and then mutates → atomic write; the cache is only used to resolve assets, never as the contents of the file being edited.
- **mtime guard** (on by default): before writing, compares the file's mtime; if it was changed since it was read (the editor saved it) → **abort** without overwriting; pass `force: true` to force the overwrite.
- **Tool serialization**: one tool runs at a time, ruling out two writes stepping on each other / a read colliding with a rescan.
- **Escape hatches**: `rescan` forces a rescan; `status` shows the state.

**Platform caveat**: `fs.watch({recursive})` only supports recursion on macOS/Windows; on Linux it degrades (non-recursive) → automatic read-freshness degrades, but **writes are still safe** (load fresh + mtime guard); use `rescan` when needed.

**The half that can't be solved**: if the editor holds an unsaved in-memory version and saves it **after** we write → it overwrites us (and vice versa). No file lock can prevent this → **don't issue an MCP write against a file the editor is currently open on and dirty**; save or close it first, and fall back on `backup` / `dryRun` / the mtime guard.

> Note: stdout is the protocol channel. The server already redirects `console.log` to stderr to keep a chatty plugin from polluting the JSON-RPC stream; a third-party plugin writing directly to stdout would still break the protocol — plugins should use only `ctx`, never `process.stdout.write`.

## Non-goals

One server, one project; no browser UI exposed; `propertyOverrides` overrides are still excluded; the Cocos editor is not opened.

## Architecture

```
src/mcp/server.js   hand-rolled JSON-RPC/stdio loop + initialize/tools.list/tools.call + serialization queue + fs.watch invalidation + scan cache
src/mcp/tools.js    tool schema table + each tool → runEdit / query / ops (commitWrites lands here, honoring dryRun/backup/force)
src/edit/ops.js     shared write seam runEdit/runSwapAll/getData/treeData (same source for CLI and MCP)
src/seam/query.js    shared read seam depsData/infoData/findData/closureData
```

Tests: `test/mcp.test.js` (node:test, actually spawns the server and speaks JSON-RPC) covers initialize/tools.list, the read tools, `set`'s dry-run vs. real write (verified by reading back), structure edits (rename → new selector resolves, add-component), and errors coming back as `isError` without crashing.
