// Clipboard helpers (with a textarea fallback for non-secure contexts).
import { base, S, setStatus, COPY_ICON, CHECK_ICON } from './state.js';
import { t } from './i18n.js';

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
