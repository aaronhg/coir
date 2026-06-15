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
  const inp = $('paletteInput'); inp.value = ''; renderPalette(''); inp.focus();
}
export function closePalette() { $('palette').hidden = true; }

// Searchable entries from every angle. Each `target` is a real asset uuid.
//   asset : a file (label=name, text=full path, also matchable by uuid)
//   frame : a sprite-frame inside an atlas/sheet (label=frame name) → its owner
//   usage : where an asset is used (node path · component.property · frame · click)
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
    if (!e.locations || !e.locations.length) continue;
    const toA = S.scan.assets.get(e.to); const fromA = S.scan.assets.get(e.from);
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

const PALETTE_SCOPES = { '@': 'frame', '#': 'type', '>': 'usage' };
export function renderPalette(raw) {
  if (!S.searchIndex) S.searchIndex = buildSearchIndex();
  raw = (raw || '').trim();
  let scope = null, q = raw.toLowerCase();
  if (raw && PALETTE_SCOPES[raw[0]]) { scope = PALETTE_SCOPES[raw[0]]; q = raw.slice(1).trim().toLowerCase(); }
  const uuidish = !scope && /^[0-9a-f-]{4,}$/i.test(q);

  let items;
  if (!q && !scope) {
    items = S.searchIndex.filter((e) => e.kind === 'asset').slice(0, 100); // empty query → assets
  } else {
    const scored = [];
    for (const e of S.searchIndex) {
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

  S.paletteItems = items; S.paletteIdx = 0;
  const tag = (e) => e.kind === 'frame' ? `<span class="ptag">${esc(t('palette.tagFrame'))}</span>`
    : e.kind === 'usage' ? `<span class="ptag">${esc(t('palette.tagUsage'))}</span>` : '';
  // Highlight matched chars (VSCode-style).
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
    const n = S.closureByUuid.get(e.target);
    const cin = n ? n.cin : 0, cout = n ? n.cout : 0;
    const parts = [];
    if (cin) parts.push(`<i>←</i>${cin}`);
    if (cout) parts.push(`<i>→</i>${cout}`);
    if (!parts.length) return '<span class="pclo"></span>'; // keep the column width for alignment
    return `<span class="pclo" title="${esc(t('palette.clo', { cin, cout }))}">${parts.join(' ')}</span>`;
  };
  $('paletteList').innerHTML = items.map((e, i) => {
    const { L, S: Ssub } = hlOf(e);
    return `<div class="pitem${i === 0 ? ' on' : ''}" data-uuid="${e.target}">` +
      `<span class="dot" style="background:${typeColor(e.type)}"></span>` +
      `<span class="pnm">${L}</span>${tag(e)}` +
      `<span class="pdir" title="${esc(e.sub)}">${Ssub}</span>${clo(e)}</div>`;
  }).join('') || `<div class="empty">${esc(t('palette.empty'))}</div>`;
  for (const el of $('paletteList').querySelectorAll('.pitem')) el.onclick = () => pickPalette(el.dataset.uuid);
  $('paletteList').scrollTop = 0; // new query resets selection to item 0 → scroll it back into view
}
export function movePalette(d) {
  if (!S.paletteItems.length) return;
  S.paletteIdx = (S.paletteIdx + d + S.paletteItems.length) % S.paletteItems.length;
  const els = $('paletteList').querySelectorAll('.pitem');
  els.forEach((e, i) => e.classList.toggle('on', i === S.paletteIdx));
  if (els[S.paletteIdx]) els[S.paletteIdx].scrollIntoView({ block: 'nearest' });
}
export function pickPalette(uuid) { closePalette(); if (S.scan && S.scan.assets.has(uuid)) focus(uuid); }
