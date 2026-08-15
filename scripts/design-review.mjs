import { chromium } from "playwright";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, "..", "public", "_verify");

const sections = [
  "home", "philosophy", "works", "services", "process",
  "pricing", "founder", "faq", "contact",
];

async function scrollReal(page) {
  const totalHeight = await page.evaluate(() => document.body.scrollHeight);
  for (let y = 0; y < totalHeight; y += 350) {
    await page.mouse.wheel(0, 350);
    await page.waitForTimeout(90);
  }
  await page.waitForTimeout(500);
}

async function captureViewport(width, height, label, isMobile = false) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width, height }, isMobile });
  const page = await context.newPage();
  await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
  await scrollReal(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);

  for (const id of sections) {
    const el = await page.$("#" + id);
    if (!el) continue;
    await el.scrollIntoViewIfNeeded();
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(outDir, `${label}-${id}.png`) });
  }

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  console.log(`${label} overflow:`, overflow);
  await browser.close();
}

await captureViewport(1440, 1000, "desktop");
await captureViewport(834, 1194, "tablet");
await captureViewport(390, 844, "mobile", true);

console.log("done");
