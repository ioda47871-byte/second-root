import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import { COPY_FACTS_NAME, COPY_RECORD_NAME, COPY_REVIEW_NAME, priorName, verifyPackageCopy, CopyPackageError, type CopyInput } from "@/lib/demo-version-package/copy";
import { importPackage, type PackageStore } from "@/lib/demo-version-package/import";
import { buildPackage, checkPackageCopy, PACKAGE_FORMAT, PACKAGE_FORMAT_COPY, PackageError, readPackage, writePackage, type DemoVersionPackage } from "@/lib/demo-version-package/package";
import { reviewCopyQuality, type CopyQualityFiles, type CopyQualityReview } from "@/lib/design-agent/quality-pipeline/copy-quality-review";
import * as fx from "../design-agent/quality-pipeline/copy-quality-fixtures";

// DEV-199d (Issue #258, owner decision ②): the copy of a demo version package (copy.json, facts pack, review and its
// earlier rounds) bound by sha256 and checked again on build, read and import. Synthetic fictional shops (and the
// made-up real-shop sample) from the DEV-199a fixtures; no network, no model, no database (the client is a stub).

const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
const png = (width: number, height: number, c = 90) => sharp({ create: { width, height, channels: 3, background: { r: c, g: 120, b: 160 } } }).png().toBuffer();
const tmp: string[] = [];
const outDir = () => {
  const d = mkdtempSync(join(tmpdir(), "copy-pkg-"));
  tmp.push(d);
  return d;
};
afterAll(() => tmp.forEach((d) => rmSync(d, { recursive: true, force: true })));

let rendersCache: { desktop_1440: Uint8Array; mobile_390: Uint8Array } | null = null;
const renders = async () => (rendersCache ??= { desktop_1440: new Uint8Array(await png(1440, 900)), mobile_390: new Uint8Array(await png(390, 900, 91)) });
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

/** A package of these files with this review (and earlier rounds). */
const pkgOf = async (f: CopyQualityFiles, review: unknown, rounds: CopyInput["rounds"] = []) =>
  buildPackage({ html: String(f.pageHtml), css: String(f.pageCss), renders: await renders(), source: "test", copy: { factsPack: f.factsPack, copyRecord: f.copyRecord, review: json(review), rounds } });

/** The bakery page with three headings; every record item is shown (record ↔ page). */
const bakery = (headings: [string, string, string], o: { extra?: string; dropBreadHow?: boolean } = {}) => {
  const g = fx.bakeryGood();
  const base = (g.record.items as fx.Item[]).filter((i) => !["tagline", "closed", "access", ...(o.dropBreadHow ? ["bread-how"] : [])].includes(i.id));
  const items = [...base, fx.creative("h1x", headings[0]), fx.creative("h2x", headings[1]), fx.creative("h3x", headings[2]), ...(o.extra ? [fx.creative("extra", o.extra)] : [])];
  return fx.shopFiles({
    facts: fx.bakeryFacts(),
    items,
    sections: [
      { id: "hero", blocks: [["h1", "name"], ["p", "name-full"]] },
      { id: "croissant", blocks: [["h2", "h1x"], ["p", "croissant"], ["p", "croissant-how"]] },
      { id: "bread", blocks: [["h2", "h2x"], ["p", "bread"], ...(o.dropBreadHow ? [] : ([["p", "bread-how"]] as fx.Block[])), ...(o.extra ? ([["p", "extra"]] as fx.Block[]) : [])] },
      { id: "info", blocks: [["h2", "h3x"], ["dt", "hours", "label"], ["dd", "hours"], ["dt", "address", "label"], ["dd", "address"]] },
    ],
  });
};
const POETIC: [string, string, string] = ["朝の光", "棚の記憶", "通りの角"];
const PLAIN: [string, string, string] = ["クロワッサンのご案内", "食パンのご案内", "お店の情報"];
const round = (f: CopyQualityFiles, review: unknown) => ({ copyRecord: f.copyRecord, pageHtml: f.pageHtml, pageCss: f.pageCss, review: json(review) });
const er = (...fs: CopyQualityFiles[]) => fs.map((f) => ({ copyRecord: f.copyRecord, pageHtml: f.pageHtml, pageCss: f.pageCss }));

/** The refusal code chain of a PackageError (`COPY_INVALID`, then the copy code and its details). */
async function refusal(p: Promise<unknown> | (() => unknown)): Promise<string[]> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    if (e instanceof PackageError) return [e.code, ...e.details];
    if (e instanceof CopyPackageError) return [e.code, ...e.details];
    throw e;
  }
  throw new Error("expected a refusal");
}

describe("v2 package: a valid copy passes with the verdict the check computes", () => {
  it("fictional research page: approve_candidate, never sendable (fictional, no owner approval, facts not from the facts path)", async () => {
    const f = fx.bakeryGood();
    const r = reviewCopyQuality(f);
    expect(r.verdict).toBe("approve_candidate");
    const pkg = await pkgOf(f, r);
    expect(pkg.format).toBe(PACKAGE_FORMAT_COPY);
    // the page manifest (the database's) is unchanged: no copy file in it, the same bundle as the page alone
    const plain = await buildPackage({ html: String(f.pageHtml), css: String(f.pageCss), renders: await renders(), source: "test" });
    expect(plain.format).toBe(PACKAGE_FORMAT);
    expect(pkg.manifest).toEqual(plain.manifest);
    expect(pkg.bundleSha256).toBe(plain.bundleSha256);
    expect(pkg.manifest.files.some((x) => x.name.startsWith("copy/"))).toBe(false);
    expect(pkg.copy!.bundle_sha256).toBe(pkg.bundleSha256);
    expect(pkg.copy!.files.map((x) => [x.name, x.role])).toEqual([
      [COPY_RECORD_NAME, "copy_record"],
      [COPY_FACTS_NAME, "facts_pack"],
      [COPY_REVIEW_NAME, "review"],
    ]);

    const res = checkPackageCopy(pkg);
    expect(res).toMatchObject({ status: "reviewed", sendable: false, lane: "quality_research_fictional", round: 0, verdict: "approve_candidate", copy_verdict: "approve_candidate", next_step: "owner_review", facts_from_facts_path: false, auditor_version: "copy_quality_rules_v1" });
    expect(res.send_blockers).toEqual(["FICTIONAL_RESEARCH_NOT_SENDABLE", "OWNER_APPROVAL_MISSING", "FACTS_NOT_FROM_FACTS_PATH"]);
    if (res.status === "reviewed") {
      expect([res.facts_sha256, res.copy_sha256, res.page_html_sha256, res.page_css_sha256]).toEqual([sha(f.factsPack), sha(f.copyRecord), sha(f.pageHtml), sha(f.pageCss)]);
      expect(res.review_sha256).toBe(sha(json(r)));
    }
    // with the facts pack from the facts path: compared, and only the owner / lane blockers remain
    const trusted = checkPackageCopy(pkg, { trustedFactsPack: f.factsPack });
    expect(trusted).toMatchObject({ facts_from_facts_path: true, send_blockers: ["FICTIONAL_RESEARCH_NOT_SENDABLE", "OWNER_APPROVAL_MISSING"] });
    expect(await refusal(() => checkPackageCopy(pkg, { trustedFactsPack: fx.bakeryFacts({ withInfo: false }) }))).toEqual(["COPY_INVALID", "COPY_FACTS_NOT_FROM_FACTS_PATH"]);
  });

  it("writes and reads back (the copy files beside the page; re-verified on read)", async () => {
    const f = fx.bakeryGood();
    const pkg = await pkgOf(f, reviewCopyQuality(f));
    const dir = outDir();
    writePackage(dir, pkg);
    expect(readFileSync(join(dir, COPY_RECORD_NAME), "utf8")).toBe(f.copyRecord);
    const meta = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(meta.format).toBe(PACKAGE_FORMAT_COPY);
    expect(Object.keys(meta.copy)).toEqual(["version", "bundle_sha256", "files"]);
    const back = readPackage(dir);
    expect(back.copy).toEqual(pkg.copy);
    expect(checkPackageCopy(back)).toMatchObject({ status: "reviewed", verdict: "approve_candidate" });
  });

  it("real-shop lane: verdict hold (COPY_APPROVAL_MISSING), the copy itself passes, goes to the owner, never sendable here", async () => {
    const f = fx.realShop();
    const r = reviewCopyQuality(f);
    const res = checkPackageCopy(await pkgOf(f, r), { trustedFactsPack: f.factsPack });
    expect(res).toMatchObject({ status: "reviewed", sendable: false, lane: "real_shop_proposal", verdict: "hold", copy_verdict: "approve_candidate", next_step: "owner_review", unresolved: ["COPY_APPROVAL_MISSING"] });
    expect(res.send_blockers).toEqual(["OWNER_APPROVAL_MISSING"]);
  });

  it("a revise page is imported as revise (not sendable, next step revise)", async () => {
    const f = bakery(POETIC);
    const r = reviewCopyQuality(f);
    expect(r.verdict).toBe("revise");
    expect(checkPackageCopy(await pkgOf(f, r))).toMatchObject({ verdict: "revise", next_step: "revise", send_blockers: expect.arrayContaining(["REVIEW_NOT_PASSED"]) });
  });

  it("a revision chain (round 0 revise → round 1 words only) passes as round 1, with its earlier round in the package", async () => {
    const f0 = bakery(POETIC);
    const r0 = reviewCopyQuality(f0);
    const f1 = bakery(PLAIN);
    const r1 = reviewCopyQuality(f1, { round: 1, previousCopySha256: r0.copy_sha256, earlierRounds: er(f0) });
    expect(r1.verdict).toBe("approve_candidate");
    const pkg = await pkgOf(f1, r1, [round(f0, r0)]);
    expect(pkg.copy!.files.map((x) => x.name)).toEqual([COPY_RECORD_NAME, COPY_FACTS_NAME, COPY_REVIEW_NAME, priorName(0, "copy.json"), priorName(0, "index.html"), priorName(0, "review.json"), priorName(0, "style.css")]);
    expect(checkPackageCopy(pkg)).toMatchObject({ status: "reviewed", round: 1, verdict: "approve_candidate" });
    const dir = outDir();
    writePackage(dir, pkg);
    expect(checkPackageCopy(readPackage(dir))).toMatchObject({ round: 1 });
  });
});

describe("refused (or never sendable) as designed", () => {
  it("legacy v1 package: read as copy_unreviewed, never sendable; a v1 with copy files, or a v2 without them, is refused", async () => {
    const f = fx.bakeryGood();
    const v1 = await buildPackage({ html: String(f.pageHtml), css: String(f.pageCss), renders: await renders(), source: "test" });
    expect(checkPackageCopy(v1)).toEqual({ status: "copy_unreviewed", sendable: false, send_blockers: ["COPY_UNREVIEWED_LEGACY_PACKAGE"] });
    const v2 = await pkgOf(f, reviewCopyQuality(f));
    expect(await refusal(() => checkPackageCopy({ ...v2, format: PACKAGE_FORMAT }))).toEqual(["COPY_INVALID", "COPY_IN_V1_PACKAGE"]);
    expect(await refusal(() => checkPackageCopy({ ...v2, copy: undefined, copyFiles: undefined }))).toEqual(["COPY_INVALID", "COPY_MANIFEST_INVALID"]);
    expect(await refusal(() => checkPackageCopy({ ...v2, format: "sales_demo_version_package_v3" as never }))).toEqual(["PACKAGE_FORMAT"]);
    // stripping the copy out of a v2 package only lands it at copy_unreviewed
    const dir = outDir();
    writePackage(dir, v2);
    const meta = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    delete meta.copy;
    writeFileSync(join(dir, "package.json"), JSON.stringify({ ...meta, format: PACKAGE_FORMAT }));
    expect(checkPackageCopy(readPackage(dir))).toMatchObject({ status: "copy_unreviewed", sendable: false });
    // a v1 package.json that still names copy files is refused on read
    writeFileSync(join(dir, "package.json"), JSON.stringify({ ...meta, format: PACKAGE_FORMAT, copy: v2.copy }));
    expect(await refusal(() => readPackage(dir))).toEqual(["COPY_INVALID", "COPY_IN_V1_PACKAGE"]);
  });

  it("missing copy.json: on disk, in the files, or left out of the copy manifest", async () => {
    const f = fx.bakeryGood();
    const pkg = await pkgOf(f, reviewCopyQuality(f));
    const dir = outDir();
    writePackage(dir, pkg);
    rmSync(join(dir, COPY_RECORD_NAME));
    expect(await refusal(() => readPackage(dir))).toEqual(["COPY_INVALID", "COPY_FILE_MISSING", COPY_RECORD_NAME]);
    const rest = Object.fromEntries(Object.entries(pkg.copyFiles!).filter(([n]) => n !== COPY_RECORD_NAME));
    expect(await refusal(() => checkPackageCopy({ ...pkg, copyFiles: rest }))).toEqual(["COPY_INVALID", "COPY_FILE_MISSING", COPY_RECORD_NAME]);
    // left out of the copy manifest: fewer than the three required files is not a copy manifest
    const copy = { ...pkg.copy!, files: pkg.copy!.files.filter((x) => x.name !== COPY_RECORD_NAME) };
    expect(await refusal(() => checkPackageCopy({ ...pkg, copy, copyFiles: rest }))).toEqual(["COPY_INVALID", "COPY_MANIFEST_INVALID"]);
    // or replaced by an earlier round's record name: the required name is still missing
    const swapped = { ...pkg.copy!, files: pkg.copy!.files.map((x) => (x.name === COPY_RECORD_NAME ? { ...x, name: priorName(0, "copy.json"), role: "prior_copy_record" as const } : x)) };
    expect(await refusal(() => checkPackageCopy({ ...pkg, copy: swapped, copyFiles: { ...rest, [priorName(0, "copy.json")]: pkg.copyFiles![COPY_RECORD_NAME]! } }))).toEqual(["COPY_INVALID", "COPY_FILE_MISSING", COPY_RECORD_NAME]);
  });

  it("tampered bytes of copy, facts or review on disk: hash mismatch", async () => {
    const f = fx.bakeryGood();
    const pkg = await pkgOf(f, reviewCopyQuality(f));
    for (const name of [COPY_RECORD_NAME, COPY_FACTS_NAME, COPY_REVIEW_NAME]) {
      const dir = outDir();
      writePackage(dir, pkg);
      writeFileSync(join(dir, name), readFileSync(join(dir, name), "utf8").replace("}", ' }'));
      expect(await refusal(() => readPackage(dir)), name).toEqual(["COPY_INVALID", "COPY_FILE_HASH_MISMATCH", name]);
    }
  });

  it("tampered copy / facts / HTML / CSS with every hash recomputed: the old review no longer matches the files", async () => {
    const f = fx.bakeryGood();
    const r = reviewCopyQuality(f);
    // copy: the same items re-ordered (still passes the copy check) — the review is for other bytes
    const rec = JSON.parse(String(f.copyRecord));
    const copy2 = json({ ...rec, items: [...rec.items].reverse() });
    expect(await refusal(pkgOf({ ...f, copyRecord: copy2 }, r))).toEqual(["COPY_INVALID", "COPY_REVIEW_INVALID", "REVIEW_STALE_COPY", "REVIEW_DOES_NOT_MATCH_AUDIT"]);
    // facts: re-serialised (the record's facts_sha256 no longer matches): the existing copy check refuses first
    const facts2 = JSON.stringify(JSON.parse(String(f.factsPack)));
    expect((await refusal(pkgOf({ ...f, factsPack: facts2 }, r))).slice(0, 2)).toEqual(["COPY_INVALID", "COPY_CHECK_FAILED"]);
    // HTML: a class added (the same words)
    const html2 = String(f.pageHtml).replace("<main>", '<main class="x">');
    expect(await refusal(pkgOf({ ...f, pageHtml: html2 }, r))).toEqual(["COPY_INVALID", "COPY_REVIEW_INVALID", "REVIEW_STALE_PAGE_HTML", "REVIEW_DOES_NOT_MATCH_AUDIT"]);
    // CSS: one rule added
    const css2 = `${String(f.pageCss)}h2{margin:0}\n`;
    expect(await refusal(pkgOf({ ...f, pageCss: css2 }, r))).toEqual(["COPY_INVALID", "COPY_REVIEW_INVALID", "REVIEW_STALE_PAGE_CSS", "REVIEW_DOES_NOT_MATCH_AUDIT"]);
    // the page itself changed under the copy manifest (the page manifest names other bytes)
    const pkg = await pkgOf(f, r);
    expect(await refusal(() => checkPackageCopy({ ...pkg, files: { ...pkg.files, "page/index.html": new TextEncoder().encode(html2) } }))).toEqual(["COPY_INVALID", "COPY_PAGE_NOT_MANIFEST_PAGE"]);
    // the copy manifest of another bundle
    expect(await refusal(() => checkPackageCopy({ ...pkg, copy: { ...pkg.copy!, bundle_sha256: "0".repeat(64) } }))).toEqual(["COPY_INVALID", "COPY_BUNDLE_MISMATCH"]);
  });

  it("a page text not in the copy record, or a record item not on the page: the record must describe this page", async () => {
    const f = fx.bakeryGood();
    const html2 = String(f.pageHtml).replace("</main>", "<p>新しい一文です。</p>\n</main>");
    expect((await refusal(pkgOf({ ...f, pageHtml: html2 }, reviewCopyQuality({ ...f, pageHtml: html2 })))).slice(0, 3)).toEqual(["COPY_INVALID", "COPY_CHECK_FAILED", "UNVERIFIED_COPY"]);
    const rec = JSON.parse(String(f.copyRecord));
    const copy2 = json({ ...rec, items: [...rec.items, fx.creative("unused", "棚の奥の話。")] });
    const g = { ...f, copyRecord: copy2 };
    expect(await refusal(pkgOf(g, reviewCopyQuality(g)))).toEqual(["COPY_INVALID", "COPY_RECORD_ITEM_NOT_ON_PAGE", "unused"]);
  });

  it("forged review verdict: a revise page declared approve_candidate (schema-valid) does not match the re-run audit", async () => {
    const f = bakery(POETIC);
    const r = reviewCopyQuality(f);
    expect(r.verdict).toBe("revise");
    const forged: CopyQualityReview = { ...r, findings: [], unresolved: [], verdict: "approve_candidate" };
    expect(await refusal(pkgOf(f, forged))).toEqual(["COPY_INVALID", "COPY_REVIEW_INVALID", "REVIEW_DOES_NOT_MATCH_AUDIT"]);
    // a verdict that disagrees with its own findings does not even parse
    expect(await refusal(pkgOf(f, { ...r, verdict: "approve_candidate" }))).toEqual(["COPY_INVALID", "COPY_REVIEW_INVALID", "REVIEW_SCHEMA"]);
    // no declared verdict in the copy manifest either
    const pkg = await pkgOf(fx.bakeryGood(), reviewCopyQuality(fx.bakeryGood()));
    expect(await refusal(() => checkPackageCopy({ ...pkg, copy: { ...pkg.copy!, verdict: "approve_candidate" } as never }))).toEqual(["COPY_INVALID", "COPY_MANIFEST_INVALID"]);
  });

  it("stale review: the PASS of the previous files reused for new copy is refused", async () => {
    const old = bakery(PLAIN);
    const r = reviewCopyQuality(old);
    expect(r.verdict).toBe("approve_candidate");
    const now = bakery(POETIC);
    expect(await refusal(pkgOf(now, r))).toEqual(["COPY_INVALID", "COPY_REVIEW_INVALID", "REVIEW_STALE_COPY", "REVIEW_STALE_PAGE_HTML", "REVIEW_DOES_NOT_MATCH_AUDIT"]);
  });

  it("a review with another auditor_version is refused (schema)", async () => {
    const f = fx.bakeryGood();
    const r = reviewCopyQuality(f);
    expect(await refusal(pkgOf(f, { ...r, auditor_version: "copy_quality_rules_v0" }))).toEqual(["COPY_INVALID", "COPY_REVIEW_INVALID", "REVIEW_SCHEMA"]);
  });

  it("broken chains: a round without its earlier rounds, a forged earlier review, a second round 0, an unlinked round", async () => {
    const f0 = bakery(POETIC);
    const r0 = reviewCopyQuality(f0);
    const f1 = bakery(PLAIN);
    const r1 = reviewCopyQuality(f1, { round: 1, previousCopySha256: r0.copy_sha256, earlierRounds: er(f0) });
    expect(await refusal(pkgOf(f1, r1))).toEqual(["COPY_INVALID", "COPY_ROUNDS_INCOMPLETE"]);
    // the earlier review forged into a revise it is not: an approve_candidate round 0 cannot open a revision
    const a0 = reviewCopyQuality(bakery(PLAIN));
    const g1 = bakery(["クロワッサンについて", "食パンについて", "お店の情報"]);
    const s1 = reviewCopyQuality(g1, { round: 1, previousCopySha256: a0.copy_sha256, earlierRounds: er(bakery(PLAIN)) });
    expect((await refusal(pkgOf(g1, s1, [round(bakery(PLAIN), a0)]))).slice(0, 3)).toEqual(["COPY_INVALID", "COPY_REVIEW_CHAIN_INVALID", "LAST_ROUND_DOES_NOT_ALLOW_REVISION"]);
    const finding = r0.findings.find((x) => x.code === "COPY_RHETORICAL_OVERUSE")!;
    const forged0 = { ...a0, findings: [finding], verdict: "revise", unresolved: ["COPY_RHETORICAL_OVERUSE"] };
    const t1 = reviewCopyQuality(g1, { round: 1, previousCopySha256: a0.copy_sha256, earlierRounds: er(bakery(PLAIN)) });
    const forgedChain = await refusal(pkgOf(g1, t1, [round(bakery(PLAIN), forged0)]));
    expect(forgedChain.slice(0, 2)).toEqual(["COPY_INVALID", "COPY_REVIEW_INVALID"]);
    expect(forgedChain).toContain("PREVIOUS_REVIEW_DOES_NOT_MATCH_AUDIT");
    // a round 0 with earlier rounds in the package is not a chain
    const z1 = reviewCopyQuality(f1);
    expect(await refusal(pkgOf(f1, z1, [round(f0, r0)]))).toEqual(["COPY_INVALID", "COPY_ROUNDS_INCOMPLETE"]);
    // a second round 0 in the earlier rounds (a revision replayed as a first audit) breaks the order
    const f2 = bakery(["クロワッサンについて", "食パンのご案内", "お店の情報"]);
    const z2 = reviewCopyQuality(f2, { round: 2, previousCopySha256: z1.copy_sha256, earlierRounds: er(f0, f1) });
    const replay = await refusal(pkgOf(f2, z2, [round(f0, r0), round(f1, z1)]));
    expect(replay.slice(0, 2)).toEqual(["COPY_INVALID", "COPY_REVIEW_CHAIN_INVALID"]);
    expect(replay).toContain("ROUND_0_ALREADY_STORED");
    // round 1 linked to a copy other than its earlier round's
    const unlinked = reviewCopyQuality(f1, { round: 1, previousCopySha256: "2".repeat(64), earlierRounds: er(f0) });
    expect((await refusal(pkgOf(f1, unlinked, [round(f0, r0)]))).slice(0, 3)).toEqual(["COPY_INVALID", "COPY_REVIEW_CHAIN_INVALID", "NOT_LINKED_TO_LAST_ROUND"]);
  });

  it("a revision that launders a fact (fail) is refused, never imported", async () => {
    const f0 = bakery(POETIC);
    const r0 = reviewCopyQuality(f0);
    const f1 = bakery(PLAIN, { dropBreadHow: true, extra: "前日から寝かせる生地" });
    const r1 = reviewCopyQuality(f1, { round: 1, previousCopySha256: r0.copy_sha256, earlierRounds: er(f0) });
    expect(r1.verdict).toBe("fail");
    const codes = await refusal(pkgOf(f1, r1, [round(f0, r0)]));
    expect(codes[0]).toBe("COPY_INVALID");
    expect(["COPY_REVIEW_INVALID", "COPY_REVIEW_FAIL"]).toContain(codes[1]);
  });

  it("fictional vs real-shop lane: AI demo pictures (fictional 輪 only) with real-shop copy are refused", () => {
    const f = fx.realShop();
    const r = reviewCopyQuality(f);
    // verifyPackageCopy reads only the count of the image records (their own checks are checkPackageImages)
    return pkgOf(f, r).then(async (pkg) => {
      expect(await refusal(() => verifyPackageCopy({ ...pkg, images: [{}] }))).toEqual(["COPY_REAL_SHOP_LANE_WITH_AI_IMAGES"]);
      const g = fx.bakeryGood();
      const fic = await pkgOf(g, reviewCopyQuality(g));
      expect(verifyPackageCopy({ ...fic, images: [{}] })).toMatchObject({ lane: "quality_research_fictional", send_blockers: expect.arrayContaining(["FICTIONAL_RESEARCH_NOT_SENDABLE"]) });
    });
  });

  it("only the copy manifest's fixed names: an extra file, a name outside the shapes, a third round", async () => {
    const f = fx.bakeryGood();
    const pkg = await pkgOf(f, reviewCopyQuality(f));
    expect(await refusal(() => checkPackageCopy({ ...pkg, copyFiles: { ...pkg.copyFiles!, "copy/notes.json": new Uint8Array([123, 125]) } }))).toEqual(["COPY_INVALID", "COPY_FILE_NOT_IN_MANIFEST", "copy/notes.json"]);
    for (const name of ["copy/../x.json", "copy/rounds/2/copy.json", "page/copy.json"]) {
      const copy = { ...pkg.copy!, files: [...pkg.copy!.files, { name, role: "prior_copy_record" as const, sha256: sha("{}"), bytes: 2 }] };
      expect(await refusal(() => checkPackageCopy({ ...pkg, copy, copyFiles: { ...pkg.copyFiles!, [name]: new TextEncoder().encode("{}") } })), name).toEqual(["COPY_INVALID", "COPY_NAME_NOT_ALLOWED", name]);
    }
  });
});

describe("importPackage: the copy is checked before the database, and the computed result is returned", () => {
  const store = (): PackageStore & { objects: Map<string, Uint8Array> } => {
    const objects = new Map<string, Uint8Array>();
    return { objects, download: async (k) => objects.get(k) ?? null, upload: async (k, b) => void objects.set(k, b) };
  };
  const DEMO = "11111111-1111-4111-8111-111111111111";
  const VERSION = "22222222-2222-4222-8222-222222222222";
  const client = (pkg: DemoVersionPackage, calls: string[]) =>
    ({
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: VERSION, demo_id: DEMO, version_no: 1, storage_prefix: `v1/${DEMO}/${VERSION}/`, bundle_sha256: pkg.bundleSha256 }, error: null }) }) }),
      }),
      rpc: async (name: string) => {
        calls.push(name);
        return { data: { version_id: VERSION, replayed: false }, error: null };
      },
    }) as never;

  it("a valid v2 package: imported, the page files only uploaded (never the copy files), `copy` computed", async () => {
    const f = fx.realShop();
    const pkg = await pkgOf(f, reviewCopyQuality(f));
    const calls: string[] = [];
    const s = store();
    const res = await importPackage(pkg, { client: client(pkg, calls), store: s, demoId: DEMO, trustedFactsPack: f.factsPack });
    expect(calls).toEqual(["sales_ingest_demo_version"]);
    expect([...s.objects.keys()].some((k) => k.includes("copy/"))).toBe(false);
    expect(res.copy).toMatchObject({ status: "reviewed", sendable: false, verdict: "hold", copy_verdict: "approve_candidate", send_blockers: ["OWNER_APPROVAL_MISSING"] });
  });

  it("a v1 package is imported as copy_unreviewed; a tampered copy is refused before the ingest is called", async () => {
    const f = fx.bakeryGood();
    const v1 = await buildPackage({ html: String(f.pageHtml), css: String(f.pageCss), renders: await renders(), source: "test" });
    const calls: string[] = [];
    expect((await importPackage(v1, { client: client(v1, calls), store: store(), demoId: DEMO })).copy).toEqual({ status: "copy_unreviewed", sendable: false, send_blockers: ["COPY_UNREVIEWED_LEGACY_PACKAGE"] });
    const pkg = await pkgOf(f, reviewCopyQuality(f));
    const tampered = { ...pkg, copyFiles: { ...pkg.copyFiles!, [COPY_RECORD_NAME]: new TextEncoder().encode(`${String(f.copyRecord)} `) } };
    const before = calls.length;
    expect(await refusal(importPackage(tampered, { client: client(pkg, calls), store: store(), demoId: DEMO }))).toEqual(["COPY_INVALID", "COPY_FILE_HASH_MISMATCH", COPY_RECORD_NAME]);
    expect(await refusal(importPackage(pkg, { client: client(pkg, calls), store: store(), demoId: DEMO, trustedFactsPack: fx.bakeryFacts({ withInfo: false }) }))).toEqual(["COPY_INVALID", "COPY_FACTS_NOT_FROM_FACTS_PATH"]);
    expect(calls.length).toBe(before);
  });
});

describe("isolation", () => {
  const src = (p: string) => readFileSync(join(fx.REPO, p), "utf8");
  const specifiers = (s: string) => [...s.matchAll(/^import[^;]*?from\s*["']([^"']+)["']/gm)].map((m) => m[1]).sort();
  it("the copy check imports only zod, sha256 and the existing checks (no file, network, process or model)", () => {
    expect(specifiers(src("lib/demo-version-package/copy.ts"))).toEqual([
      "@/lib/design-agent/quality-pipeline/copy-quality-page",
      "@/lib/design-agent/quality-pipeline/copy-quality-review",
      "@/lib/design-agent/quality-pipeline/copy-record",
      "@/lib/design-agent/quality-pipeline/facts-pack",
      "@/lib/sales/demo-version/copy-check",
      "@/lib/sales/demo-version/html-safety",
      "@/lib/sales/demo-version/manifest",
      "node:crypto",
      "zod",
    ]);
    expect(src("lib/demo-version-package/copy.ts")).not.toMatch(/\bfetch\(|import\s*\(|require\s*\(|child_process|node:fs|anthropic|openai|codex|\/worker\//i);
  });
  it("the app, components and the sales library do not read the package or its copy result (the send path is not wired: DEV-199e)", () => {
    const walk = (d: string): string[] =>
      readdirSync(join(fx.REPO, d), { withFileTypes: true }).flatMap((e) => {
        const p = `${d}/${e.name}`;
        if (e.isDirectory()) return e.name === "node_modules" ? [] : walk(p);
        return /\.(ts|tsx|mts|mjs|js)$/.test(e.name) ? [p] : [];
      });
    const importers = ["app", "components", "lib/sales"].flatMap(walk).filter((p) => /from\s*["'][^"']*demo-version-package\/(copy|import|package)["']/.test(src(p)));
    expect(importers).toEqual([]);
  });
});
