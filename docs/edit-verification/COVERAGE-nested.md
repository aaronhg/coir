# coir `edit` — coverage audit (round 2: set-ref · P2/P3 · guards · --reimport)

An adversarial **multi-agent** audit (the `edit-native-verify-plan` workflow's two
auditor lenses — *coverage-gap* and *execution-correctness* — plus live re-grounding
during execution) cross-checked the machine-authored plan against the real source
(`src/edit/ops.js`, `src/edit/editPrefab.js`, `src/editCli.js`) and the running 3.8.6
editor. It found **plan bugs that would have produced false verdicts**, all corrected
before the run logged in [RESULTS-nested.md](RESULTS-nested.md). This is the honest record
of what the native layer can and cannot prove here.

## Verdict

Every new feature is exercised at the verb level with a native or deterministic-offline
check (38/38 PASS). The **load-bearing** evidence: P3b resolves a cross-boundary reference
from a `cc.TargetOverrideInfo` with an inline `null` and no baked branch (N3 — the engine
itself, not coir reading its own output); P2 overrides land as observable node values
(N4–N7); `--reimport` round-trips through the live editor (N8) and degrades gracefully (W10).

| Audit critique | Resolution |
|---|---|
| Plan keyed FG1–FG4 + the component-target case on `NewComponent.refNode2` — the inventory agent read the `.ts`, but the **serialized prefab has only `refNode`** | **Fixed** — live-grounded `get NewComponent` keys: `refNode2` is genuinely *absent*, so FG1–FG3 (missing-field refusal) are correct as written; the component-target case (W1) was re-pointed to the existing `refNode` |
| P2 native readback used coir's **file-side** selector `Parent/[0]`; the engine walks the **runtime** tree and `/fixture copy` renames the root to the fixture basename | **Fixed** — readbacks use the basename root + the runtime instance name (`__vP1/Node[0]`, `__vP1/COIR_RENAMED`); confirmed `Parent/[0]` reads `{missing:'node'}` live |
| set-ref native cases asserted only "resolves non-null" — vacuous, since `Parent.refNode` is already `{__id__:20}` and a resolved ref's runtime uuid is non-deterministic | **Upgraded** — set-ref correctness moved to the **offline** structure (inline `{__id__}`/override `localID` via `-o json`/`get`); native used for import-survival + the two genuine null→resolved transitions (N1, N3). Documented as **FINDING-A** in RESULTS |
| FG6 tested array-bounds via `Node:cc.Node._children.5` — but `cc.Node` is not a *component* selector, so it exits 2 on a resolution error, not the `setDeep` bounds check | **Dropped** — the array-bounds guard is already covered by `test/cli.test.js`; the proposed native case tested the wrong code path |
| P2-7 ("exactly one `_name` override after two renames") gated on `coir verify`, which only reports valid/errors, not the override count | **Dropped from native** — the no-duplicate-override property is asserted by `test/cli.test.js` (P2 in-place update) + the offline `--roundtrip` audit; `verify` can't observe it |
| The plan had **no fixture teardown** (~40 `__vfy_*` would leak into the real project) | **Fixed** — every case deletes its fixture; a pre-clean + a final sweep confirm zero leftovers and `metaErrors=0` |
| set-rot readback compared `euler.y === 90` (float) | Confirmed clean — 90° about Y round-trips exactly here; a tolerance is still the correct guard for non-axis angles |

## Remaining untested branches (lower value; honest backlog)

Not blocking — narrow branches, most with `test/cli.test.js` (196 cases) or `--roundtrip`
coverage:

- **P3a target-correctness natively.** N2 proves the `cc.TargetOverrideInfo` is import-accepted + the offline `localID` is right, but not *which* baked node the engine bound (FINDING-A: runtime uuids are unmappable). The deterministic offline `localID`/`fileId` is the correctness proof; a future endpoint that returns the referenced node's *path* (not its runtime uuid) would close this.
- **Cross-instance P3b3 readback.** W4 asserts the flag + offline structure (override on `[0]` via `--into`); its live resolution wasn't read back (N3 already proves the P3b resolution mechanism on `[1]`).
- **Multi-override accumulation on one instance root.** P2 in-place update + no-duplicate is unit-tested offline; not re-run natively here.
- **`--reimport` + `needsReimport` (force-created field) end-to-end.** W2/W3 prove the flag; whether the editor *keeps or drops* a force-created non-`@property` field on reimport is engine-defined and intentionally not asserted (the falsifiable claim is coir's flag, not engine retention).
- **FG6 array-bounds natively** — covered by unit tests; needs a component with a real array `@property` on the fixture to test in-engine.

## Findings

- **FINDING-A — native node-ref readback proves liveness, not target identity** (a property of the engine's runtime, not a coir defect). Mitigation in place: offline `{__id__}`/`localID` for correctness, native for import-survival; N1/N3 are the falsifiable null→resolved exceptions. See RESULTS-nested.md.
- **FINDING-B — CLI `-o json` omitted `reimportReason`** (the text output + MCP `commitResult` carry it). **FIXED** — `editCli.js applyResult` now includes `reimportReason` in the JSON when `needsReimport` is set, reaching parity with text mode + MCP; locked by `test/cli.test.js` (the `--force` field-create case asserts `d.reimportReason`). Low severity.

Native evidence: [RESULTS-nested.md](RESULTS-nested.md) Phase N. Offline/unit complement: `test/cli.test.js` (196 PASS, incl. set-ref P1/P3a/P3b, the field/value guards, `--reimport` graceful) + `coir verify --all --roundtrip`.
