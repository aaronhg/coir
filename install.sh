#!/usr/bin/env sh
# coir CLI installer — downloads the source and links the `coir` bin onto your
# PATH. coir's CLI is pure Node built-ins (zero runtime deps), so there's nothing
# to npm-install and nothing to build — the symlinked src/cli.js just runs.
#
#   curl -fsSL https://raw.githubusercontent.com/aaronhg/coir/main/install.sh | sh
#
# Env overrides: COIR_REF (branch/tag, default main), COIR_DIR (install dir,
# default ~/.coir), COIR_BIN_DIR (where the `coir` symlink goes, default
# ~/.local/bin). Re-run to update.
set -eu

REPO="aaronhg/coir"
REF="${COIR_REF:-main}"
DIR="${COIR_DIR:-$HOME/.coir}"
BIN_DIR="${COIR_BIN_DIR:-$HOME/.local/bin}"

command -v node >/dev/null 2>&1 || { echo "✗ coir needs Node.js — install it first: https://nodejs.org" >&2; exit 1; }

echo "→ downloading coir ($REPO@$REF) → $DIR"
rm -rf "$DIR"; mkdir -p "$DIR"
curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$REF" | tar -xz -C "$DIR" --strip-components=1

mkdir -p "$BIN_DIR"
chmod +x "$DIR/src/cli.js"
ln -sf "$DIR/src/cli.js" "$BIN_DIR/coir"

echo "✓ installed: $BIN_DIR/coir  ($(node "$DIR/src/cli.js" --version 2>/dev/null || echo coir))"
case ":$PATH:" in
  *":$BIN_DIR:"*) echo "  ready — run:  coir --help" ;;
  *) echo "  add $BIN_DIR to your PATH, then run \`coir --help\`:"
     echo "    echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.zshrc   # or ~/.bashrc" ;;
esac
