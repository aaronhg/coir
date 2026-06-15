// 拓撲 tab: a bidirectional, always-fully-expanded tree rendered as a fixed
// 5-column sliding window centred on the selected node's signed offset
// (dependents fan left, dependencies fan right). Plus the nav history, keyboard
// arrows, and trackpad-swipe navigation, and `focus` (set a new centre).
import { S, $, base, esc, typeColor, COPY_ICON, CHECK_ICON, setStatus } from './state.js';
import { t } from './i18n.js';
import { renderTable } from './list.js';
import { setTab } from './ui.js';
import { showUsage } from './usage.js';
import { copyToClipboard } from './copy.js';

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
  const filtering = S.selectedTypes.size > 0;
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
    const a = S.scan.assets.get(uuid);
    const match = !filtering || (a && S.selectedTypes.has(a.type));
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
  return `<div class="cell ${c.side === 'L' ? 'left' : 'right'}${c.key === S.selectedKey ? ' sel' : ''}"` +
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
export function renderTopo() {
  if (!S.scan) return;
  if (!S.treeRoot) { $('topo').innerHTML = `<div class="colhint">${esc(t('topo.hint'))}</div>`; return; }
  const viewOffset = offsetOfKey(S.selectedKey);
  const lo = viewOffset - 2, hi = viewOffset + 2;
  const DEEP = 24;
  const right = buildSide(S.treeRoot, 'out', 'R', S.selectedTypes.size ? DEEP : hi);
  const left = buildSide(S.treeRoot, 'in', 'L', S.selectedTypes.size ? DEEP : 2 - viewOffset);
  S.lastCells = [...left, ...right];
  tagSiblingDirs(S.lastCells); // disambiguate same-name siblings (append distinguishing dir)
  const inWin = (off) => off >= lo && off <= hi;
  const gcol = (off) => off - lo + 1; // 1..5
  const cnt = (cells, d) => cells.filter((c) => c.depth === d).length;

  let head = '<div class="topohead">';
  const lyr = t('topo.layer');
  for (let gc = 1; gc <= 5; gc++) {
    const off = lo + (gc - 1);
    const label = off === 0 ? '' : off > 0 ? `<i>→</i>${lyr}${off}` : `<i>←</i>${lyr}${-off}`;
    const count = off === 0 ? '' : off > 0 ? cnt(right, off) : cnt(left, -off);
    head += `<div class="th${off === 0 ? ' center' : ''}">${label}${count !== '' ? `<span class="thc">${count}</span>` : ''}</div>`;
  }
  head += '</div>';

  let body = '<div class="treebody"><div class="tree">';
  if (inWin(0)) {
    const a = S.scan.assets.get(S.treeRoot);
    body += `<div class="cell root${S.selectedKey === S.treeRoot ? ' sel' : ''}" data-key="${esc(S.treeRoot)}" data-uuid="${S.treeRoot}"` +
      ` title="${esc(a ? a.path : S.treeRoot)}" style="grid-column:${gcol(0)};grid-row:1">` +
      `<span class="dot" style="background:${typeColor(a ? a.type : 'orphan')}"></span><span class="cnm">${esc(a ? base(a.path) : S.treeRoot)}</span>` +
      (a ? `<button class="cell-copy" type="button" title="${esc(t('topo.copyPath'))}" data-copy="${esc(a.path)}">${COPY_ICON}</button>` : '') +
      `</div>`;
  }
  for (const c of left) { const off = -c.depth; if (inWin(off)) body += cellHtml(c, gcol(off)); }
  for (const c of right) { const off = c.depth; if (inWin(off)) body += cellHtml(c, gcol(off)); }
  body += '</div></div>';
  $('topo').innerHTML = head + body;
  for (const el of $('topo').querySelectorAll('.cell')) {
    const key = el.dataset.key, uuid = el.dataset.uuid;
    el.onclick = () => { clearTimeout(S.cellClickTimer); S.cellClickTimer = setTimeout(() => selectTopoKey(key), 200); };
    el.ondblclick = () => { clearTimeout(S.cellClickTimer); focus(uuid); };
  }
  for (const cb of $('topo').querySelectorAll('.cell-copy')) { // hover 顯示，複製完整路徑
    cb.onclick = (ev) => {
      ev.stopPropagation();
      copyToClipboard(cb.dataset.copy, () => {
        cb.innerHTML = CHECK_ICON; cb.classList.add('ok');
        setTimeout(() => { cb.innerHTML = COPY_ICON; cb.classList.remove('ok'); }, 1200);
        setStatus(t('copy.named', { name: cb.dataset.copy }));
      });
    };
  }
  const selEl = $('topo').querySelector('.cell.sel') || $('topo').querySelector('.cell.root');
  if (selEl) selEl.scrollIntoView({ block: 'center', inline: 'nearest' }); // 上下置中
  showUsage(); // auto-show the "used where" info for the selected ↔ parent edge
}
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
  const targetOffset = offsetOfKey(S.selectedKey) + (dir === 'right' ? 1 : -1);
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
