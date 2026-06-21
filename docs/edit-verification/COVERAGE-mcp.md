# coir **MCP** server — coverage audit

A 3-lens adversarial audit (coverage · finding-scrutiny · fix-correctness) cross-checked
`PLAN-mcp.md` + `RESULTS-mcp.md` + the 101-spec `_mcp_design_raw.json` against the real
`src/mcp/server.js` + `tools.js` + `ops.js`, **auditing live against the connected server**.
It materially sharpened the findings.

## Verdict

The MCP wrapper is sound — dispatch, arg shapes, error→`isError`, `fs.watch` cache, rescan/
status, serialization, and the flags all work, and both engine fixes are enforced through MCP.
The audit's value was on the **findings**, not gaps in pass/fail:

| Audit critique | Resolution |
|---|---|
| FINDING-4 understated as "scalars only" | **Expanded + reproduced live**: also breaks **wrapper-object** values and **silently kills the unknown-`__type__` guard** (resolveRawTypes walks the stringified value). RESULTS-mcp FINDING-4 rewritten with all three breakages. |
| FINDING-4 root-cause hand-waved ("client stringifies") | **Corrected**: stringification is **non-uniform** (plain strings pass raw; `false`/`2`/objects get stringified); it's **client-side** (coir's `JSON.parse` preserves types) and **Claude-Code-host-specific** — a robustness gap, not a coir parsing bug. |
| Proposed fix (unconditional `JSON.parse`) unsafe | **Replaced**: it would corrupt genuine JSON-shaped string labels (`_string="42"`→number). New rec = an explicit **`json`/`valueJson` discriminator** mirroring the CLI's `--str` vs `--json`, **parsed before `resolveRawTypes`** (ordering caveat). |
| FINDING-3 fix incomplete | **Corrected**: dropping `✗` only in `toolResult` would strip the single `✗` off bare MCP-layer errors; fix must normalize **both** sources to one `✗`. |
| C8 "never fires" overclaim | **Softened** to "hard to reach, mechanism sound, not exhaustively triggered". |
| `edit_swap_uuid all:true` never run | **Filled** (W5) — dry-run-scoped to the fixture, then committed; runSwapAll+markDirty path works. |
| guard-dead via edit_set never run | **Filled live** — confirmed `{__type__:"NotARealClassXyz"}` passes. |
| edit_set_layer / deps direction:in / closure type / atlas-dup / spine-dup never run | **Filled** (gap-fillers) — all dispatch correctly. |

## Remaining untested (lower value)

- **MCP protocol-transport plumbing**: `initialize`/`protocolVersion` echo, `tools/list` shape,
  `tools/call` unknown-tool / method-not-found error codes, `notifications/*` no-reply, EOF
  drain-then-exit. Partly covered by `test/mcp.test.js` (synthetic); not re-run live here.
- **Plugin-command→MCP-tool registration path** (`server.js:68-93`): exercised only via the
  *built-in* plugin tools (`atlas-dup`/`spine-dup`, which returned empty — no plist/atlas in the
  project). The external `anim`/`skel` tools need `.anim`/`.skel` fixtures (none in NewProject_386).
- **Optional args** with no dedicated row: `share base`, `analyze type/limit/dropped`, `duplicates
  section/type`, `check rulesPath`, `deps kind`. (Their CLI equivalents are covered in `RESULTS.md`.)
- **Schema validation**: the hand-rolled server does NOT validate `inputSchema`, so e.g.
  `edit_transform kind:"skew"` is not rejected by an enum check (it would fall through). Untested.

## Findings (both MCP-layer; the edit engine itself is unaffected — see `RESULTS.md`) — both FIXED

- **FINDING-4 (HIGH, robustness)** — `edit_set`'s untyped `value` was mistyped by the Claude Code
  host (scalars, wrapper objects, and the unknown-`__type__` guard). **FIXED** (`tools.js` edit_set):
  a string `value` is `JSON.parse`d back to its type **before** `resolveRawTypes`; non-JSON strings
  kept verbatim; `raw:true` forces a literal string. The other 11 write tools (typed params) were
  already correct. Native-regressed: engine now reads `_enabled` as `Boolean`, `_shadowCastingMode`
  as `Number`, and the unknown-`__type__` guard fires.
- **FINDING-3 (trivial)** — double `✗ ✗` on engine-seam errors. **FIXED** (`server.js` toolResult):
  strip any leading `✗` then add one → exactly one `✗` everywhere.

Both fixes live purely in `src/mcp/`, covered by 3 new `test/mcp.test.js` cases (npm test 161/161),
and native-regressed via a fresh-spawned server + cocos-creator readback. The edit engine is
untouched (80 PASS in `RESULTS.md`).
