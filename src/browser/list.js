// 清單 tab: the sortable asset table (= layer 0; pick a root here). The body is
// VIRTUALIZED the same way 拓撲 is — the whole sorted+filtered set is the model
// (S.listRows), the tbody reserves the full height with top/bottom spacer rows,
// and only the rows in the viewport (± a buffer) are painted; scrolling repaints.
// So there is NO row cap — a 50k-asset project shows every row, fast. The keyboard
// cursor (↑↓ move, Enter centres) and scroll-into-view work off the MODEL + the
// measured row height, since off-screen rows are not in the DOM.
import { S, $, COLS, typeColor, kb, esc } from './state.js';
import { t } from './i18n.js';
import { typeAllowed } from './filterbar.js';
import { focus, selectedUuid } from './topo.js';

const BUF = 12;                 // rows of slack above/below the viewport (also covers the sticky thead)
const scrollEl = () => $('listbody'); // the list scroller (a non-scrolling #listwrap holds it + the find overlay, like 拓撲)

// In-list find (Ctrl/⌘+F) — virtualization keeps off-screen rows out of the DOM,
// so the browser's native find can't see them; this is the 拓撲-style own find:
// highlight + scroll-to + cycle over the MODEL (S.listRows), not the DOM.
let findActive = false, findMatches = [], findIdx = -1, findCur = null, findHits = new Set();

function sortRows(rows) {
  const col = COLS.find((c) => c.key === S.sortKey) || COLS[0];
  return rows.slice().sort((a, b) => {
    let r = col.num ? (a[S.sortKey] || 0) - (b[S.sortKey] || 0) : String(a[S.sortKey]).localeCompare(String(b[S.sortKey]));
    if (r === 0 && S.sortKey !== 'base') r = a.base.localeCompare(b.base);
    return r * S.sortDir;
  });
}

function rowHtml(n) {
  const cls = ['lrow', n.uuid === S.treeRoot ? 'rooted' : '', n.uuid === S.listSel ? 'lsel' : '',
    findActive && findHits.has(n.uuid) ? 'lfind-hit' : '', findActive && n.uuid === findCur ? 'lfind-cur' : ''].filter(Boolean).join(' ');
  return `<tr data-uuid="${n.uuid}" class="${cls}" title="${esc(n.path)}">` +
    `<td class="cnm"><span class="dot" style="background:${typeColor(n.type)}"></span>${esc(n.base)}</td>` +
    `<td class="cdir" title="${esc(n.dir)}">${esc(n.dir || '/')}</td>` +
    `<td class="ctype">${n.type}</td>` +
    `<td class="cbundle" title="${esc(n.bundle || '')}">${esc(n.bundle || '—')}</td>` +
    `<td class="cnum">${kb(n.size)}</td>` +
    `<td class="cnum">${n.in}</td><td class="cnum cclo">${n.cin}</td>` +
    `<td class="cnum">${n.out}</td><td class="cnum cclo">${n.cout}</td></tr>`;
}
const spacer = (h) => `<tr class="vpad"><td colspan="${COLS.length}" style="padding:0;border:0;height:${Math.max(0, h)}px"></td></tr>`;

export function renderTable() {
  if (!S.scan) return;
  const q = $('search').value.trim().toLowerCase();
  const filtered = S.nodeIndex.filter((n) => typeAllowed(n.type) && (!q || n.path.toLowerCase().includes(q)));
  S.listRows = sortRows(filtered);
  if (S.listSel && !S.listRows.some((n) => n.uuid === S.listSel)) S.listSel = null; // cursor fell out of the filter
  const arrow = (k) => (k === S.sortKey ? `<span class="ar">${S.sortDir > 0 ? '▲' : '▼'}</span>` : '');
  const head = `<tr>${COLS.map((c) => `<th class="${c.cls}" data-col="${c.key}"${c.titleKey ? ` title="${esc(t(c.titleKey))}"` : ''}>${esc(t(c.labelKey))}${arrow(c.key)}</th>`).join('')}</tr>`;
  $('nodeList').innerHTML =
    `<div id="nodeCount">${esc(t('list.count', { n: filtered.length }))}</div>` +
    `<table class="ptable"><thead>${head}</thead><tbody id="lbody"></tbody></table>`;
  for (const th of $('nodeList').querySelectorAll('th[data-col]')) {
    th.onclick = () => { const k = th.dataset.col; if (k === S.sortKey) S.sortDir *= -1; else { S.sortKey = k; S.sortDir = 1; } renderTable(); };
  }
  const sc = scrollEl();
  if (sc) sc.onscroll = () => { if (S.listPaintScheduled) return; S.listPaintScheduled = true; requestAnimationFrame(() => { S.listPaintScheduled = false; if (S.tab === 'list') paintList(); }); };
  paintList();
  if (findActive) { computeListMatches($('listFindInput').value); pickListIdx(); updateListFindCount(); paintList(); } // rebuild ⇒ refresh find highlights (no scroll yank)
}

// Paint ONLY the rows whose index is in the viewport (± BUF); top/bottom spacer
// rows reserve the rest of the height so the scrollbar reflects the full list.
export function paintList() {
  const sc = scrollEl(); const tbody = $('lbody');
  if (!sc || !tbody) return;
  const rows = S.listRows; const total = rows.length;
  if (!total) { tbody.innerHTML = ''; return; }
  const ROW_H = S.listRowH || 25;        // provisional until measured from a real row (below)
  const off = tbody.offsetTop;           // tbody top within the scroll content = count div + sticky thead (constant)
  const viewH = sc.clientHeight || 600;
  let from = Math.max(0, Math.floor((sc.scrollTop - off) / ROW_H) - BUF);
  let to = Math.min(total, Math.ceil((sc.scrollTop + viewH - off) / ROW_H) + BUF);
  if (from >= to) { from = 0; to = Math.min(total, BUF); } // viewport above/below the body (hidden tab, etc.)
  let html = spacer(from * ROW_H);
  for (let i = from; i < to; i++) html += rowHtml(rows[i]);
  html += spacer((total - to) * ROW_H);
  tbody.innerHTML = html;
  for (const r of tbody.querySelectorAll('tr.lrow')) {
    r.onclick = () => { clearTimeout(S.listClickTimer); const u = r.dataset.uuid; S.listClickTimer = setTimeout(() => setListSel(u, false), 200); }; // single = select
    r.ondblclick = () => { clearTimeout(S.listClickTimer); focus(r.dataset.uuid); };                                                            // double = centre
  }
  // Measure the true row height once (homogeneous rows), then repaint exactly.
  if (!S.listRowH) { const r0 = tbody.querySelector('tr.lrow'); if (r0) { const h = r0.getBoundingClientRect().height; if (h > 0) { S.listRowH = h; paintList(); } } }
}

// ---- 清單鍵盤游標：↑↓ 切換列、Enter 設為中心（以 MODEL 為準，非 DOM） -----------
const indexOf = (uuid) => S.listRows.findIndex((n) => n.uuid === uuid);

// Scroll a model row index into view (mode 'center' or 'nearest'), accounting for
// the sticky thead so a top-aligned row isn't hidden behind it.
function scrollRowIntoView(idx, mode) {
  const sc = scrollEl(); const tbody = $('lbody');
  if (!sc || !tbody || idx < 0) return;
  const ROW_H = S.listRowH || 25; const off = tbody.offsetTop; const viewH = sc.clientHeight;
  const thead = $('nodeList').querySelector('thead');
  const theadH = thead ? thead.getBoundingClientRect().height : 0;
  const rowTop = off + idx * ROW_H; const rowBot = rowTop + ROW_H;
  if (mode === 'center') sc.scrollTop = Math.max(0, rowTop - viewH / 2 + ROW_H / 2);
  else if (rowTop - theadH < sc.scrollTop) sc.scrollTop = Math.max(0, rowTop - theadH); // align under the sticky header
  else if (rowBot > sc.scrollTop + viewH) sc.scrollTop = rowBot - viewH;
}

export function setListSel(uuid, scroll) {
  S.listSel = uuid;
  if (scroll) scrollRowIntoView(indexOf(uuid), 'nearest');
  paintList(); // re-applies the .lsel class to whichever (now-visible) row matches
}
export function moveListSel(delta) {
  const total = S.listRows.length;
  if (!total) return;
  let i = indexOf(S.listSel);
  i = i < 0 ? (delta > 0 ? 0 : total - 1) : Math.max(0, Math.min(total - 1, i + delta));
  setListSel(S.listRows[i].uuid, true);
}
// On 拓撲→清單: scroll the selected node's row into view (else the centre's), and flash it.
export function scrollListToSelection() {
  const sel = selectedUuid();
  let uuid = sel && indexOf(sel) >= 0 ? sel : (S.treeRoot && indexOf(S.treeRoot) >= 0 ? S.treeRoot : null);
  if (!uuid) { paintList(); return; }          // nothing to centre on — still paint for the new viewport
  S.listSel = uuid;
  scrollRowIntoView(indexOf(uuid), 'center');
  paintList();
  requestAnimationFrame(() => {
    const target = $('lbody') && $('lbody').querySelector(`tr[data-uuid="${uuid}"]`);
    if (!target) return;
    target.classList.remove('flash');
    void target.offsetWidth;           // reflow → restart the flash if re-triggered
    target.classList.add('flash');
    setTimeout(() => target.classList.remove('flash'), 1200);
  });
}

// ---- in-list find (Ctrl/⌘+F) — the 拓撲-style own find over the MODEL ----------
export function openListFind() { // floating overlay, top-right of the list region
  if (!S.listRows.length) return;
  findActive = true;
  $('listFind').hidden = false;
  const inp = $('listFindInput'); inp.focus(); inp.select();
  runListFind(); // re-run any retained query
}
export function closeListFind() {
  if (!findActive) return;
  findActive = false; findMatches = []; findIdx = -1; findCur = null; findHits = new Set();
  $('listFind').hidden = true;
  paintList(); // drop the highlights
}
export function isListFindActive() { return findActive; }

function computeListMatches(raw) {
  findMatches = []; findHits = new Set();
  const q = (raw || '').trim().toLowerCase();
  if (!q) return;
  S.listRows.forEach((n, idx) => { if (n.path.toLowerCase().includes(q)) { findMatches.push({ idx, uuid: n.uuid }); findHits.add(n.uuid); } });
}
// Keep the same match selected if it survives, else the one nearest the viewport centre.
function pickListIdx() {
  if (!findMatches.length) { findIdx = -1; findCur = null; return; }
  let i = findCur ? findMatches.findIndex((m) => m.uuid === findCur) : -1;
  if (i < 0) {
    const sc = scrollEl(); const tbody = $('lbody');
    const ROW_H = S.listRowH || 25; const off = tbody ? tbody.offsetTop : 0;
    const centerRow = sc ? (sc.scrollTop + sc.clientHeight / 2 - off) / ROW_H : 0;
    let best = 0, bd = Infinity;
    findMatches.forEach((m, k) => { const d = Math.abs(m.idx - centerRow); if (d < bd) { bd = d; best = k; } });
    i = best;
  }
  findIdx = i; findCur = findMatches[i].uuid;
}
function updateListFindCount() {
  const el = $('listFindCount'); if (!el) return;
  const typed = !!$('listFindInput').value.trim();
  el.textContent = findMatches.length ? t('topo.findCount', { cur: findIdx + 1, total: findMatches.length }) : (typed ? t('topo.findNone') : '');
  $('listFindInput').classList.toggle('nomatch', typed && !findMatches.length);
}
function jumpToListCurrent() {
  const m = findMatches[findIdx];
  if (!m) { paintList(); updateListFindCount(); return; }
  findCur = m.uuid;
  scrollRowIntoView(m.idx, 'center');
  paintList();
  updateListFindCount();
}
export function runListFind() { // on input: recompute, jump to the nearest/kept match
  computeListMatches($('listFindInput').value);
  pickListIdx();
  if (findIdx >= 0) jumpToListCurrent(); else { updateListFindCount(); paintList(); }
}
export function listFindStep(dir) { // Enter / ↑↓ : next / prev match
  if (!findMatches.length) return;
  findIdx = (findIdx + dir + findMatches.length) % findMatches.length;
  findCur = findMatches[findIdx].uuid;
  jumpToListCurrent();
}
