// @ts-check
// Declarative CI rule engine: turn the read-only reports (analyze / bundles /
// duplicates) into a PASS/FAIL gate. Pure over a finished scan (+ optional
// precomputed I/O data in ctx) — no parsing of its own, no printing. A registry
// of named checkers; the config (coir.rules.json) only picks which to enable,
// with params + a `level`. `coir check` (and a future MCP `check` tool) drive
// this and map the result to an exit code (error → 1, config error → 2).
import { orphanRefReport, unusedReport, bundleReport, atlasUtilizationReport } from './analyze.js';
import { locSelector } from './selector.js';

const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`);
const arr = (v) => (v == null ? [] : (Array.isArray(v) ? v : [v]));
const base = (p) => p.slice(p.lastIndexOf('/') + 1);

// Match an asset against a from/to spec — every listed field must hold (AND);
// an absent spec matches anything. Fields (each a string or array):
//   type / bundle / pathStartsWith / pathContains / basename  — literal
//   pathRegex / basenameRegex                                 — regular expression
//   not: { …a nested spec… }                                  — negation (must NOT match)
const reTest = (pats, s) => arr(pats).some((p) => (p instanceof RegExp ? p : new RegExp(p)).test(s));
function matchAsset(a, spec) {
  if (!spec) return true;
  if (spec.type && !arr(spec.type).includes(a.type)) return false;
  if (spec.bundle && !arr(spec.bundle).includes(a.bundle)) return false;
  if (spec.pathStartsWith && !arr(spec.pathStartsWith).some((p) => a.path.startsWith(p))) return false;
  if (spec.pathContains && !arr(spec.pathContains).some((p) => a.path.includes(p))) return false;
  if (spec.basename && !arr(spec.basename).includes(base(a.path))) return false;
  if (spec.pathRegex && !reTest(spec.pathRegex, a.path)) return false;
  if (spec.basenameRegex && !reTest(spec.basenameRegex, base(a.path))) return false;
  if (spec.not && matchAsset(a, spec.not)) return false; // negation
  return true;
}

// Compile a matcher's regex fields once (string → RegExp), recursing into `not`.
// An invalid pattern throws here → evaluateRules turns it into a config violation.
function compileMatcher(spec) {
  if (!spec || typeof spec !== 'object') return spec;
  const out = { ...spec };
  if (spec.pathRegex) out.pathRegex = arr(spec.pathRegex).map((p) => (p instanceof RegExp ? p : new RegExp(p)));
  if (spec.basenameRegex) out.basenameRegex = arr(spec.basenameRegex).map((p) => (p instanceof RegExp ? p : new RegExp(p)));
  if (spec.not) out.not = compileMatcher(spec.not);
  return out;
}

// Transitive forbid: every from-asset that REACHES a to-asset through ≥1 edge.
// One reverse-BFS from the to-set marks every asset that can reach it (+ the next
// hop toward it); each from-asset in that set is reported with the offending path.
function forbidTransitive(scan, from, to) {
  const isTo = new Set();
  for (const a of scan.assets.values()) if (matchAsset(a, to)) isTo.add(a.uuid);
  if (!isTo.size) return [];
  const preds = new Map(); // uuid -> [assets pointing INTO it]
  for (const e of scan.edges) { if (!preds.has(e.to)) preds.set(e.to, []); preds.get(e.to).push(e.from); }
  const nextHop = new Map(); // uuid -> a neighbor one step closer to a to-asset
  const q = [...isTo]; const seen = new Set(q);
  for (let i = 0; i < q.length; i++) {
    for (const p of preds.get(q[i]) || []) { if (seen.has(p)) continue; seen.add(p); nextHop.set(p, q[i]); q.push(p); }
  }
  const out = [];
  for (const a of scan.assets.values()) {
    if (!matchAsset(a, from) || !nextHop.has(a.uuid)) continue; // a pure to-asset has no nextHop → ≥1 edge required
    const pathU = [a.uuid]; let cur = a.uuid;
    while (!isTo.has(cur) && nextHop.has(cur)) { cur = nextHop.get(cur); pathU.push(cur); }
    const names = pathU.map((u) => { const x = scan.assets.get(u); return x ? x.path : u; });
    out.push({ message: `${names[0]} ⇒ ${names[names.length - 1]} (transitively, ${pathU.length - 1} hop(s): ${names.join(' → ')})`, asset: a.path });
  }
  return out;
}

// Each checker: (scan, rule, ctx) -> [{ message, asset?, locations? }] (empty = pass).
const CHECKERS = {
  'max-meta-errors': (scan, rule) => {
    const max = rule.max ?? 0;
    return scan.metaErrors.length > max ? [{ message: `${scan.metaErrors.length} meta parse error(s) (max ${max})` }] : [];
  },
  'no-dangling-refs': (scan) => orphanRefReport(scan).items.map((i) =>
    ({ message: `dangling ref ${i.path || i.ref} (${i.count} referrer(s))`, asset: i.path || i.ref })),
  'no-orphans': (scan, rule) => {
    const types = rule.type ? new Set(arr(rule.type)) : null;
    return unusedReport(scan).items.filter((i) => !types || types.has(i.type))
      .map((i) => ({ message: `unused ${i.type} · ${i.path}`, asset: i.path }));
  },
  'no-bundle-cycle': (scan) => bundleReport(scan).cycleGroups.map((g) => ({ message: `bundle cycle ${g.join(' ⇄ ')}` })),
  'max-duplication': (scan, rule) => {
    const max = rule.maxBytes ?? 0;
    const dup = bundleReport(scan).dup;
    return dup.totalWasted > max ? [{ message: `cross-bundle duplication ${kb(dup.totalWasted)} > ${kb(max)} (${dup.total} asset(s))` }] : [];
  },
  // Needs I/O (file bytes / config text) → the host precomputes duplicatesData
  // into ctx.duplicates (the engine stays pure). Absent ctx → no-op.
  'no-duplicate-files': (scan, rule, ctx) => {
    if (!ctx || !ctx.duplicates) return [];
    const axes = rule.axis ? arr(rule.axis) : ['files', 'configs'];
    const out = [];
    for (const ax of axes) for (const g of (ctx.duplicates[ax] || [])) {
      const c = scan.assets.get(g.canonical);
      out.push({ message: `duplicate ${ax}: ${g.redundant.length} redundant copy(ies) of ${c ? c.path : g.canonical} (${kb(g.reclaimable)})`, asset: c ? c.path : g.canonical });
    }
    return out;
  },
  // phase 2 — general "X must not depend on Y" (dependency-cruiser style). The
  // from/to matchers support literals, regex (pathRegex/basenameRegex) and `not`
  // negation; `transitive:true` forbids INDIRECT reach (A must not reach B through
  // any chain), reporting the offending path.
  'forbid-dep': (scan, rule) => {
    if (!rule.from && !rule.to) throw new Error('forbid-dep needs a "from" and/or "to" matcher');
    const from = compileMatcher(rule.from), to = compileMatcher(rule.to);
    if (rule.transitive) {
      if (!rule.from || !rule.to) throw new Error('forbid-dep transitive needs BOTH a "from" and a "to" matcher');
      return forbidTransitive(scan, from, to);
    }
    const out = [];
    for (const e of scan.edges) {
      const f = scan.assets.get(e.from), t = scan.assets.get(e.to);
      if (!f || !t || !matchAsset(f, from) || !matchAsset(t, to)) continue;
      out.push({ message: `${f.path} → ${t.path} (${e.kind})`, asset: f.path, locations: (e.locations || []).map((l) => locSelector(scan, l)).filter(Boolean) });
    }
    return out;
  },
  // phase 2 — forbid a dependency between two bundles (from/to = bundle name(s); omit = any).
  'no-cross-bundle': (scan, rule) => bundleReport(scan).links
    .filter((l) => (!rule.from || arr(rule.from).includes(l.from)) && (!rule.to || arr(rule.to).includes(l.to)))
    .map((l) => ({ message: `${l.from} → ${l.to} (${l.refsTotal} cross-bundle ref(s))${l.cycle ? ' ⇄' : ''}` })),
  // Nested-prefab edit policy: only an instance ROOT's own properties (placement /
  // top-node, e.g. _lpos/_name) may be overridden; a propertyOverride on a node
  // INSIDE an instance is forbidden. References (cc.TargetOverrideInfo) are exempt
  // (a different structure, always allowed). Defaults aimed at PREFAB authoring:
  //   • files: 'prefab' (scenes carry legitimate engine-baked deep overrides —
  //     lightmap / static-batch — so they're off by default; set 'scene'/'all').
  //   • ignoreProps: the engine-baked set (lightmap/shadow), never a manual edit.
  //   • allowProps: an extra allowlist of root props (unused = all root props OK).
  // Needs I/O → the host precomputes ctx.instanceOverrides. See docs/NESTED-PREFABS.md.
  'no-deep-instance-override': (scan, rule, ctx) => {
    if (!ctx || !ctx.instanceOverrides) return [];
    // files: unset → prefab only (scenes carry engine-baked deep overrides);
    // 'all' → no type filter; else the explicit type(s).
    const scope = rule.files === 'all' ? null : (rule.files ? new Set(arr(rule.files)) : new Set(['prefab']));
    const ignore = new Set(rule.ignoreProps ? arr(rule.ignoreProps) : ['lightmapSettings', '_shadowCastingMode', '_shadowReceivingMode']);
    const allow = rule.allowProps ? new Set(arr(rule.allowProps)) : null;
    const out = [];
    for (const { file, type, overrides } of ctx.instanceOverrides) {
      if (scope && !scope.has(type)) continue;
      for (const ov of overrides) {
        if (ov.onRoot && (!allow || allow.has(ov.prop))) continue; // a root (top-node) override is allowed
        if (ignore.has(ov.prop)) continue;                          // engine-baked, not a manual edit
        out.push({ message: `deep instance override: "${ov.prop}" on a node (localID ${ov.localID.join('/')}) inside instance "${ov.instancePath || ov.instance}"`, asset: file });
      }
    }
    return out;
  },
  // Leaked editor preview Canvas: a saved prefab/scene must not contain a node
  // named `should_hide_in_hierarchy` (the editor's prefab-edit preview Canvas,
  // never meant to persist). Needs I/O → host precomputes ctx.previewLeaks.
  'no-editor-preview-leak': (scan, rule, ctx) => {
    if (!ctx || !ctx.previewLeaks) return [];
    return ctx.previewLeaks.map(({ file, nodes }) =>
      ({ message: `editor preview Canvas leaked into the file: ${nodes.join(', ')} — a "should_hide_in_hierarchy" node must never be saved (delete it, then re-save)`, asset: file }));
  },
  // phase 2 — atlases used below `min` utilization (skips whole-/dynamic-referenced ones — unknowable).
  'atlas-min-util': (scan, rule) => {
    const min = rule.min ?? 0.5;
    return atlasUtilizationReport(scan).items
      .filter((i) => i.referenced && !i.wholeReferenced && i.ratio < min)
      .map((i) => ({ message: `${i.path} ${(i.ratio * 100).toFixed(0)}% < ${(min * 100).toFixed(0)}% (${i.used}/${i.total})`, asset: i.path }));
  },
};

export const RULE_NAMES = Object.keys(CHECKERS);

// phase 3 — plugin-contributed checkers: a plugin ships `rules: [{ name, check }]`
// (same `(scan, rule, ctx) → violations[]` contract). Built-ins always win on a
// name collision. The CLI / MCP collect these from the composed plugin set.
export function collectPluginCheckers(plugins) {
  const extra = {};
  for (const p of (plugins || [])) {
    if (!Array.isArray(p.rules)) continue;
    for (const r of p.rules) {
      if (!r || typeof r.name !== 'string' || typeof r.check !== 'function') continue;
      if (CHECKERS[r.name] || extra[r.name]) continue; // built-in / earlier plugin wins
      extra[r.name] = r.check;
    }
  }
  return extra;
}
// Which configured rules need the (I/O-bound) duplicates data precomputed.
export const needsDuplicates = (rules) => (rules || []).some((r) => r && r.name === 'no-duplicate-files');
// …and which need the per-file nested-instance override data precomputed.
export const needsInstanceOverrides = (rules) => (rules || []).some((r) => r && r.name === 'no-deep-instance-override');
// …and which need the per-file preview-Canvas-leak scan.
export const needsPreviewLeaks = (rules) => (rules || []).some((r) => r && r.name === 'no-editor-preview-leak');

// Default ruleset when there is no coir.rules.json: health checks at WARN level
// only — so `coir check` is useful out of the box but never fails CI without an
// explicit (error-level) opt-in.
export const DEFAULT_RULES = [
  { name: 'max-meta-errors', level: 'warn' },
  { name: 'no-dangling-refs', level: 'warn' },
];

/**
 * Evaluate a ruleset against a scan. `level` defaults to 'error'; an unknown
 * rule / bad param / thrown checker becomes a 'config' violation (exit 2).
 * @param {any} scan
 * @param {{name:string, level?:string}[]} rules
 * @param {{duplicates?: any}} [ctx]
 * @param {Record<string, Function>} [extra] plugin-contributed checkers (from collectPluginCheckers)
 * @returns {{ violations: any[], errors: number, warns: number, configErrors: number }}
 */
export function evaluateRules(scan, rules, ctx = {}, extra = {}) {
  const violations = [];
  for (const rule of (rules || [])) {
    if (!rule || typeof rule.name !== 'string') { violations.push({ rule: '(invalid)', level: 'config', message: 'each rule needs a string "name"' }); continue; }
    const fn = CHECKERS[rule.name] || extra[rule.name];
    if (!fn) { violations.push({ rule: rule.name, level: 'config', message: `unknown rule "${rule.name}" (known: ${[...RULE_NAMES, ...Object.keys(extra)].join(', ')})` }); continue; }
    const level = rule.level === 'warn' ? 'warn' : 'error';
    try {
      for (const v of (fn(scan, rule, ctx) || [])) violations.push({ rule: rule.name, level, ...v });
    } catch (e) { violations.push({ rule: rule.name, level: 'config', message: `rule "${rule.name}" failed: ${(e && e.message) || e}` }); }
  }
  const errors = violations.filter((v) => v.level === 'error').length;
  const warns = violations.filter((v) => v.level === 'warn').length;
  const configErrors = violations.filter((v) => v.level === 'config').length;
  return { violations, errors, warns, configErrors };
}
