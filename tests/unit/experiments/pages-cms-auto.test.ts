import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildSite, writePagesYaml } from "@/experiments/pages-cms/build";
import { ContentError, loadContent, WORK_PHOTO_MAX, worksOf } from "@/experiments/pages-cms/content-model";
import { generatedRecord, GENERATED_RECORD } from "@/experiments/pages-cms/photos";
import { provenanceDirOf, Q1_TODAY, solidPng, writeFixture } from "@/experiments/pages-cms/fixtures";
import { checkPagesConfig, pagesConfig, pagesYaml } from "@/experiments/pages-cms/pages-config";
import { factsOf } from "@/experiments/pages-cms/q1-render";
import { AUTO_SITE, BAKERY_SITE, CAFE_SITE } from "@/experiments/pages-cms/shop-site";
import { stageDesignPictures } from "@/experiments/pages-cms/design-pictures";
import { autoSiteWithDesign, writeSyntheticDesign } from "./synthetic-design";

// Issue #380 (owner 2026-11-27): a third fictional shop — a car-care shop whose customer updates its 施工実績 (works)
// and their photos in Pages CMS. FICTIONAL and LOCAL only (no GitHub, Cloudflare or Pages CMS; nothing uploaded). The
// PC 1440 / SP 390 look is experiments/pages-cms/q1-check.ts and q1-render.ts (every site's fixtures, this one included).

const temps: string[] = [];
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "sr-pcms-auto-")));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
const sha = (html: string, css: string) => createHash("sha256").update(html).update("\0").update(css).digest("hex");
const repoOf = async (site: typeof AUTO_SITE, name: string) => {
  const repo = join(tmp(), "repo");
  await writeFixture(repo, site.fixtures()[name]!);
  return repo;
};
// PR #390: the car-care site with SYNTHETIC design pictures and a test-only record (no picture is committed)
const DESIGN_DIR = join(tmp(), "design");
writeSyntheticDesign(DESIGN_DIR);
const AUTO = autoSiteWithDesign(DESIGN_DIR);
const build = (repo: string, site = AUTO, extra: Partial<Parameters<typeof buildSite>[0]> = {}) => buildSite({ repo, outDir: join(tmp(), "dist"), today: Q1_TODAY, site, ...extra });
const codeOf = (p: Promise<unknown>) => p.then(
  () => "ok",
  (e: unknown) => (e instanceof ContentError ? `${e.code} ${e.file.replace(/^.*\/content\//, "content/")}` : String(e)),
);
const workFile = (repo: string, id: string) => join(repo, "content", "works", `${id}.json`);
const editWork = (repo: string, id: string, change: (w: Record<string, unknown>) => Record<string, unknown>) =>
  writeFileSync(workFile(repo, id), JSON.stringify(change(JSON.parse(readFileSync(workFile(repo, id), "utf8")) as Record<string, unknown>)));

describe("Issue #380: the bakery and the café are unchanged by the works collection", () => {
  it("the café's output is byte-identical to before #380 (html + css per fixture; the bakery's is pinned in pages-cms.test.ts)", async () => {
    // recorded with the café build at 3e00e574 (origin/develop, before #380)
    const before: Record<string, string> = {
      "items-0": "0aaf736e4b4c357fc0a8c5b5bbb54c422db636c47d6315f3dd3f0c1b64e9ede1",
      "items-3": "f0d7cf5130467526b90b979f7fe536c45507a1ce9376364717596c6a0788c490",
      "items-10": "aaec1892383b05f10867429b46b7a4a9e3c30c0adf36a7a39fa1132d5c422eb0",
      "items-50": "685e7dfbfcb61f36123cd486fb6ca93ba56683a9e85676b0846070b5a05065ee",
      "long-text": "5e4d07b16a9fb8c083072c9d2071521df22fc3838e5be7e0af8c8afef5d50e45",
      "hidden-soldout-reorder": "bf4f193dd78879d6a262cb7c9f877f909f9f8c3944a8bc1c815ef18a97010708",
      "hours-closures": "75af1fe3533f5c2b85e31d5a2f4cf3936fe7f1caece04b2c729b65783d6c0c82",
      "news-1": "397417311adc936be32e142369cb66bd5033467a4fed99bc5ebfac4c9396ee28",
      "news-many": "6228c50c9d641bc21722f748779ad5fc6cdd0558541e500dd0a54325a82f45f3",
      "sizes-prices": "4674b78e2eec5779bcb2e42cbaeb69580e3aefd81e10856d550f9e50bf4b55de",
      "photos-large-odd": "3a1d1ad20fc1622205bb2f656dca3994b5db0ef53c8eb4715a0bcc1215783f64",
      "photo-slots": "1371263fa5fbf1eae09b64f5423cb75a7446075854bcbf1636aec094834d56ee",
    };
    const now: Record<string, string> = {};
    for (const name of Object.keys(before)) {
      const r = await build(await repoOf(CAFE_SITE, name), CAFE_SITE);
      now[name] = sha(r.html, r.css);
    }
    expect(now).toEqual(before);
  });

  it("a menu-only shop's content has no works key, its .pages.yml is the same with collections [menu] as without, and works content is refused there", async () => {
    const repo = await repoOf(BAKERY_SITE, "items-3");
    expect("works" in (await loadContent(repo, BAKERY_SITE.profile))).toBe(false);
    expect("works" in (await loadContent(repo))).toBe(false);
    for (const site of [BAKERY_SITE, CAFE_SITE]) expect(pagesYaml({ extensions: site.profile.extensions, collections: ["menu"] })).toBe(pagesYaml({ extensions: site.profile.extensions }));
    // a job left in a menu-only shop's repository would sit unseen: refused
    const autoRepo = await repoOf(AUTO_SITE, "works-3");
    cpSync(join(autoRepo, "content", "works"), join(repo, "content", "works"), { recursive: true });
    expect(await codeOf(build(repo, BAKERY_SITE))).toBe("CONTENT_EXTENSION_OFF works");
  });
});

describe("Issue #380: the car-care shop (施工実績) — its own composition, every fixture", () => {
  it("builds every fixture: one job card per shown work, one picture per shown photo, 施工前 / 施工後 labels, イメージ only on the static design pictures, no script or link", async () => {
    for (const name of Object.keys(AUTO_SITE.fixtures())) {
      const repo = await repoOf(AUTO_SITE, name);
      const r = await build(repo);
      const content = await loadContent(repo, AUTO_SITE.profile);
      const shown = worksOf(content);
      const count = (re: RegExp) => (r.html.match(re) ?? []).length;
      expect(r.html, name).not.toMatch(/<script|javascript:|https?:\/\//i);
      expect(r.html, name).toContain("架空のカーケア工房 そらいろ");
      expect(r.html, name).toContain("提案用デモ（架空の店）");
      // Issue #380 SORAIRO: the AI label is on the 3 static design pictures (hero, sample before / after) and the footer
      // note — never inside the customer's works list
      expect(count(/AI生成・架空の施工イメージ/g), name).toBe(5);
      const worksList = r.html.slice(r.html.indexOf('id="works"'), r.html.indexOf('id="sample"'));
      expect(worksList, name).not.toMatch(/イメージ|AI生成|design\//);
      expect(count(/<li class="job" data-q1="item">/g), name).toBe(shown.length);
      expect(count(/<img /g), name).toBe(shown.reduce((n, w) => n + w.photos.length, 0) + 3);
      expect(count(/<figcaption class="role"><span class="en">BEFORE<\/span> <b>施工前<\/b><\/figcaption>/g), name).toBe(shown.filter((w) => w.photos.some((p) => p.role === "before")).length);
      expect(count(/<figcaption class="role"><span class="en">AFTER<\/span> <b>施工後<\/b><\/figcaption>/g), name).toBe(shown.filter((w) => w.photos.some((p) => p.role === "after")).length);
      // a pair only when the job has both
      expect(count(/<div class="pair">/g), name).toBe(shown.filter((w) => w.photos.some((p) => p.role === "before") && w.photos.some((p) => p.role === "after")).length);
      // every shown photo was checked and copied; hidden jobs' photos were not
      expect(new Set(r.media), name).toEqual(new Set(shown.flatMap((w) => w.photos.map((p) => p.image.replace(/^\/media\//, "")))));
      // the customer's pictures are B or C; the only A pictures are the two recorded design materials
      expect(r.provenance.filter((p) => !p.file.startsWith("design/")).every((p) => p.class === "B" || p.class === "C"), name).toBe(true);
      expect(r.provenance.filter((p) => p.file.startsWith("design/")).map((p) => [p.file, p.class]), name).toEqual([
        ["design/sorairo-matte-black.jpg", "A"],
        ["design/sorairo-silver.jpg", "A"],
      ]);
      expect(r.design, name).toEqual(["sorairo-matte-black.jpg", "sorairo-silver.jpg"]);
    }
  });

  it("a different composition from the bakery and the café; the empty state; hidden and reordered jobs; long 車種 names escaped", async () => {
    const r = await build(await repoOf(AUTO_SITE, "works-3"));
    expect(r.html).toContain('<ol class="jobs">');
    // the SORAIRO design (owner 2026-11-28): notice line, brand header, hero, service bar, sample, service list, details
    for (const part of ['<div class="notice"', '<a class="brand"', '<section class="hero"', '<div class="bar">', '<section class="section sample" id="sample"', '<div class="service-list">', '<section class="section details"']) expect(r.html, part).toContain(part);
    expect(r.html).not.toMatch(/class="grid"|<aside class="side">|<ul class="list">/);
    expect(r.html).not.toContain('href="#menu"');
    for (const other of [BAKERY_SITE, CAFE_SITE]) expect(r.css).not.toBe((await build(await repoOf(other, "items-3"), other)).css);
    expect((await build(await repoOf(AUTO_SITE, "works-0"))).html).toContain('<p class="empty">施工実績は準備中です。</p>');
    // hidden-reorder: every 4th job hidden, display order reversed
    const hidden = await build(await repoOf(AUTO_SITE, "hidden-reorder"));
    const order = [...hidden.html.matchAll(/<h3>(架空車 タイプ\d+)<\/h3>/g)].map((m) => m[1]);
    expect(order).toEqual([10, 8, 7, 6, 4, 3, 2].map((k) => `架空車 タイプ${k}`));
    const long = await build(await repoOf(AUTO_SITE, "long-vehicle"));
    expect(long.html).toContain("<h3>架空自動車 グランドツーリングワゴン ハイブリッド 特別仕様車 二〇一九年式（試験用）</h3>");
    expect(long.html).toContain("<h3>Fictional-Motor-Grand-Touring-Wagon-Hybrid-Edition-X2019</h3>");
    expect(long.css).toContain("overflow-wrap:anywhere");
    // markup typed into a field is text
    const repo = await repoOf(AUTO_SITE, "works-3");
    editWork(repo, "job-1", (w) => ({ ...w, vehicle: '<img src=x onerror="alert(1)">', description: "<b>強調</b>" }));
    const escaped = await build(repo);
    expect(escaped.html).toContain("<h3>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</h3>");
    // (the design itself uses <b> in its fixed labels; the customer's text never becomes markup)
    expect(escaped.html).toContain("&lt;b&gt;強調&lt;/b&gt;");
    expect(escaped.html).not.toContain("<b>強調</b>");
  });

  it("photo-ratios: every allowed edge shape is checked as it is; the 3:1 / 1:3 strips and the largest pass", async () => {
    const r = await build(await repoOf(AUTO_SITE, "photo-ratios"));
    expect(r.photos.map((p) => [p.width, p.height]).sort()).toEqual(
      [
        [3600, 2400],
        [1200, 400],
        [400, 1200],
        [320, 320],
        [2000, 2000],
        [960, 340],
        [340, 960],
        [1600, 900],
      ].sort(),
    );
    expect(r.provenance.filter((p) => !p.file.startsWith("design/")).map((p) => p.class)).toEqual(Array(8).fill("C"));
  });

  it("B photos in a job need their rights record (private folder outside the repository), like a menu picture", async () => {
    const repo = await repoOf(AUTO_SITE, "works-10");
    const r = await build(repo, AUTO, { provenanceDir: provenanceDirOf(repo) });
    expect(r.provenance.filter((p) => p.class === "B").map((p) => p.file)).toEqual(["job-7-1.png"]);
    expect(r.provenance.find((p) => p.class === "B")!.record).toMatchObject({ class: "B", provided_by: "店主" });
    // without the index entry the job's B photo is refused
    rmSync(join(repo, "content", "photo-provenance.json"));
    expect(await codeOf(build(repo))).toBe("CONTENT_PHOTO_RIGHTS_MISSING job-7-1.png");
  });

  it("the customer's facts on the page include each shown job's 車種 and 施工種別 (the phone checks)", async () => {
    const content = await loadContent(await repoOf(AUTO_SITE, "hidden-reorder"), AUTO_SITE.profile);
    const { facts, truncated } = factsOf(content);
    expect(facts.slice(0, 3)).toEqual(["架空のカーケア工房 そらいろ", "架空県架空市7-8-9（試験用）", "03-0000-0002"]);
    expect(facts).toContain("架空車 タイプ2");
    expect(facts).not.toContain("架空車 タイプ1"); // hidden
    expect(truncated).toBe(0);
  });
});

describe("Issue #380: what the build refuses in a job (and keeps the last good output)", () => {
  it("the model: ≥1 photo, at most WORK_PHOTO_MAX, one 施工前 and one 施工後, no generated picture, no HEIC path, required 車種 / 施工種別", async () => {
    const photo = (n: number, extra: object = {}) => ({ image: `/media/job-1-${n}.png`, imageAlt: "", ...extra });
    const cases: [string, (w: Record<string, unknown>) => Record<string, unknown>][] = [
      ["no photo", (w) => ({ ...w, photos: [] })],
      ["too many photos", (w) => ({ ...w, photos: Array.from({ length: WORK_PHOTO_MAX + 1 }, (_, k) => photo(1 + (k % 1))) })],
      ["two 施工前", (w) => ({ ...w, photos: [photo(1, { role: "before" }), photo(1, { role: "before" })] })],
      ["a generated picture", (w) => ({ ...w, photos: [photo(1, { imageKind: "generated" })] })],
      ["a HEIC path", (w) => ({ ...w, photos: [{ image: "/media/IMG_0001.HEIC" }] })],
      ["an empty photo path", (w) => ({ ...w, photos: [{ image: "" }] })],
      ["an empty 車種", (w) => ({ ...w, vehicle: "  " })],
      ["a 車種 over 60", (w) => ({ ...w, vehicle: "車".repeat(61) })],
      ["no 施工種別", (w) => ({ ...w, service: undefined })],
      ["an unknown field", (w) => ({ ...w, price: "1,000円" })],
      ["an unknown role", (w) => ({ ...w, photos: [photo(1, { role: "during" })] })],
    ];
    for (const [what, change] of cases) {
      const repo = await repoOf(AUTO_SITE, "works-3");
      editWork(repo, "job-1", change);
      expect(await codeOf(build(repo)), what).toBe("CONTENT_INVALID content/works/job-1.json");
    }
    // the earlier value "shop" is read as the customer's photo (C), as for a menu item
    const repo = await repoOf(AUTO_SITE, "works-3");
    editWork(repo, "job-1", (w) => ({ ...w, photos: [photo(1, { imageKind: "shop" })] }));
    expect((await loadContent(repo, AUTO_SITE.profile)).works![0]!.photos[0]!.imageKind).toBe("customer_cms");
  });

  it("collections: a menu item or a category in the car-care shop is refused; duplicate ids and too many jobs too", async () => {
    const menuRepo = await repoOf(AUTO_SITE, "works-3");
    writeFileSync(join(menuRepo, "content", "categories", "x.json"), JSON.stringify({ id: "x", name: "分類" }));
    expect(await codeOf(build(menuRepo))).toBe("CONTENT_EXTENSION_OFF menu");
    const dup = await repoOf(AUTO_SITE, "works-3");
    writeFileSync(join(dup, "content", "works", "copy.json"), readFileSync(workFile(dup, "job-1")));
    expect(await codeOf(build(dup))).toBe("CONTENT_DUPLICATE_ID works");
    const many = await repoOf(AUTO_SITE, "works-0");
    for (let k = 0; k < 101; k++) writeFileSync(join(many, "content", "works", `w-${k}.json`), JSON.stringify({ id: `w-${k}`, vehicle: "架空車", service: "洗車", photos: [{ image: "/media/x.png" }] }));
    expect(await codeOf(build(many))).toMatch(/^CONTENT_TOO_MANY .*works$/);
  });

  it("a shown job's photo goes through every photo check; a hidden job's photo is not shown, so not checked", async () => {
    const withPhoto = async (name: string, bytes: Buffer | null, visible = true) => {
      const repo = await repoOf(AUTO_SITE, "works-3");
      if (bytes) writeFileSync(join(repo, "media", name), bytes);
      editWork(repo, "job-2", (w) => ({ ...w, visible, photos: [{ image: `/media/${name}` }] }));
      return codeOf(build(repo));
    };
    expect(await withPhoto("absent.jpg", null)).toBe("CONTENT_PHOTO_MISSING absent.jpg");
    expect(await withPhoto("fake.jpg", solidPng(800, 600, [1, 2, 3]))).toBe("CONTENT_PHOTO_TYPE fake.jpg");
    expect(await withPhoto("big.png", Buffer.concat([solidPng(800, 600, [1, 2, 3]), Buffer.alloc(2 * 1024 * 1024)]))).toBe("CONTENT_PHOTO_TOO_LARGE big.png");
    expect(await withPhoto("strip.png", solidPng(1500, 400, [1, 2, 3]))).toBe("CONTENT_PHOTO_RATIO strip.png");
    expect(await withPhoto("tiny.png", solidPng(300, 300, [1, 2, 3]))).toBe("CONTENT_PHOTO_TOO_SMALL tiny.png");
    expect(await withPhoto("strip.png", solidPng(1500, 400, [1, 2, 3]), false)).toBe("ok");
  });

  it("a delivered generated material cannot be shown as a job's photo (relabelled C), and Second Root's delivery build places no customer photo", async () => {
    const repo = await repoOf(AUTO_SITE, "works-3");
    const bytes = readFileSync(join(repo, "media", "job-2-1.png"));
    writeFileSync(join(repo, GENERATED_RECORD), JSON.stringify(generatedRecord({ "job-2-1.png": bytes })));
    expect(await codeOf(build(repo))).toBe("CONTENT_GENERATED_AS_SHOP works/job-2");
    const c = await repoOf(AUTO_SITE, "works-3");
    expect(await codeOf(build(c, AUTO, { delivery: true, provenanceDir: provenanceDirOf(c) }))).toBe("CONTENT_DELIVERY_CUSTOMER_PHOTO works/job-1");
  });

  it("broken input keeps the last good output: a failed build writes nothing, the earlier output stays byte-for-byte", async () => {
    const repo = await repoOf(AUTO_SITE, "works-10");
    const good = join(tmp(), "dist-good");
    await buildSite({ repo, outDir: good, today: Q1_TODAY, site: AUTO });
    const snapshot = () => Object.fromEntries(["index.html", "style.css", ...readdirSync(join(good, "media")).map((n) => `media/${n}`)].map((n) => [n, createHash("sha256").update(readFileSync(join(good, n))).digest("hex")]));
    const before = snapshot();
    const breaks: [string, () => void, string][] = [
      ["a half-saved JSON", () => writeFileSync(workFile(repo, "job-1"), '{"id":"job-1","vehicle":'), "CONTENT_INVALID content/works/job-1.json"],
      ["a photo over the limit", () => writeFileSync(join(repo, "media", "job-2-1.png"), Buffer.concat([solidPng(640, 480, [9, 9, 9]), Buffer.alloc(2 * 1024 * 1024)])), "CONTENT_PHOTO_TOO_LARGE job-2-1.png"],
      ["a photo deleted", () => rmSync(join(repo, "media", "job-3-1.png")), "CONTENT_PHOTO_MISSING job-3-1.png"],
    ];
    for (const [what, breakIt, code] of breaks) {
      const saved = new Map(readdirSync(join(repo, "content", "works")).map((n) => [n, readFileSync(join(repo, "content", "works", n))]));
      const savedMedia = new Map(readdirSync(join(repo, "media")).map((n) => [n, readFileSync(join(repo, "media", n))]));
      breakIt();
      const next = join(tmp(), "dist-next");
      expect(await codeOf(buildSite({ repo, outDir: next, today: Q1_TODAY, site: AUTO })), what).toBe(code);
      expect(existsSync(next), what).toBe(false);
      expect(snapshot(), what).toEqual(before);
      for (const [n, b] of saved) writeFileSync(join(repo, "content", "works", n), b);
      for (const [n, b] of savedMedia) writeFileSync(join(repo, "media", n), b);
    }
    // repaired: the build passes again with the same output
    const again = await buildSite({ repo, outDir: join(tmp(), "dist-again"), today: Q1_TODAY, site: AUTO });
    expect(again.html).toBe(readFileSync(join(good, "index.html"), "utf8"));
  });
});

describe("Issue #380: the car-care shop's .pages.yml (customer-editable fields only)", () => {
  it("the committed auto.pages.yml is exactly what the generator writes; it matches the documented keys", async () => {
    const yml = readFileSync(join(__dirname, "../../../experiments/pages-cms/auto.pages.yml"), "utf8");
    expect(yml).toBe(pagesYaml({ extensions: AUTO_SITE.profile.extensions, collections: AUTO_SITE.profile.collections }));
    const repo = await repoOf(AUTO_SITE, "works-3");
    expect(await writePagesYaml(repo, AUTO_SITE)).toBe(yml);
    expect(checkPagesConfig(pagesConfig({ collections: AUTO_SITE.profile.collections }))).toEqual([]);
  });

  it("works first, no menu or categories; a job's editable fields, 1 to WORK_PHOTO_MAX photos (labelled provisional); no class, record or build setting", () => {
    const config = pagesConfig({ extensions: AUTO_SITE.profile.extensions, collections: AUTO_SITE.profile.collections });
    expect(config.content.map((c) => c.name)).toEqual(["works", "shop", "news"]);
    const works = config.content[0]! as unknown as { path: string; fields: { name: string; type: string; readonly?: boolean; hidden?: boolean; list?: { min?: number; max?: number }; label: string; fields?: { name: string; type: string; required?: boolean }[] }[] };
    expect(works.path).toBe("content/works");
    expect(works.fields.map((f) => [f.name, f.type])).toEqual([
      ["id", "uuid"],
      ["vehicle", "string"],
      ["service", "string"],
      ["description", "text"],
      ["photos", "object"],
      ["visible", "boolean"],
      ["displayOrder", "number"],
    ]);
    const photos = works.fields.find((f) => f.name === "photos")!;
    expect(photos.list).toMatchObject({ min: 1, max: WORK_PHOTO_MAX });
    expect(photos.label).toContain("試行中");
    expect(photos.fields!.map((f) => [f.name, f.type])).toEqual([
      ["image", "image"],
      ["imageAlt", "string"],
      ["role", "select"],
    ]);
    expect(photos.fields!.find((f) => f.name === "image")!.required).toBe(true);
    const yml = pagesYaml({ extensions: AUTO_SITE.profile.extensions, collections: AUTO_SITE.profile.collections });
    // no class choice (a job's photo is the customer's; generated is refused), no record, no slot, no page code
    expect(yml).not.toMatch(/imageKind|generated|provenance|photo-slots|sr-origin|style\.css|index\.html|build/);
    expect(yml).not.toMatch(/name: "menu"|name: "categories"|soldOut|priceDisplay/);
    // the shop's name stays read-only
    expect(yml).toMatch(/- name: "name"\n\s+label: "店名（変更できません）"\n\s+type: "string"\n\s+readonly: true/);
  });
});

describe("Issue #380 SORAIRO (owner 2026-11-28): the static design pictures and what the build publishes", () => {
  const listDist = (dir: string, rel = ""): string[] =>
    readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listDist(dir, `${rel}${e.name}/`) : [`${rel}${e.name}`])).sort();

  it("the design record states the provenance honestly: the owner supplied them (made on the ChatGPT side), model and prompt unknown (null), received 2026-11-28, exact bytes", () => {
    const rec = JSON.parse(readFileSync(join(AUTO_SITE.design!.dir, "generated-materials.json"), "utf8")) as { schema: string; files: { file: string; sha256: string; source: unknown }[] };
    expect(rec.schema).toBe("generated_materials_v1");
    const source = { supplied_by: "owner", made_with: "ChatGPT (owner side)", model: null, prompt: null, received_on: "2026-11-28" };
    expect(rec.files).toEqual([
      { file: "sorairo-matte-black.jpg", sha256: "20c782e075b61523aa0a27c6419d5cdf01a3db7868c679f5341862a65d21152a", source },
      { file: "sorairo-silver.jpg", sha256: "4101af37221ab2ab5501e563c5af008d4468877fc79753e87610f437b10a7809", source },
    ]);
    // PR #390 (the repository's image lock): Second Root holds the record only — the pictures stay outside its git
    expect(readdirSync(AUTO_SITE.design!.dir)).toEqual(["generated-materials.json"]);
  });

  it("the build lists them as class A with that source, copies them to dist/design/, and nothing in .pages.yml can reach them", async () => {
    const r = await build(await repoOf(AUTO_SITE, "works-3"));
    const a = r.provenance.filter((p) => p.class === "A");
    expect(a.map((p) => [p.file, p.record, p.source?.model, p.source?.prompt, p.source?.received_on])).toEqual([
      ["design/sorairo-matte-black.jpg", null, null, null, "2026-11-28"],
      ["design/sorairo-silver.jpg", null, null, null, "2026-11-28"],
    ]);
    expect(r.html).toContain('<img src="design/sorairo-matte-black.jpg" alt="AI生成によるマットブラックの架空SUV"');
    expect(pagesYaml({ extensions: AUTO_SITE.profile.extensions, collections: AUTO_SITE.profile.collections })).not.toMatch(/design|sorairo|generated/);
  });

  it("refused: a design picture whose bytes are not the recorded ones, a missing record, a missing picture", async () => {
    const repo = await repoOf(AUTO_SITE, "works-3");
    const withDesign = (dir: string) => ({ ...AUTO_SITE, design: { ...AUTO_SITE.design!, dir } });
    const copy = () => {
      const d = join(tmp(), "design");
      cpSync(AUTO.design!.dir, d, { recursive: true });
      return d;
    };
    const changed = copy();
    writeFileSync(join(changed, "sorairo-silver.jpg"), Buffer.concat([readFileSync(join(changed, "sorairo-silver.jpg")), Buffer.from([0])]));
    expect(await codeOf(build(repo, withDesign(changed)))).toBe("CONTENT_GENERATED_RECORD_MISSING design/sorairo-silver.jpg");
    const noRecord = copy();
    rmSync(join(noRecord, "generated-materials.json"));
    expect(await codeOf(build(repo, withDesign(noRecord)))).toBe("CONTENT_GENERATED_RECORD_MISSING design/generated-materials.json");
    const noPicture = copy();
    rmSync(join(noPicture, "sorairo-matte-black.jpg"));
    expect(await codeOf(build(repo, withDesign(noPicture)))).toBe("CONTENT_PHOTO_MISSING design/sorairo-matte-black.jpg");
  });

  it("Identity Lock kept: a copy of a design picture uploaded as a job's photo is refused; the B index may not list one", async () => {
    const repo = await repoOf(AUTO_SITE, "works-3");
    writeFileSync(join(repo, "media", "IMG_9999.jpg"), readFileSync(join(AUTO.design!.dir, "sorairo-matte-black.jpg")));
    editWork(repo, "job-2", (w) => ({ ...w, photos: [{ image: "/media/IMG_9999.jpg", role: "after" }] }));
    expect(await codeOf(build(repo))).toBe("CONTENT_GENERATED_AS_SHOP works/job-2");
    const b = await repoOf(AUTO_SITE, "works-10");
    const index = JSON.parse(readFileSync(join(b, "content", "photo-provenance.json"), "utf8")) as { b: { sha256: string; record_sha256: string }[] };
    index.b.push({ sha256: createHash("sha256").update(readFileSync(join(AUTO.design!.dir, "sorairo-matte-black.jpg"))).digest("hex"), record_sha256: "0".repeat(64) });
    writeFileSync(join(b, "content", "photo-provenance.json"), JSON.stringify(index));
    expect(await codeOf(build(b))).toBe("CONTENT_PHOTO_CLASS_MIXED design material");
  });

  it("only referenced pictures are published: an unreferenced file in media/ (a test image) and a hidden job's photos never reach dist/", async () => {
    const repo = await repoOf(AUTO_SITE, "works-3");
    writeFileSync(join(repo, "media", "kenkyu-test.jpg"), readFileSync(join(AUTO.design!.dir, "sorairo-silver.jpg")));
    writeFileSync(join(repo, "media", "unused.png"), solidPng(640, 480, [5, 5, 5]));
    editWork(repo, "job-3", (w) => ({ ...w, visible: false }));
    const hiddenPhotos = (JSON.parse(readFileSync(workFile(repo, "job-3"), "utf8")) as { photos: { image: string }[] }).photos.map((p) => p.image.replace(/^\/media\//, ""));
    const out = join(tmp(), "dist");
    await buildSite({ repo, outDir: out, today: Q1_TODAY, site: AUTO });
    const shown = worksOf(await loadContent(repo, AUTO_SITE.profile)).flatMap((w) => w.photos.map((p) => `media/${p.image.replace(/^\/media\//, "")}`));
    expect(listDist(out)).toEqual(["design/sorairo-matte-black.jpg", "design/sorairo-silver.jpg", "index.html", ...shown, "style.css"].sort());
    for (const f of ["kenkyu-test.jpg", "unused.png", ...hiddenPhotos]) expect(listDist(out), f).not.toContain(`media/${f}`);
    const html = readFileSync(join(out, "index.html"), "utf8");
    for (const f of ["kenkyu-test.jpg", "unused.png", ...hiddenPhotos]) expect(html, f).not.toContain(f);
  });
});

describe("PR #390: the design pictures come from a folder outside Second Root, checked against the record", () => {
  it("Second Root alone cannot build the car-care site (no picture is committed): the build names the missing picture", async () => {
    expect(await codeOf(build(await repoOf(AUTO_SITE, "works-3"), AUTO_SITE))).toBe("CONTENT_PHOTO_MISSING design/sorairo-matte-black.jpg");
  });

  it("staged from an outside folder: found by SHA-256 whatever they are called there, built and published under the record's names", async () => {
    const outside = join(tmp(), "owner-folder");
    mkdirSync(outside);
    writeFileSync(join(outside, "matte-black.jpg"), readFileSync(join(DESIGN_DIR, "sorairo-matte-black.jpg")));
    writeFileSync(join(outside, "silver.jpg"), readFileSync(join(DESIGN_DIR, "sorairo-silver.jpg")));
    writeFileSync(join(outside, "design-preview.html"), "<!doctype html>");
    const recordOnly = join(tmp(), "record-only");
    mkdirSync(recordOnly);
    writeFileSync(join(recordOnly, "generated-materials.json"), readFileSync(join(DESIGN_DIR, "generated-materials.json")));
    const staged = await stageDesignPictures(autoSiteWithDesign(recordOnly), outside, join(tmp(), "staged"));
    expect(readdirSync(staged.design!.dir).sort()).toEqual(["generated-materials.json", "sorairo-matte-black.jpg", "sorairo-silver.jpg"]);
    const out = join(tmp(), "dist");
    const r = await buildSite({ repo: await repoOf(AUTO_SITE, "works-3"), outDir: out, today: Q1_TODAY, site: staged });
    expect(r.design).toEqual(["sorairo-matte-black.jpg", "sorairo-silver.jpg"]);
    expect(readFileSync(join(out, "design", "sorairo-silver.jpg")).equals(readFileSync(join(outside, "silver.jpg")))).toBe(true);
    // a picture missing from the folder, or with other bytes, and a missing folder are refused by name
    writeFileSync(join(outside, "silver.jpg"), Buffer.concat([readFileSync(join(outside, "silver.jpg")), Buffer.from([0])]));
    expect(await codeOf(stageDesignPictures(autoSiteWithDesign(recordOnly), outside, join(tmp(), "staged")))).toBe("CONTENT_PHOTO_MISSING design/sorairo-silver.jpg");
    expect(await codeOf(stageDesignPictures(autoSiteWithDesign(recordOnly), join(tmp(), "no-such-folder"), join(tmp(), "staged")))).toBe("CONTENT_PHOTO_MISSING design pictures folder");
    // a site without design is returned as it is
    expect(await stageDesignPictures(BAKERY_SITE, join(tmp(), "no-such-folder"), join(tmp(), "staged"))).toBe(BAKERY_SITE);
  });
});
