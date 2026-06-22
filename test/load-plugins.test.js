// The node config loader (src/node/loadPlugins.js): the two-file split —
// coir.plugins.mjs (PORTABLE) + coir.plugins.node.mjs (NODE-only, free imports).
// Node hosts load BOTH; the browser (app.js) loads only the portable one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfigPlugins, loadProjectConfigPlugins } from '../src/node/loadPlugins.js';

const tmp = (files) => {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'coir-lp-'));
  for (const [name, body] of Object.entries(files)) fsSync.writeFileSync(path.join(dir, name), body);
  return dir;
};
const silent = () => {};
const names = (ps) => ps.map((p) => p.name).sort();

test('loadConfigPlugins loads BOTH the portable + node config (node one may import siblings / use node APIs)', async () => {
  const dir = tmp({
    'coir.plugins.mjs': 'export default { name: "portable", colors: { x: "#000" } };',
    'helper.mjs': 'export const NAME = "node-plug";',
    'coir.plugins.node.mjs': 'import { NAME } from "./helper.mjs"; import fs from "node:fs"; void fs; export default { name: NAME, commands: [{ name: "x", run: () => ({ text: "" }) }] };',
  });
  assert.deepEqual(names(await loadConfigPlugins(dir, silent)), ['node-plug', 'portable']);
  fsSync.rmSync(dir, { recursive: true, force: true });
});

test('loadConfigPlugins: only portable / only node / neither', async () => {
  let dir = tmp({ 'coir.plugins.mjs': 'export default { name: "p" };' });
  assert.deepEqual(names(await loadConfigPlugins(dir, silent)), ['p']);
  fsSync.rmSync(dir, { recursive: true, force: true });
  dir = tmp({ 'coir.plugins.node.mjs': 'export default { name: "n" };' });
  assert.deepEqual(names(await loadConfigPlugins(dir, silent)), ['n']);
  fsSync.rmSync(dir, { recursive: true, force: true });
  dir = tmp({});
  assert.deepEqual(await loadConfigPlugins(dir, silent), []);
  fsSync.rmSync(dir, { recursive: true, force: true });
});

test('loadProjectConfigPlugins: trusted loads both; untrusted warns (names both) + skips', async () => {
  const dir = tmp({
    'coir.plugins.mjs': 'export default { name: "p" };',
    'coir.plugins.node.mjs': 'export default { name: "n" };',
  });
  assert.deepEqual(names(await loadProjectConfigPlugins(dir, { trusted: true, warn: silent })), ['n', 'p']);
  let warned = '';
  const skipped = await loadProjectConfigPlugins(dir, { trusted: false, warn: (m) => { warned += m; } });
  assert.deepEqual(skipped, []);
  assert.match(warned, /NOT loaded/);
  assert.match(warned, /coir\.plugins\.mjs \+ coir\.plugins\.node\.mjs/); // the warning names BOTH found files
  fsSync.rmSync(dir, { recursive: true, force: true });
});
