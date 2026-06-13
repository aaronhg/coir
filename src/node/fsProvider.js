// Node FileProvider: turn an on-disk assets/ directory into the FileProvider
// the DOM-free core (scan.js) consumes. Shared by the CLI and the headless test
// runner. Paths are POSIX-relative to assetsRoot.

import { promises as fs } from 'node:fs';
import path from 'node:path';

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
  };
}
