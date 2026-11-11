import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import RenderPane from "@/components/admin/demo/RenderPane";
import { assertLocalSupabaseUrl, manualImportJobId } from "@/lib/demo-version-package/import";
import { buildPackage, downscaleRender, insideRepo, PackageError, readPackage, RENDER_SIDE_LIMIT, writePackage } from "@/lib/demo-version-package/package";
import { assertLocalDbUrl, rinDemoContent, type FactsPack } from "@/lib/demo-version-package/seed-rin";
import { scaledRenderNote } from "@/lib/sales/demo-version/admin-messages";
import { checkFileBytes, hasImageMetadata, validateManifest } from "@/lib/sales/demo-version/manifest";

// DEV-196r (option C): packaging SR-001「輪」 (d1-v9) as a demo version — downscaling to the server's 4096 px limit
// (never loosened), the manifest and the same server checks, deterministic output, writing outside the repository,
// re-verification, and the import's local-only rules. Renders here are synthetic PNGs of the real full-page sizes.

const RIN = "design-library/research/quality-pipeline/poc/bicycle/fidelity/d1-v9";
const html = readFileSync(`${RIN}/index.html`, "utf8");
const css = readFileSync(`${RIN}/style.css`, "utf8");
const png = (width: number, height: number, c = 128) => sharp({ create: { width, height, channels: 3, background: { r: c, g: 200 - (c % 100), b: 90 } } }).png().toBuffer();
const tmp: string[] = [];
const outDir = () => {
  const d = mkdtempSync(join(tmpdir(), "rin-pkg-"));
  tmp.push(d);
  return d;
};
afterAll(() => tmp.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("downscaleRender: the 4096 px limit is kept, proportionally, with no metadata", () => {
  it("the real 輪 sizes: PC 1440×5352 → 1102×4096, SP 390×5586 → 286×4096; a short page is not touched", async () => {
    const pc = await downscaleRender(await png(1440, 5352));
    expect([pc.width, pc.height]).toEqual([1102, 4096]);
    expect([pc.original.width, pc.original.height]).toEqual([1440, 5352]);
    const sp = await downscaleRender(await png(390, 5586));
    expect([sp.width, sp.height]).toEqual([286, 4096]);
    const short = await downscaleRender(await png(390, 2000));
    expect([short.width, short.height]).toEqual([390, 2000]);
    for (const r of [pc, sp, short]) {
      expect(Math.max(r.width, r.height)).toBeLessThanOrEqual(RENDER_SIDE_LIMIT);
      expect(hasImageMetadata(r.webp)).toBe(false);
      const meta = await sharp(Buffer.from(r.webp)).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(["webp", r.width, r.height]);
    }
  });
  it("refuses something that is not a PNG", async () => {
    await expect(downscaleRender(new TextEncoder().encode("not a png"))).rejects.toThrow();
  });
});

describe("buildPackage: the manifest and the server's own checks", () => {
  it("the real 輪 page passes checkArtifactHtml, validateManifest and checkFileBytes; worker_checks keeps the originals", async () => {
    const pkg = await buildPackage({ html, css, renders: { desktop_1440: await png(1440, 5352), mobile_390: await png(390, 5586) }, source: RIN, validatorCommit: "abcdef1" });
    expect(pkg.manifest.files.map((f) => f.name)).toEqual(["page/index.html", "page/style.css", "renders/desktop_1440.webp", "renders/mobile_390.webp"]);
    expect(validateManifest(pkg.manifest).ok).toBe(true);
    for (const f of pkg.manifest.files) expect(checkFileBytes(f, pkg.files[f.name]!), f.name).toEqual({ ok: true });
    const desktop = pkg.manifest.files.find((f) => f.name === "renders/desktop_1440.webp")!;
    expect([desktop.width, desktop.height]).toEqual([1102, 4096]);
    const originals = (pkg.workerChecks as { originals: Record<string, { width: number; height: number; scaled: boolean; sha256: string }> }).originals;
    expect(originals.desktop_1440).toMatchObject({ width: 1440, height: 5352, scaled: true });
    expect(originals.mobile_390).toMatchObject({ width: 390, height: 5586, scaled: true });
    expect(Buffer.byteLength(JSON.stringify(pkg.workerChecks))).toBeLessThan(2048);
    expect(JSON.stringify(pkg)).not.toMatch(/model/i);
  });
  it("deterministic: the same input gives the same bytes, manifest and bundle", async () => {
    const renders = { desktop_1440: await png(1440, 5352, 40), mobile_390: await png(390, 5586, 41) };
    const a = await buildPackage({ html, css, renders, source: RIN });
    const b = await buildPackage({ html, css, renders, source: RIN });
    expect(a.bundleSha256).toBe(b.bundleSha256);
    expect(a.manifest).toEqual(b.manifest);
    for (const name of Object.keys(a.files)) expect(Buffer.compare(Buffer.from(a.files[name]!), Buffer.from(b.files[name]!)), name).toBe(0);
  });
  it("a page the server would refuse is refused here (never loosened): script, outside URL; a missing render", async () => {
    const renders = { desktop_1440: await png(1440, 900), mobile_390: await png(390, 900) };
    await expect(buildPackage({ html: html.replace("</body>", "<script>x()</script></body>"), css, renders, source: RIN })).rejects.toMatchObject({ code: "HTML_CHECK_FAILED" });
    await expect(buildPackage({ html: html.replace("</body>", '<img src="https://example.com/x.png" alt=""></body>'), css, renders, source: RIN })).rejects.toBeInstanceOf(PackageError);
    await expect(buildPackage({ html, css, renders: { desktop_1440: renders.desktop_1440 }, source: RIN })).rejects.toMatchObject({ code: "RENDER_MISSING" });
  });
});

describe("writePackage / readPackage", () => {
  it("writes outside the repository only; reads back and verifies again; a tampered file is refused", async () => {
    const pkg = await buildPackage({ html, css, renders: { desktop_1440: await png(1440, 1200), mobile_390: await png(390, 1500) }, source: RIN });
    expect(() => writePackage(join(process.cwd(), "tmp-rin-package"), pkg)).toThrow("OUT_INSIDE_REPOSITORY");
    expect(insideRepo(process.cwd())).toBe(true);
    expect(insideRepo(tmpdir())).toBe(false);
    const dir = outDir();
    writePackage(dir, pkg);
    const back = readPackage(dir);
    expect(back.bundleSha256).toBe(pkg.bundleSha256);
    writeFileSync(join(dir, "page/style.css"), `${css}\n/* changed */`);
    expect(() => readPackage(dir)).toThrow(/FILE_CHECK_FAILED/);
    expect(() => readPackage(outDir())).toThrow("PACKAGE_UNREADABLE");
  });
});

describe("the import's rules (no network here)", () => {
  it("only a local Supabase URL / database URL; anything else is refused", () => {
    for (const ok of ["http://127.0.0.1:56421", "http://localhost:54321"]) expect(assertLocalSupabaseUrl(ok)).toBe(ok);
    for (const bad of ["https://abc.supabase.co", "http://10.0.0.5:54321", "https://127.0.0.1:54321", "http://127.0.0.1.example.com", "http://user:pw@127.0.0.1:1", "", undefined]) {
      expect(() => assertLocalSupabaseUrl(bad), String(bad)).toThrow(/SUPABASE_URL/);
    }
    expect(assertLocalDbUrl("postgresql://postgres:postgres@127.0.0.1:56422/postgres")).toContain("127.0.0.1");
    for (const bad of ["postgresql://u:p@db.abc.supabase.co:5432/postgres", "postgres://u@10.1.1.1/x", "mysql://127.0.0.1/x"]) expect(() => assertLocalDbUrl(bad), bad).toThrow(/DB_URL/);
  });
  it("the job id is derived from the bundle (a re-run replays the same version)", () => {
    const b = "a".repeat(64);
    expect(manualImportJobId(b)).toBe(`manual-import-${"a".repeat(48)}`);
    expect(manualImportJobId(b)).toMatch(/^[a-z0-9][a-z0-9-]{2,62}$/);
    expect(() => manualImportJobId("x")).toThrow("BUNDLE_INVALID");
  });
  it("the fictional 輪 shop's content is SR-001's facts pack (every fact, no real data)", () => {
    const pack = JSON.parse(readFileSync("design-library/research/quality-pipeline/poc/bicycle/facts-pack.json", "utf8")) as FactsPack;
    const c = rinDemoContent(pack);
    expect(c).toMatchObject({ name: "架空自転車修理 輪", category: "bicycle_repair", hours: "9:00〜18:00", phone: "000-0000-0236" });
    expect(c.menu_items).toEqual(["パンク修理", "ブレーキ調整", "チェーン交換", "車輪の振れ取り"]);
    expect(() => rinDemoContent({ ...pack, shop_id: "real-shop" })).toThrow("FACTS_PACK_NOT_RIN");
  });
});

describe("RenderPane: a downscaled render says so and offers no 'actual size'", () => {
  it("the note's percentage is width / viewport; no note at the viewport's width", () => {
    expect(scaledRenderNote(1102, 1440)).toBe("縮小表示（実寸の約77%）。実寸は「生の頁」タブで確認できます。");
    expect(scaledRenderNote(286, 390)).toBe("縮小表示（実寸の約73%）。実寸は「生の頁」タブで確認できます。");
    expect(scaledRenderNote(1440, 1440)).toBeNull();
    expect(scaledRenderNote(0, 1440)).toBeNull();
  });
  it("markup: the scaled PC has the note and no 実寸で見る; an unscaled PC keeps the toggle and no note", () => {
    const scaled = renderToStaticMarkup(
      <RenderPane
        renders={[
          { viewport: "desktop_1440", src: "/demo-frame/a/T/renders/desktop_1440.webp", width: 1102, height: 4096 },
          { viewport: "mobile_390", src: "/demo-frame/a/T/renders/mobile_390.webp", width: 286, height: 4096 },
        ]}
      />,
    );
    expect(scaled).toContain('data-scaled-note="desktop_1440"');
    expect(scaled).toContain("実寸の約77%");
    expect(scaled).toContain('data-scaled-note="mobile_390"');
    expect(scaled).toContain("実寸の約73%");
    expect(scaled).not.toContain("実寸で見る");
    const plain = renderToStaticMarkup(<RenderPane renders={[{ viewport: "desktop_1440", src: "/x.webp", width: 1440, height: 4000 }]} />);
    expect(plain).toContain("実寸で見る");
    expect(plain).not.toContain("data-scaled-note");
  });
});
