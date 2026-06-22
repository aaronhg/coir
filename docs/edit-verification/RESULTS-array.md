# Array-property structural edits — native verification RESULTS

Date **2026-06-22**. The post-implementation native pass: each op run through coir's
**real** ops (`coir edit … add-array-item / rm-array-item / reorder-array`, NOT a manual
JSON splice) against the live Cocos **3.8.6** editor (`NewProject_386`, `:3789`), then
`reimport` + readback. Design + the pre-flight (manual) experiments are in
[PLAN-array.md](PLAN-array.md); the contract is in [../EDITING.md §11b](../EDITING.md).

Fixture: a copy of `Node.prefab` (`__vy_arr`), whose root `NewComponent` has
`configs: [{__id__}]` — an **owned `NewConfig` data sub-object** (the hard case; the
value-array path `_materials` was already covered in the pre-flight). Selector
`__vy_arr:NewComponent.configs`.

## Phase A — array-item ops via coir's real engine (reimport → readback)

| id | op (coir CLI) | coir result | reimport | readback | level | result |
|----|----|----|----|----|----|----|
| A1 | `add-array-item …configs --clone` | `needsReimport:false` (NewConfig has no fileId → offline-complete) | `ok` | `[NewConfig, NewConfig]` | native-readback | **PASS** |
| A2 | `reorder-array …configs 1,0` | ok | `ok` | 2 × NewConfig | native-survival | **PASS** |
| A3 | `rm-array-item …configs 0` | `gc:1` (the now-orphaned NewConfig real-deleted + compacted) | `ok` | `[NewConfig]` | native-readback | **PASS** |
| A3v | (after A3) `coir verify` | — | — | **`✓ structurally valid`** — no `orphan-entry` | offline-verify | **PASS** |
| A4 | `add-array-item …configs --class NewConfig` (on the now-empty array) | `needsReimport:true` (minimal `{__type__}` stub) | `ok` | `[NewConfig]` — engine filled the class `@property` defaults | native-readback | **PASS** |

**Phase A: 5/5.**

## Offline coverage (no editor)

- `test/cli.test.js` — `edit array-item: reorder / rm (value + owned-GC) / add (value·clone·class) + guards`: reorder permutation, value remove, value add-at, **clone offline-complete**, **rm GC's the orphan → `verify` clean**, empty-array `--class` stub (`needsReimport`), `--clone`-on-empty refused, and guards (structural `_children`/`_components` routed away, non-array refused, bad permutation refused).
- `test/mcp.test.js` — `edit_reorder_array`/`edit_add_array_item`/`edit_rm_array_item` through the MCP server (same seam) + registration in `tools/list`.

## Phase B — edge cases (offline, locked in `test/cli.test.js`)

Explored with rich fixtures (shared refs, duplicate refs, an owned object that itself
owns a nested entry, nested-array paths):

| edge case | behavior | result |
|---|---|---|
| rm a **shared** node-ref (node also in `_children`) | ref dropped, node NOT deleted (`gc:0`) | ✅ |
| rm a **duplicate** ref (`{__id__:7}` twice) | one ref dropped, target still referenced → `gc:0` | ✅ |
| rm an owned object that **owns a nested entry** (`#6 → #8`) | whole owned closure GC'd (`gc:2`), `verify` clean | ✅ |
| reorder / rm / add on a **nested array path** (`Comp.nested.inner`) | works | ✅ |
| `add --ref Root/A` (intra-file) / `--ref #2` | appends `{__id__:2}` | ✅ |
| `add --clone` of an element WITH a `fileId` | `needsReimport:true`, clone gets a **fresh** fileId (≠ template) | ✅ |
| `add --clone` on a **value** array (no `{__id__}` sibling) | refused → "supply --json/--class" | ✅ |
| `add --json '{full object}'` / a typed `cc.*` object | inserted verbatim | ✅ |
| **kind mismatch** (scalar into a `{__id__}` array) | applied + non-blocking **`warning`** (no hard refuse — no schema to validate) | ✅ |
| multiple sources (`--clone --int`) | deterministic priority (clone > class > ref > asset > value) | ✅ |
| `--dry-run` / `--diff` | no write | ✅ |
| `batch` (reorder + add atomic; a bad op → nothing written) | all-or-nothing | ✅ |
| guards: structural `_children`/`_components` · non-array prop · bad permutation · `--at` out of range | refused (exit 2) | ✅ |

## Summary

**Total: 5 native PASS · 0 fail · 0 findings** (Phase A) + the Phase-B edge cases + the
offline CLI/MCP suites green. Added in response to edge-case probing: a **non-blocking
kind warning** on `add-array-item` (a kind-mismatched element is applied but flagged).

coir's real array-item ops are engine-valid: the editor reimports add/reorder/remove
cleanly, a cloned owned data object needs no reimport, a `--class` stub is filled with
class defaults on reimport, and the GC-on-remove keeps both the engine *and* coir's own
`verify` clean.

> **Note (not a finding):** the fixture's whole-file native-verify also reports the
> **pre-existing** `comp-missing NewComponen2` — the project's `NewComponen2.ts`
> filename-vs-`NewComponent2`-class mismatch makes the engine drop it. Unrelated to the
> array ops (a pristine `Node.prefab` copy shows it too); a demonstration that
> native-verify catches broken project scripts.
