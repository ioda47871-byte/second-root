import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildSite } from "@/experiments/pages-cms/build";
import { checkSveltiaBackend, exportDelivery } from "@/experiments/pages-cms/export-delivery";
import { Q1_TODAY, writeFixture } from "@/experiments/pages-cms/fixtures";
import { pagesConfig } from "@/experiments/pages-cms/pages-config";
import { AUTO_SITE } from "@/experiments/pages-cms/shop-site";
import { SVELTIA_SCRIPT, SVELTIA_TRANSFORM, SVELTIA_VERSION, sveltiaAdminHtml, sveltiaConfig, sveltiaCsp, sveltiaYaml } from "@/experiments/pages-cms/sveltia-config";
import { autoSiteWithDesign, writeSyntheticDesign } from "./synthetic-design";

// Issue #380 (2026-11-28): the Sveltia CMS PoC beside Pages CMS (hosted Pages CMS refuses phone photos over ~3.3 MB).
// LOCAL only: no sign-in, no account, nothing pushed. A Chromium run of the pinned Sveltia build against this config
// is recorded in the PR (boot + an upload through the browser-storage test backend); these tests pin what we generate
// and what the build accepts.

const temps: string[] = [];
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "sr-pcms-sveltia-")));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
const DESIGN = join(tmp(), "design");
writeSyntheticDesign(DESIGN);
const AUTO = autoSiteWithDesign(DESIGN);
const schema = { extensions: AUTO_SITE.profile.extensions, collections: AUTO_SITE.profile.collections };
type F = { name: string; widget: string; required?: boolean; fields?: F[]; field?: F; options?: { value: string }[]; default?: unknown; [k: string]: unknown };

describe("admin/config.yml is generated from the same schema as .pages.yml", () => {
  it("same collections and fields, in the same order; Pages CMS's optional fields are required: false (Sveltia's default is true)", () => {
    const s = sveltiaConfig(schema);
    const p = pagesConfig(schema);
    expect(s.collections.map((c) => c.name)).toEqual(p.content.map((c) => c.name));
    for (const c of p.content) {
      const sc = s.collections.find((x) => x.name === c.name)! as unknown as { fields?: F[]; files?: { file: string; fields: F[] }[]; folder?: string };
      const fields = sc.fields ?? sc.files![0]!.fields;
      expect(fields.map((f) => f.name), c.name).toEqual((c.fields as { name: string }[]).map((f) => f.name));
      if (c.type === "file") expect(sc.files![0]!.file).toBe(c.path);
      else expect(sc.folder).toBe(c.path);
    }
    const works = (s.collections.find((c) => c.name === "works") as unknown as { fields: F[]; slug: string; format: string }).fields;
    const by = (n: string) => works.find((f) => f.name === n)!;
    expect([by("id").widget, by("vehicle").required, by("description").required, by("visible").required, by("displayOrder").required]).toEqual(["uuid", undefined, false, false, false]);
    const photos = by("photos");
    expect([photos.widget, photos.required, photos.min, photos.max, photos.summary]).toEqual(["list", true, 1, 4, "{{role}} {{imageAlt}}"]);
    const role = photos.fields!.find((f) => f.name === "role")!;
    // a select with a default is required (an optional one offers "(None)", which the content model refuses)
    expect([role.widget, role.required, role.default, role.options!.map((o) => o.value)]).toEqual(["select", undefined, "other", ["other", "before", "after"]]);
    const image = photos.fields!.find((f) => f.name === "image")!;
    expect([image.widget, image.accept, image.choose_url]).toEqual(["image", ".jpg,.jpeg,.png,.webp,.heic,.heif", false]);
    // PR #396 review L2: the file name is the id ({id}.json, as Pages CMS names it) — checked with Sveltia 5.0.3's test backend
    expect((s.collections.find((c) => c.name === "works") as unknown as { slug: string }).slug).toBe("{{fields.id}}");
  });

  it("the in-browser image transformation, media folders, data output and backend", () => {
    const s = sveltiaConfig(schema, { repo: "fictional-owner/sr-cms-trial-autocare", branch: "main" });
    expect(s.media_libraries).toEqual({ all: { slugify_filename: true, transformations: { raster_image: { format: "webp", quality: 85, width: 2560, height: 2560 } } } });
    expect(SVELTIA_TRANSFORM).toEqual({ format: "webp", quality: 85, width: 2560, height: 2560 });
    expect([s.media_folder, s.public_folder]).toEqual(["/media", "/media"]);
    expect(s.output).toEqual({ omit_empty_optional_fields: true, json: { indent_style: "space", indent_size: 2 } });
    expect(s.backend).toEqual({ name: "github", repo: "fictional-owner/sr-cms-trial-autocare", branch: "main" });
    // with Sveltia CMS Additions (username / password on the customer's Worker)
    expect(sveltiaConfig(schema, { repo: "o/r", auth_type: "additions", base_url: "https://auth.example.workers.dev" }).backend).toEqual({ name: "github", repo: "o/r", branch: "main", auth_type: "additions", base_url: "https://auth.example.workers.dev" });
    const news = (s.collections.find((c) => c.name === "news") as unknown as { fields: F[] }).fields;
    expect(news.find((f) => f.name === "publishedAt")).toMatchObject({ widget: "datetime", type: "date", format: "YYYY-MM-DD", input_timezone: "utc" });
    const yml = sveltiaYaml(schema);
    expect(yml.startsWith("# Generated from the content model")).toBe(true);
    expect(yml).not.toMatch(/generated-materials|provenance|photo-slots|sr-origin|design\//);
  });
});

describe("the export: the Sveltia admin page only when asked for", () => {
  it("--sveltia writes admin/index.html (the pinned script) and the generated admin/config.yml, and records the backend; without it nothing changes", async () => {
    const design = { designDir: DESIGN, testOnlyDesignRecordDir: DESIGN };
    const backend = { repo: "fictional-owner/sr-cms-trial-autocare", branch: "main" };
    const out = join(tmp(), "with");
    const files = await exportDelivery({ outDir: out, ...design, sveltia: backend });
    expect(files).toContain("admin/index.html");
    expect(readFileSync(join(out, "admin", "config.yml"), "utf8")).toBe(sveltiaYaml(schema, backend));
    expect(JSON.parse(readFileSync(join(out, "site.config.json"), "utf8"))).toEqual({ site: "auto", sveltia: backend });
    const html = readFileSync(join(out, "admin", "index.html"), "utf8");
    expect(html).toBe(sveltiaAdminHtml(backend));
    expect([...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1])).toEqual([`https://unpkg.com/@sveltia/cms@${SVELTIA_VERSION}/dist/sveltia-cms.js`]);
    expect(html).not.toMatch(/type="module"/);
    // PR #396 review L1: SRI of the exact 5.0.3 bytes and a CSP
    expect(html).toContain(`integrity="${SVELTIA_SCRIPT.integrity}" crossorigin="anonymous"`);
    expect(SVELTIA_SCRIPT.integrity).toBe("sha384-ClP/ghDk7neSgL1qoZLiFf9Bxy24cvfZCdBQXkRLIze2L9C/kU4cETbaYOlKj5O7");
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${sveltiaCsp(backend)}" />`);
    const without = await exportDelivery({ outDir: join(tmp(), "without"), ...design });
    expect(without.some((f) => f.startsWith("admin/"))).toBe(false);
  });
});

describe("the build accepts content exactly as Sveltia saves it", () => {
  // the entry Sveltia 5.0.3 wrote in the Chromium run (test backend): a random-UUID file name with its own UUID id,
  // empty optional fields omitted, the photo converted to WebP and slugified
  const SVELTIA_ENTRY = {
    id: "a5829957-8409-4800-9468-56bae1f39ed5",
    vehicle: "架空車 Sveltia 試験",
    service: "カーラッピング",
    photos: [{ image: "/media/img_4001.webp", role: "other" }],
    visible: true,
    displayOrder: 0,
  };
  /** A WebP header (VP8X) of the converted size, padded (the photo checks read the header and the byte count). */
  const webp = (w: number, h: number, bytes = 945_890) => {
    const b = Buffer.alloc(bytes);
    b.write("RIFF", 0, "latin1");
    b.writeUInt32LE(bytes - 8, 4);
    b.write("WEBPVP8X", 8, "latin1");
    b.writeUInt32LE(10, 16);
    b.writeUIntLE(w - 1, 24, 3);
    b.writeUIntLE(h - 1, 27, 3);
    return b;
  };

  it("a WebP photo under a random-UUID file name whose id differs, empty optionals omitted — built and published, class C", async () => {
    const repo = join(tmp(), "repo");
    await writeFixture(repo, AUTO_SITE.fixtures()["works-3"]!);
    writeFileSync(join(repo, "media", "img_4001.webp"), webp(1920, 2560));
    writeFileSync(join(repo, "content", "works", "d1a9eb8c-2e01-4c9f-bed9-7387bf88f507.json"), `${JSON.stringify(SVELTIA_ENTRY, null, 2)}\n`);
    const r = await buildSite({ repo, outDir: join(tmp(), "dist"), today: Q1_TODAY, site: AUTO });
    expect(r.html).toContain("<h3>架空車 Sveltia 試験</h3>");
    expect(r.media).toContain("img_4001.webp");
    expect(r.provenance.find((p) => p.file === "img_4001.webp")).toMatchObject({ class: "C" });
    // the shop page never links to the admin page (Q1's no-outside-request rule stays as it is for the shop page)
    expect(r.html).not.toMatch(/admin/);
  });

  it("the other shapes Sveltia may write: empty strings and empty lists (output without omission), a date-only news entry", async () => {
    const repo = join(tmp(), "repo");
    await writeFixture(repo, AUTO_SITE.fixtures()["works-3"]!);
    writeFileSync(join(repo, "media", "img_4001.webp"), webp(1920, 2560));
    writeFileSync(join(repo, "content", "works", "e0000000-0000-4000-8000-000000000001.json"), JSON.stringify({ ...SVELTIA_ENTRY, id: "e0000000-0000-4000-8000-000000000001", description: "", photos: [{ image: "/media/img_4001.webp", imageAlt: "", role: "after" }] }));
    writeFileSync(join(repo, "content", "news", "e0000000-0000-4000-8000-000000000002.json"), JSON.stringify({ id: "e0000000-0000-4000-8000-000000000002", title: "Sveltia の試験", body: "", publishedAt: "2026-11-28", visible: true }));
    const shop = JSON.parse(readFileSync(join(repo, "content", "shop.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(repo, "content", "shop.json"), JSON.stringify({ ...shop, hoursNote: "", specialClosures: [] }));
    const r = await buildSite({ repo, outDir: join(tmp(), "dist"), today: Q1_TODAY, site: AUTO });
    expect(r.html).toContain("Sveltia の試験");
  });
});

describe("PR #396 review L1 / L3: the admin page's CSP, and the backend the export accepts", () => {
  it("the CSP holds Sveltia's documented base directives, worker-src blob:, the GitHub API, and the Additions Worker (https + wss) only when configured", () => {
    const csp = sveltiaCsp({ repo: "o/r" });
    for (const d of ["style-src 'self' 'unsafe-inline'", "font-src 'self' https://cdn.jsdelivr.net", "img-src 'self' blob: data:", "media-src blob:", "frame-src blob:", "script-src 'self' https://unpkg.com", "manifest-src blob:", "worker-src blob:"]) expect(csp, d).toContain(d);
    expect(csp).toMatch(/connect-src 'self' blob: data: https:\/\/unpkg\.com https:\/\/api\.github\.com https:\/\/www\.githubstatus\.com(;|$)/);
    const withAdditions = sveltiaCsp({ repo: "o/r", auth_type: "additions", base_url: "https://auth.example.workers.dev/x" });
    expect(withAdditions).toContain("https://auth.example.workers.dev wss://auth.example.workers.dev");
  });

  it("refuses an Additions URL that is not https:, a malformed repo or branch", () => {
    expect(() => checkSveltiaBackend({ repo: "sr-cms-trial/sr-cms-trial-autocare", branch: "main" })).not.toThrow();
    expect(() => checkSveltiaBackend({ repo: "o/r", auth_type: "additions", base_url: "https://auth.example.workers.dev" })).not.toThrow();
    for (const bad of [
      { repo: "o/r", auth_type: "additions" as const, base_url: "http://auth.example.workers.dev" },
      { repo: "o/r", auth_type: "additions" as const, base_url: "javascript:alert(1)" },
      { repo: "o/r", auth_type: "additions" as const, base_url: "https://u:p@auth.example.workers.dev" },
      { repo: "o/r", base_url: "https://auth.example.workers.dev" },
      { repo: "not a repo" },
      { repo: "o/r", branch: "main; rm" },
    ])
      expect(() => checkSveltiaBackend(bad), JSON.stringify(bad)).toThrow(/EXPORT_SVELTIA_INVALID/);
  });
});
