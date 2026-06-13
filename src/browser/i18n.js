// Tiny dependency-free i18n for the browser UI (zh-Hant + English).
// `t(key, vars)` looks up the current locale, falls back to zh-Hant then the key
// itself, and interpolates {var} placeholders. No third-party runtime deps.

const MESSAGES = {
  'zh-Hant': {
    // shell / static (index.html)
    'app.title': 'Coir · Cocos 資源依賴拓撲',
    'btn.pick': '選擇 Cocos 專案目錄',
    'proj.none': '未載入',
    'tab.list': '清單',
    'tab.topo': '拓撲',
    'tab.reports': '報告',
    'empty.pickFirst': '先選擇專案目錄',
    'search.ph': '搜尋資產路徑…（或按 / 快速開啟）',
    'palette.ph': '搜尋檔名 / uuid…　(↑↓ 選擇 · Enter 開啟 · Esc 關閉)',
    'palette.hint': '<b>@</b> sprite-frame　<b>#</b> 型別　<b>&gt;</b> 用途/節點　·　貼 uuid 直接跳',
    'welcome.tagline': '載入一個 <b>Cocos Creator 3.8.x</b> 專案，瀏覽資產的<b>使用情形</b>與<b>依賴拓撲</b>。<br>全程在瀏覽器端執行，<b>不會上傳任何檔案</b>。',
    'welcome.note': '需 Chrome / Edge（File System Access API）',
    'help.btn': '說明',
    'help.title': '說明',
    'help.close': '關閉',
    'help.body': '<h3>這是什麼</h3><p>載入一個 <b>Cocos Creator 3.8.x</b> 專案，分析資產的<b>使用情形</b>與<b>依賴拓撲</b>。全程在瀏覽器端執行，不上傳任何檔案。</p>'
      + '<h3>三個分頁</h3><ul><li><b>清單</b> — 可排序資產表。<code>被依賴</code>／<code>依賴</code> 是直接度數，帶 <code>∑</code> 的是傳遞閉包（影響範圍／打包量）。點一列＝設為拓撲中心。</li>'
      + '<li><b>拓撲</b> — 以選中資產為中心的雙向依賴樹：<code>←</code> 被依賴往左、<code>→</code> 依賴往右，固定 5 欄滑動視窗。選一個節點會自動顯示它「用在哪」。</li>'
      + '<li><b>報告</b> — 未使用、孤兒參照、圖集利用率、資產體積、缺來源檔的 meta。</li></ul>'
      + '<h3>型別篩選</h3><p>banner 下方的型別徽章三個分頁共用：篩清單／報告；在拓撲上保留「通往該型別」的路徑、剪掉無關枝。</p>'
      + '<h3>快速搜尋 <kbd>/</kbd></h3><p>模糊比對檔名／路徑／uuid，命中字會高亮。範圍前綴：<kbd>@</kbd> sprite-frame、<kbd>#</kbd> 型別、<kbd>&gt;</kbd> 用途/節點；貼上 uuid 直接跳。</p>'
      + '<h3>快捷鍵（拓撲）</h3><ul><li><kbd>↑</kbd> <kbd>↓</kbd> 同欄上下、<kbd>←</kbd> <kbd>→</kbd>（或兩指橫滑）跨欄</li><li><kbd>Enter</kbd> 把選中項設為新中心</li><li><kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>C</kbd> 複製名稱、<kbd>r</kbd> 還原上次位置</li></ul>',
    'help.github': '在 GitHub 上查看 ↗',
    // banner / status
    'stats': '{assets} 資產 · {edges} 邊 · {orphans} 孤兒參照',
    'err.noFsApi': '此瀏覽器不支援 File System Access API — 請用 Chrome / Edge，並透過 http://localhost 開啟',
    'status.reading': '讀取目錄…',
    'status.scanning': '掃描 {n} 個檔案…',
    'status.error': '錯誤：{msg}',
    // filter bar
    'filter.label': '類型篩選',
    'filter.labelTopo': '類型篩選 · 層0鄰域',
    'filter.all': '✕ 全部',
    // 清單 columns
    'col.base': '名稱', 'col.dir': '目錄', 'col.type': '類型', 'col.size': '大小',
    'col.in': '被依賴', 'col.cin': '被依賴∑', 'col.out': '依賴', 'col.cout': '依賴∑',
    'col.in.t': '直接被引用的資產數',
    'col.cin.t': '被依賴閉包：直接或間接會被牽連的資產總數',
    'col.out.t': '直接依賴的資產數',
    'col.cout.t': '依賴閉包：載入時會傳遞拉進來的資產總數',
    'list.count': '{n} 項',
    'list.cap': '（顯示前 {cap}）',
    // 拓撲
    'topo.hint': '從「清單」選一個資產，或按 / 搜尋，作為中心。',
    'topo.layer': '層',
    'usage.header': '在 {file} 內 · {n} 處',
    'usage.root': '(根節點)',
    'usage.copyTitle': '複製全部到剪貼簿',
    'usage.copyAria': '複製使用位置',
    'usage.copied': '已複製使用位置',
    'copy.named': '已複製：{name}',
    // palette
    'palette.clo': '被依賴∑ {cin}（會牽連的） · 依賴∑ {cout}（會載入的）',
    'palette.tagFrame': '🖼 frame',
    'palette.tagUsage': '↪ 用途',
    'palette.empty': '無符合',
    // 報告
    'rep.unused': '未使用 / 孤兒資源',
    'rep.unusedSub': '{n} 項 · {size}（resources/ 已略過）',
    'rep.orphan': '孤兒參照',
    'rep.orphanSub': '{n} 個失效 uuid',
    'rep.orphanMissing': '· {n} 個缺來源檔',
    'rep.atlas': '圖集利用率',
    'rep.atlasSub': '{n} 個圖集',
    'rep.size': '資產體積',
    'rep.dropped': '缺來源檔的 meta（已略過）',
    'rep.droppedSub': '{n} 個',
    'rep.droppedRefd': '{n} 個仍被引用',
    'rep.droppedNoRef': '皆無人引用',
    'rep.none': '無',
    'rep.noAtlas': '無圖集',
    'rep.sources': '{n} 來源',
    'orphan.missingTitle': '{ref} · 被 {count} 處引用，但來源檔已不存在',
    'tag.missingSrc': '缺來源檔',
    'tag.unrefd': '未被參照',
    'tag.whole': '整圖動態取用',
    'tag.stillRef': '仍被引用',
    'tag.noRef': '無人引用',
    'size.type': '類型', 'size.count': '數量', 'size.total': '總大小', 'size.sum': '總計', 'size.largest': '最大檔案',
  },
  en: {
    'app.title': 'Coir · Cocos asset dependency topology',
    'btn.pick': 'Choose Cocos project folder',
    'proj.none': 'No project',
    'tab.list': 'List',
    'tab.topo': 'Topology',
    'tab.reports': 'Reports',
    'empty.pickFirst': 'Choose a project folder first',
    'search.ph': 'Search asset paths… (or press / to quick-open)',
    'palette.ph': 'Search name / uuid…  (↑↓ select · Enter open · Esc close)',
    'palette.hint': '<b>@</b> sprite-frame　<b>#</b> type　<b>&gt;</b> usage/node　·　paste a uuid to jump',
    'welcome.tagline': 'Load a <b>Cocos Creator 3.8.x</b> project to explore asset <b>usage</b> and the <b>dependency topology</b>.<br>Everything runs in your browser — <b>no files are uploaded</b>.',
    'welcome.note': 'Requires Chrome / Edge (File System Access API)',
    'help.btn': 'Help',
    'help.title': 'Help',
    'help.close': 'Close',
    'help.body': '<h3>What it is</h3><p>Load a <b>Cocos Creator 3.8.x</b> project to analyze asset <b>usage</b> and the <b>dependency topology</b>. Everything runs in your browser — no files are uploaded.</p>'
      + '<h3>Three tabs</h3><ul><li><b>List</b> — sortable asset table. <code>Used by</code>/<code>Uses</code> are direct degrees; the <code>∑</code> columns are transitive closures (blast radius / bundle). Click a row to centre the topology on it.</li>'
      + '<li><b>Topology</b> — a bidirectional dependency tree around the selected asset: <code>←</code> dependents fan left, <code>→</code> dependencies fan right, in a fixed 5-column sliding window. Selecting a node auto-shows where it is used.</li>'
      + '<li><b>Reports</b> — unused, orphan refs, atlas utilization, asset size, source-less metas.</li></ul>'
      + '<h3>Type filter</h3><p>The type badges under the banner are shared by all tabs: they filter List/Reports, and on Topology they keep the paths that reach the chosen type and prune dead branches.</p>'
      + '<h3>Quick search <kbd>/</kbd></h3><p>Fuzzy-matches name/path/uuid, highlighting matched characters. Scopes: <kbd>@</kbd> sprite-frame, <kbd>#</kbd> type, <kbd>&gt;</kbd> usage/node; paste a uuid to jump.</p>'
      + '<h3>Shortcuts (Topology)</h3><ul><li><kbd>↑</kbd> <kbd>↓</kbd> within a column, <kbd>←</kbd> <kbd>→</kbd> (or two-finger swipe) across columns</li><li><kbd>Enter</kbd> set the selection as the new centre</li><li><kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>C</kbd> copy name, <kbd>r</kbd> restore last position</li></ul>',
    'help.github': 'View on GitHub ↗',
    'stats': '{assets} assets · {edges} edges · {orphans} orphan refs',
    'err.noFsApi': 'This browser lacks the File System Access API — use Chrome / Edge over http://localhost',
    'status.reading': 'Reading folder…',
    'status.scanning': 'Scanning {n} files…',
    'status.error': 'Error: {msg}',
    'filter.label': 'Type filter',
    'filter.labelTopo': 'Type filter · layer-0 neighbourhood',
    'filter.all': '✕ all',
    'col.base': 'Name', 'col.dir': 'Folder', 'col.type': 'Type', 'col.size': 'Size',
    'col.in': 'Used by', 'col.cin': 'Used by∑', 'col.out': 'Uses', 'col.cout': 'Uses∑',
    'col.in.t': 'Assets that directly reference this',
    'col.cin.t': 'Dependent closure: total assets transitively affected if this changes',
    'col.out.t': 'Assets this directly references',
    'col.cout.t': 'Dependency closure: total assets transitively pulled in when loaded',
    'list.count': '{n} items',
    'list.cap': ' (first {cap})',
    'topo.hint': 'Pick an asset in the List, or press / to search, as the centre.',
    'topo.layer': 'L',
    'usage.header': 'in {file} · {n} sites',
    'usage.root': '(root node)',
    'usage.copyTitle': 'Copy all to clipboard',
    'usage.copyAria': 'Copy usage sites',
    'usage.copied': 'Usage sites copied',
    'copy.named': 'Copied: {name}',
    'palette.clo': 'Used-by∑ {cin} (affected) · Uses∑ {cout} (pulled in)',
    'palette.tagFrame': '🖼 frame',
    'palette.tagUsage': '↪ usage',
    'palette.empty': 'No match',
    'rep.unused': 'Unused / orphan assets',
    'rep.unusedSub': '{n} items · {size} (resources/ skipped)',
    'rep.orphan': 'Orphan references',
    'rep.orphanSub': '{n} dangling uuids',
    'rep.orphanMissing': '· {n} missing-source',
    'rep.atlas': 'Atlas utilization',
    'rep.atlasSub': '{n} atlases',
    'rep.size': 'Asset size',
    'rep.dropped': 'Source-less metas (skipped)',
    'rep.droppedSub': '{n} metas',
    'rep.droppedRefd': '{n} still referenced',
    'rep.droppedNoRef': 'none referenced',
    'rep.none': 'None',
    'rep.noAtlas': 'No atlases',
    'rep.sources': '{n} sources',
    'orphan.missingTitle': '{ref} · referenced by {count}, but the source file is gone',
    'tag.missingSrc': 'missing source',
    'tag.unrefd': 'unreferenced',
    'tag.whole': 'whole-atlas dynamic',
    'tag.stillRef': 'still referenced',
    'tag.noRef': 'unreferenced',
    'size.type': 'Type', 'size.count': 'Count', 'size.total': 'Total size', 'size.sum': 'Total', 'size.largest': 'Largest files',
  },
};

const FALLBACK = 'zh-Hant';
export const LOCALES = [['zh-Hant', '繁中'], ['en', 'English']];

function detect() {
  try { const s = localStorage.getItem('coir.lang'); if (s && MESSAGES[s]) return s; } catch { /* ignore */ }
  const nav = ((typeof navigator !== 'undefined' && navigator.language) || '').toLowerCase();
  return nav.startsWith('zh') ? 'zh-Hant' : 'en';
}
let locale = detect();
export function getLocale() { return locale; }
export function setLocale(l) {
  if (!MESSAGES[l]) return;
  locale = l;
  try { localStorage.setItem('coir.lang', l); } catch { /* ignore */ }
}
export function t(key, vars) {
  const s = (MESSAGES[locale] && MESSAGES[locale][key]) ?? MESSAGES[FALLBACK][key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? '')) : s;
}
// Apply translations to static markup: data-i18n → textContent, data-i18n-html →
// innerHTML (trusted catalog strings), data-i18n-ph → placeholder. Also <title>.
export function applyStaticI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
  for (const el of root.querySelectorAll('[data-i18n-ph]')) el.placeholder = t(el.dataset.i18nPh);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  const titleEl = document.querySelector('title'); if (titleEl) titleEl.textContent = t('app.title');
}
