// 報告 tab: unused / orphan refs / atlas utilization / size / dropped metas.
// Every section respects the ONE global type filter (the bar under the banner).
import { S, $, base, dirOf, esc, kb, typeColor } from './state.js';
import { t } from './i18n.js';
import { unusedReport, orphanRefReport, atlasUtilizationReport, sizeReport, droppedMetaReport } from '../core/analyze.js';
import { typeAllowed } from './filterbar.js';

function refRow(uuid, path, type, right) {
  return `<div class="ref" data-uuid="${uuid}"><span class="dot" style="background:${typeColor(type)}"></span>` +
    `<span class="nm">${esc(base(path))}</span><span class="rdir" title="${esc(dirOf(path))}">${esc(dirOf(path) || '/')}</span>` +
    `<span class="meta">${right || ''}</span></div>`;
}
export function renderReports() {
  if (!S.scan) return;
  const unused = unusedReport(S.scan); const orphans = orphanRefReport(S.scan);
  const atlas = atlasUtilizationReport(S.scan); const size = sizeReport(S.scan);
  const dropped = droppedMetaReport(S.scan);
  const section = (title, sub, body, open = true) =>
    `<details${open ? ' open' : ''}><summary>${title} <span class="sub">${sub}</span></summary><div class="rbody">${body}</div></details>`;

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

  $('reports').innerHTML =
    section(t('rep.unused'), t('rep.unusedSub', { n: unusedItems.length, size: kb(unusedSize) }), unusedBody) +
    section(t('rep.orphan'), t('rep.orphanSub', { n: orphans.total }) + (orphans.missingSourceCount ? ' ' + t('rep.orphanMissing', { n: orphans.missingSourceCount }) : ''), orphanBody) +
    section(t('rep.atlas'), t('rep.atlasSub', { n: atlasItems.length }), atlasBody) +
    section(t('rep.size'), kb(sizeTotal), sizeBody) +
    (dropped.total
      ? section(t('rep.dropped'), t('rep.droppedSub', { n: dropped.total }) + ' · ' + (dropped.referencedCount ? t('rep.droppedRefd', { n: dropped.referencedCount }) : t('rep.droppedNoRef')), droppedBody, false)
      : '');
}
