// Hand-rolled MCP server — JSON-RPC 2.0 over stdio (newline-delimited), ZERO
// runtime deps, matching coir's no-dependency ethos. Long-lived: it holds a
// cached scan, refreshes it lazily on fs.watch events (so reads stay fresh as
// Cocos Creator changes files) and after its own writes, and serialises tool
// calls so two edits never race. The tool surface + edit/query logic live in
// tools.js / edit/ops.js / query.js — this file is just transport + the scan
// lifecycle. Launched by `coir mcp` (see cli.js). All non-protocol output goes
// to stderr; stdout is reserved for the JSON-RPC stream.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { scanProject } from '../core/scan.js';
import { makeFsProvider, readCocosVersion } from '../node/fsProvider.js';
import { TOOLS, TOOLS_BY_NAME } from './tools.js';
import { collectPluginCommands } from '../seam/pluginCommands.js';
import { base, kb, resolveTarget, edgeMaps } from '../seam/shared.js';
import { mainUuid, subOf, looksCompressed, decompressUuid } from '../core/uuid.js';

const VERSION = (() => { try { return JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version; } catch { return '?'; } })();
const PROTOCOL_VERSION = '2025-06-18';
const log = (s) => process.stderr.write(`[coir-mcp] ${s}\n`);

export async function startMcpServer(projectDir, { plugins } = {}) {
  // stdout is the protocol channel — keep stray console output (e.g. a chatty
  // plugin) off it so it can't corrupt the JSON-RPC stream.
  console.log = console.info = console.debug = (...a) => process.stderr.write(`${a.join(' ')}\n`);

  const assetsDir = path.join(projectDir, 'assets');
  const fp = makeFsProvider(assetsDir);
  const cocosVersion = readCocosVersion(projectDir);
  const state = { scan: null, dirty: false, projectDir, plugins }; // plugins → the `check` tool's plugin checkers
  async function rescan() { state.scan = await scanProject(fp, { plugins, env: 'mcp', projectDir, cocosVersion }); state.dirty = false; }
  state.markDirty = () => { state.dirty = true; };
  state.forceRescan = rescan;
  state.readText = (p) => fp.readText(p); // plugin MCP tools read sources under assets/ via ctx.readText
  state.bytes = fp.bytes ? (p) => fp.bytes(p) : undefined; // binary read for the `duplicates` tool (byte-dup)
  const ensureFresh = async () => { if (state.dirty || !state.scan) await rescan(); };

  await rescan(); // initial scan (throws loudly if the project dir is wrong)

  // Invalidate the cache on any change under assets/ — Cocos Creator saving,
  // importing, regenerating .meta, etc. Debounced. Recursive watch works on
  // macOS/Windows; on Linux it degrades (no recursion) but writes stay safe
  // (every edit loads fresh + the mtime guard), and coir_rescan forces a refresh.
  let debounce = null;
  try {
    const watcher = fs.watch(assetsDir, { recursive: true }, () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => { state.dirty = true; }, 150);
      debounce.unref(); // don't let a pending debounce keep the process alive at shutdown
    });
    watcher.unref(); // the watcher alone shouldn't hold the event loop open
  } catch (e) { log(`recursive watch unavailable (${e instanceof Error ? e.message : e}) — call coir_rescan to refresh`); }

  // Plugin commands that carry an `inputSchema` ALSO surface here as MCP tools —
  // one registration (plugin.commands), two hosts. Same `run(ctx)` as the CLI: it
  // RETURNS { data }/{ error } (never prints — stdout is the protocol channel), so
  // we just adapt the ctx (env:'mcp', args = the JSON tool arguments) and pass the
  // result through. Built-ins always win on a name collision.
  const toolMap = new Map(TOOLS.map((t) => [t.name, t]));
  // In MCP there is no process to exit on a bad asset — resolveAsset throws, and
  // tools/call's try/catch turns it into a clean { error } tool result.
  const mcpResolveAsset = (scan, q) => {
    const r = resolveTarget(scan, q);
    if (r.notFound) throw new Error(`not found: "${q}"`);
    if (r.candidates) throw new Error(`"${q}" matches ${r.candidates.length} assets — use the full path`);
    return r.uuid;
  };
  for (const c of collectPluginCommands(plugins, log).values()) {
    if (!c.inputSchema) continue; // CLI-only command (no schema) → not an MCP tool
    if (TOOLS_BY_NAME.has(c.name)) { log(`plugin command '${c.name}' shadows a built-in MCP tool — ignored`); continue; }
    toolMap.set(c.name, {
      name: c.name,
      description: c.description,
      inputSchema: c.inputSchema,
      run: async (st, a) => {
        const res = await c.run({
          env: 'mcp',
          command: c.name,
          args: a || {},
          flags: {},
          projectDir: st.projectDir,
          scan: st.scan,
          readText: st.readText,
          resolveAsset: (q) => mcpResolveAsset(st.scan, q),
          edgeMaps: () => edgeMaps(st.scan),
          uuid: { mainUuid, subOf, looksCompressed, decompressUuid },
          util: { base, kb },
        });
        if (res && res.error) return { error: res.error, candidates: res.candidates };
        return { data: res ? res.data : undefined };
      },
    });
  }
  const allTools = [...toolMap.values()];

  // ---- JSON-RPC framing ----------------------------------------------------
  const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
  const toolResult = (id, text, isError) => reply(id, { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

  async function handle(msg) {
    switch (msg.method) {
      case 'initialize': {
        const pv = (msg.params && msg.params.protocolVersion) || PROTOCOL_VERSION;
        return reply(msg.id, { protocolVersion: pv, capabilities: { tools: {} }, serverInfo: { name: 'coir', version: VERSION } });
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return; // notifications get no response
      case 'ping':
        return reply(msg.id, {});
      case 'tools/list':
        return reply(msg.id, { tools: allTools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
      case 'tools/call': {
        const { name, arguments: args = {} } = msg.params || {};
        const tool = toolMap.get(name);
        if (!tool) return fail(msg.id, -32602, `unknown tool: ${name}`);
        await ensureFresh();
        let res;
        try { res = await tool.run(state, args); }
        catch (e) { res = { error: e instanceof Error ? e.message : String(e) }; }
        if (res && res.error) {
          const extra = res.candidates && res.candidates.length ? `\n${res.candidates.join('\n')}` : '';
          // Normalize to exactly one leading "✗ ": some errors come from the edit seam already
          // ✗-prefixed (OM.* / OM.selErr), others are bare MCP-layer strings — strip any leading
          // ✗ then add one, so every error renders with a single ✗ (not "✗ ✗ …" or none).
          const message = `${res.error}`.replace(/^\s*✗\s*/, '');
          return toolResult(msg.id, `✗ ${message}${extra}`, true);
        }
        return toolResult(msg.id, JSON.stringify(res.data));
      }
      default:
        if (msg.id !== undefined) return fail(msg.id, -32601, `method not found: ${msg.method}`);
    }
  }

  // Serialise: one message handled at a time, so scans/writes never overlap.
  let chain = Promise.resolve();
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const s = line.trim(); if (!s) return;
    let msg; try { msg = JSON.parse(s); } catch { return; } // ignore non-JSON noise
    chain = chain.then(() => handle(msg)).catch((e) => log(`handler error: ${e && e.stack ? e.stack : e}`));
  });
  // On stdin EOF, let the queue drain, then a final write whose callback fires
  // only after all earlier responses have flushed to stdout — then exit (clean
  // for both a long-lived client disconnect and a piped batch of requests).
  rl.on('close', () => { chain.finally(() => process.stdout.write('', () => process.exit(0))); });
  log(`ready — project ${projectDir}, ${state.scan.assets.size} assets, ${allTools.length} tools`);
}
