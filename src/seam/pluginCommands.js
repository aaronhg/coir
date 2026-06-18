// @ts-check
// Shared registry for plugin-contributed commands, used by BOTH the CLI
// (src/cli.js — prints the result) and the MCP server (src/mcp/server.js —
// returns it as a tool result). A plugin registers a command ONCE under
// `commands`; if it carries an `inputSchema` it is ALSO exposed as an MCP tool —
// no second registration. The command's `run(ctx)` RETURNS `{ data, text? }`
// (or `{ error, candidates? }`) and never prints, so one definition serves both
// environments; each host presents it (CLI prints text / -o json data; MCP
// returns data). `ctx` abstracts the environment — see `CommandContext` in
// types/index.d.ts (env, args, scan, readText, resolveAsset, …).

// Names owned by the core CLI/MCP — a plugin command can never take these.
export const BUILTIN_COMMANDS = new Set(['deps', 'uses', 'closure', 'find', 'info', 'analyze', 'duplicates', 'share', 'edit', 'mcp']);

/**
 * Collect + normalize every plugin's `commands` into a name→spec map. Built-ins
 * always win (a colliding name is dropped with a warning); among plugins a later
 * same-name command wins (matches dedupePlugins).
 * @param {any[]} plugins
 * @param {(m: string) => void} [warn]
 */
export function collectPluginCommands(plugins, warn = (m) => process.stderr.write(`${m}\n`)) {
  const byName = new Map();
  for (const p of plugins || []) {
    if (!p || !Array.isArray(p.commands)) continue;
    for (const c of p.commands) {
      if (!c || typeof c.name !== 'string' || typeof c.run !== 'function') continue;
      if (BUILTIN_COMMANDS.has(c.name)) { warn(`⚠ plugin '${p.name}' command '${c.name}' shadows a built-in — ignored`); continue; }
      byName.set(c.name, {
        name: c.name,
        usage: c.usage || `coir ${c.name}`,                 // CLI help line
        description: c.description || c.usage || c.name,     // MCP tool description
        inputSchema: c.inputSchema || null,                 // present → also an MCP tool
        // Map CLI positionals → named args so ctx.args matches the MCP JSON shape.
        // Explicit `positional` wins; else fall back to the inputSchema property order.
        positional: Array.isArray(c.positional) ? c.positional
          : (c.inputSchema && c.inputSchema.properties ? Object.keys(c.inputSchema.properties) : []),
        run: c.run,
        plugin: p.name,
      });
    }
  }
  return byName;
}

/**
 * Build the named-args object for a CLI invocation from the positional tokens,
 * so a command's `ctx.args` is the same shape whether it was called from the CLI
 * or via MCP (where args arrive as a JSON object). A trailing `?` on a name marks
 * it optional and is stripped.
 * @param {{ positional?: string[] }} cmd
 * @param {string[]} pos
 */
export function mapPositionals(cmd, pos) {
  const args = {};
  const names = (cmd && cmd.positional) || [];
  for (let i = 0; i < names.length; i++) {
    const key = String(names[i]).replace(/\?$/, '');
    if (pos[i] !== undefined) args[key] = pos[i];
  }
  return args;
}
