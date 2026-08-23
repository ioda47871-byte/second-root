import { chromium } from "playwright";
const BASE = "http://127.0.0.1:3200";
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
let bad = 0;
const ok = (l, c, x = "") => { if (!c) bad++; console.log(`${c ? "✓" : "✗"} ${l}${x ? "  " + x : ""}`); };

for (const w of [1440, 1280, 1024, 860, 834, 390, 360]) {
  const ctx = await b.newContext({ viewport: { width: w, height: 900 }, isMobile: w < 700, hasTouch: w < 700 });
  const p = await ctx.newPage();
  const errs = [], failed = [];
  p.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  p.on("pageerror", (e) => errs.push("pageerror: " + e.message));
  p.on("response", (r) => r.status() >= 400 && failed.push(`${r.status()} ${new URL(r.url()).pathname}`));

  await p.goto(BASE + "/", { waitUntil: "networkidle" });
  await p.evaluate(async () => {
    const step = window.innerHeight;
    for (let y = 0; y < document.body.scrollHeight; y += step) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 80)); }
  });
  await p.waitForTimeout(500);

  const r = await p.evaluate(() => {
    const de = document.documentElement;
    const items = [...document.querySelectorAll(".concept-item")];
    const thumbs = items.map(i => i.querySelector(".concept-thumb").getBoundingClientRect());
    const tops = thumbs.map(t => Math.round(t.top));
    const heights = thumbs.map(t => Math.round(t.height));
    const cols = new Set(thumbs.map(t => Math.round(t.left))).size;
    const overflow = [...document.querySelectorAll("body *")].filter(el => {
      if (el.closest("svg")) return false;
      const cs = getComputedStyle(el);
      if (cs.position === "absolute" || cs.position === "fixed") return false;
      const b = el.getBoundingClientRect();
      return b.width > 0 && (b.right > de.clientWidth + 1 || b.left < -1);
    }).map(el => el.tagName + "." + (el.className || "").toString().slice(0, 40));
    const broken = [...document.images].filter(i => !i.naturalWidth).map(i => i.currentSrc || i.src);
    return {
      scrollW: de.scrollWidth, clientW: de.clientWidth,
      count: items.length, cols, tops, heights,
      sameRow: new Set(tops).size === 1,
      equalH: new Set(heights).size === 1,
      overflow: overflow.slice(0, 3), broken,
      brot: document.body.innerText.includes("Brot Yanagi"),
    };
  });

  const expectCols = w >= 860 ? 3 : 1;
  ok(`${String(w).padStart(4)}px 3件表示`, r.count === 3, `${r.count}件`);
  ok(`${String(w).padStart(4)}px ${expectCols}列レイアウト`, r.cols === expectCols, `列数${r.cols} / 高さ${r.heights.join(",")}`);
  ok(`${String(w).padStart(4)}px サムネイル枠の高さ揃い`, r.equalH);
  ok(`${String(w).padStart(4)}px 横スクロールなし`, r.scrollW <= r.clientW + 1 && !r.overflow.length, r.overflow.join(" | "));
  ok(`${String(w).padStart(4)}px 画像404なし`, !r.broken.length && !failed.length, [...r.broken, ...failed].join(" | "));
  ok(`${String(w).padStart(4)}px コンソールエラーなし`, !errs.length, errs.slice(0, 2).join(" | "));
  ok(`${String(w).padStart(4)}px Brot Yanagi 表示`, r.brot);
  await ctx.close();
}
console.log(bad ? `\n${bad} 件の不具合` : "\nすべて正常");
await b.close();
process.exit(bad ? 1 : 0);
