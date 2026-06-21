# coir **MCP** server — native verification RESULTS

Companion to `RESULTS.md` (which verified the `edit` *engine*). This file verifies coir's
own **MCP server** (`coir mcp`, `src/mcp/`) — the layer the CLI tests don't reach.

**Framing**: coir's MCP and CLI share one edit engine (`src/edit/ops.js`), so the 80
engine-validity results in `RESULTS.md` carry over to MCP writes — *not re-run here*. This
file covers the **MCP-specific surface**: tool dispatch + arg shapes, error mapping
(engine `{error}` → `isError` tool result), the cached scan + `fs.watch` invalidation +
`rescan`/`status`, `dryRun`/`backup`/`force` as MCP args, and a native cross-check subset.

**Setup**: two MCP servers connected — `coir-edit` (coir's MCP, registered via
`claude mcp add coir-edit -- node …/src/cli.js mcp -C …/NewProject_386`, stdio) drives
writes/reads; `cocos-creator` (live editor) does native readback. Fixtures under
`assets/_coirtest/`: `soldier_t.prefab` (clean), `nested_t.prefab` (nested instances),
`MyCoirComp.ts` (a project script). Swap target `material/tree.mtl`.

---

## Cache / fs.watch / rescan / status (MCP-only)

| id | scenario | observed | result |
|----|----------|----------|--------|
| C1 | server started at 29 assets; 3 fixtures created externally (cocos-creator) → call `status`/`find` with **no rescan** | `status.assets` = 32 (auto +3); `find _coirtest` lists all 3 incl. `MyCoirComp` as `type:script` | **PASS** (fs.watch auto-invalidated the cache) |

## D — Read-tool dispatch + arg shapes (mcp-result / cli-reread)

| id | tool / args | observed | result |
|----|-------------|----------|--------|
| D1 | status {} | {project,assets:32,edges:39} | **PASS** |
| D2 | find soldier_t | array incl _coirtest/soldier_t.prefab | **PASS** |
| D3 | find {query:"t",type:"prefab"} | only prefabs (nested_t, soldier_t) | **PASS** |
| D4 | find {query:"zzz…"} | `[]` (miss = empty, not error) | **PASS** |
| D5 | info soldier_t.prefab | full record (uuid/size/bundle/degrees) | **PASS** |
| D6/D7 | deps {direction:"out",limit:3} | dependsOn capped 3 + locations, no usedBy | **PASS** |
| D8 | closure {list:true} | {count:5,totalSize,byType,items[]} | **PASS** |
| D9 | tree soldier_t | nodeCount:34 + selectors | **PASS** |
| D10 | tree {with,depth} | pruned to SkinnedMeshRenderer | **PASS** |
| D11/D12 | get scalar / component | {value:true,kind:property} / whole component | **PASS** |
| D13 | analyze stats | metaErrors:0, byType, edgeKinds | **PASS** |
| D14 | analyze {section:"all"} | every section keyed (stats/unused/orphans/atlas/size/bundles) | **PASS** |
| D15 | duplicates {} | found tree-001.png byte-dup group (async read tool) | **PASS** |
| D16 | check {} (default) | warn-only health: 4 no-dangling-refs warns, errors:0 | **PASS** |
| D17 | check {rules:[max-meta-errors]} | inline-rules arg, violations:[], errors:0 | **PASS** |
| D18 | share {depth:3} | url contains `#topo=`, nodes:10 | **PASS** |

## E — Error mapping (engine `{error}` → `isError` tool result) + the two fixes via MCP

| id | call | isError text | result |
|----|------|--------------|--------|
| E1 | edit_set on MyCoirComp.ts | `✗ ✗ … is a script, not a prefab/scene` | **PASS** |
| E3 | edit_set on a node sel | `✗ ✗ … must select a property` | **PASS** |
| E4 | edit_rename node=component | `✗ ✗ … must select a node` | **PASS** |
| E5 | edit_rm_component on a node | `✗ ✗ … must select a component` | **PASS** |
| E6 | edit_rename nested_t `#2` | `✗ ✗ #2 is (in) a nested prefab instance` | **PASS** |
| E7 | edit_rm_node `#1` (root) | `✗ ✗ cannot remove the root node` | **PASS** |
| E8 | edit_set_parent self | `✗ ✗ cannot move a node into itself` | **PASS** |
| E9 | edit_set_parent cycle | `✗ ✗ cannot move a node into its own descendant` | **PASS** |
| E10 | edit_set_parent root `#1` | `✗ ✗ … into its own descendant` (root→child = descendant guard) | **PASS** |
| E11 | edit_swap_uuid no file/all | `✗ swap_uuid needs \`file\` …` (**single ✗** — MCP-layer error) | **PASS** |
| E12 | deps {asset:"zzz…"} | `✗ not found: …` (**single ✗**) | **PASS** |
| **FIX1a** | edit_add_component `NotARealComp` | `✗ ✗ unknown __type__ class(es): NotARealComp` — **FINDING-1 fix enforced via MCP** | **PASS** |
| **FIX1b** | edit_add_component `cc.Nope` dryRun | success (resolved:"cc.Nope") — cc.* trusted, by design | **PASS** |
| **FIX2a** | edit_set `_materials.5` (OOB) | `✗ ✗ index 5 is out of range … (0..1)` — **FINDING-2 fix via MCP** | **PASS** |
| **FIX2b** | edit_set_uuid `_materials.5` (OOB) | `✗ ✗ index 5 is out of range …` (typed-tool path) | **PASS** |

> **⚠ MCP-FINDING-3 (cosmetic) — inconsistent `✗` prefix.** Engine-seam errors already carry a
> `✗` (the `OM.*` constants / `OM.selErr` bake it in, `ops.js:19-29`), and `toolResult`
> (`server.js:125`) prefixes `✗` again → they render **`✗ ✗ …`** (double). MCP-layer plain-string
> errors that DON'T self-prefix (`deps`/`info` `not found` via resolveUuid `tools.js:20`; swap
> missing-file `tools.js:219`) render a single `✗`. **Fix (must touch both sides, not just toolResult):**
> naively dropping the `✗` in `toolResult` would strip the only `✗` off the bare MCP-layer errors.
> Correct = normalize to one `✗` at the source: have `toolResult` emit `res.error` verbatim (no added `✗`)
> AND prefix the two bare MCP-layer strings (`tools.js:20`,`:219`) with `✗ `. Net: every error reaches
> `toolResult` carrying exactly one `✗`. Severity: trivial.

## C — Cache / fs.watch / rescan / status (continued)

| id | scenario | observed | result |
|----|----------|----------|--------|
| C2 | `info` baseline → **external CLI** rename (39729→39732 B) → coir-edit `tree` | tree shows `RootNodeCLI` with NO rescan call (fs.watch on external *modify*) | **PASS** |
| C3 | `edit_rename`/adds (MCP write) → `tree` | tree reflects shieldMCP/coir_mcp_node/sword-inactive (markDirty→ensureFresh) | **PASS** |
| C4 | `edit_set dryRun` → `get` | value unchanged; dryRun does NOT markDirty (file pristine) | **PASS** |
| C5 | `rescan {}` | `{rescanned:true,assets:32}` | **PASS** |
| C7 | 8 writes fired back-to-back to one file | all applied in order, no mtime-race error (serialized promise chain) | **PASS** |
| C8 | MCP-level mtime guard | **Hard to reach via tool sequencing** (not proven unreachable): each edit re-reads the file fresh (`loadDoc`) and `ensureFresh` rescans on `dirty`, so the guard almost never fires from cache staleness — but a `get`/dryRun (which does NOT markDirty, see C4) followed by an external edit then a non-force write could in principle race the loadDoc↔commit window. The guard *code* is proven CLI-side (RESULTS.md D05/D06); `force` arg accepted (F4). | **N/A (mechanism sound, not exhaustively triggered)** |

## F — dryRun / backup / force as MCP args

| id | call | observed | result |
|----|------|----------|--------|
| F1 | `edit_set_active {dryRun:true}` | no write, plan returned | **PASS** |
| F2 | `edit_rename {backup:true}` | `.bak` created = pre-write copy of the file | **PASS** |
| F3 | `edit_set_active {dryRun:true,backup:true}` | **dryRun wins** → no `.bak`, no write | **PASS** |
| F4 | `edit_set_active {force:true}` | commits (force accepted as MCP arg) | **PASS** |

## W/N — Write dispatch + native cross-check (MCP write → engine readback)

| id | tool (MCP) | engine readback | result |
|----|-----------|-----------------|--------|
| N1 | `edit_rename shield→shieldMCP` | RootNode child renamed (engine loaded) | **PASS** |
| W7 | `edit_set_active sword false` | node `active:false` (proper **bool**) | **PASS** |
| N2 | `edit_transform {kind:"rot",30,60,90}` | rotation == {30,60,90}; clean quat `{.5,.5,.5,.5}` — **collapse path + euler→quat** | **PASS** |
| W3 | `edit_set_uuid _materials.0 → tree.mtl` | `sharedMaterials[0]` uuid = tree.mtl (proper **uuid ref**) | **PASS** |
| N3 | `edit_add_node coir_mcp_node` | node present | **PASS** |
| N6 | `edit_set_parent → Bip001 index:0` | `coir_mcp_node` is Bip001's child[0] (splice via MCP) | **PASS** |
| N4 | `edit_add_component MyCoirComp` | resolved=compressed token `0b68bd15…`; engine loaded shield01 with 2 components (script present) — **FINDING-1 fix inherited by MCP** | **PASS** |
| **W1** | `edit_set _enabled value:false` / `_shadowCastingMode value:2` | engine stores **`"false"`/`"2"` as type String** (NOT bool/int) — see FINDING-4 | **FAIL → FINDING-4** |

> **⚠ MCP-FINDING-4 (HIGH, MCP-layer) — `edit_set` with the Claude Code host writes mistyped values.**
> `edit_set`'s `value` is the **only** param across all 26 tools declared without a `type`
> (it's "any JSON"; confirmed by enumerating every tool's inputSchema). With the **Claude Code
> MCP host**, an untyped arg is sent **non-uniformly**: `false→"false"`, `2→"2"`, an object
> `{__type__:"cc.Color",…}→` its stringified JSON — but a plain string like `"hello world"`
> passes through raw (and `"42"`→`"\"42\""`). coir's server `JSON.parse` preserves whatever
> arrives, and `edit_set` writes `a.value` verbatim (no coercion) → the prefab gets a string.
> **Attribution**: this is **client-side** (coir's server does NOT stringify; a spec-compliant
> host that passes untyped JSON faithfully would avoid it) — so "corrupts" overstates coir's
> fault; it's a **robustness gap**, HIGH because the Claude Code host is a primary consumer.
> **Blast radius (bigger than first written)** — three distinct breakages, all confirmed live:
> 1. **scalars** → `_enabled` loads as `type:"String" value:"false"` (and `"false"` is *truthy* → silently the OPPOSITE of intended); `_shadowCastingMode` as `"2"`.
> 2. **wrapper objects** → `{__type__:"cc.Color",…}` written as a JSON string (the tool's headline use-case is broken).
> 3. **the unknown-`__type__` safety guard is DEAD** → `value:{__type__:"NotARealClassXyz"}` passes, because `resolveRawTypes` runs on the stringified value and never sees `__type__` (FINDING-1's protection does not reach `edit_set` via MCP).
>
> **Scope is `edit_set` ONLY** — every typed-param write tool wrote correct types and passed
> native readback: `edit_set_active`(bool→`active:false`), `edit_transform`(numbers→rot {30,60,90}),
> `edit_set_layer`(number→`_layer:33554432` int), `edit_set_uuid`/`edit_swap_uuid`(asset strings→proper uuid ref),
> `edit_rename`, `edit_add_node`, `edit_set_parent`.
>
> **Fix** — the naive "`JSON.parse` the string in `edit_set`" is **NOT safe**: it would corrupt a
> genuine string property whose text is JSON-shaped (`cc.Label._string` = `"42"`/`"true"`/`"null"`
> → coerced to number/bool/null). The CLI avoids this by letting the user state intent
> (`--str` verbatim vs `--json` parsed, `editCli.js` resolveValueSpec). **Recommended (mirror the CLI):**
> add an explicit discriminator — a `json:true` flag (or a sibling `valueJson` string arg): when set,
> `JSON.parse(value)`; else treat `value` as a literal scalar. Option B: give `value` an explicit
> primitive schema + a `valueJson` for wrappers (a typed schema also stops a compliant host
> stringifying bool/number at the source). **Ordering caveat**: whichever path parses, it must run
> **before** `resolveRawTypes` (tools.js:195) — else the unknown-`__type__` guard stays dead.
> Residual: a literal string that *is* a JSON keyword stays ambiguous under any heuristic → the
> explicit flag is the only fully-correct fix. (The CLI is unaffected — typed `--flags`.)

## Gap-fillers (untested tools/args)

| id | tool / args | observed | result |
|----|-------------|----------|--------|
| G-layer | edit_set_layer layer:33554432 | `_layer:33554432` (proper **int** — typed param; contrast edit_set FINDING-4) | **PASS** |
| G-deps-in | deps {direction:"in"} | `usedBy:[]` (fixture is unused) | **PASS** |
| G-closure-type | closure {type:"material"} | filtered to 2 materials | **PASS** |
| G-atlas-dup | atlas-dup {} | `{groups:[],atlasesScanned:0}` (plugin tool dispatches; no .plist) | **PASS** |
| G-spine-dup | spine-dup {} | `{groups:[],atlasesScanned:0}` (plugin tool dispatches; no .atlas) | **PASS** |
| G-anim/skel | anim/skel | not exercised — NewProject_386 ships no `.anim`/`.skel` (plugin-tool dispatch proven by atlas-dup/spine-dup) | **N/A** |

The typed-param contrast is decisive: `edit_set_layer` (layer:number) wrote a proper int, while
`edit_set` (value:any) wrote `"33…"`-style strings — isolating **FINDING-4 to `edit_set` alone**.

## Audit-driven additions (Workflow #2)

| id | call | observed | result |
|----|------|----------|--------|
| W5 | `edit_swap_uuid {all:true, old:plane.mtl, new:tree.mtl}` | dryRun scoped to 1 file (fixture only) → committed: totalFiles:1, runSwapAll+markDirty path works | **PASS** |
| FIX1-gap | `edit_set value:{__type__:"NotARealClassXyz"}` dryRun | **passes (no error)** — the unknown-`__type__` guard is **DEAD via edit_set** (resolveRawTypes walks the stringified value) → part of FINDING-4 | **expands FINDING-4** |


## Summary

| section | scope | result |
|---------|-------|--------|
| C — cache/fs.watch/rescan/serialize | C1–C7 | **6 PASS** (C8 mtime guard N/A — mechanism sound) |
| D — read-tool dispatch + arg shapes | 18 tools/variants | **18 PASS** |
| E — error mapping → isError | 11 guards + FIX1a/b + FIX2a/b | **15 PASS** |
| F — dryRun/backup/force args | F1–F4 | **4 PASS** |
| W/N — write dispatch + native readback | 9 | **8 PASS + 1 FAIL (FINDING-4)** |
| Gap-fillers | layer/deps-in/closure-type/atlas-dup/spine-dup/all:true | **6 PASS** (anim/skel N/A — no fixtures) |

**Total ≈ 57 PASS · 1 functional FAIL (FINDING-4) · 1 cosmetic finding (FINDING-3).**

The coir MCP server's protocol dispatch, arg-shape mapping, error→`isError` mapping, the
`fs.watch` cache invalidation (on external **create** AND **modify**, with no explicit rescan),
`rescan`/`status`, serialized calls, and `dryRun`/`backup`/`force` args all work. **Both engine
fixes are enforced through the MCP path** (FINDING-1 add-component type check via the typed
`type` param; FINDING-2 array bounds). The MCP-only **findings**:
- **FINDING-4 (HIGH)** — `edit_set`'s untyped `value` is mistyped by the Claude Code host
  (scalars, wrapper objects, AND the unknown-`__type__` guard all affected). Fix = an explicit
  `json`/`valueJson` discriminator mirroring the CLI's `--str` vs `--json`, parsed before `resolveRawTypes`.
- **FINDING-3 (trivial)** — double `✗ ✗` on engine-seam errors; normalize prefixing.

The edit *engine* itself is unchanged from `RESULTS.md` (80 PASS) — this run validated the MCP
wrapper, not the engine. Fixtures restored to pristine after every group; real assets never
touched (`all:true` dry-run-scoped to the fixture first).

## Fixes applied + native regression (FINDING-3 & FINDING-4)

Both MCP-layer findings fixed in `src/mcp/`:
- **FINDING-4** (`tools.js` `edit_set`): if `value` is a string, `JSON.parse` it back to its type
  (parsed **before** `resolveRawTypes`, so the unknown-`__type__` guard sees the real object);
  a non-JSON string is kept verbatim; new **`raw:true`** flag forces verbatim for a literal
  JSON-shaped string. Schema/description updated.
- **FINDING-3** (`server.js` toolResult call): strip any leading `✗` from the error then add
  exactly one → every error renders with a single `✗` (engine-seam and MCP-layer alike).

New tests in `test/mcp.test.js` (3): edit_set parses string→type + `raw:true` literal +
non-JSON kept; guard fires on a parsed object; errors carry exactly one `✗`. **`npm test`
161/161; tsc clean.**

Native regression (fresh-spawned `coir mcp` with the new code, host-style **string** values →
engine readback via cocos-creator):

| check | before fix | after fix | result |
|-------|-----------|-----------|--------|
| `edit_set _enabled value:"false"` → engine | `type:"String" value:"false"` (truthy!) | **`type:"Boolean" value:false`** | **FIXED** |
| `edit_set _shadowCastingMode value:"2"` → engine | `type:"String" value:"2"` | **`type:"Number" value:2`** | **FIXED** |
| `edit_set _coirCol value:'{cc.Color…}'` (string) | written as a JSON string | proper `cc.Color` object (coir get) | **FIXED** |
| `edit_set _x value:'{__type__:"NotReal"}'` | guard dead (passed) | **rejected** `unknown __type__` | **FIXED** |
| error prefix | `✗ ✗ …` (engine-seam) | single `✗ …` (both paths) | **FIXED** |

Both findings resolved (CLI + MCP unaffected — the engine is unchanged). Project restored
(29 assets, metaErrors=0); editor on main.
