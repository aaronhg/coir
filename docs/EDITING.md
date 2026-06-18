# Headless CLI editing of prefab / scene

> coir's read core is read-only; this page covers its **in-place editing capability**: changing existing Cocos prefab/scene files from the CLI — **never generating from scratch**, only editing what already exists. Implemented in `src/editCli.js` (command layer) + `src/edit/editPrefab.js` (write engine). The format contract is in [SERIALIZATION.md](SERIALIZATION.md).

Applies to **Cocos Creator 3.5.2 / 3.8.x**, the same code path (reasons in §2).

## 0. Design decisions

- **Only edit existing files**; there is no "generate a prefab from zero".
- **Delete = real delete + index compaction** (no soft-delete, no leftover array cruft).
- **Value type = explicit flag** (`--color` / `--vec3` / `--json` …, never auto-inferred).
- core stays DOM-free and read-only; writing lives only in the Node layer (`editPrefab.js`).
- Display and selector share the same addressing (`nodePath:Comp.prop`); what `--where`/web print can be pasted straight into `edit`.

## 1. Design principles

1. **Surgical** — parse into an array → touch only the target → write back, leaving untouched objects as unchanged as possible.
2. **Template-by-example** — when a new structural object is needed (`PrefabInfo`/`CompPrefabInfo`/`_mobility`/`__editorExtras__`…), **copy the skeleton of an existing same-kind object from the same file** then fill in values, only resetting identity fields. The file teaches us its own format → **3.5.2/3.8.x correct automatically, zero version branches**.
3. **Real delete + index compaction** — after deleting a node/component, remove it from the array, globally remap every `{__id__}`, scrub dangling cross-references, and reclaim orphaned sub-objects.
4. **Addressing = selector** (`nodePath:Comp.prop`), the same set used by `--where`/web display (`src/core/selector.js`).
5. **dry-run preview** — every write op accepts `--dry-run`, which only locates and does not write.

## 2. Why cross-version support is nearly free

- coir's `meta.js`/`scan.js` have **no version branches at all**, relying on `importer`/`uuid`/`subMetas` for universal parsing → reading/locating is version-independent to begin with.
- The three serialization essentials — `__id__`/`__uuid__`/compressed `__type__` — are stable from 3.0→3.8; version differences are "added fields", not "changed representation".
- Since we only modify what exists and preserve the rest, added fields don't affect us; new structures are handled by template-by-example.
- The **only** remaining version-sensitive point: an enum property's numeric semantics may differ across versions → `--enum` is the user's responsibility, with no automatic conversion.

## 3. Addressing model (selector)

| Selection target | Syntax | Example |
|---|---|---|
| Node | `<nodePath>` | `Canvas/Panel/Title` |
| Same-name disambiguation (sibling order) | `<nodePath>[i]` | `Canvas/Item[2]` |
| Absolute index (escape hatch) | `#<arrayId>` | `#14`, `#4._string` |
| Component | `<nodePath>:<Type>` | `Canvas/Title:cc.Label`, `Player:ShopCtrl` (custom scripts by class name) |
| Multiple same-type components | `<nodePath>:<Type>[i]` | `Fx:cc.Sprite[1]` |
| Property (nestable) | `<nodePath>:<Type>.<prop>` | `Canvas/Title:cc.Label._string`, `Bg:cc.Sprite._color.r` |
| Array element | `…<prop>[i]` (or `.<i>`) | `Btn:cc.Button.clickEvents[0].handler` |

**Unified index rule**: `[i]` is a **0-based, array-order** "relative" index, appearing in three places with consistent semantics — same-name nodes (leaf), same-type components, and array elements; `#N` is the **absolute array-index escape hatch** (skips all matching, goes straight to `arr[N]`, may carry `.prop`). `prop[i]` is normalized to `prop.i` in `setDeep`, so both `[i]` and `.i` notations work.

**A few parsing rules:**
- **Separator `:`** (not `@`): `@` is reserved for `uuid@sub` (sub-asset); the selector uses `:` for "a node's component", so the semantics don't overlap.
- **Type `.` vs property `.` disambiguated by allowlist**: `cc.Label` carries its own namespace dot, which collides with the property dot. When parsing, the scan's known "which component `__type__`s are actually attached to that node" serves as the allowlist, and a **longest match** is done after the `:` (`cc.Label` hits as the type, the remaining `_string` as the property). Custom scripts enter the allowlist under their class name decompressed from `__type__`.
- **Full path first**: first try a literal exact match of the nodePath (so a node actually named `Slot[0]` can be selected), then fall back to stripping a trailing `[i]`.
- Non-unique resolution → **exit 2** listing candidates.
- **Ambiguity always errors (never silently guesses)**: when `[i]` is omitted and there are multiple matches — same-name nodes *or* multiple same-type components — both **exit 2** asking you to supply `[i]` (nodes and components behave the same way). A single match hits directly, no `[i]` needed.

## 4. Value encoding (explicit flags)

The value for `set` / node ops always states its type explicitly via a flag, **never inferred**:

| Flag | Produces | Example |
|---|---|---|
| `--str <s>` | JSON string | `--str "Hello"` |
| `--int <n>` / `--num <n>` / `--enum <n>` | integer / float / enum (semantics are the user's responsibility) | `--int 3` |
| `--bool <true\|false>` | boolean | `--bool false` |
| `--color #RRGGBB[AA]` or `--color r g b a` | `cc.Color` (invalid hex → error) | `--color #ff0000ff` |
| `--vec2/--vec3/--vec4 …` / `--size w h` / `--quat …` | the corresponding `cc.*` wrapper type | `--vec3 0 0 1` |
| `--uuid <asset>` | `{__uuid__:…}` (via `resolveAsset`; missing asset → error) | `--uuid icons/coin.png` |
| `--null` | `null` (clear) | |
| `--json '<json>'` | a whole object/array/value; if `__type__` is a **class name** it is auto-converted to a compressed token (builtin / already-compressed passthrough; unknown class name → error) | `--json '{"__type__":"SpriteConfig","frameName":"x"}'` |

Each value flag consumes only its own arity of tokens (`--vec3`=3, `#hex`=1…), and does not swallow following positional arguments.

### Custom types (such as `SpriteConfig`)

A custom serialized value is just a `{__type__:"<compressed>", fields...}` object in the file:
- **Change a field**: `set "…:Comp._cfg.frameName" --str x`, `._cfg.keys[0] --str y` (`__type__` is preserved automatically).
- **Replace/build the whole thing**: `--json '{"__type__":"SpriteConfig",…}'` (the class name is auto-converted to a compressed token).
- If the value is a standalone entry (`{__id__:N}`) rather than inline: address it via `#N.frameName`.

## 5. Operation catalog

Shared flags: `--dry-run` (locate only, don't write) · `--backup` (save a `.bak` before writing) · `-o json` (structured output; defaults to text).

### Tier 0 — asset-reference layer (text patch, minimal diff, version-independent)
| Command | Effect |
|---|---|
| `swap-uuid <oldAsset> <newAsset>` | Repoint references A→B across the whole file (including `A@sub`→`B@sub`; `old===new` is a no-op) |

### Exploration — `tree` (read-only, structure discovery)
| Command | Effect |
|---|---|
| `tree [--with <Type>] [--under <sel>] [--depth N]` | List the node hierarchy + each node's components, **with every path / selector already disambiguated and ready to paste back into another op** (same-name siblings auto-get `[i]`, multiple same-type components get `[i]`, custom scripts show the class name). `-o json` for agents (each component carries a ready `nodePath:Type` selector); `--with` keeps only nodes carrying a given component, `--under` restricts to a subtree, `--depth` limits the depth (default: the whole tree). Marks `(off)` for disabled nodes and `[prefab instance]` for nested instances |

> `tree` is the solution for "blind editing": an agent can obtain every editable selector of any prefab without parsing JSON (`tree` to explore → `get` to read in detail → `set`/structural ops to change, a three-stage flow). `--with` also turns "edit across files by type" into a clean pipeline (`find .prefab` → per-file `tree --with cc.Label -o json` → `set`).

### Tier 1 — property-value layer (parse-rewrite)
| Command | Effect |
|---|---|
| `get <sel>` | **Read-only** — read the value/node/component of a selector. `-o json` prints the raw value (which can be fed straight back into `set --json`); the text form annotates `{__uuid__}` with the asset path and a compressed `__type__` with the class name |
| `set <sel:Type.prop> <value flag>` | Change a basic value / enum / wrapper type / `--json` custom object |
| `set-uuid <sel:Type.prop> <asset>` | Point a property at an asset (clear it with `set … --null`) |

> `get`/`set` are a read/write pair: the object you get from `coir edit X.prefab get "A:Comp._cfg" -o json`, once edited, can be written back with `set "A:Comp._cfg" --json '<that string>'` (compressed `__type__` passthrough, a closed loop).

### Tier 2 — node layer (parse-rewrite)
| Command | Effect |
|---|---|
| `rename <nodeSel> <newName>` | Change `_name` (empty `''` allowed) |
| `set-active <nodeSel> --bool <b>` | Change `_active` |
| `set-layer <nodeSel> --int <n>` | Change `_layer` |
| `set-pos / set-scale <nodeSel> --vec3 x y z` | Change `_lpos`/`_lscale` |
| `set-rot <nodeSel> --vec3 x y z` (Euler degrees) | Writes both `_euler` + `_lrot` (quaternion, formula bit-identical to the engine's `Quat.fromEuler`) |
| `set-parent <nodeSel> <newParentSel> [--index i]` | reparent (update both sides' `_children` + `_parent`; rejects cycles/root) |

Each node op checks the value flag's type (`set-pos` only takes `--vec3`…), erroring out immediately on a type mismatch to avoid stuffing a scalar into a Vec3 field.

### Tier 3 — structural add/remove (template-by-example + index compaction)
| Command | Effect |
|---|---|
| `add-node <parentSel> <name> [--index i]` | Append a node (clone the same-file skeleton) + its PrefabInfo (reset root/asset/…) |
| `rm-node <nodeSel>` | **Real-delete** the subtree + each component + Prefab/CompPrefabInfo + orphaned sub-objects, remapping all `__id__` |
| `add-component <nodeSel> <ccType>` | Add a minimal component (+ a CompPrefabInfo for a prefab file) |
| `rm-component <sel:Type>` | Real-delete the component + its CompPrefabInfo + orphaned sub-objects |

### Project-level (`--all`)
| Command | Effect |
|---|---|
| `edit --all swap-uuid <oldAsset> <newAsset>` | Repoint **every** prefab/scene reference to an asset (prefab/scene only; an unparseable file warns rather than failing silently) |

`--all` only supports `swap-uuid` (only uuid-keyed ops generalize across files); a selector-based op with `--all` errors out directly.

## 6. Write strategy (two modes)

| Edit kind | Mode | diff |
|---|---|---|
| `swap-uuid` (incl. `--all`): pure asset repoint | **textual surgical patch** (quote-anchored string replacement) | minimal, no reordering, no re-serialization |
| Everything else (`set`/node ops/structural add/remove) | **parse → mutate the array → `JSON.stringify(…,2)`** (+ structural ops do index compaction) | touches values/topology, re-serializes the whole thing |

### Text patch (swap-uuid)
`"<old>"`→`"<new>"` and `"<old>@`→`"<new>@`` (the sub-asset sub-id is left untouched). A full uuid appears in a prefab only as a `__uuid__` value (a compressed `__type__` is a different string and won't be hit), so quote-anchoring is safe.

### Index compaction (the core of rm, `removeEntries`)
```
seed = target node subtree + all its components + their Prefab/CompPrefabInfo
set  = ownedClosure(seed)        // then absorb sub-objects "referenced only by seed" (ClickEvent / PrefabInstance)
scrubRefs:  remove deleted refs from owner lists; null out "cross-reference" properties pointing at a deleted entry
keep = arr filtered to drop set;  remapIds: each {__id__:N} → oldToNew[N]
```

### Template-by-example (add)
`cloneOf(arr, 'cc.Node' / 'cc.PrefabInfo' / 'cc.CompPrefabInfo')` deep-copies the first same-kind object in the same file and resets identity fields (`_id`/`fileId`/`root`/`asset`/`instance`/`nestedPrefabInstanceRoots`). `isPrefabFile` decides whether to attach a Prefab/CompPrefabInfo (scene nodes get `_prefab:null`).

## 7. Safety mechanisms

- `--dry-run`: preview before writing (prints locations / the value to be written).
- **Format check**: `loadDoc` confirms it's a 3.x array-of-objects (blocks 2.x `.fire`, non-arrays).
- **Unique selector resolution**: ambiguity → exit 2 listing candidates.
- **Value-type check**: a node op given the wrong type flag, an invalid hex for `--color`, a missing asset for `--uuid`, an unknown class name for `--json` → all error out **without writing the file**.
- **Nested prefab instance guardrail**: a selector op detects the target (`assertEditable`); `rm-node` detects whether the **entire subtree** (`subtreeHasInstance`) has any `PrefabInfo.instance ≠ null`, and if so blocks it and points the way (edit it in the source prefab). `swap-uuid` is exempt (pure repoint, safe at any position).
- **Write**: atomic write (temp → rename); `--backup` saves `<file>.bak`.
- **rm-component safeguard**: only accepts a real component with a `node` back-ref; a `#N` pointing at a PrefabInfo/CompPrefabInfo/ClickEvent is blocked.

**Nested-prefab scope decided**: when A.prefab contains a B.prefab instance, only "editing A's non-B parts" and "editing `B.prefab` directly" are supported; that B instance inside A (and the subtree containing it) is always blocked. **Does not touch** `propertyOverrides` override editing.

## 8. Architecture and modules

Hold the existing split: `src/core/**` is read-only, writing lives in the Node layer. **The read/write logic is extracted into a shared seam**, so the CLI (text presentation) and the **MCP server** (JSON tools) share one source — one logic, only presentation differs.

```
src/core/selector.js   ← shared addressing (DOM-free, used by both browser + CLI)
  componentName(scan, raw)   // __type__ → class name (cc.Sprite / ScriptClass)
  locSelector(scan, loc)     // edge.location → pasteable nodePath:Comp.prop
  typeToken(scan, name)      // class name → compressed token (for --json; reverse)

src/edit/editPrefab.js ← pure file-mutating "engine" (@ts-check, no process/CLI): byte-level mutate
  loadDoc(→{raw,arr,mtime}) / serialize / writeAtomic(mtime guard)
  planSwapUuid               // Tier0 text patch
  listNodes                  // tree: structure discovery (disambiguated path + ready component selector)
  resolveSelector / buildNodeIndex / setDeep / getDeep
  eulerToQuat / setParent
  addNode / addComponent     // template-by-example (cloneOf)
  removeNode / removeComponent → {newArr, removed, cleared}
  removeEntries / ownedClosure   // index compaction
  nestedInstanceRoot / subtreeHasInstance   // instance guardrail

src/edit/ops.js        ← pure "write seam" (@ts-check, no print/exit; one source for CLI + MCP)
  runEdit(scan,dir,op,params) → {json, writes} | {error,code,candidates}  // resolve→load→mutate
  runSwapAll                 // --all whole project
  getData / treeData         // read a file's selector / structure
  commitWrites(writes,{backup,force})   // land it + mtime guard
  resolveRawTypes            // class-name __type__ → token (shared by set/--json)
src/seam/query.js       ← pure "read seam": depsData / infoData / findData / closureData

src/seam/shared.js       ← resolveTarget/resolveAsset, edgeMaps/orphansOf, locText/locJson, base/kb/edgeSort
src/editCli.js         ← the CLI layer for edit: arg/value-flag parsing + text presentation + commit; all mutation delegated to ops.js
src/cli.js             ← query commands + parseArgs + dispatch + USAGE + intercept `coir mcp`
src/mcp/server.js      ← hand-rolled JSON-RPC/stdio + queue + fs.watch invalidation + scan cache (see docs/MCP.md)
src/mcp/tools.js       ← typed tool table → ops/query
```

CLI entry:
```
coir edit <file> <op> <selector|args…> [value flag] [--dry-run] [--backup] [--force] [-o json]
coir edit --all swap-uuid <oldAsset> <newAsset> [--dry-run] [--backup] [-o json]
```
(`--force` skips the pre-write mtime guard; the same set of ops is also exposed via `coir mcp`'s MCP tools — see [docs/MCP.md](MCP.md).)

## 9. Examples

```bash
# Explore: list the structure, get pasteable selectors (then feed them to get/set)
coir edit Shop.prefab tree                                  # indented hierarchy + #index + components
coir edit Shop.prefab tree --with cc.Label -o json          # only Label nodes, with ready selectors
coir edit Shop.prefab tree --under "Canvas/Panel" --depth 2 # limit subtree + depth

# Tier0: swap one asset's references for another (single file / whole project)
coir edit Shop.prefab swap-uuid old/coin.png new/coin.png --dry-run
coir edit --all swap-uuid old/coin.png new/coin.png --backup

# Tier1: change Label text / color / custom value
coir edit Shop.prefab set "Canvas/Title:cc.Label._string" --str "開始"
coir edit Shop.prefab set "Bg:cc.Sprite._color" --color #1a1a1aff
coir edit Shop.prefab set "Icon:ResSprite._cfg" --json '{"__type__":"SpriteConfig","frameName":"coin"}'

# Tier2: rename / move / rotate / reparent
coir edit Main.scene rename "Canvas/OldName" NewName
coir edit Main.scene set-pos "Canvas/Player" --vec3 100 0 0
coir edit Main.scene set-parent "Canvas/A" "Canvas/B" --index 0

# Tier3: real-delete a node (subtree + components + bookkeeping, compacting the index) / add a component
coir edit Shop.prefab rm-node "Canvas/Debug" --backup
coir edit Shop.prefab add-component "Canvas/Icon" cc.Widget
```

## 10. Tests

`test/cli.test.js` (node:test, subprocess against a self-built temp fixture, 97 cases): covers every op, each selector form (`[i]`/`#N`/array/allowlist, and the "multiple same-type components with no `[i]`" error), each value flag type, `--json` custom types, `tree` structure discovery (round-trip of the disambiguated path/selector, `--with`/`--under`/`--depth`, instance marking), each `analyze` section, the **cross-version dual fixture** (one 3.5.2-style and one 3.8.6-style, locking down template-by-example), real-delete + index compaction (`refIntegrity`, equivalent to `validate_scene`), `ownedClosure` (a ClickEvent removed along with it), the instance guardrail, `--all`, and the edge cases caught in a round of code review (invalid hex, type mismatch, missing `--uuid` value, the `rm-component` safeguard, empty-name rename, `swap old===new` no-op…). `test/mcp.test.js` additionally actually spawns `coir mcp`, speaks JSON-RPC, and verifies the MCP tools (read, `set` dry-run vs real write, structural edit, errors returning `isError`).

**Cross-version lock-down**: there is a dedicated dual-version fixture (`XV35.prefab` carrying `_level`, `XV38.prefab` carrying `_mobility`+`__editorExtras__`, built to the format of real 3.5.2 / 3.8.6 projects) — testing that `add-node` uses **the same code path** to produce the version-correct field set in each version (template-by-example, zero version branches), and that both versions pass `refIntegrity` after the add.

## 11. Done / phased

| Phase | Content | Status |
|---|---|---|
| Tier 0 | `swap-uuid` + text patch | ✅ |
| Tier 1/2 | `set`/`set-uuid`/`rename`/`set-active`/`set-layer`/transform/`set-rot`/`set-parent` | ✅ |
| Tier 3 | `add/rm-node`, `add/rm-component` + index compaction + template-by-example | ✅ |
| Project-level | `--all swap-uuid` + nested-instance guardrail | ✅ |
| Exploration | `tree` (structure discovery + ready selectors; `--with`/`--under`/`--depth`) | ✅ |
| Shared seam | extract `src/edit/ops.js` (`runEdit`…) + `src/seam/query.js`, one source for CLI + MCP; atomic+mtime write guardrail | ✅ |
| MCP server | `coir mcp`: hand-rolled zero-dependency JSON-RPC/stdio, typed tools (reads unprefixed / writes `edit_*`; `coir__<tool>` in a host) (see [docs/MCP.md](MCP.md)) | ✅ |
| Hardening | `--json` custom types, `[i]` unification, display↔selector unification, code-review fixes | ✅ |

## 12. Under discussion / future

- **Array structure editing** (append/insert/remove/reorder elements) — Tier 1 `set` only changes existing values; this is a Tier 3 kind, needing `add-array-item`/`rm-array-item`.
- Browser-side editing (File System Access is writable) — the Node-layer API is designed to be reusable by a browser provider.
- prefab instance `propertyOverrides` override editing (deliberately excluded).
- `set --all`'s "match-by-type across files" addressing — `tree --with` has already filled in the "discovery" half (`find` → `tree --with -o json` → `set` already works), leaving the one-stop `set --all :cc.Label._x` still to do; whether `--all` should include `.mtl`/`.anim` (current decision: no).

### MCP server (implemented → [docs/MCP.md](MCP.md))

The MCP server is **not a separate implementation** but a **thin typed adapter layer** on top of the shared seam (`src/edit/ops.js` + `src/seam/query.js`) (one logic), another exit at the same layer as the CLI (`coir mcp`, hand-rolled zero-dependency JSON-RPC/stdio).

- **Value**: ① a **per-tool permission boundary** for write operations (each `edit_rm_node` is a named, separately-approvable call; the `dryRun` parameter does a read-only preview); ② reaches GUI hosts with no shell; ③ a typed schema.
- **Ecosystem position**: a rare "headless, no editor open, can both deeply read-analyze and edit existing prefabs in place" Cocos MCP — existing Cocos MCP tools are mostly either read-only, or require opening the editor, or lean toward "generate from scratch".
- **Concurrency safety**: `fs.watch`-invalidated cache, fresh load on edit, mtime write guard, tool serialization (details in docs/MCP.md).
