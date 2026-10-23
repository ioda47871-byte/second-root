import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderSyntheticComp } from "@/lib/design-agent/comp-impl/synthetic";
import { waitForFrame } from "@/lib/design-agent/frame-ready";

// DEV-098: the first screenshot of a brand-new page waits until the page has drawn
// (Chromium otherwise answers "Unable to capture screenshot" on a loaded machine).

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
});
afterAll(async () => {
  await browser?.close();
});

/** A stand-in page whose CDP session answers `send` with `reply` and records detach. */
function fakePage(reply: (method: string) => Promise<unknown>): { page: Page; detached: () => boolean } {
  let detached = false;
  const session = { send: (method: string) => reply(method), detach: async () => void (detached = true) };
  const page = { context: () => ({ newCDPSession: async () => session }) } as unknown as Page;
  return { page, detached: () => detached };
}

describe("waitForFrame (DEV-098)", () => {
  it("waits for two animation frames of the page (JavaScript on)", async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.setContent("<!doctype html><p>x</p><script>window.ticks = 0; requestAnimationFrame(function t() { window.ticks += 1; requestAnimationFrame(t); });</script>");
      const before = (await page.evaluate("window.ticks")) as number;
      await waitForFrame(page);
      expect((await page.evaluate("window.ticks")) as number).toBeGreaterThanOrEqual(before + 2);
    } finally {
      await context.close();
    }
  });

  it("works with JavaScript disabled, and the page's own scripts still do not run (an isolated world, nothing left in the page)", async () => {
    const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1440, height: 2050 }, deviceScaleFactor: 0.5 });
    try {
      const page = await context.newPage();
      await page.setContent("<!doctype html><p>x</p><script>window.ran = true;</script>", { waitUntil: "load" });
      const keys = await page.evaluate("Object.getOwnPropertyNames(window).sort().join()");
      await waitForFrame(page);
      expect(await page.evaluate("typeof window.ran")).toBe("undefined");
      expect(await page.evaluate("Object.getOwnPropertyNames(window).sort().join()")).toBe(keys);
      const png = await page.screenshot({ clip: { x: 0, y: 0, width: 1440, height: 2050 } });
      expect(png.readUInt32BE(16)).toBe(720);
      expect(png.readUInt32BE(20)).toBe(1025);
    } finally {
      await context.close();
    }
  });

  it("is bounded: a page that never draws rejects with FRAME_WAIT_TIMEOUT and the CDP session is detached", async () => {
    const f = fakePage((method) => {
      if (method === "Page.getFrameTree") return Promise.resolve({ frameTree: { frame: { id: "F" } } });
      if (method === "Page.createIsolatedWorld") return Promise.resolve({ executionContextId: 1 });
      return new Promise(() => undefined);
    });
    await expect(waitForFrame(f.page, 50)).rejects.toMatchObject({ code: "FRAME_WAIT_TIMEOUT" });
    expect(f.detached()).toBe(true);
  });

  it("a failed evaluation is an error (FRAME_WAIT_FAILED), not a silent pass", async () => {
    const f = fakePage(async (method) => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "F" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
      return { result: { type: "undefined" }, exceptionDetails: { text: "x" } };
    });
    await expect(waitForFrame(f.page, 1000)).rejects.toMatchObject({ code: "FRAME_WAIT_FAILED" });
    expect(f.detached()).toBe(true);
  });

  it("renderSyntheticComp captures only after the frame wait has finished (same clip and options as before)", async () => {
    const calls: string[] = [];
    const session = {
      send: async (method: string) => {
        calls.push(method);
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "F" } } };
        if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
        return { result: { value: true } };
      },
      detach: async () => void calls.push("detach"),
    };
    let shotOptions: unknown;
    const page = {
      setContent: async () => void calls.push("setContent"),
      screenshot: async (o: unknown) => {
        calls.push("screenshot");
        shotOptions = o;
        return Buffer.from("png");
      },
      context: () => context,
    };
    const context = { route: async () => undefined, newPage: async () => page, newCDPSession: async () => session, close: async () => void calls.push("close") };
    const fake = { newContext: async () => context } as unknown as Browser;
    expect((await renderSyntheticComp(fake, "<p>x</p>")).toString()).toBe("png");
    expect(calls).toEqual(["setContent", "Page.getFrameTree", "Page.createIsolatedWorld", "Runtime.evaluate", "detach", "screenshot", "close"]);
    expect(shotOptions).toEqual({ clip: { x: 0, y: 0, width: 1440, height: 2050 }, animations: "disabled", caret: "hide" });
  });
});
