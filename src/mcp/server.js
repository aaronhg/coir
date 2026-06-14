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
import { makeFsProvider } from '../node/fsProvider.js';
import { TOOLS, TOOLS_BY_NAME } from './tools.js';

const VERSION = (() => { try { return JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version; } catch { return '?'; } })();
const PROTOCOL_VERSION = '2025-06-18';
const log = (s) => process.stderr.write(`[coir-mcp] ${s}\n`);

export async function startMcpServer(projectDir, { plugins } = {}) {
  // stdout is the protocol channel — keep stray console output (e.g. a chatty
  // plugin) off it so it can't corrupt the JSON-RPC stream.
  console.log = console.info = console.debug = (...a) => process.stderr.write(`${a.join(' ')}\n`);

  const assetsDir = path.join(projectDir, 'assets');
  const state = { scan: null, dirty: false, projectDir };
  async function rescan() { state.scan = await scanProject(makeFsProvider(assetsDir), { plugins }); state.dirty = false; }
  state.markDirty = () => { state.dirty = true; };
  state.forceRescan = rescan;
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
        return reply(msg.id, { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
      case 'tools/call': {
        const { name, arguments: args = {} } = msg.params || {};
        const tool = TOOLS_BY_NAME.get(name);
        if (!tool) return fail(msg.id, -32602, `unknown tool: ${name}`);
        await ensureFresh();
        let res;
        try { res = await tool.run(state, args); }
        catch (e) { res = { error: e instanceof Error ? e.message : String(e) }; }
        if (res && res.error) {
          const extra = res.candidates && res.candidates.length ? `\n${res.candidates.join('\n')}` : '';
          return toolResult(msg.id, `✗ ${res.error}${extra}`, true);
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
  log(`ready — project ${projectDir}, ${state.scan.assets.size} assets, ${TOOLS.length} tools`);
}
