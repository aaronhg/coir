// Shared core of `coir native-verify` — the LIVE cross-check against the running
// Cocos editor (via the cocos-extension native-verify endpoint): reimport +
// instantiate the file, then confirm every node/component coir PARSES is one the
// engine actually BUILDS. Pure data, no printing / no process.exit — so both the
// CLI (editCli.js cmdNativeVerify) and the MCP `native_verify` tool drive it and
// behave identically, only presentation differs (the query/edit seam pattern).
import * as nv from './nativeClient.js';
import { treeData } from '../edit/ops.js';

/**
 * @returns {Promise<{file:string, nodes:number, components:number, engine:{version?:string, port:number, project?:string}, valid:boolean, fails:{code:string, sel:string, msg:string}[]} | {error:string, code?:string, candidates?:string[], engine?:any}>}
 */
export async function nativeVerifyData(scan, projectDir, file, { port } = {}) {
  const r = treeData(scan, projectDir, file); // coir's view (also resolves + checks it's a prefab/scene)
  if (r.error) return { error: r.error, candidates: r.candidates };
  // connect() probes ALL endpoints (3789..3809) and returns the one serving THIS
  // project — so several Cocos windows can be open without locking onto the wrong one.
  let conn;
  try { conn = await nv.connect({ port, project: projectDir }); }
  catch (e) { return { error: e instanceof Error ? e.message : String(e), code: 'no-endpoint' }; }
  const engine = { version: conn.version, port: conn.port, project: conn.project || projectDir };

  const url = `db://assets/${r.file}`;
  let uuid = null;
  try { uuid = await nv.uuidOf(conn, url); } catch (e) { /* */ }
  if (!uuid) return { error: `the editor has no asset for ${r.file} (is it imported?)`, code: 'not-imported', engine };

  // Strongest signal first: reimport — the engine re-reads from disk; a malformed
  // file fails to import here (the validity gate offline verify can't give).
  let importErr = null;
  try { const ri = await nv.reimport(conn, url); if (ri && ri.error) importErr = ri.error; }
  catch (e) { importErr = e instanceof Error ? e.message : String(e); }

  // Selectors from coir's tree: every node + every NAMED component (skip #index —
  // an absolute file-array index has no live-scene equivalent).
  const named = (n) => n.components.filter((c) => c.selector.includes(':'));
  const sels = [];
  for (const n of r.nodes) { sels.push(n.path); if (!n.instance) for (const c of named(n)) sels.push(c.selector); }
  let values = {};
  if (!importErr) {
    let rd; try { rd = await nv.read(conn, uuid, sels); } catch (e) { rd = { error: e instanceof Error ? e.message : String(e) }; }
    if (rd && rd.error) importErr = `read failed: ${rd.error}`; else values = (rd && rd.values) || {};
  }

  const fails = [];
  if (importErr) fails.push({ code: 'import', sel: r.file, msg: importErr });
  else for (const n of r.nodes) {
    const g = values[n.path];
    if (!g || g.missing) { fails.push({ code: 'node-missing', sel: n.path, msg: 'coir parses this node; engine did not build it' }); continue; }
    if (g.name !== n.name) fails.push({ code: 'node-name', sel: n.path, msg: `name engine="${g.name}" ≠ coir="${n.name}"` });
    if (g.active !== n.active) fails.push({ code: 'node-active', sel: n.path, msg: `active engine=${g.active} ≠ coir=${n.active}` });
    if (!n.instance) for (const c of named(n)) {
      const gc = values[c.selector];
      if (!gc || gc.missing) fails.push({ code: 'comp-missing', sel: c.selector, msg: `coir has ${c.type}; engine dropped it (not instantiable)` });
    }
  }
  const components = r.nodes.reduce((s, n) => s + (n.instance ? 0 : named(n).length), 0);
  return { file: r.file, nodes: r.nodes.length, components, engine, valid: fails.length === 0, fails };
}
