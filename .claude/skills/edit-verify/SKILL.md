---
name: edit-verify
description: >
  Natively verify coir's prefab/scene EDIT engine against a LIVE Cocos Creator editor
  (the cocos-extension native-verify endpoint): edit isolated fixture copies → reimport →
  read the engine-built result → assert it matches what coir intended, leaving a dated
  PLAN/RESULTS/COVERAGE record under docs/edit-verification/. Use after changing
  src/edit/** (editPrefab.js / ops.js) or before trusting a new/changed edit op or guard.
  Covers the full op × value-flag × guard × nested-instance matrix with edge cases.
---

# coir `edit` — native verification

`coir edit` is a DOM-free byte-level prefab/scene editor. Proving it works means proving
the **Cocos engine accepts and correctly loads what it writes** — not coir reading back its
own output (self-consistent ≠ ground truth). This skill runs that proof against a live
editor and records it reproducibly. Background + prior records: [docs/edit-verification/](../../../docs/edit-verification/).

## When to use

- After touching `src/edit/editPrefab.js` or `src/edit/ops.js` (the write engine/seam).
- Before trusting a new or changed edit op, value-flag, guard, or nested-instance behavior.
- As the live complement to the offline gates (`coir verify --all --roundtrip`, `npm test`).

## Prerequisites

1. The target project open in **Cocos Creator 3.8.x** (3.5.x also works — the endpoint
   covers both) with the **coir cocos-extension installed** (`cocos-extension/install.sh <proj>`).
2. The native-verify endpoint **started**: editor menu **Coir ▸ native-verify: start** (binds
   `:3789`, or the next free port up to `:3809`). Confirm: `coir native-verify <anyfile> -C <proj>`.
3. Tools: `node`, `curl`, `jq`, `shasum`.

## Procedure

1. **Source the harness + connect.** From the coir repo root:
   ```bash
   source .claude/skills/edit-verify/harness.sh
   vy_init ../NewProject_386          # finds the endpoint whose OPEN project matches
   ```
   `vy_init` fails loudly if no endpoint matches (several editors can be open — it matches by
   project realpath, like `coir native-verify`). It registers an EXIT trap that deletes fixtures.

2. **Walk [CHECKLIST.md](CHECKLIST.md)** — the complete op × value-flag × guard × edge matrix.
   For each op pick the **verify level** honestly:
   - **native-readback** — the engine reports the exact value (rename/active/pos/euler, a set
     scalar, add/rm presence). The strongest; prefer it.
   - **native-survival** — the engine `reimport`s with no error (a malformed structure is
     rejected). Use for things whose *value* the readback can't distinguish (see gotcha G3),
     paired with the deterministic **offline** structure (`coir … -o json` / `get`).
   - **cli-exit** — exit code + bytes unchanged (refusals / dry-run). No editor.
   - **cli-reread** — coir's own `-o json` / `get` shape (offline structural assertion).

3. **Run each case** with the harness primitives/runners (examples below). Ground every
   selector and field on the **actual fixture** first (`vy_co edit <f>.prefab tree --values`,
   `… get <sel> -o json`) — never assume from a `.ts` (gotcha G4).

4. **Record** into a new dated file `docs/edit-verification/RESULTS-<topic>.md` in the house
   format (see the existing `RESULTS.md` / `RESULTS-nested.md`): per-phase tables, a bold
   tally per phase, a `## Summary` with `**Total: N PASS · 0 fail · M findings.**`, and a
   blockquote per `⚠ FINDING-N` (what/why/severity). Author the matrix you walked as
   `PLAN-<topic>.md` and an adversarial gap audit as `COVERAGE-<topic>.md`. Link them from
   `docs/edit-verification/README.md`.

5. **Clean up + re-scan.** `vy_cleanup` (auto on EXIT) deletes every `__vy_*` fixture; then
   confirm `node test/node-run.js <proj> | grep metaErrors` is `0` — a leaked fixture or a
   corrupted import would show here.

## Harness cheat-sheet

```bash
vy_co edit <f>.prefab tree --values          # ground structure/fields (read-only, real file ok)
U=$(vy_copy <SrcRel> __vy_x)                  # copy db://assets/<SrcRel> -> __vy_x.prefab, echo uuid
                                              # ⚠ the copy renames the ROOT node to "__vy_x" (gotcha G1)
vy_co edit __vy_x.prefab set '__vy_x:cc.Label._string' --str HI -o json   # edit (root = basename!)
vy_reimp __vy_x                               # reimport BEFORE read (gotcha G5)
vy_read "$U" '["__vy_x:cc.Label._string"]'    # read engine value -> {ok,values:{...}}
vy_assert ID "$U" '["__vy_x/Node:cc.X.p"]' '.values["__vy_x/Node:cc.X.p"].value=="HI"'
vy_refuse ID 2 __vy_x -- set '__vy_x:cc.X.nope' --str y   # guard: exit==2 AND bytes unchanged
vy_del __vy_x                                 # or rely on vy_cleanup (EXIT trap)
```

A resolved reference reads back as `{value:{uuid:…}}` (non-null) or `null`; a node selector
reads `{name,active,pos,euler,scale}`; a property reads `{value:…}`; missing → `{missing:…}`.

## Gotchas (each one cost a debugging cycle — honor them)

- **G1 — `/fixture copy` renames the prefab ROOT to the new asset's basename.** A copy of
  `Node.prefab` → `__vy_x.prefab` has its root node renamed `Node`→`__vy_x`. **All selectors
  (edit AND read) use the fixture basename as the root.**
- **G2 — file-side vs runtime selectors differ for instances.** coir's file selector for a
  nested-instance root is `<root>/[i]` (positional). The engine's runtime tree names that node
  by the *source prefab's* root name (e.g. `Node`), so the readback selector is `<root>/Node[i]`
  — and after a rename, `<root>/<NewName>`. `<root>/[i]` reads `{missing:node}` live.
- **G3 — a resolved node-ref's runtime uuid is non-deterministic** (regenerated per
  `cc.instantiate`). So a `set-ref` readback proves **resolved-vs-null (liveness)**, never
  *which* node. Prove target-correctness from the **offline** `{__id__:N}` / override `localID`;
  use native for import-survival + genuine **null→resolved** transitions (point a field that
  starts `null`, or a P3b inline-`null`, and assert the read becomes non-null).
- **G4 — ground field existence on the PREFAB, not the `.ts`.** A `@property` declared in
  source may not be serialized in a given prefab. `vy_co edit <f> get <sel:Comp> -o json` lists
  the real keys; pick a genuinely-missing name for missing-field guards and an existing one for
  happy paths.
- **G5 — reimport BEFORE read.** The asset-db caches the imported version; `vy_read` an edited
  fixture without `vy_reimp` first returns the stale value.
- **G6 — mtime write-guard.** coir refuses to write if the file changed on disk since it read
  it. On a fresh copy this is usually fine; if a benign conflict appears on a *write* case, add
  `--force` (NEVER on a guard/refusal case — that would mask the very thing under test).
- **G7 — always delete fixtures.** ~one per case; the EXIT trap + `vy_cleanup` sweep them, but
  a guard case that aborts the script early can leak — re-run `vy_cleanup` and check
  `metaErrors=0`.

## Optional: scale it with a workflow (ultracode)

Authoring the matrix can be fanned out (per-op designers + adversarial coverage/execution
auditors) before a serial live run — that is how `PLAN-nested.md` was produced. The two
auditor lenses (coverage-gap, execution-correctness) reliably catch mis-grounded selectors and
vacuous assertions; keep the **live execution serial and supervised** (one shared editor).
