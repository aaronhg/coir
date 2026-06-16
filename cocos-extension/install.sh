#!/usr/bin/env bash
# Install this coir Cocos Creator extension into a project's extensions/ and wire
# it to the coir checkout (symlinks node_modules/coir → the repo, so the
# extension's `import('coir')` resolves to src/index.js via package.json
# "exports" — no npm link / env var needed).
#
#   ./install.sh                       # → ../../NewProject_386 (default)
#   ./install.sh /path/to/CocosProject # → that project
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" # this extension's folder
COIR_ROOT="$(cd "$SRC/.." && pwd)"                  # the coir repo (the package to link)
PROJECT="${1:-$COIR_ROOT/../NewProject_386}"
DEST="$PROJECT/extensions/coir"

[ -d "$PROJECT/assets" ] || { echo "✗ not a Cocos project (no assets/): $PROJECT" >&2; exit 1; }
mkdir -p "$PROJECT/extensions" # create it if this project has no extensions yet

echo "→ installing extension to $DEST"
rm -rf "$DEST"
cp -R "$SRC" "$DEST"
rm -f "$DEST/install.sh" # don't ship the installer inside the deployed extension

# Resolve coir-core: symlink node_modules/coir → this checkout so `import('coir')`
# finds src/index.js without installing/linking anything.
mkdir -p "$DEST/node_modules"
ln -sfn "$COIR_ROOT" "$DEST/node_modules/coir"

echo "✓ installed + linked coir → $COIR_ROOT"
echo "  • enable it: Cocos Creator → Extension Manager → reload, then right-click an asset"
echo "  • hosted #topo viewer isn't deployed yet — for local testing set VIEWER in"
echo "    extensions/coir/main.js to http://localhost:8080/ (run \`npm run dev\` in coir)"
