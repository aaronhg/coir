// Quick-open palette ("/" or Ctrl/⌘+P): a fuzzy search over a multi-source index
// (assets by path/uuid, sprite-frame names, usage sites). Scope sigils: @frame
// #type >usage. Every result's `target` is an asset uuid, so picking focuses an asset.
import { S, $, base, dirOf, esc, typeColor, compName } from './state.js';
import { t } from './i18n.js';
import { closeUsage } from './usage.js';
import { focus } from './topo.js';

export function openPalette() {
  if (!S.scan) return;
  closeUsage();
  $('palette').hidden = false;
  const list = $('paletteList');
  // Bound once per open (cells come and go as you scroll → delegation, not per-row).
  list.onscroll = () => { if (palettePaintScheduled) return; palettePaintScheduled = true; requestAnimationFrame(() => { palettePaintScheduled = false; paintPaletteList(); }); };
  list.onclick = (e) => {
    const it = e.target.closest('.pitem');
    if (!it) return;
    const item = S.paletteItems[+it.dataset.i];
    if (!item) return;
    if (item.kind === 'edgekind') drillKind(item.edgeKind); else pickPalette(item.target);
  };
  const inp = $('paletteInput'); inp.value = ''; renderPalette(''); inp.focus();
}
export function closePalette() { $('palette').hidden = true; }

// Searchable entries from every angle. Each `target` is a real asset uuid, so
// picking any kind focuses an asset. `edgeKind` (on edge-derived entries) is the
// clean dimension the `~` sigil filters on; `text` carries the kind so it's
// fuzzy-searchable too.
//   asset : a file (label=name, text=full path, also matchable by uuid)
//   frame : a sprite-frame inside an atlas/sheet (label=frame name) → its owner
//   usage : a LOCATED edge site (node path · component.property · frame · click)
//   edge  : a location-less edge (meta/convention/plugin — atlas→texture, extends,
//           a plugin's audio-call/emits…); label = its plugin label or endpoints
export function buildSearchIndex() {
  const out = [];
  for (const a of S.scan.assets.values()) {
    out.push({ kind: 'asset', target: a.uuid, type: a.type, uuid: a.uuid, label: base(a.path), sub: dirOf(a.path) || '/', text: a.path });
    for (const sa of a.subAssets || []) {
      if (sa.kind !== 'sprite-frame' || !sa.name || sa.name === 'spriteFrame') continue; // skip the default single-png frame
      out.push({ kind: 'frame', target: a.uuid, type: a.type, label: sa.name, sub: base(a.path), text: sa.name });
    }
  }
  const seen = new Set();
  for (const e of S.scan.edges) {
    const toA = S.scan.assets.get(e.to); const fromA = S.scan.assets.get(e.from);
    if (!toA || !fromA) continue;
    if (e.locations && e.locations.length) {              // located edge → one usage entry per site
      for (const l of e.locations) {
        const comp = l.component ? compName(l.component) : '';
        const np = l.nodePath || ''; const prop = l.property || '';
        if (!np && !prop && !comp) continue;              // no addressable location → skip (structural)
        const key = `${e.to}|${np}|${comp}|${prop}`;
        if (seen.has(key)) continue; seen.add(key);
        const text = [e.kind, np, comp, prop, l.subName].filter(Boolean).join(' '); // kind is searchable
        out.push({ kind: 'usage', target: e.to, type: toA.type, edgeKind: e.kind, label: np || prop || comp, sub: `${base(toA.path)} ← ${base(fromA.path)}`, text });
      }
    } else {                                              // location-less edge → one edge entry
      out.push({ kind: 'edge', target: e.to, type: toA.type, edgeKind: e.kind,
        label: e.label || `${base(fromA.path)} → ${base(toA.path)}`,
        sub: e.kind, text: `${e.kind} ${e.label || ''} ${fromA.path} ${toA.path}` });
    }
  }
  return out;
}
// Subsequence (fuzzy) score, with word-boundary and consecutive-run bonuses;
// stays well below the substring scores so exact hits always rank first.
function subseqScore(q, txt) {
  let ti = 0, score = 0, prev = -2;
  for (let i = 0; i < q.length; i++) {
    const f = txt.indexOf(q[i], ti);
    if (f < 0) return -1;
    let s = 1;
    if (f === 0 || '/_-. '.includes(txt[f - 1])) s += 5;
    if (f === prev + 1) s += 3;
    score += s; prev = f; ti = f + 1;
  }
  return score;
}
function matchScore(q, txt) { // higher = better; -1 = no match. q already lowercased.
  if (!q) return 0;
  txt = txt.toLowerCase();
  const idx = txt.indexOf(q);
  if (idx === 0) return 1000 - txt.length;                                              // prefix
  if (idx > 0) return ('/_-. '.includes(txt[idx - 1]) ? 700 : 500) - idx - txt.length * 0.1; // substring
  return subseqScore(q, txt);                                                            // subsequence
}
// Like matchScore but returns the matched character indices in `txt` (for highlighting).
function fuzzyMatch(q, txt) {
  if (!q) return { pos: [] };
  const tl = txt.toLowerCase();
  if (tl.includes(q)) { // highlight EVERY substring occurrence
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
// Wrap the matched indices of `str` in <b class="hl">, escaping the rest.
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

// Scope sigils: @frame  #type  >usage  ~edge-kind. `#` and `~` are TWO-PART —
// `#type query` / `~kind query` — the first token filters (asset type / edge
// kind), the rest searches within the survivors.
const PALETTE_SCOPES = { '@': 'frame', '#': 'type', '>': 'usage', '~': 'edge' };
const TWO_PART = new Set(['type', 'edge']);
// ---- result rendering (virtualized) --------------------------------------
const PROW = 32;             // .pitem fixed height — MUST match the CSS; exact row math for virtualization
let palettePaintScheduled = false;
let paletteHlQ = '';         // the query to highlight in the current result set (set by renderPalette, read at paint time)

const TAGS = { frame: 'palette.tagFrame', usage: 'palette.tagUsage', edge: 'palette.tagEdge' };
const tagHtml = (e) => TAGS[e.kind] ? `<span class="ptag">${esc(t(TAGS[e.kind]))}</span>` : '';
// Highlight matched chars (VSCode-style) using the search part.
function hlOf(e) {
  const hlQ = paletteHlQ;
  if (!hlQ) return { L: esc(e.label), Sub: esc(e.sub) };
  if (e.kind === 'asset') {
    const m = fuzzyMatch(hlQ, e.text);
    if (!m) return { L: esc(e.label), Sub: esc(e.sub) };
    const dirLen = e.sub === '/' ? 0 : e.sub.length;
    return {
      L: hlText(e.label, m.pos.filter((p) => p >= dirLen).map((p) => p - dirLen)),
      Sub: e.sub === '/' ? '/' : hlText(e.sub, m.pos.filter((p) => p < dirLen)),
    };
  }
  const m = fuzzyMatch(hlQ, e.label);
  return { L: m ? hlText(e.label, m.pos) : esc(e.label), Sub: esc(e.sub) };
}
function cloHtml(e) { // ← 被依賴∑ (blast radius) · → 依賴∑ (bundle); a 0 side is omitted
  const n = S.closureByUuid.get(e.target);
  const cin = n ? n.cin : 0, cout = n ? n.cout : 0;
  const parts = [];
  if (cin) parts.push(`<i>←</i>${cin}`);
  if (cout) parts.push(`<i>→</i>${cout}`);
  if (!parts.length) return '<span class="pclo"></span>'; // keep the column width for alignment
  return `<span class="pclo" title="${esc(t('palette.clo', { cin, cout }))}">${parts.join(' ')}</span>`;
}
// One result row — handles both the edge-kind menu rows and normal result rows.
// `data-i` is the index into S.paletteItems (delegation reads it; off-screen rows
// aren't in the DOM under virtualization).
function rowHtml(e, i) {
  const on = i === S.paletteIdx ? ' on' : '';
  if (e.kind === 'edgekind') {
    const m = fuzzyMatch(paletteHlQ, e.edgeKind) || { pos: [] };
    return `<div class="pitem${on}" data-i="${i}">` +
      `<span class="dot" style="background:#607d8b"></span>` +
      `<span class="pnm">~${hlText(e.edgeKind, m.pos)}</span>` +
      `<span class="ptag">${esc(t('palette.tagEdge'))}</span>` +
      `<span class="pdir">${e.count}</span></div>`;
  }
  const { L, Sub } = hlOf(e);
  return `<div class="pitem${on}" data-i="${i}">` +
    `<span class="dot" style="background:${typeColor(e.type)}"></span>` +
    `<span class="pnm">${L}</span>${tagHtml(e)}` +
    `<span class="pdir" title="${esc(e.sub)}">${Sub}</span>${cloHtml(e)}</div>`;
}
// Paint ONLY the rows in the viewport (± buffer); top/bottom spacer divs preserve
// the full scroll height. Runs on every scroll frame — keeps the DOM at ~a screenful.
function paintPaletteList() {
  const list = $('paletteList');
  const items = S.paletteItems;
  if (!items.length) { list.innerHTML = `<div class="empty">${esc(t('palette.empty'))}</div>`; return; }
  const vh = Math.max(list.clientHeight, Math.round(window.innerHeight * 0.5)); // #paletteList is capped at 50vh; floor for the not-yet-laid-out first paint
  const BUF = 6;
  const from = Math.max(0, Math.floor(list.scrollTop / PROW) - BUF);
  const to = Math.min(items.length - 1, Math.ceil((list.scrollTop + vh) / PROW) + BUF);
  let body = from > 0 ? `<div class="pspacer" style="height:${from * PROW}px"></div>` : '';
  for (let i = from; i <= to; i++) body += rowHtml(items[i], i);
  const tail = items.length - 1 - to;
  if (tail > 0) body += `<div class="pspacer" style="height:${tail * PROW}px"></div>`;
  list.innerHTML = body;
}

export function renderPalette(raw) {
  if (!S.searchIndex) S.searchIndex = buildSearchIndex();
  const list = $('paletteList');
  const rawInput = raw || '';          // keep the un-trimmed input — a trailing space commits a `~kind`
  raw = rawInput.trim();
  let scope = null, q = raw.toLowerCase();
  if (raw && PALETTE_SCOPES[raw[0]]) { scope = PALETTE_SCOPES[raw[0]]; q = raw.slice(1).trim().toLowerCase(); }
  const uuidish = !scope && /^[0-9a-f-]{4,}$/i.test(q);
  // Two-part scopes: split off the first token as the filter, the rest searches.
  let filterTok = '', subQ = q;
  if (TWO_PART.has(scope)) { const sp = q.indexOf(' '); filterTok = sp < 0 ? q : q.slice(0, sp); subQ = sp < 0 ? '' : q.slice(sp + 1).trim(); }
  // What to highlight: the search part (subQ for two-part scopes, else the query).
  const hlQ = TWO_PART.has(scope) ? subQ : q;

  // Bare `~` (or `~partial`, no space yet) → list the available EDGE KINDS with
  // counts, so they're discoverable. Pick one (click/Enter) or add a space to
  // drill into that kind's edges. A trailing space commits the kind → edges.
  if (scope === 'edge' && !q.includes(' ') && !/\s$/.test(rawInput)) {
    const counts = new Map();
    for (const e of S.searchIndex) {
      if ((e.kind !== 'edge' && e.kind !== 'usage') || !e.edgeKind) continue;
      if (q && matchScore(q, e.edgeKind) < 0) continue;
      counts.set(e.edgeKind, (counts.get(e.edgeKind) || 0) + 1);
    }
    const kinds = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    S.paletteItems = kinds.map(([k, n]) => ({ kind: 'edgekind', edgeKind: k, count: n }));
    paletteHlQ = q; S.paletteIdx = 0; list.scrollTop = 0; paintPaletteList();
    return;
  }

  let items;
  if (!q && !scope) {
    items = S.searchIndex.filter((e) => e.kind === 'asset'); // empty query → all assets (virtualized — no cap)
  } else {
    const within = (e) => subQ ? Math.max(matchScore(subQ, e.label), matchScore(subQ, e.text)) : 1000; // 2-part: search the survivors
    const scored = [];
    for (const e of S.searchIndex) {
      if (scope === 'frame' && e.kind !== 'frame') continue;
      if (scope === 'usage' && e.kind !== 'usage') continue;
      if (scope === 'type') { // '#type query': filter assets by type, then search
        if (e.kind !== 'asset' || (filterTok && matchScore(filterTok, e.type) < 0)) continue;
        const sc = within(e); if (sc >= 0) scored.push([sc, e]);
        continue;
      }
      if (scope === 'edge') { // '~kind query': filter edge-derived entries by kind, then search
        if ((e.kind !== 'edge' && e.kind !== 'usage') || (filterTok && matchScore(filterTok, e.edgeKind || '') < 0)) continue;
        const sc = within(e); if (sc >= 0) scored.push([sc, e]);
        continue;
      }
      if (!scope && (e.kind === 'usage' || e.kind === 'edge')) continue; // usage via '>'/'~'; edge via '~'
      let sc = matchScore(q, e.label);
      if (e.kind === 'asset' || e.kind === 'usage') sc = Math.max(sc, matchScore(q, e.text)); // also full path / component·property
      if (uuidish && e.kind === 'asset' && e.uuid.toLowerCase().includes(q)) sc = Math.max(sc, 900);
      if (sc < 0) continue;
      if (e.kind === 'frame') sc -= 0.5; // assets edge out frames on a tie
      scored.push([sc, e]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    items = scored.map((x) => x[1]); // no cap — virtualization keeps every match reachable
  }
  S.paletteItems = items; paletteHlQ = hlQ; S.paletteIdx = 0; list.scrollTop = 0; paintPaletteList();
}
export function movePalette(d) {
  if (!S.paletteItems.length) return;
  S.paletteIdx = (S.paletteIdx + d + S.paletteItems.length) % S.paletteItems.length;
  // Reveal the selected row (it may not be painted), then repaint with the new `on`.
  const list = $('paletteList');
  const top = S.paletteIdx * PROW, bot = top + PROW;
  if (top < list.scrollTop) list.scrollTop = top;
  else if (bot > list.scrollTop + list.clientHeight) list.scrollTop = bot - list.clientHeight;
  paintPaletteList();
}
export function pickPalette(uuid) { closePalette(); if (S.scan && S.scan.assets.has(uuid)) focus(uuid); }
// Drill from a kind row into that kind's edges (`~kind ` — the trailing space commits it).
export function drillKind(k) { const inp = $('paletteInput'); inp.value = `~${k} `; renderPalette(inp.value); inp.focus(); }
