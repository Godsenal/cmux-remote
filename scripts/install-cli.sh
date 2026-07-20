#!/bin/zsh
# Put `cmux-remote` on your PATH.
#
# Symlinks bin/cmux-remote into the first writable PATH directory it finds
# (preferring ~/.local/bin). Idempotent. Undo with --uninstall.

set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$DIR/bin/cmux-remote"
chmod +x "$SRC"

# Pick a destination: an existing PATH entry we can write to, else ~/.local/bin.
TARGET_DIR=""
for d in "$HOME/.local/bin" "$HOME/bin" /opt/homebrew/bin /usr/local/bin; do
  case ":$PATH:" in *":$d:"*) [ -w "$d" ] && { TARGET_DIR="$d"; break } ;; esac
done
[ -n "$TARGET_DIR" ] || { TARGET_DIR="$HOME/.local/bin"; mkdir -p "$TARGET_DIR" }
DEST="$TARGET_DIR/cmux-remote"

if [ "${1:-}" = "--uninstall" ]; then
  [ -L "$DEST" ] && rm "$DEST" && echo "Removed $DEST" || echo "Nothing to remove."
  exit 0
fi

ln -sf "$SRC" "$DEST"
echo "Installed: $DEST -> $SRC"

case ":$PATH:" in
  *":$TARGET_DIR:"*) echo "Run it from any cmux terminal with:  cmux-remote" ;;
  *) echo "⚠️  $TARGET_DIR is not on your PATH — add this to your shell rc:"
     echo "   export PATH=\"$TARGET_DIR:\$PATH\"" ;;
esac
