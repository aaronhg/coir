// The ONE global type-filter bar (under the banner), shared by 清單/拓撲/報告.
// Solo on first click, additive afterwards. Counts are per-tab: 清單/報告 span the
// whole project (byTypeCache), 拓撲 counts only 層0's neighbourhood.
import { S, $, typeColor, esc, FILTER_KEY } from './state.js';
import { t } from './i18n.js';
import { dependentClosure, dependencyClosure } from '../core/graph.js';
import { renderTable } from './list.js';
import { renderTopo } from './topo.js';
import { renderReports } from './reports.js';

export function typeAllowed(ty) { return S.selectedTypes.size === 0 || S.selectedTypes.has(ty); }

function currentTypeCounts() {
  if (S.tab !== 'topo' || !S.treeRoot) return S.byTypeCache;
  const counts = {};
  const nbhd = new Set([S.treeRoot, ...dependentClosure(S.adj, S.treeRoot), ...dependencyClosure(S.adj, S.treeRoot)]);
  for (const u of nbhd) { const a = S.scan.assets.get(u); if (a) counts[a.type] = (counts[a.type] || 0) + 1; }
  return counts;
}
export function renderTypeFilters() {
  const counts = currentTypeCounts();
  const types = Object.keys(S.byTypeCache).sort(); // stable full type list across tabs
  $('typeFilters').innerHTML = types.map((ty) => {
    const on = S.selectedTypes.size === 0 || S.selectedTypes.has(ty);
    const n = counts[ty] || 0;
    return `<button class="chip${on ? ' on' : ''}${n === 0 ? ' zero' : ''}" data-type="${ty}">` +
      `<span class="dot" style="background:${typeColor(ty)}"></span>${ty} <b>${n}</b></button>`;
  }).join('') + (S.selectedTypes.size ? `<button class="chip clr" data-type="__all">${esc(t('filter.all'))}</button>` : '');
  const fl = $('filterbar').querySelector('.flabel');
  if (fl) fl.textContent = (S.tab === 'topo' && S.treeRoot) ? t('filter.labelTopo') : t('filter.label');
  for (const c of $('typeFilters').querySelectorAll('.chip')) c.onclick = () => toggleType(c.dataset.type);
}
export function toggleType(ty) {
  if (ty === '__all') S.selectedTypes.clear();
  else if (S.selectedTypes.size === 0) S.selectedTypes = new Set([ty]);
  else if (S.selectedTypes.has(ty)) S.selectedTypes.delete(ty);
  else S.selectedTypes.add(ty);
  saveFilter();
  renderTypeFilters();
  renderTable();
  if (S.tab === 'topo') { S.selectedKey = S.treeRoot; renderTopo(); } // re-centre; old selection may be pruned
  else if (S.tab === 'reports') renderReports();
}
export function saveFilter() {
  try { localStorage.setItem(FILTER_KEY, JSON.stringify({ q: $('search').value, types: [...S.selectedTypes] })); } catch { /* ignore */ }
}
export function restoreFilter() {
  let f; try { f = JSON.parse(localStorage.getItem(FILTER_KEY) || 'null'); } catch { f = null; }
  $('search').value = f && typeof f.q === 'string' ? f.q : '';
  const types = f && Array.isArray(f.types) ? f.types.filter((ty) => S.byTypeCache[ty]) : []; // 丟掉專案沒有的型別
  S.selectedTypes = new Set(types);
}
