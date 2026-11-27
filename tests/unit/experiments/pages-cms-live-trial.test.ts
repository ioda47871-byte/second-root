import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasGps, scanMeta, scanTiff } from "@/experiments/pages-cms/exif-scan";
import { solidPng } from "@/experiments/pages-cms/fixtures";
import { checkUrl, imageSources, main, scanOriginals, scanPublished, waitForMarker } from "@/experiments/pages-cms/live-trial-measure";

// Issue #380 live trial: the read-only measurement tool. LOCAL only: a node:http server on 127.0.0.1 and hand-built
// synthetic pictures (no real photo, no network beyond the local machine).

/** A little-endian TIFF block: IFD0 with orientation and (optionally) a GPS IFD with one entry. */
function tiff(o: { orientation?: number; gps?: boolean }): Buffer {
  const entries: Buffer[] = [];
  const entry = (tag: number, type: number, count: number, value: number | Buffer) => {
    const e = Buffer.alloc(12);
    e.writeUInt16LE(tag, 0);
    e.writeUInt16LE(type, 2);
    e.writeUInt32LE(count, 4);
    if (typeof value !== "number") value.copy(e, 8);
    else if (type === 3) e.writeUInt16LE(value, 8);
    else e.writeUInt32LE(value, 8);
    return e;
  };
  if (o.orientation) entries.push(entry(0x0112, 3, 1, o.orientation));
  const ifd0Size = 2 + (entries.length + (o.gps ? 1 : 0)) * 12 + 4;
  if (o.gps) entries.push(entry(0x8825, 4, 1, 8 + ifd0Size));
  const head = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]);
  const count = Buffer.alloc(2);
  count.writeUInt16LE(entries.length);
  const ifd0 = Buffer.concat([count, ...entries, Buffer.alloc(4)]);
  const gps = o.gps ? Buffer.concat([Buffer.from([1, 0]), entry(0x0001, 2, 2, Buffer.from("N\0")), Buffer.alloc(4)]) : Buffer.alloc(0);
  return Buffer.concat([head, ifd0, gps]);
}
const segment = (marker: number, body: Buffer) => {
  const h = Buffer.from([0xff, marker, 0, 0]);
  h.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([h, body]);
};
/** A synthetic JPEG: SOI, optional Exif / XMP APP1, a SOF0 with the size, EOI. */
function jpeg(w: number, h: number, o: { exif?: Buffer; xmp?: string } = {}): Buffer {
  const sof = Buffer.from([0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    ...(o.exif ? [segment(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), o.exif]))] : []),
    ...(o.xmp ? [segment(0xe1, Buffer.concat([Buffer.from("http://ns.adobe.com/xap/1.0/\0", "latin1"), Buffer.from(o.xmp)]))] : []),
    segment(0xc0, sof),
    Buffer.from([0xff, 0xd9]),
  ]);
}

describe("the owner sheet's live-trial appendix", () => {
  it("has the 12 checks in order, each with the tool's commands where they apply, and the GPS distinction", () => {
    const sheet = readFileSync(join(__dirname, "../../../docs/design/cms-live-trial-owner-sheet.md"), "utf8");
    const appendix = sheet.slice(sheet.indexOf("## 付録 A."));
    const items = ["施工実績の追加・編集・削除", "1 件に複数枚の写真", "施工前・施工後", "スマートフォンからの更新", "4〜6 MB の JPEG", "自動の最適化", "GitHub への保存", "Cloudflare の自動公開", "反映までの時間", "編集者の権限の管理", "構築の失敗で前の公開が残る", "復旧"];
    let at = 0;
    items.forEach((item, k) => {
      const i = appendix.indexOf(`| ${k + 1} | ${item} |`, at);
      expect(i, item).toBeGreaterThan(at);
      at = i;
    });
    for (const cmd of ["TOOL wait --url URL --marker", "TOOL images --url URL", "TOOL originals --repo", "live-trial-measure.ts"]) expect(appendix, cmd).toContain(cmd);
    for (const p of ["~/second-root-trial/sr-cms-trial-autocare/", "~/second-root-trial/test-data/"]) expect(appendix, p).toContain(p);
    expect(appendix).toContain("repo の元の写真には GPS が残る");
    expect(appendix).toMatch(/未検証/);
    expect(appendix).not.toMatch(/sr-runs/);
  });
});

describe("exif-scan: metadata from the bytes", () => {
  it("finds EXIF, the orientation and a GPS block in a JPEG; nothing in a stripped one; XMP GPS too", () => {
    const phone = scanMeta(jpeg(4032, 3024, { exif: tiff({ orientation: 6, gps: true }) }));
    expect(phone).toEqual({ exif: true, gps: true, orientation: 6, xmp: false, xmpGps: false });
    expect(hasGps(phone)).toBe(true);
    expect(scanMeta(jpeg(4032, 3024, { exif: tiff({ orientation: 1 }) }))).toMatchObject({ exif: true, gps: false, orientation: 1 });
    expect(scanMeta(jpeg(1920, 2560))).toEqual({ exif: false, gps: false, orientation: null, xmp: false, xmpGps: false });
    const xmp = scanMeta(jpeg(800, 600, { xmp: '<x:xmpmeta><rdf:Description exif:GPSLatitude="35,0.0N"/></x:xmpmeta>' }));
    expect([xmp.xmp, xmp.xmpGps, hasGps(xmp)]).toEqual([true, true, true]);
    expect(scanMeta(solidPng(320, 320, [1, 2, 3]))).toMatchObject({ exif: false, gps: false });
  });

  it("PNG eXIf and WebP EXIF chunks are read; cut or malformed blocks read as nothing, never a crash", () => {
    const t = tiff({ gps: true });
    const png = solidPng(320, 320, [1, 2, 3]);
    const chunk = Buffer.concat([Buffer.alloc(4), Buffer.from("eXIf"), t, Buffer.alloc(4)]);
    chunk.writeUInt32BE(t.length, 0);
    const withExif = Buffer.concat([png.subarray(0, png.length - 12), chunk, png.subarray(png.length - 12)]);
    expect(scanMeta(withExif)).toMatchObject({ exif: true, gps: true });
    const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), t]);
    const ex = Buffer.concat([Buffer.from("EXIF"), Buffer.alloc(4), body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
    ex.writeUInt32LE(body.length, 4);
    const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), ex]);
    expect(scanMeta(webp)).toMatchObject({ exif: true, gps: true });
    expect(scanTiff(Buffer.from("IIxx"))).toBeNull();
    const full = jpeg(800, 600, { exif: tiff({ orientation: 6, gps: true }) });
    for (let cut = 2; cut < full.length; cut += 7) expect(() => scanMeta(full.subarray(0, cut))).not.toThrow();
    expect(scanMeta(Buffer.from("not an image"))).toMatchObject({ exif: false, gps: false });
  });
});

describe("live-trial-measure: URL rule, page images, originals, waiting (local server only)", () => {
  let server: Server;
  let base = "";
  let hits = 0;
  let appearAfter = Infinity;
  const files: Record<string, { type: string; body: Buffer }> = {};
  beforeAll(async () => {
    files["/media/fitted.jpg"] = { type: "image/jpeg", body: jpeg(1920, 2560) };
    files["/media/leaky.jpg"] = { type: "image/jpeg", body: jpeg(4032, 3024, { exif: tiff({ orientation: 6, gps: true }) }) };
    files["/media/plain.png"] = { type: "image/png", body: solidPng(400, 300, [9, 9, 9]) };
    server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      if (path === "/") {
        hits++;
        const html = `<!doctype html><html><body><h3>${hits > appearAfter ? "架空車 試験 新規" : "架空車 タイプ1"}</h3><img src="media/fitted.jpg" alt=""><img alt="" src='/media/leaky.jpg'><img src="media/plain.png"><img src="media/fitted.jpg"><img src="https://elsewhere.invalid/x.jpg"></body></html>`;
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(html);
      }
      const f = files[path];
      if (!f) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { "content-type": f.type, "content-length": f.body.length });
      res.end(f.body);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("refuses anything but https (http only on the local machine) and URLs carrying credentials", () => {
    for (const bad of ["http://example.com/", "ftp://example.com/", "https://user:pw@example.com/", "not a url", "file:///etc/passwd"]) expect(() => checkUrl(bad), bad).toThrow(/MEASURE_URL_REFUSED/);
    expect(checkUrl("https://sr-cms-trial-autocare.pages.dev/").hostname).toBe("sr-cms-trial-autocare.pages.dev");
    expect(checkUrl("http://127.0.0.1:8080/").port).toBe("8080");
    const { same, skipped } = imageSources('<img src="a.jpg"><img src="//other.invalid/b.jpg"><img src="/c.png">', new URL("https://shop.pages.dev/dir/"));
    expect(same.map((u) => u.href)).toEqual(["https://shop.pages.dev/dir/a.jpg", "https://shop.pages.dev/c.png"]);
    expect(skipped).toEqual(["//other.invalid/b.jpg"]);
  });

  it("images: each published picture once (same origin), with bytes, pixel size and whether it carries EXIF / GPS", async () => {
    const r = await scanPublished({ url: base });
    expect(r.images.map((i) => [i.src, i.status, i.format, i.width, i.height, i.exif, i.gps])).toEqual([
      ["/media/fitted.jpg", 200, "jpeg", 1920, 2560, false, false],
      ["/media/leaky.jpg", 200, "jpeg", 4032, 3024, true, true],
      ["/media/plain.png", 200, "png", 400, 300, false, false],
    ]);
    expect(r.images[1]!.orientation).toBe(6);
    expect(r.with_gps).toEqual(["/media/leaky.jpg"]);
    expect(r.skipped).toEqual(["https://elsewhere.invalid/x.jpg"]);
    expect((await main(["images", "--url", base])).code).toBe(0);
  });

  it("wait: polls until the marker appears and reports the time; a timeout is exit 1; bad arguments are exit 2", async () => {
    let t = 0;
    hits = 0;
    appearAfter = 3;
    const found = await waitForMarker({ url: base, marker: "架空車 試験 新規", intervalMs: 10_000, timeoutMs: 600_000, now: () => t, sleep: async (ms) => void (t += ms) });
    expect([found.status, found.attempts, found.elapsed_ms]).toEqual(["found", 4, 30_000]);
    appearAfter = Infinity;
    t = 0;
    const late = await waitForMarker({ url: base, marker: "来ない文字", intervalMs: 10_000, timeoutMs: 25_000, now: () => t, sleep: async (ms) => void (t += ms) });
    // polls at 0 s, 10 s and 20 s; the next one (30 s) would pass the 25 s limit
    expect([late.status, late.attempts]).toEqual(["timeout", 3]);
    expect((await main(["wait", "--url", base])).code).toBe(2);
    expect((await main(["wait", "--url", "http://example.com/", "--marker", "x"])).out).toMatchObject({ status: "refused", code: "MEASURE_URL_REFUSED" });
    expect((await main(["nope"])).code).toBe(2);
  });

  it("originals: every file in a checkout's media/, whether it still holds GPS, and whether the content uses it (read only)", async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "sr-trial-orig-")));
    try {
      mkdirSync(join(repo, "media"));
      mkdirSync(join(repo, "content", "works"), { recursive: true });
      writeFileSync(join(repo, "media", "IMG_0001.JPG"), files["/media/leaky.jpg"]!.body);
      writeFileSync(join(repo, "media", "job-1-1.png"), solidPng(640, 480, [1, 1, 1]));
      writeFileSync(join(repo, "content", "works", "a.json"), JSON.stringify({ id: "a", photos: [{ image: "/media/IMG_0001.JPG" }] }));
      const before = readFileSync(join(repo, "media", "IMG_0001.JPG"));
      const r = await scanOriginals({ repo });
      expect(r.files.map((f) => [f.file, f.referenced, f.format, f.gps, f.orientation])).toEqual([
        ["IMG_0001.JPG", true, "jpeg", true, 6],
        ["job-1-1.png", false, "png", false, null],
      ]);
      expect(r.with_gps).toEqual(["IMG_0001.JPG"]);
      expect(readFileSync(join(repo, "media", "IMG_0001.JPG")).equals(before)).toBe(true);
      expect((await main(["originals", "--repo", join(repo, "missing")])).out).toMatchObject({ code: "MEASURE_REPO_INVALID" });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
