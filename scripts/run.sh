#!/bin/zsh
# Update-and-run loop for cmux-remote, launched by autostart in a dedicated cmux
# workspace. It stays in the foreground as the persistent parent, so the server
# (its background child) keeps cmux ancestry across restarts — a plain backgrounded
# process would be reparented to launchd and lose socket access.
#
# Every CMUX_REMOTE_UPDATE_INTERVAL seconds it fetches the repo and, IF the working
# tree is clean and fast-forwardable, pulls the new version, rebuilds, and restarts
# the server. The clean-tree guard means it never clobbers local work — a machine
# you develop on with uncommitted changes just keeps running what it has.

set -u
DIR="${CMUX_REMOTE_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$DIR" || { echo "cmux-remote: $DIR not found" >&2; exit 1; }

PORT="${CMUX_REMOTE_PORT:-${PORT:-8787}}"
AUTOUPDATE="${CMUX_REMOTE_AUTOUPDATE:-1}"
INTERVAL="${CMUX_REMOTE_UPDATE_INTERVAL:-300}"

have_bun()   { command -v bun >/dev/null 2>&1; }
clean_tree() { [ -z "$(git status --porcelain 2>/dev/null)" ]; }

build() {
  have_bun || return 0
  [ -d node_modules ] || bun install --frozen-lockfile --silent 2>/dev/null
  # Rebuild only when a source file is newer than the binary (git checkout bumps mtimes).
  local stale=0 f
  for f in server.ts startup.ts tailscale.ts public/index.html public/sw.js; do
    [ -e "$f" ] && [ "$f" -nt ./cmux-remote ] && stale=1
  done
  if [ ! -x ./cmux-remote ] || [ "$stale" = 1 ]; then
    echo "cmux-remote: building binary…" >&2
    bun build --compile --minify server.ts --outfile cmux-remote 2>&1 | tail -1 >&2
  fi
}

run_server() {
  if [ -x ./cmux-remote ]; then PORT="$PORT" ./cmux-remote
  elif have_bun;          then PORT="$PORT" bun run server.ts
  else echo "cmux-remote: need bun or a prebuilt binary" >&2; sleep 60
  fi
}

update_available() {
  [ "$AUTOUPDATE" = 1 ] || return 1
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 1
  git fetch -q origin 2>/dev/null || return 1
  local br local remote
  br="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
  local="$(git rev-parse HEAD 2>/dev/null)"
  remote="$(git rev-parse "origin/$br" 2>/dev/null)"
  [ -n "$remote" ] && [ "$local" != "$remote" ] && clean_tree
}

# Pull once before the first launch (safe: clean + fast-forward only).
if [ "$AUTOUPDATE" = 1 ] && clean_tree; then git pull --ff-only -q 2>/dev/null; fi
build

TICK=3 # seconds between liveness checks — keeps crash-restart snappy
while true; do
  run_server &
  SRV=$!
  elapsed=0
  # Poll in short ticks so a crashed server restarts within a few seconds, and run
  # the (heavier) update check only once every INTERVAL.
  while kill -0 "$SRV" 2>/dev/null; do
    sleep "$TICK"
    kill -0 "$SRV" 2>/dev/null || break
    elapsed=$((elapsed + TICK))
    if [ "$elapsed" -ge "$INTERVAL" ]; then
      elapsed=0
      if update_available; then
        echo "cmux-remote: new version on origin — updating…" >&2
        git pull --ff-only -q 2>/dev/null && build
        kill "$SRV" 2>/dev/null
        break
      fi
    fi
  done
  wait "$SRV" 2>/dev/null
  sleep 1 # don't hot-loop if the server dies immediately
done
