/**
 * Resolves the best URL to reach this server, preferring a Tailscale HTTPS address
 * (works from anywhere, and is the only thing that satisfies the secure-context rule
 * push notifications need) over plain-http LAN addresses (same network only, no push).
 *
 * cmux is macOS-only, so this only needs to find the macOS Tailscale binary.
 */
import { networkInterfaces } from "node:os";
import { existsSync } from "node:fs";

const CANDIDATES = [
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

function findBinary(): string | null {
  for (const p of CANDIDATES) if (existsSync(p)) return p;
  return null;
}

async function run(bin: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    const code = await proc.exited;
    return { ok: code === 0, out: out || err };
  } catch {
    return { ok: false, out: "" };
  }
}

export type TailscaleResult =
  | { kind: "url"; url: string } // HTTPS is live and points at our port
  | { kind: "unavailable"; reason: string } // no tailscale, or logged out
  | { kind: "needs-setup"; reason: string; command: string }; // installed & up, but serve/cert missing

/**
 * Returns an HTTPS base URL if Tailscale can serve this port, attempting to wire up
 * `tailscale serve` automatically when it is safe to do so.
 *
 * "Safe" means: serve is currently empty, or already points at our port. If the tailnet
 * already serves `/` on 443 to a *different* backend, this leaves it alone rather than
 * clobbering the user's existing config.
 */
export async function resolveTailscale(port: number): Promise<TailscaleResult> {
  const bin = findBinary();
  if (!bin) return { kind: "unavailable", reason: "Tailscale is not installed" };

  const status = await run(bin, ["status", "--json"]);
  if (!status.ok) return { kind: "unavailable", reason: "Tailscale is not running" };

  let host: string;
  try {
    const j = JSON.parse(status.out);
    if (j.BackendState !== "Running") {
      return { kind: "unavailable", reason: `Tailscale backend is ${j.BackendState}` };
    }
    host = String(j.Self?.DNSName ?? "").replace(/\.$/, "");
    if (!host) return { kind: "unavailable", reason: "no MagicDNS name — enable MagicDNS" };
  } catch {
    return { kind: "unavailable", reason: "could not read tailscale status" };
  }

  const url = `https://${host}`;
  const proxied = `http://127.0.0.1:${port}`;

  // Is serve already wired to our port?
  const serve = await run(bin, ["serve", "status", "--json"]);
  if (serve.ok) {
    try {
      const web = JSON.parse(serve.out)?.Web ?? {};
      const handler = web[`${host}:443`]?.Handlers?.["/"]?.Proxy;
      if (handler === proxied) return { kind: "url", url };
      if (handler && handler !== proxied) {
        return {
          kind: "needs-setup",
          reason: `Tailscale already serves / on 443 → ${handler}. Leaving it untouched.`,
          command: `${bin} serve --bg ${port}`,
        };
      }
    } catch {
      /* fall through and try to set it up */
    }
  }

  // Opt out of touching the user's `tailscale serve` config. We still use an existing
  // mapping (handled above); we just won't create one.
  if (process.env.CMUX_REMOTE_NO_TAILSCALE) {
    return {
      kind: "needs-setup",
      reason: "auto-serve disabled (CMUX_REMOTE_NO_TAILSCALE). Wire it yourself:",
      command: `${bin} serve --bg ${port}`,
    };
  }

  // Serve is empty — try to enable it for our port.
  const set = await run(bin, ["serve", "--bg", String(port)]);
  if (set.ok) return { kind: "url", url };

  // Most common failure: serve/HTTPS certs not enabled on the tailnet.
  const hint = /serve/i.test(set.out) || /not enabled/i.test(set.out)
    ? "Enable HTTPS + Serve for your tailnet, then restart:\n    https://login.tailscale.com/admin/settings/features"
    : set.out.trim().split("\n")[0] || "tailscale serve failed";
  return { kind: "needs-setup", reason: hint, command: `${bin} serve --bg ${port}` };
}

/** Plain-http LAN URLs — reachable only on the same network, and never eligible for push. */
export function lanUrls(port: number, token: string): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((n): n is NonNullable<typeof n> => !!n && n.family === "IPv4" && !n.internal)
    .map((n) => `http://${n.address}:${port}/?t=${token}`);
}
