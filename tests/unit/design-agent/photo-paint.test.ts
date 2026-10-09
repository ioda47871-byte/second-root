import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { capturePage } from "@/lib/design-agent/preview-server";
import { colourVariety, decodePng } from "@/lib/design-agent/worker/png-paint";

// DEV-029 regression (poc-photo-004): on the mobile shot the About photo was
// loaded (complete, naturalWidth) but painted as an empty frame, because the
// full-page screenshot was taken before Chromium had decoded an image far below
// the viewport. The review rightly called it a renderer problem; the render
// check passed (it only saw complete / naturalWidth / box). A large, detailed
// photo below the fold reproduces it every time: the old capturePage painted
// it as one flat colour. capturePage now decodes every photo first.

vi.setConfig({ testTimeout: 120_000 });

function png(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      const at = y * (width * 3 + 1) + 1 + x * 3;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 1 })), chunk("IEND", Buffer.alloc(0))]);
}

// A detailed photo (slow to decode) and a small one.
const DETAILED = png(2400, 3000, (x, y) => {
  const h = Math.imul(x * 73856093 ^ y * 19349663, 2654435761) >>> 0;
  return [h & 255, (h >>> 8) & 255, (h >>> 16) & 255];
});
const SMALL = png(400, 500, (x, y) => [180 - (y % 60), 120 + (x % 90), 90]);

const figure = (id: string, role: string, src: string, ar: string) =>
  `<figure data-asset="${id}" data-role="${role}" style="margin:0;position:relative;overflow:hidden;aspect-ratio:${ar};background:#fbf4e6"><img src="${src}" alt="" loading="eager" decoding="async" style="display:block;width:100%;height:100%;object-fit:cover"><span data-image-label="" style="position:absolute;top:8px;left:8px;background:#f4e8d2">イメージ画像</span></figure>`;
const PAGE = (aboutSrc: string) => `<!doctype html><html lang="ja"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f4e8d2;font:16px sans-serif">
  <section data-photo-section="hero" style="padding:20px">${figure("asset-aaaaaaaaaaaaaaaaaaaaaaaa", "hero", "/small.png", "4/5")}<h1>Name</h1></section>
  <div style="height:1500px"></div>
  <section data-photo-section="about" style="padding:20px"><p>About</p>${figure("asset-bbbbbbbbbbbbbbbbbbbbbbbb", "about", aboutSrc, "3/2")}</section>
  <div style="height:300px"></div>
</body></html>`;

let server: Server;
let base: string;
let browser: Browser;
const dir = mkdtempSync(join(tmpdir(), "photo-paint-"));
beforeAll(async () => {
  server = createServer((req, res) => {
    const send = (type: string, body: Buffer | string, status = 200) => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };
    if (req.url === "/detailed") return send("text/html", PAGE("/detailed.png"));
    if (req.url === "/broken") return send("text/html", PAGE("/missing.png"));
    if (req.url === "/detailed.png") return send("image/png", DETAILED);
    if (req.url === "/small.png") return send("image/png", SMALL);
    return send("text/plain", "not found", 404);
  }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
});
afterAll(async () => {
  await browser?.close();
  server?.close();
});

async function captureMobile(path: string) {
  // the worker's mobile context (screenshotPage)
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
  try {
    const page = await context.newPage();
    await page.goto(`${base}${path}`, { waitUntil: "networkidle" });
    const shot = join(dir, `${path.slice(1)}.png`);
    const result = await capturePage(page, { path: shot, mobile: true, sectionPrefix: join(dir, `${path.slice(1)}-section`) });
    return { result, pixels: decodePng(readFileSync(shot)) };
  } finally {
    await context.close();
  }
}

describe("every photo is painted in the screenshot, not an empty frame (poc-photo-004)", () => {
  it("paints a loaded photo far below the fold on the mobile shot", async () => {
    const { result, pixels } = await captureMobile("/detailed");
    const about = result.placed.find((p) => p.role === "about")!;
    expect(about.visible).toBe(true);
    // an empty frame is one flat colour; the detailed photo shows hundreds
    expect(colourVariety(pixels, about.box!, 2)).toBeGreaterThan(100);
    const hero = result.placed.find((p) => p.role === "hero")!;
    expect(colourVariety(pixels, hero.box!, 2)).toBeGreaterThan(8);
  });

  it("reports a photo that cannot be decoded as not visible (the render check then blocks)", async () => {
    const { result } = await captureMobile("/broken");
    expect(result.placed.find((p) => p.role === "about")?.visible).toBe(false);
    expect(result.placed.find((p) => p.role === "hero")?.visible).toBe(true);
  });
});

describe("colour variety of a box", () => {
  it("tells an empty frame from a photo", () => {
    const flat = decodePng(png(200, 200, () => [251, 244, 230]));
    const photo = decodePng(SMALL);
    const box = { top: 0, bottom: 200, left: 0, right: 200 };
    expect(colourVariety(flat, box, 1)).toBe(1);
    expect(colourVariety(photo, box, 1)).toBeGreaterThan(8);
  });
});
