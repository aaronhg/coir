# Array-property structural edits — design + pre-flight experiments

Date **2026-06-22**. Design record + the live pre-flight experiments that settled the
behavior of `add-array-item` / `rm-array-item` / `reorder-array` (the contract is in
[../EDITING.md §11b](../EDITING.md)). The experiments below were run by **manually
producing the byte-change coir *would* make** (a JSON splice) on an isolated fixture,
then `reimport` + readback through the live Cocos 3.8.6 endpoint (`NewProject_386`,
`:3789`) — to learn what the engine accepts *before* writing the engine code. The
post-implementation pass (coir's real ops) goes in `RESULTS-array.md`.

## Element kinds

An array element is one of: **(V)** a value — scalar / inline `{__type__:cc.*}` /
`{__uuid__}` asset ref; **(R-ext)** a `{__id__}` to an existing node/component (also
referenced elsewhere); **(R-own)** a `{__id__}` to an **owned** sub-object the array
exclusively holds (a separate entry — `cc.ClickEvent`, a `NewConfig` data object).

## Pre-flight experiments (manual byte-change → reimport → readback)

**`_materials` (V, `{__uuid__}`) on a SkinnedMeshRenderer** — add `null` (1→2), swap,
remove idx0 (2→1):

| op | reimport | readback |
|---|---|---|
| add `null` | `ok` | `[{uuid:b698…}, null]` |
| reorder (swap) | `ok` | `[null, {uuid:b698…}]` |
| remove idx0 | `ok` | `[{uuid:b698…}]` |

→ The editor accepts **arbitrary array length/order** on reimport; a VALUE array is a
pure splice/permute. `null` elements survive.

**`NewComponent` arrays on `Node.prefab`** — `refNodes:[null]` (V/node-ref),
`newComponents:[{__id__:11}]` (R-ext component ref), `configs:[{__id__:16}]` (R-own
`NewConfig`):

| op | reimport | readback / verify |
|---|---|---|
| `configs` clone-add (R-own, 1→2) | `ok` | `[{<type>:NewConfig}, {<type>:NewConfig}]` |
| `configs` reorder | `ok` | 2 × NewConfig |
| `configs` remove idx0 (pure splice → orphan) | `ok` (editor tolerates) | **coir `verify` ⚠ `orphan-entry #N (NewConfig) referenced by no __id__`** |
| `newComponents` remove (R-ext) | `ok` | `[]` — the component entry survives (also in `_components`) |

→ Clone-add of an owned **data** object works (no `fileId` → offline-complete).
→ **Pure-splice remove leaves an orphan the editor tolerates but coir's own `verify`
flags** → so `rm-array-item` GC's a now-orphaned owned sub-object (reusing
`ownedClosure`+`removeEntries`); a still-referenced node/component is never touched.

**Empty `configs` — the "nothing to reference" case:**

| add to empty | reimport | readback | conclusion |
|---|---|---|---|
| bare `{__type__:"NewConfig"}` (no fields) | `ok` | `{<type>:NewConfig}` | engine fills the class's `@property` defaults → a minimal `--type` stub works |
| full `{__type__:"NewConfig",vec3,bool}` | `ok` | `{<type>:NewConfig}` | the `--json` full-object path works |
| bare `{__type__:"NopeConfigXYZ"}` (unknown) | `ok` (no error!) | `{uuid:"c3C1…"}` | unknown type **silently degraded** to a missing-class placeholder — not coir-detectable offline (no class registry); `native-verify` catches it via the readback's resolved `<type>` |

→ Two no-template paths: **`--json`** (full, deterministic, offline-complete) and
**`--type <Class>`** (minimal `{__type__}` stub — the **plain class name**, not a
compressed token; `needsReimport`). A typo'd type carries the same hazard as
`add-component`'s `cc.Nope`.

> **Note** — the same fixtures surfaced a **pre-existing** project issue (not an array
> bug): `native-verify` reports `comp-missing NewComponen2` on a *pristine* `Node.prefab`
> copy — the script's filename (`NewComponen2.ts`) vs class (`NewComponent2`) mismatch
> makes the engine drop it. A nice demonstration that native-verify catches broken scripts.

## Verification matrix to walk with coir's REAL ops (→ RESULTS-array.md)

Run each through `coir edit … add-array-item/rm-array-item/reorder-array` (not a manual
splice), reimport, read back:

1. `reorder-array _materials 1,0` → readback order swapped (native-readback).
2. `add-array-item _materials --uuid <mat>` → length+1 (native-readback).
3. `rm-array-item _materials 0` → length−1.
4. `add-array-item configs --clone` (R-own data) → 2 × NewConfig, offline-complete.
5. `add-array-item configs --json '{…NewConfig…}'` on empty → present.
6. `add-array-item configs --type NewConfig` on empty → present, `needsReimport`.
7. `rm-array-item configs 0` (orphans the owned entry) → GC'd; offline `verify` clean (no orphan-entry).
8. `rm-array-item newComponents 0` (R-ext) → ref dropped, component entry survives.
9. guards: non-array prop refused; `_children`/`_components` refused→routed; `--at` out of range refused; nested-instance refused.
