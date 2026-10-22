import { readFileSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Browser } from "playwright";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import ProfileRenderer from "@/components/demo/profile/ProfileRenderer";
import { CompImplError, sha256 } from "@/lib/design-agent/comp-impl/bundle";
import { runCompImpl, writeCompImplOutputs, type RunResult } from "@/lib/design-agent/comp-impl/run";
import { buildSyntheticBundle } from "@/lib/design-agent/comp-impl/synthetic";
import { loadHandWritten, parseShop } from "@/lib/design-agent/compare/shops";
import { POC_DISCLOSURE_V2 } from "@/lib/design-agent/design-image/prompt";
import { FACTS_SOURCE, FIXTURE, flatPng, launch, pageCopy, privateTemp, removeDir, REPO } from "./support";

// DEV-082 end to end in Chromium: the synthetic comp is rendered to a bundle,
// the hand-written page is checked with the network shut, and changed copies
// of the page fail the right check. Fictional shop only; no AI image (the AI
// disclosure logic is tested with a flat PNG flagged as an AI concept asset);
// nothing is fetched or published.

vi.setConfig({ testTimeout: 120_000 });

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
    expect(r.checks.overflow!.widths).toEqual([320, 360, 390, 768, 1024, 1440, 1920]);
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
