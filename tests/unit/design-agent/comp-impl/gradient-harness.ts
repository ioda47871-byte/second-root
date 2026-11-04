import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "playwright";
import type { CompPage } from "@/lib/design-agent/comp-impl/page";
import { gradientProblems } from "@/lib/design-agent/comp-impl/phase-b";
import { openCompPage } from "@/lib/design-agent/comp-impl/render";
import { REPO, SHOPS, type ShopKey } from "./nowrap-harness";
import { C_PRIME } from "./scale-harness";

// DEV-172 (Issue #193 comment 6628165899): the research harness for gradient_ground. Test-only, like nowrap-harness.ts and
// scale-harness.ts (whose shop table and C′ pages it reuses): it builds pages from the three shops' strict B pages with
// gradients added where the comp / C′ draws them. The flag is passed by the tests directly; the run never turns it on
// (APPROVED_CAPABILITIES is empty). Nothing here is a production option.

const POC = join(REPO, "design-library/research/quality-pipeline/poc");

/**
 * The page variants.
 * - strict: the strict B page as merged (no gradient at all).
 * - grad: gradients where the comp / C′ draws them on TEXT-FREE boxes (inside the scope of gradient_ground). sento: the
 *   thermometer (a 6px tube per section, C′'s liquid colours) and the fire's heat bar (C′'s four stops, in place of the
 *   strict page's four flat steps); tsugute: the two bowls (C′'s ivory glaze tone); bicycle: nothing (C′ draws gradients
 *   only on its photo placeholders, which hold a label: see grad_wide).
 * - grad_eased: grad with one change, sento's fire tube only: its second stop moves from 18% to 40% (C′'s cold-blue to
 *   ember step is steeper than the stop rule allows on a fire section under 520px tall). Everything else as grad.
 * - grad_wide: C′'s gradients where C′ puts text on them (OUTSIDE the scope): sento's photo boards (with their labels)
 *   and the fire band's ground, tsugute's gold band 金を蒔いて (its dark end failed contrast in C′), bicycle's photo boxes.
 *   Every one of them holds text: GROUND_HAS_TEXT.
 */
export const GRAD_VARIANTS = ["strict", "grad", "grad_eased", "grad_wide"] as const;
export type GradVariant = (typeof GRAD_VARIANTS)[number];

/** C′ sento's thermometer liquid per section (fidelity/d1-v4 style.css: every stop opaque, each starts where the last ends). */
export const SENTO_LIQUID = {
  hot: "linear-gradient(#fff1dc, #ff9c6e 18%, #ff8357)",
  warm: "linear-gradient(#ff8357, #ffc27f 30%, #ffd59c)",
  cold: "linear-gradient(#ffd59c, #bfe7f4 12%, #9fd6ea)",
  fire: "linear-gradient(#9fd6ea, #e46a2f 18%, #ffb35c 70%, #ffe2b0)",
  wall: "linear-gradient(#ffe2b0, #c9ccd2 30%, #9aa4b8)",
  night: "linear-gradient(#9aa4b8, #5a6a96 40%, #2a3352)",
} as const;
/** The eased fire tube of grad_eased (the only change from C′'s liquid). */
export const SENTO_FIRE_EASED = "linear-gradient(#9fd6ea, #e46a2f 40%, #ffb35c 70%, #ffe2b0)";
/** C′ sento's heat bar (and the comp's): four opaque stops, left to right. */
export const SENTO_BAR = "linear-gradient(90deg, #5b2a17, #c4512a 40%, #f2a34f 75%, #ffe2b0)";
/** C′ tsugute's ivory glaze tone (shard-ware) and gold band (cut-kin, var() resolved: --gold-hi #d8b35e, --gold #b88a35). */
export const TSUGUTE_GLAZE = "linear-gradient(160deg, #efe6d6, #d4c3a6 55%, #a99172)";
export const TSUGUTE_GOLD = "linear-gradient(90deg, #c99a45, #d8b35e 45%, #f1d68f 52%, #b88a35 70%, #8c6524)";

function gradHtml(shop: ShopKey, v: GradVariant, html: string): string {
  if (shop === "sento" && (v === "grad" || v === "grad_eased")) {
    // a text-free tube before each section's inner block (the strict page draws the gauge as the block's left border)
    return html.replace(/(<section class="(\w+)" data-comp-section="\2">)<div class="in">/g, '$1<div class="tube" aria-hidden="true"></div><div class="in">');
  }
  return html;
}

export function gradCss(shop: ShopKey, v: GradVariant): string {
  if (v === "strict") return "";
  if (shop === "sento") {
    if (v === "grad" || v === "grad_eased") {
      const liquid: Record<string, string> = { ...SENTO_LIQUID, ...(v === "grad_eased" ? { fire: SENTO_FIRE_EASED } : {}) };
      const tubes = Object.entries(liquid).map(([s, g]) => `.${s} .tube { background: ${g}; }`).join("\n");
      return [
        "section { display: flex; }",
        ".tube { flex: none; width: 6px; margin-left: 40px; }",
        ".in { flex: 1; min-width: 0; margin-left: 0; border-left-width: 0; }",
        tubes,
        `.bar { background: ${SENTO_BAR}; }`,
        ".bar div { background-color: transparent; }",
        "@media (max-width: 600px) { .tube { width: 4px; margin-left: 10px; } }",
      ].join("\n");
    }
    return [".board { background: linear-gradient(165deg, #7fb6c4, #3f7f96 55%, #2f6479); }", ".fire { background: linear-gradient(#1f1c1a, #3a1d12); }"].join("\n");
  }
  if (shop === "tsugute") {
    if (v === "grad" || v === "grad_eased") return `.bowl-l, .bowl-r { background: ${TSUGUTE_GLAZE}; }`;
    return `.cut-kin { background: ${TSUGUTE_GOLD}; }`;
  }
  // bicycle: C′ has no gradient on a text-free box (grad = strict)
  if (v === "grad" || v === "grad_eased") return "";
  return ".pic { background: linear-gradient(160deg, #c9c6bd, #8e8b84); }";
}

const files = (dir: string) => new Map(readdirSync(join(dir, "assets")).filter((f) => f.endsWith(".png")).map((f) => [`assets/${f}`, readFileSync(join(dir, "assets", f))]));

/**
 * The strict B page of a shop with a variant applied, every asset served, and the viewport meta the synthetic page carries
 * (the research pages have none; see nowrap-harness.ts strictPage).
 */
export function gradPage(shop: ShopKey, v: GradVariant): CompPage {
  const dir = join(POC, SHOPS[shop].strict);
  const html = gradHtml(shop, v, readFileSync(join(dir, "index.html"), "utf8")).replace('<meta charset="utf-8">', '<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">');
  const css = `${readFileSync(join(dir, "style.css"), "utf8")}\n${gradCss(shop, v)}\n`;
  return { dir, html, css, assets: [], files: files(dir), htmlSha256: "", cssSha256: "" };
}

/** The C′ page's stylesheet (for the static classification of its gradients). */
export const cPrimeCss = (shop: ShopKey): string => readFileSync(join(POC, C_PRIME[shop], "style.css"), "utf8");

/**
 * Every declaration of a stylesheet whose value draws a gradient: { prop, value } with comments removed, in source order.
 * (A plain scan of `prop: value;` pairs; the C′ sheets are hand-written and have no strings with `;` or `}` in them.)
 */
export function gradientDeclarations(css: string): Array<{ prop: string; value: string }> {
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Array<{ prop: string; value: string }> = [];
  for (const m of flat.matchAll(/([-a-z]+)\s*:\s*([^;{}]*gradient\([^;{}]*)/g)) out.push({ prop: m[1]!, value: m[2]!.replace(/\s+/g, " ").trim() });
  return out;
}

/**
 * An independent oracle of the ground codes (test-only, NOT the checker's code): at every integer width of [from, to] the
 * page is really resized (desktop, like the 1px sweep's real mode; the sweep itself mostly steps the root's width), then
 * every element with a background-image is found; it "holds text" when it has non-blank text, an aria-label or an alt in
 * it; it is "under text" when its border box meets a text line's Range rect by more than 0.5px both ways; each gradient
 * is parsed from the computed value and judged by the TS twin of the stop rule (phase-b.ts gradientProblems), so the
 * expected stop codes follow from measured geometry alone. Result: the codes per width (only widths with codes) and the
 * texts that met a ground (class and first characters).
 */
export async function groundOracle(browser: Browser, page: CompPage, from = 320, to = 1920): Promise<{ failing: Array<{ w: number; codes: string[] }>; hits: string[] }> {
  const o = await openCompPage(browser, page, { width: from, height: 900, scale: 1, mobile: false });
  const failing: Array<{ w: number; codes: string[] }> = [];
  const hits = new Set<string>();
  try {
    for (let w = from; w <= to; w++) {
      await o.page.setViewportSize({ width: w, height: 900 });
      const r = (await o.page.evaluate(`(() => {
        const grounds = Array.from(document.querySelectorAll("*")).filter((e) => { const s = getComputedStyle(e); return s.display !== "none" && s.backgroundImage && s.backgroundImage !== "none"; });
        const lines = [];
        const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n = tw.nextNode(); n; n = tw.nextNode()) {
          if (!n.parentElement || !n.data.replace(/\\s+/g, "")) continue;
          const rg = document.createRange();
          rg.selectNodeContents(n);
          for (const x of rg.getClientRects()) if (x.width > 0.5 && x.height > 0.5) lines.push({ x, who: (n.parentElement.className || n.parentElement.tagName) + ":" + n.data.trim().slice(0, 6) });
        }
        const out = { hasText: false, under: [], gradients: [] };
        for (const g of grounds) {
          const text = g.textContent.replace(/\\s+/g, "") !== "" || [g, ...g.querySelectorAll("*")].some((d) => (d.getAttribute("aria-label") || "").trim() || (d.getAttribute("alt") || "").trim());
          if (text) out.hasText = true;
          const b = g.getBoundingClientRect();
          if (!text) for (const l of lines) if (Math.min(l.x.right, b.right) - Math.max(l.x.left, b.left) > 0.5 && Math.min(l.x.bottom, b.bottom) - Math.max(l.x.top, b.top) > 0.5) out.under.push(l.who);
          out.gradients.push({ value: getComputedStyle(g).backgroundImage, w: b.width, h: b.height });
        }
        return out;
      })()`)) as { hasText: boolean; under: string[]; gradients: Array<{ value: string; w: number; h: number }> };
      const codes = new Set<string>();
      if (r.hasText) codes.add("GROUND_HAS_TEXT");
      if (r.under.length) codes.add("GROUND_UNDER_TEXT");
      for (const u of r.under) hits.add(u);
      for (const g of r.gradients) for (const c of stopCodesOf(g.value, g.w, g.h)) codes.add(c);
      if (codes.size) failing.push({ w, codes: [...codes].sort() });
    }
  } finally {
    await o.context.close();
  }
  return { failing, hits: [...hits].sort() };
}

/** The TS stop rule on one computed linear-gradient value with rgb() stops (anything else: GRADIENT_UNMEASURED). */
export function stopCodesOf(value: string, w: number, h: number): string[] {
  const m = /^linear-gradient\((.*)\)$/.exec(value.trim());
  if (!m) return ["GRADIENT_UNMEASURED"];
  const parts = m[1]!.split(/,(?![^(]*\))/).map((s) => s.trim());
  const config = /^rgb/.test(parts[0]!) ? null : parts.shift()!;
  const stops = parts.map((p) => /^rgb\((\d+), (\d+), (\d+)\)(?:\s+([\d.]+)%)?$/.exec(p));
  if (stops.some((s) => !s)) return ["GRADIENT_UNMEASURED"];
  return gradientProblems({ kind: "linear", config, w, h, stops: stops.map((s) => ({ rgb: [Number(s![1]), Number(s![2]), Number(s![3])] as [number, number, number], pct: s![4] ? Number(s![4]) : null })) });
}

/**
 * The same page with wider font metrics (test-only, reproduces a CI-like font): the faces the shop pages name are
 * re-declared from the same local files with a content area of 1.45em (ascent 116 %, descent 29 %, like Noto Sans CJK)
 * instead of the container's IPA fonts' 1.0em. Glyphs and advances do not change; only the Range rects of text grow
 * above and below the line. Raw CSS (an @font-face the allowlist refuses): for measuring only, never a page the run checks.
 */
export function withWideMetrics(page: CompPage): CompPage {
  const face = (family: string, local: string) => `@font-face { font-family: "${family}"; src: local("${local}"); ascent-override: 116%; descent-override: 29%; }`;
  const css = [face("IPAMincho", "IPAMincho"), face("IPAGothic", "IPAGothic"), face("Noto Sans CJK JP", "IPAGothic")].join("\n");
  return { ...page, css: `${css}\n${page.css}` };
}
