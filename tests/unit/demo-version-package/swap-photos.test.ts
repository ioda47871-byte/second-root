import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import { importPackage, ImportError, type PackageStore } from "@/lib/demo-version-package/import";
import { buildPackage, PackageError, readPackage, writePackage } from "@/lib/demo-version-package/package";
import { convertPhoto, PhotoError, photoUrlMap, provePhotoUrlRewrite, rewritePhotoUrls, storedPhotoUrl } from "@/lib/demo-version-package/photos";
import { RIN_PROSPECT_ID } from "@/lib/demo-version-package/seed-rin";
import { pixelDiff, prepareSwap, readOriginals, readSwapPage, SwapInputError } from "@/lib/demo-version-package/swap-package";
import { packageImageProblems } from "@/lib/demo-version-package/swap-rights";
import { renderPrototype } from "@/lib/design-agent/phase2f/render-prototype";
import { BICYCLE_PROMPT_SHA256 } from "@/lib/design-agent/quality-pipeline/bicycle-ai-photos";
import { checkFileBytes, hasImageMetadata, PHOTO_NAME } from "@/lib/sales/demo-version/manifest";
import { cleanupDirs, fixture, INV, newDir, noise, NOW, PAGE, png, RANGES, recOf, REPO, sha, sub, type Fixture, type Obj } from "../../support/rin-swap-fixture";

// DEV-196s (owner approval 2026-11-11): 輪 with its AI demo photos, packaged locally. SYNTHETIC fixtures only: the page
// structure is the committed d1-v9 transformed by the real photo-swap transform, but every photo is a tiny generated
// image and the rights file is fake (a fixture model name, the approved prompt's sha256). The real photos never enter.

afterAll(cleanupDirs);

const prepare = (f: Fixture, photoLimit?: number) =>
  prepareSwap({ page: readSwapPage(f.page), rights: JSON.parse(readFileSync(f.rightsPath, "utf8")), summary: JSON.parse(readFileSync(f.summaryPath, "utf8")), originals: readOriginals(f.originals), forbiddenSha256: new Set(["0".repeat(64)]), now: NOW, ...(photoLimit ? { photoLimit } : {}) });

describe("photo names: the server's PHOTO_NAME, the slot's hyphens as underscores", () => {
  it("maps each swap name; the range and the slot stay readable", () => {
    expect(storedPhotoUrl("photos/ph-bench-mobile.png")).toBe("photos/ph_bench-mobile.webp");
    expect(storedPhotoUrl("photos/ph-a-desktop.jpg")).toBe("photos/ph_a-desktop.webp");
    for (const s of INV.slots) for (const r of RANGES) expect(PHOTO_NAME.test(`page/${storedPhotoUrl(`photos/${s.slot_id}-${r}.png`)}`)).toBe(true);
  });
  it("refuses anything else (no PNG range, an uppercase slot, a path, an unknown range)", () => {
    for (const bad of ["photos/ph-a.png", "photos/PH-a-desktop.png", "photos/../ph-a-desktop.png", "photos/ph-a-wide.png", "photos/ph-a-desktop.webp", "photos/x-desktop.png"]) expect(() => storedPhotoUrl(bad), bad).toThrow(PhotoError);
  });
  it("refuses two photos that would share a stored name", () => {
    expect(() => photoUrlMap(["photos/ph-a-b-desktop.png", "photos/ph-a_b-desktop.png"])).toThrow(PhotoError);
  });
});

describe("the URL rewrite changes only the photo URLs (proved)", () => {
  const map = photoUrlMap(["photos/ph-a-desktop.png", "photos/ph-a-mobile.png"]);
  const before = '<picture data-slot="ph-a"><source media="(max-width: 600px)" srcset="photos/ph-a-mobile.png"><img src="photos/ph-a-desktop.png" alt="a"></picture><p>写真の説明 photos は文の語</p>';
  it("rewrites every reference and the proof holds", () => {
    const after = rewritePhotoUrls(before, map);
    expect(after).toContain('srcset="photos/ph_a-mobile.webp"');
    expect(after).toContain('src="photos/ph_a-desktop.webp"');
    expect(provePhotoUrlRewrite(before, after, map)).toMatchObject({ refs: 2 });
  });
  it("the proof fails when anything else changed (one byte of text, an attribute, an old URL left)", () => {
    const after = rewritePhotoUrls(before, map);
    for (const bad of [after.replace("写真の説明", "写真の説朙"), after.replace('alt="a"', 'alt="b"'), after.replace("photos/ph_a-mobile.webp", "photos/ph-a-mobile.png"), `${after} `]) {
      expect(() => provePhotoUrlRewrite(before, bad, map)).toThrow(/REWRITE_CHANGED_MORE/);
    }
  });
  it("a reference to a photo the copy does not hold is refused", () => {
    expect(() => rewritePhotoUrls('<img src="photos/ph-z-desktop.png">', map)).toThrow(/PHOTO_REF_UNKNOWN/);
  });
});

describe("convertPhoto: WebP within the limit, same pixel size, sRGB, no ICC, no metadata", () => {
  it("lossless when it fits; the original's sha256 is recorded; the server's byte check passes", async () => {
    const b = await png(40, 30, 77);
    const c = await convertPhoto(b);
    expect(c).toMatchObject({ mode: "lossless", quality: null, width: 40, height: 30, original: { sha256: sha(b), format: "png", width: 40, height: 30, icc: false } });
    expect(hasImageMetadata(Buffer.from(c.webp))).toBe(false);
    expect(checkFileBytes({ name: "page/photos/ph_a-desktop.webp", role: "photo", sha256: sha(c.webp), bytes: c.webp.byteLength, content_type: "image/webp", width: 40, height: 30 }, c.webp)).toEqual({ ok: true });
    // the pixels are the original's (lossless)
    const [x, y] = await Promise.all([sharp(b).raw().toBuffer(), sharp(Buffer.from(c.webp)).removeAlpha().raw().toBuffer()]);
    expect(Buffer.compare(x, y)).toBe(0);
  });
  it("a JPEG with an ICC profile and EXIF: converted, the profile and metadata dropped", async () => {
    const jpg = await sharp(await png(40, 30, 99)).withIccProfile("p3").withExif({ IFD0: { Copyright: "fixture" } }).jpeg().toBuffer();
    expect((await sharp(jpg).metadata()).icc).toBeTruthy();
    const c = await convertPhoto(jpg);
    expect(c.original).toMatchObject({ format: "jpeg", icc: true });
    const m = await sharp(Buffer.from(c.webp)).metadata();
    expect(m.icc).toBeUndefined();
    expect(m.exif).toBeUndefined();
    expect(hasImageMetadata(Buffer.from(c.webp))).toBe(false);
  });
  it("lossy at the highest quality that fits when lossless does not; refused when nothing fits", async () => {
    const b = await noise(200, 150);
    const at = async (q: number) => (await sharp(b).webp({ quality: q, effort: 6, smartSubsample: false }).toBuffer()).byteLength;
    const limit = await at(90);
    expect((await convertPhoto(b)).webp.byteLength).toBeGreaterThan(limit);
    const c = await convertPhoto(b, limit);
    expect(c.mode).toBe("lossy");
    expect(c.quality).toBeGreaterThanOrEqual(90);
    expect(c.webp.byteLength).toBeLessThanOrEqual(limit);
    expect([c.width, c.height]).toEqual([200, 150]);
    // one quality higher would not have fit (the highest that fits)
    if (c.quality! < 100) expect(await at(c.quality! + 1)).toBeGreaterThan(limit);
    await expect(convertPhoto(b, 200)).rejects.toThrow(/PHOTO_TOO_LARGE/);
  });
  it("refuses a picture over the 4096 px side (never resized), and anything that is not PNG or JPEG", async () => {
    await expect(convertPhoto(await png(4097, 2, 1))).rejects.toThrow(/PHOTO_SIDE_OVER_LIMIT/);
    await expect(convertPhoto(await sharp(await png(4, 4, 1)).webp().toBuffer())).rejects.toThrow(/PHOTO_NOT_PNG_OR_JPEG/);
    await expect(convertPhoto(Buffer.from("<svg/>"))).rejects.toThrow(PhotoError);
  });
});

describe("prepareSwap on a synthetic 輪 swap (the real d1-v9 structure, 5 slots × 3 ranges, 6 originals)", () => {
  it("builds the stored copy, the photos and one AI-demo image record per photo", async () => {
    const f = await fixture();
    const p = await prepare(f);
    expect(p.photos.size).toBe(15);
    expect([...p.photos.keys()].every((k) => PHOTO_NAME.test(`page/${k}`))).toBe(true);
    expect(p.proof.html.refs).toBe(15);
    expect(p.proof.css.refs).toBe(0);
    expect(p.html).not.toMatch(/photos\/ph-/);
    expect(p.conversions.every((c) => c.mode === "lossless")).toBe(true);
    expect(p.images).toHaveLength(15);
    for (const i of p.images) {
      expect(packageImageProblems(i)).toEqual([]);
      expect(i).toMatchObject({ format: "webp", source_kind: "ai_generated_demo", rights_status: "ai_demo_internal", depicts_real_shop: false, depicts_identifiable_person: false, depicts_real_product: false, depicts_real_interior: false, depicts_real_equipment: false, allowed_uses: { public_web: false } });
      expect(i.provenance).toEqual({ generator: "fixture generator", model: "fixture-gen", generated_at: "2026-11-06T20:10:51+09:00", prompt_sha256: BICYCLE_PROMPT_SHA256, approval_id: "fixture-approval-01", admin_preview_only: true });
    }
    // nothing private reaches the records: no owner, consent record, private path or focal box
    const text = JSON.stringify(p.images);
    for (const word of ["fixture owner", "fixture-consent", ".intake", "focal_box", "demo_only"]) expect(text).not.toContain(word);
    // the bench's SP crop comes from the SP original, the rest from the PC one
    const bench = p.sources.filter((s) => s.slot_id === "ph-bench");
    expect(bench.map((s) => [s.stored, s.which])).toEqual([["photos/ph_bench-desktop.webp", "pc"], ["photos/ph_bench-mobile.webp", "sp"], ["photos/ph_bench-tablet.webp", "pc"]]);
    // the inputs are unchanged (read only)
    expect(sha(readFileSync(join(f.page, "index.html")))).toBe((f.summary.copy_hashes as { html: string }).html);
  });

  it("packages it with the same server checks: photos in the manifest, the images matched, the summary; read back verified", async () => {
    const f = await fixture();
    const p = await prepare(f);
    const pkg = await buildPackage({ html: p.html, css: p.css, renders: { desktop_1440: await png(1440, 900, 3), mobile_390: await png(390, 844, 4) }, photos: p.photos, images: p.images, photoChecks: { count: 15 }, local: { conversions: p.conversions }, source: "swap-copy" });
    expect(pkg.manifest.files.filter((x) => x.role === "photo")).toHaveLength(15);
    expect(pkg.rightsSummary).toEqual({ version: 1, photos: 15, by_status: { ai_demo_internal: 15 }, earliest_expiry: null, label_required: true });
    expect(Buffer.byteLength(JSON.stringify(pkg.workerChecks))).toBeLessThanOrEqual(2000);
    const out = newDir();
    writePackage(out, pkg);
    const back = readPackage(out);
    expect(back.images).toEqual(pkg.images);
    // a record changed in the written package is refused on read
    const meta = JSON.parse(readFileSync(join(out, "package.json"), "utf8"));
    for (const tamper of [(m: { images: Record<string, unknown>[] }) => (m.images[0]!.depicts_real_shop = true), (m: { images: Record<string, unknown>[] }) => ((m.images[0]!.allowed_uses as Record<string, boolean>).public_web = true), (m: { images: Record<string, unknown>[] }) => m.images.pop(), (m: { images: Record<string, unknown>[] }) => ((m.images[0]!.provenance as Record<string, unknown>).model = "unknown"), (m: { images: Record<string, unknown>[] }) => (m.images[0]!.owner = "x")]) {
      const copy = JSON.parse(JSON.stringify(meta));
      tamper(copy);
      const d = newDir();
      writePackage(d, pkg);
      writeFileSync(join(d, "package.json"), JSON.stringify(copy));
      expect(() => readPackage(d)).toThrow(PackageError);
    }
    // photos without their records, or records without photos, are refused at build
    await expect(buildPackage({ html: p.html, css: p.css, renders: { desktop_1440: await png(1440, 900, 3), mobile_390: await png(390, 844, 4) }, photos: p.photos, source: "swap-copy" })).rejects.toThrow(/IMAGES_INVALID/);
  });

  it.each([
    ["the approved prompt is not the one recorded", { rights: (r: Obj) => (sub(recOf(r, 0), "ai_provenance").prompt_sha256 = "a".repeat(64)) }, /AI_DEMO_PROMPT_NOT_APPROVED/],
    ["public web allowed", { rights: (r: Obj) => (sub(recOf(r, 1), "allowed_uses").public_web = true) }, /PUBLIC_WEB_NOT_FALSE/],
    ["a real shop depicted", { rights: (r: Obj) => (recOf(r, 0).depicts_real_shop = true) }, /RIGHTS_REFUSED.*REAL_SHOP_DEPICTED/],
    ["no provenance", { rights: (r: Obj) => delete recOf(r, 0).ai_provenance }, /RIGHTS_REFUSED.*RIGHTS_MISSING_AI_PROVENANCE/],
    ["a human photo, not an AI demo picture", { rights: (r: Obj) => { const x = recOf(r, 0); x.source_kind = "owner_provided"; delete x.ai_provenance; } }, /NOT_AI_DEMO/],
    ["a record that does not describe its original", { rights: (r: Obj) => (recOf(r, 0).sha256 = "b".repeat(64)) }, /ORIGINAL_MISSING/],
    ["a crop cut from another slot's photo", { summary: (s: Obj) => (sub(sub(s, "crops"), "ph-a/desktop").asset_id = "photo-ph-b") }, /CROP_SOURCE_UNKNOWN/],
    ["the bench SP crop said to be from the PC photo", { summary: (s: Obj) => (sub(sub(s, "crops"), "ph-bench/mobile").source = "pc") }, /CROP_SOURCE_UNKNOWN/],
    ["a page that is not the swap's copy", { summary: (s: Obj) => (sub(s, "copy_hashes").html = "c".repeat(64)) }, /PAGE_NOT_THE_SWAP_COPY/],
    ["a photo that is not the swap's crop", { summary: (s: Obj) => (sub(s, "files")["photos/ph-a-desktop.png"] = "d".repeat(64)) }, /PAGE_PHOTOS_NOT_THE_SWAP_COPY/],
    ["another shop's summary", { summary: (s: Obj) => (s.shop = "tsugute") }, /SUMMARY_NOT_RIN/],
    ["a rights file of another shape", { rights: (r: Obj) => (r.schema = "photo_swap_rights_private_v1") }, /RIGHTS_FILE_INVALID/],
  ])("fails closed: %s", async (_, mutate, code) => {
    const f = await fixture(mutate);
    await expect(prepare(f)).rejects.toThrow(code);
  });

  it("an expired record and a forbidden (success-case) hash are refused, as the swap refuses them", async () => {
    const expired = await fixture({ rights: (r) => (recOf(r, 0).expiry = "2026-11-10") });
    await expect(prepare(expired)).rejects.toThrow(/RIGHTS_EXPIRED/);
    const f = await fixture();
    const first = recOf(f.rights, 0).sha256 as string;
    await expect(prepareSwap({ page: readSwapPage(f.page), rights: f.rights, summary: f.summary, originals: readOriginals(f.originals), forbiddenSha256: new Set([first]), now: NOW })).rejects.toThrow(/FORBIDDEN_SOURCE_HASH/);
  });

  it("refuses a photo the HTML does not use, an unexpected file and a link in the copy", async () => {
    const f = await fixture();
    writeFileSync(join(f.page, "photos", "ph-z-desktop.png"), await png(4, 4, 1));
    await expect(prepare(f)).rejects.toThrow(/PHOTO_NOT_REFERENCED/);
    const g = await fixture();
    writeFileSync(join(g.page, "photos", "notes.txt"), "x");
    expect(() => readSwapPage(g.page)).toThrow(/PAGE_PHOTO_UNEXPECTED/);
    const h = await fixture();
    rmSync(join(h.page, "style.css"));
    symlinkSync(join(REPO, PAGE, "style.css"), join(h.page, "style.css"));
    expect(() => readSwapPage(h.page)).toThrow(SwapInputError);
  });

  it("a large photo goes lossy at the highest quality that fits, and the record says so", async () => {
    const f = await fixture();
    writeFileSync(join(f.page, "photos", "ph-a-desktop.png"), await noise(200, 150));
    (f.summary.files as Record<string, string>)["photos/ph-a-desktop.png"] = sha(readFileSync(join(f.page, "photos", "ph-a-desktop.png")));
    writeFileSync(f.summaryPath, JSON.stringify(f.summary));
    const p = await prepare(f, 30_000);
    const c = p.conversions.find((x) => x.stored === "photos/ph_a-desktop.webp")!;
    expect(c.mode).toBe("lossy");
    expect(c.webp_bytes).toBeLessThanOrEqual(30_000);
    expect(p.conversions.filter((x) => x.mode === "lossless")).toHaveLength(14);
  });
});

describe("the stored copy renders with its WebP photos (renderPrototype, JavaScript off, network blocked)", () => {
  it("every PC and SP photo is shown, nothing outside the copy is requested, and the pixels equal the swap copy's", async () => {
    const f = await fixture();
    const p = await prepare(f);
    const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
    try {
      const r = await renderPrototype(browser, { html: p.html, css: p.css }, new Map([...p.photos].map(([k, v]) => [k, Buffer.from(v)])), []);
      expect(r.desktop_1440.blocked).toBe(0);
      expect(r.mobile_390.blocked).toBe(0);
      for (const s of INV.slots) {
        expect(r.desktop_1440.assets[`photos/${s.slot_id.replace(/-/g, "_")}-desktop.webp`]?.shown, s.slot_id).toBe(true);
        // the renderer's measure matches <img src> (the desktop file); at 390 the <source> picks the mobile file, which the
        // pixel comparison below covers
        expect(r.mobile_390.assets[`photos/${s.slot_id.replace(/-/g, "_")}-desktop.webp`]?.shown, s.slot_id).toBe(true);
      }
      // the swap's own copy (PNG photos, the original URLs) draws exactly the same pixels: the WebP photos decode to the
      // same pictures (lossless) and the rewrite changed nothing else
      const page = readSwapPage(f.page);
      const swapRender = await renderPrototype(browser, { html: page.html, css: page.css }, page.photos, []);
      for (const v of ["desktop_1440", "mobile_390"] as const) expect(await pixelDiff(r[v].png, swapRender[v].png), v).toMatchObject({ same_size: true, differing_pixels: 0 });
      // and the comparison is not vacuous: without the photos the page draws differently
      const bare = await renderPrototype(browser, { html: p.html, css: p.css }, new Map(), []);
      expect((await pixelDiff(r.desktop_1440.png, bare.desktop_1440.png)).differing_pixels).toBeGreaterThan(0);
      expect((await pixelDiff(r.mobile_390.png, bare.mobile_390.png)).differing_pixels).toBeGreaterThan(0);
    } finally {
      await browser.close();
    }
  }, 60_000);
});

describe("package-local.ts --page (the operator's command, on the synthetic swap)", () => {
  const cli = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", join(REPO, "scripts/sales/demo-version/package-local.ts"), ...args], { cwd: REPO, encoding: "utf8", env: process.env, timeout: 120_000 });
  it("writes a verified package with photos, prints hashes / modes / the proof / the comparison only; the inputs are unchanged", async () => {
    const f = await fixture();
    const renders = join(f.root, "swap", "renders");
    mkdirSync(renders);
    writeFileSync(join(renders, "desktop_1440.png"), await png(1440, 900, 5));
    const before = readFileSync(f.rightsPath);
    const out = join(newDir(), "pkg");
    const r = cli(["--out", out, "--page", f.page, "--rights", f.rightsPath, "--originals", f.originals, "--compare-renders", renders]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const o = JSON.parse(r.stdout);
    expect(o).toMatchObject({ status: "OK", source: "swap-copy", rights_summary: { photos: 15, by_status: { ai_demo_internal: 15 } } });
    expect(o.photos).toHaveLength(15);
    expect(o.rewrite_proof.html.refs).toBe(15);
    expect(o.compare.desktop_1440).toMatchObject({ ours: { width: 1440 }, research: { width: 1440, height: 900 } });
    expect(o.compare.mobile_390).toBeUndefined();
    // nothing private on stdout
    for (const word of ["fixture owner", "fixture-consent", ".intake", "fixture-gen", "fixture generator", f.root]) expect(r.stdout).not.toContain(word);
    expect(readPackage(out).images).toHaveLength(15);
    expect(Buffer.compare(readFileSync(f.rightsPath), before)).toBe(0);
  }, 120_000);
  it("refuses a usage without the rights or the originals, and --page with --source (exit 2)", () => {
    for (const args of [["--out", "/tmp/x", "--page", "/tmp/p"], ["--out", "/tmp/x", "--page", "/tmp/p", "--rights", "/tmp/r"], ["--out", "/tmp/x", "--page", "/tmp/p", "--rights", "/tmp/r", "--originals", "/tmp/o", "--source", PAGE], ["--out", "/tmp/x", "--rights", "/tmp/r"]]) expect(cli(args).status, args.join(" ")).toBe(2);
  });
  it("a refused rights file is a FAIL with its code (exit 1), and no package is written", async () => {
    const f = await fixture({ rights: (r) => (sub(recOf(r, 1), "allowed_uses").public_web = true) });
    const out = join(newDir(), "pkg");
    const r = cli(["--out", out, "--page", f.page, "--rights", f.rightsPath, "--originals", f.originals]);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ status: "FAIL", code: "PUBLIC_WEB_NOT_FALSE" });
    expect(() => readFileSync(join(out, "package.json"))).toThrow();
  }, 60_000);
});

describe("importPackage: AI demo pictures only into the fictional 輪 (RIN_PROSPECT_ID)", () => {
  const store: PackageStore = {
    download: async () => null,
    upload: async () => {
      throw new Error("must not upload");
    },
  };
  const client = (prospectId: string, calls: string[]) =>
    ({
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { prospect_id: prospectId }, error: null }) }) }) }),
      rpc: async (name: string) => {
        calls.push(name);
        return { data: null, error: { message: "stop" } };
      },
    }) as never;

  it("refuses a photo package for any other prospect before the ingest is called", async () => {
    const f = await fixture();
    const p = await prepare(f);
    const pkg = await buildPackage({ html: p.html, css: p.css, renders: { desktop_1440: await png(1440, 900, 3), mobile_390: await png(390, 844, 4) }, photos: p.photos, images: p.images, source: "swap-copy" });
    const calls: string[] = [];
    await expect(importPackage(pkg, { client: client("00000000-0000-4000-8000-000000000000", calls), store, demoId: "11111111-1111-4111-8111-111111111111" })).rejects.toThrow(new ImportError("AI_DEMO_NOT_ALLOWED"));
    expect(calls).toEqual([]);
    // 輪 itself reaches the ingest, with the images as p_images
    await expect(importPackage(pkg, { client: client(RIN_PROSPECT_ID, calls), store, demoId: "11111111-1111-4111-8111-111111111111" })).rejects.toThrow(/INGEST_REFUSED/);
    expect(calls).toEqual(["sales_ingest_demo_version"]);
  });
});

describe("pixelDiff", () => {
  it("counts differing pixels of same-size renders and reports sizes otherwise", async () => {
    const a = await png(20, 10, 50);
    expect(await pixelDiff(a, a)).toMatchObject({ same_size: true, differing_pixels: 0, ratio: 0, max_channel_delta: 0 });
    const b = await sharp(a).composite([{ input: await png(2, 5, 200), left: 0, top: 0 }]).png().toBuffer();
    expect(await pixelDiff(a, b)).toMatchObject({ same_size: true, differing_pixels: 10, ratio: 0.05 });
    expect(await pixelDiff(a, await png(20, 11, 50))).toMatchObject({ same_size: false, differing_pixels: null, ours: { width: 20, height: 10 }, research: { width: 20, height: 11 } });
  });
});
