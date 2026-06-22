// @ts-check
// Node-only: load external plugin modules so a plugin can live OUTSIDE the coir
// repo. Callers append the results to the built-in registry. Sources:
//   • a `coir.plugins.mjs` (or .js) config in a directory — at the COIR repo
//     root it is a global/cross-project config; at a scanned project's root it
//     applies to that project only. (loadConfigPlugins)
//   • explicit `--plugin <file>` paths, repeatable. (loadPluginFiles)
//
// A config/plugin module's `default` export is a plugin object OR an array of
// them. Prefer `.mjs`: it is always ESM regardless of the directory's
// package.json `type` (a Cocos project is usually not `"type":"module"`, so a
// `.js` config with `export default` would fail to parse there).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const warnDefault = (m) => process.stderr.write(`${m}\n`);

// Import one module file → flat array of plugin objects. A parse/load error or a
// missing default export warns and yields [] (never throws — a broken external
// plugin must not abort the whole scan).
/** @typedef {import('../../types/index.js').Plugin} Plugin */

/**
 * @param {string} absPath
 * @param {(m: string) => void} warn
 * @returns {Promise<Plugin[]>}
 */
async function loadOne(absPath, warn) {
  try {
    const mod = await import(pathToFileURL(absPath).href);
    const exp = mod.default ?? mod.plugins;
    if (exp == null) { warn(`⚠ ${path.basename(absPath)}: no default export (expected a plugin or an array of plugins)`); return []; }
    const arr = Array.isArray(exp) ? exp : [exp];
    return arr.filter((p) => p && typeof p === 'object');
  } catch (e) {
    warn(`⚠ failed to load plugin ${path.basename(absPath)}: ${e.message}`);
    return [];
  }
}

// Locate `<dir>/coir.plugins.mjs` (then .js); null if absent.
/** @param {string} dir @returns {Promise<string|null>} */
async function configPluginPath(dir) {
  for (const name of ['coir.plugins.mjs', 'coir.plugins.js']) {
    const abs = path.join(dir, name);
    try { await fs.access(abs); return abs; } catch { /* try next */ }
  }
  return null;
}

// Auto-load `<dir>/coir.plugins.mjs` (then .js) if present. Absent config is
// normal → []. Use this for the COIR-ROOT global config (the user's own) and for
// explicit paths; a SCANNED PROJECT's config goes through loadProjectConfigPlugins
// (the trust gate) instead.
/**
 * @param {string} dir
 * @param {(m: string) => void} [warn]
 * @returns {Promise<Plugin[]>}
 */
export async function loadConfigPlugins(dir, warn = warnDefault) {
  const abs = await configPluginPath(dir);
  return abs ? loadOne(abs, warn) : [];
}

// A scanned PROJECT's coir.plugins.mjs is a TRUST BOUNDARY: importing it runs
// arbitrary Node code from a project you may not control (you scanned it, you
// didn't necessarily write it). So it loads ONLY when explicitly trusted —
// otherwise its presence is REPORTED (neither silently run nor silently skipped)
// with how to enable it. The coir-root global config and `--plugin` files are the
// user's own → always loaded (loadConfigPlugins / loadPluginFiles).
/**
 * @param {string} dir
 * @param {{ trusted?: boolean, warn?: (m: string) => void }} [opts]
 * @returns {Promise<Plugin[]>}
 */
export async function loadProjectConfigPlugins(dir, { trusted = false, warn = warnDefault } = {}) {
  const abs = await configPluginPath(dir);
  if (!abs) return [];
  if (!trusted) {
    warn(`⚠ ${path.basename(abs)} found in the project but NOT loaded — a project-supplied plugin runs arbitrary code on scan.`);
    warn('  Trust it with --trust-project-plugins (or env COIR_TRUST_PROJECT_PLUGINS=1) to load it.');
    return [];
  }
  return loadOne(abs, warn);
}

// Load each `--plugin <file>` path (relative paths resolved against the cwd). A
// bad path warns (the user typed it) and is skipped.
/**
 * @param {string[]} paths
 * @param {(m: string) => void} [warn]
 * @returns {Promise<Plugin[]>}
 */
export async function loadPluginFiles(paths, warn = warnDefault) {
  const out = [];
  for (const p of paths || []) out.push(...await loadOne(path.resolve(p), warn));
  return out;
}
