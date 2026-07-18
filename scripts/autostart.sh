#!/bin/zsh
# Idempotently start cmux-remote whenever a cmux terminal opens.
#
# The bridge must keep a live connection to cmux's socket, which only admits
# processes spawned under cmux (access_mode "cmuxOnly"). A backgrounded/nohup'd
# process gets reparented to launchd and loses that ancestry — so instead we ask
# cmux to open a dedicated workspace and run the server there in the foreground,
# where it stays a child of cmux and keeps its connection.
#
# Sourced from ~/.zshrc, this fires in every cmux terminal (including the ones
# cmux restores after a reboot). It starts the server once and never twice.

# Only inside a cmux terminal — elsewhere the socket rejects us anyway.
[ -n "$CMUX_WORKSPACE_ID" ] || return 0 2>/dev/null || exit 0

CMUX_REMOTE_DIR="${CMUX_REMOTE_DIR:-$HOME/cmux-remote}"
CMUX_REMOTE_PORT="${CMUX_REMOTE_PORT:-${PORT:-8787}}"
STATE_DIR="$HOME/.cmux-remote"
LOCK="$STATE_DIR/autostart.lock"
mkdir -p "$STATE_DIR"

_up() { command -v nc >/dev/null 2>&1 && nc -z 127.0.0.1 "$CMUX_REMOTE_PORT" 2>/dev/null; }

# Already serving? Nothing to do.
_up && { return 0 2>/dev/null || exit 0; }

# Serialize terminals racing to start it (mkdir is atomic). Stale locks older
# than 30s are reclaimed so a killed launcher never blocks forever.
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +0.5 2>/dev/null)" ]; then
    rmdir "$LOCK" 2>/dev/null; mkdir "$LOCK" 2>/dev/null || { return 0 2>/dev/null || exit 0; }
  else
    return 0 2>/dev/null || exit 0
  fi
fi

# Locate the cmux CLI (on PATH inside cmux; fall back to the app bundle).
CMUX_BIN="$(command -v cmux 2>/dev/null)"
[ -x "$CMUX_BIN" ] || CMUX_BIN="/Applications/cmux.app/Contents/Resources/bin/cmux"

if [ ! -d "$CMUX_REMOTE_DIR" ] || [ ! -x "$CMUX_BIN" ]; then
  echo "cmux-remote: missing $CMUX_REMOTE_DIR or cmux CLI" >&2
  rmdir "$LOCK" 2>/dev/null; return 0 2>/dev/null || exit 0
fi

# Open a dedicated workspace and run the update-and-run loop there. run.sh stays in
# the foreground (keeping cmux ancestry) and pulls/rebuilds/restarts on new versions.
LOG="$STATE_DIR/server.log"
NEW_WS="$("$CMUX_BIN" new-workspace --cwd "$CMUX_REMOTE_DIR" \
  --command "CMUX_REMOTE_DIR='$CMUX_REMOTE_DIR' CMUX_REMOTE_PORT=$CMUX_REMOTE_PORT exec zsh '$CMUX_REMOTE_DIR/scripts/run.sh' 2>&1 | tee '$LOG'" 2>/dev/null | grep -oE 'workspace:[0-9]+' | head -1)"
[ -n "$NEW_WS" ] && "$CMUX_BIN" rename-workspace --workspace "$NEW_WS" "⚡ cmux-remote" >/dev/null 2>&1

# Hold the lock until the port is actually up, so a concurrent terminal doesn't
# also spawn one during the few seconds before it binds.
for _ in {1..40}; do _up && break; sleep 0.25; done
rmdir "$LOCK" 2>/dev/null

_up && echo "cmux-remote: serving on port $CMUX_REMOTE_PORT (dedicated cmux workspace)"
