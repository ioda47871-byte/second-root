// The delivery repository's own tests (node --test). Each test works on a copy of this repository in a temporary
// folder (node_modules linked), so the repository itself is never changed. SYNTHETIC pictures only.
//
//   - the sample builds; a changed .pages.yml is refused
//   - content in the shapes Pages CMS saves (its source, read 2026-11-27: lib/schema.ts deepMap / sanitizeObject —
//     keys in the configuration's order, keys outside the configuration dropped, "" / null / empty lists and objects
//     removed; fields/core/uuid: crypto.randomUUID(); reference: the referenced entry's value, here its id)
//   - a stopped build keeps the last good dist/
//   - phone photos: a full-size JPEG with an EXIF orientation and GPS is fitted, upright and without metadata; a 48 MP
//     JPEG is fitted; a HEIC renamed .jpg stops with the HEIC advice; protected bytes are never changed
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import sharp from "sharp";
import { register } from "tsx/esm/api";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TODAY = "2026-12-01";
register();
const { build, explain } = await import(pathToFileURL(join(ROOT, "build.mjs")).href);
const site = (name) => import(pathToFileURL(join(ROOT, "site", name)).href);
const { pagesConfig, pagesYaml } = await site("pages-config.ts");
const { SHOP_SITES } = await site("shop-site.ts");
const { writeFixture, q1Fixtures } = await site("fixtures.ts");
const { PHOTO_LIMITS } = await site("photos.ts");

const temps = [];
after(async () => {
  for (const d of temps) await rm(d, { recursive: true, force: true });
});
async function copyRepo() {
  const base = await mkdtemp(join(tmpdir(), "shop-site-test-"));
  temps.push(base);
  const dir = join(base, "repo");
  await cp(ROOT, dir, { recursive: true, filter: (src) => !/^[/\\]?(node_modules|dist|\.build)([/\\]|$)/.test(src.slice(ROOT.length)) });
  await symlink(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir");
  return dir;
}
const sha = (b) => createHash("sha256").update(b).digest("hex");
const readJson = async (p) => JSON.parse(await readFile(p, "utf8"));
const writeJson = (p, v) => writeFile(p, `${JSON.stringify(v, null, 2)}\n`);
const codeOf = (p) => p.then(
  () => "ok",
  (e) => e?.code ?? String(e),
);
const config = async (dir) => {
  const id = (await readJson(join(dir, "site.config.json"))).site;
  const s = SHOP_SITES.find((x) => x.id === id);
  return pagesConfig({ extensions: s.profile.extensions, ...(s.profile.collections ? { collections: s.profile.collections } : {}) });
};

/** What Pages CMS writes for an entry: configured keys only, in their order, empty values removed. */
const empty = (v) => v == null || v === "" || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);
function savedAs(value, fields) {
  const out = {};
  for (const f of fields) {
    let v = value?.[f.name];
    if (f.list) v = Array.isArray(v) ? v.map((x) => (f.type === "object" ? savedAs(x, f.fields) : x)).filter((x) => !empty(x)) : undefined;
    else if (f.type === "object") v = v ? savedAs(v, f.fields) : undefined;
    if (!empty(v)) out[f.name] = v;
  }
  return out;
}
/** Rewrites every content file of <dir> as Pages CMS would save it. Returns how many keys were dropped. */
async function saveAllAsPagesCms(dir) {
  const cfg = await config(dir);
  let dropped = 0;
  for (const entry of cfg.content) {
    const files = entry.type === "file" ? [join(dir, entry.path)] : (await readdir(join(dir, entry.path)).catch(() => [])).filter((n) => n.endsWith(".json")).map((n) => join(dir, entry.path, n));
    for (const file of files) {
      const before = await readJson(file);
      const after = savedAs(before, entry.fields);
      dropped += JSON.stringify(before).length - JSON.stringify(after).length > 0 ? 1 : 0;
      await writeJson(file, after);
    }
  }
  return dropped;
}
async function snapshot(dir) {
  const out = {};
  const walk = async (d, rel = "") => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.isDirectory()) await walk(join(d, e.name), `${rel}${e.name}/`);
      else out[`${rel}${e.name}`] = sha(await readFile(join(d, e.name)));
    }
  };
  await walk(join(dir, "dist"));
  return out;
}
const noise = (w, h) => sharp({ create: { width: w, height: h, channels: 3, noise: { type: "gaussian", mean: 128, sigma: 50 } } });
const firstWork = async (dir) => join(dir, "content", "works", (await readdir(join(dir, "content", "works"))).sort()[0]);

test("the sample builds: the shop's page, its pictures, no script; a changed .pages.yml is refused", async () => {
  const dir = await copyRepo();
  const r = await build({ root: dir, today: TODAY });
  const html = await readFile(join(dir, "dist", "index.html"), "utf8");
  assert.match(html, /架空のカーケア工房 そらいろ/);
  assert.doesNotMatch(html, /<script|https?:\/\//i);
  assert.ok(r.media.length > 0);
  await writeFile(join(dir, ".pages.yml"), `${await readFile(join(dir, ".pages.yml"), "utf8")}# edited\n`);
  assert.equal(await codeOf(build({ root: dir, today: TODAY })), "PAGES_YML_CHANGED");
});

test("content as Pages CMS saves it (keys in order, keys outside .pages.yml dropped, empty values removed) builds the same page", async () => {
  const dir = await copyRepo();
  await build({ root: dir, today: TODAY });
  const before = await readFile(join(dir, "dist", "index.html"), "utf8");
  const dropped = await saveAllAsPagesCms(dir);
  assert.ok(dropped > 0, "the sample has values Pages CMS would drop (empty descriptions, the photo class)");
  await build({ root: dir, today: TODAY });
  assert.equal(await readFile(join(dir, "dist", "index.html"), "utf8"), before);
  // the shop-provided (B) photo's class was dropped with the entry's imageKind: it stays B by its bytes (#383 Low)
  const works = await readdir(join(dir, "content", "works"));
  for (const n of works) for (const p of (await readJson(join(dir, "content", "works", n))).photos) assert.equal(p.imageKind, undefined);
});

test("a new entry as Pages CMS creates it: a crypto.randomUUID() id and file name, defaults written, empty optionals absent", async () => {
  const dir = await copyRepo();
  const id = randomUUID();
  const photo = (await readJson(await firstWork(dir))).photos[0].image;
  await writeJson(join(dir, "content", "works", `${id}.json`), { id, vehicle: "架空車 新規", service: "手洗い洗車", photos: [{ image: photo, role: "other" }], visible: true, displayOrder: 0 });
  await build({ root: dir, today: TODAY });
  assert.match(await readFile(join(dir, "dist", "index.html"), "utf8"), /<h3>架空車 新規<\/h3>/);
  // an empty optional saved as null (Pages CMS removes nulls; if one arrived, the build refuses it and keeps dist/)
  const snap = await snapshot(dir);
  await writeJson(join(dir, "content", "works", `${id}.json`), { id, vehicle: "架空車 新規", service: "手洗い洗車", description: null, photos: [{ image: photo }] });
  assert.equal(await codeOf(build({ root: dir, today: TODAY })), "CONTENT_INVALID");
  assert.deepEqual(await snapshot(dir), snap);
});

test("reference and string lists (the bakery's page code): a category reference is the category's id; an unknown one is refused", async () => {
  const dir = await copyRepo();
  await rm(join(dir, "content"), { recursive: true, force: true });
  await rm(join(dir, "media"), { recursive: true, force: true });
  await writeFixture(dir, q1Fixtures()["trade-extensions"]);
  const bakery = SHOP_SITES.find((s) => s.id === "bakery");
  await writeJson(join(dir, "site.config.json"), { site: "bakery" });
  await writeFile(join(dir, ".pages.yml"), pagesYaml({ extensions: bakery.profile.extensions }));
  await saveAllAsPagesCms(dir);
  const item = join(dir, "content", "menu", "item-1.json");
  const saved = await readJson(item);
  assert.equal(typeof saved.category, "string");
  assert.ok(Array.isArray(saved.allergens));
  await build({ root: dir, today: TODAY });
  await writeJson(item, { ...saved, category: randomUUID() });
  assert.equal(await codeOf(build({ root: dir, today: TODAY })), "CONTENT_UNKNOWN_CATEGORY");
});

test("a stopped build keeps the last good dist/ byte for byte (broken JSON, a missing photo); repaired, it builds again", async () => {
  const dir = await copyRepo();
  await build({ root: dir, today: TODAY });
  const good = await snapshot(dir);
  const work = await firstWork(dir);
  const text = await readFile(work);
  await writeFile(work, '{"id":"half');
  assert.equal(await codeOf(build({ root: dir, today: TODAY })), "CONTENT_INVALID");
  assert.deepEqual(await snapshot(dir), good);
  await writeFile(work, text);
  const photo = join(dir, (await readJson(work)).photos[0].image);
  const bytes = await readFile(photo);
  await rm(photo);
  assert.equal(await codeOf(build({ root: dir, today: TODAY })), "CONTENT_PHOTO_MISSING");
  assert.deepEqual(await snapshot(dir), good);
  await writeFile(photo, bytes);
  await build({ root: dir, today: TODAY });
  assert.deepEqual(await snapshot(dir), good);
});

test("phone photos: a full-size JPEG (EXIF orientation 6, GPS) and a 48 MP JPEG are fitted, upright, without metadata; the repository keeps the originals", async () => {
  const dir = await copyRepo();
  const big = await noise(4032, 3024)
    .jpeg({ quality: 95 })
    .withExif({ IFD0: { Make: "Fictional", Model: "Test" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "35/1 0/1 0/1", GPSLongitudeRef: "E", GPSLongitude: "139/1 0/1 0/1" } })
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const meta = await sharp(big).metadata();
  assert.equal(meta.orientation, 6);
  assert.ok(meta.exif);
  assert.ok(big.length > PHOTO_LIMITS.bytes, `the synthetic phone JPEG is over the limit (${big.length} bytes)`);
  const huge = await noise(8064, 6048).jpeg({ quality: 80 }).toBuffer();
  await writeFile(join(dir, "media", "IMG_0001.JPG"), big);
  await writeFile(join(dir, "media", "IMG_0002.JPG"), huge);
  const work = await firstWork(dir);
  await writeJson(work, { ...(await readJson(work)), photos: [{ image: "/media/IMG_0001.JPG", role: "before" }, { image: "/media/IMG_0002.JPG", role: "after" }] });
  const r = await build({ root: dir, today: TODAY });
  const out1 = await readFile(join(dir, "dist", "media", "IMG_0001.JPG"));
  const m1 = await sharp(out1).metadata();
  assert.deepEqual([m1.format, m1.width, m1.height, m1.orientation, m1.exif], ["jpeg", 1920, 2560, undefined, undefined]);
  assert.ok(out1.length <= PHOTO_LIMITS.bytes);
  const m2 = await sharp(await readFile(join(dir, "dist", "media", "IMG_0002.JPG"))).metadata();
  assert.deepEqual([m2.width, m2.height], [2560, 1920]);
  assert.equal(sha(await readFile(join(dir, "media", "IMG_0001.JPG"))), sha(big));
  assert.deepEqual(r.photos.filter((p) => p.file.startsWith("IMG_")).map((p) => p.action), ["fitted", "fitted"]);
});

test("a HEIC renamed .jpg stops the build with the HEIC advice; protected bytes (B index, generated record) are never changed", async () => {
  const dir = await copyRepo();
  const box = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(4), Buffer.from("mif1heic"), Buffer.alloc(3 * 1024 * 1024)]);
  await writeFile(join(dir, "media", "IMG_0003.jpg"), box);
  const work = await firstWork(dir);
  const saved = await readJson(work);
  await writeJson(work, { ...saved, photos: [{ image: "/media/IMG_0003.jpg" }] });
  const err = await build({ root: dir, today: TODAY }).then(() => null, (e) => e);
  assert.equal(err?.code, "CONTENT_PHOTO_HEIC");
  assert.match(await explain(err, dir), /互換性優先/);
  await writeJson(work, saved);
  // the B photo keeps its bytes in dist/
  const index = await readJson(join(dir, "content", "photo-provenance.json"));
  await build({ root: dir, today: TODAY });
  const shas = await Promise.all((await readdir(join(dir, "dist", "media"))).map(async (n) => sha(await readFile(join(dir, "dist", "media", n)))));
  for (const b of index.b) assert.ok(shas.includes(b.sha256), "the B photo is published unchanged");
  // a customer photo that is a delivered generated material is still caught (its bytes were not re-encoded first)
  const photoFile = saved.photos[0].image.replace(/^\/media\//, "");
  const bytes = await readFile(join(dir, "media", photoFile));
  await writeJson(join(dir, "content", "generated-materials.json"), { schema: "generated_materials_v1", files: [{ file: photoFile, sha256: sha(bytes) }] });
  assert.equal(await codeOf(build({ root: dir, today: TODAY })), "CONTENT_GENERATED_AS_SHOP");
});
