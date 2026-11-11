import { spawn, type ChildProcess } from "node:child_process";

// DEV-196d: a second `next start` from the same build with the demo version flag ON and a signing key made up inside
// the test process. The suite's own server (playwright.config.ts) keeps the flag OFF, as every deployment does today.
// No value is registered anywhere.

export type FlagOnServer = { origin: string; stop: () => void };

export async function startFlagOnServer(port: number, key: Buffer): Promise<FlagOnServer> {
  const child: ChildProcess = spawn("npm", ["run", "start", "--", "--port", String(port)], {
    env: { ...process.env, SALES_DEMO_VERSIONS_ENABLED: "true", SALES_DEMO_VIEW_SIGNING_KEY: key.toString("base64url") },
    stdio: "ignore",
    detached: true,
  });
  const origin = `http://127.0.0.1:${port}`;
  const stop = () => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // already gone
    }
  };
  const until = Date.now() + 120_000;
  while (Date.now() < until) {
    try {
      if ((await fetch(origin)).status > 0) return { origin, stop };
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  stop();
  throw new Error("flag-on server did not start");
}
