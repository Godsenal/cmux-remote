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
#
# Everything lives in main(), called on the very last line. That is load-bearing: zsh
# reads a script lazily, so an update that rewrites this file mid-run leaves the running
# shell resuming at a stale byte offset inside new content. That is not theoretical — it
# is how a supervisor here ended up running a second copy of itself as its own child,
# two loops fighting over one port. Parsing through to `main "$@"` pulls the whole file
# in first, so the update can't corrupt the instance that performed it.

set -u

# Resolve this script's path at file scope, not inside main(): zsh rebinds $0 to the
# function name while a function runs, so `${0:A}` in there resolves to ".../main".
SELF="${0:A}"

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

port_bound() { command -v nc >/dev/null 2>&1 && nc -z 127.0.0.1 "$PORT" 2>/dev/null; }

# Never relaunch into an occupied port. A restart that races the previous server's socket
# teardown dies instantly on EADDRINUSE, and this loop then hot-restarts straight back
# into it — 16 such deaths in one log. Wait the socket out; if the port is still held
# after that, another launcher is serving this port, so back off rather than crash-loop
# (if that one dies, the next pass takes over).
wait_for_port() {
  local _
  for _ in {1..40}; do port_bound || return 0; sleep 0.25; done
  return 1
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

self_hash() {
  if command -v shasum >/dev/null 2>&1; then shasum "$SELF" 2>/dev/null | cut -d' ' -f1
  else md5 -q "$SELF" 2>/dev/null
  fi
}

main() {
  DIR="${CMUX_REMOTE_DIR:-$(cd "$(dirname "$SELF")/.." && pwd)}"
  cd "$DIR" || { echo "cmux-remote: $DIR not found" >&2; exit 1; }

  PORT="${CMUX_REMOTE_PORT:-${PORT:-8787}}"
  AUTOUPDATE="${CMUX_REMOTE_AUTOUPDATE:-1}"
  INTERVAL="${CMUX_REMOTE_UPDATE_INTERVAL:-300}"

  # Hold off system sleep for as long as the bridge is running. A sleeping Mac drops off
  # the tailnet entirely, so "always reachable from the phone" is really "never idle-sleep":
  # with the stock 1-minute sleep timer this machine was taking 'Idle Sleep' every ~10
  # minutes, i.e. precisely whenever nobody was at the desk — which is when you reach for
  # the phone. `-s` asserts only while on AC power, so on battery it still sleeps normally,
  # and it leaves display sleep alone (the screen goes dark as usual). `-w $$` scopes the
  # assertion to this supervisor: when run.sh exits, caffeinate does too.
  CAF=""
  if command -v caffeinate >/dev/null 2>&1; then
    caffeinate -s -w $$ &
    CAF=$!
  fi

  # Pull once before the first launch (safe: clean + fast-forward only).
  if [ "$AUTOUPDATE" = 1 ] && clean_tree; then git pull --ff-only -q 2>/dev/null; fi
  build

  local TICK=3 # seconds between liveness checks — keeps crash-restart snappy
  local elapsed before
  while true; do
    if ! wait_for_port; then
      echo "cmux-remote: :$PORT still held by another process — backing off" >&2
      sleep 15
      continue
    fi
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
          before="$(self_hash)"
          git pull --ff-only -q 2>/dev/null && build
          kill "$SRV" 2>/dev/null
          wait "$SRV" 2>/dev/null
          # A supervisor that just updated itself is still running the old code, and used
          # to keep running it until the machine rebooted — so a fix to this file only
          # landed days later. Hand over to the new version instead. exec keeps the pid
          # (and this workspace's cmux ancestry, which the server depends on); the old
          # caffeinate would otherwise linger, since it waits on that same pid.
          if [ "$(self_hash)" != "$before" ]; then
            echo "cmux-remote: supervisor updated — re-exec into the new run.sh" >&2
            [ -n "$CAF" ] && kill "$CAF" 2>/dev/null
            exec zsh "$SELF"
          fi
          break
        fi
      fi
    done
    wait "$SRV" 2>/dev/null
    sleep 1 # don't hot-loop if the server dies immediately
  done
}

main "$@"
