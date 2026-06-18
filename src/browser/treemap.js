// Squarified treemap layout (Bruls, Huizing, van Wijk 2000) — pure geometry, no
// DOM, so it unit-tests in Node and the size-map SVG renderer just consumes its
// rects. Lays `items` (each `{ item, area }`, areas pre-scaled so Σarea === w*h)
// into the rect, greedily forming rows that keep cell aspect ratios near 1.
// Returns `[{ item, x, y, w, h }]` (input order not preserved — sort if needed).

function worstAspect(row, area, side) {
  const thick = area / side;
  let worst = 1;
  for (const c of row) {
    const len = c.area / thick;
    if (len > 0) worst = Math.max(worst, thick / len, len / thick);
  }
  return worst;
}

export function squarify(items, x, y, w, h) {
  const out = [];
  const remaining = items.filter((d) => d.area > 0);
  while (remaining.length) {
    const side = Math.min(w, h) || 1;
    // Grow a row while the worst aspect ratio doesn't get worse.
    let row = [];
    let area = 0;
    let best = Infinity;
    while (remaining.length) {
      const cand = remaining[0];
      const worst = worstAspect([...row, cand], area + cand.area, side);
      if (row.length === 0 || worst <= best) { row = [...row, cand]; area += cand.area; best = worst; remaining.shift(); }
      else break;
    }
    const thick = area / side; // row thickness (perpendicular to `side`)
    let pos = (w >= h) ? y : x;
    for (const c of row) {
      const len = c.area / thick; // extent along `side`
      if (w >= h) { out.push({ item: c.item, x, y: pos, w: thick, h: len }); }
      else { out.push({ item: c.item, x: pos, y, w: len, h: thick }); }
      pos += len;
    }
    if (w >= h) { x += thick; w -= thick; } else { y += thick; h -= thick; }
  }
  return out;
}
