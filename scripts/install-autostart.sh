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

if [ "$1" = "--uninstall" ]; then
  if [ -f "$RC" ] && grep -qF "$MARK" "$RC"; then
    # Delete the marked block.
    /usr/bin/sed -i '' "/$MARK/,/$END/d" "$RC"
    echo "Removed cmux-remote autostart from $RC"
  else
    echo "Nothing to remove."
  fi
  exit 0
fi

if [ -f "$RC" ] && grep -qF "$MARK" "$RC"; then
  echo "Already installed in $RC — updating path."
  /usr/bin/sed -i '' "/$MARK/,/$END/d" "$RC"
fi

cat >> "$RC" <<EOF
$MARK
export CMUX_REMOTE_DIR="$DIR"
[ -n "\$CMUX_WORKSPACE_ID" ] && source "$DIR/scripts/autostart.sh"
$END
EOF

echo "Installed. cmux-remote will start in every cmux terminal (idempotently)."
echo "Starting it now…"
export CMUX_REMOTE_DIR="$DIR"
source "$DIR/scripts/autostart.sh" || true
