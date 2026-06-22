// @ts-check
// Node-only: load external plugin modules so a plugin can live OUTSIDE the coir
// repo. Callers append the results to the built-in registry. Two config files per
// directory, split by host capability:
//   • `coir.plugins.mjs` — PORTABLE: pure-graph, self-contained (no relative imports,
//     no node APIs). Loaded by EVERY host (the browser blob-imports it too).
//   • `coir.plugins.node.mjs` — NODE-only: free to `import` siblings (split a big
//     config across files), use `fs`/`child_process`, add `commands`. Loaded by node
//     hosts ONLY (CLI/MCP/editor); the browser can't resolve imports / run node APIs
//     so it skips this file. ("Node" = the runtime, not just the `coir` CLI.)
// At the COIR repo root these are the global/cross-project config; at a scanned
// project's root they apply to that project only (and are trust-gated). Plus explicit
// `--plugin <file>` paths (loadPluginFiles).
//
// A config module's `default` export is a plugin OR an array of them. Prefer `.mjs`
// (always ESM regardless of the dir's package.json `type`).

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

// Two config files per dir, by host capability:
//   • PORTABLE `coir.plugins.mjs` (.js) — pure-graph, self-contained (no relative
//     imports, no node APIs). Loaded by EVERY host (browser too — see src/browser/app.js).
//   • NODE `coir.plugins.node.mjs` (.node.js) — free to `import` siblings / use fs /
//     add `commands`. Loaded by node hosts ONLY (CLI/MCP/editor); the browser skips it
//     (it can't resolve imports or run node APIs). "Node" = the runtime, not just the CLI.
const PORTABLE_NAMES = ['coir.plugins.mjs', 'coir.plugins.js'];
const NODE_NAMES = ['coir.plugins.node.mjs', 'coir.plugins.node.js'];

/** First existing `<dir>/<name>` from a candidate list; null if none. @param {string} dir @param {string[]} names */
async function firstExisting(dir, names) {
  for (const name of names) {
    const abs = path.join(dir, name);
    try { await fs.access(abs); return abs; } catch { /* try next */ }
  }
  return null;
}

// Auto-load a dir's PORTABLE + NODE config (whichever exist) for a NODE host. Absent
// config is normal → []. Use this for the COIR-ROOT global config (the user's own);
// a SCANNED PROJECT's config goes through loadProjectConfigPlugins (the trust gate).
/**
 * @param {string} dir
 * @param {(m: string) => void} [warn]
 * @returns {Promise<Plugin[]>}
 */
export async function loadConfigPlugins(dir, warn = warnDefault) {
  const out = [];
  for (const names of [PORTABLE_NAMES, NODE_NAMES]) {
    const abs = await firstExisting(dir, names);
    if (abs) out.push(...await loadOne(abs, warn));
  }
  return out;
}

// A scanned PROJECT's config runs arbitrary Node code on scan, so it is a trust
// point. It loads by DEFAULT (the common case — you scan your own projects); the host
// passes `trusted:false` to opt out (--no-trust-project-plugins / COIR_TRUST_PROJECT_PLUGINS=0,
// e.g. for an untrusted third-party project), and then its presence is REPORTED, not
// silently run. Loads BOTH the portable and the node config (the trust gate covers both).
/**
 * @param {string} dir
 * @param {{ trusted?: boolean, warn?: (m: string) => void }} [opts]
 * @returns {Promise<Plugin[]>}
 */
export async function loadProjectConfigPlugins(dir, { trusted = false, warn = warnDefault } = {}) {
  const found = [];
  for (const names of [PORTABLE_NAMES, NODE_NAMES]) { const abs = await firstExisting(dir, names); if (abs) found.push(abs); }
  if (!found.length) return [];
  if (!trusted) {
    warn(`⚠ ${found.map((f) => path.basename(f)).join(' + ')} found in the project but NOT loaded — trust is disabled (--no-trust-project-plugins / COIR_TRUST_PROJECT_PLUGINS=0).`);
    return [];
  }
  const out = [];
  for (const abs of found) out.push(...await loadOne(abs, warn));
  return out;
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
