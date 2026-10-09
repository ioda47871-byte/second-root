// TESTS ONLY. Runs the worker's page callbacks the way production does: this
// file is executed by tsx (esbuild with keepNames, like run.sh / worker.ts),
// and the callbacks run in real Chromium. Vitest's own transform does not keep
// names, so a callback that only breaks under tsx (`__name is not defined`)
// passes every in-process test; this harness is what catches it.
//
//   tsx tests/support/page-callbacks-tsx.ts   → one JSON line: { ok: true, … } or { ok: false, error }
import { chromium } from "playwright";
import { capturePage } from "../../lib/design-agent/preview-server";
import { hideAccountChrome, mediaRects } from "../../lib/design-agent/worker/capture";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PAGE = `<!doctype html><html><body style="margin:0">
  <section data-photo-section="hero" style="height:500px"><figure data-asset="asset-aaaaaaaaaaaaaaaaaaaaaaaa" data-role="hero" style="margin:0"><img src="${PIXEL}" style="width:300px;height:300px"><span data-image-label="">イメージ画像</span></figure><h1>Name</h1></section>
  <div style="height:3000px"></div>
  <section data-photo-section="visit" style="height:400px"><figure data-asset="asset-bbbbbbbbbbbbbbbbbbbbbbbb" data-role="visit" style="margin:0"><img src="${PIXEL}" style="width:300px;height:200px"></figure></section>
</body></html>`;

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "page-callbacks-"));
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.setContent(PAGE);
    const captured = await capturePage(page, { path: join(dir, "m.png"), mobile: true, sectionPrefix: join(dir, "m-section") });
    const rects = await mediaRects(page, "blur(1px)");
    const hidden = await hideAccountChrome(page);
    process.stdout.write(`${JSON.stringify({ ok: true, sections: captured.sections.length, placed: captured.placed, rects: rects.length, hidden })}\n`);
  } finally {
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message.split("\n")[0] : String(error) })}\n`);
  process.exit(1);
});
