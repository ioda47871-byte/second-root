/**
 * DEV-098: wait until a freshly loaded page has produced compositor frames before
 * the first screenshot of it.
 *
 * Chromium answers `Page.captureScreenshot` with "Unable to capture screenshot"
 * when it is asked for a page whose first frames are not drawn yet: it copies
 * the page's compositor surface, and right after a new context/page and
 * `setContent` there may be none to copy. On a loaded machine (CI) this hit
 * the captures that follow `setContent` on a brand-new page directly
 * (synthetic.ts, renderer-direction's regionPixels); the same page captured
 * fine a moment later. Pages that are measured first (render.ts) never failed.
 *
 * Two requestAnimationFrame callbacks in a row mean the renderer has run a
 * frame and begun the next one, so the first has been committed. The
 * callbacks run in an isolated world made over CDP, not the page's own world:
 * `javaScriptEnabled: false` (Emulation.setScriptExecutionDisabled) stops rAF
 * callbacks in the main world, but not in an isolated world, and the page's
 * own scripts stay off. Nothing on the page changes, so what is captured and
 * asserted afterwards is the same.
 */
import type { Page } from "playwright";

/** How long a page may take to draw (a visible headless page draws within milliseconds). */
export const FRAME_WAIT_TIMEOUT_MS = 15_000;

type Send = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

/** Resolves once the page's main frame has run two animation frames; rejects (FRAME_WAIT_TIMEOUT) if it does not in time. Chromium only. */
export async function waitForFrame(page: Page, timeoutMs: number = FRAME_WAIT_TIMEOUT_MS): Promise<void> {
  const session = await page.context().newCDPSession(page);
  const send = session.send.bind(session) as unknown as Send;
  let timer: NodeJS.Timeout | undefined;
  try {
    const wait = (async () => {
      const { frameTree } = (await send("Page.getFrameTree")) as { frameTree: { frame: { id: string } } };
      const { executionContextId } = (await send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "sr-frame-wait" })) as { executionContextId: number };
      const reply = (await send("Runtime.evaluate", {
        contextId: executionContextId,
        expression: "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))",
        awaitPromise: true,
        returnByValue: true,
      })) as { result?: { value?: unknown }; exceptionDetails?: unknown };
      if (reply.exceptionDetails || reply.result?.value !== true) throw Object.assign(new Error("frame wait failed"), { code: "FRAME_WAIT_FAILED" });
    })();
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`no frame within ${timeoutMs} ms`), { code: "FRAME_WAIT_TIMEOUT" })), timeoutMs);
    });
    wait.catch(() => undefined);
    await Promise.race([wait, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    await session.detach().catch(() => undefined);
  }
}
