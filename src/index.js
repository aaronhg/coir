// Embedder entry (Node): the headless API a host — e.g. a Cocos Creator editor
// extension — needs to run coir in-process: scan a project, build the graph, and
// encode a URL-hash topology snapshot. ESM, zero runtime deps. (The browser app
// has its own entry in src/browser/app.js; it does NOT import this barrel, which
// pulls in the node:fs FileProvider.)
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export { scanProject } from './core/scan.js';
export { buildAdjacency, dependencyClosure, dependentClosure, neighbors } from './core/graph.js';
export { encodeTopo, decodeTopo, MAX_BLOB_CHARS } from './core/topohash.js';
export { makeFsProvider, readCocosVersion } from './node/fsProvider.js';
export { PLUGINS, BUILTIN_PLUGINS, dedupePlugins } from './core/plugins/index.js';
export { loadConfigPlugins, loadProjectConfigPlugins, loadPluginFiles } from './node/loadPlugins.js';

// The coir repo root (this file is <root>/src/index.js). A host — e.g. the Cocos
// extension — passes this to loadConfigPlugins to pick up the repo-root GLOBAL
// `coir.plugins.mjs` (the cross-project config the CLI/node-run also auto-load),
// so plugins like audio-call apply without copying a config into every project.
export const COIR_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
