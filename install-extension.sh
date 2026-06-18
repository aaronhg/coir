#!/usr/bin/env sh
# coir Cocos Creator extension installer (editor 3.5–3.8). Downloads coir and
# installs a SELF-CONTAINED copy of the extension — coir-core bundled in, so the
# extension's `import('coir')` resolves without any local checkout, symlink, npm
# install or build (coir has zero runtime deps; the editor's own Node runs it).
#
#   curl -fsSL https://raw.githubusercontent.com/aaronhg/coir/main/install-extension.sh | sh -s -- /path/to/CocosProject
#
# (the `-s --` passes the project path through the pipe). Env: COIR_REF (branch/tag).
set -eu

REPO="aaronhg/coir"
REF="${COIR_REF:-main}"
PROJECT="${1:-${COIR_PROJECT:-}}"

[ -n "$PROJECT" ] || { echo "usage:  curl -fsSL .../install-extension.sh | sh -s -- <path-to-cocos-project>" >&2; exit 1; }
[ -d "$PROJECT/assets" ] || { echo "✗ not a Cocos project (no assets/ here): $PROJECT" >&2; exit 1; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
echo "→ downloading coir ($REPO@$REF)"
curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$REF" | tar -xz -C "$TMP" --strip-components=1

DEST="$PROJECT/extensions/coir"
echo "→ installing extension → $DEST"
mkdir -p "$PROJECT/extensions"
rm -rf "$DEST"
cp -R "$TMP/cocos-extension" "$DEST"
rm -f "$DEST/install.sh" # don't ship the dev installer inside the deployed copy

# Bundle coir-core: `import('coir')` resolves to node_modules/coir → src/index.js
# via package.json "exports". A plain copy (not a symlink) keeps it self-contained.
mkdir -p "$DEST/node_modules/coir"
cp -R "$TMP/src" "$TMP/types" "$TMP/package.json" "$DEST/node_modules/coir/"

echo "✓ installed (self-contained) → $DEST"
echo "  In Cocos Creator: Extension Manager → reload (or restart the editor),"
echo "  then right-click an asset for the coir dependency submenu."
