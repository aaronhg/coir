// Tiny dependency-free i18n for the browser UI (zh-Hant + English).
// `t(key, vars)` looks up the current locale, falls back to zh-Hant then the key
// itself, and interpolates {var} placeholders. No third-party runtime deps.

const MESSAGES = {
  'zh-Hant': {
    // shell / static (index.html)
    'app.title': 'Coir — Cocos Creator 資源使用與依賴拓撲分析',
    'btn.pick': '選擇 Cocos 專案目錄',
    'proj.none': '未載入',
    'tab.list': '清單',
    'tab.topo': '拓撲',
    'tab.reports': '報告',
    'empty.pickFirst': '先選擇專案目錄',
    'search.ph': '搜尋資源路徑…（或按 / 快速開啟）',
    'palette.ph': '搜尋檔名 / uuid…　(↑↓ 選擇 · Enter 開啟 · Esc 關閉)',
    'palette.hint': '<b>@</b> sprite-frame　<b>#</b> 型別　<b>&gt;</b> 引用處/節點　<b>~</b> 邊種類　·　貼 uuid 直接跳',
    'welcome.tagline': '載入一個 <b>Cocos Creator 3.8.x</b> 專案，瀏覽資源的<b>使用情形</b>與<b>依賴拓撲</b>。<br>全程在瀏覽器端執行，<b>不會上傳任何檔案</b>。',
    'welcome.note': '需 Chrome / Edge（File System Access API）',
    'help.btn': '說明',
    'help.title': '說明',
    'help.close': '關閉',
    'help.body': '<h3>這是什麼</h3><p>載入一個 <b>Cocos Creator 3.8.x</b> 專案，分析資源的<b>使用情形</b>與<b>依賴拓撲</b>。全程在瀏覽器端執行，不上傳任何檔案。</p>'
      + '<h3>三個分頁</h3><ul><li><b>清單</b> — 可排序資源表。<code>被依賴</code>／<code>依賴</code> 是直接度數，帶 <code>∑</code> 的是傳遞閉包（影響範圍／打包量）。單擊＝選中、雙擊（或 <kbd>Enter</kbd>）＝設為拓撲中心；<kbd>↑</kbd> <kbd>↓</kbd> 切換項目。</li>'
      + '<li><b>拓撲</b> — 以選中資源為中心的雙向依賴樹：<code>←</code> 被依賴往左、<code>→</code> 依賴往右，固定 5 欄滑動視窗，父子間以灰色連線相連、選中時整條鏈（祖先）與直接子節點會加亮。選一個節點會自動顯示它「用在哪」。頂端的 bar：左邊<b>篩選框</b>會直接隱藏不相符的節點（清空或 <kbd>Esc</kbd> 即還原），右邊<b>麵包屑</b>顯示到中心的整條鏈（方向固定「被依賴 → 依賴」，每節可點跳選，旁邊一顆按鈕複製整條鏈）。</li>'
      + '<li><b>報告</b> — 未使用、孤兒參照、圖集利用率、資源體積、缺來源檔的 meta。</li></ul>'
      + '<h3>型別篩選</h3><p>banner 下方的型別徽章三個分頁共用：篩清單／報告；在拓撲上保留「通往該型別」的路徑、剪掉無關的分支。</p>'
      + '<h3>快速搜尋 <kbd>/</kbd></h3><p>模糊比對檔名／路徑／uuid，命中字會高亮。範圍前綴：<kbd>@</kbd> sprite-frame、<kbd>#</kbd> 型別、<kbd>&gt;</kbd> 引用處/節點、<kbd>~</kbd> 邊種類（單打 <kbd>~</kbd> 列出可選種類）；<kbd>#</kbd>/<kbd>~</kbd> 可兩段式（<code>#型別 關鍵字</code>、<code>~kind 關鍵字</code>）。貼上 uuid 直接跳。</p>'
      + '<h3>快捷鍵</h3><ul><li><kbd>Tab</kbd> 切換分頁、<kbd>Esc</kbd> 清空類型篩選</li>'
      + '<li><kbd>/</kbd> 或 <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>P</kbd> 快速搜尋、<kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>R</kbd> 選擇專案目錄</li>'
      + '<li>拓撲：<kbd>↑</kbd> <kbd>↓</kbd> 同欄、<kbd>←</kbd> <kbd>→</kbd>（或兩指橫滑）跨欄、<kbd>Enter</kbd> 設為新中心、<kbd>−</kbd> 上一動、<kbd>+</kbd> 下一動、<kbd>Delete</kbd> 回清單、<kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>F</kbd> 在此拓撲中尋找、<kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>C</kbd> 複製名稱</li></ul>',
    'help.github': '在 GitHub 上查看 ↗',
    // banner / status
    'stats': '{assets} 資源 · {edges} 邊 · {orphans} 孤兒參照',
    'err.noFsApi': '此瀏覽器不支援 File System Access API — 請用 Chrome / Edge，並透過 http://localhost 開啟',
    'status.reading': '讀取目錄…',
    'status.scanning': '掃描 {n} 個檔案…',
    'status.error': '錯誤：{msg}',
    'status.plugins': '外掛：{names}',
    'status.snapshot': '快照檢視 · {n} 節點',
    'viewer.title': '拓撲快照',
    // filter bar
    'filter.label': '類型篩選',
    'filter.labelTopo': '類型篩選 · 層0鄰域',
    'filter.all': '✕ 全部',
    // 清單 columns
    'col.base': '名稱', 'col.dir': '目錄', 'col.type': '類型', 'col.size': '大小',
    'col.in': '被依賴', 'col.cin': '被依賴∑', 'col.out': '依賴', 'col.cout': '依賴∑',
    'col.in.t': '直接被引用的資源數',
    'col.cin.t': '被依賴閉包：直接或間接會被牽連的資源總數',
    'col.out.t': '直接依賴的資源數',
    'col.cout.t': '依賴閉包：載入時會連帶拉進來的資源總數',
    'list.count': '{n} 項',
    'list.cap': '（顯示前 {cap}）',
    // 拓撲
    'topo.hint': '從「清單」選一個資源，或按 / 搜尋，作為中心。',
    'topo.layer': '層',
    'topo.copyPath': '複製完整路徑',
    'topo.boundary': '邊界節點 · 更多依賴不在此快照',
    'topo.findPh': '在目前拓撲中尋找節點…',
    'topo.findCount': '{cur}/{total}',
    'topo.findNone': '無相符',
    'topo.findPrev': '上一個 (⇧Enter)',
    'topo.findNext': '下一個 (Enter)',
    'topo.findClose': '關閉 (Esc)',
    'topo.filterPh': '篩選節點（隱藏非相符）…',
    'topo.filterClear': '清除篩選 (Esc)',
    'topo.copyChain': '複製整條鏈（被依賴 → 依賴）',
    'copy.chain': '已複製整條鏈（{n} 個節點）',
    'topo.copyLink': '複製此中心的拓撲連結',
    'copy.link': '已複製拓撲連結',
    'usage.more': '此處有引用 · 未載入完整專案',
    'usage.header': '在 {file} 內 · {n} 處',
    'usage.root': '(根節點)',
    'usage.copyTitle': '複製全部到剪貼簿',
    'usage.copyAria': '複製使用位置',
    'usage.copied': '已複製使用位置',
    'copy.named': '已複製：{name}',
    // palette
    'palette.clo': '被依賴∑ {cin}（會受牽連） · 依賴∑ {cout}（會被拉進）',
    'palette.tagFrame': '🖼 frame',
    'palette.tagUsage': '↪ 引用處',
    'palette.tagEdge': '↘ 邊',
    'palette.empty': '無相符',
    // 報告
    'rep.unused': '未使用 / 孤兒資源',
    'rep.unusedSub': '{n} 項 · {size}（resources/ 已略過）',
    'rep.orphan': '孤兒參照',
    'rep.orphanSub': '{n} 個失效 uuid',
    'rep.orphanMissing': '· {n} 個缺來源檔',
    'rep.atlas': '圖集利用率',
    'rep.atlasSub': '{n} 個圖集',
    'rep.size': '資源體積',
    'rep.sizemap': '體積圖',
    'sizemap.others': '其他 {n} 項 · {size}',
    'sizemap.othersShort': '其他 {n} 項',
    'rep.dropped': '缺來源檔的 meta（已略過）',
    'rep.droppedSub': '{n} 個',
    'rep.droppedRefd': '{n} 個仍被引用',
    'rep.droppedNoRef': '皆無人引用',
    'rep.none': '無',
    'rep.noAtlas': '無圖集',
    'rep.sources': '{n} 來源',
    'totop': '回最上面',
    'vr.sharedCount': '{n} 組共用圖',
    'vr.loading': '載入縮圖中…',
    'vr.badge.confirmed': '已確認',
    'vr.badge.likely': '可能',
    'vr.badge.name-only': '僅同名',
    'vr.badge.different': '實際不同',
    'orphan.missingTitle': '{ref} · 被 {count} 處引用，但來源檔已不存在',
    'tag.missingSrc': '缺來源檔',
    'tag.unrefd': '未被引用',
    'tag.whole': '整圖動態取用',
    'tag.stillRef': '仍被引用',
    'tag.noRef': '無人引用',
    'size.type': '類型', 'size.count': '數量', 'size.total': '總大小', 'size.sum': '總計', 'size.largest': '最大檔案',
  },
  en: {
    'app.title': 'Coir — Cocos Creator asset usage & dependency topology',
    'btn.pick': 'Choose Cocos project folder',
    'proj.none': 'No project',
    'tab.list': 'List',
    'tab.topo': 'Topology',
    'tab.reports': 'Reports',
    'empty.pickFirst': 'Choose a project folder first',
    'search.ph': 'Search asset paths… (or press / to quick-open)',
    'palette.ph': 'Search name / uuid…  (↑↓ select · Enter open · Esc close)',
    'palette.hint': '<b>@</b> sprite-frame　<b>#</b> type　<b>&gt;</b> usage/node　<b>~</b> edge-kind　·　paste a uuid to jump',
    'welcome.tagline': 'Load a <b>Cocos Creator 3.8.x</b> project to explore asset <b>usage</b> and the <b>dependency topology</b>.<br>Everything runs in your browser — <b>no files are uploaded</b>.',
    'welcome.note': 'Requires Chrome / Edge (File System Access API)',
    'help.btn': 'Help',
    'help.title': 'Help',
    'help.close': 'Close',
    'help.body': '<h3>What it is</h3><p>Load a <b>Cocos Creator 3.8.x</b> project to analyze asset <b>usage</b> and the <b>dependency topology</b>. Everything runs in your browser — no files are uploaded.</p>'
      + '<h3>Three tabs</h3><ul><li><b>List</b> — sortable asset table. <code>Used by</code>/<code>Uses</code> are direct degrees; the <code>∑</code> columns are transitive closures (blast radius / bundle). Click to select, double-click (or <kbd>Enter</kbd>) to centre the topology on it; <kbd>↑</kbd> <kbd>↓</kbd> move between rows.</li>'
      + '<li><b>Topology</b> — a bidirectional dependency tree around the selected asset: <code>←</code> dependents fan left, <code>→</code> dependencies fan right, in a fixed 5-column sliding window, with grey parent→child connectors and the selected node\'s chain (ancestors) + direct children highlighted. Selecting a node auto-shows where it is used. The top bar: a <b>filter box</b> on the left that hides non-matching nodes (clear or <kbd>Esc</kbd> restores), and a <b>breadcrumb</b> on the right showing the chain to the centre (fixed dependents → dependencies, each crumb clickable, with a button to copy the whole chain).</li>'
      + '<li><b>Reports</b> — unused, orphan refs, atlas utilization, asset size, source-less metas.</li></ul>'
      + '<h3>Type filter</h3><p>The type badges under the banner are shared by all tabs: they filter List/Reports, and on Topology they keep the paths that reach the chosen type and prune dead branches.</p>'
      + '<h3>Quick search <kbd>/</kbd></h3><p>Fuzzy-matches name/path/uuid, highlighting matched characters. Scopes: <kbd>@</kbd> sprite-frame, <kbd>#</kbd> type, <kbd>&gt;</kbd> usage/node, <kbd>~</kbd> edge-kind (type <kbd>~</kbd> to list them); <kbd>#</kbd>/<kbd>~</kbd> are two-part (<code>#type query</code>, <code>~kind query</code>). Paste a uuid to jump.</p>'
      + '<h3>Shortcuts</h3><ul><li><kbd>Tab</kbd> switch tab, <kbd>Esc</kbd> clear type filter</li>'
      + '<li><kbd>/</kbd> or <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>P</kbd> quick search, <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>R</kbd> choose project folder</li>'
      + '<li>Topology: <kbd>↑</kbd> <kbd>↓</kbd> within a column, <kbd>←</kbd> <kbd>→</kbd> (or two-finger swipe) across columns, <kbd>Enter</kbd> set as new centre, <kbd>−</kbd> back, <kbd>+</kbd> forward, <kbd>Delete</kbd> to list, <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>F</kbd> find in this topology, <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>C</kbd> copy name</li></ul>',
    'help.github': 'View on GitHub ↗',
    'stats': '{assets} assets · {edges} edges · {orphans} orphan refs',
    'err.noFsApi': 'This browser lacks the File System Access API — use Chrome / Edge over http://localhost',
    'status.reading': 'Reading folder…',
    'status.scanning': 'Scanning {n} files…',
    'status.error': 'Error: {msg}',
    'status.plugins': 'plugins: {names}',
    'status.snapshot': 'Snapshot · {n} nodes',
    'viewer.title': 'Topology snapshot',
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
    'topo.copyPath': 'Copy full path',
    'topo.boundary': 'Boundary · more dependencies not in this snapshot',
    'topo.findPh': 'Find a node in this topology…',
    'topo.findCount': '{cur}/{total}',
    'topo.findNone': 'No matches',
    'topo.findPrev': 'Previous (⇧Enter)',
    'topo.findNext': 'Next (Enter)',
    'topo.findClose': 'Close (Esc)',
    'topo.filterPh': 'Filter nodes (hide non-matching)…',
    'topo.filterClear': 'Clear filter (Esc)',
    'topo.copyChain': 'Copy the whole chain (dependents → dependencies)',
    'copy.chain': 'Copied the chain ({n} nodes)',
    'topo.copyLink': 'Copy a topology link for this centre',
    'copy.link': 'Topology link copied',
    'usage.more': 'Referenced here · open the full project to see where',
    'usage.header': 'in {file} · {n} sites',
    'usage.root': '(root node)',
    'usage.copyTitle': 'Copy all to clipboard',
    'usage.copyAria': 'Copy usage sites',
    'usage.copied': 'Usage sites copied',
    'copy.named': 'Copied: {name}',
    'palette.clo': 'Used-by∑ {cin} (affected) · Uses∑ {cout} (pulled in)',
    'palette.tagFrame': '🖼 frame',
    'palette.tagUsage': '↪ usage',
    'palette.tagEdge': '↘ edge',
    'palette.empty': 'No match',
    'rep.unused': 'Unused / orphan assets',
    'rep.unusedSub': '{n} items · {size} (resources/ skipped)',
    'rep.orphan': 'Orphan references',
    'rep.orphanSub': '{n} dangling uuids',
    'rep.orphanMissing': '· {n} missing-source',
    'rep.atlas': 'Atlas utilization',
    'rep.atlasSub': '{n} atlases',
    'rep.size': 'Asset size',
    'rep.sizemap': 'Size map',
    'sizemap.others': '{n} more · {size}',
    'sizemap.othersShort': '+{n} more',
    'rep.dropped': 'Source-less metas (skipped)',
    'rep.droppedSub': '{n} metas',
    'rep.droppedRefd': '{n} still referenced',
    'rep.droppedNoRef': 'none referenced',
    'rep.none': 'None',
    'rep.noAtlas': 'No atlases',
    'rep.sources': '{n} sources',
    'totop': 'Back to top',
    'vr.sharedCount': '{n} shared',
    'vr.loading': 'loading thumbnails…',
    'vr.badge.confirmed': 'confirmed',
    'vr.badge.likely': 'likely',
    'vr.badge.name-only': 'name only',
    'vr.badge.different': 'differs',
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
// Merge plugin-contributed strings into the catalog: `{ 'zh-Hant': {...}, en: {...} }`.
// Plugin keys override only their own entries; call before the next render.
export function registerMessages(byLocale) {
  for (const loc of Object.keys(byLocale || {})) {
    MESSAGES[loc] = { ...(MESSAGES[loc] || {}), ...byLocale[loc] };
  }
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
