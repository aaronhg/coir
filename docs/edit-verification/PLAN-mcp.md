# coir **MCP** server — test PLAN (MCP-layer focus)

Curated from a 4-lens workflow (**101 candidate specs** in `_mcp_design_raw.json`).
Scope = the MCP-specific surface only; engine validity is inherited from `RESULTS.md`
(80 PASS, same `src/edit/ops.js`). Tools: `mcp__coir-edit__*` (writes/reads) verified,
`mcp__cocos-creator__*` for native readback. Fixtures: `_coirtest/{soldier_t.prefab,
nested_t.prefab,MyCoirComp.ts}`, swap target `material/tree.mtl`.

Verify levels: **mcp-result** (tool result shape / isError) · **cli-reread** (cross-check vs
`coir` CLI) · **cache** (cache/watch behaviour) · **native** (engine readback via cocos-creator).

## D — Read-tool dispatch + arg shapes
| id | tool / args | expect |
|----|-------------|--------|
| D1 | `status {}` | `{project,assets,edges}` |
| D2 | `find {query:"soldier_t"}` | array incl. `_coirtest/soldier_t.prefab` |
| D3 | `find {query:"t",type:"prefab"}` | only prefabs (type-filter arg) |
| D4 | `find {query:"zzz…"}` | `[]` (miss = empty, NOT error) |
| D5 | `info {asset:"soldier_t.prefab"}` | full record (== CLI) |
| D6 | `deps {asset:"soldier_t.prefab"}` | `{dependsOn,usedBy}` both sides |
| D7 | `deps {…,direction:"out",limit:3}` | dependsOn capped 3, no usedBy (direction+limit args) |
| D8 | `closure {asset:"soldier_t.prefab",list:true}` | `{count,totalSize,items[]}` |
| D9 | `tree {file:"soldier_t.prefab"}` | `nodeCount:34`, selectors |
| D10 | `tree {…,with:"cc.SkinnedMeshRenderer",depth:3}` | pruned (with+depth args) |
| D11 | `get {…selector:"…_enabled"}` | `{value:true,kind:property}` |
| D12 | `get {…selector:"…:cc.SkinnedMeshRenderer"}` | whole component (kind:component) |
| D13 | `analyze {}` | stats, metaErrors:0 |
| D14 | `analyze {section:"all"}` | every section keyed |
| D15 | `duplicates {}` | structured (maybe empty), not error |
| D16 | `check {}` | default warn-only health, no exit code |
| D17 | `check {rules:[{name:"max-meta-errors",max:0,level:"error"}]}` | inline-rules arg, errors:0 |
| D18 | `share {asset:"soldier_t.prefab",depth:3}` | url contains `#topo=` |

## W — Write-tool dispatch + arg shapes  (native/cli-reread)
| id | tool / args | expect |
|----|-------------|--------|
| W1 | `edit_set {…_enabled, value:false}` | raw scalar value; commits |
| W2 | `edit_set {…_coirColor, value:{__type__:"cc.Color",r:255,g:136,b:0,a:255}}` | wrapper value JSON |
| W3 | `edit_set_uuid {…_materials.0, asset:"material/tree.mtl"}` | uuid ref written |
| W4 | `edit_swap_uuid {file, old, new}` | single-file repoint |
| W5 | `edit_swap_uuid {all:true, old, new}` | project-wide (scope-checked first!) |
| W6 | `edit_rename` | → native N |
| W7 | `edit_set_active` | bool |
| W8 | `edit_set_layer` | int |
| W9 | `edit_transform {kind:"pos"/"scale"/"rot",x,y,z}` | **collapses CLI set-pos/scale/rot** → native N |
| W10 | `edit_set_parent` | → native N |
| W11 | `edit_add_node` | → native N |
| W12 | `edit_rm_node` | → native N |
| W13 | `edit_add_component {type:"MyCoirComp"}` | compressed token → native N |
| W14 | `edit_rm_component` | removes + compacts |

## E — Error mapping (engine `{error}` → `isError` tool result, `✗ …`)
| id | call | expect isError text |
|----|------|---------------------|
| E1 | `edit_set` on `MyCoirComp.ts` | not a prefab/scene |
| E2 | `edit_set` selector not found | `no node …` |
| E3 | `edit_set` on a node sel (needProp) | must select a property |
| E4 | `edit_rename` node=component sel (needNode) | must select a node |
| E5 | `edit_rm_component` on a node (needComp) | must select a component |
| E6 | `edit_rename` nested_t `#2` (instance guard) | nested prefab instance |
| E7 | `edit_rm_node` `#1` (root) | cannot remove the root node |
| E8 | `edit_set_parent` self | cannot move a node into itself |
| E9 | `edit_set_parent` cycle | into its own descendant |
| E10 | `edit_set_parent` root `#1` | cannot move the root node |
| E11 | `edit_swap_uuid` no `file`/`all` | needs `file` (or all:true) |
| E12 | `deps {asset:"zzz…"}` | `not found: …` (single ✗) |
| E13 | `info` ambiguous basename | matches N assets + candidates |
| **E14** | **observe `✗` prefix consistency** | engine-wrapped errors show **`✗ ✗`** (double); resolveUuid errors single `✗` — record as MCP-FINDING |
| **FIX1a** | `edit_add_component type:"NotARealComp"` | **isError** unknown __type__ (FINDING-1 via MCP) |
| **FIX1b** | `edit_add_component type:"cc.Nope" dryRun` | **success** (cc.* trusted, by design) |
| **FIX1c** | `edit_add_component type:"MyCoirComp"` | success, `resolved`=compressed token → native |
| **FIX2a** | `edit_set …_materials.5 value:{__uuid__…}` | **isError** index 5 out of range (FINDING-2 via MCP) |
| **FIX2b** | `edit_set_uuid …_materials.5` | isError out of range (typed tool path) |

## C — Cache / fs.watch / rescan / status  (MCP-only)
| id | sequence | expect |
|----|----------|--------|
| C1 | server@29 → 3 fixtures created externally → `status` | 32, no rescan ✅ (done) |
| C2 | `info` baseline → external CLI edit of the file → `info` again | size delta, NO rescan call (fs.watch) |
| C3 | `edit_rename` → `tree` | rename visible (markDirty→ensureFresh) |
| C4 | `edit_set dryRun` → `get` | unchanged (dryRun does NOT markDirty) |
| C5 | `status` → `rescan` | `{rescanned:true,assets:N}` matches |
| C6 | `status` → external new asset → `rescan` | assets count grows |
| C7 | two `edit_set_active` back-to-back, same file | both apply, no mtime race (serialized chain) |
| C8 | mtime guard via MCP: stale cache + external change → `edit` w/o force vs `force:true` | refuse / then commit |

## F — Flags (dryRun / backup / force as MCP args)
| id | call | expect |
|----|------|--------|
| F1 | `edit_set_active {dryRun:true}` | no write, plan returned |
| F2 | `edit_rename {backup:true}` | `.bak` created == pre-edit |
| F3 | `edit_set_active {dryRun:true,backup:true}` | **dryRun wins** → no `.bak`, no write |
| F4 | `edit_set {force:true}` | commits (force accepted as arg) |

## N — Native cross-check (MCP write → engine readback)
| id | op | engine readback |
|----|----|-----------------|
| N1 | `edit_rename soldier→soldier_mcp` | node name == soldier_mcp |
| N2 | `edit_transform kind:rot 30/60/90` | rotation == {30,60,90} (collapse path + euler→quat) |
| N3 | `edit_add_node coir_mcp_node` | node present under RootNode |
| N4 | `edit_add_component MyCoirComp` | engine builds a **real MyCoirComp** (not Missing) — the FINDING-1 fix via MCP |
| N5 | `edit_rm_node coir_mcp_node` | node gone + metaErrors=0 |
| N6 | `edit_set_parent` | new parent + children lists |
| N7 | `edit_set _shadowCastingMode int 2` | component reads 2 |
| N8 | `edit_swap_uuid → tree.mtl` | material binds to tree.mtl |

Execution order: D (reads) → E+FIX (errors, no/■write) → C (cache) → F (flags) → W/N (writes
batched per fixture, native readback). Fixtures restored from `/tmp/coir_mcp_pristine` between
destructive groups; real assets never touched.
