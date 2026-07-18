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

// --- config ----------------------------------------------------------------

/** Persisted so the token — and therefore the installed PWA's URL — survives restarts. */
type Sub = { endpoint: string; keys: { p256dh: string; auth: string } };
type Config = {
  token: string;
  vapid: { publicKey: string; privateKey: string };
  subscriptions: Sub[];
};

const CONFIG_DIR = `${homedir()}/.cmux-remote`;
const CONFIG_FILE = `${CONFIG_DIR}/config.json`;

async function loadConfig(): Promise<Config> {
  const file = Bun.file(CONFIG_FILE);
  if (await file.exists()) {
    const saved = await file.json();
    if (saved.token && saved.vapid?.privateKey) return { subscriptions: [], ...saved };
  }
  const fresh: Config = {
    token: crypto.randomUUID().replaceAll("-", "").slice(0, 20),
    vapid: webpush.generateVAPIDKeys(),
    subscriptions: [],
  };
  await saveConfig(fresh);
  return fresh;
}

async function saveConfig(c: Config) {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await Bun.write(CONFIG_FILE, JSON.stringify(c, null, 2));
}

const config = await loadConfig();
webpush.setVapidDetails("mailto:cmux-remote@localhost", config.vapid.publicKey, config.vapid.privateKey);

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
 * Raw PTY bytes rather than surface.send_key: that method rejects arrow keys and
 * shift+tab, both of which Claude Code needs. surface.send_text passes bytes through
 * untouched, verified with `cat -v`.
 */
const KEYS: Record<string, string> = {
  enter: "\r",
  esc: "\x1b",
  tab: "\t",
  "shift+tab": "\x1b[Z",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  "ctrl+c": "\x03",
  "ctrl+d": "\x04",
  "ctrl+r": "\x12",
  "ctrl+u": "\x15",
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

type ClientData = { workspace: string | null };
const clients = new Set<any>();

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

async function pollScreens() {
  const wanted = new Set<string>();
  for (const ws of clients) if (ws.data.workspace) wanted.add(ws.data.workspace);
  for (const key of lastScreen.keys()) if (!wanted.has(key)) lastScreen.delete(key);

  await Promise.all(
    [...wanted].map(async (workspace) => {
      let text: string;
      try {
        text = (await onWorkspace("surface.read_text", workspace))?.text ?? "";
      } catch {
        return;
      }

      if (lastScreen.get(workspace) === text) return;
      lastScreen.set(workspace, text);
      for (const ws of clients) {
        if (ws.data.workspace === workspace) send(ws, "screen", { workspace, text });
      }
    }),
  );
}

let workspaceCache: any[] = [];

async function pollWorkspaces() {
  try {
    workspaceCache = (await cmux.call("workspace.list"))?.workspaces ?? [];
    broadcast("workspaces", { workspaces: workspaceCache });
  } catch {
    /* cmux restarting; next tick retries */
  }
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

  broadcast("notifications", { items: fresh });

  for (const n of fresh) {
    const w = workspaceCache.find((x) => x.id === n.workspace_id);
    await pushToPhones({
      title: w?.title || n.title || "cmux",
      body: n.body || n.subtitle || "",
      workspace: w?.ref ?? "",
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
loop(pollWorkspaces, META_POLL_MS);
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
      if (server.upgrade(req, { data: { workspace: null } })) return;
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

    if (url.pathname === "/push/test" && req.method === "POST") {
      await pushToPhones({ title: "cmux remote", body: "푸시 알림이 정상 동작합니다.", tag: "test" });
      return Response.json({ ok: true, sent: config.subscriptions.length });
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
          ws.data.workspace = msg.workspace;
          lastScreen.delete(msg.workspace); // force a repaint for the new subscriber
          await pollScreens();
        } else if (msg.type === "send" && ws.data.workspace) {
          await onWorkspace("surface.send_text", ws.data.workspace, { text: msg.text });
        } else if (msg.type === "key" && ws.data.workspace) {
          const bytes = KEYS[msg.key];
          if (bytes) await onWorkspace("surface.send_text", ws.data.workspace, { text: bytes });
        } else if (msg.type === "select" && msg.workspace) {
          await onWorkspace("workspace.select", msg.workspace);
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
