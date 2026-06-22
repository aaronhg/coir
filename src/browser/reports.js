// 報告 tab: unused / orphan refs / atlas utilization / size / dropped metas.
// Every section respects the ONE global type filter (the bar under the banner).
import { S, $, base, dirOf, esc, kb, typeColor } from './state.js';
import { t } from './i18n.js';
import { unusedReport, orphanRefReport, atlasUtilizationReport, sizeReport, droppedMetaReport, bundleDuplication } from '../core/analyze.js';
import { buildBundleGraph, bundleName } from '../core/bundleGraph.js';
import { typeAllowed } from './filterbar.js';
import { visualSectionHTML, hydrateVisualSection } from './visualreport.js';
import { findInstanceOverrides, fileIdToPath } from '../core/classify.js';
import { copyAllBtn } from './copy.js';

function refRow(uuid, path, type, right) {
  return `<div class="ref" data-uuid="${uuid}"><span class="dot" style="background:${typeColor(type)}"></span>` +
    `<span class="nm">${esc(base(path))}</span><span class="rdir" title="${esc(dirOf(path))}">${esc(dirOf(path) || '/')}</span>` +
    `<span class="meta">${right || ''}</span></div>`;
}
// One contributing asset reference behind a bundle→bundle link (data-uuid = the
// referencing asset, so a click focuses it in the topology).
function bundleRefRow(r) {
  const fa = S.scan.assets.get(r.from), ta = S.scan.assets.get(r.to);
  if (!fa || !ta) return '';
  return `<div class="ref" data-uuid="${r.from}" title="${esc(`${fa.path} → ${ta.path}`)}">` +
    `<span class="dot" style="background:${typeColor(fa.type)}"></span>` +
    `<span class="nm">${esc(base(fa.path))} → ${esc(base(ta.path))}</span>` +
    `<span class="meta"><span class="dyn">${esc(r.kind)}</span></span></div>`;
}
// The cross-bundle dependency section (built from the parallel bundle graph; null
// when the project has no real bundles).
function bundleSection() {
  const bg = buildBundleGraph(S.scan);
  if (!bg.nodes.length) return null;
  // axis D: bytes the build copies into ≥2 same-priority bundles
  const dup = bundleDuplication(S.scan);
  const dupBlock = dup.totalWasted > 0
    ? `<div class="bdl-dup">⚠ ${esc(t('rep.bundleDup', { size: kb(dup.totalWasted), n: dup.items.length }))}</div>` +
      `<details class="bdl" open><summary>${esc(t('rep.bundleDupList'))}</summary>` +
      dup.items.map((i) => `<div class="ref" data-uuid="${i.uuid}" title="${esc(i.path)}">` +
        `<span class="dot" style="background:${typeColor(i.type)}"></span><span class="nm">${esc(base(i.path))}</span>` +
        `<span class="meta">×${i.copies} · ${esc(kb(i.wasted))} · ${esc(i.bundles.join(', '))}</span></div>`).join('') +
      `</details>`
    : '';
  const linkSet = new Set(bg.depEdges.map((d) => `${d.from} ${d.to}`));
  const inCyc = (d) => linkSet.has(`${d.to} ${d.from}`);
  const seen = new Set(); const cycPairs = [];
  for (const d of bg.depEdges) { if (!inCyc(d)) continue; const pr = [bundleName(d.from), bundleName(d.to)].sort(); const k = pr.join(' '); if (!seen.has(k)) { seen.add(k); cycPairs.push(pr); } }
  const cycBanner = cycPairs.length ? `<div class="bdl-cyc">⚠ ${cycPairs.map(([a, b]) => `${esc(a)} ⇄ ${esc(b)}`).join(' · ')}</div>` : '';
  const links = bg.depEdges.slice().sort((a, b) => Number(inCyc(b)) - Number(inCyc(a))
    || bundleName(a.from).localeCompare(bundleName(b.from)) || bundleName(a.to).localeCompare(bundleName(b.to)));
  const linksHtml = links.map((d) => {
    const cyc = inCyc(d);
    return `<details class="bdl"${cyc ? ' open' : ''}><summary>${esc(bundleName(d.from))} <span class="arr">→</span> ${esc(bundleName(d.to))}` +
      ` <span class="sub">${d.refs.length}${cyc ? ' ⇄' : ''}</span></summary>${d.refs.map(bundleRefRow).join('')}</details>`;
  }).join('') || `<div class="empty">${esc(t('rep.none'))}</div>`;
  const sub = t('rep.bundleSub', { n: bg.nodes.length })
    + (cycPairs.length ? ` · ${t('rep.bundleCyc', { n: cycPairs.length })}` : '')
    + (dup.totalWasted > 0 ? ` · ${t('rep.bundleDupTag', { size: kb(dup.totalWasted) })}` : '');
  // copy all: the cross-bundle links (from → to), plus any axis-D duplicated assets
  const copyLines = links.map((d) => `${bundleName(d.from)} → ${bundleName(d.to)} (${d.refs.length})`)
    .concat(dup.items.map((i) => `${i.path} ×${i.copies} (${i.bundles.join(', ')})`));
  return { id: 'bundle', title: t('rep.bundle'), sub, body: dupBlock + cycBanner + linksHtml, copyLines };
}
export function renderReports() {
  if (!S.scan) return;
  S.reportGen = (S.reportGen || 0) + 1; // bump so stale async plugin fills bail
  const gen = S.reportGen;
  const unused = unusedReport(S.scan); const orphans = orphanRefReport(S.scan);
  const atlas = atlasUtilizationReport(S.scan); const size = sizeReport(S.scan);
  const dropped = droppedMetaReport(S.scan);

  const unusedItems = unused.items.filter((i) => typeAllowed(i.type));
  const unusedSize = unusedItems.reduce((s, i) => s + (i.size || 0), 0);
  const unusedCands = (unused.candidates || []).filter((i) => typeAllowed(i.type)); // 0-ref but in a bundle (a2)
  const candBlock = unusedCands.length
    ? `<h4 class="rsubh">${esc(t('rep.unusedCand', { n: unusedCands.length }))}${copyAllBtn(unusedCands.map((i) => i.path))}</h4>`
      + unusedCands.slice(0, 200).map((i) => refRow(i.uuid, i.path, i.type, `${kb(i.size)} · ${esc(i.bundle)}`)).join('')
    : '';
  const unusedBody = (unusedItems.length
    ? unusedItems.slice(0, 300).map((i) => refRow(i.uuid, i.path, i.type, kb(i.size))).join('')
    : `<div class="empty">${esc(t('rep.none'))}</div>`) + candBlock;

  const orphanBody = orphans.items.length // orphans have no asset type → unfiltered
    ? orphans.items.slice(0, 200).map((i) => i.missingSource
      ? `<div class="ref orphan missing" title="${esc(t('orphan.missingTitle', { ref: i.ref, count: i.count }))}">` +
        `<span class="dot" style="background:${typeColor('orphan')}"></span>` +
        `<span class="nm">${esc(base(i.path))}</span><span class="rdir">${esc(dirOf(i.path) || '/')}</span>` +
        `<span class="meta"><span class="warn">${esc(t('tag.missingSrc'))}</span> · ${esc(t('rep.sources', { n: i.count }))}</span></div>`
      : `<div class="ref orphan"><code>${esc(i.ref)}</code><span class="meta">${esc(t('rep.sources', { n: i.count }))}</span></div>`).join('')
    : `<div class="empty">${esc(t('rep.none'))}</div>`;

  const atlasItems = atlas.items.filter((i) => typeAllowed(i.type));
  const atlasBody = atlasItems.map((i) => {
    const tag = !i.referenced ? `<span class="warn">${esc(t('tag.unrefd'))}</span>` : i.wholeReferenced ? `<span class="dyn">${esc(t('tag.whole'))}</span>` : '';
    return `<div class="ref" data-uuid="${i.uuid}"><span class="dot" style="background:${typeColor(i.type)}"></span>` +
      `<span class="nm">${esc(base(i.path))}</span><span class="rdir" title="${esc(dirOf(i.path))}">${esc(dirOf(i.path) || '/')}</span>` +
      `<span class="meta">${i.used}/${i.total} (${(i.ratio * 100).toFixed(0)}%) ${tag}</span></div>`;
  }).join('') || `<div class="empty">${esc(t('rep.noAtlas'))}</div>`;

  const sizeTypes = Object.entries(size.byType).filter(([ty]) => typeAllowed(ty)).sort((a, b) => b[1].size - a[1].size);
  const sizeTotal = sizeTypes.reduce((s, [, v]) => s + v.size, 0);
  const sizeItems = size.items.filter((i) => typeAllowed(i.type));
  const sizeBody =
    `<table class="tt"><tr><th>${esc(t('size.type'))}</th><th>${esc(t('size.count'))}</th><th>${esc(t('size.total'))}</th></tr>` +
    sizeTypes.map(([ty, v]) =>
      `<tr><td><span class="dot" style="background:${typeColor(ty)}"></span>${ty}</td><td>${v.count}</td><td>${kb(v.size)}</td></tr>`).join('') +
    `<tr class="tot"><td>${esc(t('size.sum'))}</td><td></td><td>${kb(sizeTotal)}</td></tr></table>` +
    `<h4>${esc(t('size.largest'))}${copyAllBtn(sizeItems.map((i) => i.path))}</h4>` + sizeItems.slice(0, 100).map((i) => refRow(i.uuid, i.path, i.type, kb(i.size))).join('');

  const droppedBody = dropped.items.length
    ? dropped.items.map((i) =>
      `<div class="ref orphan${i.referenced ? ' missing' : ''}" title="${esc(i.path)}">` +
      `<span class="dot" style="background:${typeColor('orphan')}"></span>` +
      `<span class="nm">${esc(base(i.path))}</span><span class="rdir">${esc(dirOf(i.path) || '/')}</span>` +
      `<span class="meta">${i.referenced ? `<span class="warn">${esc(t('tag.stillRef'))}</span>` : `<span class="muted">${esc(t('tag.noRef'))}</span>`}</span></div>`).join('')
    : `<div class="empty">${esc(t('rep.none'))}</div>`;

  // Each report is its own SUB-TAB (was a stacked accordion). Core section bodies
  // are computed synchronously; plugin sections (e.g. spine-dup, with thumbnails)
  // know their id+title upfront but build their body lazily when their tab opens.
  const core = [
    // copyLines = the row paths (one per line) for the header's "copy all" button
    { id: 'unused', title: t('rep.unused'), sub: t('rep.unusedSub', { n: unusedItems.length, size: kb(unusedSize) }), body: unusedBody, copyLines: unusedItems.map((i) => i.path) }, // candidates have their own sub-header button
    { id: 'orphan', title: t('rep.orphan'), sub: t('rep.orphanSub', { n: orphans.total }) + (orphans.missingSourceCount ? ' ' + t('rep.orphanMissing', { n: orphans.missingSourceCount }) : ''), body: orphanBody, copyLines: orphans.items.map((i) => i.missingSource ? i.path : i.ref) },
    { id: 'atlas', title: t('rep.atlas'), sub: t('rep.atlasSub', { n: atlasItems.length }), body: atlasBody, copyLines: atlasItems.map((i) => i.path) },
    { id: 'size', title: t('rep.size'), sub: kb(sizeTotal), body: sizeBody }, // the "copy all" lives on the 最大檔案 sub-header (the body's main content is the per-type table)
  ];
  const bundle = bundleSection();
  if (bundle) core.push(bundle); // cross-bundle dependency audit (only when the project uses bundles)
  if (dropped.total) core.push({ id: 'dropped', title: t('rep.dropped'), sub: t('rep.droppedSub', { n: dropped.total }) + ' · ' + (dropped.referencedCount ? t('rep.droppedRefd', { n: dropped.referencedCount }) : t('rep.droppedNoRef')), body: droppedBody, copyLines: dropped.items.map((i) => i.path) });
  S.reportBodies = Object.fromEntries(core.map((s) => [s.id, s]));

  const pluginTabs = (S.provider && S.provider.readText)
    ? (S.plugins || []).flatMap((p) => (Array.isArray(p.reports) ? p.reports.map((r) => ({ id: r.id, title: t(r.title || r.id), plugin: true })) : []))
    : [];
  // A built-in async tab (reads prefab files on open) — the browser twin of the
  // no-deep-instance-override check rule. Shown whenever we can read files.
  const overrideTab = (S.provider && S.provider.readText) ? [{ id: 'deepoverride', title: t('rep.deepOverride') }] : [];
  // 體積圖 is the FIRST tab — rendered lazily (treemap SVG + async thumbnails) on open.
  const tabs = [...core.map((s) => ({ id: s.id, title: s.title })), ...overrideTab, ...pluginTabs];
  if (!tabs.some((tb) => tb.id === S.reportTab)) S.reportTab = tabs.length ? tabs[0].id : null;

  $('reports').innerHTML =
    `<div id="reportTabs" class="rtabs">` +
    tabs.map((tb) => `<button class="rtab${tb.id === S.reportTab ? ' active' : ''}" data-rtab="${esc(tb.id)}">${esc(tb.title)}</button>`).join('') +
    `</div><div id="reportBody"></div>`;
  $('reportTabs').onclick = (e) => { const b = e.target.closest('[data-rtab]'); if (b) selectReportTab(b.dataset.rtab); };

  renderReportBody(gen);
}

// Switch sub-tab without re-running the whole report (just swap the body).
function selectReportTab(id) {
  if (S.reportTab === id) return;
  S.reportTab = id;
  for (const b of document.querySelectorAll('#reportTabs .rtab')) b.classList.toggle('active', b.dataset.rtab === id);
  renderReportBody(S.reportGen);
}

function renderReportBody(gen) {
  const host = $('reportBody');
  if (!host) return;
  const sec = S.reportBodies && S.reportBodies[S.reportTab];
  if (sec) { host.innerHTML = `<div class="rbody-head">${sec.title} <span class="sub">${sec.sub}</span>${copyAllBtn(sec.copyLines || [])}</div><div class="rbody">${sec.body}</div>`; return; }
  if (S.reportTab === 'deepoverride') { renderDeepOverrideBody(gen); return; } // built-in async tab
  renderPluginReportBody(S.reportTab, gen); // a plugin tab → async build + thumbnails
}

// DEEP nested-instance overrides — a propertyOverride on a node INSIDE a nested
// prefab instance (vs the allowed root-only override). The browser twin of the
// `no-deep-instance-override` check rule: same pure classifier (findInstanceOverrides)
// + the same default engine-baked ignore set, prefab-only (scenes carry legit
// engine-baked deep overrides). Async (reads each prefab); data cached per scan.
const DEEP_OVERRIDE_IGNORE = new Set(['lightmapSettings', '_shadowCastingMode', '_shadowReceivingMode']);
async function renderDeepOverrideBody(gen) {
  const host = $('reportBody');
  if (!host || S.tab !== 'reports') return;
  const provider = S.provider;
  if (!provider || !provider.readText) { host.innerHTML = `<div class="empty">${esc(t('rep.none'))}</div>`; return; }
  if (!S.deepOverrideCache) {
    host.innerHTML = `<div class="empty">${esc(t('vr.loading'))}</div>`;
    const srcCache = new Map(); // source-prefab uuid → parsed array | null (resolve the deep node's name)
    const srcArr = async (su) => {
      if (!srcCache.has(su)) {
        const sa = S.scan.assets.get(su); let parsed = null;
        try { if (sa && sa.path) parsed = JSON.parse(await provider.readText(sa.path)); } catch (e) { /* */ }
        srcCache.set(su, parsed);
      }
      return srcCache.get(su);
    };
    const groups = [];
    for (const [uuid, a] of S.scan.assets) {
      if (a.type !== 'prefab' || !a.path || a.virtual) continue;
      let arr; try { arr = JSON.parse(await provider.readText(a.path)); } catch (e) { continue; }
      const deep = findInstanceOverrides(arr).filter((o) => !o.onRoot && !DEEP_OVERRIDE_IGNORE.has(o.prop));
      for (const o of deep) { // resolve the DEEP node's name from the source prefab (vs the opaque localID)
        o.deepPath = null;
        if (o.sourceUuid && o.localID.length === 1) { const src = await srcArr(o.sourceUuid); if (src) o.deepPath = fileIdToPath(src, o.localID[0]); }
      }
      if (deep.length) groups.push({ uuid, path: a.path, overrides: deep });
    }
    if (S.reportGen !== gen) return; // a newer scan superseded this build
    S.deepOverrideCache = groups;
  }
  if (S.reportGen !== gen || S.reportTab !== 'deepoverride' || !$('reportBody')) return;
  const groups = S.deepOverrideCache;
  const total = groups.reduce((n, g) => n + g.overrides.length, 0);
  const rows = []; const allPaths = [];
  for (const g of groups) for (const o of g.overrides) { // one row per violation; click the prefab to focus it
    // a goto-navigable nodePath: the instance host node's PARENT path + the source-prefab
    // path of the deep node (whose first segment IS the instance root's runtime name) →
    // e.g. Node-001/Node/Node. Paste-able into the Coir Goto panel.
    const parent = o.instancePath.split('/').slice(0, -1).join('/');
    const nodePath = o.deepPath ? (parent ? `${parent}/${o.deepPath}` : o.deepPath) : null;
    allPaths.push(`${nodePath || o.instancePath}.${o.prop}`);
    const meta = nodePath
      ? `<b>${esc(nodePath)}</b><span class="muted">.${esc(o.prop)}</span>`
      : `<span class="muted">${esc(o.instancePath)} · localID </span><b>${esc(o.localID.join('/'))}</b><span class="muted">.${esc(o.prop)}</span>`;
    rows.push(refRow(g.uuid, g.path, 'prefab', meta));
  }
  const body = rows.length ? rows.join('') : `<div class="empty">${esc(t('rep.deepOverrideOk'))}</div>`;
  host.innerHTML = `<div class="rbody-head">${esc(t('rep.deepOverride'))} <span class="sub">${esc(t('rep.deepOverrideSub', { n: total, f: groups.length }))}</span>${copyAllBtn(allPaths)}</div><div class="rbody">${body}</div>`;
}

// Plugin-contributed report tab (Plugin.reports) — e.g. spine's cross-atlas dup
// view with thumbnails. Async (build() reads source files; thumbnails decode
// images). Build DATA is cached per scan; thumbnails re-hydrate each open.
async function renderPluginReportBody(id, gen) {
  const host = $('reportBody');
  if (!host) return;
  if (S.tab !== 'reports') return; // hidden tab → defer the file reads + image decode
  const provider = S.provider;
  if (!provider || !provider.readText) { host.innerHTML = `<div class="empty">${esc(t('rep.none'))}</div>`; return; }
  host.innerHTML = `<div class="empty">${esc(t('vr.loading'))}</div>`;

  if (!S.pluginReportCache) {
    const ctx = { scan: S.scan, readText: (p) => provider.readText(p) };
    const built = [];
    for (const p of (S.plugins || [])) {
      if (!Array.isArray(p.reports)) continue;
      for (const rsec of p.reports) {
        try { built.push({ id: rsec.id, title: t(rsec.title || rsec.id), report: await rsec.build(ctx) }); }
        catch (e) { console.error(`coir: report '${rsec.id}' build failed —`, e); }
      }
    }
    if (S.reportGen !== gen) return; // superseded mid-build
    S.pluginReportCache = built;
  }
  if (S.reportGen !== gen || S.reportTab !== id || !$('reportBody')) return;
  const built = S.pluginReportCache.find((b) => b.id === id);
  if (!built) { host.innerHTML = `<div class="empty">${esc(t('rep.none'))}</div>`; return; }
  host.innerHTML = visualSectionHTML(built.id, built.title, built.report);
  hydrateVisualSection(built.id, built.report, provider, () => S.reportGen === gen && S.reportTab === id);
}
