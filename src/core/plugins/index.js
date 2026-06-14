// Built-in plugin registry — the in-repo plugins that ship with the tool. Both
// the core (scan.js) and the browser (app.js) import `PLUGINS`, so a built-in
// works in the CLI and the UI alike.
//
// External plugins are composed by the CALLER, never registered here, so they
// can live outside the repo: the CLI/node compose a `coir.plugins.mjs` config
// (coir-root = global, project-root = per-project) and `--plugin` files onto
// PLUGINS (see src/node/loadPlugins.js); the browser adds `window.coir.use(...)`
// runtime plugins. To add a BUILT-IN, drop a file beside this one and add it here.

import atlas from './atlas.js';
import font from './font.js';
import particle from './particle.js';
import spine from './spine.js';

export const BUILTIN_PLUGINS = [atlas, font, particle, spine];
export const PLUGINS = BUILTIN_PLUGINS; // external plugins are composed by callers, not registered here

// Collapse same-name plugins, keeping the LAST (later in the array overrides
// earlier). Callers compose `[...PLUGINS, ...global, ...project, ...adhoc]` in
// general→specific order, so a project/--plugin/use() plugin overrides a global
// or built-in of the same name instead of running twice. Unnamed plugins are
// always kept. Order follows each name's first appearance.
export function dedupePlugins(plugins) {
  const at = new Map(); // name -> index in out
  const out = [];
  for (const p of plugins) {
    const n = p && p.name;
    if (n && at.has(n)) out[at.get(n)] = p;       // later same-name wins, keeps position
    else { if (n) at.set(n, out.length); out.push(p); }
  }
  return out;
}
