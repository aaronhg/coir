// Tests the plugin `commands` hook on the CLI (src/cli.js): a plugin can add a
// subcommand that dispatches after the built-ins and gets a command context
// (named args / scan / readText / env). The command RETURNS { data, text } — the
// CLI prints text by default, or JSON(data) on -o json. Self-contained: writes a
// tiny temp project + an external plugin loaded via --plugin.
//   node --test test/plugin-command.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'src', 'cli.js');

let dir; // temp project root (contains assets/)
let pluginFile;

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'coir-cmd-'));
  await fs.mkdir(path.join(dir, 'assets'), { recursive: true });
  // External plugin: one real command (`hello`) + one that illegally shadows a built-in (`deps`).
  pluginFile = path.join(dir, 'cmd.plugin.mjs');
  await fs.writeFile(
    pluginFile,
    `export default {
  name: 'hello-plugin',
  commands: [
    {
      name: 'hello',
      usage: 'coir hello <who>   greet (test plugin)',
      inputSchema: { type: 'object', required: ['who'], properties: { who: { type: 'string' } } },
      positional: ['who'],
      run(ctx) {
        return {
          data: { who: ctx.args.who || null, assets: ctx.scan.assets.size, hasReadText: typeof ctx.readText, env: ctx.env },
          text: 'HELLO ' + (ctx.args.who || 'world'),
        };
      },
    },
    { name: 'deps', run() { return { text: 'SHADOW' }; } },
  ],
};
`
  );
});

after(async () => { await fs.rm(dir, { recursive: true, force: true }); });

function cli(...args) {
  const r = spawnSync('node', [CLI, '-C', dir, '--plugin', pluginFile, ...args], { encoding: 'utf8' });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}

test('plugin command prints its text result; positional → named arg', () => {
  const r = cli('hello', 'aaron');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /HELLO aaron/);
});

test('-o json prints the data result, with scan + helpers in ctx', () => {
  const r = cli('hello', 'x', '-o', 'json');
  assert.equal(r.status, 0);
  const o = JSON.parse(r.stdout.trim());
  assert.equal(o.who, 'x');
  assert.equal(o.env, 'cli');
  assert.equal(typeof o.assets, 'number'); // scan ran (empty project → 0)
  assert.equal(o.hasReadText, 'function');
});

test('plugin command appears under "Plugin commands" in --help', () => {
  const r = cli('--help');
  assert.match(r.stdout, /Plugin commands:/);
  assert.match(r.stdout, /coir hello <who>/);
});

test('a plugin cannot shadow a built-in command', () => {
  const r = cli('deps'); // built-in deps with no target → its own error, never the plugin's "SHADOW"
  assert.doesNotMatch(r.stdout, /SHADOW/);
  assert.match(r.stderr, /shadows a built-in/);
});
