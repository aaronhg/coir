// Bitmap-/TTF-font plugin: the `font` type + font→texture edges.

// @ts-check
/** @typedef {import('../../../types/index.js').Plugin} Plugin */

/** @type {Plugin} */
export default {
  name: 'font',
  importerTypes: { 'bitmap-font': 'font', 'ttf-font': 'font' },
  colors: { font: '#ffd54f' },

  // font → texture (meta userData.textureUuid).
  async edges(ctx) {
    const { assets, addEdge, missing, missingReferenced, uuid: { mainUuid } } = ctx;
    for (const a of assets.values()) {
      if (a.type !== 'font') continue;
      const tex = a.userData && a.userData.textureUuid;
      if (typeof tex === 'string') {
        const m = mainUuid(tex);
        if (assets.has(m)) addEdge(a.uuid, m, 'texture');
        else if (missing.has(m)) missingReferenced.add(missing.get(m));
      }
    }
  },
};
