// @ts-check
// Canonical "where in a prefab/scene" naming — shared by the browser usage
// popup / quick-open, the CLI `--where` output, and the edit selector grammar
// (editCli's compName callback). One source of truth so a DISPLAYED location
// reads back as a paste-able `nodePath:Comp.prop` selector. DOM-free, no I/O.
import { looksCompressed, decompressUuid, compressUuid } from './uuid.js';

const base = (p) => p.slice(p.lastIndexOf('/') + 1);

/**
 * A component `__type__` → its canonical name: a builtin/plugin class string
 * as-is (`cc.Sprite`, `sp.Skeleton`, a plugin's `ResSprite`), or a custom
 * script's class name (basename minus `.ts`/`.js`). This matches what the edit
 * selector whitelist accepts, so the name shown is the name you type. An
 * unresolved compressed uuid falls back to the raw token (display only).
 * @param {{assets: Map<string, any>}} scan
 * @param {string|null|undefined} raw
 * @returns {string}
 */
export function componentName(scan, raw) {
  if (!raw || typeof raw !== 'string') return '';
  if (looksCompressed(raw)) {
    const a = scan.assets.get(decompressUuid(raw));
    return a ? base(a.path).replace(/\.[jt]s$/i, '') : raw;
  }
  return raw;
}

/**
 * The paste-able edit selector for an edge location: `nodePath:Comp.prop`
 * (or just `nodePath` when there is no component). Returns null when there is
 * no nodePath — a meta-derived/structural edge that is not an edit target.
 * @returns {string|null}
 */
export function locSelector(scan, loc) {
  if (!loc || !loc.nodePath) return null;
  const comp = componentName(scan, loc.component);
  if (!comp) return loc.nodePath;
  return `${loc.nodePath}:${comp}${loc.property ? `.${loc.property}` : ''}`;
}

/**
 * Reverse of componentName: a class NAME → the `__type__` token Cocos serializes.
 * A builtin/namespaced name (`cc.Color`, `sp.Skeleton`) and an already-compressed
 * token pass through unchanged; a bare custom class name resolves to its script
 * asset's compressed uuid. Returns null when no such script exists (caller guards).
 * @param {{assets: Map<string, any>}} scan
 * @param {string} name
 * @returns {string|null}
 */
export function typeToken(scan, name) {
  if (!name || typeof name !== 'string') return name;
  if (name.includes('.') || looksCompressed(name)) return name; // builtin / already a token
  for (const a of scan.assets.values()) {
    if (a.type === 'script' && base(a.path).replace(/\.[jt]s$/i, '') === name) return compressUuid(a.uuid);
  }
  return null;
}
