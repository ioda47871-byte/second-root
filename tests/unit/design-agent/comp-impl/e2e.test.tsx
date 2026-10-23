import { readFileSync } from "node:fs";
import { chmod, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Browser } from "playwright";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import ProfileRenderer from "@/components/demo/profile/ProfileRenderer";
import { CompImplError, sha256 } from "@/lib/design-agent/comp-impl/bundle";
import { antiTemplateCheck, templateCss } from "@/lib/design-agent/comp-impl/anti-template";
import { failedChecks, loadReferences, runCompImpl, writeCompImplOutputs, type RunResult } from "@/lib/design-agent/comp-impl/run";
import { buildSyntheticBundle } from "@/lib/design-agent/comp-impl/synthetic";
import { loadHandWritten, parseShop } from "@/lib/design-agent/compare/shops";
import { disclosureCheck, domProblems, factsCheck, imagesCheck, legibilityCheck, pairsCheck, protectedGeometryCheck, requiredDisclosure, structureCheck, sweepCheck } from "@/lib/design-agent/comp-impl/checks";
import { cssProblems, loadCompPage } from "@/lib/design-agent/comp-impl/page";
import { compMeasure, DESKTOP, domAudit, fingerprintOf, legibilityPass, legibilitySweep, mediaSegments, openCompPage, pageWidths, protectedGeometryPass } from "@/lib/design-agent/comp-impl/render";
import { factStrings } from "@/lib/design-agent/compare/shops";
import { infoPairs, type CompSpec } from "@/lib/design-agent/comp-impl/spec";
import { POC_DISCLOSURE, POC_DISCLOSURE_V2 } from "@/lib/design-agent/design-image/prompt";
import { FACTS_SOURCE, FIXTURE, flatPng, launch, pageCopy, privateTemp, removeDir, REPO } from "./support";

// DEV-082 end to end in Chromium: the synthetic comp is rendered to a bundle,
// the hand-written page is checked with the network shut, and changed copies
// of the page fail the right check. Fictional shop only; no AI image (the AI
// disclosure logic is tested with a flat PNG flagged as an AI concept asset);
// nothing is fetched or published.

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

let browser: Browser;
let bundle: string;
const temps: string[] = [];
beforeAll(async () => {
  browser = await launch();
  bundle = await privateTemp("bundle-");
  temps.push(bundle);
  await buildSyntheticBundle(browser, REPO, bundle);
  defects = await defectsRun();
});
afterAll(async () => {
  await browser?.close();
  for (const t of temps) await removeDir(t);
});

const run = (pageDir: string) => runCompImpl({ bundleDir: bundle, pageDir, repoDir: REPO, factsSourcePath: FACTS_SOURCE, browser });

/**
 * One full run of a page with several independent defects at once (CI time: one run instead of seven; each check
 * is asserted on its own code below). Each defect touches a different part of the page:
 *   an invented price in a caption · a rule wider than a phone · a request for a file the page lacks · the phone
 *   number under aria-hidden · a fixed height on the footer · a label written into a paragraph · an underline on the
 *   disclosure
 */
let defects: RunResult;
const spec = () => JSON.parse(readFileSync(join(FIXTURE, "layout-spec.json"), "utf8")) as CompSpec;
const demo = () => parseShop(JSON.parse(readFileSync(FACTS_SOURCE, "utf8")) as unknown)!.demo;
const PHONE_DD = '<dd data-comp-type="body">052-000-0731</dd>';
async function defectsRun(): Promise<RunResult> {
  return changed(async (d) => {
    await editFile(d, "index.html", (s) =>
      s
        .replace('<p class="goods-caption" data-comp-type="caption">季節の上生菓子</p>', '<p class="goods-caption" data-comp-type="caption">季節の上生菓子 350円</p>')
        .replace('<span class="lead-visual-disc"></span>', '<span class="lead-visual-disc"></span><img src="assets/missing.png" alt="">')
        .replace(PHONE_DD, '<dd data-comp-type="body" aria-hidden="true">052-000-0731</dd>')
        .replace('<p class="colophon-name"', '<p>電話：9:00〜18:00（売り切れ次第終了）</p><p class="colophon-name"'),
    );
    await editFile(d, "style.css", (s) => `${s}\n.lead-rule { width: 700px; }\n.colophon { height: 60px; }\n.colophon-note { text-decoration: underline; }\n`);
  });
}
async function changed(edit: (dir: string) => Promise<void>): Promise<RunResult> {
  const dir = await pageCopy("page-");
  temps.push(dir);
  await edit(dir);
  return run(dir);
}
const editFile = async (dir: string, name: string, f: (s: string) => string) => writeFile(join(dir, name), f(await readFile(join(dir, name), "utf8")));

describe("comp-to-site on the synthetic fixture", () => {
  let result: RunResult;
  beforeAll(async () => {
    result = await run(join(FIXTURE, "page"));
  });

  it("passes every mechanical check and still claims nothing about fidelity", () => {
    const r = result.report;
    expect(r.failed).toEqual([]);
    expect(r.mechanical_ok).toBe(true);
    expect(r.fidelity_status).toBe("synthetic_only");
    expect(r.faithful_reproduction_claimed).toBe(false);
    expect(r.similarity).toMatchObject({ status: "synthetic_only", passing: false });
    expect(r.similarity.ssim).toBeGreaterThan(0.5);
    expect(r.anti_template.min_distance).toBeGreaterThan(r.anti_template.threshold);
    expect(r.page.network_blocked).toBe(0);
    expect(r.bundle).toMatchObject({ comp_kind: "synthetic", comp_approved: false, eval_human_confirmed: false });
    expect(r.checks.overflow!.widths).toEqual([320, 360, 390, 759, 760, 761, 768, 1024, 1440, 1920]); // base widths + 1px around the 760px breakpoint
    expect(r.checks.protected_1px).toMatchObject({ ok: true, widths: 1601, failing_widths: 0 });
  });

  it("DEV-097: reports a per-section comparison for every spec section, desktop only, never a pass", () => {
    const s = result.report.similarity.sections;
    expect(s).toMatchObject({ viewport: "desktop_1440", mobile: "not_compared_no_mobile_comp", passing: false, code: null });
    expect(s.items.map((i) => i.id)).toEqual(["header", "hero", "products", "info", "footer"]);
    for (const item of s.items) {
      expect(item.code).toBeNull();
      // the synthetic page was drawn to the same plan as its comp: the numbers only show the measurement runs end to end
      expect(item.colour!.dominant_delta_e).toBeLessThan(5);
      expect(Math.abs(item.height_share!.ratio - 1)).toBeLessThan(0.1);
      expect(item.edges!.comp_density).toBeGreaterThanOrEqual(0);
    }
    // the section report is an added field; the run's verdict is the mechanical checks alone
    expect(result.report.failed).toEqual([]);
  });

  it("DEV-083 phase A: the added checks ran at every checked width and on the sweep, and pass (blocking and advisory)", () => {
    const r = result.report;
    const layers = Object.keys(r.checks).filter((k) => /^layers_\d+$/.test(k));
    expect(layers.length).toBe((r.checks.overflow!.widths as number[]).length);
    for (const k of [...layers, "layers_sweep", "visibility_matrix", "capabilities"]) expect(r.checks[k], k).toMatchObject({ ok: true, codes: [] });
    expect(r.checks.layers_sweep).toMatchObject({ widths: 51 });
    expect(r.capabilities).toEqual([]);
    // the advisory findings (never in `failed`) are empty on the synthetic page too
    for (const [k, a] of Object.entries(r.advisory)) expect(a, k).toMatchObject({ ok: true, codes: [] });
    expect(Object.keys(r.advisory)).toContain("layers_sweep");
  });

  it("writes report.json and both screenshots privately, outside the repository", async () => {
    const out = await privateTemp("out-");
    temps.push(out);
    const dest = await writeCompImplOutputs(join(out, "root"), result, { repoDir: REPO, env: { HOME: out }, inputs: [bundle] });
    expect((await stat(dest)).mode & 0o777).toBe(0o700);
    for (const f of ["report.json", "desktop.png", "mobile.png"]) expect((await stat(join(dest, f))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(join(dest, "report.json"), "utf8"))).toMatchObject({ fidelity_status: "synthetic_only", mechanical_ok: true });
    const refuse = async (root: string) => writeCompImplOutputs(root, result, { repoDir: REPO, env: { HOME: out }, inputs: [bundle] }).then(() => "WRITTEN", (e: unknown) => (e instanceof CompImplError ? e.code : "OTHER"));
    expect(await refuse(join(REPO, "tmp-out"))).toBe("OUTPUT_UNSAFE");
    expect(await refuse(join(bundle, "out"))).toBe("OUTPUT_UNSAFE");
    expect(await refuse(join(out, ".local/share/second-root-design-assets/x"))).toBe("OUTPUT_UNSAFE");
    expect(await refuse("relative/out")).toBe("OUTPUT_UNSAFE");
  });

  it("fails an invented price", () => {
    expect(defects.report.mechanical_ok).toBe(false);
    expect(defects.report.checks.facts_desktop!.codes).toContain("FACTS_UNKNOWN_TEXT");
    // and the finding points at the invented price, not at some other leftover
    expect(defects.report.checks.facts_desktop!.unknown_text).toEqual(["350円"]);
  });

  it("fails an AI concept image shown without the AI disclosure, and passes the disclosure once it is there", async () => {
    const png = flatPng(600, 400, [234, 225, 210]); // a flat test image, flagged as an AI concept asset to test the rule
    const withAi = async (d: string) => {
      await mkdir(join(d, "assets"));
      await writeFile(join(d, "assets/hero.png"), png);
      await writeFile(join(d, "assets.json"), JSON.stringify({ version: 1, assets: [{ id: "hero", file: "assets/hero.png", sha256: sha256(png), kind: "ai_concept_local", approval: { approved_by: "owner", approved_at: "2026-10-22T09:00:00+09:00", record_id: "test-record" }, published: false }] }));
      await editFile(d, "index.html", (s) => s.replace(/<div class="lead-visual" data-comp-slot="hero-visual" data-comp-placeholder>\s*<span class="lead-visual-disc"><\/span>\s*<\/div>/, '<img class="lead-visual" data-comp-slot="hero-visual" src="assets/hero.png" alt="どら焼きの断面と粒あんのイメージ（AI生成）">'));
      await editFile(d, "style.css", (s) => `${s}\nimg.lead-visual { display: block; width: 100%; height: auto; object-fit: cover; }\n`);
    };
    // the desktop measurement and the same checks run.ts applies to it (one page load instead of a full run)
    const desktopChecks = async (edit: (d: string) => Promise<void>) => {
      const dir = await pageCopy("ai-");
      temps.push(dir);
      await edit(dir);
      const page = await loadCompPage(dir);
      const o = await openCompPage(browser, page, DESKTOP);
      try {
        const m = await compMeasure(o.page);
        const disclosure = requiredDisclosure(page.assets, m);
        return { page, disclosure: disclosureCheck(m, spec(), disclosure), images: imagesCheck(m, spec(), page.assets), facts: factsCheck(m, { spec: spec(), demo: demo(), disclosure }) };
      } finally {
        await o.context.close();
      }
    };
    const r = await desktopChecks(withAi);
    expect(r.page.assets.filter((a) => a.kind === "ai_concept_local")).toHaveLength(1);
    expect(r.disclosure.codes).toContain("DISCLOSURE_TEXT");
    const fixed = await desktopChecks(async (d) => {
      await withAi(d);
      await editFile(d, "index.html", (s) => s.replace('data-comp-disclosure>架空店舗のデザイン提案<', `data-comp-disclosure>${POC_DISCLOSURE_V2}<`));
    });
    expect(fixed.disclosure.codes).toEqual(["DISCLOSURE_SPEC_MISMATCH"]); // the spec was written for placeholders
    expect(fixed.images.codes).toEqual(["SLOT_KIND"]);
    expect(fixed.facts.ok).toBe(true);
  });

  it("fails horizontal overflow at the narrow widths", () => {
    expect(defects.report.checks.overflow!.codes).toEqual(["OVERFLOW_HORIZONTAL"]);
    expect(defects.report.checks.overflow!.overflowing).toContain(320);
  });

  it("fails the renderer's markup as a page (template reuse)", async () => {
    const shop = parseShop(JSON.parse(readFileSync(FACTS_SOURCE, "utf8")) as unknown)!;
    const profile = (await loadHandWritten(join(REPO, "scripts/sales-design-worker/compare/hand-written"), ["wagashi"])).wagashi!;
    const body = renderToStaticMarkup(<ProfileRenderer demo={shop.demo} profile={profile} />)
      .replace(/<svg[\s\S]*?<\/svg>/g, "")
      .replace(/\sstyle="[^"]*"/g, "")
      .replace(/https?:\/\/[^"'\s<>]*/g, "#"); // a copier would strip what the source check refuses
    const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body>${body}</body></html>`;
    // the guard as run.ts applies it (the page's structure is parsed, not rendered)
    const anti = antiTemplateCheck({ html, css: readFileSync(join(FIXTURE, "page/style.css"), "utf8"), fingerprint: await fingerprintOf(browser, html), references: await loadReferences(REPO), templateCss: await templateCss(REPO) });
    expect(anti.ok).toBe(false);
    expect(anti.codes).toEqual(expect.arrayContaining(["TEMPLATE_RENDERER_MARKER", "TEMPLATE_STRUCTURE_TOO_CLOSE"]));
    expect(failedChecks({ facts: { ok: true, codes: [] } }, anti)).toEqual(["anti_template"]); // and the run is not mechanically ok
  });

  it("counts a request for a file the page does not have, and never renders a page with a script", async () => {
    expect(defects.report.checks.network!.codes).toEqual(["NETWORK_REQUEST_BLOCKED"]);
    await expect(changed((d) => editFile(d, "index.html", (s) => s.replace("</body>", "<script>fetch('https://example.com')</script></body>")))).rejects.toMatchObject({ code: "PAGE_SOURCE_REFUSED" });
  });
});

describe("probes: the disclosure and the required facts must be readable", () => {
  const demo = parseShop(JSON.parse(readFileSync(FACTS_SOURCE, "utf8")) as unknown)!.demo;
  const all = factStrings(demo).map((f) => f.text.replace(/\s+/g, ""));
  const required = [demo.name, demo.hours!, demo.closedDays!, demo.address!, demo.access!, demo.phone!, demo.description!].map((f) => f.replace(/\s+/g, ""));
  const DISCLOSURE = 'class="colophon-note" data-comp-disclosure';
  const PHONE = '<dd data-comp-type="body">052-000-0731</dd>';
  async function legibility(edit: (dir: string) => Promise<void>, disclosure = POC_DISCLOSURE) {
    const dir = await pageCopy("probe-");
    temps.push(dir);
    await edit(dir);
    const pass = await legibilityPass(browser, await loadCompPage(dir), 1440, all, required, { pairs: infoPairs(demo), facts: all });
    return legibilityCheck(pass, { required, disclosure });
  }
  const css = (rule: string) => (d: string) => editFile(d, "style.css", (s) => `${s}\n${rule}\n`);
  const html = (from: string, to: string) => (d: string) => editFile(d, "index.html", (s) => s.replace(from, to));

  it("the synthetic page's disclosure and facts are readable", async () => {
    expect(await legibility(async () => {})).toMatchObject({ ok: true, codes: [] });
  });

  it.each<[string, (d: string) => Promise<void>, string[]]>([
    ["color: transparent", css(".colophon-note { color: transparent; }"), ["DISCLOSURE_COLOUR_ALPHA", "DISCLOSURE_LOW_CONTRAST"]],
    ["-webkit-text-fill-color: transparent", css(".colophon-note { -webkit-text-fill-color: transparent; }"), ["DISCLOSURE_TEXT_FILL", "DISCLOSURE_NO_INK"]],
    ["the ground's own colour", css(".colophon-note { color: #F4EEE3; }"), ["DISCLOSURE_LOW_CONTRAST"]],
    ["zoom: 0.1", css(".colophon-note { zoom: 0.1; }"), ["DISCLOSURE_TOO_SMALL"]],
    ["clip-path: inset(50%)", css(".colophon-note { clip-path: inset(50%); }"), ["DISCLOSURE_EFFECT"]],
    ["scale(.05) with opacity .05", css(".colophon-note { transform: scale(.05); opacity: .05; }"), ["DISCLOSURE_TOO_SMALL", "DISCLOSURE_FADED"]],
    ["filter: opacity(.05)", css(".colophon-note { filter: opacity(.05); }"), ["DISCLOSURE_EFFECT"]],
    ["aria-hidden and off-screen", async (d) => {
      await html(DISCLOSURE, `${DISCLOSURE} aria-hidden="true"`)(d);
      await css(".colophon-note { position: absolute; left: -9999px; }")(d);
    }, ["TEXT_ARIA_HIDDEN", "DISCLOSURE_NOT_MEASURED", "DISCLOSURE_NOT_LEGIBLE"]],
    ["aria-hidden with clip-path", async (d) => {
      await html(DISCLOSURE, `${DISCLOSURE} aria-hidden="true"`)(d);
      await css(".colophon-note { clip-path: inset(50%); }")(d);
    }, ["TEXT_ARIA_HIDDEN", "DISCLOSURE_NOT_LEGIBLE"]],
    ["aria-hidden with scale and opacity", async (d) => {
      await html(DISCLOSURE, `${DISCLOSURE} aria-hidden="true"`)(d);
      await css(".colophon-note { transform: scale(.05); opacity: .05; }")(d);
    }, ["TEXT_ARIA_HIDDEN", "DISCLOSURE_NOT_LEGIBLE"]],
    ["a required fact under aria-hidden, off-screen", async (d) => {
      await html(PHONE, '<dd data-comp-type="body" aria-hidden="true" class="gone">052-000-0731</dd>')(d);
      await css(".gone { position: absolute; left: -9999px; }")(d);
    }, ["TEXT_ARIA_HIDDEN", "FACTS_REQUIRED_NOT_LEGIBLE"]],
    ["a required fact in the ground's colour", css(".facts-row dd { color: #EAE1D2; }"), ["FACT_LOW_CONTRAST", "FACTS_REQUIRED_NOT_LEGIBLE"]],
    ["a required fact with a transparent fill", css(".facts-row dd { -webkit-text-fill-color: transparent; }"), ["FACT_TEXT_FILL", "FACTS_REQUIRED_NOT_LEGIBLE"]],
  ])("fails %s", async (_n, edit, codes) => {
    const r = await legibility(edit);
    expect(r.ok).toBe(false);
    expect(r.codes).toEqual(expect.arrayContaining(codes));
  });

  it("applies the same rules to the AI disclosure", async () => {
    const r = await legibility(async (d) => {
      await html("data-comp-disclosure>架空店舗のデザイン提案<", `data-comp-disclosure>${POC_DISCLOSURE_V2}<`)(d);
      await css(".colophon-note { color: transparent; }")(d);
    }, POC_DISCLOSURE_V2);
    expect(r.codes).toEqual(expect.arrayContaining(["DISCLOSURE_COLOUR_ALPHA", "DISCLOSURE_LOW_CONTRAST"]));
  });

  it("a hidden required fact fails the whole run, at every width checked", () => {
    // the shared defects run hides the phone number under aria-hidden
    const r = defects;
    expect(r.report.mechanical_ok).toBe(false);
    const widths = Object.keys(r.report.checks).filter((k) => /^legibility_\d+$/.test(k));
    expect(widths).toEqual(["legibility_320", "legibility_360", "legibility_390", "legibility_759", "legibility_760", "legibility_761", "legibility_768", "legibility_1024", "legibility_1440", "legibility_1920"]);
    for (const k of widths) expect(r.report.checks[k]!.codes).toEqual(expect.arrayContaining(["TEXT_ARIA_HIDDEN", "FACTS_REQUIRED_NOT_LEGIBLE"]));
  });

  it.each<[string, string, string]>([
    ["list-style with a string", 'li.goods-card { display: list-item; list-style: "SALE 50% OFF" inside; }', "CSS_VALUE"],
    ["hyphenate-character", '.goods-copy { hyphens: manual; hyphenate-character: "$9.80"; }', "CSS_PROPERTY"],
    ["bidi override on a fact", ".facts-row dd { unicode-bidi: bidi-override; direction: rtl; }", "CSS_PROPERTY"],
    ["::first-letter shrinking a fact", ".facts-row dd::first-letter { font-size: 1px; }", "CSS_PSEUDO_ELEMENT"],
    ["::first-letter hiding the disclosure", ".colophon-note::first-letter { color: transparent; }", "CSS_PSEUDO_ELEMENT"],
    ["a mirrored fact", ".facts-row dd { transform: scaleX(-1); }", "CSS_PROPERTY"], // no transform at all since the fourth review
    ["a filter on the hero visual", ".lead-visual { filter: contrast(40); }", "CSS_PROPERTY"],
    ["a print-only rule", "@media print { .colophon-note { color: #F4EEE3; } }", "CSS_MEDIA"],
    ["a scripting-only rule", "@media (scripting: none) { .colophon-note { color: #F4EEE3; } }", "CSS_MEDIA"],
  ])("never renders a page whose stylesheet is outside the allowlist (%s)", async (_n, rule, code) => {
    const error = await changed(css(rule)).then(
      () => null,
      (e: unknown) => e as { code?: string; problems?: string[] },
    );
    expect(error?.code).toBe("PAGE_SOURCE_REFUSED");
    expect(error?.problems).toContain(code);
  });

  it("checks every width around a breakpoint: text hidden only at tablet widths fails", async () => {
    const rule = "@media (min-width: 761px) and (max-width: 767px) { .colophon-note { color: #F4EEE3; } }";
    const dir = await pageCopy("tablet-");
    temps.push(dir);
    await css(rule)(dir);
    const page = await loadCompPage(dir);
    // the widths run.ts checks for this stylesheet include both edges of the rule; the pixel proof fails there only
    const widths = pageWidths(page.css);
    expect(widths).toEqual(expect.arrayContaining([760, 761, 762, 766, 767, 768]));
    const at = async (w: number) => legibilityCheck(await legibilityPass(browser, page, w, all, required, { pairs: infoPairs(demo), facts: all }), { required, disclosure: POC_DISCLOSURE });
    expect((await at(761)).codes).toContain("DISCLOSURE_LOW_CONTRAST");
    expect((await at(767)).codes).toContain("DISCLOSURE_LOW_CONTRAST");
    expect((await at(1440)).ok).toBe(true);
  });

  it("refuses extra ink on protected text (an underline, allowed elsewhere, over the disclosure)", () => {
    // the shared defects run underlines the disclosure
    expect(defects.report.checks.legibility_1440!.codes).toEqual(expect.arrayContaining(["DISCLOSURE_DECORATED", "DISCLOSURE_INK_EXCESS"]));
    expect(defects.report.mechanical_ok).toBe(false);
  });

  it("the ink bound holds even past the stylesheet check (a line-through, measured directly)", async () => {
    const r = await legibility(css(".colophon-note { text-decoration: line-through; }"));
    expect(r.codes).toContain("DISCLOSURE_INK_EXCESS");
  });
});

describe("output root", () => {
  const fake = (): RunResult => ({ report: { bundle: { shop: "wagashi" } } as RunResult["report"], desktop: Buffer.from("d"), mobile: Buffer.from("m") });
  const write = (root: string, inputs: string[] = []) => writeCompImplOutputs(root, fake(), { repoDir: REPO, env: { HOME: "/nonexistent-home" }, inputs }).then(() => "WRITTEN", (e: unknown) => (e instanceof CompImplError ? e.code : String(e)));

  it("refuses a forbidden root before creating anything", async () => {
    const target = join(REPO, "tmp-comp-impl-out", "deeper");
    expect(await write(target)).toBe("OUTPUT_UNSAFE");
    await expect(stat(join(REPO, "tmp-comp-impl-out"))).rejects.toThrow();
  });

  it("uses an existing root only when it is this user's private directory, and never changes its mode", async () => {
    const base = await privateTemp("root-");
    temps.push(base);
    const open = join(base, "open");
    await mkdir(open, { mode: 0o755 });
    await chmod(open, 0o755);
    expect(await write(open)).toBe("OUTPUT_UNSAFE");
    expect((await stat(open)).mode & 0o777).toBe(0o755);
    const link = join(base, "link");
    const target = join(base, "target");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, link);
    expect(await write(link)).toBe("OUTPUT_UNSAFE");
    expect(await write(target)).toBe("WRITTEN");
    const fresh = join(base, "new", "root");
    expect(await write(fresh)).toBe("WRITTEN");
    expect((await stat(fresh)).mode & 0o777).toBe(0o700);
  });
});

// third review of PR #96 (7b612c1): combinations of allowed properties that passed the whole run
describe("probes: third review", () => {
  const demo = parseShop(JSON.parse(readFileSync(FACTS_SOURCE, "utf8")) as unknown)!.demo;
  const all = factStrings(demo).map((f) => f.text.replace(/\s+/g, ""));
  const required = [demo.name, demo.hours!, demo.closedDays!, demo.address!, demo.access!, demo.phone!, demo.description!].map((f) => f.replace(/\s+/g, ""));
  const css = (rule: string) => (d: string) => editFile(d, "style.css", (s) => `${s}\n${rule}\n`);
  const html = (from: string | RegExp, to: string) => (d: string) => editFile(d, "index.html", (s) => s.replace(from, to));
  async function copy(edit: (dir: string) => Promise<void>) {
    const dir = await pageCopy("third-");
    temps.push(dir);
    await edit(dir);
    return loadCompPage(dir);
  }
  async function structure(edit: (dir: string) => Promise<void>) {
    const o = await openCompPage(browser, await copy(edit), DESKTOP);
    try {
      return { dom: domProblems(await domAudit(o.page)), structure: structureCheck(await compMeasure(o.page)) };
    } finally {
      await o.context.close();
    }
  }
  async function at(edit: (dir: string) => Promise<void>, width = 1440) {
    const pass = await legibilityPass(browser, await copy(edit), width, all, required, { pairs: infoPairs(demo), facts: all });
    return { legibility: legibilityCheck(pass, { required, disclosure: POC_DISCLOSURE }), pairs: pairsCheck(pass.pairs) };
  }

  it("the synthetic page passes the new structure and pair checks", async () => {
    expect((await structure(async () => {})).structure).toMatchObject({ ok: true, codes: [] });
    expect((await at(async () => {})).pairs).toMatchObject({ ok: true, codes: [] });
  });

  // 1: a fixed-height box around wrapping text (the reviewer's disclosure was covered at 576–660 px)
  it.each([
    ["height on the footer", ".colophon { height: 60px; }"],
    ["max-height on the facts list", ".facts-list { max-height: 100px; }"],
    ["block-size inside a media rule", "@media (min-width: 900px) { .colophon-inner { block-size: 40px; } }"],
  ])("fails a fixed height on an element holding text (%s)", async (_n, rule) => {
    expect((await structure(css(rule))).structure.codes).toContain("FIXED_HEIGHT_TEXT");
  });

  it("the coarse sweep re-measures protected text at each width in one context", async () => {
    const page = await copy(css("@media (min-width: 600px) and (max-width: 620px) { .colophon-note { opacity: 0.5; } }"));
    const run = await legibilitySweep(browser, page, all, required, { pairs: infoPairs(demo), facts: all }, [320, 576, 608, 640, 1920]);
    const r = sweepCheck(run.widths, { required, disclosure: POC_DISCLOSURE });
    expect(r.ok).toBe(false);
    expect(r.failing_widths).toEqual([608]);
    expect(r.codes).toContain("DISCLOSURE_FADED");
  });

  // 2: labels beside other values
  it("fails a label outside a dl and a dt without its dd", async () => {
    expect((await at(html('<p class="colophon-name"', '<p>電話</p><p class="colophon-name"'))).pairs.codes).toContain("LABEL_OUTSIDE_DL");
    expect((await at(html('<dd data-comp-type="body">052-000-0731</dd>', '<dt data-comp-type="body">052-000-0731</dt>'))).pairs.codes).toContain("DT_WITHOUT_DD");
  });
  it.each([
    ["grid order (measured directly; order is refused by the stylesheet check)", ".facts-row dt { order: 2; }"],
    ["a wrapping column flex across rules (measured directly)", ".facts-list { display: flex; flex-direction: column; } .facts-list { flex-wrap: wrap; max-height: 160px; }"],
  ])("fails label / value pairs out of reading order: %s", async (_n, rule) => {
    expect((await at(css(rule))).pairs.codes).toContain("PAIR_ORDER");
  });

  // 3: nested rotations add up
  it("fails a disclosure turned 96 degrees by twelve nested 8-degree rotations", async () => {
    const nested = `${'<span class="r">'.repeat(12)}架空店舗のデザイン提案${"</span>".repeat(12)}`;
    const r = await structure(async (d) => {
      await html("data-comp-disclosure>架空店舗のデザイン提案<", `data-comp-disclosure>${nested}<`)(d);
      await css(".r { display: inline-block; transform: rotate(8deg); }")(d);
    });
    expect(r.structure.codes).toContain("TEXT_ROTATED");
  });

  // 4: list markers draw digits or discs
  it("fails an ol (not an allowed element) and the default ul disc", async () => {
    const ol = await structure(html(/<ul class="masthead-links">([\s\S]*?)<\/ul>/, '<ol class="masthead-links">$1</ol>'));
    expect(ol.dom.codes).toContain("DOM_ELEMENT_NOT_ALLOWED");
    expect(ol.structure.codes).toContain("LIST_MARKER");
    const disc = await structure((d) => editFile(d, "style.css", (s) => s.replace("ul { list-style: none; }", "")));
    expect(disc.structure.codes).toContain("LIST_MARKER");
  });

  // 5: an underline on protected text is refused up front, with its own code
  it.each([
    ["on the disclosure", ".colophon-note { text-decoration: underline; }"],
    ["inherited from an ancestor", ".colophon { text-decoration: underline; }"],
  ])("refuses an underline %s (DISCLOSURE_DECORATED)", async (_n, rule) => {
    expect((await at(css(rule))).legibility.codes).toContain("DISCLOSURE_DECORATED");
  });

  // the whole run carries the new checks
  it("a full run reports structure, pairs at every checked width and the coarse sweep", () => {
    // the shared defects run fixes the footer's height
    const r = defects;
    expect(r.report.mechanical_ok).toBe(false);
    expect(r.report.checks.structure_desktop!.codes).toContain("FIXED_HEIGHT_TEXT");
    expect(Object.keys(r.report.checks).filter((k) => k.startsWith("pairs_")).length).toBe(10);
    expect(r.report.checks.legibility_sweep).toMatchObject({ widths: 51 });
  });

  it.each([
    ["the reviewer's clamp() with vw", ".colophon-note { font-size: clamp(12px, 2.6vw, 16px); }", "CSS_VIEWPORT_UNIT"],
    ["text-transform on a fact", ".facts-row dd { text-transform: uppercase; }", "CSS_VALUE"],
    ["grid-auto-flow: column", ".facts-list { display: grid; grid-auto-flow: column; }", "CSS_VALUE"],
    ["float", ".facts-row dt { float: right; }", "CSS_VALUE"],
  ])("never renders %s", async (_n, rule, code) => {
    const error = await changed(css(rule)).then(
      () => null,
      (e: unknown) => e as { code?: string; problems?: string[] },
    );
    expect(error?.code).toBe("PAGE_SOURCE_REFUSED");
    expect(error?.problems).toContain(code);
  });
});

// fourth review of PR #96 (0301171): close the causes — no box above earlier text, no box shorter than its text, labels
// mapped to their facts
describe("probes: fourth review", () => {
  const demo = parseShop(JSON.parse(readFileSync(FACTS_SOURCE, "utf8")) as unknown)!.demo;
  const all = factStrings(demo).map((f) => f.text.replace(/\s+/g, ""));
  const required = [demo.name, demo.hours!, demo.closedDays!, demo.address!, demo.access!, demo.phone!, demo.description!].map((f) => f.replace(/\s+/g, ""));
  const plan = { pairs: infoPairs(demo), facts: all };
  const css = (rule: string) => (d: string) => editFile(d, "style.css", (s) => `${s}\n${rule}\n`);
  const html = (from: string | RegExp, to: string) => (d: string) => editFile(d, "index.html", (s) => s.replace(from, to));
  const HOURS = '<dd data-comp-type="body">9:00〜18:00（売り切れ次第終了）</dd>';
  const PHONE = '<dd data-comp-type="body">052-000-0731</dd>';
  async function copy(edit: (dir: string) => Promise<void>) {
    const dir = await pageCopy("fourth-");
    temps.push(dir);
    await edit(dir);
    return loadCompPage(dir);
  }
  async function structure(edit: (dir: string) => Promise<void>) {
    const o = await openCompPage(browser, await copy(edit), DESKTOP);
    try {
      return structureCheck(await compMeasure(o.page));
    } finally {
      await o.context.close();
    }
  }
  async function at(edit: (dir: string) => Promise<void>, width = 1440) {
    const pass = await legibilityPass(browser, await copy(edit), width, all, required, plan);
    return { legibility: legibilityCheck(pass, { required, disclosure: POC_DISCLOSURE }), pairs: pairsCheck(pass.pairs) };
  }

  it("the synthetic page passes the label-to-fact map and the box checks", async () => {
    const r = await at(async () => {});
    expect(r.pairs).toMatchObject({ ok: true, codes: [], pairs: 5 });
    expect((await structure(async () => {})).ok).toBe(true);
  });

  // F1, as the reviewer wrote it: aspect-ratio + min-height:0 in a wrapping flex row, covered by a later relative sibling
  it("never renders the reviewer's F1 page (a positioned sibling)", async () => {
    const error = await changed(async (d) => {
      await html('<p class="colophon-note" data-comp-disclosure>架空店舗のデザイン提案</p>', '<p class="colophon-note" data-comp-disclosure>架空店舗のデザイン提案</p><div class="cover"></div>')(d);
      await css(".colophon-inner { flex-wrap: wrap; } .colophon-note { flex: 0 0 30%; aspect-ratio: 10 / 1; min-height: 0; } .cover { position: relative; flex: 0 0 100%; min-height: 40px; margin-top: 0; background: #F4EEE3; }")(d);
    }).then(
      () => null,
      (e: unknown) => e as { code?: string; problems?: string[] },
    );
    expect(error?.code).toBe("PAGE_SOURCE_REFUSED");
    expect(error?.problems).toContain("CSS_VALUE");
  });
  it.each([
    ["aspect-ratio on text", ".colophon-note { aspect-ratio: 10 / 1; }", "ASPECT_RATIO_TEXT"],
    ["min-height: 0 on text", ".colophon-note { min-height: 0; }", "MIN_HEIGHT_ZERO_TEXT"],
    ["min-block-size: 0 on text", ".facts-row { min-block-size: 0px; }", "MIN_HEIGHT_ZERO_TEXT"],
    ["a length flex-basis in a column flex", ".colophon-inner { flex-direction: column; } .colophon-note { flex: 0 0 4px; }", "COLUMN_FLEX_BASIS_TEXT"],
  ])("fails a box that can be shorter than its text: %s", async (_n, rule, code) => {
    expect((await structure(css(rule))).codes).toContain(code);
  });
  it("fails any text box whose content is taller than the box (measured directly, past the stylesheet check)", async () => {
    expect((await at(css(".colophon-note { height: 4px; }"))).pairs.codes).toContain("TEXT_BOX_OVERFLOW");
  });
  it("the sweep sees the F1 cover between sampled widths (measured directly, past the stylesheet check)", async () => {
    const page = await copy(async (d) => {
      await html('<p class="colophon-note" data-comp-disclosure>架空店舗のデザイン提案</p>', '<p class="colophon-note" data-comp-disclosure>架空店舗のデザイン提案</p><div class="cover"></div>')(d);
      await css(".colophon-inner { flex-wrap: wrap; } .colophon-note { flex: 0 0 30%; aspect-ratio: 10 / 1; min-height: 0; } .cover { position: relative; flex: 0 0 100%; min-height: 40px; margin-top: -20px; background: #F4EEE3; }")(d);
    });
    const run = await legibilitySweep(browser, page, all, required, plan, [640, 656]);
    const r = sweepCheck(run.widths, { required, disclosure: POC_DISCLOSURE });
    expect(r.ok).toBe(false);
    expect(r.codes).toEqual(expect.arrayContaining(["TEXT_BOX_OVERFLOW"]));
  });
  it("fails an image laid over protected text (measured directly, past the stylesheet check)", async () => {
    const png = flatPng(200, 60, [234, 225, 210]);
    const r = await at(async (d) => {
      await mkdir(join(d, "assets"));
      await writeFile(join(d, "assets/cover.png"), png);
      await writeFile(join(d, "assets.json"), JSON.stringify({ version: 1, assets: [{ id: "cover", file: "assets/cover.png", sha256: sha256(png), kind: "placeholder", approval: null, published: false }] }));
      await html('<p class="colophon-note" data-comp-disclosure>架空店舗のデザイン提案</p>', '<p class="colophon-note" data-comp-disclosure>架空店舗のデザイン提案</p><img class="cover" src="assets/cover.png" alt="">')(d);
      await css(".colophon-inner { display: block; } .cover { display: block; width: 100%; height: 40px; margin-top: -24px; }")(d);
    });
    // the shop-CSS hit-test treats an img without a painted ground as a transparent decoration (it does NOT report this
    // cover); the ink proof does, and so does the rectangle check added for images
    expect(r.legibility.codes).toEqual(expect.arrayContaining(["DISCLOSURE_IMAGE_OVERLAP", "DISCLOSURE_NO_INK"]));
    expect(r.legibility.codes).not.toContain("DISCLOSURE_COVERED");
  });

  // F2 / F3: labels paired with the wrong values
  it("fails a label written into a paragraph (「電話：9:00〜18:00」)", async () => {
    expect((await at(html('<p class="colophon-name"', '<p>電話：9:00〜18:00（売り切れ次第終了）</p><p class="colophon-name"'))).pairs.codes).toContain("LABEL_OUTSIDE_DL");
  });
  it("fails swapped dd values (each dd must be its label's fact)", async () => {
    const r = await at(async (d) => {
      await html(HOURS, "<dd data-comp-type=\"body\">SWAP</dd>")(d);
      await html(PHONE, HOURS)(d);
      await html("<dd data-comp-type=\"body\">SWAP</dd>", PHONE)(d);
    });
    expect(r.pairs.codes).toContain("PAIR_WRONG_FACT");
  });
  it("a whole run fails the reviewer's F2 page", () => {
    // the shared defects run writes 「電話：9:00〜18:00」 into a paragraph
    expect(defects.report.mechanical_ok).toBe(false);
    expect(defects.report.checks.pairs_1440!.codes).toContain("LABEL_OUTSIDE_DL");
  });

  // N1: a dd above its dt
  it("fails a dd whose line starts above its dt (measured directly, past the stylesheet check)", async () => {
    expect((await at(css(".facts-row { display: flex; flex-direction: column-reverse; }"))).pairs.codes).toContain("PAIR_LINE");
  });
});

// fifth review of PR #96 (2d27cb3): flex items, grid items and inline-blocks paint atomically in tree order, so a later
// item's ground covers an earlier item's sideways-overflowing text — inside width windows no breakpoint names
describe("probes: fifth review (the 1px protected pass)", () => {
  const demo = parseShop(JSON.parse(readFileSync(FACTS_SOURCE, "utf8")) as unknown)!.demo;
  const all = factStrings(demo).map((f) => f.text.replace(/\s+/g, ""));
  const required = [demo.name, demo.hours!, demo.closedDays!, demo.address!, demo.access!, demo.phone!, demo.description!].map((f) => f.replace(/\s+/g, ""));
  const ROW = '<div class="facts-row"><dt data-comp-type="label">電話</dt><dd data-comp-type="body">052-000-0731</dd></div>';
  // probe A, as the reviewer wrote it: a wrapping flex row, the dd may shrink (min-width: 0), a dark tab after it
  const A = {
    html: '<div class="facts-row tel-row"><dt data-comp-type="label">電話</dt><dd data-comp-type="body">052-000-0731</dd><div class="tel-tab"></div></div>',
    css: ".tel-row { display: flex; flex-wrap: wrap; gap: 0; } .tel-row dt { flex: 0 0 170px; margin-right: 24px; } .tel-row dd { flex: 1 1 36px; min-width: 0; letter-spacing: 8px; } .tel-tab { flex: 0 0 180px; background: #1F1D1B; }",
  };
  // probe B: no min-width: 0 — an inline-block dd at 80 % beside a 20 % inline-block tab in a flex item squeezed to its
  // min-content, so the last group of digits overflows the dd under the tab; a @media rule switches it off at 400 px
  const B = {
    html: '<div class="facts-row tel-row"><dt data-comp-type="label">電話</dt><div class="tel-cell"><dd data-comp-type="body">052-000-0731</dd><div class="tel-tab"></div></div></div>',
    css: ".tel-row { display: flex; } .tel-row dt { flex: 0 0 394px; } .tel-cell { flex: 1 1 0px; } .tel-row dd { display: inline-block; width: 80%; letter-spacing: 6px; } .tel-tab { display: inline-block; width: 20%; min-height: 20px; background: #1F1D1B; } @media (max-width: 400px) { .tel-row { display: block; } }",
  };
  async function pageWith(probe: { html: string; css: string }, img = false) {
    const dir = await pageCopy("fifth-");
    temps.push(dir);
    let html = probe.html;
    if (img) {
      const png = flatPng(180, 24, [31, 29, 27]);
      await mkdir(join(dir, "assets"));
      await writeFile(join(dir, "assets/tab.png"), png);
      await writeFile(join(dir, "assets.json"), JSON.stringify({ version: 1, assets: [{ id: "tab", file: "assets/tab.png", sha256: sha256(png), kind: "placeholder", approval: null, published: false }] }));
      html = html.replace('<div class="tel-tab"></div>', '<img class="tel-tab" src="assets/tab.png" alt="">');
    }
    await editFile(dir, "index.html", (s) => s.replace(ROW, html));
    await editFile(dir, "style.css", (s) => `${s}\n${probe.css}\n`);
    return loadCompPage(dir);
  }
  const inRanges = (ranges: string | undefined, w: number) => (ranges ?? "").split(",").filter(Boolean).some((r) => {
    const [a, b] = r.split("-").map(Number);
    return w >= a! && w <= (b ?? a!);
  });

  it("the stylesheets of both probes are inside the allowlist (the cover is measured, not refused)", async () => {
    for (const probe of [A, B]) expect(cssProblems((await pageWith(probe)).css)).toEqual([]);
  });

  it("probe A: the phone digits covered at 450–476 px fail the 1px pass, and with it the run", async () => {
    const r = protectedGeometryCheck(await protectedGeometryPass(browser, await pageWith(A), required));
    expect(r.ok).toBe(false);
    expect(r.codes).toContain("FACT_COVERED");
    const ranges = r.ranges as Record<string, string>;
    for (const w of [450, 460, 476]) expect(inRanges(ranges.FACT_COVERED, w)).toBe(true);
    for (const w of [440, 500, 760, 1440]) expect(inRanges(ranges.FACT_COVERED, w)).toBe(false);
    expect(failedChecks({ protected_1px: r }, { ok: true })).toEqual(["protected_1px"]);
  });

  it("probe B: the last digits under the inline-block tab fail the 1px pass, never below the 400px media rule", async () => {
    const r = protectedGeometryCheck(await protectedGeometryPass(browser, await pageWith(B), required));
    expect(r.ok).toBe(false);
    const ranges = r.ranges as Record<string, string>;
    const failsAt = (w: number) => Object.values(ranges).some((rg) => inRanges(rg, w));
    // on screen and covered by the tab (the reviewer's 490–504 among them) …
    for (const w of [490, 495, 504]) expect(inRanges(ranges.FACT_COVERED, w)).toBe(true);
    // … and narrower, the overflowing digits run off the page (a real viewport cannot even hit-test them there)
    expect(inRanges(ranges.FACT_OFFSCREEN, 401)).toBe(true);
    for (let w = 401; w <= 504; w++) expect(failsAt(w), `width ${w}`).toBe(true);
    for (const w of [320, 400, 600, 1440]) expect(failsAt(w), `width ${w}`).toBe(false);
  });

  it("probe A with an img for the tab: FACT_IMAGE_OVERLAP in the same window", async () => {
    const r = protectedGeometryCheck(await protectedGeometryPass(browser, await pageWith(A, true), required));
    expect(r.codes).toEqual(expect.arrayContaining(["FACT_IMAGE_OVERLAP", "FACT_COVERED"]));
    expect(inRanges((r.ranges as Record<string, string>).FACT_IMAGE_OVERLAP, 460)).toBe(true);
  });

  it("the root-width stand-in gives the same findings as true viewport resizes (no override), width by width", async () => {
    // sixth review: the "real" side resizes the viewport and overrides nothing (forceReal), so a page whose html has a box of
    // its own cannot hide behind the stand-in; windows of both probes and their edges (the 400 px breakpoint included)
    for (const probe of [A, B]) {
      const page = await pageWith(probe);
      const auto = await protectedGeometryPass(browser, page, required, { range: [396, 512] });
      const real = await protectedGeometryPass(browser, page, required, { range: [396, 512], forceReal: true });
      expect(auto.segmentsReal, "the probes' html has no box: the stand-in is used").toBe(0);
      expect(real.segmentsStepped).toBe(0);
      for (let w = 396; w <= 512; w++) expect(auto.run.failing.find((f) => f.w === w)?.codes ?? [], `width ${w}`).toEqual(real.run.failing.find((f) => f.w === w)?.codes ?? []);
    }
  });

  it("splits 320–1920 into media segments at both edges of every breakpoint", () => {
    expect(mediaSegments("@media (max-width: 400px) { p { color: #000; } }")).toEqual([[320, 399], [400, 400], [401, 1920]]);
    expect(mediaSegments("")).toEqual([[320, 1920]]);
  });

  it("TEXT_BOX_OVERFLOW now reads the inline axis too (at a checked width and in the sweep)", async () => {
    const pass = await legibilityPass(browser, await pageWith(A), 460, all, required, { pairs: infoPairs(demo), facts: all });
    expect(pairsCheck(pass.pairs).codes).toContain("TEXT_BOX_OVERFLOW");
  });
});

// sixth review of PR #96 (9d8de8e): the stand-in assumed the root's width is the viewport; the page's own CSS can give html a
// box (margin, padding, border, a percentage width / max-width / margin), and a window of widths went unmeasured
describe("probes: sixth review (html with a box of its own)", () => {
  const demo = parseShop(JSON.parse(readFileSync(FACTS_SOURCE, "utf8")) as unknown)!.demo;
  const required = [demo.name, demo.hours!, demo.closedDays!, demo.address!, demo.access!, demo.phone!, demo.description!].map((f) => f.replace(/\s+/g, ""));
  const ROW = '<div class="facts-row"><dt data-comp-type="label">電話</dt><dd data-comp-type="body">052-000-0731</dd></div>';
  const TEL = '<div class="facts-row tel-row"><dt data-comp-type="label">電話</dt><dd data-comp-type="body">052-000-0731</dd><div class="tel-tab"></div></div>';
  const TEL_CSS = ".tel-row { display: flex; flex-wrap: wrap; gap: 0; } .tel-row dt { flex: 0 0 54px; margin-right: 24px; } .tel-row dd { flex: 1 1 44px; min-width: 0; letter-spacing: 8px; } .tel-tab { flex: 0 0 100px; background: #1F1D1B; }";
  async function pageWith(extra: string) {
    const dir = await pageCopy("sixth-");
    temps.push(dir);
    await editFile(dir, "index.html", (s) => s.replace(ROW, TEL));
    await editFile(dir, "style.css", (s) => `${s}\n${TEL_CSS}\n${extra}\n`);
    return loadCompPage(dir);
  }
  const inRanges = (ranges: string | undefined, w: number) => (ranges ?? "").split(",").filter(Boolean).some((r) => {
    const [a, b] = r.split("-").map(Number);
    return w >= a! && w <= (b ?? a!);
  });

  // the reviewer's probe runs the whole pass (320–1920); the variants measure 340–400, which holds their windows — the
  // html box check runs at the ends of that range too, so the fallback is the same (CI time: ~440 real resizes each saved)
  it.each<[string, string, number, [number, number] | undefined]>([
    ["the reviewer's probe: html { margin-right: 100px } under 760 px", "@media (max-width: 760px) { html { margin-right: 100px; } }", 370, undefined],
    ["html { padding-right: 100px }", "@media (max-width: 760px) { html { padding-right: 100px; } }", 370, [340, 400]],
    ["html { border-right: 16px } (the dt wider, so the window lands above 320 px)", "@media (max-width: 760px) { html { border-right: 16px solid #1F1D1B; } } .tel-row dt { flex: 0 0 140px; }", 372, [340, 400]],
    ["a percentage html width", "@media (max-width: 760px) { html { width: 75%; } }", 360, [340, 400]],
    ["a percentage html max-width", "@media (max-width: 760px) { html { max-width: 75%; } }", 360, [340, 400]],
    ["a percentage html margin", "@media (max-width: 760px) { html { margin-right: 25%; } }", 360, [340, 400]],
  ])("fails %s: the segment falls back to real resizes and the cover is found", async (_n, extra, width, range) => {
    const page = await pageWith(extra);
    expect(cssProblems(page.css)).toEqual([]); // inside the allowlist: measured, not refused
    const r = protectedGeometryCheck(await protectedGeometryPass(browser, page, required, range ? { range } : {}));
    expect(r.ok).toBe(false);
    expect(r.segments_real).toBeGreaterThan(0);
    expect(inRanges(r.real_widths as string, width)).toBe(true);
    expect(inRanges((r.ranges as Record<string, string>).FACT_COVERED, width)).toBe(true);
    expect(failedChecks({ protected_1px: r }, { ok: true })).toEqual(["protected_1px"]);
  });

  it("the reviewer's probe reads 052-/000-/073 at 362–381 px: the same findings as true resizes there", async () => {
    const page = await pageWith("@media (max-width: 760px) { html { margin-right: 100px; } }");
    const auto = await protectedGeometryPass(browser, page, required, { range: [350, 395] });
    const real = await protectedGeometryPass(browser, page, required, { range: [350, 395], forceReal: true });
    for (let w = 350; w <= 395; w++) expect(auto.run.failing.find((f) => f.w === w)?.codes ?? [], `width ${w}`).toEqual(real.run.failing.find((f) => f.w === w)?.codes ?? []);
    expect(protectedGeometryCheck(auto).ranges).toMatchObject({ FACT_COVERED: "362-381" });
  });

  it("the synthetic page's html has no box: every segment is stepped (no cost increase)", async () => {
    const pass = await protectedGeometryPass(browser, await loadCompPage(join(FIXTURE, "page")), required);
    expect(pass.segmentsReal).toBe(0);
    expect(pass.segmentsStepped).toBe(pass.segments);
  });
});

// seventh review of PR #96 (2ac5e8d, nit N1): an honest centred root (html { max-width; margin: 0 auto }) must pass — while
// stepping, the stepped root is no longer centred by its own auto margins
describe("honest pages with a centred root (seventh review N1)", () => {
  const demo = parseShop(JSON.parse(readFileSync(FACTS_SOURCE, "utf8")) as unknown)!.demo;
  const required = [demo.name, demo.hours!, demo.closedDays!, demo.address!, demo.access!, demo.phone!, demo.description!].map((f) => f.replace(/\s+/g, ""));
  async function pageWith(extra: string) {
    const dir = await pageCopy("seventh-");
    temps.push(dir);
    await editFile(dir, "style.css", (s) => `${s}\n${extra}\n`);
    return loadCompPage(dir);
  }
  it.each<[string, string, [number, number]]>([
    ["html { max-width: 1000px; margin: 0 auto } over 440–490 px", "html { max-width: 1000px; margin: 0 auto; }", [440, 490]],
    ["the synthetic page with html { max-width: 1920px; margin: 0 auto }", "html { max-width: 1920px; margin: 0 auto; }", [700, 780]],
  ])("%s: passes, stepped, and equals true resizes", async (_n, extra, range) => {
    const page = await pageWith(extra);
    expect(cssProblems(page.css)).toEqual([]);
    const auto = await protectedGeometryPass(browser, page, required, { range });
    const real = await protectedGeometryPass(browser, page, required, { range, forceReal: true });
    expect(auto.segmentsReal).toBe(0);
    expect(auto.run.failing).toEqual([]);
    for (let w = range[0]; w <= range[1]; w++) expect(auto.run.failing.find((f) => f.w === w)?.codes ?? [], `width ${w}`).toEqual(real.run.failing.find((f) => f.w === w)?.codes ?? []);
  });
  it("the whole pass on the synthetic page with a centred 1920 px root finds nothing (no false OFFSCREEN)", async () => {
    const r = protectedGeometryCheck(await protectedGeometryPass(browser, await pageWith("html { max-width: 1920px; margin: 0 auto; }"), required));
    expect(r).toMatchObject({ ok: true, codes: [], segments_real: 0 });
  });
});

