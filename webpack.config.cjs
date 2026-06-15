// Webpack config (CommonJS — package is "type":"module", so this is .cjs).
// Bundles the browser entry (which pulls in the DOM-free core; the UI is pure
// DOM with no third-party runtime deps) to dist/app.bundle.js. `webpack serve`
// runs the dev server with live reload on http://localhost:8080 (a secure
// context, required by the File System Access API).
const path = require('path');
const cp = require('child_process');
const webpack = require('webpack');
const pkg = require('./package.json');

// Build stamp injected into the bundle (shown on the welcome + help screens).
// git short SHA at build time — works locally AND in CI (the checkout has .git);
// falls back to the CI commit env, then 'dev' for a gitless tarball.
function gitShort() {
  try { return cp.execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return (process.env.GITHUB_SHA || process.env.COIR_COMMIT || '').slice(0, 7) || 'dev'; }
}
const BUILD = { version: pkg.version, commit: gitShort(), date: new Date().toISOString().slice(0, 10) };

module.exports = (env, argv) => {
  const isProd = argv.mode === 'production';
  return {
    entry: './src/browser/app.js',
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: 'app.bundle.js',
      // 'auto' for the prod (GitHub Pages) build so any runtime URL resolves
      // relative to the served location (works under the /<repo>/ base);
      // '/dist/' for the dev server's known-good HMR.
      publicPath: isProd ? 'auto' : '/dist/',
      clean: true, // wipe dist/ each build so stale artifacts (e.g. an old .LICENSE.txt) never linger
    },
    // No source map in the published build → the hosted bundle has no dangling
    // sourceMappingURL (so no devtools 404) and dist/ ships a single file.
    devtool: isProd ? false : 'source-map',
    plugins: [new webpack.DefinePlugin({ __BUILD__: JSON.stringify(BUILD) })],
    devServer: {
      static: { directory: __dirname }, // serve index.html from project root
      port: 8080,
      hot: true,
      open: false,
      devMiddleware: { publicPath: '/dist/' },
    },
    performance: { hints: false },
  };
};
