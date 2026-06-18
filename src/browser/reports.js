// 報告 tab: unused / orphan refs / atlas utilization / size / dropped metas.
// Every section respects the ONE global type filter (the bar under the banner).
import { S, $, base, dirOf, esc, kb, typeColor } from './state.js';
import { t } from './i18n.js';
import { unusedReport, orphanRefReport, atlasUtilizationReport, sizeReport, droppedMetaReport } from '../core/analyze.js';
import { typeAllowed } from './filterbar.js';
import { visualSectionHTML, hydrateVisualSection } from './visualreport.js';

function refRow(uuid, path, type, right) {
  return `<div class="ref" data-uuid="${uuid}"><span class="dot" style="background:${typeColor(type)}"></span>` +
    `<span class="nm">${esc(base(path))}</span><span class="rdir" title="${esc(dirOf(path))}">${esc(dirOf(path) || '/')}</span>` +
    `<span class="meta">${right || ''}</span></div>`;
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
  const unusedBody = unusedItems.length
    ? unusedItems.slice(0, 300).map((i) => refRow(i.uuid, i.path, i.type, kb(i.size))).join('')
    : `<div class="empty">${esc(t('rep.none'))}</div>`;

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
    `<h4>${esc(t('size.largest'))}</h4>` + sizeItems.slice(0, 100).map((i) => refRow(i.uuid, i.path, i.type, kb(i.size))).join('');

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
    { id: 'unused', title: t('rep.unused'), sub: t('rep.unusedSub', { n: unusedItems.length, size: kb(unusedSize) }), body: unusedBody },
    { id: 'orphan', title: t('rep.orphan'), sub: t('rep.orphanSub', { n: orphans.total }) + (orphans.missingSourceCount ? ' ' + t('rep.orphanMissing', { n: orphans.missingSourceCount }) : ''), body: orphanBody },
    { id: 'atlas', title: t('rep.atlas'), sub: t('rep.atlasSub', { n: atlasItems.length }), body: atlasBody },
    { id: 'size', title: t('rep.size'), sub: kb(sizeTotal), body: sizeBody },
  ];
  if (dropped.total) core.push({ id: 'dropped', title: t('rep.dropped'), sub: t('rep.droppedSub', { n: dropped.total }) + ' · ' + (dropped.referencedCount ? t('rep.droppedRefd', { n: dropped.referencedCount }) : t('rep.droppedNoRef')), body: droppedBody });
  S.reportBodies = Object.fromEntries(core.map((s) => [s.id, s]));

  const pluginTabs = (S.provider && S.provider.readText)
    ? (S.plugins || []).flatMap((p) => (Array.isArray(p.reports) ? p.reports.map((r) => ({ id: r.id, title: t(r.title || r.id), plugin: true })) : []))
    : [];
  // 體積圖 is the FIRST tab — rendered lazily (treemap SVG + async thumbnails) on open.
  const tabs = [...core.map((s) => ({ id: s.id, title: s.title })), ...pluginTabs];
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
  if (sec) { host.innerHTML = `<div class="rbody-head">${sec.title} <span class="sub">${sec.sub}</span></div><div class="rbody">${sec.body}</div>`; return; }
  renderPluginReportBody(S.reportTab, gen); // a plugin tab → async build + thumbnails
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
