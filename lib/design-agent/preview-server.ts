// Local preview server and screenshots for the design agent (DEV-028).
// Shared by the manual CLI (scripts/sales-design/design-demo.ts) and the
// design worker. `next start` runs on 127.0.0.1 only, with
// SR_DESIGN_PREVIEW_ROOT pointing at the run directories outside the repo.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import type { Browser, Page } from "playwright";
import type { PlacedPhoto } from "./assets/render-check";
import { PAGE_INFO_SCRIPT, PageInfoSchema } from "./page-scripts";

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

/** Height caps: the full-page screenshot (unchanged since DEV-028) and each section crop. */
export const SHOT_CAP = { mobile: 3200, desktop: 2800, section: 1600 } as const;

export type CapturedPage = { overflow: number; sections: string[]; placed: PlacedPhoto[] };

/**
 * Screenshots of an open preview page (DEV-029 stage 4): the full page up to
 * its cap, plus one crop for each photo section (data-photo-section) the cap
 * cuts off, so no photo drops out of the review. Also collects the page's
 * photos for the mechanical check: which asset, where, visible, labelled, and
 * whether any text of the page lies under it.
 */
export async function capturePage(page: Page, o: { path: string; mobile: boolean; sectionPrefix: string }): Promise<CapturedPage> {
  const width = o.mobile ? 390 : 1440;
  const cap = o.mobile ? SHOT_CAP.mobile : SHOT_CAP.desktop;
  // The page side is source text (page-scripts.ts): tsx / esbuild never rewrites it, so no
  // __name helper (keepNames) can reach the page. Its answer is checked before use.
  const parsed = PageInfoSchema.safeParse(await page.evaluate(PAGE_INFO_SCRIPT));
  if (!parsed.success) throw Object.assign(new Error("preview page info"), { code: "PREVIEW_RENDER_FAILED" });
  const info = parsed.data;
  await page.screenshot({ path: o.path, fullPage: true, clip: { x: 0, y: 0, width, height: Math.min(info.height, cap) } });
  const sections: string[] = [];
  for (const s of info.sections) {
    if (s.bottom <= cap) continue;
    const path = `${o.sectionPrefix}-${sections.length + 1}.png`;
    await page.screenshot({ path, fullPage: true, clip: { x: 0, y: Math.max(0, s.top), width, height: Math.min(Math.max(1, s.bottom - s.top), SHOT_CAP.section) } });
    sections.push(path);
  }
  const device = o.mobile ? "mobile" : "desktop";
  return {
    overflow: Math.max(0, info.overflow),
    sections,
    placed: info.placed.filter((p) => p.role === "hero" || p.role === "about" || p.role === "visit").map((p) => ({ ...p, role: p.role as PlacedPhoto["role"], device })),
  };
}

/** Full-page screenshot (capped height) and photo-section crops of one preview URL. */
export async function screenshotPage(browser: Browser, url: string, path: string, mobile: boolean): Promise<CapturedPage> {
  const context = await browser.newContext(
    mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: "reduce" } : { viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" },
  );
  try {
    const page = await context.newPage();
    const res = await page.goto(url, { waitUntil: "networkidle" });
    if (res?.status() !== 200) throw Object.assign(new Error(`preview returned ${String(res?.status())}`), { code: "PREVIEW_RENDER_FAILED" });
    return await capturePage(page, { path, mobile, sectionPrefix: path.replace(/\.png$/, "-section") });
  } finally {
    await context.close();
  }
}
