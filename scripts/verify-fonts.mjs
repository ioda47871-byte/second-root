import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });

const res = await page.goto("http://localhost:3000", { waitUntil: "networkidle", timeout: 30000 });
console.log("status:", res.status());
await page.waitForTimeout(1500);

const fontInfo = await page.evaluate(() => {
  const h1 = document.querySelector(".hero-title");
  const eyebrow = document.querySelector(".hero-eyebrow");
  const body = document.body;
  return {
    h1Font: h1 ? getComputedStyle(h1).fontFamily : null,
    eyebrowFont: eyebrow ? getComputedStyle(eyebrow).fontFamily : null,
    bodyFont: getComputedStyle(body).fontFamily,
    bg: getComputedStyle(body).backgroundColor,
  };
});
console.log("fonts:", JSON.stringify(fontInfo, null, 2));
console.log("console/page errors:", errors.length ? errors.slice(0, 10) : "none");

await browser.close();
