// Spine plugin — everything about Spine in one file: the `spine` / `spine-atlas`
// types, their colors, and the skeleton→atlas→page-texture edges.
//
// `.atlas` files import with the wildcard importer "*", so the type is keyed off
// the extension via `typeByExt`. Multi-page atlases are parsed out of the .atlas
// text (not guessed by basename), so a deleted .json never drops the page edges.

// @ts-check
/** @typedef {import('../../../types/index.js').Plugin} Plugin */

/** @type {Plugin} */
export default {
  name: 'spine',
  importerTypes: { 'spine-data': 'spine' },
  typeByExt: { '.atlas': 'spine-atlas' },
  colors: { spine: '#f06292', 'spine-atlas': '#f48fb1' },

  async edges(ctx) {
    const { assets, byPath, missingByPath, missingReferenced, addEdge, readText, mapLimit } = ctx;

    // skeleton(.json) → atlas(.atlas), else → page png; gated on a live skeleton.
    for (const a of assets.values()) {
      if (a.type !== 'spine') continue;
      const base = a.path.replace(/\.json$/i, '');
      const atlasPath = `${base}.atlas`;
      const atlas = byPath.get(atlasPath);
      if (atlas) addEdge(a.uuid, atlas.uuid, 'spine-atlas');
      else if (missingByPath.has(atlasPath)) missingReferenced.add(atlasPath);
      else {
        const pngPath = `${base}.png`;
        const png = byPath.get(pngPath);
        if (png) addEdge(a.uuid, png.uuid, 'texture');
        else if (missingByPath.has(pngPath)) missingReferenced.add(pngPath);
      }
    }

    // atlas(.atlas) → page texture(.png), parsed from the .atlas text —
    // INDEPENDENT of the skeleton, so a deleted .json doesn't silently drop the
    // atlas's texture edges. The atlas may be multi-page.
    const spineAtlases = [...assets.values()].filter((a) => a.type === 'spine-atlas' && a.hasSource);
    await mapLimit(spineAtlases, 16, async (a) => {
      let text;
      try { text = await readText(a.path); } catch { return; }
      const dir = a.path.slice(0, a.path.lastIndexOf('/'));
      for (const line of text.split(/\r?\n/)) {
        const name = line.trim();
        if (!/\.png$/i.test(name) || name.includes(':')) continue; // page line, not a property
        const pngPath = dir ? `${dir}/${name}` : name;
        const png = byPath.get(pngPath);
        if (png) addEdge(a.uuid, png.uuid, 'texture');
        else if (missingByPath.has(pngPath)) missingReferenced.add(pngPath);
      }
    });
  },
};
