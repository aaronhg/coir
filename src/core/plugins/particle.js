// Particle plugin: the `particle` type + particle→texture edges.

// @ts-check
/** @typedef {import('../../../types/index.js').Plugin} Plugin */

/** @type {Plugin} */
export default {
  name: 'particle',
  importerTypes: { particle: 'particle' },
  colors: { particle: '#ffb74d' },

  // particle → texture (meta userData.spriteFrameUuid / textureUuid). Routed
  // through resolveUuid so a missing target is flagged as an orphan rather than
  // silently dropped.
  async edges(ctx) {
    const { assets, resolveUuid } = ctx;
    for (const a of assets.values()) {
      if (a.type !== 'particle') continue;
      const ref = a.userData && (a.userData.spriteFrameUuid || a.userData.textureUuid);
      if (typeof ref === 'string') {
        resolveUuid(a.uuid, ref, { nodePath: null, component: 'cc.ParticleSystem2D', property: 'spriteFrame' });
      }
    }
  },
};
