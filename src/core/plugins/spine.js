// Spine plugin — everything about Spine in one file: the `spine` / `spine-atlas`
// types, their colors, the skeleton→atlas→page-texture edges, and the `spine-dup`
// command (cross-atlas region reuse).
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
  messages: {
    'zh-Hant': { 'spinedup.title': 'Spine 跨圖集重複圖' },
    en: { 'spinedup.title': 'Shared images across Spine atlases' },
  },

  commands: [
    {
      name: 'spine-dup',
      usage: 'coir spine-dup   image(s) packed into more than one Spine atlas (cross-spine art reuse)',
      description:
        'List images (atlas regions) packed into more than one Spine atlas — the same art (e.g. a glow) '
        + 'baked into multiple skeletons, which whole-file dedup can never catch since each atlas page is a '
        + 'different texture. Heuristic: regions are matched by name, corroborated by pixel dimensions '
        + '(confidence: "likely" = dims agree across atlases, "name-only" = name matches but dims differ).',
      inputSchema: { type: 'object', properties: {} },
      positional: [],
      run: runSpineDup,
    },
  ],

  // Browser-only report (報告 tab): the same shared-region groups, but each member
  // carries a CropSpec so the host can draw a thumbnail per atlas (side-by-side
  // visual compare) and run pixel-level confirmation. See src/browser/visualreport.js.
  reports: [
    {
      id: 'spine-dup',
      title: 'spinedup.title',
      async build({ scan, readText }) {
        const groups = await findSharedRegions(scan, readText);
        return {
          note: String(groups.length),
          groups: groups.map((g) => ({
            key: g.name,
            label: g.name,
            badge: g.confidence === 'likely' ? 'likely' : 'name-only',
            note: g.dimsConsistent ? g.dims[0] : g.dims.join(' / '),
            members: g.members.map((m) => ({
              label: m.atlas,
              focusUuid: m.atlasUuid,
              crop: (m.page && m.w && m.h)
                ? { page: m.page, x: m.x, y: m.y, w: m.w, h: m.h, rotate: m.rotate }
                : undefined,
            })),
          })),
        };
      },
    },
  ],

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

// ---------------------------------------------------------------------------
// spine-dup: find the same image packed into more than one Spine atlas.
//
// Each Spine skeleton ships its OWN atlas page(s); when two skeletons embed the
// same art (a shared glow, a common icon) the bytes live in two different page
// PNGs at different coordinates — so whole-file content hashing can never see it.
// We work at the REGION level instead, reusing the .atlas text the plugin already
// reads. Matching is by region name (Spine names regions after the source image),
// corroborated by the region's pixel dimensions. No image decoding (stays in the
// DOM-free / zero-dep core); pixel-exact confirmation is a deliberate non-goal here.
// ---------------------------------------------------------------------------

const pathOf = (scan, uuid) => { const a = scan.assets.get(uuid); return a ? a.path : uuid; };

/**
 * Parse a libGDX/Spine `.atlas` into region records:
 *   `{ name, page, x, y, w, h, rotate, mw, mh }`
 * where (x,y,w,h) is the region's rect on the PAGE image (ready to crop) and
 * (mw,mh) is its rotation-independent ORIGINAL size (for the dup name+dims gate).
 *
 * Region NAME lines have no ':' and don't end in '.png'; page lines end in
 * '.png'; any ':' line is a property of the current region (or, before the first
 * region, of the page header — skipped). Handles both the classic layout
 * (`xy`/`size`/`orig`, where a rotated region's on-page rect is its size SWAPPED)
 * and the newer one (`bounds`/`offsets`, where `bounds` is already the page rect).
 * @param {string} text
 */
export function parseAtlasRegions(text) {
  const regions = [];
  let page = null;
  /** @type {Record<string, any>|null} */
  let r = null; // raw field accumulator for the current region
  const flush = () => { if (r) regions.push(finishRegion(r)); r = null; };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    if (/\.png$/i.test(line) && !line.includes(':')) { flush(); page = line; continue; }
    const c = line.indexOf(':');
    if (c === -1) { flush(); r = { name: line, page }; continue; }
    if (!r) continue; // page-header property (size/format/filter/repeat) — not a region's
    const key = line.slice(0, c).trim();
    const val = line.slice(c + 1).trim();
    const n = val.split(',').map((s) => parseInt(s, 10)).filter((x) => !Number.isNaN(x));
    if (key === 'rotate') r.rotate = (val === 'true' || n[0] === 90);
    else if (key === 'xy' && n.length >= 2) { r.px = n[0]; r.py = n[1]; }
    else if (key === 'size' && n.length >= 2) { r.sw = n[0]; r.sh = n[1]; }
    else if (key === 'orig' && n.length >= 2) { r.ow = n[0]; r.oh = n[1]; }
    else if (key === 'bounds' && n.length >= 4) { r.px = n[0]; r.py = n[1]; r.bw = n[2]; r.bh = n[3]; }
    else if (key === 'offsets' && n.length >= 4) { r.ow = n[2]; r.oh = n[3]; }
  }
  flush();
  return regions;
}

function finishRegion(r) {
  const rot = !!r.rotate;
  let x = r.px || 0, y = r.py || 0, w = 0, h = 0;
  if (r.bw != null) { w = r.bw; h = r.bh; }      // new format: bounds is the page rect as-is
  else if (r.sw != null) {                        // classic: size is the UNROTATED region size
    w = rot ? r.sh : r.sw;                        // rotated → on-page rect is swapped
    h = rot ? r.sw : r.sh;
  }
  const mw = r.ow != null ? r.ow : (r.sw || 0);   // original size (rotation-independent) for the dims gate
  const mh = r.oh != null ? r.oh : (r.sh || 0);
  return { name: r.name, page: r.page || null, x, y, w, h, rotate: rot, mw, mh };
}

/**
 * Group atlas regions that appear (by name) in more than one Spine atlas — the
 * same art baked into multiple skeletons. Pure: needs only the scan + a text
 * reader, so the `spine-dup` command, the browser report, and unit tests all
 * share it. Each group's `members` carry the page rect (a CropSpec source) so a
 * host can draw a thumbnail / confirm by pixels.
 * @param {import('../../../types/index.js').ScanResult} scan
 * @param {(p: string) => Promise<string>} readText
 */
export async function findSharedRegions(scan, readText) {
  const atlases = [...scan.assets.values()].filter((a) => a.type === 'spine-atlas' && a.hasSource);
  // skeleton(s) referencing each atlas (skeleton → atlas edge, kind 'spine-atlas')
  const spinesByAtlas = new Map();
  for (const e of scan.edges) {
    if (e.kind !== 'spine-atlas') continue;
    let s = spinesByAtlas.get(e.to); if (!s) spinesByAtlas.set(e.to, (s = new Set()));
    s.add(pathOf(scan, e.from));
  }

  const byRegion = new Map(); // region name -> [member]
  for (const atlas of atlases) {
    let text;
    try { text = await readText(atlas.path); } catch { continue; }
    const dir = atlas.path.slice(0, atlas.path.lastIndexOf('/'));
    const spines = [...(spinesByAtlas.get(atlas.uuid) || [])].sort();
    const seen = new Set();
    for (const reg of parseAtlasRegions(text)) {
      if (seen.has(reg.name)) continue; // same name twice in one atlas → count the atlas once
      seen.add(reg.name);
      let arr = byRegion.get(reg.name); if (!arr) byRegion.set(reg.name, (arr = []));
      arr.push({
        atlas: atlas.path,
        atlasUuid: atlas.uuid,
        page: reg.page ? (dir ? `${dir}/${reg.page}` : reg.page) : null,
        x: reg.x, y: reg.y, w: reg.w, h: reg.h, rotate: reg.rotate,
        mw: reg.mw, mh: reg.mh,
        spines,
      });
    }
  }

  const groups = [];
  for (const [name, members] of byRegion) {
    if (members.length < 2) continue; // packed into only one atlas — not shared
    const dims = [...new Set(members.map((m) => `${m.mw}x${m.mh}`))];
    const dimsConsistent = dims.length === 1 && !members.some((m) => !m.mw || !m.mh);
    const spines = [...new Set(members.flatMap((m) => m.spines))].sort();
    groups.push({
      name,
      atlasCount: members.length,
      confidence: dimsConsistent ? 'likely' : 'name-only',
      dimsConsistent,
      dims,
      spineCount: spines.length,
      spines,
      members,
    });
  }
  // strongest signal first: most atlases, dimension-confirmed, then by name.
  groups.sort((a, b) => b.atlasCount - a.atlasCount
    || Number(b.dimsConsistent) - Number(a.dimsConsistent)
    || a.name.localeCompare(b.name));
  return groups;
}

/** @param {import('../../../types/index.js').CommandContext} ctx */
async function runSpineDup(ctx) {
  const groups = await findSharedRegions(ctx.scan, ctx.readText);
  const atlasesScanned = [...ctx.scan.assets.values()].filter((a) => a.type === 'spine-atlas' && a.hasSource).length;
  const data = { groups, total: groups.length, atlasesScanned };
  return { data, text: renderSpineDup(data) };
}

function renderSpineDup(data) {
  if (!data.total) return `No image is packed into more than one Spine atlas (scanned ${data.atlasesScanned} atlas(es)).`;
  const lines = [`${data.total} image(s) packed into multiple Spine atlases (scanned ${data.atlasesScanned}):`, ''];
  for (const g of data.groups) {
    const dim = g.dimsConsistent ? ` ${g.dims[0]}`
      : (g.dims.length > 1 ? ` [dims differ: ${g.dims.join(' / ')} — possibly name-only]` : '');
    lines.push(`  ${g.name}${dim} — in ${g.atlasCount} atlases, used by ${g.spineCount} spine(s) [${g.confidence}]`);
    for (const m of g.members) lines.push(`      ${m.atlas}${m.spines.length ? `  ← ${m.spines.join(', ')}` : ''}`);
  }
  return lines.join('\n');
}
