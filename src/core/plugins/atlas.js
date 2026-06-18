// Sprite-atlas (.plist) plugin: the `atlas` type, atlas→texture edges, and the
// `atlas-dup` command + report (the same frame baked into more than one .plist —
// the Cocos analogue of spine-dup, reusing the browser visual-report hook).
//
// A plugin is a plain object. The core reads `importerTypes`/`typeByExt` (phase 1
// type assignment) and `edges(ctx)` (run after the asset index is final). The
// browser additionally reads `colors`/`messages`/`reports`. `edges` uses only
// `ctx` helpers — it imports nothing — so a third-party plugin needs no build step.

// @ts-check
/** @typedef {import('../../../types/index.js').Plugin} Plugin */

/** @type {Plugin} */
export default {
  name: 'atlas',
  importerTypes: { 'sprite-atlas': 'atlas' },
  colors: { atlas: '#ba68c8' },
  messages: {
    'zh-Hant': { 'atlasdup.title': 'Plist 跨圖集重複圖' },
    en: { 'atlasdup.title': 'Shared frames across .plist atlases' },
  },

  commands: [
    {
      name: 'atlas-dup',
      usage: 'coir atlas-dup   frame(s) packed into more than one .plist atlas (cross-atlas reuse)',
      description:
        'List sprite frames packed into more than one .plist sprite-atlas — the same art baked into multiple '
        + 'atlas pages, which whole-file dedup can never catch (each page is a different texture). Heuristic: frames '
        + 'are matched by name, corroborated by source dimensions (confidence: "likely" = dims agree, "name-only" = differ).',
      inputSchema: { type: 'object', properties: {} },
      positional: [],
      run: runAtlasDup,
    },
  ],

  // Browser-only report (報告 tab): same shared-frame groups, each member carrying
  // a CropSpec so the host draws a thumbnail per atlas + confirms by pixels.
  reports: [
    {
      id: 'atlas-dup',
      title: 'atlasdup.title',
      async build({ scan, readText }) {
        const groups = await findSharedFrames(scan, readText);
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

// ---------------------------------------------------------------------------
// atlas-dup: same frame packed into more than one .plist atlas.
// Mirrors spine-dup but parses the .plist (XML) for per-frame rects instead of an
// .atlas text. The page rect feeds the same browser thumbnail + pixel-confirm.
// ---------------------------------------------------------------------------

const pathOf = (scan, uuid) => { const a = scan.assets.get(uuid); return a ? a.path : uuid; };

/**
 * Parse a Cocos/TexturePacker `.plist` sprite-atlas into:
 *   `{ texture, frames: [{ name, x, y, w, h, rotate, mw, mh }] }`
 * where (x,y,w,h) is the frame's rect ON THE PAGE (ready to crop; a rotated frame
 * swaps w/h) and (mw,mh) is its source size (rotation-independent, for the dims
 * gate). Handles format 2 (`frame`/`rotated`/`sourceSize`) and format 3
 * (`textureRect`/`textureRotated`/`spriteSourceSize`). DOM-free string parsing —
 * each frame's <dict> is flat, so a depth-aware slice of the `frames` dict plus a
 * per-frame regex suffices.
 * @param {string} text
 */
export function parsePlistFrames(text) {
  const texture = (text.match(/<key>textureFileName<\/key>\s*<string>([^<]+)<\/string>/)
    || text.match(/<key>realTextureFileName<\/key>\s*<string>([^<]+)<\/string>/) || [])[1] || null;
  const inner = sliceDict(text, 'frames');
  const frames = [];
  if (inner) {
    const re = /<key>([^<]+)<\/key>\s*<dict>([\s\S]*?)<\/dict>/g;
    let m;
    while ((m = re.exec(inner))) {
      const name = m[1], body = m[2];
      const rectStr = (body.match(/<key>(?:frame|textureRect)<\/key>\s*<string>([^<]+)<\/string>/) || [])[1];
      const r = rectStr && rectStr.match(/\{\{(-?\d+)\s*,\s*(-?\d+)\}\s*,\s*\{(-?\d+)\s*,\s*(-?\d+)\}\}/);
      if (!r) continue;
      const rotate = /<key>(?:texture)?[rR]otated<\/key>\s*<true\/>/.test(body);
      const ss = (body.match(/<key>(?:sourceSize|spriteSourceSize)<\/key>\s*<string>([^<]+)<\/string>/) || [])[1];
      const sm = ss && ss.match(/\{(-?\d+)\s*,\s*(-?\d+)\}/);
      const fx = +r[1], fy = +r[2], fw = +r[3], fh = +r[4];
      frames.push({
        name,
        x: fx, y: fy,
        w: rotate ? fh : fw, // on-page rect: a rotated frame occupies h×w
        h: rotate ? fw : fh,
        rotate,
        mw: sm ? +sm[1] : fw, // source (unrotated) size for the dims gate
        mh: sm ? +sm[2] : fh,
      });
    }
  }
  return { texture, frames };
}

// Inner XML of a top-level <key>NAME</key><dict>…</dict>, depth-aware (frame dicts
// are flat, but the `frames`/`metadata` value dicts nest).
function sliceDict(text, keyName) {
  const k = text.indexOf(`<key>${keyName}</key>`);
  if (k < 0) return '';
  const open = text.indexOf('<dict>', k);
  if (open < 0) return '';
  let i = open + 6, depth = 1;
  while (i < text.length && depth > 0) {
    const nd = text.indexOf('<dict>', i), cd = text.indexOf('</dict>', i);
    if (cd < 0) break;
    if (nd >= 0 && nd < cd) { depth++; i = nd + 6; } else { depth--; i = cd + 7; }
  }
  return text.slice(open + 6, Math.max(open + 6, i - 7));
}

/**
 * Group frames that appear (by name) in more than one .plist atlas. Pure: needs
 * only the scan + a text reader (shared by the command, the report, and tests).
 * Each member carries the page rect (a CropSpec source) for thumbnails / pixel
 * confirmation.
 * @param {import('../../../types/index.js').ScanResult} scan
 * @param {(p: string) => Promise<string>} readText
 */
export async function findSharedFrames(scan, readText) {
  const atlases = [...scan.assets.values()].filter((a) => a.type === 'atlas' && a.hasSource);
  const atlasUuids = new Set(atlases.map((a) => a.uuid));
  // whoever references each atlas (any incoming edge) — the "used by" hint.
  const usersByAtlas = new Map();
  for (const e of scan.edges) {
    if (!atlasUuids.has(e.to)) continue;
    let s = usersByAtlas.get(e.to); if (!s) usersByAtlas.set(e.to, (s = new Set()));
    s.add(pathOf(scan, e.from));
  }

  const byFrame = new Map(); // frame name -> [member]
  for (const atlas of atlases) {
    let text; try { text = await readText(atlas.path); } catch { continue; }
    const { texture, frames } = parsePlistFrames(text);
    if (!frames.length) continue;
    const dir = atlas.path.slice(0, atlas.path.lastIndexOf('/'));
    const page = texture ? (dir ? `${dir}/${texture}` : texture) : null;
    const users = [...(usersByAtlas.get(atlas.uuid) || [])].sort();
    const seen = new Set();
    for (const f of frames) {
      if (seen.has(f.name)) continue;
      seen.add(f.name);
      let arr = byFrame.get(f.name); if (!arr) byFrame.set(f.name, (arr = []));
      arr.push({ atlas: atlas.path, atlasUuid: atlas.uuid, page, x: f.x, y: f.y, w: f.w, h: f.h, rotate: f.rotate, mw: f.mw, mh: f.mh, users });
    }
  }

  const groups = [];
  for (const [name, members] of byFrame) {
    if (members.length < 2) continue; // in only one atlas — not shared
    const dims = [...new Set(members.map((m) => `${m.mw}x${m.mh}`))];
    const dimsConsistent = dims.length === 1 && !members.some((m) => !m.mw || !m.mh);
    const users = [...new Set(members.flatMap((m) => m.users))].sort();
    groups.push({ name, atlasCount: members.length, confidence: dimsConsistent ? 'likely' : 'name-only', dimsConsistent, dims, userCount: users.length, users, members });
  }
  groups.sort((a, b) => b.atlasCount - a.atlasCount || Number(b.dimsConsistent) - Number(a.dimsConsistent) || a.name.localeCompare(b.name));
  return groups;
}

/** @param {import('../../../types/index.js').CommandContext} ctx */
async function runAtlasDup(ctx) {
  const groups = await findSharedFrames(ctx.scan, ctx.readText);
  const atlasesScanned = [...ctx.scan.assets.values()].filter((a) => a.type === 'atlas' && a.hasSource).length;
  const data = { groups, total: groups.length, atlasesScanned };
  return { data, text: renderAtlasDup(data) };
}

function renderAtlasDup(data) {
  if (!data.total) return `No frame is packed into more than one .plist atlas (scanned ${data.atlasesScanned} atlas(es)).`;
  const lines = [`${data.total} frame(s) packed into multiple .plist atlases (scanned ${data.atlasesScanned}):`, ''];
  for (const g of data.groups) {
    const dim = g.dimsConsistent ? ` ${g.dims[0]}`
      : (g.dims.length > 1 ? ` [dims differ: ${g.dims.join(' / ')} — possibly name-only]` : '');
    lines.push(`  ${g.name}${dim} — in ${g.atlasCount} atlases, used by ${g.userCount} ref(s) [${g.confidence}]`);
    for (const m of g.members) lines.push(`      ${m.atlas}${m.users.length ? `  ← ${m.users.join(', ')}` : ''}`);
  }
  return lines.join('\n');
}
