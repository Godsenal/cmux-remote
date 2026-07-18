<div align="center">

# cmux-remote

**Drive your [cmux](https://github.com/manaflow-ai/cmux) terminals — Claude Code and every other CLI agent — from your phone.**

Scan a QR, and the terminal you left running on your Mac is in your hand: read the screen,
type, hit the keys, and get a push notification the moment an agent needs you.

</div>

---

`cmux-remote` is one small Bun server that sits next to cmux, speaks its Unix socket, and
serves a phone-friendly PWA over your Tailscale network. It is **not** a general SSH
replacement — it mirrors exactly what cmux shows, so a Claude Code session on your desk is
the same Claude Code session on your phone.

```
 iPhone PWA ──WebSocket──▶ cmux-remote ──Unix socket──▶ cmux.sock
      ▲                         │
      └────── Apple push ◀──VAPID┘   (fires when Claude needs you)
```

## Quick start

Everything runs on **your own Mac** — the phone only ever talks to your machine over your
private Tailscale network. Nothing is exposed to the public internet.

### 1. Prerequisites

- [**cmux**](https://github.com/manaflow-ai/cmux) — the terminal this controls (macOS).
- [**Bun**](https://bun.sh) — `curl -fsSL https://bun.sh/install | bash`
- [**Tailscale**](https://tailscale.com/download) — for HTTPS + remote access + push.
  Sign in on the Mac **and** the phone with the same account. Free tier is plenty.

### 2. Run it — inside a cmux terminal

> [!IMPORTANT]
> Launch it **from a cmux terminal.** cmux only accepts socket connections from processes
> spawned under cmux (`access_mode: cmuxOnly`). Run elsewhere and it prints a clear error.

```sh
git clone https://github.com/Godsenal/cmux-remote
cd cmux-remote
bun install
bun start
```

On first run it auto-generates a token + push keys, auto-configures `tailscale serve`, and
prints a **QR code**:

```
  ✓ Tailscale HTTPS is live — reachable from anywhere, push works.

  Scan to open on your phone:

  █▀▀▀▀▀█ ▄▀ █▀▄ █▀▀▀▀▀█
  █ ███ █ ▀█▀▄▀ █ ███ █     ← scan this with your iPhone camera
  █ ▀▀▀ █ █▀ ▄▀ █ ▀▀▀ █
  ▀▀▀▀▀▀▀ █▄▀▄█ ▀▀▀▀▀▀▀
  https://your-mac.your-tailnet.ts.net/?t=…
```

### 3. Install on your phone (one time)

1. **Scan the QR** with the iPhone camera → opens in Safari.
2. **Share → Add to Home Screen.**
3. **Open it from the home-screen icon** — not the Safari tab.
4. Sidebar (☰) → **알림 켜기 / Enable notifications** → allow.

That last step matters: iOS only delivers web push to an **installed** PWA. The app tells
you if you skipped it.

## What you get

| | |
|---|---|
| **Live screen** | The cmux screen, mirrored and auto-fit to your phone's width. |
| **Full input** | Type text, plus `esc` `tab` `⇧tab` `↑↓←→` `^C` `^R` `⏎` — every key Claude Code's menus and permission-mode toggle need. |
| **Workspace switcher** | Every cmux workspace with its live status icon; tap to jump. |
| **Push** | `Claude is waiting for your input` reaches your phone even with the app closed; tapping it deep-links to that workspace. |
| **Connect another device** | Sidebar QR to onboard a tablet or a second phone without retyping anything. |

## Configuration

State lives in `~/.cmux-remote/config.json` (token, VAPID keys, phone subscriptions), so
your URL stays stable across restarts — which is what lets the installed PWA keep working.

| Env | Default | |
|---|---|---|
| `PORT` | `8787` | |
| `CMUX_SOCKET_PATH` | auto (set by cmux) | override the cmux socket |
| `SCREEN_POLL_MS` | `350` | screen refresh interval |
| `META_POLL_MS` | `2000` | workspace list + notification interval |
| `CMUX_REMOTE_NO_TAILSCALE` | unset | set to skip auto-`tailscale serve` (still uses an existing mapping) |

On startup, if `tailscale serve` isn't wired for this port, `cmux-remote` sets it up for
you. It never overwrites an existing mapping to a different backend, and you can disable
the behavior entirely with `CMUX_REMOTE_NO_TAILSCALE=1`.

Build a standalone binary (no Bun needed to run it) with `bun run build` → `./cmux-remote`.

## Autostart

To have the bridge come back on its own after a reboot:

```sh
./scripts/install-autostart.sh      # undo with --uninstall
```

This adds one guarded line to `~/.zshrc`. cmux only accepts socket connections from
processes **spawned under cmux**, and a backgrounded process gets reparented away from
cmux and loses that access — so the launcher instead opens a **dedicated cmux workspace**
and runs the server there in the foreground, where it keeps its connection. It fires in
every cmux terminal (including the ones cmux restores on launch), starts the server once,
and never starts a second copy. You'll see a `cmux-remote` workspace appear in the sidebar.

The Mac must be awake and on power for the phone to reach it. Closing the lid sleeps it
(unless an external display keeps it in clamshell); on battery, `caffeinate -s` holds it.

## Known limitation: arrow keys in Claude Code

Arrow keys and `⇧Tab` work in a normal shell (history, line editing) but **not inside
Claude Code's menus/composer** — there they insert literal `[B` instead of moving.

This is a cmux constraint, not a bug in this app. cmux's socket delivers the `ESC` byte of
an escape sequence separately from the rest when the target app is in the input modes
Claude Code uses; Claude Code's parser then reads the lone `ESC` as Escape and the rest as
text. cmux's own `send_key` API doesn't accept arrows either. Verified exhaustively — no
reliable socket-level workaround exists. Type/submit, `esc`, `^C`, and `^R` all work in
Claude Code; use the Mac for heavy menu navigation.

## Security

`cmux-remote` types arbitrary text into your shells — treat the URL like a live root
shell. The token in the URL is the only credential. Two rules:

- **Keep it on your tailnet.** `tailscale serve` publishes it *inside your tailnet only*.
  Never `tailscale funnel` it or port-forward it to the public internet.
- **The token is a secret.** Anyone with the URL can drive your terminals. Rotate it by
  deleting `~/.cmux-remote/config.json` (you'll re-install the PWA).

## How it works, and what cmux allows

Findings from probing cmux's socket (v0.62). They explain why the app looks the way it does:

- **No output stream, so screens are polled.** cmux has no subscribe/event method for
  terminal output. `cmux-remote` polls `surface.read_text` and pushes only on change.
- **No color.** `read_text` returns already-rendered plain text — no ANSI, no cursor. The
  bright side: no terminal emulator is needed on the phone; the payload is a character
  grid, so a `<pre>` is the whole renderer and it stays fast.
- **Raw keys go through `send_text`.** cmux's `send_key` rejects `↑ ↓ shift+tab` — the very
  keys Claude Code needs. `send_text` passes raw PTY bytes, so `cmux-remote` writes the
  escape sequences itself (verified with `cat -v`: `shift+tab → ^[[Z`, arrows → `^[[A..D`).
- **Workspace targeting is guarded.** cmux silently ignores an unknown target param and
  falls back to the *selected* workspace — so a wrong param name means typing into the
  wrong session with no error. `onWorkspace()` checks the workspace cmux reports back and
  refuses on mismatch.

## Layout

```
server.ts       cmux socket client, WebSocket + HTTP, push, workspace guard
tailscale.ts    detects Tailscale, auto-wires `tailscale serve`, resolves the HTTPS URL
startup.ts      startup banner + terminal QR
public/         the PWA (index.html, sw.js, icons) — embedded into the compiled binary
```

## License

MIT
