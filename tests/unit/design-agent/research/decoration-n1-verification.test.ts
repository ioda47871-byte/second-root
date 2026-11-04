import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drawCase, parseProbeArgs, runProbe } from "../../../../scripts/design-artifact/n1-browser-probe";
import { HOSTILE_SVGS, MOUNTAIN, SEAM, SHOP_SHAPES, WHEEL } from "../../../../lib/design-agent/research/decoration-fixtures";
import { scanDecorationLayers } from "../../../support/decoration-layers";
import { launchDecorationBrowser } from "../../../../lib/design-agent/research/decoration-page-browser";
import { checkDecorationAssetFile, checkDecorationSvg, ownerReviewProblems, type DecorationAsset, type OwnerVisualReview } from "../../../../lib/design-agent/research/decoration-svg";

// DEV-165 (Issue #193 comment 6623100651; owner chat 2026-11-04 item 2): N1 follow-up research. Nothing is enabled.

const REPO = resolve(__dirname, "../../../..");
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const NOW = new Date("2026-11-04T12:00:00Z");

/**
 * TEST FIXTURE — not an owner review. Built in memory for the checker's own tests and never written to a tracked file.
 * A real owner_visual_review is written only by the owner (docs/design/n1-decoration-svg.md §2.11).
 */
const fixtureReview = (assetSha: string, over: Partial<Record<keyof OwnerVisualReview, unknown>> = {}) =>
  ({ reviewed_by: "owner", reviewed_at: "2026-11-01", asset_sha256: assetSha, decision: "approved", note: "TEST FIXTURE - not an owner review", ...over }) as OwnerVisualReview;

/** A record claiming the owner: either quote, the key quoted or not (L4). */
const OWNER_RECORD = /reviewed_by["']?\s*:\s*["']owner["']/;
const OWNER_RECORD_GREP = `owner_visual_review|reviewed_by["']?[[:space:]]*:[[:space:]]*["']owner["']`;
const FIXTURE_MARK = "TEST FIXTURE - not an owner review";

const without = (r: OwnerVisualReview, key: keyof OwnerVisualReview) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== key));

describe("owner_visual_review: required, approved, bound to the file's bytes", () => {
  let dir: string;
  const asset = (body: string, review: unknown): DecorationAsset => ({
    id: "seam",
    file: "assets/seam.svg",
    sha256: sha(body),
    bytes: Buffer.byteLength(body),
    width: 100,
    height: 100,
    kind: "decoration_svg",
    role: "decoration",
    owner_visual_review: review as OwnerVisualReview,
  });
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "dev165-review-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "assets/seam.svg"), SEAM);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("an approved review of exactly these bytes passes", () => expect(checkDecorationAssetFile(dir, asset(SEAM, fixtureReview(sha(SEAM))), NOW)).toEqual([]));

  it.each([
    ["no review", undefined, "OWNER_REVIEW_MISSING"],
    ["null", null, "OWNER_REVIEW_MISSING"],
    ["a string", "approved", "OWNER_REVIEW_MISSING"],
    ["an array", [], "OWNER_REVIEW_MISSING"],
    ["rejected", fixtureReview(sha(SEAM), { decision: "rejected" }), "OWNER_REVIEW_REJECTED"],
    ["an unknown decision", fixtureReview(sha(SEAM), { decision: "ok" }), "OWNER_REVIEW_DECISION"],
    ["decision upper case", fixtureReview(sha(SEAM), { decision: "APPROVED" }), "OWNER_REVIEW_DECISION"],
    ["no decision", without(fixtureReview(sha(SEAM)), "decision"), "OWNER_REVIEW_DECISION"],
    ["reviewed by Claude", fixtureReview(sha(SEAM), { reviewed_by: "claude" }), "OWNER_REVIEW_REVIEWER"],
    ["reviewed by Owner (case)", fixtureReview(sha(SEAM), { reviewed_by: "Owner" }), "OWNER_REVIEW_REVIEWER"],
    ["the sha of other bytes", fixtureReview(sha(WHEEL)), "OWNER_REVIEW_SHA256"],
    ["the sha upper case", fixtureReview(sha(SEAM).toUpperCase()), "OWNER_REVIEW_SHA256"],
    ["no sha", fixtureReview(sha(SEAM), { asset_sha256: undefined }), "OWNER_REVIEW_SHA256"],
    ["not a date", fixtureReview(sha(SEAM), { reviewed_at: "yesterday" }), "OWNER_REVIEW_DATE"],
    ["not a real day", fixtureReview(sha(SEAM), { reviewed_at: "2026-02-30" }), "OWNER_REVIEW_DATE"],
    ["month 13", fixtureReview(sha(SEAM), { reviewed_at: "2026-13-01" }), "OWNER_REVIEW_DATE"],
    ["hour 24", fixtureReview(sha(SEAM), { reviewed_at: "2026-11-01T24:00:00Z" }), "OWNER_REVIEW_DATE"],
    ["no zone on a time", fixtureReview(sha(SEAM), { reviewed_at: "2026-11-01T10:00:00" }), "OWNER_REVIEW_DATE"],
    ["in the future", fixtureReview(sha(SEAM), { reviewed_at: "2026-12-01" }), "OWNER_REVIEW_DATE"],
    ["before reviews existed", fixtureReview(sha(SEAM), { reviewed_at: "2019-01-01" }), "OWNER_REVIEW_DATE"],
    ["a number date", fixtureReview(sha(SEAM), { reviewed_at: 20261101 }), "OWNER_REVIEW_DATE"],
    ["no note", fixtureReview(sha(SEAM), { note: undefined }), "OWNER_REVIEW_NOTE"],
    ["a note too long", fixtureReview(sha(SEAM), { note: "x".repeat(501) }), "OWNER_REVIEW_NOTE"],
    ["an extra key", { ...fixtureReview(sha(SEAM)), approved_by_claude: true }, "OWNER_REVIEW_SHAPE"],
    ["a missing key", without(fixtureReview(sha(SEAM)), "note"), "OWNER_REVIEW_SHAPE"],
  ])("refused: %s", (_, review, code) => {
    const r = checkDecorationAssetFile(dir, asset(SEAM, review), NOW);
    expect(r).toContain(code);
  });

  it("a time with a zone passes; today passes", () => {
    expect(ownerReviewProblems(fixtureReview(sha(SEAM), { reviewed_at: "2026-11-04T09:30:00+09:00" }), sha(SEAM), NOW)).toEqual([]);
    expect(ownerReviewProblems(fixtureReview(sha(SEAM), { reviewed_at: "2026-11-04" }), sha(SEAM), NOW)).toEqual([]);
  });

  it("any byte change voids the review, even when the record's sha256 and size are updated to match", () => {
    const changed = SEAM.replace("#b8923a", "#b8923b");
    writeFileSync(join(dir, "assets/seam.svg"), changed);
    try {
      // the record follows the new bytes (as a careless or hostile edit would), the review still names the old ones
      const r = checkDecorationAssetFile(dir, asset(changed, fixtureReview(sha(SEAM))), NOW);
      expect(r).toEqual(["OWNER_REVIEW_SHA256"]);
    } finally {
      writeFileSync(join(dir, "assets/seam.svg"), SEAM);
    }
  });

  it("a review whose sha matches the record but not the file read is refused (bound to the bytes read, not the record)", () => {
    const r = checkDecorationAssetFile(dir, { ...asset(SEAM, fixtureReview("a".repeat(64))), sha256: "a".repeat(64) }, NOW);
    expect(r).toEqual(expect.arrayContaining(["ASSET_SHA256", "OWNER_REVIEW_SHA256"]));
  });

  it("a file that cannot be read cannot be bound: OWNER_REVIEW_SHA256 with the file's own code", () => {
    const r = checkDecorationAssetFile(dir, { ...asset(SEAM, fixtureReview(sha(SEAM))), file: "assets/none.svg" }, NOW);
    expect(r).toEqual(expect.arrayContaining(["ASSET_MISSING", "OWNER_REVIEW_SHA256"]));
  });

  it("a hostile review never throws", () => {
    const evil = Object.defineProperty({}, "decision", {
      enumerable: true,
      get() {
        throw new Error("x");
      },
    });
    expect(() => ownerReviewProblems(evil, sha(SEAM), NOW)).not.toThrow();
    expect(ownerReviewProblems(evil, sha(SEAM), NOW).length).toBeGreaterThan(0);
    const record = Object.defineProperty(asset(SEAM, undefined), "owner_visual_review", {
      get() {
        throw new Error("x");
      },
    });
    expect(() => checkDecorationAssetFile(dir, record, NOW)).not.toThrow();
    expect(checkDecorationAssetFile(dir, record, NOW)).toContain("OWNER_REVIEW_MISSING");
  });

  it("the repository holds no owner review record: only the code, its tests (fixtures), the design doc and the task notes name the field", () => {
    const r = spawnSync("git", ["grep", "-l", "-E", OWNER_RECORD_GREP], { cwd: REPO, encoding: "utf8" });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0); // the checker names the field itself: never a vacuous empty result
    const hits = r.stdout.split("\n").filter(Boolean).sort();
    expect(hits).toContain("lib/design-agent/research/decoration-svg.ts");
    const allowed = (h: string) => ["lib/design-agent/research/decoration-svg.ts", "docs/design/n1-decoration-svg.md", ".ai/tasks.json", ".ai/reviews/DEV-165.md"].includes(h) || /^tests\/unit\/design-agent\/research\/[a-z0-9-]+\.test\.ts$/.test(h);
    expect(hits.filter((h) => !allowed(h))).toEqual([]);
    // in the tests, EVERY such review (each matched record, not once per file) carries the fixture marker within 2 lines
    let records = 0;
    for (const h of hits.filter((x) => x.startsWith("tests/"))) {
      const lines = readFileSync(join(REPO, h), "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!OWNER_RECORD.test(line)) return;
        records += 1;
        expect(lines.slice(Math.max(0, i - 2), i + 3).join("\n"), `${h}:${i + 1}`).toContain(FIXTURE_MARK);
      });
    }
    expect(records).toBeGreaterThanOrEqual(2); // this file's fixtureReview and decoration-svg.test.ts's: never vacuous
    // no data file (JSON) anywhere records a decorative SVG asset or a review (.ai/tasks.json names the field: status 0)
    const data = spawnSync("git", ["grep", "-l", "-E", "decoration_svg|owner_visual_review|asset_sha256", "--", "*.json"], { cwd: REPO, encoding: "utf8" });
    expect(data.error).toBeUndefined();
    expect(data.status).toBe(0);
    expect(data.stdout.split("\n").filter(Boolean).filter((h) => h !== ".ai/tasks.json")).toEqual([]);
  });
});

describe("transforms: skewX / skewY refused by default, and so is a shear without the name", () => {
  const NS = `xmlns="http://www.w3.org/2000/svg"`;
  const svg = (inner: string, root = "") => `<svg ${NS} width="100" height="100" viewBox="0 0 100 100"${root}>${inner}</svg>`;
  const codes = (s: string) => checkDecorationSvg(Buffer.from(s, "latin1")).findings.map((f) => f.code);
  const stretched = (inner: string) => `<svg ${NS} width="200" height="100" viewBox="0 0 100 100" preserveAspectRatio="none">${inner}</svg>`;

  it.each([
    ["skewX", svg(`<g transform="skewX(20)"/>`), "SVG_TRANSFORM_SKEW"],
    ["skewY", svg(`<g transform="skewY(-5)"/>`), "SVG_TRANSFORM_SKEW"],
    ["skewX after a translate", svg(`<path d="M0 0" transform="translate(5 5) skewX(1)"/>`), "SVG_TRANSFORM_SKEW"],
    ["skewX(0) (no visible slant, still the name)", svg(`<g transform="skewX(0)"/>`), "SVG_TRANSFORM_SKEW"],
    ["SKEWX upper case", svg(`<g transform="SKEWX(20)"/>`), "SVG_TRANSFORM_SKEW"],
    ["skew in a gradientTransform", svg(`<defs><linearGradient id="g" gradientTransform="skewY(30)"/></defs>`), "SVG_TRANSFORM_SKEW"],
    ["skewX on the root", svg(`<g/>`, ` transform="skewX(10)"`), "SVG_TRANSFORM_SKEW"],
    ["a shearing matrix", svg(`<g transform="matrix(1 0 0.5 1 0 0)"/>`), "SVG_TRANSFORM_SHEAR"],
    ["a shear from scale then rotate in one list", svg(`<rect width="1" height="1" transform="scale(2 1) rotate(30)"/>`), "SVG_TRANSFORM_SHEAR"],
    ["a shear from nested groups", svg(`<g transform="scale(2 1)"><g transform="rotate(30)"><rect width="1" height="1"/></g></g>`), "SVG_TRANSFORM_SHEAR"],
    ["a shearing gradientTransform", svg(`<defs><linearGradient id="g" gradientTransform="matrix(1 0.3 0 1 0 0)"/></defs>`), "SVG_TRANSFORM_SHEAR"],
    // L1: preserveAspectRatio="none" with a width/height aspect other than the viewBox's stretches per axis inside the file
    ["a rotate under the root's non-uniform viewBox scale (none, 200×100 over a 100×100 viewBox)", stretched(`<rect width="10" height="10" transform="rotate(30)"/>`), "SVG_TRANSFORM_SHEAR"],
    ["a rotated group under the root's non-uniform viewBox scale", stretched(`<g transform="rotate(-4)"><rect width="10" height="10"/></g>`), "SVG_TRANSFORM_SHEAR"],
    ["a rotate under the stretch, one level down", stretched(`<g transform="translate(5 5)"><g transform="rotate(45)"><rect width="1" height="1"/></g></g>`), "SVG_TRANSFORM_SHEAR"],
    // L2: values that overflow are refused, never judged on Infinity or NaN
    ["scale(1e200 1) rotate(30) (a real shear whose dot product overflows)", svg(`<g transform="scale(1e200 1) rotate(30)"/>`), "SVG_TRANSFORM_SHEAR"],
    ["a shear at a tiny scale (no longer under an absolute threshold)", svg(`<g transform="scale(1e-6) matrix(1 0 0.5 1 0 0)"/>`), "SVG_TRANSFORM_SHEAR"],
    ["a list whose product overflows to Infinity", svg(`<g transform="scale(1e200) scale(1e200)"/>`), "SVG_TRANSFORM_RANGE"],
    ["a list that overflows and comes back (NaN on the way)", svg(`<g transform="scale(1e200) scale(1e200) scale(0)"/>`), "SVG_TRANSFORM_RANGE"],
    ["nested groups whose product overflows", svg(`<g transform="scale(1e200)"><g transform="scale(1e200)"><rect width="1" height="1"/></g></g>`), "SVG_TRANSFORM_RANGE"],
    ["a gradientTransform that overflows", svg(`<defs><linearGradient id="g" gradientTransform="scale(1e300) scale(1e300)"/></defs>`), "SVG_TRANSFORM_RANGE"],
    ["matrix with 4 numbers", svg(`<g transform="matrix(1 0 0 1)"/>`), "SVG_ATTRIBUTE_VALUE"],
    ["rotate with 2 numbers", svg(`<g transform="rotate(10 5)"/>`), "SVG_ATTRIBUTE_VALUE"],
    ["translate with 3 numbers", svg(`<g transform="translate(1 2 3)"/>`), "SVG_ATTRIBUTE_VALUE"],
  ])("refused: %s", (_, s, code) => {
    const c = codes(s);
    expect(c).toContain(code);
  });

  it.each([
    ["rotate", `<g transform="rotate(-4)"/>`],
    ["rotate about a point", `<g transform="rotate(90 50 50)"/>`],
    ["non-uniform scale alone", `<g transform="scale(2 0.5)"/>`],
    ["rotate then non-uniform scale (a rotated, stretched shape: no shear)", `<rect width="1" height="1" transform="rotate(30) scale(2 1)"/>`],
    ["a mirror", `<g transform="scale(-1 1)"/>`],
    ["a rotation matrix", `<g transform="matrix(0 1 -1 0 10 0)"/>`],
    ["translate, rotate in nested groups", `<g transform="translate(10, 10)"><g transform="rotate(45)"><rect width="1" height="1"/></g></g>`],
    ["a tiny uniform scale with a rotate (columns compared as unit vectors)", `<g transform="scale(1e-200) rotate(30)"/>`],
    ["a huge uniform scale with a rotate", `<g transform="scale(1e150) rotate(30)"/>`],
  ])("passes: %s", (_, inner) => expect(codes(svg(inner))).toEqual([]));

  it.each([
    ["none with the viewBox's own aspect (uniform)", `<svg ${NS} width="200" height="200" viewBox="0 0 100 100" preserveAspectRatio="none"><rect width="10" height="10" transform="rotate(30)"/></svg>`],
    ["a stretched aspect without none (meet: uniform)", `<svg ${NS} width="200" height="100" viewBox="0 0 100 100"><rect width="10" height="10" transform="rotate(30)"/></svg>`],
    ["a stretched aspect with slice (uniform)", `<svg ${NS} width="200" height="100" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice"><rect width="10" height="10" transform="rotate(30)"/></svg>`],
    ["none and stretched, but rotate(90) keeps the axes (no shear)", `<svg ${NS} width="200" height="100" viewBox="0 0 100 100" preserveAspectRatio="none"><rect width="10" height="10" transform="rotate(90)"/></svg>`],
    ["none and stretched, no rotate (the stretch alone is per-axis scale)", `<svg ${NS} width="200" height="100" viewBox="0 0 100 100" preserveAspectRatio="none"><rect width="10" height="10" transform="translate(5 5) scale(2 1)"/></svg>`],
  ])("passes (L1): %s", (_, s) => expect(codes(s)).toEqual([]));

  it("the three shops' shapes still pass (none uses a transform; seam and mountain use none with the viewBox's own aspect)", () => {
    for (const s of [SEAM, WHEEL, MOUNTAIN]) expect(codes(s)).toEqual([]);
    expect(SEAM).toContain(`width="100" height="100" viewBox="0 0 100 100" preserveAspectRatio="none"`);
    expect(MOUNTAIN).toContain(`width="660" height="600" viewBox="0 0 660 600" preserveAspectRatio="none"`);
    for (const s of SHOP_SHAPES) expect(s.svg).not.toMatch(/transform/i);
  });
});

describe("the cross-browser probe (scripts/design-artifact/n1-browser-probe.ts)", () => {
  it("every hostile fixture is refused by the checker, every shop shape passes", () => {
    for (const h of HOSTILE_SVGS) expect(checkDecorationSvg(Buffer.from(h.svg, "latin1")).ok, h.name).toBe(false);
    for (const s of SHOP_SHAPES) expect(checkDecorationSvg(Buffer.from(s.svg, "latin1")).ok, s.name).toBe(true);
    for (const h of HOSTILE_SVGS) for (const u of h.svg.match(/https?:\/\/[^"')\s]+/g) ?? []) if (!u.startsWith("http://www.w3.org/")) expect(new URL(u).hostname.endsWith(".invalid"), u).toBe(true);
  });

  it("arguments: a browser of the three, an --out that does not exist under a parent that does", () => {
    const base = mkdtempSync(join(tmpdir(), "dev165-args-"));
    try {
      expect(parseProbeArgs(["--browser", "edge", "--out", join(base, "o")])).toMatch(/^usage/);
      expect(parseProbeArgs(["--out", join(base, "o")])).toMatch(/^usage/);
      expect(parseProbeArgs(["--browser", "firefox"])).toMatch(/^usage/);
      expect(parseProbeArgs(["--browser", "webkit", "--out", base])).toBe("REFUSED: --out exists");
      expect(parseProbeArgs(["--browser", "webkit", "--out", join(base, "no/such/o")])).toBe("REFUSED: the parent of --out does not exist");
      expect(parseProbeArgs(["--browser", "webkit", "--out", join(base, "o")])).toEqual({ browser: "webkit", out: join(base, "o"), executable: null });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("the CLI refuses an existing --out with exit 2 and writes nothing", () => {
    const base = mkdtempSync(join(tmpdir(), "dev165-cli-"));
    try {
      const r = spawnSync(process.execPath, [join(REPO, "node_modules/tsx/dist/cli.mjs"), join(REPO, "scripts/design-artifact/n1-browser-probe.ts"), "--browser", "chromium", "--out", base], { cwd: REPO, encoding: "utf8" });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("REFUSED: --out exists");
      expect(existsSync(join(base, "summary.json"))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, 60_000);

  describe("in Chromium", () => {
    let browser: Browser;
    beforeAll(async () => {
      browser = await launchDecorationBrowser();
    }, 60_000);
    afterAll(async () => {
      await browser?.close();
    }, 60_000);

    it("the probe finds nothing: no request outside the page directory, no ink outside the box, JS on and off", async () => {
      const s = await runProbe(browser, "chromium");
      expect(s.findings).toEqual([]);
      expect(s.result).toBe("pass");
      expect(s.cases).toHaveLength(SHOP_SHAPES.length + HOSTILE_SVGS.length);
      for (const c of s.cases) {
        expect(c.runs.map((r) => r.javascript)).toEqual([true, false]);
        for (const r of c.runs) {
          expect(r.outside_requests).toEqual([]);
          expect(r.ink_outside).toBe(0);
          expect(r.requests.sort()).toEqual([`http://n1-probe.invalid/probe/${c.name}.html`, `http://n1-probe.invalid/probe/${c.name}.svg`]);
          if (c.kind === "shop") expect(r.ink_inside).toBeGreaterThan(0);
        }
      }
    }, 180_000);

    it("a browser that dies mid-run: every run is a RUN_ERROR finding (exit 1 in the CLI), never a pass", async () => {
      const dead = await launchDecorationBrowser();
      await dead.close();
      const s = await runProbe(dead, "chromium");
      expect(s.result).toBe("fail");
      expect(s.findings.length).toBeGreaterThan(0);
      expect(s.findings.filter((f) => f.endsWith(": RUN_ERROR"))).toHaveLength(2 * (SHOP_SHAPES.length + HOSTILE_SVGS.length));
      for (const c of s.cases) for (const r of c.runs) expect(r.error).not.toBeNull();
    }, 120_000);

    it("positive controls: a host-page request and host-page ink outside the box are caught (the measures are not vacuous)", async () => {
      const box = { width: 100, height: 100 };
      const req = await drawCase(browser, "control", SEAM, box, false, `<img src="http://n1-probe-hostile.invalid/control.png" alt="" style="position:absolute;left:0;top:0;width:1px;height:1px">`);
      expect(req.outside_requests).toEqual(["http://n1-probe-hostile.invalid/control.png"]);
      const ink = await drawCase(browser, "control", SEAM, box, true, `<div style="position:absolute;left:0;top:0;width:10px;height:10px;background:#000"></div>`);
      expect(ink.ink_outside).toBe(100);
      expect(ink.outside_requests).toEqual([]);
    }, 60_000);
  });
});

describe("phase C conditions: what today's phase A layer scan and geometry say about a decorative SVG <img>", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await launchDecorationBrowser();
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
  }, 60_000);

  const FACT = "営業時間 10:00〜18:00";
  const facts = [FACT.replace(/\s+/g, "")];
  const IMG = `<img src="assets/seam.svg" alt="" aria-hidden="true" referrerpolicy="no-referrer" width="300" height="120">`;
  const page = (body: string) => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>t</title></head><body>${body}</body></html>`;
  const BASE = `body{margin:0;font-size:20px;line-height:1.5}p{margin:0 0 0 20px}`;
  const OVER = `img{position:absolute;left:0;top:0;width:300px;height:120px}`;
  const scan = (body: string, css: string, declared = false) =>
    scanDecorationLayers(browser, { html: page(body), css: BASE + css, svgs: new Map([["assets/seam.svg", SEAM]]), assets: [{ id: "seam", file: "assets/seam.svg" }], facts, declared });

  it("the decoration covering a fact (positioned, painted after the text): refused — by the geometry gate and the stylesheet allowlist; the layer codes are advisory", async () => {
    const r = await scan(`<main><p>${FACT}</p>${IMG}</main>`, OVER);
    expect(r.page_static).toEqual([]); // the N1 page allowlist says nothing about where the img lands
    expect(r.page_css).toEqual(expect.arrayContaining(["CSS_PROPERTY"])); // position: absolute is refused before render today
    expect(r.geometry).toEqual(["FACT_COVERED", "FACT_IMAGE_OVERLAP"]);
    expect(r.layer_codes).toEqual(["FACT_NONCONTENT_OVERLAP", "PAINT_ORDER_COVER"]);
    expect(r.layer_blocking).toEqual([]);
    expect(r.covers).toBe(1);
    expect(r.stacking).toBe(0);
    expect(r.unexpected_requests).toEqual([]);
  }, 60_000);

  it("the decoration covering the disclosure: the same, with the DISCLOSURE codes", async () => {
    const r = await scan(`<main><p data-comp-disclosure="">これは架空の店です</p>${IMG}</main>`, OVER);
    expect(r.page_css).toEqual(expect.arrayContaining(["CSS_PROPERTY"]));
    expect(r.geometry).toEqual(["DISCLOSURE_COVERED", "DISCLOSURE_IMAGE_OVERLAP"]);
    expect(r.layer_codes).toEqual(["DISCLOSURE_NONCONTENT_OVERLAP", "PAINT_ORDER_COVER"]);
    expect(r.layer_blocking).toEqual([]);
  }, 60_000);

  it("the decoration over plain (not protected) text: only the advisory PAINT_ORDER_COVER — no gate protects ordinary text from it", async () => {
    const r = await scan(`<main><p>ただの文</p>${IMG}</main>`, OVER);
    expect(r.page_css).toEqual(expect.arrayContaining(["CSS_PROPERTY"])); // positioned: refused before render today
    expect(r.geometry).toEqual([]);
    expect(r.layer_codes).toEqual(["PAINT_ORDER_COVER"]);
    expect(r.layer_blocking).toEqual([]);
    expect(r.covers).toBe(1);
  }, 60_000);

  it("under a fact with z-index -1 (painted below): STACKING_CONTEXT is the blocking code; V4 and the geometry still fire whatever the paint order", async () => {
    const r = await scan(`<main><p>${FACT}</p>${IMG}</main>`, `${OVER} img{z-index:-1}`);
    expect(r.page_css).toEqual(expect.arrayContaining(["CSS_PROPERTY"]));
    expect(r.layer_codes).toEqual(["FACT_NONCONTENT_OVERLAP", "STACKING_CONTEXT"]);
    expect(r.layer_blocking).toEqual(["STACKING_CONTEXT"]);
    expect(r.covers).toBe(0);
    expect(r.geometry).toEqual(["FACT_IMAGE_OVERLAP"]);
  }, 60_000);

  it("under a fact without a stacking context (the text positioned over an in-flow img): no cover, no STACKING_CONTEXT; V4 and the geometry still fire", async () => {
    const r = await scan(`<main>${IMG}<p class="lift">${FACT}</p></main>`, `img{display:block;width:300px;height:120px}.lift{position:relative;top:-100px}`);
    expect(r.page_css).toEqual(expect.arrayContaining(["CSS_PROPERTY"]));
    expect(r.layer_codes).toEqual(["FACT_NONCONTENT_OVERLAP"]);
    expect(r.layer_blocking).toEqual([]);
    expect(r.covers).toBe(0);
    expect(r.stacking).toBe(0);
    expect(r.geometry).toEqual(["FACT_IMAGE_OVERLAP"]);
  }, 60_000);

  it("under a fact by a negative margin (no positioning at all): the stylesheet allowlist refuses the value; V4 and the geometry fire", async () => {
    const r = await scan(`<main>${IMG}<p class="lift">${FACT}</p></main>`, `img{display:block;width:300px;height:120px}.lift{margin-top:-100px}`);
    expect(r.page_css).toEqual(["CSS_VALUE"]);
    expect(r.layer_codes).toEqual(["FACT_NONCONTENT_OVERLAP"]);
    expect(r.layer_blocking).toEqual([]);
    expect(r.geometry).toEqual(["FACT_IMAGE_OVERLAP"]);
  }, 60_000);

  it("fully clear of text, in flow: nothing fires anywhere (stylesheet, layer scan, geometry)", async () => {
    const r = await scan(`<main><p>${FACT}</p>${IMG}</main>`, `img{display:block;width:300px;height:120px;margin-top:40px}`);
    expect(r).toMatchObject({ page_static: [], page_css: [], layer_codes: [], geometry: [], stacking: 0, covers: 0, unexpected_requests: [] });
  }, 60_000);

  it("fully clear of text but positioned: the layer scan and geometry pass; only the stylesheet allowlist refuses position", async () => {
    const r = await scan(`<main><p>${FACT}</p>${IMG}</main>`, `img{position:absolute;left:400px;top:300px;width:300px;height:120px}`);
    expect(r.layer_codes).toEqual([]);
    expect(r.layer_blocking).toEqual([]);
    expect(r.geometry).toEqual([]);
    expect(r.page_css).toEqual(expect.arrayContaining(["CSS_PROPERTY"]));
  }, 60_000);

  it("the role model: a decorative SVG img derives as media; declaring it decoration is ROLE_MISMATCH (blocking)", async () => {
    const css = `img{display:block;width:300px;height:120px;margin-top:40px}`;
    const derived = await scan(`<main><p>${FACT}</p>${IMG}</main>`, css);
    expect(derived.roles.media).toBe(1);
    expect(derived.roles.decoration).toBe(0);
    const declared = await scan(`<main><p>${FACT}</p>${IMG.replace("<img", '<img data-comp-role="decoration"')}</main>`, css, true);
    expect(declared.layer_blocking).toEqual(["ROLE_MISMATCH"]);
    const asMedia = await scan(`<main><p>${FACT}</p>${IMG.replace("<img", '<img data-comp-role="media"')}</main>`, css, true);
    expect(asMedia.layer_codes).toEqual([]);
  }, 60_000);

  it("the checks are box-based: the seam's box is mostly transparent, yet a fact under any part of it fires", async () => {
    // the seam's ink is the line near x = 70 % of the box; the fact sits at the box's left, far from the line
    const r = await scan(`<main><p>${FACT}</p>${IMG}</main>`, `img{position:absolute;left:0;top:0;width:600px;height:40px}`);
    expect(r.page_css).toEqual(expect.arrayContaining(["CSS_PROPERTY"]));
    expect(r.geometry).toContain("FACT_IMAGE_OVERLAP");
    expect(r.layer_codes).toContain("FACT_NONCONTENT_OVERLAP");
    expect(r.layer_blocking).toEqual([]);
  }, 60_000);

  // Fresh Review M1: an overlap needs neither position nor a negative value. A grid item wider than its track, aligned to
  // the track's end, overflows back over the first column. The production stylesheet allowlist passes this CSS.
  const GRID = `main{display:grid;grid-template-columns:200px 200px}img{display:block;justify-self:end;width:400px;height:120px}`;
  const IMG400 = IMG.replace('width="300"', 'width="400"');

  it("M1: in flow, no position, no negative value — over plain text: every gate passes; only the advisory PAINT_ORDER_COVER fires", async () => {
    const r = await scan(`<main><p>ただの文ただの文ただの文</p>${IMG400}</main>`, GRID);
    expect(r.page_static).toEqual([]);
    expect(r.page_css).toEqual([]); // the production allowlist does NOT refuse this placement
    expect(r.geometry).toEqual([]);
    expect(r.layer_codes).toEqual(["PAINT_ORDER_COVER"]);
    expect(r.layer_blocking).toEqual([]); // advisory only today: phase C must make it blocking or decide (C-3)
    expect(r.covers).toBe(1);
    expect(r.stacking).toBe(0);
    expect(r.unexpected_requests).toEqual([]);
  }, 60_000);

  it("M1: the same in-flow overlap over a fact — the geometry gate still blocks (FACT_COVERED, FACT_IMAGE_OVERLAP)", async () => {
    const r = await scan(`<main><p>${FACT}</p>${IMG400}</main>`, GRID);
    expect(r.page_css).toEqual([]);
    expect(r.geometry).toEqual(["FACT_COVERED", "FACT_IMAGE_OVERLAP"]);
    expect(r.layer_codes).toEqual(["FACT_NONCONTENT_OVERLAP", "PAINT_ORDER_COVER"]);
    expect(r.layer_blocking).toEqual([]);
  }, 60_000);
});
