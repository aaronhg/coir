# coir `edit` — native verification RESULTS (round 3: edit/verify refactor regression)

Date **2026-06-22**. A **focused regression** run after this session's changes to the edit/verify
layer — NOT a full matrix walk (the edit OPS themselves were unchanged; see [RESULTS.md](RESULTS.md)
/ [RESULTS-nested.md](RESULTS-nested.md) for the comprehensive rounds). What changed this session:

- `probeInvertible` now runs an **op-matrix suite** (add/remove node · add/remove component ·
  setParent there-and-back) — offline, covered by `coir verify --all --roundtrip` = **11/11 ok**
  on `NewProject_386` (and a new `test/roundtrip-probe.test.js`).
- the **native-verify client was refactored**: the helpers now take the `conn` object (carrying a
  per-session `X-Coir-Token`), and `cmdNativeVerify` + the new MCP `native_verify` tool both drive
  one shared core, `src/verify/nativeVerify.js` `nativeVerifyData`.

This round re-confirms, against the live Cocos **3.8.6** editor (`NewProject_386`, coir's own
`cocos-extension/` endpoint on `:3789`), that (a) the refactored native-verify tool still works
end-to-end and (b) the engine still accepts what coir writes for the core ops — read back through
the refactored `/read` path. `PASS = observed == expected`; `exit` = coir's process exit code;
`bytes` = SHA-stable (a refusal must not modify the target). Fixtures are `__vy_*` copies of
`Node.prefab` (root renamed to the basename, gotcha G1), deleted after the run; the project
re-scans clean (`assets=34`, `metaErrors=0`).

> **Endpoint note:** the running editor served the **pre-token** extension (`/ready` had no
> `token`), so the new `X-Coir-Token` path was NOT exercised live — the refactored client/harness
> correctly ran token-less and the endpoint accepted it (proving graceful back-compat). See FINDING-C.

## Verify levels (honest labelling)

- **native-readback** — the engine reports the exact value coir wrote (S1/S2 scalars, S3 name,
  S4 active, S5 add presence, S6 absence). The strongest.
- **native-survival** — the engine reimports + instantiates with no error (R0).
- **cli-exit** — exit code + file bytes unchanged (G1). No editor.

---

## Phase R — sanity: the refactored native-verify tool

| id | op | engine / offline observation | level | result |
|----|----|------------------------------|-------|--------|
| R0 | `native-verify Node-002.prefab` | `connect(:3789)` via the new conn-signature → reimport + read → "✓ engine matches coir's read", exit 0 (1 node, 1 component) | native-survival | **PASS** |

## Phase S — the engine accepts coir's writes (edit → reimport → readback) · `Node.prefab` copies

| id | op | engine readback | level | result |
|----|----|-----------------|-------|--------|
| S1 | `set …/Label:cc.Label._string --str VY_HELLO` | `value:"VY_HELLO"` | native-readback | **PASS** |
| S2 | `set …/Label:cc.Label._fontSize --int 33` | `value:33` | native-readback | **PASS** |
| S3 | `rename …/Label RenamedLbl` | node `RenamedLbl` → `name:"RenamedLbl"` | native-readback | **PASS** |
| S4 | `set-active …/Label --bool false` | `active:false` | native-readback | **PASS** |
| S5 | `add-node <root> VYAdded` (PrefabInfo cloned → no `needsReimport`) | node `VYAdded` present, `name:"VYAdded"` | native-readback | **PASS** |
| S6 | `rm-node …/Label` (real-delete + `__id__` compaction) | `{missing:"node"}` — gone | native-readback | **PASS** |

## Phase G — guards (no editor)

| id | op | exit | bytes | result |
|----|----|------|-------|--------|
| G1 | `set …/Label:cc.Label._nope --str x` (field does not exist) | 2 | unchanged | **PASS** |

**Phase R: 1/1 · Phase S: 6/6 · Phase G: 1/1.**

## Summary

**Total: 8 PASS · 0 fail · 1 finding.**

The refactored native-verify path (conn-signature + shared `nativeVerifyData`) is intact, and the
engine correctly loads what coir writes for set (string + int), rename, set-active, add-node and
rm-node; the field-existence guard refuses cleanly. Cleanup: all `__vy_*` fixtures deleted via the
endpoint; project re-scans `metaErrors=0`.

> **⚠ FINDING-C — the `X-Coir-Token` path is unverified live (severity: low).** The endpoint
> change (every route but `/ready` now requires a per-session `X-Coir-Token`, a CSRF guard on the
> destructive `/fixture`) ships in `cocos-extension/main.js`, but the running editor still had the
> **pre-token** extension installed, so `/ready` returned no token and the client/harness ran
> token-less. That proves back-compat with an old extension, not the new enforcement. **To verify
> it:** re-install the extension (`cocos-extension/install.sh <proj>`), restart Cocos, restart the
> endpoint, re-run — `/ready` should then carry a `token`, the harness/CLI should pick it up, and a
> token-less POST to `/fixture` should be rejected `401`.

> **Note (not a finding) — EXIT-trap cleanup is async.** The editor processes `/fixture delete`
> asynchronously, so an immediate `find` right after the trap fired briefly saw the `__vy_*`
> fixtures before the editor finished deleting them; they cleared within seconds and a re-run of
> `vy_cleanup` is idempotent (gotcha G7). No leak persisted.
