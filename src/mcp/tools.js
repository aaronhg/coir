// The MCP tool surface for coir — a thin TYPED layer over the same shared query
// (query) + edit (edit/ops) logic the CLI runs, so behaviour is identical.
// Read tools are unprefixed (a host may auto-allow them); write tools are
// edit_* (gate each one individually — that per-tool boundary is the point
// of the MCP exit). Each tool's `run(ctx, args)` returns { data } on success or
// { error, candidates? } on failure; ctx = the live server state (scan/projectDir
// /markDirty/forceRescan). Writes commit here (respecting dryRun/backup/force).
import { edgeMaps, resolveTarget } from '../shared.js';
import { depsData, infoData, findData, closureData, analyzeData, analyzeAll, ANALYZE_SECTIONS } from '../query.js';
import { runEdit, runSwapAll, commitWrites, resolveRawTypes, getData, treeData } from '../edit/ops.js';

const setOf = (t) => (t ? new Set([t]) : new Set());
function resolveUuid(scan, query) {
  const r = resolveTarget(scan, query);
  if (r.notFound) return { error: `not found: "${query}"` };
  if (r.candidates) return { error: `"${query}" matches ${r.candidates.length} assets — use the full path`, candidates: r.candidates.slice(0, 20) };
  return { uuid: r.uuid };
}

// Run a write op through the shared seam, then commit (unless dryRun). The mtime
// guard refuses a write if the file changed on disk since the scan (Cocos Creator
// saved it) unless force:true.
function applyEdit(ctx, op, params, a) {
  const r = runEdit(ctx.scan, ctx.projectDir, op, params);
  if (r.error) return { error: r.error, candidates: r.candidates };
  if (!a.dryRun) {
    try { commitWrites(r.writes, { backup: !!a.backup, force: !!a.force }); }
    catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
    ctx.markDirty();
  }
  return { data: { file: r.asset.path, ...r.json, dryRun: !!a.dryRun } };
}

// Shared schema fragments for write tools.
const WRITE_FLAGS = {
  dryRun: { type: 'boolean', description: 'Plan the edit and return what would change WITHOUT writing the file.' },
  backup: { type: 'boolean', description: 'Copy the file to <file>.bak before writing.' },
  force: { type: 'boolean', description: 'Skip the concurrent-change guard (write even if the file changed on disk since the scan).' },
};
const SEL_DOC = 'Selector: nodePath then :Type then .prop, e.g. "Canvas/Title:cc.Label._string". [i] disambiguates same-name nodes / same-type components / array elements; #N is the raw array index. Discover selectors with tree.';

export const TOOLS = [
  // ---- reads (*) ------------------------------------------------------
  {
    name: 'find',
    description: 'Find assets by name (substring of path/basename). Returns candidates with path/type/uuid.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['query'],
      properties: { query: { type: 'string', description: 'Name or path substring.' }, type: { type: 'string', description: 'Restrict to one asset type (e.g. prefab, scene, image).' } } },
    run: (ctx, a) => ({ data: findData(ctx.scan, a.query, { types: setOf(a.type) }) }),
  },
  {
    name: 'deps',
    description: 'Dependencies of an asset (what it depends on / who depends on it), 1 hop, with usage locations as paste-able selectors.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['asset'],
      properties: {
        asset: { type: 'string', description: 'Asset by full path / basename / uuid / uuid@sub.' },
        direction: { type: 'string', enum: ['both', 'out', 'in'], description: 'out = what it depends on; in = who depends on it (uses); both (default).' },
        type: { type: 'string', description: 'Keep only neighbours of this asset type.' },
        limit: { type: 'number', description: 'Cap neighbours per side.' },
      } },
    run: (ctx, a) => {
      const u = resolveUuid(ctx.scan, a.asset); if (u.error) return u;
      const dir = a.direction || 'both';
      return { data: depsData(ctx.scan, edgeMaps(ctx.scan), u.uuid, { showOut: dir !== 'in', showIn: dir !== 'out', types: setOf(a.type), limit: a.limit ?? Infinity }) };
    },
  },
  {
    name: 'closure',
    description: 'Transitive bundle closure of an asset: total count/size + per-type breakdown (its blast radius).',
    inputSchema: { type: 'object', additionalProperties: false, required: ['asset'],
      properties: { asset: { type: 'string', description: 'Asset by path / basename / uuid.' }, type: { type: 'string', description: 'Filter the closure to one type.' }, list: { type: 'boolean', description: 'Include every item (path/type/size).' } } },
    run: (ctx, a) => {
      const u = resolveUuid(ctx.scan, a.asset); if (u.error) return u;
      return { data: closureData(ctx.scan, u.uuid, { types: setOf(a.type), list: !!a.list }) };
    },
  },
  {
    name: 'info',
    description: "One asset's record: type/uuid/ext/importer/size, in/out degrees, sub-assets, raw meta userData.",
    inputSchema: { type: 'object', additionalProperties: false, required: ['asset'], properties: { asset: { type: 'string', description: 'Asset by path / basename / uuid.' } } },
    run: (ctx, a) => {
      const u = resolveUuid(ctx.scan, a.asset); if (u.error) return u;
      return { data: infoData(ctx.scan.assets.get(u.uuid)) };
    },
  },
  {
    name: 'analyze',
    description: 'Project-wide audit. section: stats (counts/edge-kinds/metaErrors health), unused (0-referrer non-resources assets), orphans (dangling refs; +dropped for source-less metas), atlas (per-atlas frame utilization), size (per-type totals), or all. Default stats.',
    inputSchema: { type: 'object', additionalProperties: false,
      properties: {
        section: { type: 'string', enum: [...ANALYZE_SECTIONS, 'all'], description: 'Which report (default stats).' },
        type: { type: 'string', description: 'Filter unused/size to one asset type.' },
        limit: { type: 'number', description: 'Cap list items (default 30).' },
        dropped: { type: 'boolean', description: 'orphans: also list dropped source-less metas.' },
        list: { type: 'boolean', description: 'size: include the largest files.' },
      } },
    run: (ctx, a) => {
      const section = a.section || 'stats';
      const opts = { types: setOf(a.type), limit: a.limit ?? 30, dropped: !!a.dropped, list: !!a.list };
      return { data: section === 'all' ? analyzeAll(ctx.scan, opts) : analyzeData(ctx.scan, section, opts) };
    },
  },
  {
    name: 'tree',
    description: 'STRUCTURE DISCOVERY for a prefab/scene: the node hierarchy with each node\'s disambiguated path and every component\'s ready nodePath:Type selector. Start here, then get to read and edit_* to change — no file parsing needed. Flags (off)=inactive, [prefab instance]=nested instance (edit in its source prefab).',
    inputSchema: { type: 'object', additionalProperties: false, required: ['file'],
      properties: {
        file: { type: 'string', description: 'The prefab/scene file (path or basename).' },
        with: { type: 'string', description: 'Keep only nodes carrying this component type (e.g. cc.Label).' },
        under: { type: 'string', description: 'Scope to the subtree under this node selector.' },
        depth: { type: 'number', description: 'Limit to N levels below the root (default: the whole tree).' },
      } },
    run: (ctx, a) => {
      const r = treeData(ctx.scan, ctx.projectDir, a.file, { withType: a.with, under: a.under, depth: a.depth == null ? Infinity : a.depth });
      if (r.error) return { error: r.error, candidates: r.candidates };
      return { data: { file: r.file, nodeCount: r.nodeCount, nodes: r.nodes } };
    },
  },
  {
    name: 'get',
    description: 'Read the value / node / component at a selector in a prefab/scene. Returns the raw JSON (round-trips straight into edit_set value).',
    inputSchema: { type: 'object', additionalProperties: false, required: ['file', 'selector'],
      properties: { file: { type: 'string', description: 'The prefab/scene file.' }, selector: { type: 'string', description: SEL_DOC } } },
    run: (ctx, a) => {
      const r = getData(ctx.scan, ctx.projectDir, a.file, a.selector);
      if (r.error) return { error: r.error, candidates: r.candidates };
      return { data: { value: r.value, kind: r.kind } };
    },
  },
  {
    name: 'status',
    description: 'Server status: the project dir and current scanned asset/edge counts.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    run: (ctx) => ({ data: { project: ctx.projectDir, assets: ctx.scan.assets.size, edges: ctx.scan.edges.length } }),
  },
  {
    name: 'rescan',
    description: 'Force a re-scan of the project from disk now (the scan also auto-refreshes when files change, so this is rarely needed).',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    run: async (ctx) => { await ctx.forceRescan(); return { data: { rescanned: true, assets: ctx.scan.assets.size } }; },
  },

  // ---- writes (edit_*) — gate each individually -----------------------
  {
    name: 'edit_set',
    description: 'Set a component property to a value. `value` is the raw JSON Cocos serializes: a scalar ("hi"/42/true), a wrapper object ({"__type__":"cc.Color","r":..}), an asset ref ({"__uuid__":".."}), or a custom type by class name ({"__type__":"SpriteConfig",..} — converted to its token). Use get to see the current shape.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['file', 'selector', 'value'],
      properties: { file: { type: 'string' }, selector: { type: 'string', description: SEL_DOC }, value: { description: 'The raw value (any JSON).' }, ...WRITE_FLAGS } },
    run: (ctx, a) => {
      const unknown = []; resolveRawTypes(ctx.scan, a.value, unknown);
      if (unknown.length) return { error: `unknown __type__ class(es): ${[...new Set(unknown)].join(', ')} — no matching script asset` };
      return applyEdit(ctx, 'set', { file: a.file, selector: a.selector, value: a.value }, a);
    },
  },
  {
    name: 'edit_set_uuid',
    description: 'Point a property at an asset (sets {__uuid__}). The asset is given by path/basename/uuid.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['file', 'selector', 'asset'],
      properties: { file: { type: 'string' }, selector: { type: 'string', description: SEL_DOC }, asset: { type: 'string', description: 'Target asset.' }, ...WRITE_FLAGS } },
    run: (ctx, a) => applyEdit(ctx, 'set-uuid', { file: a.file, selector: a.selector, asset: a.asset }, a),
  },
  {
    name: 'edit_swap_uuid',
    description: 'Repoint every reference from one asset onto another. With all:true it does this across the WHOLE project; otherwise pass a single file.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['old', 'new'],
      properties: { old: { type: 'string', description: 'Asset currently referenced.' }, new: { type: 'string', description: 'Asset to point at instead.' }, file: { type: 'string', description: 'A single prefab/scene (omit with all:true).' }, all: { type: 'boolean', description: 'Project-wide repoint.' }, ...WRITE_FLAGS } },
    run: (ctx, a) => {
      if (a.all) {
        const r = runSwapAll(ctx.scan, ctx.projectDir, a.old, a.new);
        if (r.error) return { error: r.error, candidates: r.candidates };
        if (!a.dryRun) { try { commitWrites(r.writes, { backup: !!a.backup, force: !!a.force }); } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; } ctx.markDirty(); }
        return { data: { ...r.json, dryRun: !!a.dryRun } };
      }
      if (!a.file) return { error: 'swap_uuid needs `file` (or set all:true for project-wide)' };
      return applyEdit(ctx, 'swap-uuid', { file: a.file, old: a.old, new: a.new }, a);
    },
  },
  {
    name: 'edit_rename',
    description: "Rename a node (its _name).",
    inputSchema: { type: 'object', additionalProperties: false, required: ['file', 'node', 'name'],
      properties: { file: { type: 'string' }, node: { type: 'string', description: 'Node selector.' }, name: { type: 'string', description: 'New name ("" allowed).' }, ...WRITE_FLAGS } },
    run: (ctx, a) => applyEdit(ctx, 'rename', { file: a.file, selector: a.node, value: a.name }, a),
  },
  {
    name: 'edit_set_active',
    description: "Set a node's _active (enabled) flag.",
    inputSchema: { type: 'object', additionalProperties: false, required: ['file', 'node', 'active'],
      properties: { file: { type: 'string' }, node: { type: 'string', description: 'Node selector.' }, active: { type: 'boolean' }, ...WRITE_FLAGS } },
    run: (ctx, a) => applyEdit(ctx, 'set-active', { file: a.file, selector: a.node, value: !!a.active }, a),
  },
  {
    name: 'edit_set_layer',
    description: "Set a node's _layer (integer bitmask).",
    inputSchema: { type: 'object', additionalProperties: false, required: ['file', 'node', 'layer'],
      properties: { file: { type: 'string' }, node: { type: 'string', description: 'Node selector.' }, layer: { type: 'number' }, ...WRITE_FLAGS } },
    run: (ctx, a) => applyEdit(ctx, 'set-layer', { file: a.file, selector: a.node, value: Math.trunc(a.layer) }, a),
  },
  {
    name: 'edit_transform',
    description: "Set a node's local position / scale / rotation. rotation is euler degrees (writes _euler + the matching _lrot quaternion).",
    inputSchema: { type: 'object', additionalProperties: false, required: ['file', 'node', 'kind', 'x', 'y', 'z'],
      properties: { file: { type: 'string' }, node: { type: 'string', description: 'Node selector.' }, kind: { type: 'string', enum: ['pos', 'scale', 'rot'] }, x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, ...WRITE_FLAGS } },
    run: (ctx, a) => {
      const op = a.kind === 'rot' ? 'set-rot' : a.kind === 'scale' ? 'set-scale' : 'set-pos';
      const value = { __type__: 'cc.Vec3', x: a.x, y: a.y, z: a.z };
      return applyEdit(ctx, op, { file: a.file, selector: a.node, value }, a);
    },
  },
  {
    name: 'edit_set_parent',
    description: 'Reparent a node under another (fixes both _children lists; refuses cycles/root).',
    inputSchema: { type: 'object', additionalProperties: false, required: ['file', 'node', 'newParent'],
      properties: { file: { type: 'string' }, node: { type: 'string', description: 'Node to move.' }, newParent: { type: 'string', description: 'New parent node selector.' }, index: { type: 'number', description: 'Sibling index to insert at (default: append).' }, ...WRITE_FLAGS } },
    run: (ctx, a) => applyEdit(ctx, 'set-parent', { file: a.file, selector: a.node, parent: a.newParent, index: a.index == null ? null : a.index }, a),
  },
  {
    name: 'edit_add_node',
    description: 'Add a new empty node under a parent (cloned from a same-file skeleton, so version-correct).',
    inputSchema: { type: 'object', additionalProperties: false, required: ['file', 'parent', 'name'],
      properties: { file: { type: 'string' }, parent: { type: 'string', description: 'Parent node selector.' }, name: { type: 'string' }, index: { type: 'number', description: 'Sibling index (default: append).' }, ...WRITE_FLAGS } },
    run: (ctx, a) => applyEdit(ctx, 'add-node', { file: a.file, parent: a.parent, name: a.name, index: a.index == null ? null : a.index }, a),
  },
  {
    name: 'edit_rm_node',
    description: 'Delete a node and its whole subtree (real delete + global __id__ compaction). Refused if the subtree contains a nested prefab instance.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['file', 'node'],
      properties: { file: { type: 'string' }, node: { type: 'string', description: 'Node selector.' }, ...WRITE_FLAGS } },
    run: (ctx, a) => applyEdit(ctx, 'rm-node', { file: a.file, selector: a.node }, a),
  },
  {
    name: 'edit_add_component',
    description: 'Add a component (by Cocos type, e.g. cc.Widget) to a node.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['file', 'node', 'type'],
      properties: { file: { type: 'string' }, node: { type: 'string', description: 'Node selector.' }, type: { type: 'string', description: 'Component type, e.g. cc.Sprite.' }, ...WRITE_FLAGS } },
    run: (ctx, a) => applyEdit(ctx, 'add-component', { file: a.file, selector: a.node, type: a.type }, a),
  },
  {
    name: 'edit_rm_component',
    description: 'Delete a component (real delete + compaction).',
    inputSchema: { type: 'object', additionalProperties: false, required: ['file', 'selector'],
      properties: { file: { type: 'string' }, selector: { type: 'string', description: 'Component selector, e.g. "Canvas/Btn:cc.Button".' }, ...WRITE_FLAGS } },
    run: (ctx, a) => applyEdit(ctx, 'rm-component', { file: a.file, selector: a.selector }, a),
  },
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
