import type { Browser } from "playwright";
import { areaLabel } from "@/components/demo/info";
import type { DemoView } from "@/lib/sales/demo-content";
import { guardShopCss, type GuardedShopCss } from "./guard";
import { checkShopCssRender, type ShopCssPageBuilder } from "./render-check";

// Accept a per-shop stylesheet or fall back (DEV-072, Stage 3 trial, local
// preview only). A stylesheet is used only when it passes the static guard
// and the Chromium render check; otherwise the page is the profile renderer's
// own output, unchanged. The report holds fixed codes only (never the
// stylesheet's or a model's words).

export type ShopCssReport = { accepted: boolean; guard: string[]; render: string[] };
export type ShopCssDecision = { css: GuardedShopCss | null; report: ShopCssReport };

/** Every fact string the page shows (the fact-only DemoView, and the area label built from it). */
export function demoFacts(demo: DemoView): string[] {
  return [demo.name, areaLabel(demo), demo.description, ...demo.menuItems, demo.hours, demo.closedDays, demo.address, demo.access, demo.phone].filter((v): v is string => typeof v === "string" && v.trim().length > 0);
}

export async function shopCssOrFallback(input: { css: string; demo: DemoView; browser: Browser; build: ShopCssPageBuilder }): Promise<ShopCssDecision> {
  const guarded = guardShopCss(input.css);
  if (!guarded.ok) return { css: null, report: { accepted: false, guard: guarded.problems, render: [] } };
  const render = await checkShopCssRender({ browser: input.browser, build: input.build, css: guarded.css, facts: demoFacts(input.demo) });
  if (!render.ok) return { css: null, report: { accepted: false, guard: [], render: render.problems } };
  return { css: guarded.css, report: { accepted: true, guard: [], render: [] } };
}
