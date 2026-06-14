// Public type declarations for coir — the parse data model and the plugin
// contract. Hand-authored (the source stays .js + JSDoc); shipped via the
// package "types" field so external plugin authors get autocomplete:
//
//   /** @type {import('coir').Plugin} */
//   export default { name: 'audio-call', async edges(ctx) { /* ctx is typed */ } };

/** Environment-agnostic file access; all paths are POSIX-relative to assets/. */
export interface FileProvider {
  listFiles(): Promise<string[]>;
  readText(path: string): Promise<string>;
  size(path: string): Promise<number>;
}

/** A sub-asset declared in a .meta's subMetas (e.g. a sprite-frame in an atlas). */
export interface SubAsset {
  subId: string;
  uuid: string | null;
  kind: string; // the sub's importer, e.g. 'sprite-frame' | 'texture'
  name: string;
  userData: Record<string, any> | null;
}

/** An indexed asset (a record in scan.assets), keyed by uuid. */
export interface Asset {
  uuid: string;
  path: string; // source path, POSIX-relative to assets/
  metaPath: string;
  ext: string;
  importer: string;
  type: string; // normalized, plugin-extensible (NOT a closed union)
  userData: Record<string, any> | null;
  subAssets: SubAsset[];
  hasSource: boolean;
  size: number;
  inResources: boolean;
  in: number; // in-degree
  out: number; // out-degree
}

/** Where/how one edge is used inside a prefab/scene (from edge.locations). */
export interface EdgeLocation {
  nodePath: string | null;
  component: string | null; // a builtin class name, or a compressed __type__ uuid
  property: string | null;
  subName?: string | null;
}

/** A dependency edge: `from` (uuid) depends on `to` (uuid) via `kind`. */
export interface Edge {
  from: string;
  to: string;
  kind: string; // asset type / sub kind / 'script' / 'texture' / 'extends' / plugin-defined
  weight: number;
  locations: EdgeLocation[];
}

export interface SubOwner { owner: string; kind: string; name: string; }

/** Out/in adjacency over the edges (attached to a scan as `scan.adjacency`). */
export interface Adjacency {
  out: Map<string, { to: string; kind: string; weight: number }[]>;
  inc: Map<string, { from: string; kind: string; weight: number }[]>;
}

/** The contract object scanProject returns — the boundary between core and UI. */
export interface ScanResult {
  assets: Map<string, Asset>;
  byPath: Map<string, Asset>;
  edges: Edge[];
  subOwner: Map<string, SubOwner>;
  subUsage: Map<string, Set<string>>;
  orphanRefs: { from: string; ref: string; loc?: EdgeLocation | null }[];
  metaErrors: { metaPath: string; error: string }[];
  missing: Map<string, string>; // uuid (+sub-uuids) -> intended path of a dropped source-less meta
  missingReferenced: Set<string>; // dropped paths something still points at
  files: string[];
  rootTypes: Set<string>; // plugin-declared never-unused types
  adjacency?: Adjacency; // attached post-scan by buildAdjacency
}

/**
 * The object a plugin's `edges(ctx)` receives: the finalized asset index plus
 * the same primitives the core uses to mutate the graph. A plugin imports
 * nothing — it uses only ctx — so a third-party plugin needs no build step.
 */
export interface PluginContext {
  assets: Map<string, Asset>;
  byPath: Map<string, Asset>;
  subOwner: Map<string, SubOwner>;
  subUsage: Map<string, Set<string>>;
  missing: Map<string, string>;
  missingByPath: Map<string, string>;
  missingReferenced: Set<string>;
  addEdge(from: string, to: string, kind: string, loc?: EdgeLocation | null): void;
  resolveUuid(from: string, ref: string, loc?: EdgeLocation | null): void;
  noteSub(owner: string, sub: string | null): void;
  readText(path: string): Promise<string>;
  mapLimit<T, R>(
    items: T[],
    limit: number,
    fn: (item: T, index: number) => Promise<R>,
    onTick?: (done: number, total: number) => void
  ): Promise<R[]>;
  uuid: {
    mainUuid(ref: string): string;
    subOf(ref: string): string | null;
    looksCompressed(token: string): boolean;
    decompressUuid(token: string): string;
  };
  /** Read-only view of the component/extends graph built during script pruning. */
  scripts: {
    isComp: Set<string>;
    baseName: Map<string, string>;
    definers: Map<string, string[]>;
    text: Map<string, string>; // scriptUuid -> source text
  };
}

/**
 * A coir plugin. All fields are optional except `name`. Core reads the type/edge
 * fields; the browser reads `colors`/`messages`. Built-ins live in
 * src/core/plugins/; external ones load via coir.plugins.mjs / --plugin /
 * window.coir.use().
 */
export interface Plugin {
  name: string;
  importerTypes?: Record<string, string>; // importer -> type
  typeByExt?: Record<string, string>; // ext (with dot) -> type
  jsonSourceExts?: string[]; // extra source exts walked for __uuid__/__type__ refs
  rootTypes?: string[]; // types that are never "unused"
  colors?: Record<string, string>; // type -> hex (browser UI)
  messages?: Record<string, Record<string, string>>; // locale -> key -> string (browser i18n)
  edges?(ctx: PluginContext): void | Promise<void>;
}

export interface ScanOptions {
  plugins?: Plugin[];
  onProgress?(p: { phase: string; done: number; total: number }): void;
}
