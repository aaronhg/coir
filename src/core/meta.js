// @ts-check
// Parse a Cocos Creator 3.x `.meta` file into a normalized asset record.
//
// A `.meta` is JSON: { ver, importer, uuid, files, subMetas, userData }.
// `subMetas` maps a short sub-id (e.g. "6c48a") to a sub-asset whose uuid is
// "<mainUuid>@<subId>" and whose `importer` is the sub-asset kind
// ("texture", "sprite-frame", ...). Sub-metas can nest (image -> texture).

// importer value -> normalized node type (built-in BASELINE). Types that also
// carry edge logic — atlas, font, particle, spine, plus the ext-derived
// spine-atlas — live in their plugin under src/core/plugins/ and are merged on
// top via buildTypeResolver. With no plugins this baseline is what you get.
const IMPORTER_TYPE = {
  image: 'image',
  texture: 'texture',
  'sprite-frame': 'sprite-frame',
  prefab: 'prefab',
  scene: 'scene',
  typescript: 'script',
  javascript: 'script',
  'audio-clip': 'audio',
  material: 'material',
  effect: 'effect',
  'animation-clip': 'anim',
  json: 'json',
  'physics-material': 'physics-material',
};

// Build the importer/ext → type resolver, merging plugin `importerTypes` and
// `typeByExt` over the baseline. Importer match wins, then ext, then the
// extension-derived fallback (so project-specific types still resolve). Passing
// the built-in plugin set reproduces the original mapping exactly.
export function buildTypeResolver(plugins = []) {
  const importerTypes = { ...IMPORTER_TYPE };
  const typeByExt = {};
  for (const p of plugins) {
    if (p.importerTypes) Object.assign(importerTypes, p.importerTypes);
    if (p.typeByExt) Object.assign(typeByExt, p.typeByExt);
  }
  return (importer, ext) => {
    if (importerTypes[importer]) return importerTypes[importer];
    if (ext && typeByExt[ext]) return typeByExt[ext]; // e.g. spine's ".atlas" (importer "*")
    if (importer === '*' || importer == null) return ext ? ext.slice(1) : 'unknown';
    return importer;
  };
}

// The stable type vocabulary for help text / discoverability — the baseline plus
// every type any plugin can assign. NOT a closed set (the resolver still falls
// back to the file extension for unknown importers).
export function knownTypes(plugins = []) {
  const types = new Set(Object.values(IMPORTER_TYPE));
  for (const p of plugins) {
    for (const v of Object.values(p.importerTypes || {})) types.add(v);
    for (const v of Object.values(p.typeByExt || {})) types.add(v);
  }
  return [...types].sort();
}

const defaultResolve = buildTypeResolver();

function lower(s) {
  return typeof s === 'string' ? s.toLowerCase() : s;
}

function extOf(path) {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  return dot > slash ? lower(path.slice(dot)) : '';
}

// Collect every sub-asset (recursively) declared in a meta's subMetas.
function collectSubAssets(subMetas, out) {
  if (!subMetas) return;
  for (const id of Object.keys(subMetas)) {
    const sm = subMetas[id];
    if (!sm || typeof sm !== 'object') continue;
    out.push({
      subId: id,
      uuid: sm.uuid || null,
      kind: sm.importer || 'unknown',
      name: sm.name || sm.displayName || id,
      userData: sm.userData || null,
    });
    if (sm.subMetas) collectSubAssets(sm.subMetas, out);
  }
}

// `metaPath` is the path of the .meta file; the asset's source file is the same
// path with the trailing ".meta" removed.
export function parseMeta(metaPath, text, resolveType = defaultResolve) {
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { error: `invalid JSON: ${e.message}`, metaPath };
  }
  if (!json || !json.uuid) return { error: 'no uuid', metaPath };

  const sourcePath = metaPath.slice(0, -'.meta'.length);
  const ext = extOf(sourcePath);
  const importer = json.importer || '*';
  const subAssets = [];
  collectSubAssets(json.subMetas, subAssets);

  return {
    uuid: json.uuid,
    path: sourcePath,
    metaPath,
    ext,
    importer,
    type: resolveType(importer, ext),
    userData: json.userData || null,
    subAssets,
  };
}

export { extOf };
