/**
 * cmux-remote — drives cmux terminals (Claude Code included) from a phone.
 *
 * Compiles to a single binary: `bun build --compile server.ts --outfile cmux-remote`.
 * Assets below are embedded by that build, so the binary needs no sibling files.
 *
 * Must run inside a cmux terminal — the socket defaults to access_mode "cmuxOnly",
 * which admits only processes spawned under cmux.
 */
import webpush from "web-push";
import qrcode from "qrcode";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { printBanner } from "./startup";

import indexHtml from "./public/index.html" with { type: "text" };
import swJs from "./public/sw.js" with { type: "text" };
import icon192 from "./public/icon-192.png" with { type: "file" };
import icon512 from "./public/icon-512.png" with { type: "file" };

const SOCKET_PATH =
  process.env.CMUX_SOCKET_PATH ||
  `${homedir()}/Library/Application Support/cmux/cmux.sock`;
const PORT = Number(process.env.PORT || 8787);
const SCREEN_POLL_MS = Number(process.env.SCREEN_POLL_MS || 350);
const META_POLL_MS = Number(process.env.META_POLL_MS || 2000);
// Read scrollback, not just the viewport, so the phone can scroll through history
// no matter where the desktop is scrolled. The cap is generous — scrolling up should
// reach the whole session — and cheap: updates are sent as deltas (see pollScreens),
// so only a fresh subscribe pays the full, and the real size is bounded by cmux's own
// buffer anyway (asking for more lines than it keeps just returns what it has).
const SCROLLBACK_LINES = Number(process.env.SCROLLBACK_LINES || 50000);

// --- config ----------------------------------------------------------------

/** Persisted so the token — and therefore the installed PWA's URL — survives restarts. */
type Sub = { endpoint: string; keys: { p256dh: string; auth: string } };
type Config = {
  token: string;
  vapid: { publicKey: string; privateKey: string };
  subscriptions: Sub[];
  // Workspace ids allowed to send push. Opt-in: a workspace not listed here stays
  // silent, so the default for every workspace (and every new one) is notifications off.
  notifyWorkspaces: string[];
};

const CONFIG_DIR = `${homedir()}/.cmux-remote`;
const CONFIG_FILE = `${CONFIG_DIR}/config.json`;

async function loadConfig(): Promise<Config> {
  const file = Bun.file(CONFIG_FILE);
  if (await file.exists()) {
    const saved = await file.json();
    if (saved.token && saved.vapid?.privateKey)
      return { subscriptions: [], notifyWorkspaces: [], ...saved };
  }
  const fresh: Config = {
    token: crypto.randomUUID().replaceAll("-", "").slice(0, 20),
    vapid: webpush.generateVAPIDKeys(),
    subscriptions: [],
    notifyWorkspaces: [],
  };
  await saveConfig(fresh);
  return fresh;
}

async function saveConfig(c: Config) {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await Bun.write(CONFIG_FILE, JSON.stringify(c, null, 2));
}

const config = await loadConfig();

// Apple's push service rejects the VAPID JWT with 403 BadJwtToken unless `sub` is a
// genuinely valid mailto: or https: contact — `...@localhost` fails. A real https URL
// is always accepted; override with a mailto: via CMUX_REMOTE_VAPID_SUBJECT if you like.
const VAPID_SUBJECT = process.env.CMUX_REMOTE_VAPID_SUBJECT || "https://github.com/Godsenal/cmux-remote";
webpush.setVapidDetails(VAPID_SUBJECT, config.vapid.publicKey, config.vapid.privateKey);

// --- cmux socket -----------------------------------------------------------

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

class CmuxClient {
  #sock: any = null;
  #connecting: Promise<void> | null = null;
  #buf = "";
  #pending = new Map<string, Pending>();
  #seq = 0;

  async #ensure(): Promise<void> {
    if (this.#sock) return;
    if (this.#connecting) return this.#connecting;

    this.#connecting = (async () => {
      this.#sock = await Bun.connect({
        unix: SOCKET_PATH,
        socket: {
          data: (_s: any, chunk: Buffer) => this.#onData(chunk),
          close: () => this.#drop(new Error("cmux socket closed")),
          error: (_s: any, err: Error) => this.#drop(err),
        },
      });
    })().finally(() => {
      this.#connecting = null;
    });

    return this.#connecting;
  }

  #onData(chunk: Buffer) {
    this.#buf += chunk.toString();
    let nl: number;
    while ((nl = this.#buf.indexOf("\n")) >= 0) {
      const line = this.#buf.slice(0, nl).trim();
      this.#buf = this.#buf.slice(nl + 1);
      if (!line) continue;

      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }

      const p = this.#pending.get(msg.id);
      if (!p) continue;
      this.#pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error?.message ?? JSON.stringify(msg.error)));
    }
  }

  #drop(err: Error) {
    this.#sock = null;
    this.#buf = "";
    for (const p of this.#pending.values()) p.reject(err);
    this.#pending.clear();
  }

  async call(method: string, params: Record<string, unknown> = {}): Promise<any> {
    await this.#ensure();
    const id = `r${++this.#seq}`;

    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#sock.write(JSON.stringify({ id, method, params }) + "\n");
      setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 10_000);
    });
  }
}

const cmux = new CmuxClient();

/**
 * Targets a surface method at one workspace and refuses the result unless cmux
 * confirms it acted on that workspace.
 *
 * The socket ignores unknown param names silently and falls back to whichever
 * workspace is currently selected in the app — so a typo like `surface:` instead of
 * `workspace_id:` does not error, it just reads (or types into) the wrong Claude Code
 * session. Every response echoes the target back, so we check it.
 */
async function onWorkspace(
  method: string,
  workspace: string,
  params: Record<string, unknown> = {},
): Promise<any> {
  const res = await cmux.call(method, { workspace_id: workspace, ...params });
  const hit = res?.workspace_ref ?? res?.workspace_id;
  if (hit && workspace !== hit && workspace !== res?.workspace_id) {
    throw new Error(`${method} targeted ${workspace} but hit ${hit} — refusing`);
  }
  return res;
}

/**
 * Reads/sends to one specific target — a surface (a single pane/tab within a
 * workspace) when given one, otherwise the workspace's focused surface. Same
 * guard as onWorkspace: verify cmux acted on the target we asked for, since an
 * ignored param silently falls back to the selected workspace.
 */
async function onTarget(
  method: string,
  target: { workspace: string; surface: string | null },
  params: Record<string, unknown> = {},
): Promise<any> {
  if (!target.surface) return onWorkspace(method, target.workspace, params);
  const res = await cmux.call(method, { surface_id: target.surface, ...params });
  if (res?.surface_id && res.surface_id !== target.surface) {
    throw new Error(`${method} targeted surface ${target.surface} but hit ${res.surface_id}`);
  }
  return res;
}

/**
 * Navigation uses emacs/readline control bytes, not arrow escape sequences.
 *
 * cmux's send_text splits the ESC byte of an escape sequence from the rest when the
 * target app is in the input modes Claude Code uses, so `\x1b[A`/`\x1b[B` arrive as a
 * lone Escape + literal "[A"/"[B" and corrupt the composer. The Ctrl-key equivalents
 * are single bytes with no ESC to split, and they drive both Claude Code's menus
 * (Ctrl+P/N move the selection) and the shell (Ctrl+P/N = history, Ctrl+B/F = cursor).
 *
 * Trade-off: full-screen apps that read raw arrows (vim, less) won't follow these —
 * use the Mac for those. Claude Code, the primary target, works.
 */
const KEYS: Record<string, string> = {
  enter: "\r",
  esc: "\x1b",
  tab: "\t",
  up: "\x10", // Ctrl+P
  down: "\x0e", // Ctrl+N
  left: "\x02", // Ctrl+B
  right: "\x06", // Ctrl+F
  clear: "\x15", // Ctrl+U — clear the input line
  "ctrl+c": "\x03",
  "ctrl+r": "\x12",
  backspace: "\x7f",
};

// --- push ------------------------------------------------------------------

async function pushToPhones(payload: Record<string, unknown>) {
  if (!config.subscriptions.length) return;
  const body = JSON.stringify(payload);

  const dead: string[] = [];
  await Promise.all(
    config.subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(sub as any, body);
      } catch (err: any) {
        // 404/410 mean the phone dropped the subscription for good; anything else is
        // a real fault and must be visible — a silent catch here makes a phone that
        // never buzzes impossible to diagnose.
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          dead.push(sub.endpoint);
        } else {
          console.error(
            `push failed for ${new URL(sub.endpoint).host}:`,
            err?.statusCode ?? "",
            err?.body || err?.message || err,
          );
        }
      }
    }),
  );

  if (dead.length) {
    config.subscriptions = config.subscriptions.filter((s) => !dead.includes(s.endpoint));
    await saveConfig(config);
  }
}

// --- clients ---------------------------------------------------------------

type ClientData = { workspace: string | null; surface: string | null; window: string | null };
const clients = new Set<any>();

/** What a client is currently viewing: a specific surface, or a workspace's focus. */
const targetKey = (d: ClientData) => d.surface || d.workspace || "";

function send(ws: any, type: string, payload: Record<string, unknown>) {
  try {
    ws.send(JSON.stringify({ type, ...payload }));
  } catch {
    /* client vanished mid-send */
  }
}

const broadcast = (type: string, payload: Record<string, unknown>) => {
  for (const ws of clients) send(ws, type, payload);
};

// --- pollers ---------------------------------------------------------------

/** cmux exposes no terminal output stream, so live screens are polled and diffed. */
const lastScreen = new Map<string, string>();

/**
 * Between polls only the viewport churns — the scrollback above it is written once
 * and then unchanged. So instead of resending the whole buffer (up to SCROLLBACK_LINES)
 * every 350ms, send just the region that differs: the common prefix and suffix stay,
 * only the middle is transmitted. Lets the scrollback cap be large without the payload.
 */
function diff(oldStr: string, next: string) {
  const oLen = oldStr.length, nLen = next.length;
  let p = 0;
  const pMax = Math.min(oLen, nLen);
  while (p < pMax && oldStr.charCodeAt(p) === next.charCodeAt(p)) p++;
  let s = 0;
  const sMax = Math.min(oLen - p, nLen - p);
  while (s < sMax && oldStr.charCodeAt(oLen - 1 - s) === next.charCodeAt(nLen - 1 - s)) s++;
  return { p, s, mid: next.slice(p, nLen - s), len: nLen };
}

async function pollScreens() {
  // Dedupe the distinct targets clients are viewing (a surface, or a workspace focus).
  const targets = new Map<string, ClientData>();
  for (const ws of clients) {
    if (ws.data.workspace) targets.set(targetKey(ws.data), ws.data);
  }
  for (const key of lastScreen.keys()) if (!targets.has(key)) lastScreen.delete(key);

  await Promise.all(
    [...targets].map(async ([key, target]) => {
      let text: string;
      try {
        text = (await onTarget("surface.read_text", target, {
          scrollback: true,
          lines: SCROLLBACK_LINES,
        }))?.text ?? "";
      } catch {
        // A surface cmux hasn't rendered yet (a brand-new one while the desktop is hidden)
        // reads as "not found". Show a hint once instead of a blank, and keep polling —
        // it resolves itself the moment cmux renders the surface. Only for targets we've
        // never read; an established surface's momentary error must not wipe its screen.
        if (!lastScreen.has(key)) {
          const hint = "⏳ 터미널을 준비 중입니다…\n맥에서 이 워크스페이스가 화면에 한 번 보이면 나타납니다.";
          lastScreen.set(key, hint);
          for (const c of clients) if (targetKey(c.data) === key) send(c, "screen", { target: key, full: hint });
        }
        return;
      }

      const prev = lastScreen.get(key);
      if (prev === text) return;
      lastScreen.set(key, text);

      // Fresh target (no baseline) → send the whole thing; otherwise send a delta.
      const payload =
        prev === undefined ? { target: key, full: text } : { target: key, ...diff(prev, text) };
      for (const ws of clients) {
        if (targetKey(ws.data) === key) send(ws, "screen", payload);
      }
    }),
  );
}

/** Per-workspace list of surfaces (panes/tabs), pushed to clients so they can switch. */
const lastSurfaces = new Map<string, string>();

async function pollSurfaces() {
  const wanted = new Set<string>();
  for (const ws of clients) if (ws.data.workspace) wanted.add(ws.data.workspace);
  for (const key of lastSurfaces.keys()) if (!wanted.has(key)) lastSurfaces.delete(key);

  await Promise.all(
    [...wanted].map(async (workspace) => {
      let surfaces: any[];
      try {
        surfaces = (await onWorkspace("surface.list", workspace))?.surfaces ?? [];
      } catch {
        return;
      }
      const slim = surfaces.map((s) => ({
        id: s.id,
        title: s.title,
        type: s.type,
        focused: !!s.focused,
        pane: s.pane_ref, // lets the phone mark surfaces in other panes as splits, not tabs
      }));
      const json = JSON.stringify(slim);
      if (lastSurfaces.get(workspace) === json) return;
      lastSurfaces.set(workspace, json);
      for (const ws of clients) {
        if (ws.data.workspace === workspace) send(ws, "surfaces", { workspace, surfaces: slim });
      }
    }),
  );
}

let workspaceCache: any[] = [];
// cmux can have several windows open at once, each with its own workspaces. Clients
// default to the current window and can switch; workspaceCache is the union across all
// windows, since unread/notifications/cwd lookups don't care which window owns a workspace.
let windowsCache: any[] = [];
let currentWindowId: string | null = null;

async function pollWorkspaces() {
  let wins: any[];
  try {
    wins = (await cmux.call("window.list"))?.windows ?? [];
  } catch {
    return; // cmux restarting; next tick retries
  }
  windowsCache = wins;
  try {
    currentWindowId = (await cmux.call("window.current"))?.window_id ?? wins[0]?.id ?? null;
  } catch {
    currentWindowId = wins[0]?.id ?? null;
  }

  // One workspace.list per window; each client is shown the window it's scoped to.
  const byWindow = new Map<string, any[]>();
  await Promise.all(
    wins.map(async (w: any) => {
      try {
        byWindow.set(w.id, (await cmux.call("workspace.list", { window_id: w.id }))?.workspaces ?? []);
      } catch {
        /* skip this window this tick */
      }
    }),
  );
  workspaceCache = [...byWindow.values()].flat();

  const windows = wins.map((w: any) => ({
    id: w.id,
    index: w.index,
    workspaces: w.workspace_count,
  }));
  for (const c of clients) {
    let winId = c.data.window || currentWindowId;
    if (winId && !byWindow.has(winId)) winId = currentWindowId; // a picked window that closed
    send(c, "windows", { windows, current: winId });
    send(c, "workspaces", { workspaces: (winId && byWindow.get(winId)) || [] });
  }
}

/**
 * Unread activity. cmux exposes no per-workspace "activity" flag, so it's derived
 * here: poll every workspace's screen and flag the ones whose content changed while
 * nobody was viewing them. Reading just the viewport (no scrollback) keeps this to a
 * few ms even for dozens of workspaces. State is global, not per-device — a personal
 * remote has one user, and that is far simpler than tracking a read cursor per phone.
 */
const activitySig = new Map<string, string>(); // workspace id -> signature of its screen
const unread = new Set<string>(); // workspace ids changed while unwatched

// Compact content signature — length plus a rolling hash. We only need to notice
// that the screen differs, not to store every workspace's full buffer.
function screenSig(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `${s.length}:${h}`;
}

const broadcastUnread = () => broadcast("unread", { workspaces: [...unread] });

async function pollActivity() {
  if (!clients.size || !workspaceCache.length) return;

  const viewed = new Set<string>();
  for (const ws of clients) if (ws.data.workspace) viewed.add(ws.data.workspace);

  let changed = false;
  await Promise.all(
    workspaceCache.map(async (w: any) => {
      let text: string;
      try {
        text = (await onWorkspace("surface.read_text", w.id))?.text ?? "";
      } catch {
        return;
      }
      const next = screenSig(text);
      const prev = activitySig.get(w.id);
      activitySig.set(w.id, next);

      if (viewed.has(w.id)) {
        // On screen right now: keep its baseline current so leaving it doesn't
        // re-flag, and it is never unread while being watched.
        if (unread.delete(w.id)) changed = true;
      } else if (prev !== undefined && prev !== next && !unread.has(w.id)) {
        // A first sighting (prev === undefined) only primes the baseline — otherwise
        // every workspace would light up unread the instant the server starts.
        unread.add(w.id);
        changed = true;
      }
    }),
  );

  // Forget workspaces that have since closed.
  const live = new Set(workspaceCache.map((w: any) => w.id));
  for (const id of [...unread]) {
    if (!live.has(id)) {
      unread.delete(id);
      changed = true;
    }
  }
  for (const id of [...activitySig.keys()]) if (!live.has(id)) activitySig.delete(id);

  if (changed) broadcastUnread();
}

const seenNotifications = new Set<string>();
let notificationsPrimed = false;

async function pollNotifications() {
  let items: any[];
  try {
    items = (await cmux.call("notification.list"))?.notifications ?? [];
  } catch {
    return;
  }

  // The first pass only records history — otherwise every past alert fires at startup.
  if (!notificationsPrimed) {
    for (const n of items) seenNotifications.add(n.id);
    notificationsPrimed = true;
    return;
  }

  const fresh = items.filter((n) => !seenNotifications.has(n.id));
  for (const n of items) seenNotifications.add(n.id);
  if (!fresh.length) return;

  // Per-workspace opt-in: only alert for workspaces the user turned on. Everything is
  // still marked seen above, so enabling a workspace never replays its backlog — it
  // starts notifying from the next alert on.
  const enabled = new Set(config.notifyWorkspaces);
  const allowed = fresh.filter((n) => enabled.has(n.workspace_id));
  if (!allowed.length) return;

  broadcast("notifications", { items: allowed });

  for (const n of allowed) {
    const w = workspaceCache.find((x) => x.id === n.workspace_id);
    await pushToPhones({
      title: w?.title || n.title || "cmux",
      body: n.body || n.subtitle || "",
      // uuid, not ref — the phone subscribes by stable id, and refs get renumbered.
      workspace: n.workspace_id || "",
      tag: n.id,
    });
  }
}

function loop(fn: () => Promise<void>, ms: number) {
  const tick = async () => {
    await fn().catch(() => {});
    setTimeout(tick, ms);
  };
  tick();
}

loop(pollScreens, SCREEN_POLL_MS);
loop(pollSurfaces, META_POLL_MS);
loop(pollWorkspaces, META_POLL_MS);
loop(pollActivity, META_POLL_MS);
loop(pollNotifications, META_POLL_MS);

// --- http / ws -------------------------------------------------------------

const authorized = (req: Request, url: URL): boolean =>
  url.searchParams.get("t") === config.token ||
  (req.headers.get("cookie") ?? "")
    .split(";")
    .some((c) => c.trim() === `cmux_remote=${config.token}`);

const page = indexHtml.replace("__VAPID_PUBLIC_KEY__", config.vapid.publicKey);

const server = Bun.serve<ClientData>({
  port: PORT,
  hostname: "0.0.0.0",
  idleTimeout: 120,

  async fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      if (!authorized(req, url)) return new Response("unauthorized", { status: 401 });
      if (server.upgrade(req, { data: { workspace: null, surface: null, window: null } })) return;
      return new Response("upgrade failed", { status: 400 });
    }

    // The browser fetches the manifest and service worker uncredentialed; neither
    // holds a secret, and the VAPID public key is public by design.
    if (url.pathname === "/sw.js") {
      return new Response(swJs, { headers: { "content-type": "text/javascript; charset=utf-8" } });
    }
    if (url.pathname === "/manifest.json") {
      return Response.json({
        name: "cmux remote",
        short_name: "cmux",
        description: "Drive cmux terminals and Claude Code from your phone.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#0d0f12",
        theme_color: "#0d0f12",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
        ],
      });
    }
    if (url.pathname === "/icon-192.png") return new Response(Bun.file(icon192));
    if (url.pathname === "/icon-512.png") return new Response(Bun.file(icon512));

    if (!authorized(req, url)) {
      return new Response("unauthorized — open the URL printed by the server", { status: 401 });
    }

    // A QR of this exact authenticated origin, so the app can onboard another device
    // (phone, tablet) without anyone retyping the long tailnet URL and token.
    if (url.pathname === "/qr.svg") {
      const target = `${url.origin}/?t=${config.token}`;
      const svg = await qrcode.toString(target, { type: "svg", margin: 1, width: 240 });
      return new Response(svg, { headers: { "content-type": "image/svg+xml; charset=utf-8" } });
    }

    if (url.pathname === "/push/subscribe" && req.method === "POST") {
      const sub = (await req.json()) as Sub;
      if (!config.subscriptions.some((s) => s.endpoint === sub.endpoint)) {
        config.subscriptions.push(sub);
        await saveConfig(config);
      }
      return Response.json({ ok: true, count: config.subscriptions.length });
    }

    if (url.pathname === "/push/unsubscribe" && req.method === "POST") {
      const { endpoint } = (await req.json()) as { endpoint: string };
      const before = config.subscriptions.length;
      config.subscriptions = config.subscriptions.filter((s) => s.endpoint !== endpoint);
      if (config.subscriptions.length !== before) await saveConfig(config);
      return Response.json({ ok: true, count: config.subscriptions.length });
    }

    if (url.pathname === "/") {
      return new Response(page, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          // Lets the home-screen PWA reopen at "/" without the token in start_url.
          "set-cookie": `cmux_remote=${config.token}; Path=/; Max-Age=31536000; SameSite=Lax`,
        },
      });
    }

    return new Response("not found", { status: 404 });
  },

  websocket: {
    open(ws) {
      clients.add(ws);
      send(ws, "notify-state", { workspaces: config.notifyWorkspaces });
      send(ws, "unread", { workspaces: [...unread] });
      pollWorkspaces();
    },
    close(ws) {
      clients.delete(ws);
    },
    async message(ws, raw) {
      let msg: any;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }

      try {
        if (msg.type === "subscribe") {
          // A new workspace resets the surface to the workspace's focus; an explicit
          // surface (a pane/tab) narrows to just that one.
          ws.data.workspace = msg.workspace;
          ws.data.surface = msg.surface ?? null;
          if (unread.delete(msg.workspace)) broadcastUnread(); // opening it marks it read
          lastScreen.delete(targetKey(ws.data)); // force a repaint for the new view
          await Promise.all([pollScreens(), pollSurfaces()]);
        } else if (msg.type === "send" && ws.data.workspace) {
          // Multi-line input must arrive as one paste. Sent raw, each newline acts as a
          // separate Enter, so the target (Claude Code, the shell) takes the lines one at
          // a time and queues them. cmux's `bracketed` flag wraps the text as a single
          // bracketed paste (handled internally, so no escape sequences get mangled); the
          // client's follow-up Enter then submits it as one message.
          const text = String(msg.text ?? "");
          const params = text.includes("\n") ? { text, bracketed: true } : { text };
          await onTarget("surface.send_text", ws.data, params);
        } else if (msg.type === "key" && ws.data.workspace) {
          const bytes = KEYS[msg.key];
          if (bytes) await onTarget("surface.send_text", ws.data, { text: bytes });
        } else if (msg.type === "select-window" && msg.window) {
          // Scope this client to another cmux window; its workspace list re-scopes on the
          // next poll (triggered now). Read-only — it never moves the desktop's focus.
          ws.data.window = msg.window;
          await pollWorkspaces();
        } else if (msg.type === "select" && msg.workspace) {
          await onWorkspace("workspace.select", msg.workspace);
        } else if (msg.type === "new-surface" && ws.data.workspace) {
          // A new terminal ("tab") in the focused pane of the workspace being viewed.
          // Inherit that workspace's directory so the new shell starts in the same repo.
          const cwd = workspaceCache.find((w) => w.id === ws.data.workspace)?.current_directory;
          const res = await onWorkspace("surface.create", ws.data.workspace, cwd ? { cwd } : {});
          const surface = res?.surface_id;
          if (surface) {
            // A brand-new surface has no rendered terminal, so surface.read_text returns
            // "not found" and the phone shows a blank. Focusing it makes cmux render it,
            // which instantiates the terminal so it can be read.
            await cmux.call("surface.focus", { surface_id: surface }).catch(() => {});
            send(ws, "created", { kind: "surface", workspace: ws.data.workspace, surface });
            await Promise.all([pollSurfaces(), pollScreens()]); // reflect it without waiting a poll
          }
        } else if (msg.type === "new-split" && ws.data.workspace) {
          // Split the viewed surface (or the workspace's focused one) into a new pane —
          // unlike new-surface (a tab in the same pane), a split shows up side-by-side on
          // the Mac. surface.split needs an explicit surface_id, so resolve it first.
          let surfaceId = ws.data.surface;
          if (!surfaceId) {
            const list = (await onWorkspace("surface.list", ws.data.workspace))?.surfaces ?? [];
            surfaceId = (list.find((s: any) => s.focused) ?? list[0])?.id ?? null;
          }
          if (surfaceId) {
            const res = await cmux.call("surface.split", { surface_id: surfaceId, direction: "right" });
            const surface = res?.surface_id;
            if (surface) {
              // Focus it so cmux renders the new pane — otherwise its terminal is never
              // instantiated and read_text returns "not found" (a blank on the phone).
              await cmux.call("surface.focus", { surface_id: surface }).catch(() => {});
              send(ws, "created", { kind: "split", workspace: ws.data.workspace, surface });
              await Promise.all([pollSurfaces(), pollScreens()]);
            }
          }
        } else if (msg.type === "new-workspace") {
          // A fresh workspace, opened in the currently-viewed workspace's directory when there
          // is one (so "new workspace" means "another agent on this repo"), else cmux's default.
          const cwd = workspaceCache.find((w) => w.id === ws.data.workspace)?.current_directory;
          const res = await cmux.call("workspace.create", cwd ? { cwd } : {});
          const workspace = res?.workspace_id;
          if (workspace) {
            // A new workspace's terminal isn't instantiated until cmux renders it once, so
            // selecting it forces the render (then read_text works); restore the Mac's prior
            // focus right after so creating from the phone doesn't yank the desktop away.
            const prev = windowsCache.find((w) => w.id === currentWindowId)?.selected_workspace_id;
            await onWorkspace("workspace.select", workspace).catch(() => {});
            if (prev && prev !== workspace) await onWorkspace("workspace.select", prev).catch(() => {});
            send(ws, "created", { kind: "workspace", workspace });
            await pollWorkspaces(); // broadcast the new list so every client sees it
          }
        } else if (msg.type === "close-surface" && msg.surface) {
          // Close one tab/pane. cmux moves focus to a sibling; the client's surfaces
          // handler falls back to the workspace focus when the viewed one disappears.
          await cmux.call("surface.close", { surface_id: msg.surface });
          await Promise.all([pollSurfaces(), pollScreens()]);
        } else if (msg.type === "close-workspace" && msg.workspace) {
          // Close a whole workspace. The client's workspaces handler auto-jumps to another
          // when the current one vanishes.
          await onWorkspace("workspace.close", msg.workspace);
          await pollWorkspaces();
        } else if (msg.type === "close-window" && msg.window) {
          // Close a cmux window. pollWorkspaces re-scopes any client that was on it back
          // to the current window.
          await cmux.call("window.close", { window_id: msg.window });
          await pollWorkspaces();
        } else if (msg.type === "notify-toggle" && msg.workspace) {
          // Turn push on/off for one workspace. Global (not per-device) — it decides
          // which sessions are allowed to ping at all; the master push button decides
          // whether this phone is subscribed to receive them.
          const set = new Set(config.notifyWorkspaces);
          if (msg.on) set.add(msg.workspace);
          else set.delete(msg.workspace);
          config.notifyWorkspaces = [...set];
          await saveConfig(config);
          broadcast("notify-state", { workspaces: config.notifyWorkspaces });
        } else if (msg.type === "resync") {
          // Client detected a delta it couldn't apply — drop the baseline so the next
          // poll resends the full screen to everyone on this target.
          lastScreen.delete(targetKey(ws.data));
          await pollScreens();
        }
      } catch (err) {
        send(ws, "error", { message: String(err) });
      }
    },
  },
});

// Confirm we can actually reach cmux before claiming to be ready. Outside a cmux
// terminal the socket is either missing or rejects us (access_mode "cmuxOnly"), which
// otherwise shows up only as a permanently blank screen with no explanation.
const cmuxOk = await cmux
  .call("system.ping")
  .then(() => true)
  .catch(() => false);

if (!cmuxOk) {
  console.log(
    "\n  \x1b[31m✗ Can't reach cmux.\x1b[0m Run this inside a cmux terminal — the socket only\n" +
      "    admits processes spawned under cmux (access_mode \"cmuxOnly\").\n" +
      `    Looked for: ${SOCKET_PATH}\n`,
  );
}

await printBanner({
  port: server.port,
  token: config.token,
  socketPath: SOCKET_PATH,
  configFile: CONFIG_FILE,
  pushCount: config.subscriptions.length,
});
