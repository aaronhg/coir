// @ts-check
// Thin zero-dep client for the coir cocos-extension "native-verify" endpoint
// (a localhost HTTP server the extension exposes — reimport · scene readback ·
// fixture I/O). Used by `coir native-verify` to cross-check coir's read of a
// prefab/scene against the LIVE engine. node:http only (no fetch / no deps).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

/** Resolve a project dir to a canonical path (realpath handles symlinks). */
const norm = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

/** POST JSON to base+route, resolve the parsed JSON reply. */
function post(base, route, body, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body || {}));
    const u = new URL(base + route);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length } },
      (res) => { let s = ''; res.on('data', (d) => { s += d; }); res.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch (e) { reject(new Error('bad JSON from endpoint')); } }); },
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.end(data);
  });
}

/**
 * Find the running endpoint for a given project. Probes `/ready` across the
 * given port, or 3789..3809 (the extension auto-increments from 3789 when a port
 * is taken) — so several editors can run at once on adjacent ports. When
 * `project` is set, KEEPS probing until it finds the endpoint whose open project
 * matches (you can have many Cocos windows open); without it, the first answer
 * wins. Returns { base, port, version, project } or throws (the message lists
 * any other-project endpoints that answered, so the mismatch is obvious).
 * @param {{port?:number, project?:string}} [opts]
 */
export async function connect({ port, project } = {}) {
  const fixed = port || Number(process.env.COIR_VERIFY_PORT) || 0;
  const ports = fixed ? [fixed] : Array.from({ length: 21 }, (_, i) => 3789 + i);
  const want = project ? norm(project) : null;
  const others = [];
  for (const p of ports) {
    const base = `http://127.0.0.1:${p}`;
    let r;
    try { r = await post(base, '/ready', {}, 1200); } catch (e) { continue; } // refused/timeout → next port
    if (!r || r.ready === undefined) continue;
    const ep = { base, port: p, version: r.version, project: r.project };
    if (!want || (r.project && norm(r.project) === want)) return ep; // matching project (or no filter)
    others.push(`:${p} ${r.project ? path.basename(r.project) : '?'}`); // answered, but a different project
  }
  if (others.length) throw new Error(`no endpoint open for this project — other editor(s) answered: ${others.join(', ')}`);
  throw new Error(`no native-verify endpoint on 127.0.0.1:${fixed || '3789-3809'}`);
}

export const reimport = (base, url) => post(base, '/reimport', { url });
export const read = (base, uuid, selectors) => post(base, '/read', { uuid, selectors });
export const uuidOf = (base, url) => post(base, '/uuid', { url }).then((r) => r && r.uuid);
export const fixture = (base, body) => post(base, '/fixture', body);
