// @ts-check
// Node FileProvider: turn an on-disk assets/ directory into the FileProvider
// the DOM-free core (scan.js) consumes. Shared by the CLI and the headless test
// runner. Paths are POSIX-relative to assetsRoot.

import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';

// Best-effort read of a project's Cocos Creator version from its root package.json
// (`creator.version`, e.g. "3.8.6"); null if absent/unreadable. Node hosts pass the
// result to scanProject({ cocosVersion }) so a plugin can branch by engine version.
// (The editor host uses the authoritative Editor.App.version instead.)
export function readCocosVersion(projectDir) {
  if (!projectDir) return null;
  try {
    const pkg = JSON.parse(readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
    return (pkg && pkg.creator && pkg.creator.version) || null;
  } catch { return null; }
}

/** @returns {import('../../types/index.js').FileProvider} */
export function makeFsProvider(assetsRoot) {
  return {
    async listFiles() {
      const out = [];
      async function walk(dir, rel) {
        for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
          if (ent.name === '.DS_Store') continue;
          const abs = path.join(dir, ent.name);
          const r = rel ? `${rel}/${ent.name}` : ent.name;
          if (ent.isDirectory()) await walk(abs, r);
          else out.push(r);
        }
      }
      await walk(assetsRoot, '');
      return out;
    },
    readText: (p) => fs.readFile(path.join(assetsRoot, p), 'utf8'),
    size: async (p) => (await fs.stat(path.join(assetsRoot, p))).size,
    bytes: async (p) => new Uint8Array(await fs.readFile(path.join(assetsRoot, p))),
  };
}
