# Cocos scene/prefab serialization contract

> coir reads this format, and coir's edit feature (see [EDITING.md](EDITING.md)) also writes it. This page records the details of that contract: **which fields coir actually relies on, and which it can ignore**, plus the respective trade-offs of the two approaches to "writing this format in place". Read this page before changing `scan`, writing a plugin, or maintaining the edit feature.

Applies to **Cocos Creator 3.5.2 / 3.8.x** (meta `ver` is usually `1.1.50`). 3.5.2 and 3.8.x agree on this contract; the difference is "adding fields", not "changing the representation".

---

## 1. Basic contract

Both scene (`.scene`) and prefab (`.prefab`) are **a single JSON array**, where each element is a serialized object. Objects cross-reference each other through three kinds of references:

| Form | Meaning | How coir handles it |
|---|---|---|
| `{"__id__": N}` | **Same-file internal** reference = array index N | Walks the prefab/scene tree to build `edge.locations` (nodePath · component.property · frame) |
| `{"__uuid__": "<full-uuid>[@sub]"}` | **External asset** reference (SpriteFrame / Prefab / AudioClip / script…) | Extracts → resolves into a dependency **edge** |
| `"__type__": "<23-char compressed token>"` | The type of a **custom script / custom serialized class** | `decompressUuid` restores it to a script path → `script` edge (see §3) |

> The `__type__` of built-in components/types is a plaintext class name (`cc.Sprite`, `cc.Label`, `cc.Vec3`…); only the `__type__` of custom classes (scripts, `@ccclass` serialized objects) is a compressed uuid.

The array index is the identity, which yields an iron rule: **you may only append, never reorder or hard-delete** — otherwise every `__id__` is wrong. The only way to delete safely is "remove then globally remap" (this is exactly what coir's editor does, see §6; tools that don't do this can only soft-delete, see §5).

---

## 2. Which fields coir relies on / which it can ignore

coir's dependency topology grows from **only** a few fields; the large remainder are internal bookkeeping for the engine/editor, which coir does not look at at all.

### coir **relies on** (touching these changes the topology)

| Field / source | Purpose |
|---|---|
| `{"__uuid__": …}` at any level | The primary source of dependency edges |
| The `"__type__"` (compressed) of a script/custom class | Decompress → `script` edge; also used for component-script pruning |
| The `importer` of `.meta` | → normalized `type` (meta.js lookup table) |
| The `uuid` / `subMetas[*].uuid` of `.meta` | Keys of the asset index; `uuid@subId` sub-asset addressing |
| `subMetas[*].userData.imageUuidOrDatabaseUri` | atlas→texture edge (plugin) |
| `.meta` `userData.textureUuid` / `spriteFrameUuid` etc. | font→texture, particle→texture edges (plugin) |
| Whether a source file exists (`hasSource`) | A meta with no source is dropped, but recorded in `scan.missing` for named orphan resolution |

### coir **ignores** (however you fill these, the topology is unaffected)

| Field | Belongs to |
|---|---|
| `cc.PrefabInfo` (`root` / `asset` / `instance` / `targetOverrides` / `nestedPrefabInstanceRoots`) | prefab instantiation bookkeeping |
| `cc.CompPrefabInfo`, a component's `__prefab` | Same as above (one per component) |
| `fileId` | prefab internal id |
| `__editorExtras__`, `_mobility`, `_id`, `_objFlags` | editor/node internal fields |
| `_lpos` / `_lrot` / `_lscale` / `_euler` / `_layer` / `_active` | transform and flags |
| `_name`, `asyncLoadAssets`, `optimizationPolicy`, `persistent` | asset miscellany |

**Corollary:** as long as two prefabs have the same `__uuid__` and compressed `__type__`, the dependency topology coir computes is **exactly identical**, no matter how complete or incomplete PrefabInfo/CompPrefabInfo/fileId are written. This is also why coir's editor can edit files in place without disturbing the topology (§6).

> **Nested prefabs.** `instance` / `targetOverrides` / `nestedPrefabInstanceRoots` (plus `cc.PrefabInstance`, `CCPropertyOverrideInfo`, `cc.TargetOverrideInfo`, `cc.TargetInfo`) are the **nested-instance** machinery — `fileId`-addressed value/reference overrides across the instantiation boundary, which coir's editor refuses to mutate in place. They are explained in detail in **[NESTED-PREFABS.md](NESTED-PREFABS.md)**.

---

## 3. UUID compression (`__type__`)

The `__type__` of custom classes uses **Cocos v2.0.10 base64 compression**: the first 5 hex characters stay unchanged, and the remaining 27 are compressed to 18 (total length 23; 22 in `min` mode).

- coir: `compressUuid` / `decompressUuid` / `looksCompressed` in `src/core/uuid.js`. `looksCompressed` is only a heuristic gate; after decompression the value is still validated against the asset index before an edge is created.
- coir's edit feature also uses this: when reading a selector it calls `decompressUuid` (compressed `__type__` → class name), and when `--json` writes a custom value it calls `compressUuid` (class name → compressed token).

> ⚠️ Easy mistake: a `__uuid__` asset reference is a **full** hyphenated uuid (optionally with `@subId`), and is **never compressed**; only `__type__` is compressed. Don't confuse the two.

---

## 4. Two approaches to "writing this format in place"

The tools in the wild that write this format roughly split into two camps, with exactly opposite trade-offs — understanding them helps maintain coir's editor:

- **In-editor (editor-API)**: operate within the Cocos process via the editor message API, but the prefab part still **hand-crafts the JSON then reimports** to let the editor finish it off. The output is close to official: complete `PrefabInfo`/`CompPrefabInfo`, `__editorExtras__`/`_mobility`, but leaves half-finished bits (`_id:""`, random `fileId`) for the reimport to correct. Prerequisite: the editor must be open.
- **headless (write the JSON directly)**: don't open the editor, read and write the array directly. The output is a **minimal skeleton**, betting that the engine fills in defaults for the missing fields at load time. Fast, no editor needed, but the structure is incomplete and (without index compaction) can only soft-delete.

Field-by-field differences (the same prefab):

| Field | editor-API | headless |
|---|---|---|
| `cc.Prefab` `__editorExtras__:{}` / `asyncLoadAssets` | the former has it, the latter has it (each often misses one) | — |
| `cc.Node` `__editorExtras__` / `_mobility` | ✓ | **missing** |
| `cc.Node` `_id` | `""` (filled in by reimport) | 22-char random |
| `cc.PrefabInfo` | complete (`root`/`asset`/`instance`/`targetOverrides`/`nestedPrefabInstanceRoots`) | often only `{__type__, fileId}` |
| per-component `cc.CompPrefabInfo` | ✓ | often **absent entirely** |
| `fileId` shape | 22 chars (correct), but random | some stuff in a full uuid directly (**wrong shape**) |
| `.meta` | `ver:1.1.50` / `importer:prefab` / `files:[".json"]`… | nearly word-for-word identical |

**What this means for coir:** all the differences in the table above are **within fields coir ignores** (§2). So whichever camp's prefab coir scans, the topology result is consistent. The only difference is in "instance override / revert / apply linkage" — the headless minimal skeleton lacks the per-node/per-component bookkeeping, which is fine when used as a static template, but causes problems if you try to edit an instance and apply it back the way the editor does. coir's editor takes the template-by-example route (§6), sidestepping this pit.

---

## 5. Interop traps (affecting coir's analysis)

### Soft-delete residue (pollutes unused detection)

Because the array index is the identity (§1), tools without index compaction can only **soft-delete**: pull the node out of the parent's `_children`, set `_active=false`, clear `_parent`, but **the object still remains in the array**. If that dead node still carries `__uuid__` asset references, coir will count those assets as **still in use** when it scans.

> **Consequence:** in a project heavily edited with a soft-delete tool, coir's "unused" report will undercount (propped up by ghost nodes). **coir's own editor uses hard-delete + compaction (§6), so it leaves no such garbage.**

### prefab bookkeeping doesn't affect the topology

`PrefabInfo` / `CompPrefabInfo` / `fileId` / `__editorExtras__` all go through `__id__`/`fileId` internal references and **produce no asset dependency edges** (the corollary in §2).

### source-less meta

When the source is deleted but the `.meta` is left behind, coir drops that meta from the index but records it in `scan.missing`, so that prefabs/scenes still pointing at it resolve to a **named missing-source orphan** (rather than a bare uuid). A healthy scan reports `metaErrors=0`.

---

## 6. How coir itself writes this format

When the edit feature (see [EDITING.md](EDITING.md)) modifies an existing file in place, it deliberately avoids the pits of §4/§5:

- **Hard-delete + index compaction**: after deleting a node/component, remove it from the array, then globally remap all `{__id__}`, null out cross-references pointing into the deleted set, and remove sub-objects (ClickEvent / PrefabInstance) that should have been deleted but are only referenced by the deleted set. → No soft-delete garbage, no dangling `__id__`.
- **Template-by-example**: when adding a node/component/PrefabInfo, **clone the skeleton of an existing same-kind object in the same file**, only resetting the identity fields (`fileId`/`root`/`asset`/`instance`/`nestedPrefabInstanceRoots`/`_id`). → All fields for that file (that version) are automatically correct, with zero version branches.
- **Minimal diff**: pure asset repointing (`swap-uuid`) goes through a quote-anchored text replacement, with no reordering and no re-serialization.

In other words, coir's editor approaches official quality on "structural completeness" via template-by-example, and beats the soft-delete camp on "hard-delete" — and all of this depends only on the §1 contract of this page, not on any of the ignored fields in §2.

---

## 7. coir's construction surface (the Cocos-format coupling)

Template-by-example (§6) means coir **rarely hand-builds** an engine object — it clones a real one from the file. The inventory below is therefore the **complete coupling surface**: the only structures coir constructs from scratch (so if Cocos changes the format, these are the points to re-check). All live in `src/edit/editPrefab.js` unless noted.

### Hand-built typed structures (no template — full literal)

| Structure | Where | Fields coir authors | Cocos contract | Validated |
|---|---|---|---|---|
| **`cc.TargetOverrideInfo`** (P3 cross-ref) | `setCrossRef` | `source`/`sourceInfo`/`propertyPath`/`target`/`targetInfo` | cross-boundary reference system | live engine (`native-verify`) |
| **`CCPropertyOverrideInfo`** (P2 root override) | `setRootOverride` | `targetInfo`/`propertyPath`/`value` | instance value-override system | live engine |
| **`cc.TargetInfo`** (P2/P3) | `setRootOverride`/`setCrossRef` | `localID: [fileId]` | `fileId` addressing | live engine |
| **Component skeleton** | `addComponent` | `__type__`/`_name`/`_objFlags`/`node`/`_enabled`/`__prefab`/`_id` | component base fields | `native-verify` (engine applies defaults) |
| **`cc.PrefabInfo` fallback** | `addNode` | `{__type__, fileId}` (lacks `root`/`asset`) | PrefabInfo | ⚠ `needsReimport` |
| **`cc.CompPrefabInfo` fallback** | `addComponent` | `{__type__, fileId}` | CompPrefabInfo (trivial) | complete |
| **Value types** `cc.Vec2/3/4` · `cc.Quat` · `cc.Color` · `cc.Size` | `editCli.js` (value flags), `mcp/tools.js` (`edit_transform`), `eulerToQuat`/`addNode` resets | `x/y/z/w` · `r/g/b/a` · `width/height` | math / value-type fields | tests |

The **override trio** (`TargetOverrideInfo` / `CCPropertyOverrideInfo` / `TargetInfo`) is the deepest coupling — fully hand-built (these may not exist in the file to clone) — which is why they were each verified against the running editor. See [NESTED-PREFABS.md](NESTED-PREFABS.md).

### `fileId` generation (synthetic, not the editor's)

`pad22(seed)` = `"<seed>xxxx…"` padded to **22 chars**. Used for a new node's `_id`, its `PrefabInfo.fileId`, a new component's `_id`, and its `CompPrefabInfo.fileId`. Contract: a `fileId` is a 22-char token. coir's synthetic form is **engine-accepted** (`native-verify`), but it is not the editor's random base64, so the editor regenerates it on the next save.

### Field / ref conventions coir writes

- **Node** (reset by `addNode`): `_name` · `_parent` · `_children` · `_components` · `_prefab` · `_active` · `_lpos`/`_lscale`/`_lrot`/`_euler` · `_id`.
- **PrefabInfo** (reset by `addNode`): `fileId` · `root` · `asset` · `instance` · `targetOverrides` · `nestedPrefabInstanceRoots`.
- **Ref shapes**: `{__id__}` (intra-file) · `{__uuid__}` (asset).
- **Linking pushes**: `parent._children.push` · `node._components.push` · `PrefabInstance.propertyOverrides.push` · `PrefabInfo.targetOverrides.push` · `node._prefab = {__id__}` · `comp.__prefab = {__id__}`.

Everything else a new node/component carries comes from the **cloned template** (§6), not from coir — so it is not part of this coupling surface.

---

## References

- coir internals: `src/core/scan.js` (scan pipeline), `src/core/meta.js` (importer→type), `src/core/uuid.js` (compression), `src/core/selector.js` (`__type__` ↔ class name), `src/edit/editPrefab.js` (write engine), `CLAUDE.md` (architecture overview).
