/** Startup banner: resolve the best URL, print it as a scannable QR, and explain the caveats. */
import qrTerminal from "qrcode-terminal";
import { resolveTailscale, lanUrls, type TailscaleResult } from "./tailscale";

const b = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

function qr(text: string): Promise<string> {
  return new Promise((resolve) => qrTerminal.generate(text, { small: true }, resolve));
}

export async function printBanner(opts: {
  port: number;
  token: string;
  socketPath: string;
  configFile: string;
  pushCount: number;
}): Promise<TailscaleResult> {
  const { port, token, socketPath, configFile, pushCount } = opts;
  const ts = await resolveTailscale(port);
  const lan = lanUrls(port, token);

  const primary = ts.kind === "url" ? `${ts.url}/?t=${token}` : lan[0] ?? `http://localhost:${port}/?t=${token}`;

  console.log(`
  ${b("cmux-remote")} ${dim("· drive cmux from your phone")}

  ${dim("socket")}  ${socketPath}
  ${dim("config")}  ${configFile}
  ${dim("phones")}  ${pushCount} subscribed to push
`);

  if (ts.kind === "url") {
    console.log(`  ${green("✓ Tailscale HTTPS is live — reachable from anywhere, push works.")}\n`);
  } else if (ts.kind === "needs-setup") {
    console.log(`  ${yellow("⚠ Tailscale is up but HTTPS isn't wired.")} ${dim("(no remote access / push yet)")}`);
    console.log(`    ${ts.reason}\n`);
  } else {
    console.log(`  ${yellow("⚠ No Tailscale")} ${dim(`(${ts.reason})`)} — LAN only, no push.`);
    console.log(`    ${dim("Install it for remote access + notifications: https://tailscale.com/download")}\n`);
  }

  console.log(`  ${b("Scan to open on your phone:")}\n`);
  console.log(await qr(primary));
  console.log(`  ${primary}\n`);

  if (lan.length) {
    console.log(dim(`  LAN fallback (same wifi only, no push):`));
    for (const u of lan) console.log(dim(`    ${u}`));
    console.log("");
  }

  console.log(dim(`  Anyone with this URL + token can type into your terminals. Keep it on your tailnet.\n`));
  return ts;
}
