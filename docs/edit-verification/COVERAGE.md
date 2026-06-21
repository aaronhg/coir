# coir `edit` — coverage audit

An adversarial 3-agent audit (source-coverage, native-rigor, candidate-mining lenses)
cross-checked `PLAN.md` + `RESULTS.md` + the 224-candidate `_design_raw.json` against the
real source (`src/editCli.js`, `src/edit/ops.js`, `src/edit/editPrefab.js`). Its findings
drove **Round 2** in `RESULTS.md`. This file records the audit verdict, what was filled,
and what remains.

## Verdict

Execution covers **every op at the verb level** and is honest about verification *levels*
and the two findings. The audit's main critiques were branch-shallowness and one artifact
flaw — all **addressed**:

| Audit critique | Resolution |
|---|---|
| Phase R command column truncated → rows indistinguishable | **Fixed** — table rewritten with full distinguishing commands |
| Summary overclaimed "every value flag confirmed through engine" | **Fixed** — summary now splits native-readback (16) vs native-load (~12) explicitly |
| `set ... --uuid` value-flag (≠ set-uuid op) untested | **Filled** — G5 (native-readback: sharedMaterials[0]==tree.mtl) |
| set-parent guards: only descendant-cycle tested | **Filled** — G6 self-move, G7 root-move (both exit 2) |
| add-node/set-parent `--index` splice untested (append only) | **Filled** — G1, G2 (native-readback child[0] ordering) |
| Multi-axis set-rot euler→quat never read back natively | **Filled** — G3 (rotation read back exactly {30,60,90}) |
| Component-scalar sets were native-load, not readback | **Upgraded** — G4 reads `_shadowCastingMode==2` engine-side |
| Empty-string rename vs add-node empty-name asymmetry untested | **Filled** — G8 (rename ''=legal), G9 (add-node ''=exit 1) |
| `getDeep`/`setDeep` descend-into-scalar error untested | **Filled** — G10, G11 (exit 2 "stops") |
| `--depth 0` coercion quirk undocumented | **Filled** — G13 (coerces to 1) |
| OOB-array set "no bounds check" GIGO undocumented | **Filled** — G12 → **FINDING-2** |
| FINDING-1 root cause (addComponent zero validation) | Confirmed in code by the audit (`editPrefab.js` addComponent; `selector.js` typeToken passes any dotted name) |

The audit also **independently verified the set-rot math**: coir's euler→quat is byte-identical
to Cocos 3.8.6 *and* 3.5.2 `Quat.fromEuler` (y uses +, w uses −, halfToRad=0.5·π/180).

## Remaining untested branches (lower value; honest backlog)

Not blocking — these are narrow branches; most have indirect coverage or unit-test coverage.

- **swap-uuid `<uuid>@subId`** sub-asset reference replacement (only whole-asset uuids swapped).
- **add-node / add-component on a SCENE** node (no PrefabInfo branch; scene only got rename via S01).
- **rm-component ownedClosure** (cc.Button + cc.ClickEvent owned-entry removal) — *un-runnable on
  current fixtures (no Button)*; already covered by `test/cli.test.js` fix#12.
- **Selector resolution edges**: sibling `[i]` / component `[i]` out-of-range; bad `#index` (`#abc`);
  `#N` out of array range; `[i]`≡`.i` equivalence; namespaced-type longest-match (`cc.X._prop`).
- **get** out-of-range array index → undefined.
- **set-parent onto / of a nested-instance** node (both guard directions).
- **non-numeric `--index`** (`--index abc`) → coerced to null → append (not rejected).
- **`--dry-run` + `--backup`** combined precedence; `--backup` overwriting a stale pre-existing `.bak`.
- **set-layer** `--num` / `--enum` acceptance branches (only `--int` exercised).

## Findings (see RESULTS.md for native evidence) — both FIXED

- **FINDING-1** — `add-component` did not validate the component type. **FIXED** (Round 3):
  `ops.js` now resolves the type via `typeToken` → rejects unknown non-cc names (exit 1) and
  writes the resolved token. This also fixed a real bug — a project-script class name was
  written as the bare name (engine → MissingScript); it now writes the compressed uuid token,
  natively confirmed (`add-component … MyCoirComp` → engine builds a real `MyCoirComp`). The
  only remaining unguarded case is a typo'd **`cc.*` builtin** (e.g. `cc.Nope`), unknowable
  offline without a bundled cc registry — consistent with `set --json`.
- **FINDING-2** — array `set`/`set-uuid` had no bounds check. **FIXED** (Round 3): `setDeep`
  rejects an out-of-range array index (exit 2); replace/append still allowed.

Both fixes are in the pure seam (CLI + MCP inherit them), covered by new unit tests
(`npm test` 158/158) and natively regression-verified (RESULTS.md Round 3).
