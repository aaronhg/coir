// Unit tests for the squarified treemap layout that backs the size-map report
// (src/browser/treemap.js — pure geometry, no DOM). The invariants that matter
// for a correct size map: every cell stays inside the rect, the total area is
// conserved, and each cell's area matches its input weight.
//   node --test test/treemap.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { squarify } from '../src/browser/treemap.js';

test('fills the rect, conserves area, every cell within bounds and ∝ its weight', () => {
  const items = [{ item: 'a', area: 5000 }, { item: 'b', area: 3000 }, { item: 'c', area: 1500 }, { item: 'd', area: 500 }];
  const W = 100, H = 100; // Σarea = 10000 = W*H
  const rects = squarify(items, 0, 0, W, H);
  assert.equal(rects.length, 4);
  let total = 0;
  const areaOf = {};
  for (const r of rects) {
    assert.ok(r.x >= -1e-6 && r.y >= -1e-6 && r.x + r.w <= W + 1e-6 && r.y + r.h <= H + 1e-6, 'within bounds');
    total += r.w * r.h;
    areaOf[r.item] = r.w * r.h;
  }
  assert.ok(Math.abs(total - W * H) < 1, 'total area conserved');
  for (const it of items) assert.ok(Math.abs(areaOf[it.item] - it.area) < 1, `cell ${it.item} area ∝ weight`);
});

test('a single item fills the whole rect; zero-area items are dropped', () => {
  const r = squarify([{ item: 'x', area: 200 }, { item: 'z', area: 0 }], 0, 0, 20, 10);
  assert.equal(r.length, 1);
  assert.equal(r[0].w, 20);
  assert.equal(r[0].h, 10);
});
