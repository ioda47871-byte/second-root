/**
 * DEV-124: a success-case reference image, made ready for Codex.
 *
 * - The bytes must be the registered file: the SHA-256 the manifest pins (open-direction.ts) and a WebP header.
 *   Anything else is refused before an approval is used.
 * - A full page is far taller than wide (CP-003 phone: 390 × 4502). Shown as is, a model scales it down until the
 *   text and details are lost. It is cut into columns placed side by side (read left to right), one PNG per
 *   reference: Codex's image input takes PNG copies only (codex.ts).
 * - Chromium does the decoding and drawing on a blank page with JavaScript off and every request aborted; the
 *   image is inlined, so nothing is fetched.
 */
import { createHash } from "node:crypto";
import type { Browser } from "playwright";
import { sheetColumns, type Reference } from "./open-direction";

export class ReferenceStop extends Error {
  constructor(readonly code: "REFERENCE_SHA_MISMATCH" | "REFERENCE_NOT_WEBP" | "REFERENCE_SIZE_MISMATCH") {
    super(code);
    this.name = "ReferenceStop";
  }
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Refuses bytes that are not exactly the registered WebP. */
export function checkReferenceBytes(bytes: Buffer, ref: Reference): void {
  if (sha256(bytes) !== ref.webp_sha256) throw new ReferenceStop("REFERENCE_SHA_MISMATCH");
  if (bytes.subarray(0, 4).toString("latin1") !== "RIFF" || bytes.subarray(8, 12).toString("latin1") !== "WEBP") throw new ReferenceStop("REFERENCE_NOT_WEBP");
}

/** The registered WebP as one PNG sheet of columns (each `width` wide, the page cut top to bottom). */
export async function referenceSheet(browser: Browser, bytes: Buffer, ref: Reference): Promise<{ png: Buffer; png_sha256: string; columns: number; sheet: { width: number; height: number } }> {
  checkReferenceBytes(bytes, ref);
  const columns = sheetColumns(ref.width, ref.height);
  const colHeight = Math.ceil(ref.height / columns);
  const gap = 12;
  const sheet = { width: columns * ref.width + (columns - 1) * gap, height: colHeight };
  const src = `data:image/webp;base64,${bytes.toString("base64")}`;
  const cols = Array.from({ length: columns }, (_, i) => `<div style="position:absolute;left:${i * (ref.width + gap)}px;top:0;width:${ref.width}px;height:${colHeight}px;overflow:hidden;background:#fff"><img src="${src}" style="position:absolute;left:0;top:${-i * colHeight}px;width:${ref.width}px;height:${ref.height}px"></div>`);
  const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: "block", viewport: { width: sheet.width, height: Math.min(sheet.height, 4000) }, deviceScaleFactor: 1 });
  try {
    await context.route("**/*", (route) => route.abort());
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body style="margin:0;background:#888;width:${sheet.width}px;height:${sheet.height}px;position:relative">${cols.join("")}</body></html>`, { waitUntil: "load" });
    const natural = (await page.evaluate("(() => { const i = document.images[0]; return [i.naturalWidth, i.naturalHeight]; })()")) as [number, number];
    if (natural[0] !== ref.width || natural[1] !== ref.height) throw new ReferenceStop("REFERENCE_SIZE_MISMATCH");
    const png = await page.screenshot({ fullPage: true, clip: { x: 0, y: 0, ...sheet }, animations: "disabled" });
    return { png, png_sha256: sha256(png), columns, sheet };
  } finally {
    await context.close();
  }
}
