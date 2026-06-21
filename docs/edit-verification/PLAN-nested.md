# coir `edit` — native verification PLAN (round 2: set-ref · P2/P3 · guards · --reimport)

The test matrix for this session's new `edit` features, executed in
[RESULTS-nested.md](RESULTS-nested.md). Authored by a **multi-agent workflow**
(`edit-native-verify-plan`): an inventory pass enumerated the falsifiable claims
from `src/edit/ops.js`/`editPrefab.js`/`editCli.js`/`mcp/tools.js`; seven per-feature
designers grounded selectors against the real fixtures via read-only coir; two
adversarial auditors (coverage + execution-correctness) cross-checked the cases.
**The auditors' corrections are folded in below** — see COVERAGE-nested.md.

Conventions: `coir … = node <repo>/src/cli.js -C <NewProject_386> …`. Selectors in coir
grammar (`nodePath:cc.Type.prop`, `[i]`, `#N`). **A copied fixture's ROOT node is renamed
to the fixture basename** (the editor does this on `/fixture copy`), so every selector uses
the basename as the root (`__vN1/Node`, not `Node/Node`); the runtime instance-root name is
the *source* root's name (`Node`), so native readbacks use `__vP1/Node[0]` / `__vP1/COIR_RENAMED`.

Grounded facts (live, on the real fixtures): `Node.prefab` root has `NewComponent` with **one**
ref field `refNode:null` (`refNode2` does **not** exist — a genuinely-missing field); its
tree is root→`Node`(#2)→`Label`(#3, `cc.Label` with `_string`/`_color`/`_fontSize`).
`Parent.prefab` root `refNode` is **already** `{__id__:20}` (so a P3a "non-null" readback is
vacuous → P3a correctness is offline); its two children `[0]`#2/`[1]`#10 are nested-instance
ROOTS (runtime name `Node`); `Parent//Node`(#21) is a baked node inside instance `[1]`.
`Node-001.prefab` has one instance root `[0]`#2 with deeper baked nodes (deep-override refusals).

Verify levels: **native-readback** > **native-survival** > **cli-exit** > **cli-reread** (see RESULTS-nested.md).

---

## Phase N — Native success (instantiate → readback)

| id | op | command core (args after `-C`) | readback / assert |
|----|----|--------------------------------|-------------------|
| N1 | set-ref P1 (null→resolved) | `edit <Node> set-ref '<r>:NewComponent.refNode' '<r>/Node'` | file `{__id__:2}`; read `refNode` ≠ null (native-readback) |
| N2 | set-ref P3a (baked, in instance) | `set-ref '<r>:NewComponent.refNode' '<r>//Node'` | `mode:P3a`; reimport ok (TargetOverrideInfo accepted) |
| N3 | set-ref P3b (override-only) | `set-ref '<r>:NewComponent.refNode' '<r>/[1]' --into 'Node/Node'` | inline `null`, `needsReimport`; read ≠ null ⇒ override resolves with no baked branch |
| N4 | P2 rename instance root | `rename '<r>/[0]' COIR_RENAMED` | read `<r>/COIR_RENAMED` name == `COIR_RENAMED` |
| N5 | P2 set-active root | `set-active '<r>/[0]' --bool false` | read `<r>/Node[0]` active == false |
| N6 | P2 set-pos root | `set-pos '<r>/[0]' --vec3 12 34 56` | read pos == {12,34,56} |
| N7 | P2 set-rot root | `set-rot '<r>/[0]' --vec3 0 90 0` | read euler ≈ {0,90,0} (tol 1e-3) |
| N8 | --reimport | `set '<r>/Node/Label:cc.Label._string' --str REIMPORTED_OK --reimport` | stderr `↻ reimported`; read == `REIMPORTED_OK` |

## Phase G — Refusals & dry-run (cli-exit; exit 2 + bytes unchanged, unless noted)

| id | case | expect |
|----|------|--------|
| G1 | set-ref source = a component (not a property) | exit 2 |
| G2 | set-ref target = a property | exit 2 |
| G3 | set-ref source field missing (`refNodeXYZ`) | exit 2 |
| G4 | set-ref source field is a string | exit 2 |
| G5 | set-ref target = a property inside an instance | exit 2 |
| G6 | set-ref source = a node | exit 2 |
| G7 | set-ref (P3a) source field missing | exit 2 |
| G8 | set-ref source inside instance + non-ref | exit 2 |
| G9 | `--into` target not an instance root | exit 2 |
| G10 | `--into` sub-path absent in source prefab | exit 2 |
| G11 | `--into` source field is boolean | exit 2 |
| G12 | node-prop op DEEPER than instance root (`Node-001//Node`) | exit 2 |
| G13 | set-ref onto `_string` | exit 2 |
| G14 | set-ref onto `cc.Color` | exit 2 |
| G15–G17 | set / set-uuid / set-ref into a missing field | exit 2 |
| G18–G20 | set-ref / set-active / set --reimport, all `--dry-run` | exit 0, unchanged |

## Phase W — Writes & warnings (cli-reread)

| id | case | expect |
|----|------|--------|
| W1 | set-ref to a COMPONENT target | `mode:P1`, `targetKind:component` |
| W2 | set-ref missing field `--force` | exit 0, `needsReimport:true` |
| W3 | set missing field `--force` | exit 0, `needsReimport:true`, no warning |
| W4 | set-ref `--into` flag | `mode:P3b`, `needsReimport`, reason mentions cross-boundary |
| W5–W7 | set int→string / str→number / set-uuid asset→cc.Color | a value-kind `warning` |
| W8–W9 | set same-kind / set `--null` | NO warning |
| W10 | `--reimport` with no endpoint (`COIR_VERIFY_PORT=3999`) | exit 0, written, graceful note |

---

Execution order: N → G → W. Results logged per-case to [RESULTS-nested.md](RESULTS-nested.md);
the full machine-authored candidate set (51 cases across 7 features, pre-correction) is the
workflow output backstop. Fixtures (`__vfy_*`/`__g*`) are deleted after each case; the project
re-scans `metaErrors=0`.
