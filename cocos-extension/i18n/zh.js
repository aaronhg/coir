'use strict';
// 中文字串（繁體）。key 以 `i18n:coir.<key>`（package.json）與
// `Editor.I18n.t('coir.<key>')`（程式）引用；命名空間 = 擴充名稱（coir）。
module.exports = {
  ext_title: 'Coir 依賴拓撲',
  ext_desc: '右鍵資源以開啟它的依賴拓撲（coir）。子選單按層列出被依賴（←）與依賴（→）。',
  menu_title: 'Coir 依賴拓撲',
  open: '開啟拓撲圖',
  layer: '層', // 顯示為「層1」「層2」（數字由程式接上）
};
