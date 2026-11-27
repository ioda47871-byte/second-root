import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildSite } from "@/experiments/pages-cms/build";
import { ContentError } from "@/experiments/pages-cms/content-model";
import { Q1_TODAY, q1Fixtures, writeFixture } from "@/experiments/pages-cms/fixtures";
import { imageMeta, isHeif } from "@/experiments/pages-cms/image-meta";
import { checkPhoto, PHOTO_ADVICE, PHOTO_LIMITS } from "@/experiments/pages-cms/photos";

// Issue #380 (owner 2026-11-27, phone photos): what today's build does with what an iPhone actually produces —
// full-size JPEGs (4032×3024, 3–8 MB; 48 MP 8064×6048) and HEIC — against the current limits (2 MiB / 4096 px / 16 MP;
// JPEG / PNG / WebP only). SYNTHETIC bytes only: a JPEG start-of-frame header padded to the size a phone writes (the
// limits read the header and the byte count, nothing is decoded), and a HEIC `ftyp` box. No real photo anywhere.
// Research and the plan: docs/design/pages-cms-phone-photos.md.

const temps: string[] = [];
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "sr-pcms-phone-")));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
const MB = 1024 * 1024;
/** A baseline JPEG header (SOI, APP0, SOF0 with the size), padded with zeros to `bytes`. */
const phoneJpeg = (w: number, h: number, bytes: number) => {
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03]);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, bytes - head.length))]);
};
/** An iPhone HEIC's start: an `ftyp` box with major brand heic and compatible brands mif1 / heic (then padding). */
const heic = (major = "heic", compatible = ["mif1", "heic"]) => {
  const box = Buffer.concat([Buffer.alloc(4), Buffer.from("ftyp"), Buffer.from(major), Buffer.alloc(4), ...compatible.map((c) => Buffer.from(c))]);
  box.writeUInt32BE(box.length, 0);
  return Buffer.concat([box, Buffer.alloc(2 * 1024)]);
};
const codeOf = (f: () => unknown) => {
  try {
    f();
    return "ok";
  } catch (e) {
    return e instanceof ContentError ? e.code : String(e);
  }
};

describe("Issue #380: iPhone photos against today's limits (synthetic)", () => {
  it("a full-size 12 MP iPhone JPEG (4032×3024) passes the pixel limits but not the byte limit at 3–8 MB; under 2 MiB it passes", () => {
    expect(4032 * 3024).toBeLessThan(PHOTO_LIMITS.maxPixels);
    for (const mb of [3, 5, 8]) expect(codeOf(() => checkPhoto("IMG_0001.JPG", phoneJpeg(4032, 3024, mb * MB))), `${mb} MB`).toBe("CONTENT_PHOTO_TOO_LARGE");
    // portrait (the phone held upright writes 3024×4032, or 4032×3024 with an EXIF orientation: the limits are symmetric)
    expect(codeOf(() => checkPhoto("IMG_0002.jpeg", phoneJpeg(3024, 4032, 3 * MB)))).toBe("CONTENT_PHOTO_TOO_LARGE");
    expect(checkPhoto("IMG_0003.JPG", phoneJpeg(4032, 3024, PHOTO_LIMITS.bytes))).toMatchObject({ format: "jpeg", width: 4032, height: 3024, bytes: PHOTO_LIMITS.bytes });
    expect(codeOf(() => checkPhoto("IMG_0003.JPG", phoneJpeg(4032, 3024, PHOTO_LIMITS.bytes + 1)))).toBe("CONTENT_PHOTO_TOO_LARGE");
  });

  it("a 48 MP JPEG (8064×6048) is refused by its pixel size even when small in bytes; 4000×3000 phone shots pass", () => {
    expect(codeOf(() => checkPhoto("IMG_0004.JPG", phoneJpeg(8064, 6048, 1 * MB)))).toBe("CONTENT_PHOTO_DIMENSIONS");
    expect(codeOf(() => checkPhoto("IMG_0005.JPG", phoneJpeg(4000, 3000, 1 * MB)))).toBe("ok");
    // a 16:9 crop of a 12 MP shot (4032×2268) and a panorama strip (beyond 3:1)
    expect(codeOf(() => checkPhoto("IMG_0006.JPG", phoneJpeg(4032, 2268, 1 * MB)))).toBe("ok");
    expect(codeOf(() => checkPhoto("IMG_0007.JPG", phoneJpeg(4096, 1200, 1 * MB)))).toBe("CONTENT_PHOTO_RATIO");
  });

  it("HEIC is recognised by its bytes and refused by name (CONTENT_PHOTO_HEIC), whatever the file is called", () => {
    for (const [major, compat] of [
      ["heic", ["mif1", "heic"]],
      ["mif1", ["heic"]],
      ["heix", []],
      ["avif", ["mif1"]],
    ] as const) {
      expect(isHeif(heic(major, [...compat])), major).toBe(true);
      expect(imageMeta(heic(major, [...compat])), major).toBeNull();
    }
    expect(isHeif(heic("isom", ["mp41"]))).toBe(false); // an MP4, not HEIF
    // an ftyp box claiming to run to the end (size 0) or a huge size is read only to its first 64 bytes
    const runaway = heic("isom", ["mp41"]);
    runaway.writeUInt32BE(0xffffffff, 0);
    runaway.write("heic", 200, "latin1");
    expect(isHeif(runaway)).toBe(false);
    expect(isHeif(phoneJpeg(4032, 3024, 4096))).toBe(false);
    // a HEIC renamed .jpg (reported for converted / shared files) is named for what it is
    expect(codeOf(() => checkPhoto("IMG_0008.jpg", heic()))).toBe("CONTENT_PHOTO_HEIC");
    // a non-image under a picture name stays the generic type error
    expect(codeOf(() => checkPhoto("IMG_0009.jpg", Buffer.from("not a picture at all, just text bytes")))).toBe("CONTENT_PHOTO_TYPE");
  });

  it("in a build: a .HEIC path is refused by the content model (the CMS media settings do not offer it either); HEIC bytes as .jpg and a full-size JPEG stop the build by name (a stopped build writes nothing)", async () => {
    const repo = join(tmp(), "repo");
    await writeFixture(repo, q1Fixtures()["items-3"]!);
    const item = join(repo, "content", "menu", "item-1.json");
    const original = readFileSync(item);
    const withImage = async (name: string, bytes: Buffer) => {
      writeFileSync(join(repo, "media", name), bytes);
      writeFileSync(item, JSON.stringify({ ...(JSON.parse(original.toString("utf8")) as object), image: `/media/${name}`, imageKind: "customer_cms" }));
      const out = join(tmp(), "dist");
      return buildSite({ repo, outDir: out, today: Q1_TODAY }).then(
        () => "ok",
        (e: unknown) => {
          expect(existsSync(out)).toBe(false);
          return e instanceof ContentError ? `${e.code} ${e.file.replace(/^.*\/content\//, "content/")}` : String(e);
        },
      );
    };
    expect(await withImage("IMG_0001.HEIC", heic())).toBe("CONTENT_INVALID content/menu/item-1.json");
    expect(await withImage("IMG_0001.jpg", heic())).toBe("CONTENT_PHOTO_HEIC IMG_0001.jpg");
    expect(await withImage("IMG_0002.JPG", phoneJpeg(4032, 3024, 4 * MB))).toBe("CONTENT_PHOTO_TOO_LARGE IMG_0002.JPG");
    // #384 review M: a typical 1.5–3 MB HEIC saved as .jpg is named HEIC first (never "make it smaller" first)
    const bigHeic = Buffer.concat([heic(), Buffer.alloc(3 * MB)]);
    expect(await withImage("big.jpg", bigHeic)).toBe("CONTENT_PHOTO_HEIC big.jpg");
    expect(codeOf(() => checkPhoto("big.jpg", bigHeic))).toBe("CONTENT_PHOTO_HEIC");
  });

  it("every photo code has plain customer advice; the HEIC advice names the iPhone setting (互換性優先) and the limits match PHOTO_LIMITS", () => {
    const photoCodes = ["CONTENT_PHOTO_MISSING", "CONTENT_PHOTO_TYPE", "CONTENT_PHOTO_HEIC", "CONTENT_PHOTO_TOO_LARGE", "CONTENT_PHOTO_DIMENSIONS", "CONTENT_PHOTO_TOO_SMALL", "CONTENT_PHOTO_RATIO"];
    expect(Object.keys(PHOTO_ADVICE).sort()).toEqual(photoCodes.sort());
    expect(PHOTO_ADVICE.CONTENT_PHOTO_HEIC).toContain("「設定」→「カメラ」→「フォーマット」");
    expect(PHOTO_ADVICE.CONTENT_PHOTO_HEIC).toContain("互換性優先");
    expect(PHOTO_ADVICE.CONTENT_PHOTO_TOO_LARGE).toContain(`${PHOTO_LIMITS.bytes / MB}MB`);
    expect(PHOTO_ADVICE.CONTENT_PHOTO_DIMENSIONS).toContain(`${PHOTO_LIMITS.maxSide}px`);
    for (const text of Object.values(PHOTO_ADVICE)) expect(text).not.toMatch(/[<>]|https?:/);
  });
});
