import { chromium } from "playwright";

const widths = [
  { label: "Desktop 1920", width: 1920, height: 1080 },
  { label: "Laptop 1440", width: 1440, height: 900 },
  { label: "Tablet 1024", width: 1024, height: 1366 },
  { label: "Tablet 768", width: 768, height: 1024 },
  { label: "Phone 430", width: 430, height: 932 },
  { label: "Phone 390", width: 390, height: 844 },
  { label: "Phone 375", width: 375, height: 812 },
];

const browser = await chromium.launch();
let anyFailure = false;

for (const bp of widths) {
  const page = await (await browser.newContext({ viewport: { width: bp.width, height: bp.height } })).newPage();
  await page.goto("http://localhost:3000", { waitUntil: "networkidle" });

  const results = await page.evaluate(() => {
    const paras = Array.from(document.querySelectorAll(".photo-band-content p"));
    return paras.map((p, pi) => {
      // split this <p>'s children into segments between <br> elements
      const segments = [];
      let current = [];
      for (const node of Array.from(p.childNodes)) {
        if (node.nodeName === "BR") {
          segments.push(current);
          current = [];
        } else {
          current.push(node);
        }
      }
      segments.push(current);

      const segmentResults = segments.map((nodes) => {
        const text = nodes.map((n) => n.textContent).join("").trim();
        if (!text) return null;
        // measure line count via Range.getClientRects on the text node(s)
        const range = document.createRange();
        const textNode = nodes.find((n) => n.nodeType === 3 && n.textContent.trim());
        if (!textNode) return { text, lines: 0 };
        range.selectNodeContents(textNode);
        const rects = range.getClientRects();
        // merge rects that are on the same line (similar top) to count visual lines
        const tops = Array.from(rects).map((r) => Math.round(r.top));
        const uniqueLines = new Set(tops).size;
        return { text, lines: uniqueLines };
      }).filter(Boolean);

      return { index: pi, segments: segmentResults };
    });
  });

  let bpFailed = false;
  for (const p of results) {
    for (const seg of p.segments) {
      if (seg.lines > 1) {
        bpFailed = true;
        anyFailure = true;
        console.log(`[FAIL] ${bp.label} (${bp.width}px) — paragraph #${p.index}: "${seg.text}" wrapped into ${seg.lines} lines`);
      }
    }
  }
  if (!bpFailed) console.log(`[OK]   ${bp.label} (${bp.width}px) — all segments render as single lines`);

  await page.close();
}

await browser.close();
console.log(anyFailure ? "\nRESULT: issues found" : "\nRESULT: all clear");
process.exit(anyFailure ? 1 : 0);
