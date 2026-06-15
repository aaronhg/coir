// The "used where" popup: for the SELECTED topology cell, where it sits inside
// its tree-parent (the adjacent on-screen node) — node path · component.property
// · frame · ClickEvent. Only the location detail; from/to names are already in
// the tree. Hidden for the centre/root and for edges with no node location.
import { S, $, base, esc, compName, COPY_ICON } from './state.js';
import { t } from './i18n.js';
import { copyToClipboard, flashCopied } from './copy.js';

export function showUsage() {
  const pop = $('usagePopup');
  if (S.tab !== 'topo' || !S.scan || !S.treeRoot || !S.selectedKey || S.selectedKey === S.treeRoot) { pop.hidden = true; return; }
  const segs = S.selectedKey.split('>');
  const a = segs[segs.length - 1];
  const p = segs.length >= 3 ? segs[segs.length - 2] : S.treeRoot; // tree-parent uuid
  const side = S.selectedKey[0];
  const from = side === 'R' ? p : a; // the scene/prefab that contains the usage
  const to = side === 'R' ? a : p;   // the asset being used
  const fromA = S.scan.assets.get(from);
  if (!fromA) { pop.hidden = true; return; }
  const locs = S.scan.edges.filter((e) => e.from === from && e.to === to).flatMap((e) => e.locations || []);
  if (!locs.length) { pop.hidden = true; return; } // structural edge / no node-level location
  const seen = new Set(); const rows = []; const plain = [];
  for (const l of locs) {
    const npRaw = l.nodePath || t('usage.root');
    const comp = compName(l.component);
    let headRaw, tail = '', tailRaw = '';
    if (l.property && l.property.startsWith('click')) { // cc.Button ClickEvent — show a badge
      const method = l.property.replace(/^click → /, '').replace(/\(\)$/, '');
      headRaw = l.nodePath && comp ? `${npRaw}:${comp}` : npRaw;
      tail = `<span class="up-click">▶ ${esc(method)}</span>`; tailRaw = `▶ ${method}`;
    } else {
      // nodePath:Comp.prop — a paste-able edit selector; the frame stays as a tail.
      headRaw = l.nodePath && comp ? `${npRaw}:${comp}${l.property ? `.${l.property}` : ''}`
        : (comp && l.property ? `${npRaw}  ${comp}.${l.property}` : npRaw);
      if (l.subName) { tail = esc(`🖼 ${l.subName}`); tailRaw = `🖼 ${l.subName}`; }
    }
    const head = esc(headRaw);
    const key = `${headRaw}|${tailRaw}`;
    if (seen.has(key)) continue; seen.add(key);
    rows.push(`<div class="up-site">${head}${tail ? `  ·  ${tail}` : ''}</div>`);
    plain.push(`${headRaw}${tailRaw ? `  ·  ${tailRaw}` : ''}`);
  }
  S.usageText = plain.join('\n'); // just the usage sites, no header line
  const headHtml = t('usage.header', { file: `<b>${esc(base(fromA.path))}</b>`, n: rows.length });
  pop.innerHTML = `<div class="up-head"><span>${headHtml}</span>` +
    `<button class="up-copy" type="button" title="${esc(t('usage.copyTitle'))}" aria-label="${esc(t('usage.copyAria'))}">${COPY_ICON}</button></div>` +
    `<div class="up-list">${rows.join('')}</div>`;
  pop.hidden = false;
  const cb = pop.querySelector('.up-copy');
  if (cb) cb.onclick = (ev) => { ev.stopPropagation(); copyToClipboard(S.usageText, () => flashCopied(cb)); };
  positionUsage(pop);
}
export function closeUsage() { $('usagePopup').hidden = true; }

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
}
