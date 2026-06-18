// Browser-only generic renderer for a plugin's `reports` VisualReport: a section
// of groups, each rendered as side-by-side thumbnails cropped from every member's
// page (2a — human eyeball compare), then a pixel-level confirmation pass that
// upgrades each group's badge to confirmed/different (2b). Reusable for ANY plugin
// report whose members carry a CropSpec; spine's `spine-dup` is the first user.
import { S, $, base, esc } from './state.js';
import { t } from './i18n.js';
import { makePageCache, cropThumb, cropSignature, sigDistance } from './imagecrop.js';

const CONFIRM_THRESHOLD = 0.10; // normalized L1; pairwise worst ≤ this → "confirmed"

const badgeText = (b) => t('vr.badge.' + (b || 'likely'));

// Build the section markup synchronously (thumbnails fill in later via hydrate).
// Rendered as a report-tab body (the sub-tab itself is the disclosure).
export function visualSectionHTML(sectionId, title, report) {
  const groups = report.groups || [];
  const body = groups.length
    ? groups.map((g, gi) => groupHTML(gi, g)).join('')
    : `<div class="empty">${esc(t('rep.none'))}</div>`;
  const sub = groups.length ? t('vr.sharedCount', { n: groups.length }) : t('rep.none');
  return `<div id="rep-${esc(sectionId)}" class="vreport">` +
    `<div class="rbody-head">${esc(t(title))} <span class="sub">${esc(sub)}</span></div>` +
    `<div class="rbody">${body}</div></div>`;
}

function groupHTML(gi, g) {
  const members = (g.members || []).map((m, mi) => {
    const cap = `<figcaption title="${esc(m.label)}">${esc(base(m.label))}</figcaption>`;
    const thumb = m.crop
      ? `<div class="vthumb" data-g="${gi}" data-m="${mi}"></div>`
      : '<div class="vthumb nocrop">?</div>';
    const click = m.focusUuid ? ` data-uuid="${esc(m.focusUuid)}"` : '';
    return `<figure class="vmember"${click}>${thumb}${cap}</figure>`;
  }).join('');
  return `<div class="vgroup" data-g="${gi}">` +
    `<div class="vghead">` +
    `<span class="vbadge ${esc(g.badge || 'likely')}" data-g="${gi}">${esc(badgeText(g.badge))}</span>` +
    `<span class="vglabel">${esc(g.label)}</span>` +
    (g.note ? `<span class="vgnote">${esc(g.note)}</span>` : '') +
    `</div><div class="vthumbs">${members}</div></div>`;
}

// Draw thumbnails (2a) and run pixel confirmation (2b) into an already-rendered
// section. `isCurrent()` lets us bail the instant a newer render supersedes us.
export async function hydrateVisualSection(sectionId, report, provider, isCurrent) {
  if (!provider || !provider.file) return; // snapshot mode / no binary access
  const root = $('rep-' + sectionId);
  if (!root || !isCurrent()) return;
  const groups = report.groups || [];
  const cache = makePageCache(provider);
  try {
    const sigs = groups.map(() => []);
    // 2a — thumbnails, stashing each member's signature for 2b as we go.
    for (let gi = 0; gi < groups.length; gi++) {
      const members = groups[gi].members || [];
      for (let mi = 0; mi < members.length; mi++) {
        const crop = members[mi].crop;
        if (!crop) { sigs[gi].push(null); continue; }
        const [url, sig] = await Promise.all([cropThumb(cache, crop, 128), cropSignature(cache, crop)]);
        if (!isCurrent()) return;
        sigs[gi].push(sig);
        const cell = root.querySelector(`.vthumb[data-g="${gi}"][data-m="${mi}"]`);
        if (cell && url) { cell.style.backgroundImage = `url(${url})`; cell.classList.add('loaded'); }
        else if (cell) cell.classList.add('failed');
      }
    }
    // 2b — confirm each group from its decoded signatures; update the badge.
    for (let gi = 0; gi < groups.length; gi++) {
      const present = sigs[gi].filter(Boolean);
      if (present.length < 2) continue; // need ≥2 decoded to compare
      let worst = 0;
      for (let i = 0; i < present.length; i++) {
        for (let j = i + 1; j < present.length; j++) worst = Math.max(worst, sigDistance(present[i], present[j]));
      }
      const verdict = worst <= CONFIRM_THRESHOLD ? 'confirmed' : 'different';
      if (!isCurrent()) return;
      const badge = root.querySelector(`.vbadge[data-g="${gi}"]`);
      if (badge) {
        badge.classList.remove('likely', 'name-only', 'confirmed', 'different');
        badge.classList.add(verdict);
        badge.textContent = badgeText(verdict);
      }
      const grp = root.querySelector(`.vgroup[data-g="${gi}"]`);
      if (grp) grp.classList.toggle('isdiff', verdict === 'different');
    }
  } finally { cache.dispose(); }
}
