// Webpack config (CommonJS — package is "type":"module", so this is .cjs).
// Bundles the browser entry (which pulls in the DOM-free core; the UI is pure
// DOM with no third-party runtime deps) to dist/app.bundle.js. `webpack serve`
// runs the dev server with live reload on http://localhost:8080 (a secure
// context, required by the File System Access API).
const path = require('path');

module.exports = {
  entry: './src/browser/app.js',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'app.bundle.js',
    publicPath: '/dist/',
    clean: true, // wipe dist/ each build so stale artifacts (e.g. an old .LICENSE.txt) never linger
  },
  devtool: 'source-map',
  devServer: {
    static: { directory: __dirname }, // serve index.html from project root
    port: 8080,
    hot: true,
    open: false,
    devMiddleware: { publicPath: '/dist/' },
  },
  performance: { hints: false },
};
