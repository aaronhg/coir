// Browser adapter: turn a File System Access directory handle into the
// FileProvider that the DOM-free core (scan.js) consumes.
//
// Requires a Chromium browser and a secure context (https or http://localhost),
// so the app must be served (see README) — opening index.html via file:// will
// not expose window.showDirectoryPicker.

export function fsApiSupported() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

export async function pickProjectDirectory() {
  return window.showDirectoryPicker({ id: 'cocos-project', mode: 'read' });
}

// Walk the chosen directory, locate the assets/ tree (or accept that the user
// picked the assets folder directly), and index every file handle by its
// POSIX path relative to the assets root.
export async function makeProvider(rootHandle) {
  let assetsHandle = rootHandle;
  let label = rootHandle.name;
  try {
    assetsHandle = await rootHandle.getDirectoryHandle('assets');
  } catch {
    assetsHandle = rootHandle; // user pointed straight at assets/
  }

  const handles = new Map(); // relPath -> FileSystemFileHandle
  async function walk(dir, rel) {
    for await (const [name, h] of dir.entries()) {
      if (name === '.DS_Store') continue;
      const r = rel ? `${rel}/${name}` : name;
      if (h.kind === 'directory') await walk(h, r);
      else handles.set(r, h);
    }
  }
  await walk(assetsHandle, '');

  return {
    projectName: label,
    fileCount: handles.size,
    listFiles: async () => [...handles.keys()],
    readText: async (p) => {
      const h = handles.get(p);
      if (!h) throw new Error(`no file: ${p}`);
      return (await h.getFile()).text();
    },
    size: async (p) => {
      const h = handles.get(p);
      if (!h) return 0;
      return (await h.getFile()).size;
    },
    // Raw File/Blob for binary sources (images) — feeds createImageBitmap and
    // object URLs. Used by the report thumbnails / pixel-confirmation pass.
    file: async (p) => {
      const h = handles.get(p);
      if (!h) throw new Error(`no file: ${p}`);
      return h.getFile();
    },
  };
}
