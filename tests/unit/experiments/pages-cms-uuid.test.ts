import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { autoEntryId } from "@/experiments/pages-cms/auto-fixtures";
import { buildSite } from "@/experiments/pages-cms/build";
import { Q1_TODAY, writeFixture } from "@/experiments/pages-cms/fixtures";
import { migrateIds } from "@/experiments/pages-cms/migrate-ids";
import { cmsSaveIssues } from "@/experiments/pages-cms/pages-cms-validate";
import { pagesConfig } from "@/experiments/pages-cms/pages-config";
import { AUTO_SITE, SHOP_SITES, type ShopSite } from "@/experiments/pages-cms/shop-site";
import { isUuid, uuidV5 } from "@/experiments/pages-cms/uuid";
import { autoSiteWithDesign, writeSyntheticDesign } from "./synthetic-design";

// Issue #380 live trial (2026-11-28): editing the pre-registered work 「架空車 タイプ1」 in Pages CMS failed with
// "Please fix the errors before saving." — its id `job-1` is not a UUID, Pages CMS validates the hidden uuid id field
// on save and shows that error nowhere (uuid.ts, pages-cms-validate.ts). LOCAL only; synthetic data.

const temps: string[] = [];
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "sr-pcms-uuid-")));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
const DESIGN = join(tmp(), "design");
writeSyntheticDesign(DESIGN);
const AUTO = autoSiteWithDesign(DESIGN);
const configOf = (site: ShopSite) => pagesConfig({ extensions: site.profile.extensions, ...(site.profile.collections ? { collections: site.profile.collections } : {}) });

/** Every fixture entry of every collection of a site, with the collection's fields. */
function entries(site: ShopSite) {
  const cfg = configOf(site);
  const out: { fixture: string; collection: string; entry: Record<string, unknown>; fields: unknown[] }[] = [];
  for (const [fixture, f] of Object.entries(site.fixtures()))
    for (const c of cfg.content) {
      const items: unknown[] = c.type === "file" ? [f.shop] : c.name === "works" ? (f.works ?? []) : c.name === "news" ? f.news : c.name === "menu" ? f.menu : c.name === "categories" ? f.categories : [];
      for (const entry of items) out.push({ fixture, collection: c.name, entry: entry as Record<string, unknown>, fields: c.fields });
    }
  return { out, media: cfg.media.extensions };
}

describe("uuid.ts: the ids Pages CMS's uuid field accepts", () => {
  it("version-5 UUIDs are RFC 4122 (a published vector) and deterministic; isUuid accepts UUIDs only", () => {
    expect(uuidV5("www.example.com", "6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe("2ed6657d-e927-568b-95e1-2665a8aea6a2");
    expect(uuidV5("works/job-1")).toBe(uuidV5("works/job-1"));
    expect(uuidV5("works/job-1")).not.toBe(uuidV5("news/job-1"));
    for (const ok of [randomUUID(), uuidV5("works/job-1"), "70c310e4-dc9a-4ed3-9e09-ca08aa54a1e3"]) expect(isUuid(ok), ok).toBe(true);
    for (const bad of ["job-1", "news-1", "", "70c310e4dc9a4ed39e09ca08aa54a1e3", "70c310e4-dc9a-4ed3-9e09-ca08aa54a1e"]) expect(isUuid(bad), bad).toBe(false);
  });
});

describe("the Pages CMS save reproduction over every fixture entry", () => {
  it("reproduces the trial's failure: a legacy job-1 entry has exactly one issue — the hidden id — and other kinds are caught too", () => {
    const works = configOf(AUTO_SITE).content.find((c) => c.name === "works")!;
    const legacy = { id: "job-1", vehicle: "架空車 タイプ1", service: "ガラスコーティング", description: "", photos: [{ image: "/media/job-1-1.png", imageAlt: "", role: "other", imageKind: "customer_cms" }], visible: true, displayOrder: 0 };
    expect(cmsSaveIssues(works.fields, legacy, ["png"])).toEqual([{ path: "id", message: "Invalid UUID format", hidden: true }]);
    expect(cmsSaveIssues(works.fields, { ...legacy, id: uuidV5("works/job-1") }, ["png"])).toEqual([]);
    // a missing id gets a new UUID (the field's default) — only a present non-UUID fails
    const { id: _id, ...noId } = legacy;
    expect(cmsSaveIssues(works.fields, noId, ["png"])).toEqual([]);
    const five = { ...legacy, id: uuidV5("x"), photos: Array.from({ length: 5 }, () => legacy.photos[0]!) };
    expect(cmsSaveIssues(works.fields, five, ["png"]).map((i) => i.message)).toEqual(["Array must contain at most 4 element(s)"]);
    expect(cmsSaveIssues(works.fields, { ...legacy, id: uuidV5("x"), photos: [{ ...legacy.photos[0]!, role: "during" }] }, ["png"]).map((i) => [i.path, i.message])).toEqual([["photos.0.role", "Invalid option"]]);
    expect(cmsSaveIssues(works.fields, { ...legacy, id: uuidV5("x"), vehicle: "" }, ["png"]).map((i) => [i.path, i.message])).toEqual([["vehicle", "This field is required"]]);
  });

  it("the car-care site: every fixture entry of works, news and the shop file saves unchanged in Pages CMS", () => {
    const { out, media } = entries(AUTO_SITE);
    expect(out.length).toBeGreaterThan(100);
    const issues = out.flatMap((e) => cmsSaveIssues(e.fields, e.entry, media).map((i) => `${e.fixture} ${e.collection} ${i.path} ${i.message}`));
    expect(issues).toEqual([]);
    for (const e of out.filter((x) => x.collection === "works" || x.collection === "news")) expect(isUuid(e.entry.id), `${e.fixture} ${e.collection}`).toBe(true);
  });

  it("the bakery and the café still carry the same latent issue (readable ids) plus an imageKind outside the select's options — recorded, NOT changed here (their output is pinned; Lead's decision)", () => {
    for (const site of SHOP_SITES.filter((s) => s.id !== "auto")) {
      const { out, media } = entries(site);
      const kinds = new Set(out.flatMap((e) => cmsSaveIssues(e.fields, e.entry, media).map((i) => `${e.collection} ${i.path} ${i.message}${i.hidden ? " (hidden)" : ""}`)));
      expect([...kinds].sort(), site.id).toEqual(["categories id Invalid UUID format (hidden)", "menu id Invalid UUID format (hidden)", "menu imageKind Invalid option", "news id Invalid UUID format (hidden)"]);
    }
  });
});

describe("the build keeps accepting legacy file names and ids, and UUID-named files", () => {
  it("a work in job-1.json with id job-1, one renamed to job-2.json with a UUID id, and UUID-named files all build", async () => {
    const repo = join(tmp(), "repo");
    await writeFixture(repo, AUTO_SITE.fixtures()["works-3"]!);
    const dir = join(repo, "content", "works");
    const first = join(dir, `${autoEntryId("works", "job-1")}.json`);
    writeFileSync(join(dir, "job-1.json"), JSON.stringify({ ...(JSON.parse(readFileSync(first, "utf8")) as object), id: "job-1" }));
    rmSync(first);
    renameSync(join(dir, `${autoEntryId("works", "job-2")}.json`), join(dir, "job-2.json"));
    expect(readdirSync(dir).sort()).toEqual(["job-1.json", "job-2.json", `${autoEntryId("works", "job-3")}.json`].sort());
    const r = await buildSite({ repo, outDir: join(tmp(), "dist"), today: Q1_TODAY, site: AUTO });
    expect((r.html.match(/<li class="job" data-q1="item">/g) ?? []).length).toBe(3);
  });
});

describe("migrate-ids.ts: delivered entries with readable ids become editable, losing nothing", () => {
  /** A repository as delivered before the fix: works and news with readable ids in readable file names, plus one entry the customer made in the CMS (a UUID). */
  async function legacyRepo() {
    const repo = join(tmp(), "repo");
    await writeFixture(repo, AUTO_SITE.fixtures()["news-1"]!);
    for (const [collection, prefix] of [
      ["works", "job"],
      ["news", "news"],
    ] as const) {
      const dir = join(repo, "content", collection);
      for (const name of readdirSync(dir)) {
        const entry = JSON.parse(readFileSync(join(dir, name), "utf8")) as { id: string };
        const k = [1, 2, 3].find((n) => autoEntryId(collection, `${prefix}-${n}`) === entry.id)!;
        rmSync(join(dir, name));
        // the readable id, written with its own spacing (a hand-formatted file must keep its bytes)
        writeFileSync(join(dir, `${prefix}-${k}.json`), JSON.stringify({ ...entry, id: `${prefix}-${k}` }, null, 2).replace('"id": ', '"id":   ') + "\n");
      }
    }
    const own = randomUUID();
    writeFileSync(join(repo, "content", "works", `${own}.json`), `${JSON.stringify({ id: own, vehicle: "架空車 CMS で作った", service: "洗車", photos: [{ image: "/media/job-1-1.png", role: "before" }], visible: false, displayOrder: 0 }, null, 2)}\n`);
    return { repo, own };
  }
  const snapshot = (repo: string) =>
    Object.fromEntries(["works", "news"].flatMap((c) => readdirSync(join(repo, "content", c)).map((n) => [`${c}/${n}`, readFileSync(join(repo, "content", c, n), "utf8")])));

  it("dry run by default: reports every file, writes nothing", async () => {
    const { repo, own } = await legacyRepo();
    const before = snapshot(repo);
    const r = await migrateIds(repo);
    expect(r.status).toBe("dry_run");
    expect(r.changes.map((c) => [c.file, c.old_id, c.action])).toEqual([
      ["content/works/job-1.json", "job-1", "rewrite"],
      ["content/works/job-2.json", "job-2", "rewrite"],
      ["content/works/job-3.json", "job-3", "rewrite"],
      [`content/works/${own}.json`, own, "kept"],
      ["content/news/news-1.json", "news-1", "rewrite"],
    ].sort((a, b) => (a[0]! < b[0]! ? -1 : 1)).sort((a, b) => (a[0]!.includes("/news/") ? 1 : 0) - (b[0]!.includes("/news/") ? 1 : 0)));
    expect(snapshot(repo)).toEqual(before);
  });

  it("--write: only the id's characters change (file names, photos, other fields and formatting kept); the result saves in Pages CMS and builds the same page; a second run changes nothing", async () => {
    const { repo } = await legacyRepo();
    const before = snapshot(repo);
    const page = (await buildSite({ repo, outDir: join(tmp(), "dist"), today: Q1_TODAY, site: AUTO })).html;
    const r = await migrateIds(repo, { write: true });
    expect(r.status).toBe("written");
    const after = snapshot(repo);
    expect(Object.keys(after)).toEqual(Object.keys(before));
    for (const c of r.changes) {
      const key = c.file.replace(/^content\//, "");
      if (c.action === "kept") expect(after[key], key).toBe(before[key]);
      else {
        expect(c.new_id).toBe(uuidV5(`${key.split("/")[0]}/${c.old_id}`));
        expect(after[key]!.replace(JSON.stringify(c.new_id), JSON.stringify(c.old_id)), key).toBe(before[key]);
      }
    }
    expect(after["works/job-1.json"]).toContain(`"id":   "${autoEntryId("works", "job-1")}"`);
    const cfg = configOf(AUTO_SITE);
    for (const [key, text] of Object.entries(after)) {
      const fields = cfg.content.find((x) => x.name === key.split("/")[0])!.fields;
      expect(cmsSaveIssues(fields, JSON.parse(text) as Record<string, unknown>, cfg.media.extensions), key).toEqual([]);
    }
    expect((await buildSite({ repo, outDir: join(tmp(), "dist"), today: Q1_TODAY, site: AUTO })).html).toBe(page);
    const again = await migrateIds(repo, { write: true });
    expect([again.status, again.changes.every((c) => c.action === "kept")]).toEqual(["written", true]);
    expect(snapshot(repo)).toEqual(after);
  });

  it("refused with nothing written: two entries ending with the same id, invalid JSON, no string id", async () => {
    for (const breakIt of [
      (repo: string) => writeFileSync(join(repo, "content", "works", "job-1-copy.json"), readFileSync(join(repo, "content", "works", "job-1.json"))),
      (repo: string) => writeFileSync(join(repo, "content", "works", `${autoEntryId("works", "job-2")}.json`), JSON.stringify({ id: autoEntryId("works", "job-2"), vehicle: "x", service: "y", photos: [{ image: "/media/job-1-1.png" }] })),
      (repo: string) => writeFileSync(join(repo, "content", "news", "broken.json"), '{"id":'),
      (repo: string) => writeFileSync(join(repo, "content", "news", "noid.json"), JSON.stringify({ title: "x", publishedAt: "2026-11-30" })),
    ]) {
      const { repo } = await legacyRepo();
      breakIt(repo);
      const before = snapshot(repo);
      const r = await migrateIds(repo, { write: true });
      expect(r.status).toBe("refused");
      expect(r.errors.length).toBeGreaterThan(0);
      expect(snapshot(repo)).toEqual(before);
    }
  });
});
