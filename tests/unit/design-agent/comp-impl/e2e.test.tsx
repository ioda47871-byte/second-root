import { readFileSync } from "node:fs";
import { chmod, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Browser } from "playwright";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import ProfileRenderer from "@/components/demo/profile/ProfileRenderer";
import { CompImplError, sha256 } from "@/lib/design-agent/comp-impl/bundle";
import { runCompImpl, writeCompImplOutputs, type RunResult } from "@/lib/design-agent/comp-impl/run";
import { buildSyntheticBundle } from "@/lib/design-agent/comp-impl/synthetic";
import { loadHandWritten, parseShop } from "@/lib/design-agent/compare/shops";
import { legibilityCheck } from "@/lib/design-agent/comp-impl/checks";
import { loadCompPage } from "@/lib/design-agent/comp-impl/page";
import { legibilityPass } from "@/lib/design-agent/comp-impl/render";
import { factStrings } from "@/lib/design-agent/compare/shops";
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
});
afterAll(async () => {
  await browser?.close();
  for (const t of temps) await removeDir(t);
});

const run = (pageDir: string) => runCompImpl({ bundleDir: bundle, pageDir, repoDir: REPO, factsSourcePath: FACTS_SOURCE, browser });
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

  it("fails an invented price", async () => {
    const r = await changed((d) => editFile(d, "index.html", (s) => s.replace("<p class=\"goods-caption\" data-comp-type=\"caption\">季節の上生菓子</p>", "<p class=\"goods-caption\" data-comp-type=\"caption\">季節の上生菓子 350円</p>")));
    expect(r.report.mechanical_ok).toBe(false);
    expect(r.report.checks.facts_desktop!.codes).toContain("FACTS_UNKNOWN_TEXT");
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
    const r = await changed(withAi);
    expect(r.report.page.ai_assets).toBe(1);
    expect(r.report.checks.disclosure_desktop!.codes).toContain("DISCLOSURE_TEXT");
    const fixed = await changed(async (d) => {
      await withAi(d);
      await editFile(d, "index.html", (s) => s.replace('data-comp-disclosure>架空店舗のデザイン提案<', `data-comp-disclosure>${POC_DISCLOSURE_V2}<`));
    });
    expect(fixed.report.checks.disclosure_desktop!.codes).toEqual(["DISCLOSURE_SPEC_MISMATCH"]); // the spec was written for placeholders
    expect(fixed.report.checks.images_desktop!.codes).toEqual(["SLOT_KIND"]);
    expect(fixed.report.checks.facts_desktop!.ok).toBe(true);
  });

  it("fails horizontal overflow at the narrow widths", async () => {
    const r = await changed((d) => editFile(d, "style.css", (s) => `${s}\n.lead-rule { width: 700px; }\n`));
    expect(r.report.checks.overflow!.codes).toEqual(["OVERFLOW_HORIZONTAL"]);
    expect(r.report.checks.overflow!.overflowing).toContain(320);
  });

  it("fails the renderer's markup as a page (template reuse)", async () => {
    const shop = parseShop(JSON.parse(readFileSync(FACTS_SOURCE, "utf8")) as unknown)!;
    const profile = (await loadHandWritten(join(REPO, "scripts/sales-design-worker/compare/hand-written"), ["wagashi"])).wagashi!;
    const body = renderToStaticMarkup(<ProfileRenderer demo={shop.demo} profile={profile} />)
      .replace(/<svg[\s\S]*?<\/svg>/g, "")
      .replace(/\sstyle="[^"]*"/g, "")
      .replace(/https?:\/\/[^"'\s<>]*/g, "#"); // a copier would strip what the source check refuses
    const r = await changed((d) => writeFile(join(d, "index.html"), `<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body>${body}</body></html>`));
    expect(r.report.anti_template.ok).toBe(false);
    expect(r.report.anti_template.codes).toEqual(expect.arrayContaining(["TEMPLATE_RENDERER_MARKER", "TEMPLATE_STRUCTURE_TOO_CLOSE"]));
    expect(r.report.mechanical_ok).toBe(false);
  });

  it("counts a request for a file the page does not have, and never renders a page with a script", async () => {
    const r = await changed((d) => editFile(d, "index.html", (s) => s.replace("<span class=\"lead-visual-disc\"></span>", '<span class="lead-visual-disc"></span><img src="assets/missing.png" alt="">')));
    expect(r.report.checks.network!.codes).toEqual(["NETWORK_REQUEST_BLOCKED"]);
    await expect(changed((d) => editFile(d, "index.html", (s) => s.replace("</body>", "<script>fetch('https://example.com')</script></body>")))).rejects.toMatchObject({ code: "PAGE_SOURCE_REFUSED" });
  });
});

// review of PR #96 (Fresh Review FAIL at 9daac92): each probe below passed before; each must fail now
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
    const pass = await legibilityPass(browser, await loadCompPage(dir), 1440, all, required);
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

  it("a hidden required fact fails the whole run, at every width checked", async () => {
    // off-screen placement is refused by the stylesheet allowlist now, so aria-hidden alone is the probe here
    const r = await changed(html(PHONE, '<dd data-comp-type="body" aria-hidden="true">052-000-0731</dd>'));
    expect(r.report.mechanical_ok).toBe(false);
    const widths = Object.keys(r.report.checks).filter((k) => k.startsWith("legibility_"));
    expect(widths).toEqual(["legibility_320", "legibility_360", "legibility_390", "legibility_759", "legibility_760", "legibility_761", "legibility_768", "legibility_1024", "legibility_1440", "legibility_1920"]);
    for (const k of widths) expect(r.report.checks[k]!.codes).toEqual(expect.arrayContaining(["TEXT_ARIA_HIDDEN", "FACTS_REQUIRED_NOT_LEGIBLE"]));
  });

  it.each<[string, string, string]>([
    ["list-style with a string", 'li.goods-card { display: list-item; list-style: "SALE 50% OFF" inside; }', "CSS_VALUE"],
    ["hyphenate-character", '.goods-copy { hyphens: manual; hyphenate-character: "$9.80"; }', "CSS_PROPERTY"],
    ["bidi override on a fact", ".facts-row dd { unicode-bidi: bidi-override; direction: rtl; }", "CSS_PROPERTY"],
    ["::first-letter shrinking a fact", ".facts-row dd::first-letter { font-size: 1px; }", "CSS_PSEUDO_ELEMENT"],
    ["::first-letter hiding the disclosure", ".colophon-note::first-letter { color: transparent; }", "CSS_PSEUDO_ELEMENT"],
    ["a mirrored fact", ".facts-row dd { transform: scaleX(-1); }", "CSS_VALUE"],
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
    const r = await changed(css("@media (min-width: 761px) and (max-width: 767px) { .colophon-note { color: #F4EEE3; } }"));
    expect(r.report.mechanical_ok).toBe(false);
    const failing = Object.entries(r.report.checks).filter(([k, c]) => k.startsWith("legibility_") && !c.ok).map(([k]) => k);
    expect(failing).toEqual(expect.arrayContaining(["legibility_761", "legibility_767"]));
    expect(r.report.checks.legibility_1440!.ok).toBe(true);
  });

  it("refuses extra ink on protected text (an underline, allowed elsewhere, over the disclosure)", async () => {
    const r = await changed(css(".colophon-note { text-decoration: underline; }"));
    expect(r.report.checks.legibility_1440!.codes).toContain("DISCLOSURE_INK_EXCESS");
    expect(r.report.mechanical_ok).toBe(false);
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
