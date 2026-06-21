'use strict';
// coir「跳轉」面板 (renderer). 在輸入框貼/打一段定位字串 → 在編輯器裡選取目標：
//   • coir nodePath（如 Canvas/…/Node）→ 選取 *目前場景* 裡的節點
//       語法：nodePath 與 nodePath[i]（同名兄弟、0-based 消歧，比照 coir editPrefab）。
//       結尾的 :Component（與任何 .prop）會被剝掉——選「節點」，不選元件（編輯器沒有
//       單獨高亮元件卡的公開 API）。不支援 #N（檔案序列化絕對 index，活場景樹裡沒有）。
//   • 檔名/資源路徑（結尾是 .副檔名，如 xxx.prefab）→ 走 asset-db 選取 Assets 面板裡的資源。
// 反向：在階層選取節點時，自動把輸入框回填成該節點的 coir nodePath（你正在打字時不覆蓋）。

// i18n via the editor (follows its language); falls back to zh-Hant if coir.<key> 沒載到。
const T = (k, fb) => { try { const s = Editor.I18n.t(`coir.${k}`); return s && s !== `coir.${k}` ? s : fb; } catch (e) { return fb; } };
const base = (p) => String(p || '').slice(String(p || '').lastIndexOf('/') + 1);

// "Name" 或 "Name[i]" → { name, idx|null }；idx = 同名兄弟中的 0-based 位置（coir 的 [i] 語法）。
function parseSeg(s) {
  const m = /^(.*?)\[(\d+)\]$/.exec(s);
  return m ? { name: m[1].trim(), idx: Number(m[2]) } : { name: s.trim(), idx: null };
}

// 一個節點在它兄弟群裡的 coir segment：同名才加 [i]（round-trippable，比照 editPrefab listNodes）。
function segOf(node, siblings) {
  const same = (siblings || []).filter((c) => c.name === node.name);
  return same.length > 1 ? `${node.name}[${same.indexOf(node)}]` : node.name;
}

// 把一段 coir nodePath 對著活場景樹的 root 走訪。回傳 { uuid } 或 { error }。
function resolvePath(root, raw) {
  let path = String(raw || '').trim();
  const colon = path.indexOf(':');           // 剝掉 :Component[...] 後綴——選節點
  if (colon >= 0) path = path.slice(0, colon);
  path = path.trim();
  const segs = path.split('/').map((s) => s.trim()).filter(Boolean);
  if (!segs.length) return { error: T('goto_empty', '請輸入節點路徑') };

  // coir 路徑是絕對的、以場景根節點名開頭。segs[0] 對到 root 就吃掉它；
  // 否則把 segs 當成 root 底下的相對路徑（寬鬆處理）。
  let cur = root;
  let i = parseSeg(segs[0]).name === root.name ? 1 : 0;
  for (; i < segs.length; i++) {
    const { name, idx } = parseSeg(segs[i]);
    const kids = (cur.children || []).filter((c) => c.name === name);
    if (!kids.length) return { error: `${T('goto_not_found', '找不到節點')}: ${name}` };
    // 同名多個但沒給 [i]：不擋，直接取 [0]（最前面那個）。明確的 [i] 仍照走、超出範圍才報錯。
    cur = idx == null ? kids[0] : kids[idx];
    if (!cur) return { error: `${name}[${idx}] ${T('goto_oob', '超出同名節點數量')}` };
  }
  if (!cur || !cur.uuid) return { error: T('goto_not_found', '找不到節點') };
  return { uuid: cur.uuid };
}

// 反向：在活場景樹裡找到 uuid → 回傳含 [i] 消歧的 coir nodePath（root→node）。找不到回 null。
function pathOfUuid(root, uuid) {
  let found = null;
  (function dfs(node, segs, siblings) {
    if (found) return;
    const here = segs.concat(segOf(node, siblings));
    if (node.uuid === uuid) { found = here; return; }
    for (const c of node.children || []) dfs(c, here, node.children);
  })(root, [], [root]);
  return found ? found.join('/') : null;
}

const sceneRoot = async () => {
  let tree = null;
  try { tree = await Editor.Message.request('scene', 'query-node-tree'); } catch (e) { tree = null; }
  return Array.isArray(tree) ? tree[0] : tree;
};

// 檔名/資源查詢：basename 或 db-url 後綴比對 → 選取 asset。回傳 { ok } | { error }。
async function selectAsset(query) {
  const q = query.trim().toLowerCase();
  let assets = [];
  try { assets = (await Editor.Message.request('asset-db', 'query-assets')) || []; } catch (e) { assets = []; }
  assets = assets.filter((a) => a && a.url && !a.isDirectory);
  let hits = assets.filter((a) => base(a.url).toLowerCase() === q);
  if (!hits.length) hits = assets.filter((a) => a.url.toLowerCase().endsWith(`/${q}`)); // 給了部分路徑
  if (!hits.length) return { error: `${T('goto_asset_not_found', '找不到資源')}: ${query.trim()}` };
  if (hits.length > 1) return { error: `${T('goto_asset_ambiguous', '有多個同名資源，請給更完整路徑')} (${hits.length})` };
  try { Editor.Selection.clear('asset'); Editor.Selection.select('asset', hits[0].uuid); }
  catch (e) { return { error: String((e && e.message) || e) }; }
  return { ok: base(hits[0].url) };
}

// 讀輸入 → 判斷是資源還是節點 → 解析 → 選取。狀態回報到 #msg。
async function jump(panel) {
  const raw = (panel.$.sel && panel.$.sel.value) || '';
  const setMsg = (cls, text) => { panel.$.msg.className = cls; panel.$.msg.innerText = text; };
  setMsg('', '');
  const trimmed = raw.trim();
  if (!trimmed) return setMsg('err', T('goto_empty', '請輸入節點路徑'));

  // 結尾是 .副檔名（剝掉可能的 :Comp 後）→ 當作資源查詢（xxx.prefab / ui/foo.png）。
  const head = trimmed.split(':')[0].trim();
  if (/\.\w+$/.test(head)) {
    const r = await selectAsset(head);
    return r.error ? setMsg('err', r.error) : setMsg('ok', `${T('goto_asset_ok', '已選取資源')} ✓ ${r.ok}`);
  }

  const root = await sceneRoot();
  if (!root) return setMsg('err', T('goto_no_scene', '請先開啟一個場景'));
  const r = resolvePath(root, raw);
  if (r.error) return setMsg('err', r.error);
  try {
    Editor.Selection.clear('node');
    Editor.Selection.select('node', r.uuid);
    setMsg('ok', `${T('goto_ok', '已選取')} ✓`);
  } catch (e) {
    setMsg('err', String((e && e.message) || e));
  }
}

// 反向回填：選取變動時，把目前選到的（最後一個）節點/資源寫進輸入框——但你正在
// 輸入框打字時（焦點在它身上）不覆蓋。ui-input 是 custom element，聚焦時
// document.activeElement === 該 host，所以這個判斷可靠。
async function reflect(panel) {
  if (!panel.$ || !panel.$.sel) return;
  try { if (document.activeElement === panel.$.sel) return; } catch (e) { /* */ }
  let type = '';
  try { type = Editor.Selection.getLastSelectedType() || ''; } catch (e) { return; }
  let ids = [];
  try { ids = Editor.Selection.getSelected(type) || []; } catch (e) { return; }
  const uuid = ids[ids.length - 1];
  if (!uuid) return;
  if (type === 'node') {
    const root = await sceneRoot();
    const p = root && pathOfUuid(root, uuid);
    if (p) panel.$.sel.value = p;
  } else if (type === 'asset') {
    let info = null;
    try { info = await Editor.Message.request('asset-db', 'query-asset-info', uuid); } catch (e) { info = null; }
    if (info && info.url) panel.$.sel.value = base(info.url);
  }
}

// ── native-verify status footer ─────────────────────────────────────────────
// Talk to main.js (package 'coir') for the endpoint's live state + a start/stop
// toggle. Shows the bound port + cocos version in the panel's bottom-right.
const vstatus = async () => { try { return await Editor.Message.request('coir', 'coir-verify-status'); } catch (e) { return null; } };
async function renderVerify(panel) {
  if (!panel.$ || !panel.$.vinfo) return;
  const s = await vstatus();
  if (!s) { panel.$.vinfo.innerText = ''; if (panel.$.vtoggle) panel.$.vtoggle.style.display = 'none'; return; }
  const ver = s.version && s.version !== '?' ? ` · cocos ${s.version}` : '';
  panel.$.vinfo.innerText = s.running ? `native-verify :${s.port}${ver}` : `native-verify off${ver}`;
  panel.$.vinfo.className = s.running ? 'on' : '';
  if (panel.$.vtoggle) { panel.$.vtoggle.style.display = ''; panel.$.vtoggle.innerText = s.running ? 'stop' : 'start'; }
}
async function toggleVerify(panel) {
  const s = await vstatus();
  try { await Editor.Message.request('coir', s && s.running ? 'coir-verify-stop' : 'coir-verify-start'); } catch (e) { /* */ }
  renderVerify(panel); // start/stop resolve after bind, so the re-query sees the new state
}

module.exports = Editor.Panel.define({
  template: `
    <div class="coir-goto">
      <div class="row">
        <ui-input id="sel"></ui-input>
        <ui-button id="go"></ui-button>
      </div>
      <div id="msg"></div>
      <div class="foot"><span id="vinfo"></span><ui-button id="vtoggle" type="text"></ui-button></div>
    </div>`,
  style: `
    .coir-goto { padding: 8px; display: flex; flex-direction: column; gap: 6px; height: 100%; box-sizing: border-box; }
    .row { display: flex; gap: 6px; align-items: center; }
    #sel { flex: 1; }
    #msg { font-size: 11px; line-height: 1.4; white-space: pre-wrap; opacity: .9; min-height: 14px; }
    #msg.err { color: var(--color-danger, #f66); }
    #msg.ok  { color: var(--color-success, #6c6); }
    .foot { margin-top: auto; display: flex; justify-content: flex-end; align-items: center; gap: 4px; font-size: 10px; opacity: .65; }
    #vinfo.on { color: var(--color-success, #6c6); opacity: .95; }`,
  $: { sel: '#sel', go: '#go', msg: '#msg', vinfo: '#vinfo', vtoggle: '#vtoggle' },
  ready() {
    this.$.go.innerText = T('goto_go', '跳轉');
    this.$.sel.setAttribute('placeholder', T('goto_ph', '貼上 coir 節點路徑或檔名，如 Canvas/…/Node 或 xxx.prefab'));
    this.$.go.addEventListener('confirm', () => jump(this));   // 點按鈕
    this.$.vtoggle.addEventListener('confirm', () => toggleVerify(this)); // native-verify 開關
    renderVerify(this); // 顯示 endpoint 狀態 + port
    // 用原生 keydown 抓 Enter——比 ui-input 的 confirm 可靠（confirm 只在值有變動時才在 Enter 觸發，
    // 沒改再按就不發 → 之前「第二次 Enter 沒反應」的原因）。
    this.$.sel.addEventListener('keydown', (e) => { if (e.key === 'Enter') jump(this); });

    // 反向回填：監聽選取變動。
    this._onSel = () => reflect(this);
    try {
      Editor.Message.addBroadcastListener('selection:select', this._onSel);
      Editor.Message.addBroadcastListener('selection:unselect', this._onSel);
    } catch (e) { /* 訊息名在此版本不同 → 反向回填停用，手打仍可用 */ }
    reflect(this); // 開面板當下先反映一次目前選取

    try { this.$.sel.focus(); } catch (e) { /* */ }
  },
  beforeClose() {
    try {
      Editor.Message.removeBroadcastListener('selection:select', this._onSel);
      Editor.Message.removeBroadcastListener('selection:unselect', this._onSel);
    } catch (e) { /* */ }
  },
});
