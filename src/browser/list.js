// 清單 tab: the sortable asset table (= layer 0; pick a root here). Also the
// keyboard cursor (↑↓ move, Enter centres) and the scroll-into-view on tab switch.
import { S, $, COLS, typeColor, kb, esc } from './state.js';
import { t } from './i18n.js';
import { typeAllowed } from './filterbar.js';
import { focus, selectedUuid } from './topo.js';

function sortRows(rows) {
  const col = COLS.find((c) => c.key === S.sortKey) || COLS[0];
  return rows.slice().sort((a, b) => {
    let r = col.num ? (a[S.sortKey] || 0) - (b[S.sortKey] || 0) : String(a[S.sortKey]).localeCompare(String(b[S.sortKey]));
    if (r === 0 && S.sortKey !== 'base') r = a.base.localeCompare(b.base);
    return r * S.sortDir;
  });
}
export function renderTable() {
  if (!S.scan) return;
  const q = $('search').value.trim().toLowerCase();
  const filtered = S.nodeIndex.filter((n) => typeAllowed(n.type) && (!q || n.path.toLowerCase().includes(q)));
  const rows = sortRows(filtered);
  const cap = 1000; const shown = rows.slice(0, cap);
  const arrow = (k) => (k === S.sortKey ? `<span class="ar">${S.sortDir > 0 ? '▲' : '▼'}</span>` : '');
  const head = `<tr>${COLS.map((c) => `<th class="${c.cls}" data-col="${c.key}"${c.titleKey ? ` title="${esc(t(c.titleKey))}"` : ''}>${esc(t(c.labelKey))}${arrow(c.key)}</th>`).join('')}</tr>`;
  const body = shown.map((n) =>
    `<tr data-uuid="${n.uuid}"${n.uuid === S.treeRoot ? ' class="rooted"' : ''} title="${esc(n.path)}">` +
    `<td class="cnm"><span class="dot" style="background:${typeColor(n.type)}"></span>${esc(n.base)}</td>` +
    `<td class="cdir" title="${esc(n.dir)}">${esc(n.dir || '/')}</td>` +
    `<td class="ctype">${n.type}</td>` +
    `<td class="cbundle" title="${esc(n.bundle || '')}">${esc(n.bundle || '—')}</td>` +
    `<td class="cnum">${kb(n.size)}</td>` +
    `<td class="cnum">${n.in}</td><td class="cnum cclo">${n.cin}</td>` +
    `<td class="cnum">${n.out}</td><td class="cnum cclo">${n.cout}</td></tr>`).join('');
  $('nodeList').innerHTML =
    `<div id="nodeCount">${esc(t('list.count', { n: filtered.length }))}${rows.length > cap ? esc(t('list.cap', { cap })) : ''}</div>` +
    `<table class="ptable"><thead>${head}</thead><tbody>${body}</tbody></table>`;
  for (const th of $('nodeList').querySelectorAll('th[data-col]')) {
    th.onclick = () => { const k = th.dataset.col; if (k === S.sortKey) S.sortDir *= -1; else { S.sortKey = k; S.sortDir = 1; } renderTable(); };
  }
  for (const r of $('nodeList').querySelectorAll('tbody tr[data-uuid]')) { // 單擊選中、雙擊設為中心
    r.onclick = () => { clearTimeout(S.listClickTimer); const u = r.dataset.uuid; S.listClickTimer = setTimeout(() => setListSel(u, false), 200); };
    r.ondblclick = () => { clearTimeout(S.listClickTimer); focus(r.dataset.uuid); };
  }
  if (S.listSel) { const r = $('nodeList').querySelector(`tr[data-uuid="${S.listSel}"]`); if (r) r.classList.add('lsel'); else S.listSel = null; } // 保留游標
}

// ---- 清單鍵盤游標：↑↓ 切換列、Enter 設為中心 -------------------------------
function listRows() { return [...$('nodeList').querySelectorAll('tbody tr[data-uuid]')]; }
export function setListSel(uuid, scroll) {
  S.listSel = uuid;
  for (const r of listRows()) r.classList.toggle('lsel', r.dataset.uuid === uuid);
  if (scroll) { const el = $('nodeList').querySelector('tr.lsel'); if (el) el.scrollIntoView({ block: 'nearest' }); }
}
export function moveListSel(delta) {
  const rows = listRows();
  if (!rows.length) return;
  const i = rows.findIndex((r) => r.dataset.uuid === S.listSel);
  if (i < 0) { setListSel(rows[delta > 0 ? 0 : rows.length - 1].dataset.uuid, true); return; } // 無游標→端點
  setListSel(rows[Math.max(0, Math.min(rows.length - 1, i + delta))].dataset.uuid, true);
}
// On 拓撲→清單: scroll the selected node's row into view (else the centre's), and flash it.
export function scrollListToSelection() {
  const list = $('nodeList');
  const sel = selectedUuid();
  let target = sel ? list.querySelector(`tr[data-uuid="${sel}"]`) : null;
  if (!target && S.treeRoot) target = list.querySelector(`tr[data-uuid="${S.treeRoot}"]`);
  if (!target) return;
  setListSel(target.dataset.uuid, false); // 進清單時把它設為鍵盤游標
  requestAnimationFrame(() => {
    target.scrollIntoView({ block: 'center' });
    target.classList.remove('flash');
    void target.offsetWidth;           // reflow → restart the flash if re-triggered
    target.classList.add('flash');
    setTimeout(() => target.classList.remove('flash'), 1200);
  });
}
