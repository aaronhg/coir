// Sprite-atlas (.plist) plugin: the `atlas` type + atlas→texture edges.
//
// A plugin is a plain object. The core reads `importerTypes`/`typeByExt` (phase 1
// type assignment) and `edges(ctx)` (run after the asset index is final). The
// browser additionally reads `colors`/`messages`. `edges` uses only `ctx` helpers
// — it imports nothing — so a third-party plugin needs no build step.

// @ts-check
/** @typedef {import('../../../types/index.js').Plugin} Plugin */

/** @type {Plugin} */
export default {
  name: 'atlas',
  importerTypes: { 'sprite-atlas': 'atlas' },
  colors: { atlas: '#ba68c8' },

  // atlas → texture: each sprite-frame's source image (userData.imageUuidOrDatabaseUri).
  async edges(ctx) {
    const { assets, addEdge, missing, missingReferenced, uuid: { mainUuid } } = ctx;
    for (const a of assets.values()) {
      if (a.type !== 'atlas') continue;
      const seen = new Set();
      for (const sa of a.subAssets) {
        const img = sa.userData && sa.userData.imageUuidOrDatabaseUri;
        if (typeof img === 'string') {
          const main = mainUuid(img);
          if (!seen.has(main)) {
            seen.add(main);
            if (assets.has(main)) addEdge(a.uuid, main, 'texture');
            else if (missing.has(main)) missingReferenced.add(missing.get(main));
          }
        }
      }
    }
  },
};
