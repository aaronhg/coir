'use strict';
// 中文字串（繁體）。key 以 `i18n:coir.<key>`（package.json）與
// `Editor.I18n.t('coir.<key>')`（程式）引用；命名空間 = 擴充名稱（coir）。
module.exports = {
  ext_title: 'Coir 依賴拓撲',
  ext_desc: '右鍵資源以開啟它的依賴拓撲（coir）。子選單按層列出被依賴（←）與依賴（→）。',
  menu_title: 'Coir 依賴拓撲',
  open: '開啟拓撲圖',
  layer: '層', // 顯示為「層1」「層2」（數字由程式接上）
  // 「跳轉到節點」面板（panels/goto.js）
  goto_title: 'Coir 跳轉',
  goto_open: '跳轉到節點…',
  goto_go: '跳轉',
  goto_ph: '貼上 coir 節點路徑或檔名，如 Canvas/…/Node 或 xxx.prefab',
  goto_empty: '請輸入節點路徑',
  goto_no_scene: '請先開啟一個場景',
  goto_not_found: '找不到節點',
  goto_ambiguous: '有多個同名節點，請加 [i]',
  goto_oob: '超出同名節點數量',
  goto_ok: '已選取',
  goto_asset_ok: '已選取資源',
  goto_asset_not_found: '找不到資源',
  goto_asset_ambiguous: '有多個同名資源，請給更完整路徑',
};
