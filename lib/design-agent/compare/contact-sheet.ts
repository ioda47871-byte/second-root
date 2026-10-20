// A contact sheet of the compared pages (DEV-073): one row per shop, its page
// at 1440 and 390 and its baseline at both, scaled down, as one PNG. Built as a
// local HTML page of file:// images, screenshotted in Chromium, then removed.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser } from "playwright";

export type SheetRow = { label: string; cells: Array<{ label: string; path: string; mobile?: boolean }> };

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Shown widths (CSS px): a 1440px page at a quarter, a 390px page at about a quarter too. */
export const SHEET_WIDTHS = { desktop: 360, mobile: 100 } as const;

export function contactSheetHtml(title: string, rows: SheetRow[]): string {
  const cell = (c: SheetRow["cells"][number]) =>
    `<figure><figcaption>${escape(c.label)}</figcaption><img src="${pathToFileURL(c.path).href}" style="width:${c.mobile ? SHEET_WIDTHS.mobile : SHEET_WIDTHS.desktop}px"></figure>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;padding:24px;background:#e9e9e6;font:13px/1.4 system-ui,sans-serif;color:#222}
h1{font-size:16px;margin:0 0 16px}
.row{display:flex;gap:14px;align-items:flex-start;margin:0 0 22px;padding:12px;background:#fff;border:1px solid #ccc}
.row>h2{writing-mode:vertical-rl;font-size:13px;margin:0;white-space:nowrap}
figure{margin:0}figcaption{font-size:11px;color:#555;margin:0 0 4px}
img{display:block;border:1px solid #bbb;background:#fafafa}
</style></head><body><h1>${escape(title)}</h1>${rows
    .map((r) => `<section class="row"><h2>${escape(r.label)}</h2>${r.cells.map(cell).join("")}</section>`)
    .join("")}</body></html>`;
}

export async function writeContactSheet(browser: Browser, o: { title: string; rows: SheetRow[]; out: string }): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "sr-compare-sheet-"));
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 2 });
  try {
    const html = join(dir, "sheet.html");
    await writeFile(html, contactSheetHtml(o.title, o.rows), { mode: 0o600 });
    const page = await context.newPage();
    await page.goto(pathToFileURL(html).href, { waitUntil: "load" });
    await page.screenshot({ path: o.out, fullPage: true });
  } finally {
    await context.close();
    await rm(dir, { recursive: true, force: true });
  }
}
