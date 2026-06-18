// Size-map report: a squarified treemap of asset bytes (the visual companion to
// the "資源體積" table). Outer cells = asset types (area ∝ total bytes), inner
// cells = individual assets (area ∝ bytes) — so the biggest textures literally
// take up the most screen. Respects the global type filter. Each asset rect is
// data-uuid (the body-level click delegation focuses it) with a path+size tooltip.
//
// Image assets carry `data-img` so `hydrateSizeMap` can paint the actual texture
// thumbnail into the cell (downscaled, behind the per-cell type label). Thin gaps
// + no per-asset text labels keep it uncluttered.
import { typeColor, esc, base, kb } from './state.js';
import { t } from './i18n.js';
import { sizeReport } from '../core/analyze.js';
import { typeAllowed } from './filterbar.js';
import { squarify } from './treemap.js';

const W = 1000, H = 560;   // viewBox; CSS scales width:100% keeping this aspect
const CAP = 80;            // max asset rects per type (the tail lumps into "其他")
const MINPX = 3;           // skip cells too small to see (caps the DOM)
const THUMB_MIN = 22;      // only thumbnail cells at least this big (viewBox units)
const GAP = 0.75;          // half-gap between cells (thin, soft)

const SVG_NS = 'http://www.w3.org/2000/svg';
const r3 = (n) => Math.round(n * 10) / 10; // trim SVG coordinate noise
const MAXF = 11; // filename font cap (viewBox units) so big cells aren't shouty

// A filename label sized to fit the cell (full name, no truncation) — tiny on a
// small cell, magnified to readability by pinch-zoom. Skips microscopic cells.
function nameLabel(rc, nm) {
  if (rc.w < 10 || rc.h < 4) return '';
  const fs = Math.min(MAXF, rc.h * 0.55, rc.w / (nm.length * 0.52 + 0.5));
  if (fs < 1.6) return '';
  return `<text class="tmname" x="${r3(rc.x + GAP + 1.5)}" y="${r3(rc.y + GAP + fs)}" font-size="${r3(fs)}" stroke-width="${r3(fs * 0.16)}">${esc(nm)}</text>`;
}

export function sizeMapBody(scan) {
  const items = sizeReport(scan).items.filter((i) => typeAllowed(i.type) && (i.size || 0) > 0);
  if (!items.length) return `<div class="empty">${esc(t('rep.none'))}</div>`;

  const byType = new Map();
  for (const i of items) { let g = byType.get(i.type); if (!g) byType.set(i.type, (g = { type: i.type, size: 0, items: [] })); g.size += i.size; g.items.push(i); }
  const groups = [...byType.values()].sort((a, b) => b.size - a.size);
  const total = groups.reduce((s, g) => s + g.size, 0);

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
        cells += `<rect class="tmother" x="${x}" y="${y}" width="${bw}" height="${bh}" rx="2" fill="${col}" fill-opacity="0.28"><title>${esc(t('sizemap.others', { n: it.count, size: kb(it.size) }))}</title></rect>`;
        if (rc.w > 56 && rc.h > 22) cells += `<text class="tmotherl" x="${r3(rc.x + rc.w / 2)}" y="${r3(rc.y + rc.h / 2)}" text-anchor="middle" dominant-baseline="middle">${esc(t('sizemap.othersShort', { n: it.count }))}</text>`;
        continue;
      }
      const isImg = it.type === 'image' && rc.w >= THUMB_MIN && rc.h >= THUMB_MIN;
      const img = isImg ? ` data-img="${esc(it.path)}"` : '';
      cells += `<rect class="tmrect" data-uuid="${esc(it.uuid)}"${img} x="${x}" y="${y}" width="${bw}" height="${bh}" rx="1.5" fill="${col}" fill-opacity="0.82"><title>${esc(it.path)}\n${esc(kb(it.size))}</title></rect>`;
      // Filename sized to the cell — small cells get small text, so a pinch-zoom
      // magnifies it into readability (the SVG text is vector). Outlined (paint-order)
      // so it stays legible over a thumbnail. Placed right after the rect so a
      // thumbnail (injected via rect.after) sits UNDER it.
      cells += nameLabel(rc, base(it.path));
    }
  }
  return `<svg class="sizemap" viewBox="0 0 ${W} ${H}">${cells}</svg>`;
}

// Paint downscaled texture thumbnails into the image cells (data-img). Inserted
// right after each placeholder rect (so it covers the colour but stays below the
// type-label chips, which were appended last). Concurrency-limited; `isCurrent()`
// bails the instant a newer render supersedes us.
export async function hydrateSizeMap(root, provider, isCurrent) {
  if (!provider || !provider.file) return;
  const svg = root.querySelector('svg.sizemap');
  if (!svg) return;
  const cellsToThumb = [...svg.querySelectorAll('rect[data-img]')];
  let i = 0;
  const worker = async () => {
    while (i < cellsToThumb.length) {
      const rect = cellsToThumb[i++];
      if (!isCurrent()) return;
      const url = await thumbDataUrl(provider, rect.dataset.img).catch(() => null);
      if (!url || !isCurrent() || !rect.isConnected) continue;
      const im = document.createElementNS(SVG_NS, 'image');
      im.setAttribute('href', url);
      for (const a of ['x', 'y', 'width', 'height']) im.setAttribute(a, rect.getAttribute(a));
      im.setAttribute('preserveAspectRatio', 'xMidYMid slice');
      im.setAttribute('data-uuid', rect.dataset.uuid);
      im.classList.add('tmimg');
      rect.after(im); // on top of the placeholder colour, under the label chips
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, cellsToThumb.length) }, worker));
}

// Two-finger pinch (trackpad ctrl+wheel) zooms the treemap toward the cursor by
// shrinking the SVG viewBox; drag pans; double-click resets. Aspect is locked so
// cells never distort, and the view is clamped to the map bounds. A real drag
// suppresses the trailing click so panning never accidentally focuses an asset.
export function attachSizemapZoom(svg) {
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

  let down = null, moved = false;
  svg.addEventListener('pointerdown', (e) => { down = { cx: e.clientX, cy: e.clientY, vx: view.x, vy: view.y }; moved = false; try { svg.setPointerCapture(e.pointerId); } catch { /* ignore */ } });
  svg.addEventListener('pointermove', (e) => {
    if (!down) return;
    const dx = e.clientX - down.cx, dy = e.clientY - down.cy;
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
    const r = svg.getBoundingClientRect();
    view.x = down.vx - dx / r.width * view.w; view.y = down.vy - dy / r.height * view.h;
    apply();
  });
  svg.addEventListener('pointerup', (e) => { down = null; try { svg.releasePointerCapture(e.pointerId); } catch { /* ignore */ } });
  svg.addEventListener('click', (e) => { if (moved) { e.stopPropagation(); moved = false; } }); // a pan shouldn't focus
  svg.addEventListener('dblclick', (e) => { e.preventDefault(); view.x = view.y = 0; view.w = W; apply(); });
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
