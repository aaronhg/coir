// Embedder entry (Node): the headless API a host — e.g. a Cocos Creator editor
// extension — needs to run coir in-process: scan a project, build the graph, and
// encode a URL-hash topology snapshot. ESM, zero runtime deps. (The browser app
// has its own entry in src/browser/app.js; it does NOT import this barrel, which
// pulls in the node:fs FileProvider.)
export { scanProject } from './core/scan.js';
export { buildAdjacency, dependencyClosure, dependentClosure, neighbors } from './core/graph.js';
export { encodeTopo, decodeTopo, MAX_BLOB_CHARS } from './core/topohash.js';
export { makeFsProvider } from './node/fsProvider.js';
export { PLUGINS, BUILTIN_PLUGINS, dedupePlugins } from './core/plugins/index.js';
