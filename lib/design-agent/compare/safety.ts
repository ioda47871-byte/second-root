// Mechanical safety checks of a compared page (DEV-073), at the review
// screenshots' two viewports: every fact of the shop is on the page, the
// notice band and the footer note (MVP_SPEC §7) are there and visible, and
// nothing scrolls sideways. Output: fact keys, booleans and pixels only.
import type { Browser } from "playwright";
import { z } from "zod";
import type { DemoView } from "@/lib/sales/demo-content";
import { SHOT_VIEWPORTS } from "../shot-viewports";
import { factStrings } from "./shops";

/**
 * Page-side source text (see page-scripts.ts: tsx would wrap a passed function in
 * __name()). A function of the fact list; called as `(<script>)(<facts JSON>)`.
 */
export const SAFETY_SCRIPT = String.raw`((facts) => {
  const visible = (e) => {
    if (!e) return false;
    const r = e.getBoundingClientRect();
    const s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && Number(s.opacity) > 0;
  };
  const flat = (s) => s.replace(/\s+/g, "");
  const text = flat(document.body.innerText || "");
  const note = document.querySelector('[role="note"]');
  const footer = document.querySelector("footer");
  return {
    missing: facts.filter((f) => !text.includes(flat(f.text))).map((f) => f.key),
    notice: Boolean(note && visible(note) && (note.textContent || "").includes("公式サイトではありません")),
    footer: Boolean(footer && visible(footer) && (footer.textContent || "").includes("公式サイト・公式情報ではありません")),
    overflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
  };
})`;

const PageSafetySchema = z.strictObject({
  missing: z.array(z.string().max(40)).max(40),
  notice: z.boolean(),
  footer: z.boolean(),
  overflow: z.number(),
});
export type PageSafety = z.infer<typeof PageSafetySchema>;
export type Safety = { desktop: PageSafety; mobile: PageSafety; ok: boolean };

export const pageSafe = (p: PageSafety) => p.missing.length === 0 && p.notice && p.footer && p.overflow === 0;

/** Opens the page at the desktop and the mobile review viewport and checks it. */
export async function checkPageSafety(browser: Browser, url: string, demo: DemoView): Promise<Safety> {
  const facts = factStrings(demo);
  const one = async (mobile: boolean): Promise<PageSafety> => {
    const v = mobile ? SHOT_VIEWPORTS.mobile : SHOT_VIEWPORTS.desktop;
    const context = await browser.newContext({
      viewport: { width: v.width, height: v.height },
      deviceScaleFactor: v.scale,
      ...(mobile ? { isMobile: true, hasTouch: true } : {}),
      reducedMotion: "reduce",
    });
    try {
      const page = await context.newPage();
      const res = await page.goto(url, { waitUntil: "networkidle" });
      if (res?.status() !== 200) throw Object.assign(new Error("page"), { code: "PREVIEW_RENDER_FAILED" });
      return PageSafetySchema.parse(await page.evaluate(`(${SAFETY_SCRIPT})(${JSON.stringify(facts)})`));
    } finally {
      await context.close();
    }
  };
  const desktop = await one(false);
  const mobile = await one(true);
  return { desktop, mobile, ok: pageSafe(desktop) && pageSafe(mobile) };
}
