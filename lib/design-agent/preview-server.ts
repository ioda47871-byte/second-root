// Local preview server and screenshots for the design agent (DEV-028).
// Shared by the manual CLI (scripts/sales-design/design-demo.ts) and the
// design worker. `next start` runs on 127.0.0.1 only, with
// SR_DESIGN_PREVIEW_ROOT pointing at the run directories outside the repo.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import type { Browser } from "playwright";

const servers = new Set<ChildProcess>();

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    /* already gone */
  }
}

/** SIGKILL every preview server group (signal handlers, watchdog). */
export function killPreviewServers(): void {
  for (const child of servers) signalGroup(child, "SIGKILL");
  servers.clear();
}

export async function portInUse(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`);
    return true;
  } catch {
    return false;
  }
}

/** A free TCP port on 127.0.0.1. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

export type PreviewServer = { child: ChildProcess; port: number };

export async function startPreviewServer(options: { repoDir: string; port: number; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<PreviewServer> {
  const child = spawn("npx", ["next", "start", "--port", String(options.port), "--hostname", "127.0.0.1"], {
    cwd: options.repoDir,
    env: { ...options.env, PORT: String(options.port) },
    stdio: "ignore",
    detached: true,
  });
  child.on("error", () => undefined); // judged below (exitCode / pid)
  servers.add(child);
  child.once("exit", () => servers.delete(child));
  const until = Date.now() + options.timeoutMs;
  while (Date.now() < until) {
    if (child.pid === undefined || child.exitCode !== null) break;
    try {
      const res = await fetch(`http://127.0.0.1:${options.port}/design-preview/not-a-run-id`);
      if (res.status === 404) return { child, port: options.port };
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  await stopPreviewServer({ child, port: options.port });
  throw Object.assign(new Error("The local preview server did not start."), { code: "PREVIEW_SERVER_FAILED" });
}

/** SIGTERM the server's group, wait up to 5 s, then SIGKILL whatever is left. */
export async function stopPreviewServer(server: PreviewServer | undefined): Promise<void> {
  const child = server?.child;
  if (child?.pid === undefined) return;
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    signalGroup(child, "SIGTERM");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
  }
  signalGroup(child, "SIGKILL");
  servers.delete(child);
}

/** Full-page screenshot (capped height). Returns the horizontal overflow in px. */
export async function screenshotPage(browser: Browser, url: string, path: string, mobile: boolean): Promise<number> {
  const context = await browser.newContext(
    mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: "reduce" } : { viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" },
  );
  try {
    const page = await context.newPage();
    const res = await page.goto(url, { waitUntil: "networkidle" });
    if (res?.status() !== 200) throw Object.assign(new Error(`preview returned ${String(res?.status())}`), { code: "PREVIEW_RENDER_FAILED" });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.screenshot({ path, fullPage: true, clip: { x: 0, y: 0, width: mobile ? 390 : 1440, height: Math.min(height, mobile ? 3200 : 2800) } });
    return Math.max(0, overflow);
  } finally {
    await context.close();
  }
}
