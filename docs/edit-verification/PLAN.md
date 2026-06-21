# coir `edit` — native verification PLAN

Curated, ordered, executable matrix. Derived from a multi-agent design pass (8
agents → **224 candidate specs** in `_design_raw.json`), de-duplicated here into the
canonical set actually executed. Every `edit` op, every `set` value-flag, and every
documented guard appears ≥ once.

Conventions: `coir …` = `node <repo>/src/cli.js -C <NewProject_386> …`.
Fixtures: `_coirtest/soldier_t.prefab` (clean), `_coirtest/nested_t.prefab` (nested
instances #2/#15; editable child `nested_t/Node`), `_coirtest/scene_t.scene`,
`model/helloWorld/folder-001/sky.png` (non-prefab). Grounded facts:
component `soldier_t/RootNode/soldier:cc.SkinnedMeshRenderer` has `_enabled`(bool),
`_shadowCastingMode`(int), `_materials[0]`=`8a58ddec-…`; swap target `material/tree.mtl`.

Verify levels (honest labelling in RESULTS):
- **native-readback** — engine reports the exact written value (instantiate/open → `node_get_node_info`/`component_get_components`). Strongest.
- **native-load** — engine `reimport_asset` accepts the file (proves validity/loadability) + coir re-reads the written value. Used when the prop isn't trivially node-readable.
- **cli-exit** — assert exit code + file bytes unchanged (refusals, dry-run, guards).
- **cli-reread** — assert coir output shape (read-only ops).

---

## Phase R — Refusals & guards  (cli-exit; batched)

| id | op / case | command (args after `-C`) | expect |
|----|-----------|---------------------------|--------|
| R01 | not a prefab/scene | `edit model/helloWorld/folder-001/sky.png rename x y` | exit 2, no write |
| R02 | unknown op | `edit _coirtest/soldier_t.prefab frobnicate x` | exit 1 |
| R03 | missing op | `edit _coirtest/soldier_t.prefab` | exit 1 |
| R04 | selector not found | `edit _coirtest/soldier_t.prefab rename NoSuch/Node x` | exit 2 |
| R05 | ambiguous selector | (create 2 same-name siblings first, then) selector w/o `[i]` | exit 2 + candidates |
| R06 | set on non-property (node sel) | `edit … set soldier_t/RootNode --str hi` | exit 2 (needProp) |
| R07 | rm-component on a node | `edit … rm-component soldier_t/RootNode` | exit 2 (needNode/needComp) |
| R08 | rm-node on a component | `edit … rm-node soldier_t/RootNode/soldier:cc.SkinnedMeshRenderer` | exit 2 (needNode) |
| R09 | set unknown component | `edit … set soldier_t/RootNode:cc.Nope._x --int 1` | exit 2 |
| R10 | add-component unknown type | `edit … add-component soldier_t/RootNode cc.Nope` | exit 1/2 |
| R11 | bad hex color | `edit … set <comp>._x --color #ZZZ` | exit 1 |
| R12 | invalid JSON | `edit … set <comp>._x --json '{bad'` | exit 1 |
| R13 | unknown __type__ in --json | `edit … set <comp>._x --json '{"__type__":"cc.Nope"}'` | exit 1 |
| R14 | missing value flag | `edit … set <comp>._enabled` | exit 1 |
| R15 | wrong value flag | `edit … set-pos soldier_t/RootNode --str hi` | exit 1 |
| R16 | --uuid no asset | `edit … set <comp>._materials.0 --uuid` | exit 1 |
| R17 | set-rot without --vec3 | `edit … set-rot soldier_t/RootNode --int 1` | exit 1 |
| R18 | instance guard (edit instance node) | `edit _coirtest/nested_t.prefab rename <instance-path> x` | exit 2 |
| R19 | subtree-instance guard (rm-node) | `edit _coirtest/nested_t.prefab rm-node nested_t` (root subtree has instances) | exit 2 |
| R20 | rm-node root | `edit _coirtest/soldier_t.prefab rm-node soldier_t` | exit 2 |
| R21 | set-parent cycle | `edit … set-parent soldier_t/RootNode soldier_t/RootNode/soldier` | exit 2 |
| R22 | --all non-swap | `edit --all rename a b` | exit 1 |
| R23 | swap-uuid zero refs | `edit … swap-uuid <unused-uuid> material/tree.mtl` | exit 0 no-op, no write |
| R24 | swap-uuid old===new | `edit … swap-uuid 8a58ddec-… 8a58ddec-…` | no-op |
| R25 | rm-component on a #N PrefabInfo | `edit … rm-component <prefabinfo #N>` | exit 2 |

## Phase D — Dry-run, backup, mtime/force, json shape  (cli-exit)

| id | case | expect |
|----|------|--------|
| D01 | `set … --dry-run` | exit 0, file byte-identical |
| D02 | `rm-node … --dry-run` | exit 0, file byte-identical |
| D03 | `swap-uuid … --dry-run` | exit 0, file byte-identical |
| D04 | `set … --backup` writes `<file>.bak` | .bak exists, == pre-edit bytes |
| D05 | mtime guard: read, then `touch` file, then write | exit 2 (changed on disk) |
| D06 | `--force` overrides mtime guard | writes anyway |
| D07 | `set … -o json` | parses; has `file`,`dryRun:false` |
| D08 | `swap-uuid … -o json --dry-run` | parses; `dryRun:true`, no write |

## Phase RO — Read-only  (cli-reread)

| id | case | expect |
|----|------|--------|
| RO01 | `tree` whole tree | node count + indented tree |
| RO02 | `tree --depth 1` | depth-limited |
| RO03 | `tree --with cc.SkinnedMeshRenderer` | flat, only matching |
| RO04 | `tree --under soldier_t/RootNode` | subtree |
| RO05 | `tree -o json` | valid json `{file,nodeCount,nodes}` |
| RO06 | `get <comp>._enabled` scalar | `true` |
| RO07 | `get <comp>._materials.0` → __uuid__ | path + uuid annotation |
| RO08 | `get soldier_t/RootNode/soldier:cc.SkinnedMeshRenderer` whole comp | object, `// className` if compressed |
| RO09 | `get <comp>._nope` missing | `(no such property)` |
| RO10 | `get soldier_t/RootNode` node sel | whole node object |
| RO11 | `get … -o json` raw | raw json round-trips into set --json |
| RO12 | selector `[i]` array element | element value |
| RO13 | selector `#N` absolute index | entry at index |

## Phase N — Native success  (soldier_t.prefab; instantiate → readback)

Each: `coir edit … --backup` → `reimport` → `instantiate` → readback → assert → delete node + restore `.bak` → `reimport`.

| id | op | command core | readback / assert |
|----|----|--------------|-------------------|
| N01 | rename | `rename soldier_t/RootNode RootNode_COIR` | find node `RootNode_COIR` exists (native-readback) |
| N02 | set-active | `set-active soldier_t/RootNode --bool false` | node `active:false` |
| N03 | set-layer | `set-layer soldier_t/RootNode --int 33554432` | node layer == |
| N04 | set-pos | `set-pos soldier_t/RootNode --vec3 1 -2 3.5` | node position == |
| N05 | set-scale | `set-scale soldier_t/RootNode --vec3 2 2 2` | node scale == |
| N06 | set-rot (1-axis) | `set-rot soldier_t/RootNode --vec3 0 0 90` | rotation ≈ (euler+quat) |
| N07 | set-rot (3-axis) | `set-rot soldier_t/RootNode --vec3 30 45 60` | rotation ≈ |
| N08 | set --bool | `set <comp>._enabled --bool false` | component `_enabled:false` (component_get_components) |
| N09 | set --int | `set <comp>._shadowCastingMode --int 0` | component prop == |
| N10 | set --color | `set <comp>._x --color #FF8800` | native-load (reimport ok) + coir reread |
| N11 | set --json | `set <comp>._x --json '{...}'` | native-load + coir reread |
| N12 | set --null / --num / --enum / --vec2/3/4 / --size / --quat | one each on a real prop | native-load + coir reread (coercion shape) |
| N13 | set-uuid | `set-uuid <comp>._materials.0 material/tree.mtl` | component `_materials[0]` uuid changed (native-readback) + reimport ok |
| N14 | swap-uuid | `swap-uuid 8a58ddec-… material/tree.mtl` | reimport ok + coir reread material swapped |
| N15 | swap-uuid --all | project-wide on a copy-safe uuid | reimport ok across hits |
| N16 | add-node | `add-node soldier_t/RootNode COIR_NEW` | new node present under RootNode (native-readback) |
| N17 | add-component | `add-component soldier_t/RootNode <ccType>` | component present on node (native-readback) |
| N18 | rm-component | remove a component | component gone + reimport ok |
| N19 | rm-node | `rm-node <a clean leaf>` | node gone + reimport ok + `coir analyze` metaErrors=0 |
| N20 | set-parent | `set-parent <nodeA> <nodeB>` | new parent + children lists (native-readback) |

## Phase S — Scene parity  (scene_t.scene)

| id | op | expect |
|----|----|--------|
| S01 | rename a node in `scene_t.scene` | open scene → node renamed (native-readback) |

---

Execution order: R → D → RO (all cli, batchable) → N (native, grouped on soldier_t) → S.
Results logged per-test to `RESULTS.md`. The 224-candidate superset in
`_design_raw.json` is the completeness backstop for the Phase-2 audit.
