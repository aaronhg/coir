# Nested prefabs: instances, property overrides, target overrides

How Cocos Creator 3.x serializes a prefab/scene that **embeds another prefab as a
nested instance**, and how the three structures involved — `cc.PrefabInstance`,
`CCPropertyOverrideInfo`, and `cc.TargetOverrideInfo` — fit together. This is the
companion to [SERIALIZATION.md](SERIALIZATION.md) (the base format contract) and
explains the structures coir's editor deliberately **refuses to touch in place**
(see [EDITING.md](EDITING.md) §nested-instance guard).

All entry numbers below are array indices (`{__id__:N}` ⇔ `arr[N]`), as in the
base contract.

---

## 1. The core problem: `__id__` is local, `fileId` is durable

A prefab/scene is one flat array; every cross-reference inside it is a
`{__id__:N}` **array index**. That index is meaningful **only within this one
file**. When a nested prefab is *instantiated* (its nodes are cloned into the
outer object at load/build time), those clones get **fresh** ids — so an outer
`__id__` can never reach an object **inside** a nested instance, nor survive the
nested prefab being edited and re-instantiated.

Cocos therefore needs a second, **instantiation-stable** identity: the
**`fileId`** (a 22-char token on every node's `PrefabInfo` and every component's
`CompPrefabInfo`). Anything that has to address an object *across the nesting
boundary* does so by `fileId`, never by `__id__`. The structure that carries a
`fileId` path is `cc.TargetInfo`:

```jsonc
{ "__type__": "cc.TargetInfo", "localID": ["<fileId>", "<fileId>", …] }
```

`localID` is an **array** precisely so it can drill through **several** nesting
layers — one `fileId` per layer (§4).

---

## 2. The three structures (don't conflate them)

```
node._prefab ─► cc.PrefabInfo
                   ├─ instance ─► cc.PrefabInstance        (#1 — "this node IS an instance of prefab P")
                   │                └─ propertyOverrides ─► CCPropertyOverrideInfo[]   (#2 — override a VALUE)
                   └─ targetOverrides ────────────────────► cc.TargetOverrideInfo[]    (#3 — wire a REFERENCE)
```

| Structure | Lives in | Answers | Identity it uses |
|---|---|---|---|
| **`cc.PrefabInstance`** | `PrefabInfo.instance` of an instance-root node | "this node is an instance of prefab *P*" | — (the boundary marker) |
| **`CCPropertyOverrideInfo`** | `PrefabInstance.propertyOverrides` | "set property *X* of an object **inside** this instance to **value** *V*" | `fileId` (`targetInfo`) |
| **`cc.TargetOverrideInfo`** | `PrefabInfo.targetOverrides` (of the *outer* prefab root) | "wire reference property *X* to **point at** an object across the boundary" | `fileId` (`sourceInfo` / `targetInfo`) |

The split exists because the two override jobs need different data:

- A **value** override needs only `target + propertyPath + value` (a string,
  number, color, …).
- A **reference** override needs to resolve a **target object** that itself lives
  across a boundary, so it needs a descriptor for **both ends** — and either end
  may be deep inside nesting.

`cc.PrefabInfo` of the outer root also carries `nestedPrefabInstanceRoots` — the
list of nodes in this prefab that **are** nested-instance roots (the bookkeeping
that lets the engine know where the boundaries are).

---

## 3. `cc.PrefabInstance` — the boundary marker

```jsonc
// the PrefabInstance reached via  node._prefab.instance
{
  "__type__": "cc.PrefabInstance",
  "fileId": "11zt6/gn5K37OyT69J5M1u",   // this instance's own stable id
  "prefabRootNode": { "__id__": 1 },     // the outer root that owns the instance tree
  "mountedChildren": [],                  // nodes ADDED to the instance beyond the source prefab
  "mountedComponents": [],                // components ADDED likewise
  "propertyOverrides": [ {"__id__":5}, … ],  // see §4
  "removedComponents": []                 // components of the source prefab DELETED in this instance
}
```

The full chain from a node to its instance data is
`node._prefab → cc.PrefabInfo → .instance → cc.PrefabInstance`. A node whose
`PrefabInfo.instance` is **non-null** is a **nested-instance root**; a prefab's
own top root has `instance: null`.

---

## 4. `CCPropertyOverrideInfo` — overriding a VALUE

Each entry in `PrefabInstance.propertyOverrides` customizes one property of one
object inside the instance, relative to the source prefab's default:

```jsonc
{
  "__type__": "CCPropertyOverrideInfo",
  "targetInfo": { "__id__": 6 },   // → TargetInfo localID: ["c46/YsCPVOJYA4mWEpNYRx"]
  "propertyPath": ["_name"],        // which property (+ sub-path) on that object
  "value": "Node"                   // the overriding value
}
```

Read it as: *"inside this instance, the object whose fileId is
`c46/Ys…` has its `_name` set to `"Node"`."* This is how the editor records
"this instance's label text / position / enabled-flag differs from the prefab it
came from" without rewriting the source prefab.

> Two instances of the **same** source prefab share the internal `fileId`s (e.g.
> both instance roots resolve `c46/Ys…`). They're told apart by **which
> `PrefabInstance` owns the override**, not by the fileId.

### Every instance implicitly overrides its root's transform + name

Dropping a prefab in writes **four `propertyOverrides` immediately**, before you
change anything — `_name`, `_lpos`, `_lrot`, `_euler` on the **instance root**.
These are placement/identity data that belong to *this* instance, not the source
prefab (where the instance sits, what it's called), so they are **always pinned**
as overrides — even when their values still equal the source's defaults.
Consequence: editing the **source** prefab's root transform or name never moves or
renames an already-placed instance. (No other property is auto-overridden.)

**Example** — a prefab dropped in with **zero** manual edits already serializes:

```
PrefabInstance.propertyOverrides (4) — all on the instance root (fileId c46/Ys…):
    _name  = "Node"
    _lpos  = (0, 0, 0)        ← still the default value, yet pinned
    _lrot  = identity
    _euler = (0, 0, 0)
```

---

## 5. `cc.TargetOverrideInfo` — wiring a cross-boundary REFERENCE

This is the structure that needs `fileId` on **both** ends. It lives in the outer
root's `PrefabInfo.targetOverrides`:

```jsonc
{
  "__type__": "cc.TargetOverrideInfo",
  "source":       { "__id__": 18 },    // the object holding the reference property
  "sourceInfo":   null,                 // fileId path to the source, IF it's inside a nested instance (else null)
  "propertyPath": ["refNode"],          // which property on the source to wire
  "target":       { "__id__": 10 },     // the nested-instance ROOT node containing the target
  "targetInfo":   { "__id__": 30 }      // → TargetInfo localID: ["e0QUTXHrdNFYfwkcx10hSN"]
}
```

Read it as: *"the `refNode` property of component #18 should point at the object
identified by fileId `e0QU…` inside the nested instance rooted at #10."*

- **Source side** — `source` is the local `{__id__}`; `sourceInfo` is non-null
  **only when the source itself lives inside a nested instance** (then a fileId
  path is needed to find it after instantiation). Here it's `null`: the source
  component sits on the outer prefab's own root.
- **Target side** — `target` is the **nested-instance root node**; `targetInfo`'s
  `localID` is the **fileId path** from there to the exact node/component.

### Why a baked `__id__` value coexists with the override

The source component usually *also* carries an inline value, e.g.
`"refNode": {"__id__": 20}`, where #20 is the **baked** copy of the target node
flattened into this array (for display / when the asset is loaded flat). The
`TargetOverrideInfo` is the **durable** description: if the nested prefab is later
changed and re-instantiated, the engine re-resolves `refNode` by `fileId`, not by
the stale baked index. The two are kept consistent by the editor:

```
TargetOverrideInfo.targetInfo.localID = "e0QUTXHrdNFYfwkcx10hSN"
      └─► matches the fileId of node #20's PrefabInfo
              └─► and node #18.refNode's inline value is {__id__: 20}   (the same node, baked)
```

### Wiring a cross-boundary reference materializes ("bakes") the target

Pointing a reference property (a script's `refNode`, a `cc.Sprite._spriteFrame`,
…) at a node **inside** a nested instance is **not** a one-line change. Because the
target has no concrete `__id__` in this file until the instance is built, the
editor **bakes the target node's whole branch into the array** — the target node,
the nodes on the path to it, and their components / `PrefabInfo` /
`CompPrefabInfo` — so the inline `refNode: {__id__:N}` resolves *now*, **and** adds
the `cc.TargetOverrideInfo` + `cc.TargetInfo` as the durable fileId wiring. A
single drag can therefore add ~10 entries; the cost is the **cross-boundary**
reference, not the property. (The baked nodes carry `_parent` pointing into the
instance, but the instance root's `_children` stays unmanaged — they exist solely
as the reference's materialized target.) A reference to a **non-nested** node in
the same prefab adds only the one `{__id__}` line — no baking, no override.

**Example** — one nested instance, then a script wired to a label inside it:

```
fresh drop (thin instance)                                    13 entries
  └ cc.Prefab · root cc.Node · instance cc.Node · PrefabInfo ·
    PrefabInstance · 4 propertyOverrides · UITransform · …

+ add a script component to the root                          +2  → 15
  └ the component  +  its cc.CompPrefabInfo

+ drag its refNode onto a "Label" node INSIDE the instance    +10 → 25
  ├ BAKED target branch:  Label node · the path node · UITransform ·
  │                       cc.Label · their PrefabInfo/CompPrefabInfo   (~8)
  └ WIRING:               cc.TargetOverrideInfo + cc.TargetInfo         (2)
```

The `refNode` drag alone is responsible for the +10 — the same drag onto a
non-nested node would have been +0 beyond the `{__id__}` it sets.

---

## 6. Multi-layer nesting

Two dimensions let the mechanism scale to any depth:

1. **`localID` is a path.** Depth-1 nesting → one fileId. A reference into "an
   instance inside an instance" → `localID: [fileId_layer1, fileId_layer2]`; the
   engine walks the fileIds layer by layer.
2. **Both ends can be deep.** Because `sourceInfo` and `targetInfo` are *both*
   `TargetInfo`s, a `TargetOverrideInfo` can express "a component **inside**
   instance A references a node **inside** instance B" — each end resolved by its
   own fileId path.

So the worked example in §5 (source on the outer root, target one layer in) is the
shallow case; the structure is identical for deeper graphs, just with longer
`localID` arrays and a non-null `sourceInfo`.

---

## 7. Worked example (the full entry layout)

A prefab `Parent` whose root has a script with a `refNode` reference pointing into
one of two nested instances:

```
#0  cc.Prefab                          (asset wrapper)
#1  cc.Node "Parent"                   (outer root)         _prefab → #28
#2  cc.Node                            (nested-instance root A)  _prefab → #3
#3  cc.PrefabInfo                        instance → #4, targetOverrides …
#4  cc.PrefabInstance                    propertyOverrides → #5,#7,#8,#9
#5  CCPropertyOverrideInfo                targetInfo #6, _name = "Node"
#6  cc.TargetInfo                         localID ["c46/Ys…"]
…
#10 cc.Node                            (nested-instance root B)  _prefab → #11
#11 cc.PrefabInfo                        instance → #12
#12 cc.PrefabInstance                    propertyOverrides → #13,…
#18 <compressed script type>           (the script on the outer root)  refNode → #20 (baked)
#20 cc.Node "Label"                    (baked copy of B's target node)  _prefab → #27
#27 cc.PrefabInfo                        fileId "e0QU…"
#28 cc.PrefabInfo                      (outer root's)
        targetOverrides            → [ #29 ]
        nestedPrefabInstanceRoots  → [ #10, #2 ]
#29 cc.TargetOverrideInfo               source #18, propertyPath ["refNode"], target #10, targetInfo #30
#30 cc.TargetInfo                       localID ["e0QU…"]     ← matches #27.fileId
```

The two `propertyOverrides` on instance A rename its root (`_name="Node"`); the
single `targetOverride` on the outer root wires the script's `refNode` to the
`Label` node living inside instance B, addressed by its fileId.

---

## 8. Sync semantics (what the overrides are for)

Nested instances **auto-sync from their source prefab** in 3.x — edit and save the
source, and every instance reflects the change. The override structures above are
exactly the **diff** that survives that sync:

- A property that **has** an override (a `CCPropertyOverrideInfo`, or the implicit
  root transform/name of §4) — the **override wins**; the source's value for that
  property does **not** propagate.
- A property with **no** override — it **syncs** from the source.
- Overrides are **not permanent** — reverting/removing the override in the editor
  makes the property track the source again.

So "the source's X stops taking effect" is true **only for the property you
overrode**, and it is by design: an override is a deliberate *"this instance
differs here."* Everything un-overridden still follows the source.

---

## 9. How coir handles all this

coir's **dependency topology is unaffected** by any of these structures — they
route through `__id__`/`fileId` internal references and produce **no asset
dependency edges** (the corollary in SERIALIZATION.md §2). They matter only to the
**editor**:

- **Edit refusal.** `nestedInstanceRoot()` walks up `_prefab.instance` and, if a
  selector resolves at/under a node whose `PrefabInfo.instance != null`, the edit
  engine **refuses** the operation — because mutating an instance's internals
  means going through `propertyOverrides`/`targetOverrides` + `fileId`, not the
  plain `__id__`-array surgery coir does. Edit the **source prefab** instead.
- **Add resets identity.** `addNode`/`addComponent` clone a same-file skeleton
  (template-by-example) and then null every identity/link field —
  `instance`, `targetOverrides`, `nestedPrefabInstanceRoots`, `_id`, fresh
  `fileId` — so a cloned `PrefabInfo` never drags in another node's nesting state.
- **What `verify` can and can't check.** Offline `verify` validates the
  `__id__`-typed ends (`TargetOverrideInfo.source`/`target`,
  `CCPropertyOverrideInfo.targetInfo`'s `__id__`) like any other reference, but it
  **does not** validate `localID` — a `fileId` only resolves when the nested
  prefab is actually instantiated, which is invisible offline. "Does this fileId
  still point at a live object inside the sub-prefab?" is exactly the
  engine-semantic question only **`native-verify`** (the live editor re-instantiates
  the file) can answer.
- **A `check` rule for the edit policy.** `no-deep-instance-override` (`coir check`)
  enforces "only an instance **root**'s own properties may be overridden" — it
  flags any `CCPropertyOverrideInfo` whose `localID` ≠ the host instance node's
  `PrefabInfo.fileId` (i.e. a value override on a node **inside** the instance),
  while leaving root placement overrides (§4) and references (`cc.TargetOverrideInfo`)
  alone. Aimed at PREFAB authoring: `files` defaults to `prefab` because scenes
  legitimately carry engine-baked deep overrides (lightmap / shadow), which
  `ignoreProps` also excludes by default. (`coir edit` already *can't* create these
  — its `nestedInstanceRoot` guard refuses editing at/under an instance — so this
  rule's job is catching edits made in the **Cocos editor** and committed.)
  Classifier: `findInstanceOverrides` in `editPrefab.js`.

### Inspecting a file

`scripts/prefab-anatomy.js` dumps the nesting structure of any prefab/scene with
every `fileId` / `__id__` resolved to a node/component (it scans the project to
turn a compressed script `__type__` into its class name):

```
$ node scripts/prefab-anatomy.js path/to/Foo.prefab

Foo.prefab — 25 entries
Nested instances (1):
  node #2  ◂ PrefabInstance #4  fileId 4eMid…
    propertyOverrides (4) — instance-local VALUE overrides:
        _name = "Node"   [fileId c46/Ys… → node #2 (shared by 2 instances)]
        _lpos = (0, 0, 0) …
Target overrides (1) — cross-boundary REFERENCE wiring:
  [from PrefabInfo #22]  comp #12 <NewComponent> . refNode
        → into node #2 , fileId e0QU… → node #14 "Label"
```

---

## 10. The editor preview Canvas (`should_hide_in_hierarchy`)

A related editor-runtime artifact worth knowing. When you open a prefab for
editing in isolation (prefab-edit mode), the editor's scene process injects a
**hidden Canvas + Camera** named exactly **`should_hide_in_hierarchy`** so it has
something to render the prefab into (a prefab alone has no scene / canvas /
camera). It is created by `createShouldHideInHierarchyCanvasNode` in
[cocos-cli](https://github.com/cocos/cocos-cli/blob/main/src/core/scene/scene-process/service/node/node-create.ts),
parented to a temporary scene, flagged `CCObject.Flags.LockedInEditor`, and
**filtered out of the hierarchy panel** (hence the name). So the **live** scene
tree in prefab-edit mode is:

```
Scene
 └ should_hide_in_hierarchy   ← the hidden preview Canvas+Camera (editor runtime only)
     └ <the prefab root you're editing>
```

It is **never serialized** — coir's file-based nodePaths never contain it (a grep
of a healthy project finds zero). Two consequences for coir:

- **Live-tree ↔ file path alignment.** Anything that reads the live tree
  (`query-node-tree`) — the `cocos-extension` **goto panel** — sees the prefab-edit
  wrapping and would build `Scene/[should_hide_in_hierarchy/]<node>`, which doesn't
  match coir's file path. The wrapping is a **temp `Scene`** (always) plus a
  `should_hide_in_hierarchy` preview **Canvas** (only for UI prefabs; a 3D prefab
  like a skeletal mesh has none). So `logicalRoot` in `panels/goto.js` **descends to
  the prefab root** on both directions — but ONLY in prefab-edit mode, since in
  normal scene editing the scene IS the root (coir's scene paths include the scene
  root name). It detects prefab-edit mode by the preview Canvas (UI prefabs) or by
  asking the asset-db what the open scene's asset is (3D prefabs). (Other community
  tools strip the `should_hide_in_hierarchy` segment similarly — e.g. oops-copilot.)
- **Leak detection.** The wrapper **can accidentally get saved** into a prefab (a
  known footgun — many public projects ship a `should_hide_in_hierarchy` node in
  committed prefabs). The **`no-editor-preview-leak`** check rule (`coir check`)
  flags any prefab/scene that contains such a node. Classifier:
  `findPreviewCanvasLeaks` in `editPrefab.js`.

---

## References

- [SERIALIZATION.md](SERIALIZATION.md) — the base scene/prefab format contract.
- [EDITING.md](EDITING.md) — coir's in-place editor, including the nested-instance
  guard and template-by-example adds.
- Cocos Creator engine: `cc.Prefab`, `cc.PrefabInfo`, `cc.PrefabInstance`,
  `cc.TargetInfo`, `cc.TargetOverrideInfo`, `CCPropertyOverrideInfo` (the
  `_utils/prefab-utils` / `instantiate` paths).
