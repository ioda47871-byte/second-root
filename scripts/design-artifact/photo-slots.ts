/**
 * DEV-163 (Issue #193 comment 6601921731, decision 3) — OFFLINE research measure. Uses no photo.
 *
 *   npx tsx scripts/design-artifact/photo-slots.ts --shop <shop> --page <dir> [--out <photo-slots.json>]
 *   npx tsx scripts/design-artifact/photo-slots.ts --edges --shop <shop> --page <dir> [--out <photo-slot-edges.json>]
 *
 * Draws a research fidelity page (C) at 1440, 1024, 768 and 390 with JavaScript off and every request outside the
 * page's own directory refused, finds each placeholder board (the box next to a caption that starts with 写真｜), and
 * records its layout size at each width as a slot inventory (lib/design-agent/quality-pipeline/photo-slots.ts).
 * The caption's copy-record id becomes the slot id. The page's HTML, CSS and copy hashes are recorded so that a
 * changed page is measured again (tests/unit/design-agent/quality-pipeline/photo-intake.test.ts compares).
 *
 * --edges (DEV-166): the same boards at the widest edge of each CSS breakpoint range (600, 1199, and the desktop cap
 * 1920; EDGE_WINDOWS), kept beside the inventory as photo-slot-edges.json with the same page hashes. A board grows
 * inside its range, so the scale rule is checked there too (photo-swap.test.ts compares).
 *
 * Nothing is written but --out (a new file). Exit: 0 inventory, 2 refused. Never calls a model, a generator or the
 * network.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { chromium, type Browser } from "playwright";
import { DESKTOP_CAP_PX, EDGE_VIEWPORTS, EDGE_WINDOWS, PhotoSlotEdges, PhotoSlotInventory, SLOT_DENSITY, SLOT_VIEWPORTS, variantOf, type PhotoSlot, type SlotViewport } from "../../lib/design-agent/quality-pipeline/photo-slots";

const REPO = resolve(__dirname, "../..");
const RESEARCH = join(REPO, "design-library/research/quality-pipeline/poc");
const SIZES: Record<SlotViewport, { width: number; height: number }> = {
  desktop_1440: { width: 1440, height: 900 },
  tablet_1024: { width: 1024, height: 768 },
  tablet_768: { width: 768, height: 1024 },
  mobile_390: { width: 390, height: 844 },
};
const LABEL = "写真｜";

export type Found = { label: string; section: string; board_class: string; board_selector: string; svg: boolean; width: number; height: number };

/** Runs in the page (the harness's evaluate; the page's own JS is off). */
const FIND = String.raw`(label) => {
  const own = (el) => (el.textContent || "").trim();
  const labels = Array.from(document.querySelectorAll("body *")).filter((el) => own(el).startsWith(label) && !Array.from(el.children).some((c) => own(c).startsWith(label)));
  const isLabel = (el) => labels.includes(el);
  const out = [];
  for (const lab of labels) {
    let board = null;
    for (let at = lab.parentElement; at && at !== document.body && !board; at = at.parentElement) {
      if (labels.filter((l) => at.contains(l)).length > 1) break;
      const cands = [at, ...Array.from(at.querySelectorAll("*"))].filter((c) => !isLabel(c) && !c.closest("svg") && getComputedStyle(c).aspectRatio !== "auto");
      if (cands.length) board = cands.sort((a, b) => b.offsetWidth * b.offsetHeight - a.offsetWidth * a.offsetHeight)[0];
    }
    const sec = lab.closest("[data-comp-section]");
    // the shortest selector under the section that names this board and nothing else
    let selector = "";
    if (board && sec) {
      const head = '[data-comp-section="' + sec.getAttribute("data-comp-section") + '"]';
      const seg = (el) => {
        const base = el.tagName.toLowerCase() + Array.from(el.classList).map((c) => "." + CSS.escape(c)).join("");
        const twins = el.parentElement ? Array.from(el.parentElement.children).filter((c) => c.matches(base)) : [el];
        return twins.length > 1 ? base + ":nth-child(" + (Array.from(el.parentElement.children).indexOf(el) + 1) + ")" : base;
      };
      const path = [];
      for (let el = board; el && el !== sec; el = el.parentElement) {
        path.unshift(seg(el));
        const sel = head + " " + path.join(" > ");
        const hits = document.querySelectorAll(sel);
        if (hits.length === 1 && hits[0] === board) { selector = sel; break; }
      }
    }
    out.push({
      label: own(lab),
      section: sec ? sec.getAttribute("data-comp-section") : "",
      board_class: board ? board.getAttribute("class") || "" : "",
      board_selector: selector,
      svg: board ? board.querySelector("svg") !== null : false,
      // the layout box, before any rotation the page draws the board with
      width: board ? parseFloat(getComputedStyle(board).width) : 0,
      height: board ? parseFloat(getComputedStyle(board).height) : 0,
    });
  }
  return out;
}`;

async function findBoards(browser: Browser, dir: string, v: SlotViewport): Promise<Found[]> {
  return measureBoards(browser, dir, SIZES[v]);
}

/** The placeholder boards of the page in `dir` (a real path) drawn at one window size, in page order. */
export async function measureBoards(browser: Browser, dir: string, size: { width: number; height: number }): Promise<Found[]> {
  const ctx = await browser.newContext({ viewport: size, deviceScaleFactor: 1, javaScriptEnabled: false, serviceWorkers: "block" });
  try {
    const page = await ctx.newPage();
    const base = `file://${dir}${sep}`;
    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (!url.startsWith(base)) return route.abort();
      let real: string;
      try {
        real = realpathSync(decodeURIComponent(new URL(url).pathname));
      } catch {
        return route.abort();
      }
      return (real + sep).startsWith(dir + sep) ? route.continue() : route.abort();
    });
    await page.goto(`${base}index.html`, { waitUntil: "load" });
    await page.evaluate("document.fonts.ready.then(() => true)");
    return (await page.evaluate(`(${FIND})(${JSON.stringify(LABEL)})`)) as Found[];
  } finally {
    await ctx.close();
  }
}

const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

export async function deriveSlots(browser: Browser, shop: string, pageDir: string): Promise<PhotoSlotInventory> {
  const dir = realpathSync(join(REPO, pageDir));
  if (!(dir + sep).startsWith(realpathSync(RESEARCH) + sep)) throw new Error("REFUSED: the page is outside the research tree");
  const copy = JSON.parse(readFileSync(join(dir, "copy.json"), "utf8")) as { shop_id: string; items: Array<{ id: string; text: string }> };
  const byViewport = {} as Record<SlotViewport, Found[]>;
  for (const v of SLOT_VIEWPORTS) byViewport[v] = await findBoards(browser, dir, v);
  const first = byViewport.desktop_1440;
  const slots: PhotoSlot[] = first.map((f, i) => {
    const item = copy.items.filter((it) => it.text === f.label);
    if (item.length !== 1 || !item[0]!.id.startsWith("ph-")) throw new Error(`REFUSED: caption ${f.label} is not exactly one ph-* copy item`);
    if (!f.board_selector) throw new Error(`REFUSED: no unique selector for the board of ${f.label}`);
    if (!f.board_class) throw new Error(`REFUSED: no board found for ${f.label}`);
    return {
      slot_id: item[0]!.id,
      role: f.label.slice(LABEL.length),
      section: f.section,
      board_class: f.board_class,
      board_selector: f.board_selector,
      placeholder: f.svg ? "css_board_with_svg" : "css_board",
      focal_default: { x: 0.5, y: 0.5 },
      variants: SLOT_VIEWPORTS.map((v) => {
        const b = byViewport[v][i];
        if (!b || b.label !== f.label || b.board_selector !== f.board_selector) throw new Error(`REFUSED: ${f.label} is not the same board at ${v}`);
        if (b.width <= 0 || b.height <= 0) throw new Error(`REFUSED: ${f.label} has no size at ${v}`);
        return variantOf(v, b.width, b.height);
      }),
    };
  });
  return PhotoSlotInventory.parse({
    schema: "photo_slots_v0",
    shop,
    shop_id: copy.shop_id,
    page_dir: pageDir,
    html_sha256: sha(join(dir, "index.html")),
    css_sha256: sha(join(dir, "style.css")),
    copy_sha256: sha(join(dir, "copy.json")),
    derived_by: "scripts/design-artifact/photo-slots.ts",
    evaluation_label: "placeholder_limited",
    density: SLOT_DENSITY,
    slots,
  });
}

/** The boards of an inventoried page at the range edges, in the inventory's slot order (same board, same selector). */
export async function deriveEdges(browser: Browser, inv: PhotoSlotInventory): Promise<PhotoSlotEdges> {
  const dir = realpathSync(join(REPO, inv.page_dir));
  if (!(dir + sep).startsWith(realpathSync(RESEARCH) + sep)) throw new Error("REFUSED: the page is outside the research tree");
  if (sha(join(dir, "index.html")) !== inv.html_sha256 || sha(join(dir, "style.css")) !== inv.css_sha256 || sha(join(dir, "copy.json")) !== inv.copy_sha256) throw new Error("REFUSED: the page is not the inventoried page");
  const at = {} as Record<(typeof EDGE_VIEWPORTS)[number], Found[]>;
  for (const v of EDGE_VIEWPORTS) at[v] = await measureBoards(browser, dir, EDGE_WINDOWS[v]);
  return PhotoSlotEdges.parse({
    schema: "photo_slot_edges_v0",
    shop: inv.shop,
    page_dir: inv.page_dir,
    html_sha256: inv.html_sha256,
    css_sha256: inv.css_sha256,
    copy_sha256: inv.copy_sha256,
    derived_by: "scripts/design-artifact/photo-slots.ts --edges",
    desktop_cap_px: DESKTOP_CAP_PX,
    slots: inv.slots.map((s, i) => ({
      slot_id: s.slot_id,
      edges: EDGE_VIEWPORTS.map((v) => {
        const b = at[v][i];
        if (!b || b.label !== `${LABEL}${s.role}` || b.board_selector !== s.board_selector) throw new Error(`REFUSED: ${s.slot_id} is not the same board at ${v}`);
        if (b.width <= 0 || b.height <= 0) throw new Error(`REFUSED: ${s.slot_id} has no size at ${v}`);
        return variantOf(v, b.width, b.height);
      }),
    })),
  });
}

async function main(argv: string[]): Promise<number> {
  const arg = (k: string) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const shop = arg("--shop");
  const pageDir = arg("--page");
  const out = arg("--out");
  if (!shop || !pageDir) return (process.stderr.write("usage: --shop <shop> --page <dir> [--out <photo-slots.json>]\n"), 2);
  if (out && existsSync(out)) return (process.stderr.write("REFUSED: --out exists\n"), 2);
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  try {
    const data = argv.includes("--edges") ? await deriveEdges(browser, await deriveSlots(browser, shop, pageDir)) : await deriveSlots(browser, shop, pageDir);
    const text = `${JSON.stringify(data, null, 2)}\n`;
    if (out) writeFileSync(out, text, { flag: "wx" });
    else process.stdout.write(text);
    return 0;
  } catch (e) {
    process.stderr.write(`${(e as Error).message.split("\n")[0]}\n`);
    return 2;
  } finally {
    await browser.close();
  }
}

if (require.main === module) main(process.argv.slice(2)).then((c) => process.exit(c));
