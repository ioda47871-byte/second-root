import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkPhotoRights as checkWith,
  isIsoDate,
  loadForbiddenSha256,
  measurePhotoBytes,
  PRIVATE_PHOTO_PATH,
  readPhotoHeader,
  resolvePrivatePhoto,
  toPublicPhotoRecord,
  type PhotoBytesInfo,
  type PhotoRightsOptions,
} from "@/lib/design-agent/quality-pipeline/photo-rights";
import { coverCrop, fitSlot, PhotoSlotInventory, requestFor, SLOT_VIEWPORTS, variantOf } from "@/lib/design-agent/quality-pipeline/photo-slots";
import { deriveSlots } from "../../../../scripts/design-artifact/photo-slots";

const REPO = resolve(__dirname, "../../../..");
const POC = "design-library/research/quality-pipeline/poc";

/** A PNG header only (signature + IHDR): enough for the size reader. Not a picture, never written to the repository. */
function pngHeader(w: number, h: number) {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
function jpegHeader(w: number, h: number) {
  // SOI, an APP0 segment of 4 bytes, SOF0 (len 17, precision 8, height, width)
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03]);
}
/**
 * A JPEG header with an APP1 EXIF block whose IFD0 holds one entry (the orientation tag), then SOF0. In memory only;
 * not a picture. `entry` overrides the 12-byte IFD entry, `tiff` the whole TIFF block (for malformed cases).
 */
function jpegExifHeader(w: number, h: number, orientation: number, order: "II" | "MM", o: { tiff?: Buffer } = {}) {
  const le = order === "II";
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  tiff.write(order, 0, "latin1");
  const u16 = (v: number, at: number) => (le ? tiff.writeUInt16LE(v, at) : tiff.writeUInt16BE(v, at));
  const u32 = (v: number, at: number) => (le ? tiff.writeUInt32LE(v, at) : tiff.writeUInt32BE(v, at));
  u16(42, 2);
  u32(8, 4);
  u16(1, 8); // one entry
  u16(0x0112, 10);
  u16(3, 12); // SHORT
  u32(1, 14);
  u16(orientation, 18);
  const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), o.tiff ?? tiff]);
  const app1 = Buffer.alloc(4);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(body.length + 2, 2);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, body, sof]);
}
function webpVp8xHeader(w: number, h: number) {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "latin1");
  b.writeUInt32LE(22, 4);
  b.write("WEBP", 8, "latin1");
  b.write("VP8X", 12, "latin1");
  b.writeUInt32LE(10, 16);
  b.writeUIntLE(w - 1, 24, 3);
  b.writeUIntLE(h - 1, 27, 3);
  return b;
}

const BYTES = pngHeader(4000, 3000);
const INFO = measurePhotoBytes(BYTES)!;
/** the forbidden hashes from the originals inventory, the one source of truth for the success-case pictures */
const FORBIDDEN = loadForbiddenSha256(REPO);
/** every check pins its date, so the tests do not depend on the day they run */
const NOW = "2026-11-03";
const checkPhotoRights = (record: unknown, info: PhotoBytesInfo | null, o: Partial<PhotoRightsOptions> = {}) => checkWith(record, info, { forbiddenSha256: FORBIDDEN, now: NOW, ...o });
const record = () => ({
  schema: "photo_rights_v0",
  asset_id: "photo-tsugute-ware-01",
  sha256: INFO.sha256,
  bytes: INFO.bytes,
  width: 4000,
  height: 3000,
  format: "png",
  source_kind: "owner_provided",
  owner: "owner (private)",
  license: "written permission, see consent record",
  paid: false,
  allowed_uses: { edit: true, crop: true, commercial: true, public_web: false },
  consent_record_ref: "consent-2026-11-03-01",
  received_at: "2026-11-03",
  expiry: null,
  private_path: ".intake/photos/tsugute-ware-01.png",
  depicts_identifiable_person: false,
  depicts_real_shop: false,
});

describe("photo_rights_v0: what a photo must carry before it is used", () => {
  it("a complete owner-provided record that matches the measured bytes passes for quality verification", () => {
    const r = checkPhotoRights(record(), INFO);
    expect(r.ok).toBe(true);
  });

  it("every missing rights field is refused by name, never folded into a generic error", () => {
    const cases: Array<[string, string]> = [
      ["source_kind", "RIGHTS_MISSING_SOURCE"],
      ["owner", "RIGHTS_MISSING_OWNER"],
      ["license", "RIGHTS_MISSING_LICENSE"],
      ["allowed_uses", "RIGHTS_MISSING_ALLOWED_USES"],
      ["consent_record_ref", "RIGHTS_MISSING_CONSENT"],
      ["received_at", "RIGHTS_MISSING_RECEIVED_AT"],
      ["expiry", "RIGHTS_MISSING_EXPIRY"],
      ["paid", "RIGHTS_MISSING_PAID"],
      ["depicts_identifiable_person", "RIGHTS_MISSING_SUBJECT"],
      ["depicts_real_shop", "RIGHTS_MISSING_SUBJECT"],
      ["private_path", "PATH_NOT_PRIVATE"],
    ];
    for (const [key, code] of cases) {
      const r = record() as Record<string, unknown>;
      delete r[key];
      const out = checkPhotoRights(r, INFO);
      expect(out.ok, key).toBe(false);
      if (!out.ok) expect(out.codes, key).toContain(code);
    }
    // blank is missing too
    const blank = checkPhotoRights({ ...record(), owner: "  ", consent_record_ref: "" }, INFO);
    expect(blank.ok).toBe(false);
    if (!blank.ok) expect(blank.codes).toEqual(expect.arrayContaining(["RIGHTS_MISSING_OWNER", "RIGHTS_MISSING_CONSENT"]));
    // an allowed_uses object missing one use is missing the uses
    const partial = checkPhotoRights({ ...record(), allowed_uses: { edit: true, crop: true, commercial: true } }, INFO);
    expect(partial.ok).toBe(false);
    if (!partial.ok) expect(partial.codes).toContain("RIGHTS_MISSING_ALLOWED_USES");
  });

  it("every use the pipeline makes must be allowed: edit, crop, commercial (and public web + client confirmation for a public site)", () => {
    const deny = (use: string) => checkPhotoRights({ ...record(), allowed_uses: { ...record().allowed_uses, [use]: false } }, INFO);
    for (const [use, code] of [
      ["edit", "NOT_ALLOWED_FOR_EDIT"],
      ["crop", "NOT_ALLOWED_FOR_CROP"],
      ["commercial", "NOT_ALLOWED_FOR_COMMERCIAL"],
    ]) {
      const r = deny(use!);
      expect(r.ok, use).toBe(false);
      if (!r.ok) expect(r.codes).toEqual([code]);
    }
    const pub = checkPhotoRights(record(), INFO, { purpose: "public_site" });
    expect(pub.ok).toBe(false);
    if (!pub.ok) expect(pub.codes.sort()).toEqual(["CLIENT_CONFIRMATION_MISSING", "NOT_ALLOWED_FOR_PUBLIC_WEB"]);
    const confirmed = checkPhotoRights({ ...record(), allowed_uses: { ...record().allowed_uses, public_web: true }, client_confirmation_ref: "client-ok-01" }, INFO, { purpose: "public_site" });
    expect(confirmed.ok).toBe(true);
  });

  it("stock material needs its terms pinned by hash; paid material, people, real shops, forbidden hashes and expired rights are refused", () => {
    const stock = { ...record(), source_kind: "licensed_stock_with_terms", license: "CC0-1.0" };
    const noTerms = checkPhotoRights(stock, INFO);
    expect(noTerms.ok).toBe(false);
    if (!noTerms.ok) expect(noTerms.codes).toEqual(["RIGHTS_MISSING_TERMS_SNAPSHOT"]);
    expect(checkPhotoRights({ ...stock, terms_sha256: "a".repeat(64) }, INFO).ok).toBe(true);

    const bad = checkPhotoRights({ ...record(), paid: true, depicts_identifiable_person: true, depicts_real_shop: true, expiry: "2026-11-10" }, INFO, { now: "2026-12-01", forbiddenSha256: new Set([INFO.sha256]) });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.codes.sort()).toEqual(["FORBIDDEN_SOURCE_HASH", "IDENTIFIABLE_PERSON", "PAID_SOURCE_NOT_APPROVED", "REAL_SHOP_DEPICTED", "RIGHTS_EXPIRED"]);

    // other sources (another site, a success case, a generator) do not exist as a kind
    for (const kind of ["web", "other_site", "success_case", "ai_generated"]) {
      const r = checkPhotoRights({ ...record(), source_kind: kind }, INFO);
      expect(r.ok, kind).toBe(false);
      if (!r.ok) expect(r.codes).toEqual(["RIGHTS_MISSING_SOURCE"]);
    }
  });

  it("the forbidden hashes come from the originals inventory, cover every success-case picture in the repository, and are refused", () => {
    const assets = spawnSync("git", ["ls-files", "design-library/success-cases/assets"], { cwd: REPO, encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);
    expect(assets.length).toBeGreaterThan(0);
    const inv = JSON.parse(readFileSync(resolve(REPO, "design-library/research/quality-pipeline/originals-inventory.json"), "utf8")) as { cases: Array<{ originals: Array<{ sha256: string }> }> };
    for (const c of inv.cases) for (const o of c.originals) expect(FORBIDDEN.has(o.sha256)).toBe(true);
    for (const p of assets) {
      const bytes = readFileSync(resolve(REPO, p));
      const sha = createHash("sha256").update(bytes).digest("hex");
      expect(FORBIDDEN.has(sha), p).toBe(true);
      const info = { ...INFO, sha256: sha, bytes: bytes.length };
      const r = checkPhotoRights({ ...record(), sha256: sha, bytes: bytes.length }, info);
      expect(r.ok, p).toBe(false);
      if (!r.ok) expect(r.codes, p).toEqual(["FORBIDDEN_SOURCE_HASH"]);
    }
    // the list is required: the type has no default, and a call without it does not compile
    // @ts-expect-error forbiddenSha256 is required
    expect(() => checkWith(record(), INFO, {})).toThrow();
  });

  it("dates are real calendar dates; expiry is checked against today by default; received_at may not be in the future", () => {
    for (const d of ["2026-02-31", "9999-99-99", "2026-13-01", "2026-00-10", "2026-11-03T24:00Z", "2026-11-3", "20261103"]) expect(isIsoDate(d), d).toBe(false);
    for (const d of ["2026-02-28", "2028-02-29", "2099-12-31", "2026-11-03T09:30:00+09:00"]) expect(isIsoDate(d), d).toBe(true);
    const impossible = checkPhotoRights({ ...record(), expiry: "2026-02-31" }, INFO);
    expect(impossible.ok).toBe(false);
    if (!impossible.ok) expect(impossible.codes).toEqual(["RIGHTS_DATE_INVALID"]);
    const nines = checkPhotoRights({ ...record(), received_at: "9999-99-99" }, INFO);
    expect(nines.ok).toBe(false);
    if (!nines.ok) expect(nines.codes).toEqual(["RIGHTS_DATE_INVALID"]);
    // "no end date" is null, said explicitly; a valid far-future date is a date
    expect(checkPhotoRights({ ...record(), expiry: "2099-12-31" }, INFO).ok).toBe(true);
    // the future
    const future = checkPhotoRights({ ...record(), received_at: "2026-11-04" }, INFO);
    expect(future.ok).toBe(false);
    if (!future.ok) expect(future.codes).toEqual(["RIGHTS_RECEIVED_IN_FUTURE"]);
    // without `now`, today is used: an expiry in the past is refused whoever calls
    const past = checkWith({ ...record(), received_at: "2020-01-01", expiry: "2020-12-31" }, INFO, { forbiddenSha256: FORBIDDEN });
    expect(past.ok).toBe(false);
    if (!past.ok) expect(past.codes).toEqual(["RIGHTS_EXPIRED"]);
    expect(checkWith({ ...record(), received_at: "2020-01-01" }, INFO, { forbiddenSha256: FORBIDDEN }).ok).toBe(true);
    // the last day is still allowed
    expect(checkPhotoRights({ ...record(), expiry: NOW }, INFO).ok).toBe(true);
    expect(() => checkPhotoRights(record(), INFO, { now: "2026-02-31" })).toThrow();
  });

  it("the record must describe the bytes: hash, size, dimensions, format; and its extension must match its format", () => {
    const other: PhotoBytesInfo = { sha256: "b".repeat(64), bytes: INFO.bytes + 1, width: 3999, height: 3000, format: "jpeg", orientation: 1 };
    const r = checkPhotoRights(record(), other);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codes.sort()).toEqual(["DIMENSION_MISMATCH", "FORMAT_MISMATCH", "HASH_MISMATCH", "SIZE_MISMATCH"]);
    const unmeasured = checkPhotoRights(record(), null);
    expect(unmeasured.ok).toBe(false);
    if (!unmeasured.ok) expect(unmeasured.codes).toEqual(["HASH_MISMATCH"]);
    const ext = checkPhotoRights({ ...record(), private_path: ".intake/photos/tsugute-ware-01.webp" }, INFO);
    expect(ext.ok).toBe(false);
    if (!ext.ok) expect(ext.codes).toEqual(["FORMAT_EXTENSION_MISMATCH"]);
  });

  it("the public record keeps hashes and booleans only: no owner, no consent record, no path, no licence text", () => {
    const r = checkPhotoRights(record(), INFO);
    if (!r.ok) throw new Error("expected ok");
    const pub = toPublicPhotoRecord(r.record);
    const text = JSON.stringify(pub);
    for (const secret of ["owner (private)", "consent-2026-11-03-01", ".intake", "written permission"]) expect(text).not.toContain(secret);
    expect(pub.bytes_committed).toBe(false);
    expect(pub.sha256).toBe(INFO.sha256);
  });

  it("reads size and format from the header, not from the name or the record", () => {
    expect(measurePhotoBytes(pngHeader(1200, 800))).toMatchObject({ width: 1200, height: 800, format: "png" });
    expect(measurePhotoBytes(jpegHeader(3024, 4032))).toMatchObject({ width: 3024, height: 4032, format: "jpeg" });
    expect(measurePhotoBytes(webpVp8xHeader(2048, 1536))).toMatchObject({ width: 2048, height: 1536, format: "webp" });
    expect(measurePhotoBytes(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(measurePhotoBytes(Buffer.from("GIF89a\x01\x00\x01\x00"))).toBeNull();
  });

  it("a JPEG's EXIF orientation gives the shape it is shown in: 5–8 swap width and height (II and MM)", () => {
    // a phone photo stored 4032×3024, held upright
    expect(measurePhotoBytes(jpegExifHeader(4032, 3024, 1, "II"))).toMatchObject({ width: 4032, height: 3024, orientation: 1 });
    expect(measurePhotoBytes(jpegExifHeader(4032, 3024, 6, "II"))).toMatchObject({ width: 3024, height: 4032, orientation: 6, format: "jpeg" });
    expect(measurePhotoBytes(jpegExifHeader(4032, 3024, 6, "MM"))).toMatchObject({ width: 3024, height: 4032, orientation: 6 });
    expect(measurePhotoBytes(jpegExifHeader(4032, 3024, 8, "MM"))).toMatchObject({ width: 3024, height: 4032, orientation: 8 });
    expect(measurePhotoBytes(jpegExifHeader(4032, 3024, 3, "II"))).toMatchObject({ width: 4032, height: 3024, orientation: 3 });
    expect(measurePhotoBytes(jpegHeader(4032, 3024))).toMatchObject({ orientation: 1 });
    expect(measurePhotoBytes(pngHeader(10, 20))).toMatchObject({ orientation: 1 });
  });

  it("a JPEG whose EXIF block cannot be read is refused by name, without crashing", () => {
    const bad = (tiff: Buffer) => jpegExifHeader(4032, 3024, 1, "II", { tiff });
    const good = jpegExifHeader(4032, 3024, 6, "II").subarray(12, 12 + 26);
    const withOrder = Buffer.from(good);
    withOrder.write("XX", 0, "latin1");
    const badMagic = Buffer.from(good);
    badMagic.writeUInt16LE(43, 2);
    const ifdOut = Buffer.from(good);
    ifdOut.writeUInt32LE(0xffff, 4);
    const manyEntries = Buffer.from(good);
    manyEntries.writeUInt16LE(500, 8);
    const longType = Buffer.from(good);
    longType.writeUInt16LE(4, 12);
    const zero = Buffer.from(good);
    zero.writeUInt16LE(0, 18);
    const nine = Buffer.from(good);
    nine.writeUInt16LE(9, 18);
    for (const [name, tiff] of Object.entries({ withOrder, badMagic, ifdOut, manyEntries, longType, zero, nine, short: good.subarray(0, 6), empty: Buffer.alloc(0) })) {
      expect(readPhotoHeader(bad(tiff)), name).toEqual({ ok: false, code: "PHOTO_EXIF_UNREADABLE" });
      expect(measurePhotoBytes(bad(tiff)), name).toBeNull();
    }
    // the well-formed block the cases were cut from is read
    expect(readPhotoHeader(bad(good))).toMatchObject({ ok: true, info: { width: 3024, height: 4032, orientation: 6 } });
  });
});

describe("private hand-off: only a plain file directly under .intake/photos/", () => {
  it("the record path is refused outside .intake/photos, in a sub-folder, with .., or with another extension", () => {
    for (const p of [
      "photos/a.png",
      ".intake/a.png",
      ".intake/photos/../a.png",
      ".intake/photos/sub/a.png",
      ".intake/photos/.hidden.png",
      "/abs/.intake/photos/a.png",
      "design-library/success-cases/assets/CP-001_Mond.webp",
      ".intake/photos/a.gif",
      ".intake/photos/a.svg",
      "intake:photos/a.png",
    ]) {
      expect(PRIVATE_PHOTO_PATH.test(p), p).toBe(false);
      const r = checkPhotoRights({ ...record(), private_path: p }, INFO);
      expect(r.ok, p).toBe(false);
      if (!r.ok) expect(r.codes, p).toContain("PATH_NOT_PRIVATE");
    }
    expect(PRIVATE_PHOTO_PATH.test(".intake/photos/tsugute-ware-01.jpg")).toBe(true);
  });

  it("opens the file through no link: the photo, the photos folder and the .intake folder must all be real", () => {
    const root = mkdtempSync(join(tmpdir(), "photo-intake-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "photo-elsewhere-"));
    try {
      mkdirSync(join(root, ".intake/photos"), { recursive: true });
      writeFileSync(join(root, ".intake/photos/a.png"), BYTES);
      const ok = resolvePrivatePhoto(root, ".intake/photos/a.png");
      expect(ok.ok).toBe(true);
      if (ok.ok) expect(ok.info).toEqual(INFO);

      writeFileSync(join(elsewhere, "b.png"), BYTES);
      symlinkSync(join(elsewhere, "b.png"), join(root, ".intake/photos/link.png"));
      expect(resolvePrivatePhoto(root, ".intake/photos/link.png")).toEqual({ ok: false, code: "PATH_SYMLINK" });

      const root2 = mkdtempSync(join(tmpdir(), "photo-intake-"));
      mkdirSync(join(root2, ".intake"));
      mkdirSync(join(elsewhere, "photos"));
      writeFileSync(join(elsewhere, "photos/c.png"), BYTES);
      symlinkSync(join(elsewhere, "photos"), join(root2, ".intake/photos"));
      expect(resolvePrivatePhoto(root2, ".intake/photos/c.png")).toEqual({ ok: false, code: "PATH_SYMLINK" });

      const root3 = mkdtempSync(join(tmpdir(), "photo-intake-"));
      symlinkSync(elsewhere, join(root3, ".intake"));
      expect(resolvePrivatePhoto(root3, ".intake/photos/c.png")).toEqual({ ok: false, code: "PATH_SYMLINK" });

      // the pipeline root itself may not be a link
      const rootLink = join(elsewhere, "root-link");
      symlinkSync(root, rootLink);
      expect(resolvePrivatePhoto(rootLink, ".intake/photos/a.png")).toEqual({ ok: false, code: "PATH_SYMLINK" });

      // a hard link (a second name for a file that may live anywhere on the disk) is refused, both of its names
      writeFileSync(join(elsewhere, "d.png"), BYTES);
      linkSync(join(elsewhere, "d.png"), join(root, ".intake/photos/hard.png"));
      expect(resolvePrivatePhoto(root, ".intake/photos/hard.png")).toEqual({ ok: false, code: "PHOTO_HARDLINK" });
      linkSync(join(root, ".intake/photos/a.png"), join(elsewhere, "a-again.png"));
      expect(resolvePrivatePhoto(root, ".intake/photos/a.png")).toEqual({ ok: false, code: "PHOTO_HARDLINK" });
      rmSync(join(elsewhere, "a-again.png"));
      expect(resolvePrivatePhoto(root, ".intake/photos/a.png").ok).toBe(true);

      // a JPEG with an unreadable EXIF block is refused by name
      writeFileSync(join(root, ".intake/photos/exif.jpg"), jpegExifHeader(4032, 3024, 1, "II", { tiff: Buffer.from("MM\0\x2a") }));
      expect(resolvePrivatePhoto(root, ".intake/photos/exif.jpg")).toEqual({ ok: false, code: "PHOTO_EXIF_UNREADABLE" });

      expect(resolvePrivatePhoto(root, ".intake/photos/missing.png")).toEqual({ ok: false, code: "FILE_UNREADABLE" });
      expect(resolvePrivatePhoto(root, ".intake/photos/../a.png")).toEqual({ ok: false, code: "PATH_NOT_PRIVATE" });
      writeFileSync(join(root, ".intake/photos/fake.png"), "not a picture");
      expect(resolvePrivatePhoto(root, ".intake/photos/fake.png")).toEqual({ ok: false, code: "NOT_A_PHOTO" });
      for (const r of [root2, root3]) rmSync(r, { recursive: true, force: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("the quality pipeline's .intake folder is ignored by git", () => {
    const r = spawnSync("git", ["check-ignore", "-q", "design-library/research/quality-pipeline/.intake/photos/x.png"], { cwd: REPO });
    expect(r.status).toBe(0);
  });
});

describe("cover crop around a focal point", () => {
  const slot = variantOf("desktop_1440", 600, 400); // 3:2, min 1200×800

  it("a wider photo is cut at the sides, centred by default", () => {
    const c = coverCrop({ width: 4000, height: 2000 }, slot);
    expect(c.ok).toBe(true);
    if (c.ok) {
      expect(c.crop).toEqual({ x: 500, y: 0, width: 3000, height: 2000 });
      expect(c.object_position).toBe("50% 50%");
      expect(c.kept_area).toBe(0.75);
      expect(c.density).toBe(5);
    }
  });

  it("the focal point moves the crop, and stops at the photo's edge", () => {
    const left = coverCrop({ width: 4000, height: 2000 }, slot, { x: 0, y: 0.5 });
    const right = coverCrop({ width: 4000, height: 2000 }, slot, { x: 0.6, y: 0.5 });
    const edge = coverCrop({ width: 4000, height: 2000 }, slot, { x: 1, y: 0.5 });
    if (!left.ok || !right.ok || !edge.ok) throw new Error("expected ok");
    expect(left.crop.x).toBe(0);
    expect(left.object_position).toBe("0% 50%");
    expect(right.crop.x).toBe(900); // 0.6·4000 − 3000/2
    expect(right.object_position).toBe("90% 50%"); // 900 of the 1000px that spill over
    expect(edge.crop.x).toBe(1000);
    expect(edge.object_position).toBe("100% 50%");
  });

  it("a taller photo is cut at the top and bottom", () => {
    const c = coverCrop({ width: 3000, height: 4000 }, variantOf("mobile_390", 300, 300), { x: 0.5, y: 0.25 });
    if (!c.ok) throw new Error("expected ok");
    expect(c.crop).toEqual({ x: 0, y: 0, width: 3000, height: 3000 });
    expect(c.object_position).toBe("50% 0%");
  });

  it("refuses a photo below the slot's 2× minimum, and one that loses more than half of itself", () => {
    const small = coverCrop({ width: 1100, height: 733 }, slot);
    expect(small).toMatchObject({ ok: false, codes: ["PHOTO_TOO_SMALL"] });
    const narrow = coverCrop({ width: 1000, height: 4000 }, variantOf("desktop_1440", 1440, 600));
    expect(narrow.ok).toBe(false);
    if (!narrow.ok) expect(narrow.codes.sort()).toEqual(["PHOTO_TOO_SMALL", "RATIO_MISMATCH_EXTREME"]);
    const pano = coverCrop({ width: 12000, height: 2000 }, slot);
    expect(pano).toMatchObject({ ok: false, codes: ["RATIO_MISMATCH_EXTREME"] });
    expect(coverCrop({ width: 0, height: 10 }, slot)).toEqual({ ok: false, codes: ["BAD_INPUT"] });
    expect(coverCrop({ width: 4000, height: 3000 }, slot, { x: 1.2, y: 0 })).toEqual({ ok: false, codes: ["BAD_INPUT"] });
  });

  it("the half-kept limit is compared unrounded: 20016×10000 into 1:1 keeps 0.4996 and is refused, though it prints as 0.5", () => {
    const c = coverCrop({ width: 20016, height: 10000 }, variantOf("mobile_390", 300, 300));
    expect(c).toEqual({ ok: false, codes: ["RATIO_MISMATCH_EXTREME"], kept_area: 0.5, density: expect.any(Number) });
    expect(coverCrop({ width: 20000, height: 10000 }, variantOf("mobile_390", 300, 300)).ok).toBe(true);
  });

  it("a photo fits a slot only if it fits every viewport (the slot's shape changes between PC and SP)", () => {
    const inv = PhotoSlotInventory.parse(JSON.parse(readFileSync(resolve(REPO, `${POC}/sento/photo-slots.json`), "utf8")));
    const garden = inv.slots.find((s) => s.slot_id === "ph-garden")!;
    // an upright 3:4 photo: fine on SP (390×420), but the 1440 panorama (2.4:1) would keep under a third of it
    const r = fitSlot({ width: 3024, height: 4032 }, garden);
    expect(r.byViewport.mobile_390.ok).toBe(true);
    expect(r.byViewport.desktop_1440.ok).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.codes).toEqual(["RATIO_MISMATCH_EXTREME"]);
  });
});

describe("slot inventories of the three C pages", () => {
  const SHOPS = [
    { shop: "tsugute", dir: `${POC}/tsugute/fidelity/d1-v3`, count: 6 },
    { shop: "bicycle", dir: `${POC}/bicycle/fidelity/d1-v2`, count: 5 },
    { shop: "sento", dir: `${POC}/sento/fidelity/d1-v2`, count: 4 },
  ];
  const sha = (p: string) => createHash("sha256").update(readFileSync(resolve(REPO, p))).digest("hex");
  const load = (shop: string) => PhotoSlotInventory.parse(JSON.parse(readFileSync(resolve(REPO, `${POC}/${shop}/photo-slots.json`), "utf8")));

  it.each(SHOPS)("$shop: measured on the current page, one slot per 写真｜ caption and per ph-* copy item, labelled placeholder_limited", ({ shop, dir, count }) => {
    const inv = load(shop);
    expect(inv.page_dir).toBe(dir);
    expect(inv.evaluation_label).toBe("placeholder_limited");
    expect([inv.html_sha256, inv.css_sha256, inv.copy_sha256]).toEqual([sha(`${dir}/index.html`), sha(`${dir}/style.css`), sha(`${dir}/copy.json`)]);
    const html = readFileSync(resolve(REPO, dir, "index.html"), "utf8");
    const captions = [...html.matchAll(/写真｜([^<]+)</g)].map((m) => m[1]!.trim());
    expect(inv.slots.map((s) => s.role).sort()).toEqual(captions.sort());
    expect(inv.slots).toHaveLength(count);
    const copy = JSON.parse(readFileSync(resolve(REPO, dir, "copy.json"), "utf8")) as { shop_id: string; items: Array<{ id: string; text: string }> };
    expect(inv.shop_id).toBe(copy.shop_id);
    const ph = copy.items.filter((i) => i.id.startsWith("ph-"));
    expect(inv.slots.map((s) => s.slot_id).sort()).toEqual(ph.map((i) => i.id).sort());
    for (const s of inv.slots) {
      expect(ph.find((i) => i.id === s.slot_id)!.text).toBe(`写真｜${s.role}`);
      expect(s.variants.map((v) => v.viewport)).toEqual([...SLOT_VIEWPORTS]);
      for (const v of s.variants) {
        // 2× the board (the board's size is fractional; the recorded box is rounded)
        expect(Math.abs(v.min_width_px - 2 * v.width_px), `${s.slot_id} ${v.viewport}`).toBeLessThanOrEqual(2);
        expect(Math.abs(v.min_height_px - 2 * v.height_px), `${s.slot_id} ${v.viewport}`).toBeLessThanOrEqual(2);
      }
    }
  });

  it("the CSS aspect-ratios the pages declare are the ones measured at 1440", () => {
    const declared: Record<string, Record<string, string>> = {
      tsugute: { "ph-ware": "560/400", "ph-kake": "420/330", "ph-hibi": "600/330", "ph-dry": "340/500", "ph-hand": "640/560", "ph-desk": "440/320" },
      bicycle: { "ph-a": "360/260", "ph-b": "300/220", "ph-c": "330/240", "ph-d": "300/330", "ph-bench": "760/560" },
      sento: { "ph-tub": "720/520", "ph-surface": "380/300", "ph-garden": "1440/600", "ph-mural": "660/600" },
    };
    for (const [shop, slots] of Object.entries(declared)) {
      const inv = load(shop);
      for (const [id, ratio] of Object.entries(slots)) {
        const [a, b] = ratio.split("/").map(Number);
        const v = inv.slots.find((s) => s.slot_id === id)!.variants.find((x) => x.viewport === "desktop_1440")!;
        expect(Math.abs(v.ratio - a! / b!), `${shop} ${id}`).toBeLessThan(0.01);
      }
    }
  });

  it.each(SHOPS)("$shop: the photo asked of the owner for each slot (one common shape, least size) fits every viewport, and a smaller one does not", ({ shop }) => {
    for (const s of load(shop).slots) {
      const r = requestFor(s);
      expect(r.ok, s.slot_id).toBe(true);
      if (!r.ok) continue;
      expect(fitSlot({ width: r.min_width_px, height: r.min_height_px }, s).ok, s.slot_id).toBe(true);
      const smaller = fitSlot({ width: Math.floor(r.min_width_px * 0.9), height: Math.floor(r.min_height_px * 0.9) }, s);
      expect(smaller.codes, s.slot_id).toEqual(["PHOTO_TOO_SMALL"]);
    }
  });

  it("a slot whose PC and SP shapes are too far apart for one photo says so instead of asking for a bad one", () => {
    const slot = { ...load("sento").slots[0]!, variants: [variantOf("desktop_1440", 1440, 300), variantOf("tablet_1024", 1024, 300), variantOf("tablet_768", 768, 300), variantOf("mobile_390", 200, 600)] };
    expect(requestFor(slot)).toMatchObject({ ok: false, code: "NO_SINGLE_SHAPE" });
  });

  describe("re-measured in the browser", () => {
    let browser: Browser;
    beforeAll(async () => {
      browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
    });
    afterAll(async () => {
      await browser?.close();
    });
    it.each(SHOPS)("$shop: the committed inventory is what the page measures now (boards, selectors, sizes within 2px)", async ({ shop, dir }) => {
      const now = await deriveSlots(browser, shop, dir);
      const saved = load(shop);
      expect(now.slots.map((s) => [s.slot_id, s.board_selector, s.section, s.placeholder])).toEqual(saved.slots.map((s) => [s.slot_id, s.board_selector, s.section, s.placeholder]));
      for (const [i, s] of now.slots.entries())
        for (const [j, v] of s.variants.entries()) {
          const w = saved.slots[i]!.variants[j]!;
          expect(Math.abs(v.width_px - w.width_px), `${shop} ${s.slot_id} ${v.viewport}`).toBeLessThanOrEqual(2);
          expect(Math.abs(v.height_px - w.height_px), `${shop} ${s.slot_id} ${v.viewport}`).toBeLessThanOrEqual(2);
        }
    }, 120_000);
  });
});

describe("no photo enters the public repository", () => {
  /**
   * Every image file in the repository (tracked, or untracked and not ignored) before DEV-163, pinned: the app's icons,
   * the brand and concept pictures under public/, the success-case previews and the 64px research boards. A new
   * image anywhere in the tree fails this test.
   */
  const EXISTING = [
    "app/apple-icon.png",
    "design-library/research/quality-pipeline/poc/bicycle/impl/d1-a/assets/board.png",
    "design-library/research/quality-pipeline/poc/bicycle/impl/d1-b/assets/board.png",
    "design-library/research/quality-pipeline/poc/sento/impl/d1-a/assets/board.png",
    "design-library/research/quality-pipeline/poc/sento/impl/d1-b/assets/board.png",
    "design-library/research/quality-pipeline/poc/sento/impl/d1-b/assets/garden.png",
    "design-library/research/quality-pipeline/poc/sento/impl/d1-b/assets/mural.png",
    "design-library/research/quality-pipeline/poc/tsugute/impl/d1-v2-a/assets/board.png",
    "design-library/research/quality-pipeline/poc/tsugute/impl/d1-v2-b/assets/board.png",
    "design-library/success-cases/assets/CP-001_Mond.webp",
    "design-library/success-cases/assets/CP-002_Sissi.webp",
    "design-library/success-cases/assets/CP-003_NagoyaBeans_v4_desktop.webp",
    "design-library/success-cases/assets/CP-003_NagoyaBeans_v4_mobile.webp",
    "public/brand-photos/desk-laptop-back-daylight.jpg",
    "public/brand-photos/desk-night-crop.jpg",
    "public/brand-photos/hero-shop-entrance.webp",
    "public/brand-photos/notebook-wireframe-wide.jpg",
    "public/brand-photos/office-room-wide.jpg",
    "public/brand-photos/philosophy-still-life.webp",
    "public/brand-photos/table-shadow-empty.jpg",
    "public/brand-photos/wall-shadow-plant-a.jpg",
    "public/concept-work/hoshi-no-cha.jpg",
    "public/concept-work/midori-seitai.webp",
    "public/concept-work/yasashii-beauty-salon.webp",
    "public/icons/icon-192.png",
    "public/icons/icon-512.png",
    "public/og-image.jpg",
    "public/screenshots-source/access-mobile-portrait.jpeg",
    "public/screenshots-source/entrance-photo-crop.jpg",
    "public/screenshots-source/exterior-photo-crop.jpg",
    "public/screenshots-source/home-mobile.jpeg",
    "public/screenshots-source/interior-photo-crop.jpeg",
    "public/screenshots-source/interior-photo.jpeg",
    "public/screenshots-source/menu-desktop.jpg",
  ];

  it("no image file is added anywhere in the repository (tracked or about to be), and the research boards stay 64×64", () => {
    const listed = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).stdout.trim().split("\n").filter(Boolean);
    const images = listed.filter((p) => /\.(png|jpe?g|webp|gif|avif|heic|heif|bmp|tiff?)$/i.test(p));
    expect(images.sort()).toEqual([...EXISTING].sort());
    for (const p of EXISTING.filter((x) => x.includes("/research/"))) {
      const info = measurePhotoBytes(readFileSync(resolve(REPO, p)));
      expect(info, p).not.toBeNull();
      expect([info!.width, info!.height], p).toEqual([64, 64]);
    }
  });

  it("nothing under .intake is tracked", () => {
    const tracked = spawnSync("git", ["ls-files", "design-library/research/quality-pipeline/.intake"], { cwd: REPO, encoding: "utf8" }).stdout.trim();
    expect(tracked).toBe("");
  });
});
