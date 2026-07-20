#!/bin/zsh
# Wire cmux-remote to start automatically whenever cmux is running.
#
# Adds a single sourcing line to ~/.zshrc that runs scripts/autostart.sh in every
# cmux terminal. Idempotent — safe to run more than once. Undo with --uninstall.

set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
RC="${ZDOTDIR:-$HOME}/.zshrc"
MARK="# >>> cmux-remote autostart >>>"
END="# <<< cmux-remote autostart <<<"

# Delete the marked block, following symlinks. Dotfiles-managed rc files are
# symlinks and BSD `sed -i` refuses those ("in-place editing only works for
# regular files"), so rewrite via a temp file and cat back through the link —
# the symlink stays intact and the real target is edited.
strip_block() {
  local tmp; tmp="$(mktemp)" || return 1
  /usr/bin/sed "/$MARK/,/$END/d" "$RC" > "$tmp" && cat "$tmp" > "$RC"
  rm -f "$tmp"
}

if [ "$1" = "--uninstall" ]; then
  if [ -f "$RC" ] && grep -qF "$MARK" "$RC"; then
    strip_block
    echo "Removed cmux-remote autostart from $RC"
  else
    echo "Nothing to remove."
  fi
  exit 0
fi

if [ -f "$RC" ] && grep -qF "$MARK" "$RC"; then
  echo "Already installed in $RC — updating path."
  strip_block
fi

cat >> "$RC" <<EOF
$MARK
export CMUX_REMOTE_DIR="$DIR"
[ -n "\$CMUX_WORKSPACE_ID" ] && source "$DIR/scripts/autostart.sh"
$END
EOF

# CMUX_REMOTE_WIRE_ONLY=1 → only wire ~/.zshrc, don't launch now. Used by the
# package.json postinstall so a fresh `bun install` (incl. run.sh's own install
# step) never tries to spawn a workspace mid-install — it starts on the next
# cmux terminal instead.
if [ "${CMUX_REMOTE_WIRE_ONLY:-0}" = 1 ]; then
  echo "Installed. cmux-remote autostart wired — starts on the next cmux terminal."
else
  echo "Installed. cmux-remote will start in every cmux terminal (idempotently)."
  echo "Starting it now…"
  export CMUX_REMOTE_DIR="$DIR"
  source "$DIR/scripts/autostart.sh" || true
fi
