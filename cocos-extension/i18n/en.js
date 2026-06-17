'use strict';
// English strings. Keys are referenced as `i18n:coir.<key>` (package.json) and
// `Editor.I18n.t('coir.<key>')` (code). Namespace = the extension name (coir).
module.exports = {
  ext_title: 'Coir — dependency topology',
  ext_desc: "Right-click an asset to open its dependency topology (coir). The submenu lists dependents (←) and dependencies (→) by layer.",
  menu_title: 'Coir dependency topology',
  open: 'Open topology',
  layer: 'L', // shown as "L1", "L2" (the number is appended in code)
  // "Go to node" panel (panels/goto.js)
  goto_title: 'Coir Goto',
  goto_open: 'Go to node…',
  goto_go: 'Go',
  goto_ph: 'Paste a coir node path or file name, e.g. Canvas/…/Node or xxx.prefab',
  goto_empty: 'Enter a node path',
  goto_no_scene: 'Open a scene first',
  goto_not_found: 'Node not found',
  goto_ambiguous: 'matches multiple same-name nodes — add [i]',
  goto_oob: 'is out of range for same-name nodes',
  goto_ok: 'Selected',
  goto_asset_ok: 'Asset selected',
  goto_asset_not_found: 'Asset not found',
  goto_asset_ambiguous: 'multiple same-name assets — give a fuller path',
};
