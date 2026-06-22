// Clipboard helpers (with a textarea fallback for non-secure contexts).
import { base, S, setStatus, COPY_ICON, CHECK_ICON, esc } from './state.js';
import { t } from './i18n.js';

// A "copy all" button for a report section/sub-header — copies every line (one per
// row). Empty list → no button. The click is handled by the global delegated
// handler in ui.js (.cell-copy → copyToClipboard); data-copy-msg = the status text.
export function copyAllBtn(lines) {
  if (!lines || !lines.length) return '';
  return ` <button class="cell-copy" type="button" title="${esc(t('rep.copyAll'))}" data-copy="${esc(lines.join('\n'))}" data-copy-msg="${esc(t('rep.copiedN', { n: lines.length }))}">${COPY_ICON}</button>`;
}

export function copyToClipboard(text, done) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else fallbackCopy(text, done);
}
export function copyName(uuid) {
  const name = base(S.scan.assets.get(uuid).path);
  copyToClipboard(name, () => setStatus(t('copy.named', { name })));
}
function fallbackCopy(s, done) {
  const ta = document.createElement('textarea');
  ta.value = s; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); done(); } catch { /* ignore */ }
  document.body.removeChild(ta);
}
// Flash a copy button to ✓ then back; used by the usage popup's copy.
export function flashCopied(btn) {
  btn.innerHTML = CHECK_ICON; btn.classList.add('ok');
  setTimeout(() => { btn.innerHTML = COPY_ICON; btn.classList.remove('ok'); }, 1200);
  setStatus(t('usage.copied'));
}
