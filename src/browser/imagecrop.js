// Browser-only image cropping + perceptual signatures for the visual report
// (Spine cross-atlas dup thumbnails + pixel confirmation). NOT in the DOM-free
// core — it needs createImageBitmap + canvas, which the browser gives for free.
// An atlas page is decoded ONCE and reused across all its regions.

const SIG = 16; // perceptual signature grid is SIG×SIG grayscale

// A per-hydrate bitmap cache: path -> Promise<ImageBitmap|null>. Build one per
// pass and dispose() it after (decoded bitmaps are closed to free memory).
export function makePageCache(provider) {
  const cache = new Map();
  return {
    get(path) {
      if (!cache.has(path)) {
        cache.set(path, (async () => {
          try { return await createImageBitmap(await provider.file(path)); }
          catch { return null; }
        })());
      }
      return cache.get(path);
    },
    async dispose() {
      for (const p of cache.values()) { const b = await p.catch(() => null); if (b && b.close) b.close(); }
      cache.clear();
    },
  };
}

// Draw a region's page rect into a dw×dh canvas, un-rotating a libGDX 90° pack so
// the thumbnail is upright. Direction is approximate (the confirmation pass below
// is rotation-invariant, so any residual rotation is purely cosmetic here).
function drawCrop(bitmap, crop, dw, dh) {
  const cv = document.createElement('canvas');
  cv.width = dw; cv.height = dh;
  const g = cv.getContext('2d');
  const { x, y, w, h, rotate } = crop;
  if (rotate) {
    g.translate(dw / 2, dh / 2);
    g.rotate(-Math.PI / 2);
    g.drawImage(bitmap, x, y, w, h, -dh / 2, -dw / 2, dh, dw);
  } else {
    g.drawImage(bitmap, x, y, w, h, 0, 0, dw, dh);
  }
  return cv;
}

// A thumbnail dataURL (PNG) of the region, longest side scaled to `max` px.
export async function cropThumb(cache, crop, max = 64) {
  const bm = await cache.get(crop.page);
  if (!bm || !crop.w || !crop.h) return null;
  const scale = Math.min(1, max / (Math.max(crop.w, crop.h) || 1));
  const dw = Math.max(1, Math.round(crop.w * scale));
  const dh = Math.max(1, Math.round(crop.h * scale));
  try { return drawCrop(bm, crop, dw, dh).toDataURL('image/png'); } catch { return null; }
}

// A SIG×SIG grayscale signature (Uint8Array) of the region, for pixel compare.
// Transparent pixels fold toward mid-grey so trim/whitespace differences between
// two packings matter less than the actual art.
export async function cropSignature(cache, crop) {
  const bm = await cache.get(crop.page);
  if (!bm || !crop.w || !crop.h) return null;
  let d;
  try { d = drawCrop(bm, crop, SIG, SIG).getContext('2d').getImageData(0, 0, SIG, SIG).data; }
  catch { return null; }
  const out = new Uint8Array(SIG * SIG);
  for (let i = 0; i < SIG * SIG; i++) {
    const a = d[i * 4 + 3] / 255;
    const luma = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    out[i] = Math.round(luma * a + 128 * (1 - a));
  }
  return out;
}

// Rotate a SIG×SIG grid 90° CW.
function rot90(a) {
  const b = new Uint8Array(a.length);
  for (let y = 0; y < SIG; y++) for (let x = 0; x < SIG; x++) b[x * SIG + (SIG - 1 - y)] = a[y * SIG + x];
  return b;
}

// Normalized L1 distance (0 = identical, 1 = opposite) between two signatures,
// taking the MIN over the 4 rotations of `b` — so a region packed rotated still
// matches its unrotated twin regardless of how we drew it.
export function sigDistance(a, b) {
  if (!a || !b) return 1;
  let best = 1, r = b;
  for (let k = 0; k < 4; k++) {
    let sum = 0; for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - r[i]);
    best = Math.min(best, sum / (a.length * 255));
    r = rot90(r);
  }
  return best;
}
