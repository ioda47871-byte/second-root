// Production preview for the design worker: `npm run build` once per run,
// then `next start` on a free 127.0.0.1 port with SR_DESIGN_PREVIEW_ROOT set,
// and a separate headless browser for the demo screenshots.
import { join } from "node:path";
import type { Browser } from "playwright";
import { runBounded, type RunDeadline } from "../bounded-process";
import { freePort, screenshotPage, startPreviewServer, stopPreviewServer, type PreviewServer } from "../preview-server";
import type { PreviewSession } from "./run";

const BUILD_TIMEOUT_MS = 20 * 60 * 1000;

export function productionPreview(repoDir: string, launch: (env: NodeJS.ProcessEnv) => Promise<Browser>) {
  return async ({ previewRoot, env, deadline }: { previewRoot: string; env: NodeJS.ProcessEnv; deadline: RunDeadline }): Promise<PreviewSession> => {
    const build = await runBounded("npm", ["run", "build"], { cwd: repoDir, env, timeoutMs: deadline.timeoutFor(BUILD_TIMEOUT_MS, 60_000) }).catch(() => null);
    if (!build || build.timedOut || build.code !== 0) throw Object.assign(new Error("build"), { code: "WORKER_BUILD_FAILED" });
    let server: PreviewServer | undefined;
    let browser: Browser | undefined;
    try {
      server = await startPreviewServer({ repoDir, port: await freePort(), env: { ...env, SR_DESIGN_PREVIEW_ROOT: previewRoot }, timeoutMs: deadline.timeoutFor(90_000, 10_000) });
      browser = await launch(env);
    } catch (error) {
      await browser?.close().catch(() => undefined);
      await stopPreviewServer(server);
      throw error;
    }
    const port = server.port;
    const b = browser;
    return {
      renderer: {
        async render(runId, candidate, shotsDir) {
          const url = `http://127.0.0.1:${port}/design-preview/${runId}?profile=${candidate}`;
          const shots = { desktop: join(shotsDir, `${candidate}-desktop.png`), mobile: join(shotsDir, `${candidate}-mobile.png`) };
          const overflow: string[] = [];
          if ((await screenshotPage(b, url, shots.desktop, false)) > 0) overflow.push(`OVERFLOW_${candidate}_DESKTOP`);
          if ((await screenshotPage(b, url, shots.mobile, true)) > 0) overflow.push(`OVERFLOW_${candidate}_MOBILE`);
          return { shots, overflow };
        },
      },
      async stop() {
        await b.close().catch(() => undefined);
        await stopPreviewServer(server);
      },
    };
  };
}
