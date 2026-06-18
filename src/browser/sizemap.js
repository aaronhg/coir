// Size-map report: a squarified treemap of asset bytes (the visual companion to
// the "資源體積" table). Outer cells = asset types (area ∝ total bytes), inner
// cells = individual assets (area ∝ bytes) — so the biggest textures literally
// take up the most screen. Respects the global type filter. Each asset rect is
// data-uuid (the body-level click delegation focuses it) with a path+size tooltip.
//
// Image assets carry `data-img` so `hydrateSizeMap` can paint the actual texture
// thumbnail into the cell (downscaled, behind the per-cell type label). Thin gaps
// + no per-asset text labels keep it uncluttered.
import { S, $, typeColor, esc, base, kb, dirOf, setStatus } from './state.js';
import { t } from './i18n.js';
import { sizeReport, closureReport } from '../core/analyze.js';
import { typeAllowed, renderTypeFilters } from './filterbar.js';
import { squarify } from './treemap.js';
import { setCenter, focus } from './topo.js';

const DEFAULT_W = 1000, DEFAULT_H = 560; // fallback viewBox if the container isn't measured yet
const CAP = 80;            // max asset rects per type (the tail lumps into "其他")
const MINPX = 3;           // skip cells too small to see (caps the DOM)
const THUMB_MIN = 22;      // only thumbnail cells at least this big (viewBox units)
const GAP = 0.75;          // half-gap between cells (thin, soft)
const DIM = 0.6;           // darken type colours so cells aren't too bright

const SVG_NS = 'http://www.w3.org/2000/svg';
const r3 = (n) => Math.round(n * 10) / 10; // trim SVG coordinate noise
const MAXF = 11; // filename font cap (viewBox units) so big cells aren't shouty
// Darken a #rrggbb toward black by factor f (keeps the hue).
function dim(hex, f = DIM) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  if (!m) return hex;
  const c = (i) => Math.round(parseInt(m[i], 16) * f).toString(16).padStart(2, '0');
  return `#${c(1)}${c(2)}${c(3)}`;
}

// A filename label sized to fit the cell (full name, no truncation) — tiny on a
// small cell, magnified to readability by pinch-zoom. Skips microscopic cells.
function nameLabel(rc, nm) {
  if (rc.w < 10 || rc.h < 4) return '';
  const fs = Math.min(MAXF, rc.h * 0.55, rc.w / (nm.length * 0.52 + 0.5));
  if (fs < 1.6) return '';
  return `<text class="tmname" x="${r3(rc.x + GAP + 1.5)}" y="${r3(rc.y + GAP + fs)}" font-size="${r3(fs)}" stroke-width="${r3(fs * 0.16)}">${esc(nm)}</text>`;
}

// Build the treemap SVG for `scopeUuid`'s dependency closure (à la Unreal's Size
// Map: "what makes this thing heavy"); null scope → whole project. `filter` keeps
// only cells whose path contains it. Returns `{ svg, total, count }` so the bar
// can show the total. The root's own file is added since closureReport strips it.
export function sizeMapBody(scan, scopeUuid, filter = '', vw = DEFAULT_W, vh = DEFAULT_H) {
  const W = Math.max(50, Math.round(vw)), H = Math.max(50, Math.round(vh)); // viewBox = the container's px, so it fills it
  let src;
  if (scopeUuid && scan.assets.has(scopeUuid)) {
    const r = scan.assets.get(scopeUuid);
    src = [{ uuid: r.uuid, path: r.path, type: r.type, size: r.size || 0 }, ...closureReport(scan, scopeUuid).items];
  } else {
    src = sizeReport(scan).items;
  }
  const fq = filter.trim().toLowerCase();
  const items = src.filter((i) => typeAllowed(i.type) && (i.size || 0) > 0 && (!fq || i.path.toLowerCase().includes(fq)));
  const total = items.reduce((s, i) => s + (i.size || 0), 0);
  if (!items.length) return { svg: `<div class="empty">${esc(t('rep.none'))}</div>`, total: 0, count: 0 };

  const byType = new Map();
  for (const i of items) { let g = byType.get(i.type); if (!g) byType.set(i.type, (g = { type: i.type, size: 0, items: [] })); g.size += i.size; g.items.push(i); }
  const groups = [...byType.values()].sort((a, b) => b.size - a.size);

  const outer = squarify(groups.map((g) => ({ item: g, area: (g.size * W * H) / total })), 0, 0, W, H);
  let cells = ''; // backdrops + asset rects (+ filenames / others labels)
  for (const cell of outer) {
    const g = cell.item;
    const col = typeColor(g.type);
    cells += `<rect x="${r3(cell.x)}" y="${r3(cell.y)}" width="${r3(cell.w)}" height="${r3(cell.h)}" fill="${col}" fill-opacity="0.08"/>`;

    const sorted = g.items.slice().sort((a, b) => b.size - a.size);
    const shown = sorted.slice(0, CAP);
    const tail = sorted.slice(CAP);
    const data = shown.map((i) => ({ item: i, area: i.size }));
    if (tail.length) data.push({ item: { others: true, count: tail.length, size: tail.reduce((s, i) => s + i.size, 0) }, area: tail.reduce((s, i) => s + i.size, 0) });
    const innerTotal = data.reduce((s, d) => s + d.area, 0) || 1;
    const inner = squarify(data.map((d) => ({ item: d.item, area: (d.area * cell.w * cell.h) / innerTotal })), cell.x, cell.y, cell.w, cell.h);
    for (const rc of inner) {
      if (rc.w < MINPX || rc.h < MINPX) continue;
      const it = rc.item;
      const x = r3(rc.x + GAP), y = r3(rc.y + GAP), bw = r3(Math.max(0, rc.w - 2 * GAP)), bh = r3(Math.max(0, rc.h - 2 * GAP));
      if (it.others) { // the tail of small files, aggregated — label it so it doesn't read as a void
        cells += `<rect class="tmother" x="${x}" y="${y}" width="${bw}" height="${bh}" rx="2" fill="${dim(col)}" fill-opacity="0.55"><title>${esc(t('sizemap.others', { n: it.count, size: kb(it.size) }))}</title></rect>`;
        if (rc.w > 56 && rc.h > 22) cells += `<text class="tmotherl" x="${r3(rc.x + rc.w / 2)}" y="${r3(rc.y + rc.h / 2)}" text-anchor="middle" dominant-baseline="middle">${esc(t('sizemap.othersShort', { n: it.count }))}</text>`;
        continue;
      }
      const isImg = it.type === 'image' && rc.w >= THUMB_MIN && rc.h >= THUMB_MIN;
      const img = isImg ? ` data-img="${esc(it.path)}"` : '';
      cells += `<rect class="tmrect" data-uuid="${esc(it.uuid)}"${img} x="${x}" y="${y}" width="${bw}" height="${bh}" rx="1.5" fill="${dim(col)}" fill-opacity="0.95"><title>${esc(it.path)}\n${esc(kb(it.size))}</title></rect>`;
      // Filename sized to the cell — small cells get small text, so a pinch-zoom
      // magnifies it into readability (the SVG text is vector). Outlined (paint-order)
      // so it stays legible over a thumbnail. Placed right after the rect so a
      // thumbnail (injected via rect.after) sits UNDER it.
      cells += nameLabel(rc, base(it.path));
    }
  }
  return { svg: `<svg class="sizemap" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${cells}</svg>`, total, count: items.length };
}

// ---- 體積圖 tab orchestrator ----------------------------------------------
// A first-class tab (like 拓撲) sharing the centre (S.treeRoot): the map shows the
// centre's dependency closure, the bar carries a node filter + the 體積 total + a
// breadcrumb. Single-click a cell = drill (re-centre, stay here); double-click =
// jump to 拓撲; arrow keys move a cell cursor, Enter drills, −/+ step history.
export function renderSizemap() {
  if (!S.scan) return;
  S.sizemapGen = (S.sizemapGen || 0) + 1;
  const gen = S.sizemapGen;
  const scope = (S.treeRoot && S.scan.assets.has(S.treeRoot)) ? S.treeRoot : null;
  const view = $('sizemapView');
  if (!view) return;
  const { svg, total, count } = sizeMapBody(S.scan, scope, sizemapFilterText(), view.clientWidth, view.clientHeight);
  view.innerHTML = svg;
  S.sizemapTotal = total; S.sizemapCount = count; S.sizemapSel = null;
  renderSizemapBar(scope);
  renderTypeFilters(); // badges reflect the current scope母體
  const el = view.querySelector('svg.sizemap');
  if (el) {
    attachSizemapZoom(el, drillCell, jumpToTopo);
    el.addEventListener('mouseover', (e) => { const r = e.target.closest('[data-uuid]'); if (r) updateSelInfo(r.dataset.uuid); }); // live readout
    el.addEventListener('mouseleave', () => updateSelInfo(S.sizemapSel));
  }
  if (S.provider) hydrateSizeMap(view, S.provider, () => S.sizemapGen === gen);
}

function sizemapFilterText() { const i = $('smFilterInput'); return i ? i.value : ''; }

// Bar (right side): [selected name + size ·] centre-name total · n 項 · 複製 · 回最上層.
function renderSizemapBar(scope) {
  const cur = scope ? S.scan.assets.get(scope) : null;
  const cenName = cur ? base(cur.path) : t('sizemap.all');
  const sc = $('smScope');
  sc.textContent = `${cenName} ${kb(S.sizemapTotal || 0)} · ${t('sizemap.nItems', { n: S.sizemapCount || 0 })}`;
  sc.title = cur ? cur.path : '';
  $('smCopy').hidden = !cur;  // copy / 回最上層 only make sense when scoped
  $('smHome').hidden = !cur;
  updateSelInfo(S.sizemapSel);
}
// The selected/hovered cell's name + size (left of the centre info). '' clears it.
function updateSelInfo(uuid) {
  const a = uuid && S.scan.assets.get(uuid);
  const el = $('smSel');
  if (el) el.textContent = a ? `${base(a.path)} ${kb(a.size || 0)} ·` : '';
}

// drill (single click): re-centre on an asset that HAS deps but STAY in 體積圖; a
// leaf (or the current centre) just gets selected/highlighted (double-click jumps).
function drillCell(uuid) {
  const a = S.scan.assets.get(uuid);
  if (a && a.out > 0 && uuid !== S.treeRoot) { setCenter(uuid); renderSizemap(); }
  else { S.sizemapSel = uuid; highlightSel(); }
}
// jump (double click): re-centre AND switch to 拓撲 to see the tree.
function jumpToTopo(uuid) { focus(uuid); }

// Keyboard cell cursor: arrows move to the nearest cell centre in that direction,
// Enter drills into the highlighted cell. Cells are read straight from the SVG.
function sizemapCells() {
  const view = $('sizemapView'); if (!view) return [];
  return [...view.querySelectorAll('rect[data-uuid]')].map((r) => ({
    uuid: r.dataset.uuid, el: r,
    cx: +r.getAttribute('x') + +r.getAttribute('width') / 2,
    cy: +r.getAttribute('y') + +r.getAttribute('height') / 2,
  }));
}
function highlightSel() {
  const view = $('sizemapView'); if (!view) return;
  for (const e of view.querySelectorAll('.tmsel')) e.classList.remove('tmsel');
  updateSelInfo(S.sizemapSel);
  if (!S.sizemapSel) return;
  const el = view.querySelector(`rect[data-uuid="${cssEsc(S.sizemapSel)}"]`);
  if (el) {
    el.classList.add('tmsel');
    el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    const a = S.scan.assets.get(S.sizemapSel); if (a) setStatus(a.path);
  }
}
const cssEsc = (s) => String(s).replace(/["\\]/g, '\\$&');
export function sizemapMove(dir) {
  const cells = sizemapCells(); if (!cells.length) return;
  const cur = cells.find((c) => c.uuid === S.sizemapSel);
  if (!cur) { S.sizemapSel = cells[0].uuid; highlightSel(); return; }
  const want = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[dir];
  let best = null, bestScore = Infinity;
  for (const c of cells) {
    if (c === cur) continue;
    const dx = c.cx - cur.cx, dy = c.cy - cur.cy;
    const along = dx * want[0] + dy * want[1];            // distance in the chosen direction
    if (along <= 1) continue;                              // must be ahead
    const perp = Math.abs(dx * want[1] - dy * want[0]);    // lateral offset
    const score = along + perp * 2;                        // prefer straight-ahead + near
    if (score < bestScore) { bestScore = score; best = c; }
  }
  if (best) { S.sizemapSel = best.uuid; highlightSel(); }
}
export function sizemapEnter() { if (S.sizemapSel) drillCell(S.sizemapSel); }
export function sizemapClearCenter() { setCenter(null); renderSizemap(); }

// Paint texture thumbnails into the image cells (data-img), inserted right after
// each placeholder rect. When there are FEW image cells (a scoped/drill view) we
// use the **original** file (an object URL) — crisp at any pinch-zoom; with MANY
// cells (the whole-project map) we downscale to bound memory. Object URLs from the
// previous render are revoked here. Concurrency-limited; `isCurrent()` bails fast.
const ORIGINAL_MAX_CELLS = 60; // ≤ this many image cells → use full-res originals
let liveThumbUrls = [];
export async function hydrateSizeMap(root, provider, isCurrent) {
  if (!provider || !provider.file) return;
  const svg = root.querySelector('svg.sizemap');
  if (!svg) return;
  for (const u of liveThumbUrls) URL.revokeObjectURL(u); // free the previous render's originals
  liveThumbUrls = [];
  const cells = [...svg.querySelectorAll('rect[data-img]')];
  const useOriginal = cells.length <= ORIGINAL_MAX_CELLS; // few → crisp originals; many → downscaled
  let i = 0;
  const worker = async () => {
    while (i < cells.length) {
      const rect = cells[i++];
      if (!isCurrent()) return;
      let href = null;
      try {
        if (useOriginal) { href = URL.createObjectURL(await provider.file(rect.dataset.img)); liveThumbUrls.push(href); }
        else href = await thumbDataUrl(provider, rect.dataset.img);
      } catch { href = null; }
      if (!href || !isCurrent() || !rect.isConnected) continue;
      const im = document.createElementNS(SVG_NS, 'image');
      im.setAttribute('href', href);
      for (const a of ['x', 'y', 'width', 'height']) im.setAttribute(a, rect.getAttribute(a));
      im.setAttribute('preserveAspectRatio', 'xMidYMid meet'); // contain: whole image fits in the cell (no crop)
      im.setAttribute('data-uuid', rect.dataset.uuid);
      im.classList.add('tmimg');
      rect.after(im); // on top of the placeholder colour, under the label chips
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, cells.length) }, worker));
}

// Two-finger pinch (trackpad ctrl+wheel) zooms the treemap toward the cursor by
// shrinking the SVG viewBox; drag pans; double-click resets. Aspect is locked so
// cells never distort, and the view is clamped to the map bounds. A real drag
// suppresses the trailing click so panning never accidentally focuses an asset.
export function attachSizemapZoom(svg, onPick, onJump) {
  const vb = svg.viewBox.baseVal;
  const W = vb.width || DEFAULT_W, H = vb.height || DEFAULT_H; // the actual viewBox (= container px)
  const view = { x: 0, y: 0, w: W, h: H };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const apply = () => {
    view.h = view.w * (H / W);                 // lock aspect
    view.x = clamp(view.x, 0, W - view.w);
    view.y = clamp(view.y, 0, H - view.h);
    svg.setAttribute('viewBox', `${r3(view.x)} ${r3(view.y)} ${r3(view.w)} ${r3(view.h)}`);
  };
  const at = (e) => { const r = svg.getBoundingClientRect(); return { x: view.x + (e.clientX - r.left) / r.width * view.w, y: view.y + (e.clientY - r.top) / r.height * view.h }; };

  svg.addEventListener('wheel', (e) => {
    if (e.ctrlKey) { // pinch / ctrl+wheel → zoom toward the cursor
      e.preventDefault();
      const p = at(e);
      const nw = clamp(view.w * Math.exp(e.deltaY * 0.01), W / 12, W);
      const f = nw / view.w;
      view.x = p.x - (p.x - view.x) * f; view.y = p.y - (p.y - view.y) * f; view.w = nw;
      apply();
      return;
    }
    // plain two-finger scroll: PAN the zoomed map; at full zoom let the report scroll
    if (view.w >= W - 0.5) return;
    e.preventDefault();
    view.x += e.deltaX * (view.w / (svg.clientWidth || W));
    view.y += e.deltaY * (view.h / (svg.clientHeight || H));
    apply();
  }, { passive: false });

  // NOTE: capture is taken LAZILY — only once a real drag starts (>3px). Capturing
  // on pointerdown would retarget the subsequent `click` to the <svg>, breaking
  // closest('[data-uuid]') and the drill. A pure click never captures → click hits
  // the cell. (capId tracks the captured pointer so we release the right one.)
  let down = null, moved = false, capId = null;
  svg.addEventListener('pointerdown', (e) => { down = { cx: e.clientX, cy: e.clientY, vx: view.x, vy: view.y }; moved = false; });
  svg.addEventListener('pointermove', (e) => {
    if (!down) return;
    const dx = e.clientX - down.cx, dy = e.clientY - down.cy;
    if (!moved) {
      if (Math.abs(dx) + Math.abs(dy) <= 3) return; // jitter — not a drag yet
      moved = true; try { svg.setPointerCapture(e.pointerId); capId = e.pointerId; } catch { /* ignore */ }
    }
    const r = svg.getBoundingClientRect();
    view.x = down.vx - dx / r.width * view.w; view.y = down.vy - dy / r.height * view.h;
    apply();
  });
  svg.addEventListener('pointerup', () => { down = null; if (capId != null) { try { svg.releasePointerCapture(capId); } catch { /* ignore */ } capId = null; } });
  // Single click = drill (delayed so a double-click can pre-empt it); double click
  // on a cell = jump to 拓撲; double click on empty space = reset the zoom.
  let clickTimer = null;
  svg.addEventListener('click', (e) => {
    if (moved) { e.stopPropagation(); moved = false; return; } // a pan shouldn't drill/jump
    const r = e.target.closest('[data-uuid]');
    if (!r) return;
    e.stopPropagation();
    if (clickTimer) clearTimeout(clickTimer);
    clickTimer = setTimeout(() => { clickTimer = null; if (onPick) onPick(r.dataset.uuid); }, 210);
  });
  svg.addEventListener('dblclick', (e) => {
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
    e.preventDefault();
    const r = e.target.closest('[data-uuid]');
    if (r) { e.stopPropagation(); if (onJump) onJump(r.dataset.uuid); return; }
    view.x = view.y = 0; view.w = W; apply(); // empty area → reset zoom
  });
}

// Decode → downscale to a small PNG dataURL (avoids holding full-res textures).
async function thumbDataUrl(provider, path, max = 128) {
  const bm = await createImageBitmap(await provider.file(path));
  const scale = Math.min(1, max / (Math.max(bm.width, bm.height) || 1));
  const w = Math.max(1, Math.round(bm.width * scale)), h = Math.max(1, Math.round(bm.height * scale));
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  cv.getContext('2d').drawImage(bm, 0, 0, w, h);
  if (bm.close) bm.close();
  return cv.toDataURL('image/png');
}
