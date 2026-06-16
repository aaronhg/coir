'use strict';
// English strings. Keys are referenced as `i18n:coir.<key>` (package.json) and
// `Editor.I18n.t('coir.<key>')` (code). Namespace = the extension name (coir).
module.exports = {
  ext_title: 'Coir — dependency topology',
  ext_desc: "Right-click an asset to open its dependency topology (coir). The submenu lists dependents (←) and dependencies (→) by layer.",
  menu_title: 'Coir dependency topology',
  open: 'Open topology',
  layer: 'L', // shown as "L1", "L2" (the number is appended in code)
};
