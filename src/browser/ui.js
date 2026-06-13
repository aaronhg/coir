// DOM layer. Three banner tabs over one content area:
//   清單  : sortable asset table (= layer 0; pick a root here)
//   拓撲  : a BIDIRECTIONAL column-aligned tree centred on the root —
//          被依賴層n … | 層0 | … 依賴層n  (dependents fan left, deps fan right)
//   報告  : unused / orphan / atlas-utilization / size reports
// "/" opens a VSCode-style quick-open by filename. "r" restores the saved path.

import {
  unusedReport, orphanRefReport, atlasUtilizationReport, sizeReport, summary, droppedMetaReport,
} from '../core/analyze.js';
import { dependencyClosure, dependentClosure } from '../core/graph.js';
import { decompressUuid } from '../core/uuid.js';
import { t, setLocale, getLocale, applyStaticI18n } from './i18n.js';

const TYPE_COLOR = {
  image: '#4fc3f7', texture: '#4dd0e1', atlas: '#ba68c8', 'sprite-frame': '#4fc3f7',
  spine: '#f06292', 'spine-atlas': '#f48fb1', font: '#ffd54f', prefab: '#81c784',
  scene: '#ff8a65', script: '#90a4ae', audio: '#a1887f', anim: '#4db6ac',
  material: '#9575cd', effect: '#7e57c2', particle: '#ffb74d',
  json: '#b0bec5', text: '#b0bec5', orphan: '#ef5350',
};
const typeColor = (t) => TYPE_COLOR[t] || '#b0bec5';
const $ = (id) => document.getElementById(id);
const base = (p) => p.slice(p.lastIndexOf('/') + 1);
const dirOf = (p) => { const i = p.lastIndexOf('/'); return i === -1 ? '' : p.slice(0, i + 1); };
const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const COLS = [
  { key: 'base', labelKey: 'col.base', cls: 'cnm' },
  { key: 'dir', labelKey: 'col.dir', cls: 'cdir' },
  { key: 'type', labelKey: 'col.type', cls: 'ctype' },
  { key: 'size', labelKey: 'col.size', cls: 'cnum', num: true },
  { key: 'in', labelKey: 'col.in', cls: 'cnum', num: true, titleKey: 'col.in.t' },
  { key: 'cin', labelKey: 'col.cin', cls: 'cnum cclo', num: true, titleKey: 'col.cin.t' },
  { key: 'out', labelKey: 'col.out', cls: 'cnum', num: true, titleKey: 'col.out.t' },
  { key: 'cout', labelKey: 'col.cout', cls: 'cnum cclo', num: true, titleKey: 'col.cout.t' },
];

let scan = null;
let adj = null;
let byTypeCache = {};
let nodeIndex = [];
let closureByUuid = new Map(); // uuid -> nodeIndex entry, for the palette's ∑ columns
let sortKey = 'dir';
let sortDir = 1;
let selectedTypes = new Set(); // empty == all types — ONE global filter for 清單/拓撲/報告
let tab = 'list';
let treeRoot = null;           // centre asset (層0)
let selectedKey = null;        // selected key (root uuid, or a side-prefixed key)
let lastCells = [];            // cells from the last renderTopo (keyboard nav)
let cellClickTimer = null;
let paletteItems = [];
let paletteIdx = 0;
let searchIndex = null; // lazily-built multi-source palette index (assets/frames/usage)
const STORE_KEY = 'coir.sel';

export function initUI({ onPick }) {
  applyStaticI18n(); // localize the static shell for the detected/saved locale
  const ls = $('langSel');
  if (ls) { ls.value = getLocale(); ls.onchange = () => { setLocale(ls.value); relocalize(); }; }
  $('pickBtn').onclick = onPick;
  $('welcomeBtn').onclick = onPick;
  $('helpBtn').onclick = () => { $('help').hidden = false; };
  $('helpClose').onclick = () => { $('help').hidden = true; };
  $('help').onclick = (e) => { if (e.target === $('help')) $('help').hidden = true; }; // backdrop closes
  $('search').oninput = renderTable;
  for (const b of document.querySelectorAll('.btabs button')) b.onclick = () => setTab(b.dataset.tab);
  document.body.addEventListener('click', (e) => {
    const t = e.target.closest('[data-uuid]');
    if (!t || t.closest('#topo') || t.closest('#palette')) return; // those handle themselves
    if (scan && scan.assets.has(t.dataset.uuid)) focus(t.dataset.uuid);
  });
  const pin = $('paletteInput');
  pin.oninput = () => renderPalette(pin.value);
  pin.onkeydown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); movePalette(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); movePalette(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); const it = paletteItems[paletteIdx]; if (it) pickPalette(it.target); }
    else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
  };
  $('palette').onclick = (e) => { if (e.target === $('palette')) closePalette(); };
  document.addEventListener('keydown', onKey);
  document.addEventListener('mousedown', (e) => {
    // clicking a cell re-selects → showUsage refreshes; only close on clicks elsewhere
    if (!$('usagePopup').hidden && !e.target.closest('#usagePopup') && !e.target.closest('.cell')) closeUsage();
  });
  $('topo').addEventListener('wheel', onTopoWheel, { passive: false });
  return { setScan, onProgress, setStatus };
}

function setTab(t) {
  tab = t;
  for (const b of document.querySelectorAll('.btabs button')) b.classList.toggle('active', b.dataset.tab === t);
  $('tab-list').hidden = t !== 'list';
  $('tab-topo').hidden = t !== 'topo';
  $('tab-reports').hidden = t !== 'reports';
  renderTypeFilters(); // badge 母體隨分頁切換(拓撲→層0鄰域)
  if (t !== 'topo') closeUsage();
  if (t === 'topo') renderTopo();
  else if (t === 'reports') renderReports(); // reflect the current global filter
}
function setStatus(msg) { $('status').textContent = msg || ''; }
function onProgress({ phase, done, total }) { setStatus(`${phase} ${done}/${total}`); }
function renderStats() {
  if (scan) $('stats').textContent = t('stats', { assets: scan.assets.size, edges: scan.edges.length, orphans: scan.orphanRefs.length });
}
// Re-apply every translation after a language switch.
function relocalize() {
  applyStaticI18n();
  if (!scan) return;
  renderStats();
  renderTypeFilters();
  renderTable();
  renderReports();
  if (tab === 'topo') renderTopo();
}

// ---- data ----------------------------------------------------------------
function setScan(s, name) {
  scan = s; adj = s.adjacency; treeRoot = null; selectedKey = null; selectedTypes = new Set();
  searchIndex = null;
  $('welcome').hidden = true; // first-run card → gone once a project is loaded
  $('filterbar').hidden = false;
  nodeIndex = [...s.assets.values()].map((a) => ({
    uuid: a.uuid, path: a.path, base: base(a.path), dir: dirOf(a.path),
    type: a.type, size: a.size, in: a.in, out: a.out,
    cin: dependentClosure(adj, a.uuid).size, // transitive dependents (blast radius)
    cout: dependencyClosure(adj, a.uuid).size, // transitive deps (bundle)
  }));
  closureByUuid = new Map(nodeIndex.map((n) => [n.uuid, n]));
  const sum = summary(s); byTypeCache = sum.byType;
  $('projectName').textContent = name;
  renderStats();
  setStatus('');
  renderTypeFilters();
  renderTable();
  renderReports();
  $('topo').innerHTML = `<div class="colhint">${esc(t('topo.hint'))}</div>`;
  setTab('list');
}

// ---- type badges: solo on first click, additive afterwards ---------------
// The badge count is per-tab: 清單/報告 span the whole project (byTypeCache),
// 拓撲 counts only 層0's neighbourhood — 層0 plus everything reachable up- or
// down-stream (both closures), matching the always-fully-expanded tree.
function typeAllowed(t) { return selectedTypes.size === 0 || selectedTypes.has(t); }
function currentTypeCounts() {
  if (tab !== 'topo' || !treeRoot) return byTypeCache;
  const counts = {};
  const nbhd = new Set([treeRoot, ...dependentClosure(adj, treeRoot), ...dependencyClosure(adj, treeRoot)]);
  for (const u of nbhd) { const a = scan.assets.get(u); if (a) counts[a.type] = (counts[a.type] || 0) + 1; }
  return counts;
}
function renderTypeFilters() {
  const counts = currentTypeCounts();
  const types = Object.keys(byTypeCache).sort(); // stable full type list across tabs
  $('typeFilters').innerHTML = types.map((t) => {
    const on = selectedTypes.size === 0 || selectedTypes.has(t);
    const n = counts[t] || 0;
    return `<button class="chip${on ? ' on' : ''}${n === 0 ? ' zero' : ''}" data-type="${t}">` +
      `<span class="dot" style="background:${typeColor(t)}"></span>${t} <b>${n}</b></button>`;
  }).join('') + (selectedTypes.size ? `<button class="chip clr" data-type="__all">${esc(t('filter.all'))}</button>` : '');
  const fl = $('filterbar').querySelector('.flabel');
  if (fl) fl.textContent = (tab === 'topo' && treeRoot) ? t('filter.labelTopo') : t('filter.label');
  for (const c of $('typeFilters').querySelectorAll('.chip')) c.onclick = () => toggleType(c.dataset.type);
}
function toggleType(t) {
  if (t === '__all') selectedTypes.clear();
  else if (selectedTypes.size === 0) selectedTypes = new Set([t]);
  else if (selectedTypes.has(t)) selectedTypes.delete(t);
  else selectedTypes.add(t);
  renderTypeFilters();
  renderTable();
  if (tab === 'topo') { selectedKey = treeRoot; renderTopo(); } // re-centre; old selection may be pruned
  else if (tab === 'reports') renderReports();
}

// ---- 清單: sortable asset table ------------------------------------------
function sortRows(rows) {
  const col = COLS.find((c) => c.key === sortKey) || COLS[0];
  return rows.slice().sort((a, b) => {
    let r = col.num ? (a[sortKey] || 0) - (b[sortKey] || 0) : String(a[sortKey]).localeCompare(String(b[sortKey]));
    if (r === 0 && sortKey !== 'base') r = a.base.localeCompare(b.base);
    return r * sortDir;
  });
}
function renderTable() {
  if (!scan) return;
  const q = $('search').value.trim().toLowerCase();
  const filtered = nodeIndex.filter((n) => typeAllowed(n.type) && (!q || n.path.toLowerCase().includes(q)));
  const rows = sortRows(filtered);
  const cap = 1000; const shown = rows.slice(0, cap);
  const arrow = (k) => (k === sortKey ? `<span class="ar">${sortDir > 0 ? '▲' : '▼'}</span>` : '');
  const head = `<tr>${COLS.map((c) => `<th class="${c.cls}" data-col="${c.key}"${c.titleKey ? ` title="${esc(t(c.titleKey))}"` : ''}>${esc(t(c.labelKey))}${arrow(c.key)}</th>`).join('')}</tr>`;
  const body = shown.map((n) =>
    `<tr data-uuid="${n.uuid}"${n.uuid === treeRoot ? ' class="rooted"' : ''} title="${esc(n.path)}">` +
    `<td class="cnm"><span class="dot" style="background:${typeColor(n.type)}"></span>${esc(n.base)}</td>` +
    `<td class="cdir" title="${esc(n.dir)}">${esc(n.dir || '/')}</td>` +
    `<td class="ctype">${n.type}</td>` +
    `<td class="cnum">${kb(n.size)}</td>` +
    `<td class="cnum">${n.in}</td><td class="cnum cclo">${n.cin}</td>` +
    `<td class="cnum">${n.out}</td><td class="cnum cclo">${n.cout}</td></tr>`).join('');
  $('nodeList').innerHTML =
    `<div id="nodeCount">${esc(t('list.count', { n: filtered.length }))}${rows.length > cap ? esc(t('list.cap', { cap })) : ''}</div>` +
    `<table class="ptable"><thead>${head}</thead><tbody>${body}</tbody></table>`;
  for (const th of $('nodeList').querySelectorAll('th[data-col]')) {
    th.onclick = () => { const k = th.dataset.col; if (k === sortKey) sortDir *= -1; else { sortKey = k; sortDir = 1; } renderTable(); };
  }
}

// ---- shared: a node's neighbours (topology shows the TRUE structure; the
//      清單 type badges filter only the list, not the tree) ----------------
function neighborsOf(uuid, dir) {
  const list = dir === 'out' ? (adj.out.get(uuid) || []) : (adj.inc.get(uuid) || []);
  const m = new Map();
  for (const n of list) {
    const other = dir === 'out' ? n.to : n.from;
    if (scan.assets.has(other) && !m.has(other)) m.set(other, true);
  }
  return m;
}
function sortByTypeName(a, b) {
  const ax = scan.assets.get(a), ay = scan.assets.get(b);
  return (ax.type).localeCompare(ay.type) || base(ax.path).localeCompare(base(ay.path));
}

// ---- pick a root (from table/report/palette) -----------------------------
function focus(uuid) {
  treeRoot = uuid; selectedKey = uuid;
  renderTable();        // highlight the chosen row in 清單
  setTab('topo');       // switch to the tree and render (centres the root)
  saveSel();
}

// ---- 拓撲: bidirectional column-aligned tree -----------------------------
// One side of the tree (deps to the right / dependents to the left), fully
// expanded to maxDepth. A node's first (kept) child shares its row; later
// children start new rows. When the global type filter is active we keep only
// nodes whose type matches OR that lead to a match (中間節點) — dead branches
// are pruned, but 層0 (rendered separately) is always kept.
function buildSide(rootUuid, dir, side, maxDepth) {
  const filtering = selectedTypes.size > 0;
  // Pass 1 — build the node tree (cycle-guarded), dropping non-matching leaves.
  function build(uuid, depth, key, anc) {
    const cycle = anc.has(uuid);
    const realKids = cycle ? [] : [...neighborsOf(uuid, dir).keys()];
    const children = [];
    if (!cycle && depth < maxDepth) {
      const ca = new Set(anc).add(uuid);
      for (const cu of realKids.sort(sortByTypeName)) {
        const cn = build(cu, depth + 1, `${key}>${cu}`, ca);
        if (cn) children.push(cn);
      }
    }
    const a = scan.assets.get(uuid);
    const match = !filtering || (a && selectedTypes.has(a.type));
    if (filtering && !match && children.length === 0) return null; // prune dead branch
    const hasKids = filtering ? children.length > 0 : realKids.length > 0;
    return { uuid, depth, key, cycle, hasKids, children };
  }
  // Pass 2 — assign rows over the kept tree and flatten to cells.
  const cells = []; let row = -1;
  function layout(n, inheritRow) {
    const myRow = inheritRow != null ? inheritRow : ++row;
    cells.push({ uuid: n.uuid, depth: n.depth, row: myRow, key: n.key, hasKids: n.hasKids, cycle: n.cycle, side });
    n.children.forEach((c, i) => layout(c, i === 0 ? myRow : null));
  }
  if (maxDepth < 1) return cells;
  const anc = new Set([rootUuid]);
  for (const cu of [...neighborsOf(rootUuid, dir).keys()].sort(sortByTypeName)) {
    const n = build(cu, 1, `${side}:${rootUuid}>${cu}`, anc);
    if (n) layout(n, null);
  }
  return cells;
}
function cellHtml(c, col) {
  const a = scan.assets.get(c.uuid);
  const sym = c.cycle ? '↻' : c.hasKids ? (c.side === 'L' ? '◂' : '▸') : '';
  return `<div class="cell ${c.side === 'L' ? 'left' : 'right'}${c.key === selectedKey ? ' sel' : ''}"` +
    ` data-key="${esc(c.key)}" data-uuid="${c.uuid}" data-side="${c.side}"` +
    ` title="${esc(a ? a.path : c.uuid)}" style="grid-column:${col};grid-row:${c.row + 1}">` +
    `<span class="tw">${sym}</span><span class="dot" style="background:${typeColor(a ? a.type : 'orphan')}"></span>` +
    `<span class="cnm">${esc(a ? base(a.path) : c.uuid.slice(0, 10) + '…')}</span></div>`;
}
// signed offset of a selected key (層0=0, 依賴=+depth, 被依賴=-depth)
function offsetOfKey(key) {
  if (!key || key === treeRoot) return 0;
  const depth = key.split('>').length - 1;
  return key[0] === 'L' ? -depth : depth;
}
function renderTopo() {
  if (!scan) return;
  if (!treeRoot) { $('topo').innerHTML = `<div class="colhint">${esc(t('topo.hint'))}</div>`; return; }
  // 5-column window centred on the selected node's offset. Build each side only
  // as deep as the window shows — but when the type filter is on, build the full
  // reachable tree (cycle-bounded) so matches deeper than the window still keep
  // their connecting path visible.
  const viewOffset = offsetOfKey(selectedKey);
  const lo = viewOffset - 2, hi = viewOffset + 2;
  const DEEP = 24;
  const right = buildSide(treeRoot, 'out', 'R', selectedTypes.size ? DEEP : hi);
  const left = buildSide(treeRoot, 'in', 'L', selectedTypes.size ? DEEP : 2 - viewOffset);
  lastCells = [...left, ...right];
  const inWin = (off) => off >= lo && off <= hi;
  const gcol = (off) => off - lo + 1; // 1..5
  const cnt = (cells, d) => cells.filter((c) => c.depth === d).length;

  let head = '<div class="topohead">';
  const lyr = t('topo.layer');
  for (let gc = 1; gc <= 5; gc++) {
    const off = lo + (gc - 1);
    // ← 被依賴 / → 依賴 (arrow = direction); 「層n」 = which layer (NOT a count, so
    // it doesn't clash with the palette's ←count →count); the .thc pill = node
    // count at that layer. 層0 has no label — the tinted centre column says it.
    const label = off === 0 ? '' : off > 0 ? `<i>→</i>${lyr}${off}` : `<i>←</i>${lyr}${-off}`;
    const count = off === 0 ? '' : off > 0 ? cnt(right, off) : cnt(left, -off);
    head += `<div class="th${off === 0 ? ' center' : ''}">${label}${count !== '' ? `<span class="thc">${count}</span>` : ''}</div>`;
  }
  head += '</div>';

  let body = '<div class="treebody"><div class="tree">';
  if (inWin(0)) {
    const a = scan.assets.get(treeRoot);
    body += `<div class="cell root${selectedKey === treeRoot ? ' sel' : ''}" data-key="${esc(treeRoot)}" data-uuid="${treeRoot}"` +
      ` title="${esc(a ? a.path : treeRoot)}" style="grid-column:${gcol(0)};grid-row:1">` +
      `<span class="dot" style="background:${typeColor(a ? a.type : 'orphan')}"></span><span class="cnm">${esc(a ? base(a.path) : treeRoot)}</span></div>`;
  }
  for (const c of left) { const off = -c.depth; if (inWin(off)) body += cellHtml(c, gcol(off)); }
  for (const c of right) { const off = c.depth; if (inWin(off)) body += cellHtml(c, gcol(off)); }
  body += '</div></div>';
  $('topo').innerHTML = head + body;
  for (const el of $('topo').querySelectorAll('.cell')) {
    const key = el.dataset.key, uuid = el.dataset.uuid;
    el.onclick = () => { clearTimeout(cellClickTimer); cellClickTimer = setTimeout(() => selectTopoKey(key), 200); };
    el.ondblclick = () => { clearTimeout(cellClickTimer); focus(uuid); };
  }
  const selEl = $('topo').querySelector('.cell.sel') || $('topo').querySelector('.cell.root');
  if (selEl) selEl.scrollIntoView({ block: 'center', inline: 'nearest' }); // 上下置中
  showUsage(); // auto-show the "used where" info for the selected ↔ parent edge
}
function selectTopoKey(key) { selectedKey = key; renderTopo(); saveSel(); }

// ---- persistence + keyboard ----------------------------------------------
function saveSel() {
  if (!treeRoot) return;
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ key: selectedKey || treeRoot })); } catch { /* ignore */ }
}
function restoreSel() {
  let saved; try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { saved = null; }
  if (!saved || !scan) return;
  const raw = String(saved.key || '');
  let side = null, body = raw;
  if (raw.startsWith('R:') || raw.startsWith('L:')) { side = raw[0]; body = raw.slice(2); }
  const uuids = body.split('>').filter(Boolean);
  if (!uuids.length || !scan.assets.has(uuids[0])) return;
  if (side) {
    const dir = side === 'L' ? 'in' : 'out';
    for (let i = 0; i < uuids.length - 1; i++) { if (!scan.assets.has(uuids[i + 1]) || !neighborsOf(uuids[i], dir).has(uuids[i + 1])) return; }
  }
  treeRoot = uuids[0];
  selectedKey = side ? `${side}:${uuids.join('>')}` : treeRoot;
  renderTable();
  setTab('topo');
}
function firstChildKey(uuid, side) {
  const fc = [...neighborsOf(uuid, side === 'R' ? 'out' : 'in').keys()].sort(sortByTypeName)[0];
  return fc;
}
function selectedUuid() {
  if (!treeRoot) return null;
  if (!selectedKey || selectedKey === treeRoot) return treeRoot;
  return selectedKey.split('>').pop();
}
function copyToClipboard(text, done) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else fallbackCopy(text, done);
}
function copyName(uuid) {
  const name = base(scan.assets.get(uuid).path);
  copyToClipboard(name, () => setStatus(t('copy.named', { name })));
}
function fallbackCopy(s, done) {
  const ta = document.createElement('textarea');
  ta.value = s; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); done(); } catch { /* ignore */ }
  document.body.removeChild(ta);
}

// ---- usage popup: where/how an asset is used ("被依賴" sites) -------------
function compName(raw) {
  if (!raw) return '';
  if (raw.startsWith('cc.')) return raw.slice(3);
  if (raw.startsWith('sp.')) return raw.slice(3);
  if (raw.length === 22 || raw.length === 23) { const a = scan.assets.get(decompressUuid(raw)); if (a) return base(a.path); }
  return raw;
}
const COPY_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CHECK_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
let usageText = ''; // plain-text of the current usage popup, for its copy button
function flashCopied(btn) {
  btn.innerHTML = CHECK_ICON; btn.classList.add('ok');
  setTimeout(() => { btn.innerHTML = COPY_ICON; btn.classList.remove('ok'); }, 1200);
  setStatus(t('usage.copied'));
}
// Auto-shown for the SELECTED cell: where it sits inside its tree-parent (the
// adjacent node already on screen). Only the location detail — the from/to
// asset names are already visible in the tree. Hidden for the centre/root and
// for relationships with no node location (structural edges).
function showUsage() {
  const pop = $('usagePopup');
  if (tab !== 'topo' || !scan || !treeRoot || !selectedKey || selectedKey === treeRoot) { pop.hidden = true; return; }
  const segs = selectedKey.split('>');
  const a = segs[segs.length - 1];
  const p = segs.length >= 3 ? segs[segs.length - 2] : treeRoot; // tree-parent uuid
  const side = selectedKey[0];
  const from = side === 'R' ? p : a; // the scene/prefab that contains the usage
  const to = side === 'R' ? a : p;   // the asset being used
  const fromA = scan.assets.get(from);
  if (!fromA) { pop.hidden = true; return; }
  const locs = scan.edges.filter((e) => e.from === from && e.to === to).flatMap((e) => e.locations || []);
  if (!locs.length) { pop.hidden = true; return; } // structural edge / no node-level location
  const seen = new Set(); const rows = []; const plain = [];
  for (const l of locs) {
    const npRaw = l.nodePath || t('usage.root');
    const np = esc(npRaw);
    let tail, tailRaw;
    if (l.property && l.property.startsWith('click')) { // cc.Button ClickEvent — show a badge
      const method = l.property.replace(/^click → /, '').replace(/\(\)$/, '');
      tail = `<span class="up-click">▶ ${esc(method)}</span>`; tailRaw = `▶ ${method}`;
    } else {
      // when there's no property the ref IS the component itself (its name == the
      // selected asset, redundant) — just show the node path.
      const compProp = l.property ? (l.component ? `${compName(l.component)}.${l.property}` : l.property) : '';
      const parts = [compProp, l.subName ? `🖼 ${l.subName}` : ''].filter(Boolean);
      tail = parts.map(esc).join('  ·  '); tailRaw = parts.join('  ·  ');
    }
    const key = `${np}|${tail}`;
    if (seen.has(key)) continue; seen.add(key);
    rows.push(`<div class="up-site">${np}${tail ? `  ·  ${tail}` : ''}</div>`);
    plain.push(`${npRaw}${tailRaw ? `  ·  ${tailRaw}` : ''}`);
  }
  usageText = plain.join('\n'); // just the usage sites, no header line
  const headHtml = t('usage.header', { file: `<b>${esc(base(fromA.path))}</b>`, n: rows.length });
  pop.innerHTML = `<div class="up-head"><span>${headHtml}</span>` +
    `<button class="up-copy" type="button" title="${esc(t('usage.copyTitle'))}" aria-label="${esc(t('usage.copyAria'))}">${COPY_ICON}</button></div>` +
    `<div class="up-list">${rows.join('')}</div>`;
  pop.hidden = false;
  const cb = pop.querySelector('.up-copy');
  if (cb) cb.onclick = (ev) => { ev.stopPropagation(); copyToClipboard(usageText, () => flashCopied(cb)); };
  positionUsage(pop);
}
function closeUsage() { $('usagePopup').hidden = true; }
function positionUsage(pop) {
  const sel = $('topo').querySelector('.cell.sel');
  if (!sel) { pop.hidden = true; return; }
  const r = sel.getBoundingClientRect();
  const top0 = $('topo').getBoundingClientRect().top; // below the banner + column header
  const vw = window.innerWidth, vh = window.innerHeight, m = 8;
  pop.style.maxHeight = 'none';
  const pw = pop.offsetWidth || 360;
  const left = Math.min(Math.max(m, r.left), vw - pw - m);
  // Put the popup on whichever side of the cell has more room, and cap its
  // height to that space (it scrolls internally) so it never covers the banner.
  const below = vh - m - (r.bottom + 6);
  const above = (r.top - 6) - (top0 + 4);
  if (below >= above) {
    pop.style.top = `${r.bottom + 6}px`;
    pop.style.maxHeight = `${Math.max(90, below)}px`;
  } else {
    pop.style.maxHeight = `${Math.max(90, above)}px`;
    pop.style.top = `${Math.max(top0 + 4, r.top - 6 - pop.offsetHeight)}px`;
  }
  pop.style.left = `${left}px`;
  return;
}
function onKey(e) {
  if (!$('palette').hidden) return; // palette has its own handler
  if (!$('help').hidden) { if (e.key === 'Escape') { e.preventDefault(); $('help').hidden = true; } return; } // help open → only Esc
  const typing = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');
  if (e.key === '/' && !typing) { e.preventDefault(); openPalette(); return; }
  if ((e.key === 'r' || e.key === 'R') && !e.metaKey && !e.ctrlKey && !e.altKey) { if (typing) return; e.preventDefault(); restoreSel(); return; }
  if ((e.key === 'c' || e.key === 'C') && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
    if (typing) return;                                            // copying inside an input
    if (window.getSelection && window.getSelection().toString()) return; // a text selection exists → let the browser copy it
    const u = selectedUuid();
    if (u && scan && scan.assets.has(u)) { e.preventDefault(); copyName(u); }
    return;
  }
  if (e.key === 'Escape' && !$('usagePopup').hidden) { e.preventDefault(); closeUsage(); return; }
  if (typing || tab !== 'topo' || !treeRoot) return;
  if (e.key === 'Enter') { const u = selectedUuid(); if (u) { e.preventDefault(); focus(u); } return; }
  const dir = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }[e.key];
  if (!dir) return;
  e.preventDefault();
  navTree(dir);
}
// Shared tree navigation (keyboard arrows + trackpad swipe).
// ↑/↓ : move within the current column. ←/→ : move one column toward 被依賴/依賴
// and select the item NEAREST the viewport vertical centre (skip if empty).
function navTree(dir) {
  if (!treeRoot) return;
  if (dir === 'up' || dir === 'down') {
    if (!selectedKey || selectedKey === treeRoot) return; // 層0 is a single cell
    const side = selectedKey[0];
    const depth = selectedKey.split('>').length - 1;
    const col = lastCells.filter((c) => c.side === side && c.depth === depth).sort((a, b) => a.row - b.row);
    const nx = col[col.findIndex((c) => c.key === selectedKey) + (dir === 'down' ? 1 : -1)];
    if (nx) selectTopoKey(nx.key);
    return;
  }
  const targetOffset = offsetOfKey(selectedKey) + (dir === 'right' ? 1 : -1);
  const topoEl = $('topo');
  const cells = [...topoEl.querySelectorAll('.cell')].filter((el) => offsetOfKey(el.dataset.key) === targetOffset);
  if (!cells.length) return; // no item that direction → don't move
  const area = topoEl.querySelector('.treebody') || topoEl;
  const box = area.getBoundingClientRect();
  const centerY = box.top + box.height / 2;
  let best = null, bestD = Infinity;
  for (const el of cells) {
    const r = el.getBoundingClientRect();
    const d = Math.abs((r.top + r.height / 2) - centerY);
    if (d < bestD) { bestD = d; best = el; }
  }
  if (best) selectTopoKey(best.dataset.key);
}
// Trackpad two-finger horizontal swipe → ←/→ navigation (and blocks the macOS
// browser back/forward gesture). Swipe right (back, deltaX<0) → left/toward
// centre; swipe left (forward, deltaX>0) → right/deeper.
let swipeAccum = 0, swipeLock = false, swipeTimer = null;
function onTopoWheel(e) {
  if (tab !== 'topo' || !treeRoot) return;
  if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return; // vertical → normal scroll
  e.preventDefault();                                   // block browser back/forward
  if (swipeLock) return;
  swipeAccum += e.deltaX;
  clearTimeout(swipeTimer);
  swipeTimer = setTimeout(() => { swipeAccum = 0; }, 180);
  if (swipeAccum <= -50) fireSwipe('left');
  else if (swipeAccum >= 50) fireSwipe('right');
}
function fireSwipe(dir) {
  navTree(dir);
  swipeLock = true; swipeAccum = 0; clearTimeout(swipeTimer);
  setTimeout(() => { swipeLock = false; }, 450);
}

// ---- quick-open palette ("/") --------------------------------------------
function openPalette() {
  if (!scan) return;
  closeUsage();
  $('palette').hidden = false;
  const inp = $('paletteInput'); inp.value = ''; renderPalette(''); inp.focus();
}
function closePalette() { $('palette').hidden = true; }

// Searchable entries from every angle. Each `target` is a real asset uuid, so
// picking any kind focuses an asset.
//   asset : a file (label=name, text=full path, also matchable by uuid)
//   frame : a sprite-frame inside an atlas/sheet (label=frame name) → its owner
//   usage : where an asset is used (node path · component.property · frame · click)
function buildSearchIndex() {
  const out = [];
  for (const a of scan.assets.values()) {
    out.push({ kind: 'asset', target: a.uuid, type: a.type, uuid: a.uuid, label: base(a.path), sub: dirOf(a.path) || '/', text: a.path });
    for (const sa of a.subAssets || []) {
      if (sa.kind !== 'sprite-frame' || !sa.name || sa.name === 'spriteFrame') continue; // skip the default single-png frame
      out.push({ kind: 'frame', target: a.uuid, type: a.type, label: sa.name, sub: base(a.path), text: sa.name });
    }
  }
  const seen = new Set();
  for (const e of scan.edges) {
    if (!e.locations || !e.locations.length) continue;
    const toA = scan.assets.get(e.to); const fromA = scan.assets.get(e.from);
    if (!toA || !fromA) continue;
    for (const l of e.locations) {
      const comp = l.component ? compName(l.component) : '';
      const np = l.nodePath || ''; const prop = l.property || '';
      const text = [np, comp, prop, l.subName].filter(Boolean).join(' ');
      if (!text) continue;
      const key = `${e.to}|${np}|${comp}|${prop}`;
      if (seen.has(key)) continue; seen.add(key);
      out.push({ kind: 'usage', target: e.to, type: toA.type, label: np || prop || comp, sub: `${base(toA.path)} ← ${base(fromA.path)}`, text });
    }
  }
  return out;
}
// Subsequence (fuzzy) score, with word-boundary and consecutive-run bonuses;
// stays well below the substring scores so exact hits always rank first.
function subseqScore(q, t) {
  let ti = 0, score = 0, prev = -2;
  for (let i = 0; i < q.length; i++) {
    const f = t.indexOf(q[i], ti);
    if (f < 0) return -1;
    let s = 1;
    if (f === 0 || '/_-. '.includes(t[f - 1])) s += 5;
    if (f === prev + 1) s += 3;
    score += s; prev = f; ti = f + 1;
  }
  return score;
}
function matchScore(q, t) { // higher = better; -1 = no match. q already lowercased.
  if (!q) return 0;
  t = t.toLowerCase();
  const idx = t.indexOf(q);
  if (idx === 0) return 1000 - t.length;                                            // prefix
  if (idx > 0) return ('/_-. '.includes(t[idx - 1]) ? 700 : 500) - idx - t.length * 0.1; // substring
  return subseqScore(q, t);                                                          // subsequence
}
// Like matchScore but returns the matched character indices in `t` (for
// highlighting). Prefers a contiguous substring; else the greedy subsequence.
function fuzzyMatch(q, t) {
  if (!q) return { pos: [] };
  const tl = t.toLowerCase();
  if (tl.includes(q)) { // highlight EVERY substring occurrence (e.g. ".prefab" in the name AND "/prefab/" in the dir)
    const pos = [];
    for (let idx = tl.indexOf(q); idx !== -1; idx = tl.indexOf(q, idx + q.length)) {
      for (let i = 0; i < q.length; i++) pos.push(idx + i);
    }
    return { pos };
  }
  let ti = 0; const pos = []; // subsequence fallback (cross-field, e.g. "dd")
  for (let i = 0; i < q.length; i++) {
    const f = tl.indexOf(q[i], ti);
    if (f < 0) return null;
    pos.push(f); ti = f + 1;
  }
  return { pos };
}
// Wrap the matched indices of `str` in <b class="hl"> (bold + accent), escaping
// the rest. Contiguous matched runs share one tag.
function hlText(str, pos) {
  if (!pos || !pos.length) return esc(str);
  const set = new Set(pos);
  let out = '', run = false;
  for (let i = 0; i < str.length; i++) {
    const m = set.has(i);
    if (m && !run) { out += '<b class="hl">'; run = true; }
    else if (!m && run) { out += '</b>'; run = false; }
    out += esc(str[i]);
  }
  return out + (run ? '</b>' : '');
}

const PALETTE_SCOPES = { '@': 'frame', '#': 'type', '>': 'usage' };
function renderPalette(raw) {
  if (!searchIndex) searchIndex = buildSearchIndex();
  raw = (raw || '').trim();
  let scope = null, q = raw.toLowerCase();
  if (raw && PALETTE_SCOPES[raw[0]]) { scope = PALETTE_SCOPES[raw[0]]; q = raw.slice(1).trim().toLowerCase(); }
  const uuidish = !scope && /^[0-9a-f-]{4,}$/i.test(q);

  let items;
  if (!q && !scope) {
    items = searchIndex.filter((e) => e.kind === 'asset').slice(0, 100); // empty query → assets
  } else {
    const scored = [];
    for (const e of searchIndex) {
      if (scope === 'frame' && e.kind !== 'frame') continue;
      if (scope === 'usage' && e.kind !== 'usage') continue;
      if (scope === 'type') { // '#': filter assets by type
        if (e.kind !== 'asset') continue;
        const sc = matchScore(q, e.type);
        if (sc >= 0) scored.push([sc, e]);
        continue;
      }
      if (!scope && e.kind === 'usage') continue; // usage only via '>'
      let sc = matchScore(q, e.label);
      if (e.kind === 'asset') sc = Math.max(sc, matchScore(q, e.text)); // also full path
      if (uuidish && e.kind === 'asset' && e.uuid.toLowerCase().includes(q)) sc = Math.max(sc, 900);
      if (sc < 0) continue;
      if (e.kind === 'frame') sc -= 0.5; // assets edge out frames on a tie
      scored.push([sc, e]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    items = scored.slice(0, 100).map((x) => x[1]);
  }

  paletteItems = items; paletteIdx = 0;
  const tag = (e) => e.kind === 'frame' ? `<span class="ptag">${esc(t('palette.tagFrame'))}</span>`
    : e.kind === 'usage' ? `<span class="ptag">${esc(t('palette.tagUsage'))}</span>` : '';
  // Highlight matched chars (VSCode-style). For assets the match is on the full
  // path, split back onto the displayed dir + name; frames/usage match the label.
  const hlOf = (e) => {
    if (!q || scope === 'type') return { L: esc(e.label), S: esc(e.sub) };
    if (e.kind === 'asset') {
      const m = fuzzyMatch(q, e.text);
      if (!m) return { L: esc(e.label), S: esc(e.sub) };
      const dirLen = e.sub === '/' ? 0 : e.sub.length;
      return {
        L: hlText(e.label, m.pos.filter((p) => p >= dirLen).map((p) => p - dirLen)),
        S: e.sub === '/' ? '/' : hlText(e.sub, m.pos.filter((p) => p < dirLen)),
      };
    }
    const m = fuzzyMatch(q, e.label);
    return { L: m ? hlText(e.label, m.pos) : esc(e.label), S: esc(e.sub) };
  };
  const clo = (e) => { // ← 被依賴∑ (blast radius) · → 依賴∑ (bundle); a 0 side is omitted
    const n = closureByUuid.get(e.target);
    const cin = n ? n.cin : 0, cout = n ? n.cout : 0;
    const parts = [];
    if (cin) parts.push(`<i>←</i>${cin}`);
    if (cout) parts.push(`<i>→</i>${cout}`);
    if (!parts.length) return '<span class="pclo"></span>'; // keep the column width for alignment
    return `<span class="pclo" title="${esc(t('palette.clo', { cin, cout }))}">${parts.join(' ')}</span>`;
  };
  $('paletteList').innerHTML = items.map((e, i) => {
    const { L, S } = hlOf(e);
    return `<div class="pitem${i === 0 ? ' on' : ''}" data-uuid="${e.target}">` +
      `<span class="dot" style="background:${typeColor(e.type)}"></span>` +
      `<span class="pnm">${L}</span>${tag(e)}` +
      `<span class="pdir" title="${esc(e.sub)}">${S}</span>${clo(e)}</div>`;
  }).join('') || `<div class="empty">${esc(t('palette.empty'))}</div>`;
  for (const el of $('paletteList').querySelectorAll('.pitem')) el.onclick = () => pickPalette(el.dataset.uuid);
  $('paletteList').scrollTop = 0; // new query resets selection to item 0 → scroll it back into view
}
function movePalette(d) {
  if (!paletteItems.length) return;
  paletteIdx = (paletteIdx + d + paletteItems.length) % paletteItems.length;
  const els = $('paletteList').querySelectorAll('.pitem');
  els.forEach((e, i) => e.classList.toggle('on', i === paletteIdx));
  if (els[paletteIdx]) els[paletteIdx].scrollIntoView({ block: 'nearest' });
}
function pickPalette(uuid) { closePalette(); if (scan && scan.assets.has(uuid)) focus(uuid); }

// ---- 報告 -----------------------------------------------------------------
function refRow(uuid, path, type, right) {
  return `<div class="ref" data-uuid="${uuid}"><span class="dot" style="background:${typeColor(type)}"></span>` +
    `<span class="nm">${esc(base(path))}</span><span class="rdir" title="${esc(dirOf(path))}">${esc(dirOf(path) || '/')}</span>` +
    `<span class="meta">${right || ''}</span></div>`;
}
// Every report respects the ONE global type filter (the bar under the banner).
function renderReports() {
  if (!scan) return;
  const unused = unusedReport(scan); const orphans = orphanRefReport(scan);
  const atlas = atlasUtilizationReport(scan); const size = sizeReport(scan);
  const dropped = droppedMetaReport(scan);
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

  const sizeTypes = Object.entries(size.byType).filter(([t]) => typeAllowed(t)).sort((a, b) => b[1].size - a[1].size);
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
