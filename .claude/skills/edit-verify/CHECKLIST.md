# coir `edit` — complete verification checklist (op × value-flag × guard × edge)

The canonical matrix to walk per run. `N` = native-readback, `S` = native-survival,
`X` = cli-exit (refusal/dry-run), `R` = cli-reread (offline `-o json`/`get`). Ground every
selector/field on the actual fixture first. Records go to `docs/edit-verification/RESULTS-<topic>.md`.
Fixtures: a CLEAN prefab (no nested instances) + a NESTED prefab (≥1 `cc.PrefabInstance`) — copy
each as needed; remember the root is renamed to the fixture basename (gotcha G1).

## 1. `set <sel:Type.prop> <value-flag>`

- **N** every value-flag round-trips: `--str --int --num --bool --color #RRGGBBAA --vec2 --vec3
  --vec4 --size --quat --enum --null` → set, reimport, read `.value` == input (Color → `{r,g,b,a}`,
  Vec → `{x,y,z[,w]}`, null → `null`).
- **N/S** `--json '<obj>'` for a wrapper (`{"__type__":"cc.Vec3",…}`) and a class-name `__type__`
  (compressed token written) → reimport survives, value present.
- **X** missing property (no `--force`) → exit 2 `noSuchProp`, unchanged.
- **R** missing property `--force` → exit 0, `needsReimport:true` + `reimportReason` (and the
  engine MAY drop the non-`@property` field on reimport — assert coir's flag, not retention).
- **R** value-kind mismatch (e.g. `--int` into a string field) → exit 0 + `warning`; same-kind /
  `--null` → no warning.
- **X** array index out of range (`prop.5` on a len-1 array) → exit 2 (bounds); append (`==len`) ok;
  replace (`<len`) ok.
- **X** `--color '#ZZZ'` / `--json '{bad'` → exit 1 (bad value); wrong flag for nothing; missing value flag → exit 1.
- **X** sel selects a node or component (not a property) → exit 2 `needProp`.

## 2. `set-uuid <sel> <asset>`

- **N/S** point an asset ref (e.g. a SpriteFrame) at another asset → reimport survives; read the
  ref non-null. **R** the `-o json` `toUuid` is the resolved asset.
- **X** asset not found / ambiguous basename → exit 2 (`notFound`/`ambiguous`).
- **X** missing field (no `--force`) → exit 2; **R** value-kind warning when the field wasn't an asset ref.

## 3. `set-ref <sel> <targetNode[:Type]>` (and `--into <srcSubPath>`)

- **N** P1, **null→resolved**: pick a ref field that is `null` on the fixture, `set-ref` it to a
  sibling NODE → reimport → read resolves non-null. **R** `-o json` `mode:'P1'`, file `{__id__:N}`.
- **R** P1 COMPONENT target (`…:cc.Label`) → `targetKind:'component'`.
- **S** P3a, target a node BAKED inside a nested instance (`<root>//<path>`) → reimport survives
  the `cc.TargetOverrideInfo`. **R** offline: inline `{__id__}` + an override on the outer
  `PrefabInfo.targetOverrides` (correctness is offline — G3).
- **N** P3b, **inline-null→resolved**: `set-ref <sel> <instanceRoot> --into <srcSubPath>` → the
  file's inline ref is `null` + a `cc.TargetOverrideInfo`; `needsReimport:true`,
  `reimportReason` mentions cross-boundary; reimport → read resolves non-null ⇒ the engine
  resolves from the override with NO baked branch (the load-bearing P3b proof).
- **X** guards (each exit 2, unchanged): source not a property (`needProp`); target is a property
  (`refNotNode`); source field missing (`noSuchProp`); source field non-reference (`notRefField`);
  source inside an instance (`instanceGuard`); `--into` target not an instance ROOT
  (`refNeedInstance`); `--into` sub-path absent in source (`selErr`).
- **R** `--force` into a missing field → `needsReimport`; `--dry-run` → no write.

## 4. `swap-uuid <old> <new>` (+ `--all`)

- **N/S** repoint a referenced asset → reimport survives; the new asset resolves where the old was.
- **X** 0 refs in file → exit 0 no-op (bytes unchanged); old===new → exit 0.
- **R** `--all` project-wide → N files changed; `--all` with a selector op → exit 1.

## 5. `rename <node> <newName>`

- **N** read the node → `name == newName`. **N (P2)** on a nested-instance ROOT → a root
  `CCPropertyOverrideInfo`; read the (renamed) root by its new name.
- **X (P2)** on a node DEEPER than the instance root → exit 2 `deepInstanceEdit`, unchanged.
- **X** node not found → exit 2.

## 6. `set-active <node> --bool` / `set-layer <node> --int`

- **N** read `active`/layer. **N (P2)** on an instance root → override; read the flipped value.
- **X** deep-in-instance → exit 2.

## 7. `set-pos / set-scale / set-rot <node> --vec3 x y z`

- **N** read `pos`/`scale`/`euler` (rot authors `_euler`+`_lrot`; compare euler with ~1e-3
  tolerance for non-axis angles). **N (P2)** on an instance root → override.
- **X** `set-rot` without `--vec3` → exit 1; deep-in-instance → exit 2.

## 8. `set-parent <node> <newParent> [--index i]`

- **N** read the moved node under the new parent (and `--index` position).
- **X** new parent is a descendant of the node (cycle) → exit 2; self-move → exit 2; move the root → exit 2;
  parent/target inside an instance → exit 2.

## 9. `add-node <parent> <name> [--index i]`

- **N** the new node exists at the expected path/index after reimport. **R** when the file has no
  `cc.PrefabInfo` to template → `needsReimport:true` (fallback PrefabInfo).
- **X** parent inside a nested instance → exit 2.
- **S** add then `rm-node` it → the result canonicalizes back (the `--roundtrip` invertibility, also offline).

## 10. `rm-node <node>`

- **N** the node is gone; siblings/`__id__` re-compacted (no dangling refs; engine reimports clean).
- **X** the root node → exit 2; a subtree containing a nested instance → exit 2 (`subtreeInstance`).

## 11. `add-component <node> <ccType>`

- **N** the component is present on the node after reimport. A project-script class name → its
  compressed token; the engine builds it.
- **X** unknown non-`cc.` type → exit 2 (`unknownType`).
- **N (negative)** a bogus `cc.Nope` is written (coir trusts `cc.*`) but the engine **drops** it —
  native-verify reports `comp-missing`. This is the canonical case offline `verify` can't catch.

## 12. `rm-component <sel:Type>`

- **N** the component is gone after reimport.
- **X** sel is a node / a `cc.CompPrefabInfo` (not a real component) → exit 2.

## 13. `batch <ops.json>` (atomic)

- **N** several ops applied in one write → reimport reflects all. **X** any op fails → NOTHING is
  written (atomicity: the fixture is byte-identical to before the batch).

## 14. Read-only & gates

- **R** `tree` / `tree --values` / `get` shape; `get` round-trips into `set --json`.
- **R** `verify <file>` and `verify --all` (structural), `verify --all --roundtrip` (edit-engine
  audit) — exit non-zero on a broken file. These are offline CI gates; run them too.

## 15. Cross-cutting flags (apply across ops)

- **X** `--dry-run` → exit 0, bytes unchanged (verify on ≥1 op per category).
- **R** `--backup` → a `.bak` is written alongside.
- **R** `--diff` → a unified diff in the output (works with `--dry-run`).
- **X** `--verify` write-gate → a structurally-broken result is refused (no write).
- **N/X** `--reimport` → after a write, the editor reimports (`↻ reimported`); with no matching
  endpoint (`COIR_VERIFY_PORT=<unused>`), the write STILL succeeds + a graceful note (exit 0).
- **X** mtime guard → edit, touch the file on disk, edit again without `--force` → exit 2;
  `--force` overrides.

## 16. Edge cases / adversarial (the audit lenses)

- The fixture-root-rename (G1) and runtime-vs-file selector (G2) — verify a readback actually
  resolves before trusting a PASS (`{missing:node}` is a silent false-pass risk).
- A ref readback that is non-null on the UNEDITED fixture (vacuous) — require a null→resolved
  delta or assert the offline structure (G3).
- A guard case that uses `--force` (masks the guard) or a mis-grounded field (G4) — re-ground.
- Cross-version: if a 3.5.x editor is available, re-run the happy paths (the format + endpoint
  cover both; the zlib/Buffer fallbacks matter there).
- Atomicity/ordering: a `batch` whose 2nd op fails must leave 0 bytes changed; an `add` then
  `rm` must invert.
