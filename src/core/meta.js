// Parse a Cocos Creator 3.x `.meta` file into a normalized asset record.
//
// A `.meta` is JSON: { ver, importer, uuid, files, subMetas, userData }.
// `subMetas` maps a short sub-id (e.g. "6c48a") to a sub-asset whose uuid is
// "<mainUuid>@<subId>" and whose `importer` is the sub-asset kind
// ("texture", "sprite-frame", ...). Sub-metas can nest (image -> texture).

// importer value -> normalized node type used across the tool.
const IMPORTER_TYPE = {
  image: 'image',
  texture: 'texture',
  'sprite-frame': 'sprite-frame',
  'sprite-atlas': 'atlas',
  'bitmap-font': 'font',
  'ttf-font': 'font',
  prefab: 'prefab',
  scene: 'scene',
  typescript: 'script',
  javascript: 'script',
  'spine-data': 'spine',
  'audio-clip': 'audio',
  material: 'material',
  effect: 'effect',
  'animation-clip': 'anim',
  particle: 'particle',
  json: 'json',
  'physics-material': 'physics-material',
};

// Distinct normalized types assigned from known importers, plus the ext-derived
// spine `.atlas` ('spine-atlas'). Project-specific extensions can add more at
// runtime (normalizeType falls back to the file extension), so this is the stable
// vocabulary for help text / discoverability, not a closed set.
export const KNOWN_TYPES = [...new Set([...Object.values(IMPORTER_TYPE), 'spine-atlas'])].sort();

export function normalizeType(importer, ext) {
  if (IMPORTER_TYPE[importer]) return IMPORTER_TYPE[importer];
  // The spine .atlas file uses importer "*"; disambiguate by extension.
  if (ext === '.atlas') return 'spine-atlas';
  if (importer === '*' || importer == null) return ext ? ext.slice(1) : 'unknown';
  return importer;
}

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
export function parseMeta(metaPath, text) {
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
    type: normalizeType(importer, ext),
    userData: json.userData || null,
    subAssets,
  };
}

export { extOf };
