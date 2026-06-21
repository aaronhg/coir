# coir `edit` — native verification record

This directory is a **durable, reproducible record** of verifying every `coir edit`
operation against a **real Cocos Creator 3.8.6 editor** (not coir reading back its
own output, which would be circular). It exists so the `edit` feature can be
re-validated later by re-running the same plan.

## Why "native"

`coir edit` is a DOM-free, byte-level prefab/scene editor. Proving it works means
proving the **Cocos engine accepts and correctly loads** what it writes. coir's own
CLI and MCP share one engine (`src/edit/ops.js`), so checking coir's output with
coir is self-consistent but not ground truth. The ground truth is the editor's own
serializer/loader, reached here through the **`cocos-creator` MCP**
(`DaxianLee/cocos-mcp-server`, HTTP `:3000`, installed in the project's
`extensions/`). See the memory note `native-edit-verification-setup`.

## Environment

| | |
|---|---|
| Project | `/Users/aaron/Documents/repo/NewProject_386` (Cocos Creator **3.8.6**) |
| coir | `node <repo>/src/cli.js -C <project> <args>` |
| Editor bridge | `cocos-creator` MCP — must be running (editor open + server started) |

## Fixtures (isolated — real assets are never edited)

Created by copying real assets via the editor (fresh uuids), under
`NewProject_386/assets/_coirtest/`:

| Fixture | uuid | Purpose |
|---|---|---|
| `_coirtest/soldier_t.prefab` | `975fe1b3-…` | clean prefab, 34 nodes, no nested instances — most happy-path ops |
| `_coirtest/nested_t.prefab` | `2581b749-…` | has nested prefab instances (#2,#15) — instance-guard refusals |
| `_coirtest/scene_t.scene` | `9d2340eb-…` | scene-target parity test |
| `model/helloWorld/folder-001/sky.png` | — | non-prefab target → "not a prefab/scene" refusal |

These are **deleted at the end** (`project_delete_asset db://assets/_coirtest`).

## Verification strategies

- **native** — for writes that change a node/component value/structure:
  `coir edit … --backup` → `reimport_asset` (engine re-reads; *errors if the file is
  malformed* — a strong validity gate) → `instantiate_prefab` (or `open_scene`) →
  `node_get_node_info` / `find_node_by_name` / `component_get_components` to read the
  engine-built value → **assert == what coir wrote** → delete instantiated node +
  restore `.bak` + reimport.
- **cli-exit** — for refusals/guards/`--dry-run`: assert coir's **exit code** and that
  the file bytes are **unchanged**. No editor needed.
- **cli-reread** — for read-only `tree`/`get`: assert output shape.

## Files

- `PLAN.md` — the full ordered test matrix (op × kind), authored by a multi-agent workflow.
- `RESULTS.md` — per-test execution log: command, exit, observation, PASS/FAIL, raw editor readback.
- `COVERAGE.md` — adversarial audit of coverage gaps / weak verifications.

**MCP-server verification** (the `coir mcp` *wrapper*, not the engine — registered as the
`coir-edit` MCP alongside `cocos-creator`): `PLAN-mcp.md`, `RESULTS-mcp.md`, `COVERAGE-mcp.md`,
`_mcp_design_raw.json`. Covers tool dispatch/arg-shapes, error→`isError` mapping, `fs.watch`
cache invalidation, `rescan`/`status`, `dryRun`/`backup`/`force`. ≈57 PASS + 2 MCP-layer findings
(FINDING-4: `edit_set`'s untyped `value` mistyped by the host; FINDING-3: double `✗✗`).

## Reproduce

1. Open `NewProject_386` in Cocos Creator 3.8.6; start the `cocos-creator` MCP server (`:3000`).
2. Re-create the fixtures (copy the four assets above into `_coirtest/`).
3. Walk `PLAN.md` top to bottom; record into `RESULTS.md`.
4. Delete `_coirtest/`.
