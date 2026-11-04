import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Browser } from "playwright";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HOSTILE_SVGS, MOUNTAIN, SEAM, SHOP_SHAPES, WHEEL } from "../../../../lib/design-agent/research/decoration-fixtures";
import { launchDecorationBrowser } from "../../../../lib/design-agent/research/decoration-page-browser";
import {
  checkN1Asset,
  n1ReviewProblems,
  N1_REVIEW_KEYS,
  N1_REVIEW_SCHEMA,
  NO_ATTESTATION,
  pendingN1Review,
  renderN1Preview,
  type N1Asset,
  type N1OwnerReview,
  type N1Preview,
  type N1ReviewBinding,
} from "../../../../lib/design-agent/research/decoration-review";
import { APPROVED_CAPABILITIES, CAPABILITY_NAMES } from "../../../../lib/design-agent/comp-impl/spec";

// DEV-174 (Issue #193 comment 6628165899): the per-asset owner visual review record for N1 (schema 2: asset sha256 +
// rendered preview sha256 + renderer + pending / approved / rejected + an attestation hook). RESEARCH ONLY, NOT ENABLED.
// No record in this file is an owner review: every approved or rejected one is an in-memory TEST FIXTURE.

const REPO = resolve(__dirname, "../../../..");
const MODULE = "lib/design-agent/research/decoration-review.ts";
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const NOW = new Date("2026-11-04T12:00:00Z");
const FIXTURE_MARK = "TEST FIXTURE - not an owner review";
const RENDERER = "chromium/test-fixture";
const PREVIEW_SHA = "b".repeat(64);
const preview = (over: Partial<N1Preview> = {}): N1Preview => ({ sha256: PREVIEW_SHA, renderer: RENDERER, width: 100, height: 100, scale: 2, background: "#ffffff", ...over });
const ASSET = { id: "seam", file: "assets/seam.svg" };
const bound = (over: Partial<N1ReviewBinding> = {}): N1ReviewBinding => ({ assetId: "seam", assetFile: "assets/seam.svg", assetSha256: sha(SEAM), preview: { sha256: PREVIEW_SHA, renderer: RENDERER, width: 100, height: 100 }, ...over });
/** A verifier that says yes to anything: TEST FIXTURE ONLY, to show the path an attested record would take. */
const FIXTURE_ATTEST = () => true;
/** TEST FIXTURE - not an owner review: an "approved" record built in memory, never written to a file. */
const fixtureDecided = (over: Partial<Record<keyof N1OwnerReview, unknown>> = {}) =>
  ({ ...pendingN1Review(ASSET, sha(SEAM), preview()), decision: "approved", reviewed_at: "2026-11-02", note: FIXTURE_MARK, ...over }) as N1OwnerReview;
const without = (r: object, key: string) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== key));
/** Tracked and untracked (not ignored) files under a top-level directory of the repository. */
const tracked = (top: string) => spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", top], { cwd: REPO, encoding: "utf8" }).stdout.split("\n").filter(Boolean);

describe("the record: what an agent may write is pending, and pending is refused", () => {
  it("pendingN1Review has exactly the nine keys, decision pending, no date, and is refused only for being pending", () => {
    const r = pendingN1Review(ASSET, sha(SEAM), preview());
    expect(Object.keys(r).sort()).toEqual([...N1_REVIEW_KEYS]);
    expect(r).toMatchObject({ schema: N1_REVIEW_SCHEMA, reviewer: "owner", decision: "pending", reviewed_at: null, note: "" });
    expect(n1ReviewProblems(r, bound(), { now: NOW })).toEqual(["N1_REVIEW_PENDING"]);
    // a verifier changes nothing for a pending record (it is never asked)
    expect(n1ReviewProblems(r, bound(), { now: NOW, attest: FIXTURE_ATTEST })).toEqual(["N1_REVIEW_PENDING"]);
  });

  it("an approved record with no verifier (the default: the owner has not decided how to prove it) is refused", () => {
    expect(n1ReviewProblems(fixtureDecided(), bound(), { now: NOW })).toEqual(["N1_REVIEW_UNATTESTED"]);
    expect(n1ReviewProblems(fixtureDecided(), bound(), { now: NOW, attest: NO_ATTESTATION })).toEqual(["N1_REVIEW_UNATTESTED"]);
    expect(
      n1ReviewProblems(fixtureDecided(), bound(), {
        now: NOW,
        attest: () => {
          throw new Error("x");
        },
      }),
    ).toEqual(["N1_REVIEW_UNATTESTED"]);
    expect(n1ReviewProblems(fixtureDecided(), bound(), { now: NOW, attest: (() => "yes") as unknown as () => boolean })).toEqual(["N1_REVIEW_UNATTESTED"]);
  });

  it("only an approved, attested record of exactly these bytes and this picture passes (the mechanism, with a fixture verifier)", () => {
    expect(n1ReviewProblems(fixtureDecided(), bound(), { now: NOW, attest: FIXTURE_ATTEST })).toEqual([]);
  });

  it.each([
    ["no record", undefined, "N1_REVIEW_MISSING"],
    ["null", null, "N1_REVIEW_MISSING"],
    ["an array", [], "N1_REVIEW_MISSING"],
    ["the string approved", "approved", "N1_REVIEW_MISSING"],
    ["rejected", fixtureDecided({ decision: "rejected" }), "N1_REVIEW_REJECTED"],
    ["an unknown decision", fixtureDecided({ decision: "ok" }), "N1_REVIEW_DECISION"],
    ["decision upper case", fixtureDecided({ decision: "APPROVED" }), "N1_REVIEW_DECISION"],
    ["pending with a date", fixtureDecided({ decision: "pending" }), "N1_REVIEW_DATE"],
    ["approved without a date", fixtureDecided({ reviewed_at: null }), "N1_REVIEW_DATE"],
    ["approved in the future", fixtureDecided({ reviewed_at: "2026-12-01" }), "N1_REVIEW_DATE"],
    ["not a real day", fixtureDecided({ reviewed_at: "2026-02-30" }), "N1_REVIEW_DATE"],
    ["reviewer claude", fixtureDecided({ reviewer: "claude" }), "N1_REVIEW_REVIEWER"],
    ["reviewer Owner (case)", fixtureDecided({ reviewer: "Owner" }), "N1_REVIEW_REVIEWER"],
    ["another schema (DEV-165's)", fixtureDecided({ schema: "owner_visual_review@1" }), "N1_REVIEW_SCHEMA"],
    ["another asset id", fixtureDecided({ asset_id: "wheel" }), "N1_REVIEW_ASSET"],
    ["another asset file", fixtureDecided({ asset_file: "assets/wheel.svg" }), "N1_REVIEW_ASSET"],
    ["the sha of other bytes", fixtureDecided({ asset_sha256: sha(WHEEL) }), "N1_REVIEW_ASSET_SHA256"],
    ["the sha upper case", fixtureDecided({ asset_sha256: sha(SEAM).toUpperCase() }), "N1_REVIEW_ASSET_SHA256"],
    ["another picture", fixtureDecided({ preview: preview({ sha256: "c".repeat(64) }) }), "N1_REVIEW_PREVIEW_SHA256"],
    ["no picture sha", fixtureDecided({ preview: without(preview(), "sha256") }), "N1_REVIEW_PREVIEW_SHA256"],
    ["drawn by another renderer", fixtureDecided({ preview: preview({ renderer: "chromium/999" }) }), "N1_REVIEW_PREVIEW_RENDERER"],
    ["drawn at another size", fixtureDecided({ preview: preview({ width: 200 }) }), "N1_REVIEW_PREVIEW_SIZE"],
    ["drawn at scale 1", fixtureDecided({ preview: preview({ scale: 1 as 2 }) }), "N1_REVIEW_PREVIEW_SHAPE"],
    ["drawn on black", fixtureDecided({ preview: preview({ background: "#000000" as "#ffffff" }) }), "N1_REVIEW_PREVIEW_SHAPE"],
    ["an extra preview key", fixtureDecided({ preview: { ...preview(), crop: true } }), "N1_REVIEW_PREVIEW_SHAPE"],
    ["no note", fixtureDecided({ note: undefined }), "N1_REVIEW_NOTE"],
    ["a note too long", fixtureDecided({ note: "x".repeat(501) }), "N1_REVIEW_NOTE"],
    ["an extra key", { ...fixtureDecided(), approved_by_claude: true }, "N1_REVIEW_SHAPE"],
    ["a missing key", without(fixtureDecided(), "reviewer"), "N1_REVIEW_SHAPE"],
  ])("refused even with a verifier that says yes: %s", (_, record, code) => {
    const p = n1ReviewProblems(record, bound(), { now: NOW, attest: FIXTURE_ATTEST });
    expect(p).toContain(code);
    expect(p).not.toContain("N1_REVIEW_UNATTESTED"); // the verifier is asked only of an otherwise clean approved record
  });

  it("the verifier gets a frozen plain copy of the nine validated fields, never the live record", () => {
    const seen: unknown[] = [];
    const rec = fixtureDecided();
    expect(n1ReviewProblems(rec, bound(), { now: NOW, attest: (x) => (seen.push(x), true) })).toEqual([]);
    const got = seen[0] as N1OwnerReview;
    expect(got).not.toBe(rec);
    expect(got.preview).not.toBe(rec.preview);
    expect(Object.isFrozen(got)).toBe(true);
    expect(Object.isFrozen(got.preview)).toBe(true);
    expect(Object.getPrototypeOf(got)).toBe(Object.prototype);
    expect(Object.keys(got).sort()).toEqual([...N1_REVIEW_KEYS]);
    expect(got).toEqual(rec);
    // a verifier that tries to change what it was given changes nothing in the caller's record
    n1ReviewProblems(rec, bound(), {
      now: NOW,
      attest: (x) => {
        try {
          (x as { decision: string }).decision = "rejected";
        } catch {
          // frozen: strict mode throws
        }
        return true;
      },
    });
    expect(rec.decision).toBe("approved");
  });

  it("a record whose getters answer differently on each read is read once: the checks and the verifier see the same values", () => {
    let reads = 0;
    const base = fixtureDecided();
    const shifty = { ...base };
    Object.defineProperty(shifty, "asset_sha256", {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? sha(SEAM) : sha(WHEEL);
      },
    });
    const seen: N1OwnerReview[] = [];
    expect(n1ReviewProblems(shifty, bound(), { now: NOW, attest: (x) => (seen.push(x as N1OwnerReview), true) })).toEqual([]);
    expect(reads).toBe(1);
    expect(seen[0]!.asset_sha256).toBe(sha(SEAM));
  });

  it("nothing read or nothing rendered: the record cannot be bound", () => {
    expect(n1ReviewProblems(fixtureDecided(), bound({ assetSha256: null }), { now: NOW, attest: FIXTURE_ATTEST })).toEqual(["N1_REVIEW_ASSET_SHA256"]);
    expect(n1ReviewProblems(fixtureDecided(), bound({ preview: null }), { now: NOW, attest: FIXTURE_ATTEST })).toEqual(["N1_REVIEW_PREVIEW_SHA256", "N1_REVIEW_PREVIEW_RENDERER", "N1_REVIEW_PREVIEW_SIZE"]);
  });

  it("a hostile record never throws", () => {
    const evil = Object.defineProperty({}, "decision", {
      enumerable: true,
      get() {
        throw new Error("x");
      },
    });
    expect(() => n1ReviewProblems(evil, bound(), { now: NOW })).not.toThrow();
    expect(n1ReviewProblems(evil, bound(), { now: NOW }).length).toBeGreaterThan(0);
  });
});

describe("checkN1Asset: the file side and the record together, bound to a preview it renders itself (Chromium)", () => {
  let dir: string;
  let browser: Browser;
  /** The preview checkN1Asset will render from SEAM: a record for these bytes must carry exactly this picture. */
  let real: N1Preview;
  const asset = (body: string, over: Partial<N1Asset> = {}): N1Asset => ({ id: "seam", file: "assets/seam.svg", sha256: sha(body), bytes: Buffer.byteLength(body), width: 100, height: 100, kind: "decoration_svg", role: "decoration", ...over });
  /** TEST FIXTURE - not an owner review: approved, bound to the real picture of SEAM (fixtureDecided carries FIXTURE_MARK). */
  const decided = (over: Partial<Record<keyof N1OwnerReview, unknown>> = {}) => fixtureDecided({ preview: { ...real }, ...over });
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "dev174-review-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "assets/seam.svg"), SEAM);
    browser = await launchDecorationBrowser();
    const r = await renderN1Preview(browser, Buffer.from(SEAM), 100, 100);
    expect(r.problems).toEqual([]);
    real = r.preview!;
  }, 60_000);
  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await browser?.close();
  }, 60_000);

  it("a clean file with no record, a pending record, or an unattested approval is refused; only the real picture, attested, passes", async () => {
    expect(await checkN1Asset(browser, dir, asset(SEAM), undefined, { now: NOW })).toEqual(["N1_REVIEW_MISSING"]);
    expect(await checkN1Asset(browser, dir, asset(SEAM), pendingN1Review(ASSET, sha(SEAM), real), { now: NOW })).toEqual(["N1_REVIEW_PENDING"]);
    expect(await checkN1Asset(browser, dir, asset(SEAM), decided(), { now: NOW })).toEqual(["N1_REVIEW_UNATTESTED"]);
    expect(await checkN1Asset(browser, dir, asset(SEAM), decided(), { now: NOW, attest: FIXTURE_ATTEST })).toEqual([]);
  }, 60_000);

  it("the preview is not the caller's to give: a forged picture sha256, another renderer or another size is refused, even attested", async () => {
    // the record carries whatever picture it likes; checkN1Asset renders the bytes itself and compares
    expect(await checkN1Asset(browser, dir, asset(SEAM), decided({ preview: preview() }), { now: NOW, attest: FIXTURE_ATTEST })).toEqual(["N1_REVIEW_PREVIEW_SHA256", "N1_REVIEW_PREVIEW_RENDERER"]);
    expect(await checkN1Asset(browser, dir, asset(SEAM), decided({ preview: { ...real, sha256: PREVIEW_SHA } }), { now: NOW, attest: FIXTURE_ATTEST })).toEqual(["N1_REVIEW_PREVIEW_SHA256"]);
    expect(await checkN1Asset(browser, dir, asset(SEAM), decided({ preview: { ...real, renderer: "chromium/999.0.0.0" } }), { now: NOW, attest: FIXTURE_ATTEST })).toEqual(["N1_REVIEW_PREVIEW_RENDERER"]);
    expect(await checkN1Asset(browser, dir, asset(SEAM), decided({ preview: { ...real, width: 200 } }), { now: NOW, attest: FIXTURE_ATTEST })).toEqual(["N1_REVIEW_PREVIEW_SIZE"]);
  }, 60_000);

  it("an asset record whose size is not the file's is not drawn, so no record can be bound to it", async () => {
    for (const over of [{ width: 200 }, { height: 50 }, { width: 0 }, { width: Number.NaN }]) {
      const r = await checkN1Asset(browser, dir, asset(SEAM, over), decided({ preview: { ...real, ...over } }), { now: NOW, attest: FIXTURE_ATTEST });
      expect(r, JSON.stringify(over)).toEqual(expect.arrayContaining(["ASSET_DIMENSIONS", "N1_PREVIEW_SIZE", "N1_REVIEW_PREVIEW_SHA256"]));
    }
  }, 60_000);

  it("any byte change voids the record, even when the asset record follows the new bytes", async () => {
    const changed = SEAM.replace("#b8923a", "#b8923b");
    writeFileSync(join(dir, "assets/seam.svg"), changed);
    try {
      // the bytes and the picture both changed: both bindings refuse the old record
      expect(await checkN1Asset(browser, dir, asset(changed), decided(), { now: NOW, attest: FIXTURE_ATTEST })).toEqual(["N1_REVIEW_ASSET_SHA256", "N1_REVIEW_PREVIEW_SHA256"]);
    } finally {
      writeFileSync(join(dir, "assets/seam.svg"), SEAM);
    }
  }, 60_000);

  it("a file refused by the file side carries its own code and cannot be bound", async () => {
    const r = await checkN1Asset(browser, dir, { ...asset(SEAM), file: "assets/none.svg" }, decided({ asset_file: "assets/none.svg" }), { now: NOW, attest: FIXTURE_ATTEST });
    expect(r).toEqual(expect.arrayContaining(["ASSET_MISSING", "N1_REVIEW_ASSET_SHA256", "N1_REVIEW_PREVIEW_SHA256"]));
    const bad = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><text>半額</text></svg>`;
    writeFileSync(join(dir, "assets/text.svg"), bad);
    const t = await checkN1Asset(browser, dir, { ...asset(bad), id: "text", file: "assets/text.svg" }, decided({ asset_id: "text", asset_file: "assets/text.svg", asset_sha256: sha(bad) }), { now: NOW, attest: FIXTURE_ATTEST });
    expect(t.some((c) => c.startsWith("SVG_"))).toBe(true);
    expect(t).toContain("N1_REVIEW_PREVIEW_SHA256"); // never drawn, so never bound
  }, 60_000);

  it("a hostile asset record never throws", async () => {
    const evil = Object.defineProperty({}, "file", {
      get() {
        throw new Error("x");
      },
    }) as N1Asset;
    await expect(checkN1Asset(browser, dir, evil, decided(), { now: NOW, attest: FIXTURE_ATTEST })).resolves.toEqual(expect.any(Array));
    expect((await checkN1Asset(browser, dir, evil, decided(), { now: NOW, attest: FIXTURE_ATTEST })).length).toBeGreaterThan(0);
  }, 60_000);
});

describe("the preview the owner looks at (Chromium; WebKit / Firefox: BLOCKED here, not installed)", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await launchDecorationBrowser();
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
  }, 60_000);

  it("the same bytes give the same picture in fresh contexts; one changed colour gives another; the record follows the picture", async () => {
    const a = await renderN1Preview(browser, Buffer.from(SEAM), 100, 100);
    const b = await renderN1Preview(browser, Buffer.from(SEAM), 100, 100);
    const c = await renderN1Preview(browser, Buffer.from(SEAM.replace("#b8923a", "#b8923b")), 100, 100);
    expect(a.problems).toEqual([]);
    expect(a.unexpected).toEqual([]);
    expect(a.preview!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(b.preview!.sha256).toBe(a.preview!.sha256);
    expect(c.preview!.sha256).not.toBe(a.preview!.sha256);
    expect(a.preview!.renderer).toMatch(/^chromium\/\d+\./);
    expect(a.preview!.sha256).toBe(sha(a.png!));
    // the picture is the asset at scale 2 on white, and it is not blank
    const { data, info } = await sharp(a.png!).raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([200, 200]);
    let ink = 0;
    for (let i = 0; i < data.length; i += info.channels) if (data[i]! < 250 || data[i + 1]! < 250 || data[i + 2]! < 250) ink++;
    expect(ink).toBeGreaterThan(0);
    // a record made for picture a passes the binding of a only
    const rec = { ...pendingN1Review(ASSET, sha(SEAM), a.preview!), decision: "approved", reviewed_at: "2026-11-02", note: FIXTURE_MARK };
    const pa = { sha256: a.preview!.sha256, renderer: a.preview!.renderer, width: 100, height: 100 };
    expect(n1ReviewProblems(rec, bound({ preview: pa }), { now: NOW, attest: FIXTURE_ATTEST })).toEqual([]);
    expect(n1ReviewProblems(rec, bound({ preview: { ...pa, sha256: c.preview!.sha256 } }), { now: NOW, attest: FIXTURE_ATTEST })).toEqual(["N1_REVIEW_PREVIEW_SHA256"]);
  }, 60_000);

  it.each(SHOP_SHAPES.map((s) => [s.name, s.svg] as const))("%s: renders at its own size, loads nothing else", async (_, body) => {
    const m = /width="(\d+)" height="(\d+)"/.exec(body)!;
    const r = await renderN1Preview(browser, Buffer.from(body), Number(m[1]), Number(m[2]));
    expect(r.problems).toEqual([]);
    expect(r.unexpected).toEqual([]);
  }, 60_000);

  it("a file the checker refuses is never drawn; a size other than the file's is refused", async () => {
    for (const h of HOSTILE_SVGS) {
      const r = await renderN1Preview(browser, Buffer.from(h.svg), 100, 100);
      expect(r.preview, h.name).toBeNull();
      expect(r.problems.length, h.name).toBeGreaterThan(0);
    }
    expect((await renderN1Preview(browser, Buffer.from(MOUNTAIN), 330, 300)).problems).toEqual(["N1_PREVIEW_SIZE"]);
  }, 60_000);
});

describe("nothing is approved, and nothing can be (repository guards)", () => {
  it("N1 is not a capability, and APPROVED_CAPABILITIES is empty", () => {
    expect(APPROVED_CAPABILITIES).toEqual([]);
    expect(CAPABILITY_NAMES.some((c) => /decoration_svg|n1|svg/i.test(c))).toBe(false);
  });

  it("the module writes only pending records and defines no verifier but the one that refuses; no other lib file names the verifier type", () => {
    const src = readFileSync(resolve(REPO, MODULE), "utf8");
    expect(src).not.toMatch(/["']?decision["']?\s*:\s*["'](approved|rejected)["']/);
    expect(src.match(/:\s*N1Attestation\s*=/g)).toEqual([": N1Attestation ="]);
    expect(src).toMatch(/export const NO_ATTESTATION: N1Attestation = \(\) => false;/);
    // no other way to mint a verifier in the module: a cast, satisfies, an angle-bracket assertion
    expect(src).not.toMatch(/\bas\s+N1Attestation\b|\bsatisfies\s+N1Attestation\b|<N1Attestation>/);
    const lib = tracked("lib").filter((f) => f.endsWith(".ts") && f !== MODULE);
    expect(lib.length).toBeGreaterThan(10);
    expect(lib.filter((f) => /\bN1Attestation\b|\bNO_ATTESTATION\b/.test(readFileSync(resolve(REPO, f), "utf8")))).toEqual([]);
  });

  it("no tracked record exists: the schema marker is named only by the module, its research tests and the docs; no JSON holds one", () => {
    const r = spawnSync("git", ["grep", "--untracked", "-l", "-F", N1_REVIEW_SCHEMA], { cwd: REPO, encoding: "utf8" });
    expect(r.error).toBeUndefined();
    // the marker lives in the module as a constant and the tests import it: git grep finds at least the module
    expect(r.status).toBe(0);
    const hits = r.stdout.split("\n").filter(Boolean);
    expect(hits).toContain(MODULE);
    const allowed = (h: string) => h === MODULE || h === "docs/design/n1-implementation-prep.md" || h === ".ai/reviews/DEV-174.md" || /^tests\/unit\/design-agent\/research\/[a-z0-9-]+\.test\.ts$/.test(h);
    expect(hits.filter((h) => !allowed(h))).toEqual([]);
    const data = spawnSync("git", ["grep", "--untracked", "-l", "-F", "n1-owner-visual-review", "--", "*.json"], { cwd: REPO, encoding: "utf8" });
    expect(data.error).toBeUndefined();
    expect(data.status).toBe(1); // 1 = no match anywhere
  });

  it("in every lib, test and script file that touches the N1 record, each decided record (approved / rejected) is a marked in-memory fixture", () => {
    const N1 = /decoration-review|N1OwnerReview|n1ReviewProblems|checkN1Asset|pendingN1Review|N1Attestation|N1_REVIEW_SCHEMA|n1-owner-visual-review/;
    // a value, not a type: `decision: "approved" | "rejected"` (DEV-165's OwnerVisualReview type) is not a record
    const DECIDED = /["']?decision["']?\s*:\s*["'](approved|rejected)["'](?!\s*\|)/;
    // fixtureDecided (this file) and fixtureReview (decoration-n1-verification.test.ts, DEV-165) build their records with the mark
    const MARK = /TEST FIXTURE - not an owner review|FIXTURE_MARK|fixtureDecided\(|fixtureReview\(/;
    const files = [...tracked("lib"), ...tracked("tests"), ...tracked("scripts")].filter((f) => /\.(ts|tsx|mts|js|mjs)$/.test(f));
    expect(files.length).toBeGreaterThan(100);
    let approved = 0;
    let rejected = 0;
    let touching = 0;
    for (const f of files) {
      const src = readFileSync(resolve(REPO, f), "utf8");
      if (!N1.test(src)) continue;
      touching += 1;
      const lines = src.split("\n");
      lines.forEach((line, i) => {
        const m = DECIDED.exec(line);
        if (!m) return;
        if (m[1] === "approved") approved += 1;
        else rejected += 1;
        expect(f, `${f}:${i + 1}`).toMatch(/^tests\//);
        expect(lines.slice(Math.max(0, i - 2), i + 3).join("\n"), `${f}:${i + 1}`).toMatch(MARK);
      });
    }
    expect(touching).toBeGreaterThanOrEqual(3); // the module and the two DEV-174 tests at least
    // the helpers named in MARK do carry the mark where they are defined
    for (const [f, helper] of [["tests/unit/design-agent/research/n1-owner-review.test.ts", "fixtureDecided"], ["tests/unit/design-agent/research/decoration-n1-verification.test.ts", "fixtureReview"]] as const) {
      const lines = readFileSync(resolve(REPO, f), "utf8").split("\n");
      const at = lines.findIndex((l) => new RegExp(`const ${helper} =`).test(l));
      expect(at, `${f} ${helper}`).toBeGreaterThanOrEqual(0);
      expect(lines.slice(at, at + 3).join("\n"), `${f} ${helper}`).toMatch(/TEST FIXTURE - not an owner review|FIXTURE_MARK/);
    }
    // never vacuous: this file's fixtureDecided, the preview test, and the rejected fixtures
    expect(approved).toBeGreaterThanOrEqual(2);
    expect(rejected).toBeGreaterThanOrEqual(1);
  });
});
