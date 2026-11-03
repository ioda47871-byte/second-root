import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { cssProblems } from "@/lib/design-agent/comp-impl/page";
import { APPROVED_CAPABILITIES, CAPABILITY_NAMES } from "@/lib/design-agent/comp-impl/spec";

// DEV-161 (Issue #193 comment 6601921731, decision 1): the compatibility baseline for phase B
// (docs/design/phase-b-design.md §5). It pins TODAY's behaviour. A phase-B implementation PR must keep every case here
// green with its capabilities off; only a separately owner-approved PR may change what this file expects.
const REPO = resolve(__dirname, "../../../..");

const css = (decl: string) => `.x { ${decl} }`;

/** Each phase-B probe and what the strict lane says about it today (with no flag and with the existing flag). */
const PHASE_B_PROBES: Array<{ capability: string; css: string; today: string[] }> = [
  { capability: "web_font", css: `@font-face { font-family: "Pinned"; src: local("Pinned"); }`, today: ["CSS_AT_RULE"] },
  { capability: "display_scale", css: css("font-size: 300px;"), today: ["CSS_VALUE"] },
  { capability: "display_scale", css: css("font-size: 640px;"), today: ["CSS_VALUE"] },
  { capability: "colour_syntax", css: css("color: hsl(30 50% 40%);"), today: ["CSS_VALUE"] },
  { capability: "colour_syntax", css: css("color: oklch(0.6 0.1 40);"), today: ["CSS_VALUE"] },
  { capability: "colour_syntax", css: css("color: rebeccapurple;"), today: ["CSS_VALUE"] },
  { capability: "gradient_ground", css: css("background: linear-gradient(#000, #fff);"), today: ["CSS_VALUE"] },
  { capability: "gradient_ground", css: css("background-image: radial-gradient(#000, #fff);"), today: ["CSS_PROPERTY"] },
  { capability: "translucent_decoration", css: css("opacity: 0.5;"), today: ["CSS_VALUE"] },
  { capability: "image_filters", css: css("filter: grayscale(1);"), today: ["CSS_PROPERTY"] },
  { capability: "image_filters", css: css("filter: blur(2px);"), today: ["CSS_PROPERTY"] },
  { capability: "ornament", css: `.x::before { content: ""; }`, today: ["CSS_PROPERTY", "CSS_PSEUDO_ELEMENT"] },
  { capability: "ornament", css: `.x::after { content: ""; display: block; }`, today: ["CSS_PROPERTY", "CSS_PSEUDO_ELEMENT"] },
  { capability: "display_nowrap", css: css("white-space: nowrap;"), today: ["CSS_PROPERTY"] },
  { capability: "display_nowrap", css: css("word-break: keep-all;"), today: ["CSS_VALUE"] },
  { capability: "display_nowrap", css: css("letter-spacing: -0.02em;"), today: ["CSS_VALUE"] },
];

/** CSS that would fetch from outside the page: refused today, and phase B must keep it refused (design §2.4, §5). */
const FETCH_PROBES: Array<{ css: string; today: string[] }> = [
  { css: css("background: url(a.png);"), today: ["CSS_SYNTAX_URL"] },
  { css: `@import "x.css";`, today: ["CSS_AT_RULE"] },
  { css: `@font-face { font-family: "P"; src: url(f.woff2); }`, today: ["CSS_SYNTAX_URL"] },
  // a string, not url(): only the value grammar stops these, not the tokenizer's url check
  { css: css(`background: image-set("a.png" 1x);`), today: ["CSS_VALUE"] },
  { css: css(`background-image: image-set("a.png" 1x);`), today: ["CSS_PROPERTY"] },
  { css: css(`background: -webkit-image-set("a.png" 1x);`), today: ["CSS_VALUE"] },
];

/** Declarations the strict lane allows today; they must stay allowed. */
const ALLOWED_TODAY = [
  css("color: #123456;"),
  css("font-size: 48px;"),
  css("background: #f1ebdf;"),
  css("display: grid; grid-template-columns: 1fr auto 1fr;"),
  css("aspect-ratio: 1.45;"),
  css("text-wrap: balance;"),
  css("border-left: 3px solid #b88a35;"),
  css("writing-mode: horizontal-tb;"),
  css("min-height: 400px;"),
];

// `type_scale` is not searched: it is already a spec field name (the capability is named display_scale, design §2.2).
const PHASE_B_SNAKE = ["web_font", "colour_syntax", "gradient_ground", "translucent_decoration", "image_filters", "ornament", "display_nowrap", "display_scale"];
const camel = (n: string) => n.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
// both the capability names and the PageCssOptions keys they would become (design §3.3); `ornament` is one word in both
const PHASE_B_NAMES = [...new Set([...PHASE_B_SNAKE, ...PHASE_B_SNAKE.map(camel)])];

function filesUnder(path: string): string[] {
  if (statSync(path).isFile()) return [path];
  return readdirSync(path).flatMap((n) => filesUnder(join(path, n)));
}

describe("DEV-161: phase B compatibility baseline (today's behaviour, flag off)", () => {
  it.each(PHASE_B_PROBES)("refuses $capability probe $css today", ({ css: probe, today }) => {
    expect(cssProblems(probe)).toEqual(today);
    expect(cssProblems(probe, { verticalName: true })).toEqual(today);
  });

  it.each(FETCH_PROBES)("refuses outside fetch $css today", ({ css: probe, today }) => {
    expect(cssProblems(probe)).toEqual(today);
    expect(cssProblems(probe, { verticalName: true })).toEqual(today);
  });

  it("records today's gap: root font-size times rem passes the static check (design §2.2)", () => {
    // 256px × 16rem = 4096px text; phase B's computed-px cap must close this, and that PR changes this expectation
    expect(cssProblems(`html { font-size: 256px; } .x { font-size: 16rem; }`)).toEqual([]);
  });

  it("searches camelCase option keys as well as capability names", () => {
    expect(PHASE_B_NAMES).toEqual(expect.arrayContaining(["webFont", "displayScale", "displayNowrap", "imageFilters"]));
  });

  it.each(ALLOWED_TODAY)("still allows %s", (decl) => {
    expect(cssProblems(decl)).toEqual([]);
    expect(cssProblems(decl, { verticalName: true })).toEqual([]);
  });

  it("keeps vertical writing behind its existing flag only", () => {
    expect(cssProblems(css("writing-mode: vertical-rl;"))).toEqual(["CSS_VALUE"]);
    expect(cssProblems(css("writing-mode: vertical-rl;"), { verticalName: true })).toEqual([]);
  });

  it("has no capability but vertical_name, and none approved", () => {
    expect([...CAPABILITY_NAMES]).toEqual(["vertical_name"]);
    expect([...APPROVED_CAPABILITIES]).toEqual([]);
  });

  it("has no CSS option key but verticalName", () => {
    const src = readFileSync(resolve(REPO, "lib/design-agent/comp-impl/page-css.ts"), "utf8");
    const types = src.match(/export type PageCssOptions = [^\n]*/g);
    expect(types).toEqual(["export type PageCssOptions = { verticalName?: boolean };"]);
  });

  it("names no phase-B capability in the production worker path", () => {
    const paths = [...filesUnder(resolve(REPO, "scripts/sales-design-worker")), resolve(REPO, "lib/design-agent/comp-impl/run.ts")];
    expect(paths.length).toBeGreaterThan(1);
    const hits = paths.flatMap((p) => {
      const text = readFileSync(p, "utf8");
      return PHASE_B_NAMES.filter((n) => text.includes(n)).map((n) => `${p.slice(REPO.length + 1)}: ${n}`);
    });
    expect(hits).toEqual([]);
  });
});
