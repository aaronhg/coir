### What it is
Load a **Cocos Creator 3.8.x** project to analyze asset **usage** and the **dependency topology**. Everything runs in your browser — no files are uploaded.

### Four tabs
- **List** — sortable asset table. `Used by`/`Uses` are direct degrees; the `∑` columns are transitive closures (blast radius / bundle); the `Bundle` column is the owning Asset Bundle (`main` = unbundled, `resources` = loaded by path). Click to select, double-click (or <kbd>Enter</kbd>) to set it as the centre; <kbd>↑</kbd> <kbd>↓</kbd> move between rows.
- **Topology** — a bidirectional dependency tree around the selected asset: `←` dependents fan left, `→` dependencies fan right, in a fixed 5-column sliding window, with grey parent→child connectors and the selected node's chain (ancestors) + direct children highlighted. Selecting a node auto-shows where it is used. The top bar: a **filter box** on the left that hides non-matching nodes (clear or <kbd>Esc</kbd> restores), and a **breadcrumb** on the right showing the chain to the centre (fixed dependents → dependencies, each crumb clickable, with buttons to copy the chain / a snapshot link).
- **Size map** — a treemap of asset bytes (cell area ∝ size, coloured by type), **scoped to the topology centre's dependency closure** (or the whole project when there's no centre), with image thumbnails painted in. A toggle **groups by Bundle**; assets the build duplicates across bundles get a **red outline**. **Single-click** a cell to drill into its dependency size, **double-click** to jump to Topology; hover for name+size, **pinch to zoom** + scroll to pan, arrows to move + <kbd>Enter</kbd> to drill.
- **Reports** (sub-tabs) — unused/orphan refs, atlas utilization, asset size, **cross-bundle dependencies** (cycles + duplication), source-less metas, plus a plugin-contributed **cross-atlas duplicate** view (the same art baked into multiple Spine/.plist atlases — side-by-side thumbnails + pixel confirmation).

### Type filter
The type badges under the banner are shared by all tabs: they filter List/Reports/Size map (the Size-map counts also track the current scope), and on Topology they keep the paths that reach the chosen type and prune dead branches.

### Quick search <kbd>/</kbd>
Fuzzy-matches name/path/uuid, highlighting matched characters. Scopes: <kbd>@</kbd> sprite-frame, <kbd>#</kbd> type, <kbd>></kbd> usage/node, <kbd>~</kbd> edge-kind (type <kbd>~</kbd> to list them); <kbd>#</kbd>/<kbd>~</kbd> are two-part (`#type query`, `~kind query`). Paste a uuid to jump.

### Shortcuts
- <kbd>Tab</kbd> switch tab (<kbd>Delete</kbd> reverse), <kbd>Esc</kbd> clear type filter
- <kbd>/</kbd> or <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>P</kbd> quick search
- Topology: <kbd>↑</kbd> <kbd>↓</kbd> within a column, <kbd>←</kbd> <kbd>→</kbd> (or two-finger swipe) across columns, <kbd>Enter</kbd> set as new centre, <kbd>−</kbd> back, <kbd>+</kbd> forward, <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>F</kbd> find in this topology, <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>C</kbd> copy name
- Size map: arrows move the cell cursor, <kbd>Enter</kbd> drill, <kbd>−</kbd>/<kbd>+</kbd> centre history; single-click drills, double-click jumps to Topology

### Command-line tools (headless)
Besides this web UI, coir ships a **CLI** (query deps, find duplicate assets, edit prefabs/scenes in place, `coir analyze bundles` cross-bundle audit, the `coir check` CI gate) and an **MCP server**. Zero runtime deps — install in one line (links `coir` onto your PATH):

```
curl -fsSL https://raw.githubusercontent.com/aaronhg/coir/main/install.sh | sh
```

Cocos Creator extension (right-click dependency lookup) — self-contained install into a project:

```
curl -fsSL https://raw.githubusercontent.com/aaronhg/coir/main/install-extension.sh | sh -s -- <cocos-project-path>
```
