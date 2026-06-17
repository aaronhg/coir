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
  virtual?: boolean; // a plugin-added non-asset node (no file); excluded from health reports
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
  label?: string; // optional plugin-supplied description (display/search); falls back to kind + endpoints
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
  addEdge(from: string, to: string, kind: string, loc?: EdgeLocation | null, label?: string): void;
  resolveUuid(from: string, ref: string, loc?: EdgeLocation | null): void;
  noteSub(owner: string, sub: string | null): void;
  /**
   * Add a VIRTUAL node — a non-asset topology node a plugin discovers (an event,
   * a notification, a route — anything with no `.meta`/file). It joins the graph
   * (edges + degrees) but is `virtual:true`/`hasSource:false`, so the asset-health
   * reports skip it. Idempotent by key; returns the stable key to wire edges to.
   */
  addNode(node: { path: string; type: string; ext?: string; importer?: string; size?: number; subAssets?: SubAsset[]; userData?: any; uuid?: string }): string;
  /** Every asset-relative path the FileProvider lists (incl. `.meta`) — the formal entry to read any source via `readText`. */
  files: string[];
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
  /**
   * Commands this plugin contributes. Registered ONCE: a command runs as
   * `coir <name> …` on the CLI and — when it carries an `inputSchema` — is ALSO
   * exposed as an MCP tool (`coir mcp`). Built-ins always win: a `name` that
   * collides with deps/uses/closure/find/info/analyze/edit/mcp is ignored with a
   * warning. CLI commands are listed in `coir --help`.
   */
  commands?: PluginCommand[];
  /**
   * Asset right-click menus this plugin contributes to an editor (e.g. the Cocos
   * Creator extension). Independent of `commands` — a plugin can ship only
   * `assetMenus` (a pure "asset-menu plugin"). Each matching asset (by `ext`
   * and/or `type`) gets a submenu titled `label` whose rows are returned by
   * `rows(ctx)`. The host runs `rows` in the background and caches the result
   * (the menu render must be synchronous); CLI/MCP ignore this field. See
   * cocos-extension/.
   */
  assetMenus?: AssetMenu[];
}

/**
 * A command contributed by a plugin. The same definition serves the CLI and (when
 * `inputSchema` is present) MCP: `run(ctx)` RETURNS its result and never prints —
 * each host presents it (CLI prints `text`, or JSON on `-o json`; MCP returns
 * `data`).
 */
export interface PluginCommand {
  name: string; // the subcommand / tool token: `coir <name> …`
  usage?: string; // one-line usage shown under "Plugin commands" in `coir --help`
  description?: string; // MCP tool description (falls back to usage)
  /** JSON Schema for the args object. Present → the command is ALSO an MCP tool. */
  inputSchema?: object;
  /** Names mapping CLI positionals → `ctx.args` keys (so it matches the MCP JSON shape). Defaults to the inputSchema property order. A trailing `?` marks optional. */
  positional?: string[];
  run(ctx: CommandContext): CommandResult | void | Promise<CommandResult | void>;
}

/**
 * A plugin's contribution to an editor's asset right-click menu — its own thing,
 * NOT tied to a command. A matching asset gets a submenu titled `label`; `rows`
 * computes the entries from the asset itself (read its source via `ctx.readText`,
 * resolve siblings via `ctx.scan`). Return [] for "nothing to show".
 */
export interface AssetMenu {
  ext?: string[]; // source extensions that get this menu (lowercased, with dot), e.g. ['.anim']
  types?: string[]; // coir asset types that get this menu, e.g. ['anim'] (matched in addition to ext)
  label?: string; // submenu title
  rows(ctx: AssetMenuContext): { label: string }[] | Promise<{ label: string }[]>;
}

/** What an `AssetMenu.rows(ctx)` receives — the matched asset plus scan/IO helpers. */
export interface AssetMenuContext {
  asset: Asset; // the matched asset (path / uuid / type / ext)
  scan: ScanResult; // the finished scan (e.g. to find a sibling .atlas of a .skel)
  projectDir: string; // project root (for reading a binary source directly, e.g. a .skel)
  readText(path: string): Promise<string>; // read any source under assets/ (POSIX-relative)
}

/** What a command's `run` returns: `data` (structured, for `-o json` / MCP) and/or `text` (human CLI output); or an `error`. */
export type CommandResult =
  | { data?: any; text?: string }
  | { error: string; candidates?: string[] };

/**
 * What a command's `run(ctx)` receives — the finished scan plus resolution/IO
 * helpers, normalized so one `run` works in both hosts. `args` is a NAMED object
 * (CLI positionals mapped via `positional`; MCP's JSON arguments). `env` lets a
 * command branch if it must.
 */
export interface CommandContext {
  env: 'cli' | 'mcp';
  command: string; // the invoked command name
  args: Record<string, any>; // named args (same shape in both hosts)
  argv?: string[]; // CLI only: raw positionals (escape hatch)
  flags?: Record<string, any>; // CLI only: parsed flags (json, limit, depth, where, types:Set, …); {} in MCP
  projectDir: string;
  scan: ScanResult;
  readText(path: string): Promise<string>; // read any source under assets/ (POSIX-relative)
  resolveAsset(query: string): string; // path/basename/uuid[@sub] → uuid; on miss the CLI prints candidates + exits 2, MCP throws (→ a clean tool error)
  edgeMaps(): { out: Map<string, Edge[]>; inc: Map<string, Edge[]> };
  uuid: {
    mainUuid(ref: string): string;
    subOf(ref: string): string | null;
    looksCompressed(token: string): boolean;
    decompressUuid(token: string): string;
  };
  util: { base(p: string): string; kb(n: number): string };
}

export interface ScanOptions {
  plugins?: Plugin[];
  onProgress?(p: { phase: string; done: number; total: number }): void;
}
