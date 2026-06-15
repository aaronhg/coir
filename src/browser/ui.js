// DOM orchestrator: wires the shell (tabs, keyboard, palette/usage events),
// loads a scan, and re-localizes. The features live in their own modules:
//   list.js  topo.js  usage.js  palette.js  reports.js  filterbar.js  copy.js
// and the shared state + helpers in state.js. Three banner tabs (清單 / 拓撲 /
// 報告) over one content area; "/" opens quick-open.
import { S, $, base, dirOf, esc, TYPE_COLOR, setStatus } from './state.js';
import { t, setLocale, getLocale, applyStaticI18n, registerMessages } from './i18n.js';
import { summary } from '../core/analyze.js';
import { dependencyClosure, dependentClosure } from '../core/graph.js';
import { PLUGINS } from '../core/plugins/index.js';
import { renderTable, moveListSel, scrollListToSelection } from './list.js';
import { renderTopo, reflowTopo, focus, goBack, goForward, navTree, onTopoWheel, selectedUuid, openTopoFind, closeTopoFind, runTopoFind, topoFindStep, isTopoFindActive } from './topo.js';
import { closeUsage } from './usage.js';
import { openPalette, closePalette, renderPalette, movePalette, pickPalette, drillKind } from './palette.js';
import { renderTypeFilters, toggleType, restoreFilter, saveFilter } from './filterbar.js';
import { renderReports } from './reports.js';
import { copyName } from './copy.js';

export function initUI({ onPick }) {
  applyStaticI18n(); // localize the static shell for the detected/saved locale
  const ls = $('langSel');
  if (ls) { ls.value = getLocale(); ls.onchange = () => { setLocale(ls.value); relocalize(); }; }
  $('pickBtn').onclick = onPick;
  $('welcomeBtn').onclick = onPick;
  $('helpBtn').onclick = () => { $('help').hidden = false; };
  $('helpClose').onclick = () => { $('help').hidden = true; };
  $('help').onclick = (e) => { if (e.target === $('help')) $('help').hidden = true; }; // backdrop closes
  $('search').oninput = () => { saveFilter(); renderTable(); };
  for (const b of document.querySelectorAll('.btabs button')) b.onclick = () => setTab(b.dataset.tab);
  document.body.addEventListener('click', (e) => {
    const el = e.target.closest('[data-uuid]');
    if (!el || el.closest('#topo') || el.closest('#palette') || el.closest('#nodeList')) return; // 清單列自有單擊/雙擊處理
    if (S.scan && S.scan.assets.has(el.dataset.uuid)) focus(el.dataset.uuid);
  });
  const pin = $('paletteInput');
  pin.oninput = () => renderPalette(pin.value);
  pin.onkeydown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); movePalette(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); movePalette(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); const it = S.paletteItems[S.paletteIdx]; if (!it) return; if (it.kind === 'edgekind') drillKind(it.edgeKind); else pickPalette(it.target); }
    else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
  };
  $('palette').onclick = (e) => { if (e.target === $('palette')) closePalette(); };
  document.addEventListener('keydown', onKey);
  document.addEventListener('mousedown', (e) => {
    // clicking a cell re-selects → showUsage refreshes; only close on clicks elsewhere
    if (!$('usagePopup').hidden && !e.target.closest('#usagePopup') && !e.target.closest('.cell')) closeUsage();
  });
  $('topo').addEventListener('wheel', onTopoWheel, { passive: false });
  // In-topo find (Ctrl/⌘+F) — its own input handler; stopPropagation so the global
  // onKey (Esc/arrows) doesn't double-handle the keys this bar owns.
  const tfi = $('topoFindInput');
  tfi.oninput = () => runTopoFind();
  tfi.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); topoFindStep(e.shiftKey ? -1 : 1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); topoFindStep(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); topoFindStep(-1); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeTopoFind(); }
  };
  $('topoFindNext').onclick = () => { topoFindStep(1); tfi.focus(); };
  $('topoFindPrev').onclick = () => { topoFindStep(-1); tfi.focus(); };
  $('topoFindClose').onclick = () => closeTopoFind();
  let resizeRaf = 0;
  window.addEventListener('resize', () => { // adaptive topo padding depends on viewport height → re-fit
    if (S.tab !== 'topo' || !S.treeRoot) return;
    cancelAnimationFrame(resizeRaf); resizeRaf = requestAnimationFrame(reflowTopo);
  });
  return { setScan, onProgress, setStatus };
}

export function setTab(name) {
  S.tab = name;
  for (const b of document.querySelectorAll('.btabs button')) b.classList.toggle('active', b.dataset.tab === name);
  $('tab-list').hidden = name !== 'list';
  $('tab-topo').hidden = name !== 'topo';
  $('tab-reports').hidden = name !== 'reports';
  renderTypeFilters(); // badge 母體隨分頁切換(拓撲→層0鄰域)
  if (name !== 'topo') { closeUsage(); closeTopoFind(); }
  if (name === 'topo') renderTopo();
  else if (name === 'reports') renderReports(); // reflect the current global filter
  else if (name === 'list') scrollListToSelection(); // 捲到選中/中心那列並閃一下
}
function cycleTab(delta) {
  const tabs = ['list', 'topo', 'reports'];
  const i = tabs.indexOf(S.tab);
  setTab(i < 0 ? 'list' : tabs[(i + delta + tabs.length) % tabs.length]);
}
function onProgress({ phase, done, total }) { setStatus(`${phase} ${done}/${total}`); }
function renderStats() {
  if (S.scan) $('stats').textContent = t('stats', { assets: S.scan.assets.size, edges: S.scan.edges.length, orphans: S.scan.orphanRefs.length });
}
// Re-apply every translation after a language switch.
function relocalize() {
  applyStaticI18n();
  if (!S.scan) return;
  renderStats();
  renderTypeFilters();
  renderTable();
  renderReports();
  if (S.tab === 'topo') renderTopo();
}

// ---- data ----------------------------------------------------------------
function setScan(s, name, plugins = PLUGINS) {
  // Fold plugin presentation into the UI before the first render: type colors
  // into TYPE_COLOR (plugin wins), localized strings into the i18n catalog.
  for (const p of plugins) {
    if (p.colors) Object.assign(TYPE_COLOR, p.colors);
    if (p.messages) registerMessages(p.messages);
  }
  S.scan = s; S.adj = s.adjacency; S.treeRoot = null; S.selectedKey = null; S.selectedTypes = new Set(); S.navHistory = []; S.navForward = []; S.listSel = null;
  S.searchIndex = null;
  $('welcome').hidden = true; // first-run card → gone once a project is loaded
  $('filterbar').hidden = false;
  S.nodeIndex = [...s.assets.values()].map((a) => ({
    uuid: a.uuid, path: a.path, base: base(a.path), dir: dirOf(a.path),
    type: a.type, size: a.size, in: a.in, out: a.out,
    cin: dependentClosure(S.adj, a.uuid).size, // transitive dependents (blast radius)
    cout: dependencyClosure(S.adj, a.uuid).size, // transitive deps (bundle)
  }));
  S.closureByUuid = new Map(S.nodeIndex.map((n) => [n.uuid, n]));
  const sum = summary(s); S.byTypeCache = sum.byType;
  restoreFilter(); // 還原上次的清單過濾（型別只保留專案實際有的）
  $('projectName').textContent = name;
  renderStats();
  setStatus('');
  renderTypeFilters();
  renderTable();
  renderReports();
  $('topo').innerHTML = `<div class="colhint">${esc(t('topo.hint'))}</div>`;
  setTab('list');
}

// ---- global keys ---------------------------------------------------------
function onKey(e) {
  if (!$('palette').hidden) return; // palette has its own handler
  if (!$('help').hidden) { if (e.key === 'Escape') { e.preventDefault(); $('help').hidden = true; } return; } // help open → only Esc
  const typing = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');
  const mod = (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey;
  if ((e.key === 'p' || e.key === 'P') && mod) { e.preventDefault(); openPalette(); return; }        // Ctrl/⌘+P = "/"
  if ((e.key === 'f' || e.key === 'F') && mod && S.tab === 'topo' && S.treeRoot) { e.preventDefault(); openTopoFind(); return; } // Ctrl/⌘+F find in the (virtualized) topology

  if ((e.key === 'r' || e.key === 'R') && mod) { e.preventDefault(); $('pickBtn').click(); return; }  // Ctrl/⌘+R 選擇目錄
  if ((e.key === 'c' || e.key === 'C') && mod) {                                                      // Ctrl/⌘+C 複製名稱
    if (typing) return;                                            // copying inside an input
    if (window.getSelection && window.getSelection().toString()) return; // a text selection exists → let the browser copy it
    const u = selectedUuid();
    if (u && S.scan && S.scan.assets.has(u)) { e.preventDefault(); copyName(u); }
    return;
  }
  if (e.key === 'Escape') {                                        // Esc：先關找尋列、彈窗，再清空類型篩選
    if (isTopoFindActive()) { e.preventDefault(); closeTopoFind(); return; }
    if (!$('usagePopup').hidden) { e.preventDefault(); closeUsage(); return; }
    if (!typing && S.selectedTypes.size) { e.preventDefault(); toggleType('__all'); return; } // 打字中不清篩選
    return;
  }
  if (e.key === '/' && !typing) { e.preventDefault(); openPalette(); return; }
  if (typing) return;
  if (e.key === 'Tab') { e.preventDefault(); cycleTab(e.shiftKey ? -1 : 1); return; } // Tab 切分頁
  if (S.tab === 'list') {                                 // 清單：↑↓ 切換項目、Enter 設為中心
    if (e.key === 'ArrowDown') { e.preventDefault(); moveListSel(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); moveListSel(-1); return; }
    if (e.key === 'Enter' && S.listSel) { e.preventDefault(); focus(S.listSel); return; }
    return;
  }
  if (S.tab !== 'topo' || !S.treeRoot) return;
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); setTab('list'); return; }  // 回清單
  if (e.key === '-' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); goBack(); return; }                        // − 上一動（不攔 Cmd/Ctrl±縮放）
  if ((e.key === '+' || e.key === '=') && !e.metaKey && !e.ctrlKey) { e.preventDefault(); goForward(); return; }  // + 下一動
  if (e.key === 'Enter') { const u = selectedUuid(); if (u) { e.preventDefault(); focus(u); } return; }
  const dir = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }[e.key];
  if (!dir) return;
  e.preventDefault();
  navTree(dir);
}
