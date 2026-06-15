// 拓撲 tab: a bidirectional, always-fully-expanded tree rendered as a fixed
// 5-column sliding window centred on the selected node's signed offset
// (dependents fan left, dependencies fan right). Plus the nav history, keyboard
// arrows, and trackpad-swipe navigation, and `focus` (set a new centre).
import { S, $, base, esc, typeColor, COPY_ICON, CHECK_ICON, setStatus } from './state.js';
import { t } from './i18n.js';
import { renderTable } from './list.js';
import { setTab } from './ui.js';
import { showUsage, positionUsage } from './usage.js';
import { copyToClipboard } from './copy.js';

// ---- in-topo find (Ctrl/⌘+F) state ----------------------------------------
// Virtualization keeps off-screen cells out of the DOM, so the browser's native
// find can't see them. This searches the tree's cell DATA instead and scrolls /
// highlights matches. (Scope: cells in the shown columns — what you can reach by
// scrolling; deeper nodes are a re-centre via "/".)
let findActive = false;
let findMatches = [];    // [{ key, row, off }] over the current tree, sorted for next/prev
let findIdx = -1;
let findSet = new Set();  // match keys, for the cell-highlight lookup
let findCurKey = null;    // the current match's key (stronger highlight)
function findClass(key) { return key === findCurKey ? ' find-cur' : findSet.has(key) ? ' find-hit' : ''; }

// The topo bar's filter query (prunes the tree to matching nodes + the path back
// to the centre); lower-cased, '' when empty. Separate from the find overlay.
function topoFilterText() { const inp = $('topoFilterInput'); return inp ? inp.value.trim().toLowerCase() : ''; }

// ---- selected-node path highlight ------------------------------------------
// The chain root → selection (its ancestors) plus the selection's direct
// children, so the connection between the centre and the selection is visible
// at a glance: cells get .onpath/.kid and the SVG connectors on it get .hot.
let pathSet = new Set();   // keys on the chain root → selection (inclusive)
let childSet = new Set();  // keys of the selection's direct children
// The tree-parent of a cell key. A depth-1 key is `side:rootUuid>child`; its
// stripped prefix `side:rootUuid` has no '>' → it maps back to the real root cell.
function parentKeyOf(key) {
  if (!key || key === S.treeRoot) return null;
  const i = key.lastIndexOf('>');
  if (i < 0) return null;
  const pk = key.slice(0, i);
  return pk.includes('>') ? pk : S.treeRoot;
}
function computeSelPath() {
  pathSet = new Set(); childSet = new Set();
  if (!S.treeRoot) return;
  const sel = S.selectedKey || S.treeRoot;
  for (let k = sel; k && k !== S.treeRoot; k = parentKeyOf(k)) pathSet.add(k);
  pathSet.add(S.treeRoot);
  for (const c of S.lastCells) if (parentKeyOf(c.key) === sel) childSet.add(c.key);
}

// A node's neighbours (the topology shows the TRUE structure; the 清單 type
// badges filter only the list, not the tree).
function neighborsOf(uuid, dir) {
  const list = dir === 'out' ? (S.adj.out.get(uuid) || []) : (S.adj.inc.get(uuid) || []);
  const m = new Map();
  for (const n of list) {
    const other = dir === 'out' ? n.to : n.from;
    if (S.scan.assets.has(other) && !m.has(other)) m.set(other, true);
  }
  return m;
}
function sortByTypeName(a, b) {
  const ax = S.scan.assets.get(a), ay = S.scan.assets.get(b);
  return (ax.type).localeCompare(ay.type) || base(ax.path).localeCompare(base(ay.path));
}

// ---- navigation history (Delete/Backspace = back; − / + step) -------------
function pushNav() {
  if (!S.treeRoot) return;
  const top = S.navHistory[S.navHistory.length - 1];
  if (top && top.treeRoot === S.treeRoot && top.selectedKey === S.selectedKey) return; // skip no-op
  S.navHistory.push({ treeRoot: S.treeRoot, selectedKey: S.selectedKey });
  if (S.navHistory.length > 200) S.navHistory.shift();
  S.navForward = []; // a new navigation invalidates the forward stack
}
function applyNav(s) {
  S.treeRoot = s.treeRoot; S.selectedKey = s.selectedKey;
  renderTable(); renderTopo();
  const a = S.scan.assets.get(selectedUuid());
  if (a) setStatus(a.path);
}
export function goBack() {    // − 上一動
  if (S.tab !== 'topo' || !S.navHistory.length) return;
  S.navForward.push({ treeRoot: S.treeRoot, selectedKey: S.selectedKey });
  applyNav(S.navHistory.pop());
}
export function goForward() { // + 下一動
  if (S.tab !== 'topo' || !S.navForward.length) return;
  S.navHistory.push({ treeRoot: S.treeRoot, selectedKey: S.selectedKey });
  applyNav(S.navForward.pop());
}
export function focus(uuid) {
  pushNav();            // remember the current centre/selection before re-centring
  S.treeRoot = uuid; S.selectedKey = uuid;
  renderTable();        // highlight the chosen row in 清單
  setTab('topo');       // switch to the tree and render (centres the root)
  const a = S.scan.assets.get(uuid); // 提示中心節點的完整路徑
  if (a) setStatus(a.path);
}

// ---- build one side of the tree (filtered to branches reaching a type) ----
function buildSide(rootUuid, dir, side, maxDepth) {
  const types = S.selectedTypes;
  const fq = topoFilterText();
  const filtering = types.size > 0 || !!fq; // type filter and/or the bar's text filter
  const nodeMatch = (uuid) => {
    const a = S.scan.assets.get(uuid);
    if (!a) return false;
    if (types.size && !types.has(a.type)) return false;
    if (fq && !a.path.toLowerCase().includes(fq)) return false;
    return true;
  };
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
    const match = !filtering || nodeMatch(uuid);
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
// Among same-name siblings, the shortest path part that tells them apart.
function distinguishingDirs(paths) {
  const segs = paths.map((p) => p.split('/'));
  const minLen = Math.min(...segs.map((s) => s.length));
  let pre = 0;
  while (pre < minLen - 1 && segs.every((s) => s[pre] === segs[0][pre])) pre++;
  let suf = 0;
  while (suf < minLen - 1 - pre && segs.every((s) => s[s.length - 1 - suf] === segs[0][segs[0].length - 1 - suf])) suf++;
  return segs.map((s) => s.slice(pre, s.length - suf).join('/'));
}
// Tag each cell with `.dir` when its basename collides with a sibling.
function tagSiblingDirs(cells) {
  const byParent = new Map();
  for (const c of cells) {
    c.dir = null;
    const pk = c.key.slice(0, c.key.lastIndexOf('>'));
    if (!byParent.has(pk)) byParent.set(pk, []);
    byParent.get(pk).push(c);
  }
  for (const sibs of byParent.values()) {
    const byBase = new Map();
    for (const c of sibs) {
      const a = S.scan.assets.get(c.uuid);
      const b = a ? base(a.path) : c.uuid;
      if (!byBase.has(b)) byBase.set(b, []);
      byBase.get(b).push(c);
    }
    for (const group of byBase.values()) {
      if (group.length < 2) continue;
      const dirs = distinguishingDirs(group.map((c) => { const a = S.scan.assets.get(c.uuid); return a ? a.path : c.uuid; }));
      group.forEach((c, i) => { c.dir = dirs[i]; });
    }
  }
}
function cellHtml(c, col) {
  const a = S.scan.assets.get(c.uuid);
  const sym = c.cycle ? '↻' : c.hasKids ? (c.side === 'L' ? '◂' : '▸') : '';
  const dh = c.dir ? `<span class="cdh" style="opacity:.5;margin-left:.35em;font-size:.82em">${esc(c.dir)}</span>` : '';
  return `<div class="cell ${c.side === 'L' ? 'left' : 'right'}${pathSet.has(c.key) ? ' onpath' : ''}${childSet.has(c.key) ? ' kid' : ''}${c.key === S.selectedKey ? ' sel' : ''}${findClass(c.key)}"` +
    ` data-key="${esc(c.key)}" data-uuid="${c.uuid}" data-side="${c.side}"` +
    ` title="${esc(a ? a.path : c.uuid)}" style="grid-column:${col};grid-row:${c.row + 1}">` +
    `<span class="tw">${sym}</span><span class="dot" style="background:${typeColor(a ? a.type : 'orphan')}"></span>` +
    `<span class="cnm">${esc(a ? base(a.path) : c.uuid.slice(0, 10) + '…')}${dh}</span>` +
    (a ? `<button class="cell-copy" type="button" title="${esc(t('topo.copyPath'))}" data-copy="${esc(a.path)}">${COPY_ICON}</button>` : '') +
    `</div>`;
}
// signed offset of a selected key (層0=0, 依賴=+depth, 被依賴=-depth)
export function offsetOfKey(key) {
  if (!key || key === S.treeRoot) return 0;
  const depth = key.split('>').length - 1;
  return key[0] === 'L' ? -depth : depth;
}
const ROW_H = 30; // .tree's grid-auto-rows — MUST match the CSS; exact row math for virtualization
let paintScheduled = false;

// Adaptive vertical padding: exactly enough that ANY row can scroll to the
// viewport centre (viewport/2 − row/2). Short trees end up centred with no
// excess scroll-into-void; tall trees can still centre their first/last rows.
function setAdaptivePad(tb) {
  tb.querySelector('.tree').style.paddingBlock = `${Math.max(0, tb.clientHeight / 2 - ROW_H / 2)}px`;
}

// The layer-0 (centre) cell — always row 0.
function rootCellHtml(col) {
  const a = S.scan.assets.get(S.treeRoot);
  return `<div class="cell root${pathSet.has(S.treeRoot) ? ' onpath' : ''}${S.selectedKey === S.treeRoot ? ' sel' : ''}${findClass(S.treeRoot)}" data-key="${esc(S.treeRoot)}" data-uuid="${S.treeRoot}"` +
    ` title="${esc(a ? a.path : S.treeRoot)}" style="grid-column:${col};grid-row:1">` +
    `<span class="dot" style="background:${typeColor(a ? a.type : 'orphan')}"></span><span class="cnm">${esc(a ? base(a.path) : S.treeRoot)}</span>` +
    (a ? `<button class="cell-copy" type="button" title="${esc(t('topo.copyPath'))}" data-copy="${esc(a.path)}">${COPY_ICON}</button>` : '') +
    `</div>`;
}
// Build the tree for the current centre/selection/filter, cache it in S.topo,
// render the column header + scroll shell (handlers bound ONCE via delegation),
// centre the selected row, then paint only the visible rows. buildSide runs once
// per centre/select; scrolling re-paints (cheap) without rebuilding.
export function renderTopo() {
  if (!S.scan) return;
  const bar = $('topobar');
  if (!S.treeRoot) { $('topo').innerHTML = `<div class="colhint">${esc(t('topo.hint'))}</div>`; S.topo = null; if (bar) bar.hidden = true; renderCrumb(); return; }
  if (bar) bar.hidden = false;
  const viewOffset = offsetOfKey(S.selectedKey);
  const lo = viewOffset - 2, hi = viewOffset + 2;
  const DEEP = 24;
  const deep = S.selectedTypes.size || topoFilterText(); // any filter ⇒ build deep so distant matches survive the prune
  const right = buildSide(S.treeRoot, 'out', 'R', deep ? DEEP : hi);
  const left = buildSide(S.treeRoot, 'in', 'L', deep ? DEEP : 2 - viewOffset);
  S.lastCells = [...left, ...right];
  tagSiblingDirs(S.lastCells); // disambiguate same-name siblings (append distinguishing dir)
  computeSelPath();            // highlight sets for the selection's chain + children
  const inWin = (off) => off >= lo && off <= hi;
  let maxRow = 0;
  for (const c of S.lastCells) if (inWin(c.side === 'L' ? -c.depth : c.depth)) maxRow = Math.max(maxRow, c.row);
  S.topo = { left, right, lo, hi, maxRow };

  // column header — counts use the full sides (cheap, not virtualized)
  const cnt = (cells, d) => cells.filter((c) => c.depth === d).length;
  const lyr = t('topo.layer');
  let head = '<div class="topohead">';
  for (let gc = 1; gc <= 5; gc++) {
    const off = lo + (gc - 1);
    const label = off === 0 ? '' : off > 0 ? `<i>→</i>${lyr}${off}` : `<i>←</i>${lyr}${-off}`;
    const count = off === 0 ? '' : off > 0 ? cnt(right, off) : cnt(left, -off);
    head += `<div class="th${off === 0 ? ' center' : ''}">${label}${count !== '' ? `<span class="thc">${count}</span>` : ''}</div>`;
  }
  head += '</div>';
  $('topo').innerHTML = `${head}<div class="treebody"><div class="tree"></div></div>`;

  const tb = $('topo').querySelector('.treebody');
  // Event delegation (bound once per build, NOT per painted cell — cells come and
  // go as you scroll): single-click selects (200ms vs dblclick), double-click
  // re-centres, the hover copy button copies the full path.
  tb.onclick = (e) => {
    const cb = e.target.closest('.cell-copy');
    if (cb) {
      e.stopPropagation();
      copyToClipboard(cb.dataset.copy, () => {
        cb.innerHTML = CHECK_ICON; cb.classList.add('ok');
        setTimeout(() => { cb.innerHTML = COPY_ICON; cb.classList.remove('ok'); }, 1200);
        setStatus(t('copy.named', { name: cb.dataset.copy }));
      });
      return;
    }
    const cell = e.target.closest('.cell');
    if (cell) { clearTimeout(S.cellClickTimer); const key = cell.dataset.key; S.cellClickTimer = setTimeout(() => selectTopoKey(key), 200); }
  };
  tb.ondblclick = (e) => { const cell = e.target.closest('.cell'); if (cell) { clearTimeout(S.cellClickTimer); focus(cell.dataset.uuid); } };
  tb.onscroll = () => { if (paintScheduled) return; paintScheduled = true; requestAnimationFrame(() => { paintScheduled = false; paintTopo(); }); };

  setAdaptivePad(tb); // size the padding to this viewport BEFORE painting (paint/centre read it)
  if (findActive) { computeFindMatches($('topoFindInput').value); pickFindIdx(); updateFindCount(); } // rebuild ⇒ refresh find highlights (no scroll yank; centreSelected drives scroll)
  paintTopo();        // first paint (at scrollTop 0) — its spacer establishes the full scroll height…
  centerSelected(tb); // …so this scroll-to-centre isn't clamped to an empty .tree, then…
  paintTopo();        // …repaint for the centred position
  showUsage(); // auto-show the "used where" info for the selected ↔ parent edge
  renderCrumb(); // breadcrumb root → selection (right side of the topo bar)
}
// The selection's chain, ALWAYS ordered 被依賴 → 依賴 (left = dependents, right =
// dependencies) by signed offset, so the breadcrumb's orientation is fixed and
// never flips to 依賴 → 被依賴 regardless of which side the selection is on.
function crumbKeys() {
  if (!S.treeRoot) return [];
  const sel = S.selectedKey || S.treeRoot;
  const keys = [];
  for (let k = sel; k && k !== S.treeRoot; k = parentKeyOf(k)) keys.push(k);
  keys.push(S.treeRoot);
  keys.sort((a, b) => offsetOfKey(a) - offsetOfKey(b)); // fixed orientation (−被依賴 … +依賴)
  return keys;
}
const crumbUuid = (key) => (key === S.treeRoot ? S.treeRoot : key.split('>').pop());
// Breadcrumb of the selection's chain; each crumb re-selects (and re-centres on) that node.
function renderCrumb() {
  const el = $('topoCrumb');
  if (!el) return;
  const sel = S.selectedKey || S.treeRoot;
  const keys = crumbKeys();
  const nameOf = (key) => {
    const a = S.scan.assets.get(crumbUuid(key));
    return a ? base(a.path) : `${crumbUuid(key).slice(0, 10)}…`;
  };
  const crumb = (key) => `<button class="cr${key === sel ? ' cur' : ''}" type="button" data-key="${esc(key)}" title="${esc(nameOf(key))}">${esc(nameOf(key))}</button>`;
  const SEP = '<span class="crsep">›</span>';
  const MAX = 7;
  if (keys.length > MAX) { // keep both extremes (selection sits at one of them)
    const tail = keys.slice(keys.length - (MAX - 2)).map(crumb).join(SEP);
    el.innerHTML = `${crumb(keys[0])}${SEP}<span class="crsep">…</span>${SEP}${tail}`;
  } else {
    el.innerHTML = keys.map(crumb).join(SEP);
  }
}
// Copy the whole chain (被依賴 → 依賴) as full asset paths — the fixed copy button beside the breadcrumb.
export function copyCrumbChain() {
  const keys = crumbKeys();
  if (!keys.length) return;
  const txt = keys.map((key) => { const a = S.scan.assets.get(crumbUuid(key)); return a ? a.path : crumbUuid(key); }).join('\n');
  const btn = $('topoCrumbCopy');
  copyToClipboard(txt, () => {
    if (btn) { btn.innerHTML = CHECK_ICON; btn.classList.add('ok'); setTimeout(() => { btn.innerHTML = COPY_ICON; btn.classList.remove('ok'); }, 1200); }
    setStatus(t('copy.chain', { n: keys.length }));
  });
}
// Re-fit the padding + re-centre + repaint without rebuilding the tree — for
// window resize, where the viewport (and thus the centring padding) changed.
export function reflowTopo() {
  const tb = $('topo').querySelector('.treebody');
  if (!tb || !S.topo) return;
  setAdaptivePad(tb);
  centerSelected(tb);
  paintTopo();
}

// ---- in-topo find (Ctrl/⌘+F) ----------------------------------------------
export function openTopoFind() { // Ctrl/⌘+F — the floating find overlay (top-right of the tree)
  if (!S.treeRoot) return;
  findActive = true;
  $('topoFind').hidden = false;
  const inp = $('topoFindInput');
  inp.focus(); inp.select();
  runTopoFind(); // re-run any retained query
}
export function closeTopoFind() {
  if (!findActive) return;
  findActive = false; findMatches = []; findIdx = -1; findSet = new Set(); findCurKey = null;
  $('topoFind').hidden = true;
  if (S.topo) paintTopo(); // drop the highlights
}
// Clear the bar's text filter (and rebuild the now-unpruned tree). Esc / ✕.
export function clearTopoFilter() {
  const inp = $('topoFilterInput');
  if (!inp) return;
  if (!inp.value) { inp.blur(); return; }
  inp.value = '';
  if (S.treeRoot) renderTopo();
}
// Gather matches over the current tree (shown columns only — those are reachable
// by scrolling; the root counts as row 0).
function computeFindMatches(raw) {
  findMatches = []; findSet = new Set();
  const q = (raw || '').trim().toLowerCase();
  if (!q || !S.topo) return;
  const { left, right, lo, hi } = S.topo;
  const inWin = (off) => off >= lo && off <= hi;
  const add = (key, uuid, row, off) => {
    if (!inWin(off)) return;
    const a = S.scan.assets.get(uuid);
    if ((a ? a.path : uuid).toLowerCase().includes(q)) { findMatches.push({ key, row, off }); findSet.add(key); }
  };
  add(S.treeRoot, S.treeRoot, 0, 0);
  for (const c of left) add(c.key, c.uuid, c.row, -c.depth);
  for (const c of right) add(c.key, c.uuid, c.row, c.depth);
  findMatches.sort((a, b) => a.row - b.row || a.off - b.off);
}
// After (re)computing matches, keep the same match selected if it survives, else
// fall back to the one nearest the viewport centre.
function pickFindIdx() {
  if (!findMatches.length) { findIdx = -1; findCurKey = null; return; }
  let i = findCurKey ? findMatches.findIndex((m) => m.key === findCurKey) : -1;
  if (i < 0) i = nearestMatchIdx();
  findIdx = i; findCurKey = findMatches[i].key;
}
function nearestMatchIdx() {
  const tb = $('topo').querySelector('.treebody');
  if (!tb || !findMatches.length) return 0;
  const padTop = parseFloat(getComputedStyle(tb.querySelector('.tree')).paddingTop) || 0;
  const centerRow = (tb.scrollTop + tb.clientHeight / 2 - padTop) / ROW_H;
  let best = 0, bd = Infinity;
  findMatches.forEach((m, i) => { const d = Math.abs(m.row - centerRow); if (d < bd) { bd = d; best = i; } });
  return best;
}
function updateFindCount() {
  const el = $('topoFindCount'); if (!el) return;
  const typed = !!$('topoFindInput').value.trim();
  el.textContent = findMatches.length ? t('topo.findCount', { cur: findIdx + 1, total: findMatches.length }) : (typed ? t('topo.findNone') : '');
  $('topoFindInput').classList.toggle('nomatch', typed && !findMatches.length);
}
function jumpToCurrent() {
  const m = findMatches[findIdx];
  if (!m) { if (S.topo) paintTopo(); return; }
  findCurKey = m.key;
  const tb = $('topo').querySelector('.treebody');
  if (tb) scrollRowToCenter(tb, m.row);
  paintTopo();
  updateFindCount();
}
export function runTopoFind() { // on input: recompute, jump to the nearest/kept match
  computeFindMatches($('topoFindInput').value);
  pickFindIdx();
  if (findIdx >= 0) jumpToCurrent(); else { updateFindCount(); if (S.topo) paintTopo(); }
}
export function topoFindStep(dir) { // Enter / ↑↓ : next / prev match
  if (!findMatches.length) return;
  findIdx = (findIdx + dir + findMatches.length) % findMatches.length;
  jumpToCurrent();
}
export function isTopoFindActive() { return findActive; }
// Render ONLY the cells whose row is in the viewport (± buffer); a spacer one row
// past the last cell holds the full scroll height (grid-auto-rows reserves every
// implicit row). Runs on every scroll frame — keeps the DOM at ~a screenful of cells.
function paintTopo() {
  const tb = $('topo').querySelector('.treebody');
  const tree = tb && tb.querySelector('.tree');
  if (!tree || !S.topo) return;
  const { left, right, lo, hi, maxRow } = S.topo;
  const padTop = parseFloat(getComputedStyle(tree).paddingTop) || 0; // .tree's 45vh, resolved to px
  const BUF = 12;
  const rFrom = Math.max(0, Math.floor((tb.scrollTop - padTop) / ROW_H) - BUF);
  const rTo = Math.ceil((tb.scrollTop + tb.clientHeight - padTop) / ROW_H) + BUF;
  const inWin = (off) => off >= lo && off <= hi;
  const gcol = (off) => off - lo + 1;
  const vis = (c, off) => inWin(off) && c.row >= rFrom && c.row <= rTo;
  // parent-row lookup for the connector overlay (full sides, so an off-screen
  // parent still anchors a visible child's line)
  const rowByKey = new Map();
  for (const c of left) rowByKey.set(c.key, c.row);
  for (const c of right) rowByKey.set(c.key, c.row);
  const cw = (tree.clientWidth || tb.clientWidth) / 5;
  const yOf = (row) => padTop + row * ROW_H + ROW_H / 2;
  const INSET = 12;
  let edges = '';
  const addEdge = (c, off) => { // a smooth parent→child connector crossing the shared column boundary
    const pk = parentKeyOf(c.key);
    const pRow = pk === S.treeRoot ? 0 : rowByKey.get(pk);
    if (pRow == null) return;
    const pY = yOf(pRow), cY = yOf(c.row);
    const bx = (c.side === 'R' ? off - lo : off - lo + 1) * cw; // boundary between parent & child columns
    const pX = c.side === 'R' ? bx - INSET : bx + INSET;
    const cX = c.side === 'R' ? bx + INSET : bx - INSET;
    const hot = pathSet.has(c.key) || childSet.has(c.key);
    edges += `<path class="${hot ? 'hot' : ''}" d="M${pX} ${pY}C${bx} ${pY} ${bx} ${cY} ${cX} ${cY}"/>`;
  };
  let body = '';
  if (inWin(0) && rFrom <= 0) body += rootCellHtml(gcol(0));
  for (const c of left) { const off = -c.depth; if (vis(c, off)) { body += cellHtml(c, gcol(off)); addEdge(c, off); } }
  for (const c of right) { const off = c.depth; if (vis(c, off)) { body += cellHtml(c, gcol(off)); addEdge(c, off); } }
  body += `<div class="vspacer" style="grid-column:1;grid-row:${maxRow + 2}"></div>`; // reserve full height
  const svgH = padTop * 2 + (maxRow + 2) * ROW_H; // pad above + below + every reserved row
  tree.innerHTML = `<svg class="edges" style="height:${svgH}px">${edges}</svg>${body}`;
  if (!$('usagePopup').hidden) positionUsage($('usagePopup')); // re-pin (or hide if its cell scrolled off)
}
function selectedRowOf() {
  if (!S.selectedKey || S.selectedKey === S.treeRoot) return 0; // the centre cell sits at row 0
  const c = S.lastCells.find((x) => x.key === S.selectedKey);
  return c ? c.row : 0;
}
function scrollRowToCenter(tb, row) {
  const padTop = parseFloat(getComputedStyle(tb.querySelector('.tree')).paddingTop) || 0;
  tb.scrollTop = Math.max(0, padTop + row * ROW_H + ROW_H / 2 - tb.clientHeight / 2);
}
function centerSelected(tb) { scrollRowToCenter(tb, selectedRowOf()); }
export function selectTopoKey(key) {
  pushNav();           // remember the current selection before moving
  S.selectedKey = key; renderTopo();
  const a = S.scan.assets.get(selectedUuid()); // 提示選中節點的完整路徑
  if (a) setStatus(a.path);
}
export function selectedUuid() {
  if (!S.treeRoot) return null;
  if (!S.selectedKey || S.selectedKey === S.treeRoot) return S.treeRoot;
  return S.selectedKey.split('>').pop();
}

// ---- shared tree navigation (keyboard arrows + trackpad swipe) -------------
export function navTree(dir) {
  if (!S.treeRoot) return;
  if (dir === 'up' || dir === 'down') {
    if (!S.selectedKey || S.selectedKey === S.treeRoot) return; // 層0 is a single cell
    const side = S.selectedKey[0];
    const depth = S.selectedKey.split('>').length - 1;
    const col = S.lastCells.filter((c) => c.side === side && c.depth === depth).sort((a, b) => a.row - b.row);
    const nx = col[col.findIndex((c) => c.key === S.selectedKey) + (dir === 'down' ? 1 : -1)];
    if (nx) selectTopoKey(nx.key);
    return;
  }
  // left/right: step one column toward 被依賴/依賴, landing on the cell in that
  // column NEAREST the current viewport centre. Computed from cell data (rows),
  // not DOM rects — under virtualization off-screen cells aren't in the DOM.
  const targetOffset = offsetOfKey(S.selectedKey) + (dir === 'right' ? 1 : -1);
  if (targetOffset === 0) { selectTopoKey(S.treeRoot); return; } // toward the centre → the root cell
  const cands = S.lastCells.filter((c) => (c.side === 'L' ? -c.depth : c.depth) === targetOffset);
  if (!cands.length) return; // no column that way → don't move
  const tb = $('topo').querySelector('.treebody');
  const padTop = tb ? parseFloat(getComputedStyle(tb.querySelector('.tree')).paddingTop) || 0 : 0;
  const centerRow = tb ? (tb.scrollTop + tb.clientHeight / 2 - padTop) / ROW_H : 0;
  let best = cands[0], bestD = Infinity;
  for (const c of cands) { const d = Math.abs(c.row - centerRow); if (d < bestD) { bestD = d; best = c; } }
  selectTopoKey(best.key);
}
export function onTopoWheel(e) {
  if (S.tab !== 'topo' || !S.treeRoot) return;
  if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return; // vertical → normal scroll
  e.preventDefault();                                   // block browser back/forward
  if (S.swipeLock) return;
  S.swipeAccum += e.deltaX;
  clearTimeout(S.swipeTimer);
  S.swipeTimer = setTimeout(() => { S.swipeAccum = 0; }, 180);
  if (S.swipeAccum <= -50) fireSwipe('left');
  else if (S.swipeAccum >= 50) fireSwipe('right');
}
function fireSwipe(dir) {
  navTree(dir);
  S.swipeLock = true; S.swipeAccum = 0; clearTimeout(S.swipeTimer);
  setTimeout(() => { S.swipeLock = false; }, 450);
}
