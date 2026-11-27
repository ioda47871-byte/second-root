// Issue #380 live trial: writes the SYNTHETIC test-data pack for the 12 trial checks (docs/design/cms-live-trial-owner-sheet.md
// appendix) into a folder OUTSIDE Second Root and outside the trial repository. No real photo, place, car or person:
// every picture is drawn from shapes and noise; the GPS position written into the "phone" JPEGs is 0°N 0°E (a point in
// the sea, chosen to be obviously fake).
//
//   node experiments/pages-cms/live-trial-data.mjs --sharp-from <a checkout of the trial repo after npm ci> --out <empty folder>
//
// It borrows sharp from the trial repository's node_modules (the version pinned there); Second Root itself gets no
// dependency. A real HEIC cannot be made here (sharp's prebuilt binaries do not write HEVC), so the pack holds only a
// HEIC-headed fake for the build's refusal check; a real HEIC comes from the iPhone itself (its default format).
import { createHash } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const from = arg("--sharp-from");
const out = arg("--out");
if (!from || !out) {
  process.stdout.write('{"status":"refused","code":"ARGS_INVALID"}\n');
  process.exit(2);
}
const sharp = createRequire(join(resolve(from), "package.json"))("sharp");
const MB = 1024 * 1024;
const sha = (b) => createHash("sha256").update(b).digest("hex");

/** A synthetic car-shaped drawing (no text, no brand), tinted, over gaussian noise. */
function drawing(w, h, { body = "#3c6ea8", grime = 0, seed = 0 } = {}) {
  const spots = Array.from({ length: grime }, (_, k) => {
    const x = ((k * 7919 + seed * 104729) % 1000) / 1000;
    const y = ((k * 3571 + seed * 1299709) % 1000) / 1000;
    return `<circle cx="${(0.15 + 0.7 * x) * w}" cy="${(0.42 + 0.22 * y) * h}" r="${(0.01 + 0.02 * x) * w}" fill="#6b5236" opacity="0.7"/>`;
  }).join("");
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#cfdbe6"/><stop offset="1" stop-color="#8e9aa6"/></linearGradient></defs>
<rect width="${w}" height="${h}" fill="url(#sky)"/>
<rect y="${0.72 * h}" width="${w}" height="${0.28 * h}" fill="#55595e"/>
<rect x="${0.12 * w}" y="${0.42 * h}" width="${0.76 * w}" height="${0.22 * h}" rx="${0.04 * w}" fill="${body}"/>
<rect x="${0.28 * w}" y="${0.3 * h}" width="${0.42 * w}" height="${0.16 * h}" rx="${0.04 * w}" fill="${body}"/>
<rect x="${0.32 * w}" y="${0.33 * h}" width="${0.15 * w}" height="${0.1 * h}" fill="#dfe8ef"/>
<rect x="${0.51 * w}" y="${0.33 * h}" width="${0.15 * w}" height="${0.1 * h}" fill="#dfe8ef"/>
<circle cx="${0.27 * w}" cy="${0.66 * h}" r="${0.07 * w}" fill="#1d1f22"/>
<circle cx="${0.73 * w}" cy="${0.66 * h}" r="${0.07 * w}" fill="#1d1f22"/>
${spots}</svg>`);
}
async function picture(w, h, opts, sigma) {
  const noise = await sharp({ create: { width: w, height: h, channels: 3, noise: { type: "gaussian", mean: 128, sigma } } }).png().toBuffer();
  const art = await sharp(drawing(w, h, opts)).resize(w, h).png().toBuffer();
  return sharp(art).composite([{ input: noise, blend: "soft-light" }]);
}
const GPS = { GPSLatitudeRef: "N", GPSLatitude: "0/1 0/1 0/1", GPSLongitudeRef: "E", GPSLongitude: "0/1 0/1 0/1" };
/** A phone-like JPEG: EXIF orientation 6 (stored sideways, shown upright), the fake GPS, a camera name that is not one. */
async function phoneJpeg(img, quality) {
  return img.jpeg({ quality, chromaSubsampling: "4:4:4" }).withExif({ IFD0: { Make: "Fictional", Model: "Trial Phone" }, IFD3: GPS }).withMetadata({ orientation: 6 }).toBuffer();
}
/** The highest quality from the list whose size falls in [lo, hi] bytes (else the closest). */
async function sized(make, lo, hi) {
  let best = null;
  for (const q of [97, 95, 92, 90, 88, 85, 82, 78, 74, 70]) {
    const b = await make(q);
    if (b.length >= lo && b.length <= hi) return b;
    if (!best || Math.abs(b.length - (lo + hi) / 2) < Math.abs(best.length - (lo + hi) / 2)) best = b;
  }
  return best;
}

const files = [];
async function put(rel, bytes, note) {
  const p = join(out, rel);
  await mkdir(join(p, ".."), { recursive: true });
  await writeFile(p, bytes);
  const meta = /\.(jpe?g|png|webp)$/i.test(rel) ? await sharp(bytes).metadata().catch(() => null) : null;
  files.push({ file: rel, bytes: bytes.length, sha256: sha(bytes), ...(meta ? { width: meta.width, height: meta.height, orientation: meta.orientation ?? null, exif: Boolean(meta.exif) } : {}), note });
}

await mkdir(out, { recursive: true });
if ((await readdir(out)).length > 0) {
  process.stdout.write('{"status":"refused","code":"OUT_NOT_EMPTY"}\n');
  process.exit(2);
}
// 1. phone-like full-size JPEGs, 4–6 MB, 4032×3024 stored sideways (orientation 6), with the fake GPS
for (const [k, body] of [
  [1, "#3c6ea8"],
  [2, "#a83c3c"],
  [3, "#3ca86e"],
]) {
  const bytes = await sized(async (q) => phoneJpeg(await picture(4032, 3024, { body, seed: k }, 34), q), 4 * MB, 6 * MB);
  await put(`phone/IMG_40${String(k).padStart(2, "0")}.JPG`, bytes, "スマートフォンの写真の代わり: 4032×3024・EXIF の向き 6・偽の GPS（0°N 0°E）・4〜6 MB");
}
// 2. a 48 MP JPEG (8064×6048)
await put("phone/IMG_4800.JPG", await phoneJpeg(await picture(8064, 6048, { body: "#6e3ca8", seed: 9 }, 22), 85), "4800 万画素の写真の代わり（8064×6048、偽の GPS）");
// 3. before / after pairs (the same drawing, dirty and clean)
for (const k of [1, 2]) {
  await put(`before-after/pair-${k}-before.jpg`, await (await picture(1600, 1200, { body: "#7d8288", grime: 40, seed: k }, 18)).jpeg({ quality: 88 }).toBuffer(), "施工前の代わり（汚れの点あり）");
  await put(`before-after/pair-${k}-after.jpg`, await (await picture(1600, 1200, { body: "#2f6db5", seed: k }, 10)).jpeg({ quality: 88 }).toBuffer(), "施工後の代わり");
}
// 4. several photos of different shapes for one job
for (const [name, w, h] of [
  ["landscape-4x3", 1600, 1200],
  ["portrait-3x4", 1200, 1600],
  ["wide-16x9", 1920, 1080],
  ["square", 1400, 1400],
]) await put(`multi/${name}.jpg`, await (await picture(w, h, { body: "#b5852f", seed: w + h }, 14)).jpeg({ quality: 86 }).toBuffer(), `1 件に複数枚の写真の代わり（${w}×${h}）`);
// 5. a HEIC-headed fake (not a picture): the build must stop with CONTENT_PHOTO_HEIC
const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(4), Buffer.from("mif1heic"), Buffer.alloc(2 * MB)]);
await put("heic/IMG_4002-fake-heic.jpg", heic, "HEIC の頭だけを持つ偽のファイル（本物の HEIC ではない）。構築が CONTENT_PHOTO_HEIC で止まることの確認用");
// 6. broken entries (for the build-failure check): copy one into content/works/ of the trial repo
const enc = (o) => Buffer.from(`${JSON.stringify(o, null, 2)}\n`);
await put("broken/half-saved.json", Buffer.from('{\n  "id": "broken-half",\n  "vehicle": "架空車 壊れた例",\n'), "途中で切れた JSON（CONTENT_INVALID）");
await put("broken/no-photo.json", enc({ id: "broken-nophoto", vehicle: "架空車 写真なし", service: "手洗い洗車", photos: [] }), "写真が 0 枚（CONTENT_INVALID）");
await put("broken/missing-photo.json", enc({ id: "broken-missing", vehicle: "架空車 写真が無い", service: "手洗い洗車", photos: [{ image: "/media/does-not-exist.jpg" }] }), "存在しない写真（CONTENT_PHOTO_MISSING）");
await writeFile(join(out, "manifest.json"), `${JSON.stringify({ schema: "sr_live_trial_data_v1", note: "合成の試験データ。実在の写真・場所・車・人は含まない。GPS は偽（0°N 0°E）。", files }, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ status: "written", files: files.length })}\n`);
