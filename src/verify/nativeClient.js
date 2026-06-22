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

/** POST JSON to base+route, resolve the parsed JSON reply. `token` (when set) is
 * sent as X-Coir-Token — the endpoint requires it on every route except /ready. */
function post(base, route, body, timeoutMs = 8000, token = null) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body || {}));
    const u = new URL(base + route);
    const headers = { 'content-type': 'application/json', 'content-length': data.length };
    if (token) headers['x-coir-token'] = token;
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers },
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
 * wins. Returns { base, port, version, project, token } or throws (the message
 * lists any other-project endpoints that answered, so the mismatch is obvious).
 * The `token` is read from /ready and must ride on every later call (the helpers
 * below take the whole conn object and forward it).
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
    const ep = { base, port: p, version: r.version, project: r.project, token: r.token || null }; // token absent on a pre-token extension → calls run unauthenticated (back-compat)
    if (!want || (r.project && norm(r.project) === want)) return ep; // matching project (or no filter)
    others.push(`:${p} ${r.project ? path.basename(r.project) : '?'}`); // answered, but a different project
  }
  if (others.length) throw new Error(`no endpoint open for this project — other editor(s) answered: ${others.join(', ')}`);
  throw new Error(`no native-verify endpoint on 127.0.0.1:${fixed || '3789-3809'}`);
}

// Each helper takes the conn object from connect() (carrying base + token); a
// bare base string is still accepted (back-compat — runs unauthenticated).
const baseOf = (c) => (typeof c === 'string' ? c : c.base);
const tokenOf = (c) => (typeof c === 'string' ? null : (c && c.token) || null);
export const reimport = (conn, url) => post(baseOf(conn), '/reimport', { url }, 8000, tokenOf(conn));
export const read = (conn, uuid, selectors) => post(baseOf(conn), '/read', { uuid, selectors }, 8000, tokenOf(conn));
export const uuidOf = (conn, url) => post(baseOf(conn), '/uuid', { url }, 8000, tokenOf(conn)).then((r) => r && r.uuid);
export const fixture = (conn, body) => post(baseOf(conn), '/fixture', body, 8000, tokenOf(conn));
