// Shared UI state + tiny helpers, imported by every ui/* module. The single
// mutable `S` object holds what used to be ui.js's module-level `let`s — so a
// split module reads/writes `S.scan`, `S.tab`, … and they all see one source of
// truth. DOM-touching helpers ($/setStatus) live here too since everyone needs them.
import { componentName } from '../core/selector.js';
import { PLUGINS } from '../core/plugins/index.js';

// Baseline colors for the core (non-plugin) types. Plugin-owned types bring their
// own `colors`, merged in by setScan (mutates this object) — so each plugin is
// the single source of truth for its type's color.
export const TYPE_COLOR = {
  image: '#4fc3f7', texture: '#4dd0e1', 'sprite-frame': '#4fc3f7', prefab: '#81c784',
  scene: '#ff8a65', script: '#90a4ae', audio: '#a1887f', anim: '#4db6ac',
  material: '#9575cd', effect: '#7e57c2',
  json: '#b0bec5', text: '#b0bec5', orphan: '#ef5350',
  bundle: '#ffd54f', // Asset Bundle pseudo-node (parallel bundle graph)
};
export const typeColor = (ty) => TYPE_COLOR[ty] || '#b0bec5';
export const $ = (id) => document.getElementById(id);
export const base = (p) => p.slice(p.lastIndexOf('/') + 1);
export const dirOf = (p) => { const i = p.lastIndexOf('/'); return i === -1 ? '' : p.slice(0, i + 1); };
export const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`);
export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const setStatus = (msg) => { $('status').textContent = msg || ''; };

export const COLS = [
  { key: 'base', labelKey: 'col.base', cls: 'cnm' },
  { key: 'dir', labelKey: 'col.dir', cls: 'cdir' },
  { key: 'type', labelKey: 'col.type', cls: 'ctype' },
  { key: 'bundle', labelKey: 'col.bundle', cls: 'cbundle', titleKey: 'col.bundle.t' },
  { key: 'size', labelKey: 'col.size', cls: 'cnum', num: true },
  { key: 'in', labelKey: 'col.in', cls: 'cnum', num: true, titleKey: 'col.in.t' },
  { key: 'cin', labelKey: 'col.cin', cls: 'cnum cclo', num: true, titleKey: 'col.cin.t' },
  { key: 'out', labelKey: 'col.out', cls: 'cnum', num: true, titleKey: 'col.out.t' },
  { key: 'cout', labelKey: 'col.cout', cls: 'cnum cclo', num: true, titleKey: 'col.cout.t' },
];
export const FILTER_KEY = 'coir.filter'; // 持久化清單過濾（搜尋字串 + 型別篩選）

export const COPY_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
export const CHECK_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

// The one mutable state bag (was ui.js's module-level `let`s).
export const S = {
  scan: null,
  adj: null,
  bundleAdj: null,    // parallel bundle graph (contains + bundle-dep) — topology nav only
  bundleDepAdj: null, // bundle → bundle only — for bundle degree/closure in the list
  bundleDepRefs: null, // Map `fromBundleKey>toBundleKey` → the asset edges behind it (usage popup)
  bundleDupMap: null,  // Map assetUuid → {copies,wasted,bundles} for the size-map red overlay (axis D)
  hasBundles: false,   // project has real bundles → show the 體積圖 group-by toggle
  sizemapGroup: 'type', // 體積圖 grouping: 'type' | 'bundle'
  byTypeCache: {},
  nodeIndex: [],
  closureByUuid: new Map(), // uuid -> nodeIndex entry, for the palette's ∑ columns
  sortKey: 'dir',
  sortDir: 1,
  selectedTypes: new Set(), // empty == all types — ONE global filter for 清單/拓撲/報告
  tab: 'list',
  treeRoot: null,           // centre asset (層0)
  selectedKey: null,        // selected key (root uuid, or a side-prefixed key)
  lastCells: [],            // cells from the last renderTopo (keyboard nav)
  topo: null,               // cached built tree { left, right, lo, hi, maxRow } — paintTopo virtualizes rows over it
  navHistory: [],           // topology back-stack of { treeRoot, selectedKey }  (− = 上一動)
  navForward: [],           // topology forward-stack  (+ = 下一動)
  listSel: null,            // 清單鍵盤游標的 uuid (↑↓ 切換、Enter 設為中心)
  listClickTimer: null,     // 清單單擊/雙擊 區分
  cellClickTimer: null,
  paletteItems: [],
  paletteIdx: 0,
  searchIndex: null,        // lazily-built multi-source palette index (assets/frames/usage/edge)
  usageText: '',            // plain-text of the current usage popup, for its copy button
  swipeAccum: 0,
  swipeLock: false,
  swipeTimer: null,
  plugins: PLUGINS,
  provider: null,           // the live FileProvider (file()/readText) — null in snapshot/viewer mode
  reportGen: 0,             // bumped each renderReports; stale async plugin-report fills bail
  pluginReportCache: null,  // built Plugin.reports data, per scan (cleared in setScan)
  deepOverrideCache: null,  // built deep-instance-override report data, per scan (cleared in setScan)
  reportTab: null,          // active 報告 sub-tab id (null → first); persists across re-renders
  reportBodies: null,       // id -> {title,sub,body} for the core sections (sync sub-tab swap)
  sizemapSel: null,         // 體積圖 keyboard cell cursor (uuid)
  sizemapGen: 0,            // bumped each renderSizemap; a stale thumbnail hydration bails
};

// Canonical component name (cc.Sprite / ResSprite) — same as the CLI --where and
// the edit selector, so a usage line reads back as a paste-able selector.
export const compName = (raw) => componentName(S.scan, raw);
