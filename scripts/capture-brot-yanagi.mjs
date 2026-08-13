import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, "..", "public", "screenshots");
mkdirSync(outDir, { recursive: true });

const BASE = "https://mugi-no-mi-nextjs-2-mujq-dv0g92t0v-brot-yanagi.vercel.app";

const targets = [
  { path: "/", file: "brot-yanagi-home-desktop.png", viewport: { width: 1440, height: 900 } },
  { path: "/menu", file: "brot-yanagi-menu-desktop.png", viewport: { width: 1440, height: 900 } },
  { path: "/", file: "brot-yanagi-home-mobile.png", viewport: { width: 390, height: 844 }, isMobile: true },
  { path: "/menu", file: "brot-yanagi-menu-mobile.png", viewport: { width: 390, height: 844 }, isMobile: true },
];

const browser = await chromium.launch();

for (const t of targets) {
  const context = await browser.newContext({
    viewport: t.viewport,
    isMobile: !!t.isMobile,
    hasTouch: !!t.isMobile,
    deviceScaleFactor: t.isMobile ? 2 : 1,
  });
  const page = await context.newPage();
  const url = BASE + t.path;
  console.log("Loading", url, "->", t.file);
  const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  console.log("  status:", res ? res.status() : "no response");
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(outDir, t.file) });
  await context.close();
}

await browser.close();
console.log("Done.");
