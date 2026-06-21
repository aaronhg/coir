// The MCP tool surface for coir — a thin TYPED layer over the same shared query
// (query) + edit (edit/ops) logic the CLI runs, so behaviour is identical.
// Read tools are unprefixed (a host may auto-allow them); write tools are
// edit_* (gate each one individually — that per-tool boundary is the point
// of the MCP exit). Each tool's `run(ctx, args)` returns { data } on success or
// { error, candidates? } on failure; ctx = the live server state (scan/projectDir
// /markDirty/forceRescan). Writes commit here (respecting dryRun/backup/force).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { edgeMaps, resolveTarget, shareData } from '../seam/shared.js';
import { depsData, infoData, findData, closureData, analyzeData, analyzeAll, ANALYZE_SECTIONS } from '../seam/query.js';
import { duplicatesData } from '../core/duplicates.js';
import { evaluateRules, DEFAULT_RULES, needsDuplicates, needsInstanceOverrides, needsPreviewLeaks, collectPluginCheckers } from '../core/rules.js';
import { runEdit, runSwapAll, runBatch, commitWrites, resolveRawTypes, getData, treeData, verifyData, verifyAllData, verifyText, auditRoundtripData, collectInstanceOverridesData, collectPreviewLeaksData } from '../edit/ops.js';
import { unifiedDiff } from '../edit/diff.js';
import * as nv from '../verify/nativeClient.js';

const setOf = (t) => (t ? new Set([t]) : new Set());
function resolveUuid(scan, query) {
  const r = resolveTarget(scan, query);
  if (r.notFound) return { error: `not found: "${query}"` };
  if (r.candidates) return { error: `"${query}" matches ${r.candidates.length} assets — use the full path`, candidates: r.candidates.slice(0, 20) };
  return { uuid: r.uuid };
}

// Commit a write-plan result (runEdit/runBatch) honouring dryRun/backup/force,
// plus the shared verify/diff flags. `verify`: structurally validate the planned
// text and refuse to write on errors. `diff`: include a unified diff in the data.
async function commitResult(ctx, r, a) {
  if (r.error) return { error: r.error, candidates: r.candidates };
  const out = { file: r.asset.path, ...r.json, dryRun: !!a.dryRun, needsReimport: !!r.needsReimport };
  if (r.needsReimport) out.reimportReason = r.reimportReason; // finalized by Cocos Creator on next open/reimport
  if (r.warning) out.warning = r.warning;                     // soft type-sanity hint (non-blocking)
  if (a.diff) out.diff = (r.writes || []).map((w) => unifiedDiff(w.oldText ?? '', w.text)).join('\n\n');
  if (a.verify) {
    for (const w of r.writes || []) {
      const v = verifyText(ctx.scan, w.text);
      if (v.errors.length) return { error: `verify: ${v.errors.length} structural error(s) — not written: ${v.errors.slice(0, 6).map((e) => e.msg).join('; ')}` };
    }
  }
  if (!a.dryRun) {
    try { commitWrites(r.writes, { backup: !!a.backup, force: !!a.force }); }
    catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
    ctx.markDirty();
  }
  // --reimport: after writing, ask the running Cocos editor to reimport the file.
  if (a.reimport && !a.dryRun && r.writes && r.writes.length) {
    try { const conn = await nv.connect({ project: ctx.projectDir }); const rep = await nv.reimport(conn.base, `db://assets/${r.asset.path}`); out.reimported = !(rep && rep.error); if (rep && rep.error) out.reimportError = rep.error; }
    catch (e) { out.reimported = false; out.reimportError = e instanceof Error ? e.message : String(e); }
  }
  return { data: out };
}
function applyEdit(ctx, op, params, a) {
  return commitResult(ctx, runEdit(ctx.scan, ctx.projectDir, op, params), a);
}

// Shared schema fragments for write tools.
const WRITE_FLAGS = {
  dryRun: { type: 'boolean', description: 'Plan the edit and return what would change WITHOUT writing the file.' },
  backup: { type: 'boolean', description: 'Copy the file to <file>.bak before writing.' },
  force: { type: 'boolean', description: 'Skip the concurrent-change guard (write even if the file changed on disk since the scan); also overrides the existing-field / reference-shape guards.' },
  verify: { type: 'boolean', description: 'Structurally validate the result before writing; refuse to write on errors.' },
  diff: { type: 'boolean', description: 'Include a unified diff of the change in the result.' },
  reimport: { type: 'boolean', description: 'After writing, ask the running Cocos editor (native-verify endpoint) to reimport the file — refreshes its library so the edit is picked up. Returns reimported:true/false.' },
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
        kind: { type: 'string', description: 'Keep only edges of this kind (e.g. texture, script, extends, audio-call).' },
        limit: { type: 'number', description: 'Cap neighbours per side.' },
      } },
    run: (ctx, a) => {
      const u = resolveUuid(ctx.scan, a.asset); if (u.error) return u;
      const dir = a.direction || 'both';
      return { data: depsData(ctx.scan, edgeMaps(ctx.scan), u.uuid, { showOut: dir !== 'in', showIn: dir !== 'out', types: setOf(a.type), kinds: setOf(a.kind), limit: a.limit ?? Infinity }) };
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
    name: 'share',
    description: "A shareable #topo= snapshot link of an asset's dependency neighbourhood — opens in the browser topology viewer (no server, no upload; the subgraph rides in the URL hash). Returns { url, blob, depth, nodes, … }. depth is the requested max (auto-shrunk to fit); base overrides the viewer URL.",
    inputSchema: { type: 'object', additionalProperties: false, required: ['asset'],
      properties: { asset: { type: 'string', description: 'Asset by path / basename / uuid.' }, depth: { type: 'number', description: 'Max neighbourhood depth (default 5; auto-shrinks to fit).' }, base: { type: 'string', description: 'Viewer base URL (default the hosted viewer).' } } },
    run: async (ctx, a) => {
      const u = resolveUuid(ctx.scan, a.asset); if (u.error) return u;
      return { data: await shareData(ctx.scan, u.uuid, { depth: a.depth, base: a.base }) };
    },
  },
  {
    name: 'analyze',
    description: 'Project-wide audit. section: stats (counts/edge-kinds/metaErrors health), unused (0-referrer non-resources assets), orphans (dangling refs; +dropped for source-less metas), atlas (per-atlas frame utilization), size (per-type totals), bundles (per-bundle size/degree + cross-bundle dependency links with the contributing asset refs + cycles), or all. Default stats.',
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
    name: 'duplicates',
    description: 'Redundant assets to merge. files = byte-identical source files (different uuids); configs = structurally identical prefab/material/anim (catches editor copy-paste that byte-hashing misses). Each group has a suggested canonical (keep) + redundant (drop), mergeable flag, and reclaimable bytes — pair with edit_swap_uuid (all:true). Default both.',
    inputSchema: { type: 'object', additionalProperties: false,
      properties: {
        section: { type: 'string', enum: ['files', 'configs'], description: 'Restrict to one axis (default: both).' },
        type: { type: 'string', description: 'Restrict to one asset type.' },
      } },
    run: async (ctx, a) => ({ data: await duplicatesData(ctx.scan, { readBytes: ctx.bytes, readText: ctx.readText }, { section: a.section, types: setOf(a.type) }) }),
  },
  {
    name: 'check',
    description: 'Run the declarative CI rules and return { violations, errors, warns, configErrors } — the same gate `coir check` uses (no exit code; the agent decides). Rules come from the inline `rules` arg, else `rulesPath`, else <project>/coir.rules.json, else a warn-only default health set. Built-in checkers: max-meta-errors, no-dangling-refs, no-orphans, no-bundle-cycle, max-duplication, no-duplicate-files, forbid-dep, no-cross-bundle, atlas-min-util, no-deep-instance-override, no-editor-preview-leak (+ any plugin-contributed).',
    inputSchema: { type: 'object', additionalProperties: false,
      properties: {
        rules: { type: 'array', items: { type: 'object' }, description: 'Inline ruleset (overrides the file): [{ name, level?, ...params }].' },
        rulesPath: { type: 'string', description: 'Path to a rules JSON file (default <project>/coir.rules.json).' },
      } },
    run: async (ctx, a) => {
      let rules = Array.isArray(a.rules) ? a.rules : null;
      if (!rules) {
        const p = a.rulesPath || path.join(ctx.projectDir, 'coir.rules.json');
        try { const raw = JSON.parse(readFileSync(p, 'utf8')); rules = Array.isArray(raw) ? raw : (raw && raw.rules); } catch { /* none → default */ }
      }
      if (!Array.isArray(rules)) rules = DEFAULT_RULES;
      const c = {};
      if (needsDuplicates(rules)) c.duplicates = await duplicatesData(ctx.scan, { readBytes: ctx.bytes, readText: ctx.readText }, {});
      if (needsInstanceOverrides(rules)) c.instanceOverrides = collectInstanceOverridesData(ctx.scan, ctx.projectDir);
      if (needsPreviewLeaks(rules)) c.previewLeaks = collectPreviewLeaksData(ctx.scan, ctx.projectDir);
      return { data: evaluateRules(ctx.scan, rules, c, collectPluginCheckers(ctx.plugins)) };
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
        values: { type: 'boolean', description: 'Deep read: inline each node\'s + component\'s raw serialized value (structure AND values in one call — no per-node get round-trips).' },
      } },
    run: (ctx, a) => {
      const r = treeData(ctx.scan, ctx.projectDir, a.file, { withType: a.with, under: a.under, depth: a.depth == null ? Infinity : a.depth, values: !!a.values });
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
    name: 'verify',
    description: 'OFFLINE structural validation of a prefab/scene (no live engine needed): checks every {__id__} reference resolves, node↔child↔parent and component back-refs, null gaps, orphan entries, and __type__ resolvability. Returns { valid, errors[], warnings[] } for one file, or with all:true runs the same check over EVERY prefab/scene and returns { valid, total, passed, failures[] } (one project-wide structural gate). Run after an edit_* (or before relying on a file) to catch corruption the engine would reject.',
    inputSchema: { type: 'object', additionalProperties: false,
      properties: { file: { type: 'string', description: 'The prefab/scene file (omit when all:true).' }, all: { type: 'boolean', description: 'Validate every prefab/scene in the project (no file needed).' } } },
    run: (ctx, a) => {
      if (a.all) return { data: verifyAllData(ctx.scan, ctx.projectDir) };
      if (!a.file) return { error: 'verify needs a file (or all:true)' };
      const r = verifyData(ctx.scan, ctx.projectDir, a.file);
      if (r.error) return { error: r.error, candidates: r.candidates };
      return { data: { file: r.file, entries: r.entries, valid: r.valid, errors: r.errors, warnings: r.warnings } };
    },
  },
  {
    name: 'roundtrip',
    description: 'OFFLINE, READ-ONLY round-trip audit of prefab/scene files (no live engine — the headless complement to native-verify). For each file: byte round-trip (does coir reproduce the source verbatim — serializer/diff fidelity, a warning) and an invertible-edit probe (add-then-remove a node through the real edit engine; the result MUST equal the original, else a compaction/clone corruption bug). Set all:true to sweep every prefab/scene, or pass file for one. Never writes. Returns { total, passed, failures[], byteDivergent[], unprobed[], valid }.',
    inputSchema: { type: 'object', additionalProperties: false,
      properties: { file: { type: 'string', description: 'A single prefab/scene to audit (omit when all:true).' }, all: { type: 'boolean', description: 'Audit every prefab/scene in the project.' } } },
    run: (ctx, a) => {
      const r = auditRoundtripData(ctx.scan, ctx.projectDir, { all: !!a.all, file: a.file });
      if (r.error) return { error: r.error, candidates: r.candidates };
      return { data: r };
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
    name: 'edit_batch',
    description: 'Apply MANY edits to ONE prefab/scene ATOMICALLY: load once, apply each op in order (selectors re-resolve against the running state), write once. If any op fails, NOTHING is written (all-or-nothing) — use for a multi-step structural refactor instead of N separate edit_* calls. Each op is { op, …params } (no `file`). Params by op: set → {selector, value}; set-uuid → {selector, asset}; rename/set-active/set-layer → {selector, value}; set-pos/set-scale/set-rot → {selector, value:{"__type__":"cc.Vec3","x":..,"y":..,"z":..}}; set-parent → {selector, parent, index?}; add-node → {parent, name, index?}; rm-node/rm-component → {selector}; add-component → {selector, type}. swap-uuid is NOT allowed (use edit_swap_uuid).',
    inputSchema: { type: 'object', additionalProperties: false, required: ['file', 'ops'],
      properties: { file: { type: 'string' }, ops: { type: 'array', items: { type: 'object' }, description: 'Ordered [{op, …params}] — see the tool description for each op\'s params.' }, ...WRITE_FLAGS } },
    run: (ctx, a) => commitResult(ctx, runBatch(ctx.scan, ctx.projectDir, a.file, a.ops), a),
  },
  {
    name: 'edit_set',
    description: 'Set a component property to a value. `value` is the JSON Cocos serializes: a scalar ("hi"/42/true), a wrapper object ({"__type__":"cc.Color","r":..}), an asset ref ({"__uuid__":".."}), or a custom type by class name ({"__type__":"SpriteConfig",..} — converted to its token). Use get to see the current shape. NOTE: some MCP hosts send `value` as a JSON STRING (e.g. false→"false", an object→its stringified JSON); a JSON-shaped string is parsed back to its type automatically. To set a LITERAL string whose text is itself JSON (e.g. a label reading "true" or "42"), pass `raw:true`.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['file', 'selector', 'value'],
      properties: { file: { type: 'string' }, selector: { type: 'string', description: SEL_DOC }, value: { description: 'The value (any JSON). May be passed as a JSON string — it is parsed back to its type unless raw:true.' }, raw: { type: 'boolean', description: 'Treat a string `value` verbatim (do NOT JSON-parse it) — for a literal string property whose text looks like JSON, e.g. "true"/"42".' }, ...WRITE_FLAGS } },
    run: (ctx, a) => {
      // Defend against MCP hosts that serialize an untyped argument as a JSON string:
      // a string that is valid JSON is parsed back to its real type (bool/number/object),
      // so value:"false" sets a boolean and value:'{"__type__":"cc.Color",..}' sets the
      // wrapper. A string that is NOT valid JSON is kept verbatim; `raw:true` forces verbatim
      // (for a literal string whose text is itself JSON). Parse BEFORE resolveRawTypes so the
      // unknown-__type__ guard sees the real object, not a string. (The CLI is unambiguous —
      // it uses typed --str/--int/--json flags.)
      let value = a.value;
      if (typeof value === 'string' && !a.raw) {
        try { value = JSON.parse(value); } catch { /* not JSON → a literal string */ }
      }
      const unknown = []; resolveRawTypes(ctx.scan, value, unknown);
      if (unknown.length) return { error: `unknown __type__ class(es): ${[...new Set(unknown)].join(', ')} — no matching script asset` };
      return applyEdit(ctx, 'set', { file: a.file, selector: a.selector, value, force: a.force }, a);
    },
  },
  {
    name: 'edit_set_uuid',
    description: 'Point a property at an asset (sets {__uuid__}). The asset is given by path/basename/uuid.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['file', 'selector', 'asset'],
      properties: { file: { type: 'string' }, selector: { type: 'string', description: SEL_DOC }, asset: { type: 'string', description: 'Target asset.' }, ...WRITE_FLAGS } },
    run: (ctx, a) => applyEdit(ctx, 'set-uuid', { file: a.file, selector: a.selector, asset: a.asset, force: a.force }, a),
  },
  {
    name: 'edit_set_ref',
    description: 'Point a property at a NODE or COMPONENT (an intra-file {__id__}) — distinct from edit_set_uuid (asset). Three modes: (P1) target is a node/component in the same file → set target. (P3a) target is a node baked inside a nested instance → inline + a cc.TargetOverrideInfo, offline-complete. (P3b) reference a node ONLY in the instance\'s source prefab → pass target = the nested-instance ROOT and `into` = the node sub-path within the source prefab; coir resolves its fileId and writes a cc.TargetOverrideInfo (engine resolves it; result is needsReimport).',
    inputSchema: { type: 'object', additionalProperties: false, required: ['file', 'selector', 'target'],
      properties: { file: { type: 'string' }, selector: { type: 'string', description: SEL_DOC }, target: { type: 'string', description: 'P1/P3a: target node/component. P3b: the nested-instance ROOT.' }, into: { type: 'string', description: 'P3b only: the target node sub-path WITHIN the instance\'s source prefab.' }, ...WRITE_FLAGS } },
    run: (ctx, a) => applyEdit(ctx, 'set-ref', { file: a.file, selector: a.selector, target: a.target, into: a.into, force: a.force }, a),
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
