/**
 * DEV-189 (Issue #193, owner GO 2026-11-06 item 3): the 輪 (bicycle, FICTIONAL) research swap, OFFLINE.
 *
 * The designated research-only page is poc/bicycle/fidelity/d1-v7 (fidelity-spec.json's fidelity_c; not an owner-approved
 * design, no HOLD option adopted). Its 5 real photo placeholders are pinned in photo-slots-d1-v7.json and
 * photo-slot-edges-d1-v7.json by the page's HTML, CSS and copy SHA-256.
 *
 * Every picture here is a MOCK: solid-colour PNGs made by code at test time under os.tmpdir(), never written to the
 * repository. The pipeline root with .intake/photos/ is a temporary folder too. No model, generator or network is used.
 *
 * E2E: intake (mock bytes into the private .intake/photos/, measured) → rights (checkPhotoRights) → crop (planSlot, sharp)
 * → swap (transformHtml with 輪's fixed spec) → render at PC 1440 and SP 390, checked twice: by the swap's own render
 * gate and again here, independently, on the written copy (no placeholder left, every image loaded, no horizontal
 * overflow, every board at its measured size with the photo filling it). A failed swap is refused with no output.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { chromium, type Browser } from "playwright";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadForbiddenSha256 } from "@/lib/design-agent/quality-pipeline/photo-rights";
import { edgesFor, PhotoSlotEdges, PhotoSlotInventory, planSlot, requestFor, type FocalBox } from "@/lib/design-agent/quality-pipeline/photo-slots";
import { BICYCLE_SWAP_CSS, SWAP_SHOP_SPECS } from "@/lib/design-agent/quality-pipeline/photo-swap-shops";
import { AI_DEMO_SHOPS, loadInventory, swapPage, SWAP_SHOPS, transformHtml } from "../../../../scripts/design-artifact/photo-swap";
import { deriveEdges, deriveSlots } from "../../../../scripts/design-artifact/photo-slots";

const REPO = resolve(__dirname, "../../../..");
const POC = "design-library/research/quality-pipeline/poc/bicycle";
const PAGE = `${POC}/fidelity/d1-v7`;
const INV = PhotoSlotInventory.parse(JSON.parse(readFileSync(join(REPO, POC, "photo-slots-d1-v7.json"), "utf8")));
const EDGES = PhotoSlotEdges.parse(JSON.parse(readFileSync(join(REPO, POC, "photo-slot-edges-d1-v7.json"), "utf8")));
const EDGE_MAP = edgesFor(INV, EDGES)!;
const SPEC = SWAP_SHOP_SPECS.bicycle;
const SLOT_IDS = ["ph-d", "ph-a", "ph-c", "ph-b", "ph-bench"];
const FORBIDDEN = loadForbiddenSha256(REPO);
const NOW = "2026-11-06";
const CENTRE: FocalBox = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const slot = (id: string) => INV.slots.find((s) => s.slot_id === id)!;
const launch = () => chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });

describe("輪 d1-v7: the designated research page and its 5 real photo slots", () => {
  it("is the page fidelity-spec.json points its C at, and the inventory pins its HTML, CSS and copy", () => {
    const spec = JSON.parse(readFileSync(join(REPO, POC, "fidelity-spec.json"), "utf8")) as { pages: Array<{ key: string; dir: string }> };
    expect(spec.pages.find((p) => p.key === "fidelity_c")!.dir).toBe(PAGE);
    expect(INV.page_dir).toBe(PAGE);
    expect(EDGES.page_dir).toBe(PAGE);
    for (const [f, h] of [["index.html", INV.html_sha256], ["style.css", INV.css_sha256], ["copy.json", INV.copy_sha256]] as const) expect(sha(readFileSync(join(REPO, PAGE, f))), f).toBe(h);
    expect(INV.evaluation_label).toBe("placeholder_limited");
    expect(EDGE_MAP).not.toBeNull();
  });
  it("has exactly the page's 5 写真｜ boards — not padded to 6 — and keeps the drawn motifs out of the slots", () => {
    const html = readFileSync(join(REPO, PAGE, "index.html"), "utf8");
    expect(html.replace(/<wbr>/g, "").match(/写真｜/g)).toHaveLength(5);
    expect(INV.slots.map((s) => s.slot_id)).toEqual(SLOT_IDS);
    expect(INV.slots.every((s) => s.placeholder === "css_board")).toBe(true);
    // each slot is a ph-* copy item; the wheel, spokes, truing drawing, gauge and giant words are drawings, not slots
    const copy = JSON.parse(readFileSync(join(REPO, PAGE, "copy.json"), "utf8")) as { items: Array<{ id: string }> };
    expect(copy.items.filter((i) => i.id.startsWith("ph-")).map((i) => i.id).sort()).toEqual([...SLOT_IDS].sort());
    for (const s of INV.slots) for (const motif of ["wheel-art", "true-art", "gauge-art", "ghost"]) expect(s.board_selector, s.slot_id).not.toContain(motif);
  });
  it.each([
    // [slot, viewport, width, height] — the measured boards (CSS px)
    ["ph-d", "desktop_1440", 260, 200],
    ["ph-d", "mobile_390", 278, 188],
    ["ph-a", "tablet_768", 236, 182],
    ["ph-c", "tablet_1024", 213, 155],
    ["ph-b", "desktop_1440", 300, 220],
    ["ph-bench", "desktop_1440", 760, 560],
    ["ph-bench", "mobile_390", 226, 414],
  ])("%s at %s is %i×%i", (id, v, w, h) => {
    expect(slot(id).variants.find((x) => x.viewport === v)).toMatchObject({ width_px: w, height_px: h });
  });
  it("its range edges are 輪's own (601–999 is the tablet range): 600, 999, 1920, and each is the range's largest board", () => {
    expect(EDGES.edge_viewports).toEqual(["mobile_600", "tablet_999", "desktop_1920"]);
    expect(SPEC.edgeViewports).toEqual(EDGES.edge_viewports);
    for (const s of INV.slots) {
      const at = (v: string) => [...s.variants, ...EDGE_MAP.get(s.slot_id)!].find((x) => x.viewport === v)!.width_px;
      expect(at("mobile_600"), s.slot_id).toBeGreaterThanOrEqual(at("mobile_390"));
      expect(at("tablet_999"), s.slot_id).toBeGreaterThanOrEqual(at("tablet_768"));
      expect(at("desktop_1920"), s.slot_id).toBeGreaterThan(at("desktop_1440"));
      expect(at("desktop_1440"), s.slot_id).toBeGreaterThan(at("tablet_1024"));
    }
    // the bench's SP board is tall, its PC board wide: one landscape photo cannot serve SP
    expect(slot("ph-bench").variants.find((v) => v.viewport === "mobile_390")!.ratio).toBeLessThan(1);
  });
  it("the swap takes d1-v7 (and, from DEV-190, the integrated d1-v9); the old d1-v2 is refused, every other version is not inventoried", () => {
    expect(loadInventory("bicycle", PAGE)).toMatchObject({ ok: true });
    // DEV-190: d1-v2 is not one of the spec's pages (refused before its missing edges are looked at)
    expect(loadInventory("bicycle", `${POC}/fidelity/d1-v2`)).toEqual({ ok: false, code: "PAGE_NOT_IN_SPEC" });
    const versions = readdirSync(join(REPO, POC, "fidelity")).filter((v) => v !== "d1-v7" && v !== "d1-v2" && v !== "d1-v9");
    // the d1-v8 HOLD options (PR #222) included: none is adopted, none is swappable
    expect(versions).toEqual(expect.arrayContaining(["d1-v6", "d1-v8-opt-hub-glyph", "d1-v8-opt-cta-band"]));
    for (const v of versions) expect(loadInventory("bicycle", `${POC}/fidelity/${v}`), v).toEqual({ ok: false, code: "PAGE_NOT_INVENTORIED" });
  });
  it("a shop's edges file must hold one mobile, one tablet and the desktop cap edge, in order", () => {
    expect(PhotoSlotEdges.safeParse({ ...EDGES, edge_viewports: ["mobile_600", "tablet_1199", "desktop_1920"] }).success).toBe(false); // the slots are measured at 999
    expect(PhotoSlotEdges.safeParse({ ...EDGES, edge_viewports: ["tablet_999", "mobile_600", "desktop_1920"] }).success).toBe(false);
    expect(PhotoSlotEdges.safeParse({ ...EDGES, edge_viewports: undefined }).success).toBe(false);
  });
});

describe("loadInventory refusals, each on its own (PR #232 review M1/L2)", () => {
  // the seam reads the shop's inventory files from a temporary folder; the pages are still the repository's
  const TS = "design-library/research/quality-pipeline/poc/tsugute";
  const json = (f: string) => JSON.parse(readFileSync(join(REPO, f), "utf8")) as Record<string, unknown>;
  const folder = (files: Record<string, unknown>) => {
    const dir = mkdtempSync(join(tmpdir(), "dev190-inv-"));
    for (const [name, data] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(data));
    return dir;
  };
  const dirs: string[] = [];
  const at = (files: Record<string, unknown>) => {
    const d = folder(files);
    dirs.push(d);
    return d;
  };
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const V7_SLOTS = json(`${POC}/photo-slots-d1-v7.json`);
  const V7_EDGES = json(`${POC}/photo-slot-edges-d1-v7.json`);

  it("control: the unchanged copies load through the seam (so each refusal below is the one change)", () => {
    expect(loadInventory("bicycle", PAGE, { shopDir: at({ "photo-slots-d1-v7.json": V7_SLOTS, "photo-slot-edges-d1-v7.json": V7_EDGES }) })).toMatchObject({ ok: true });
  });
  it("EDGES_STALE: no edges file beside the inventory", () => {
    expect(loadInventory("bicycle", PAGE, { shopDir: at({ "photo-slots-d1-v7.json": V7_SLOTS }) })).toEqual({ ok: false, code: "EDGES_STALE" });
  });
  it("EDGES_STALE: edges measured on another state of the page (hash) or with another slot list", () => {
    expect(loadInventory("bicycle", PAGE, { shopDir: at({ "photo-slots-d1-v7.json": V7_SLOTS, "photo-slot-edges-d1-v7.json": { ...V7_EDGES, css_sha256: "0".repeat(64) } }) })).toEqual({ ok: false, code: "EDGES_STALE" });
    const slots = (V7_EDGES.slots as unknown[]).slice(0, 4);
    expect(loadInventory("bicycle", PAGE, { shopDir: at({ "photo-slots-d1-v7.json": V7_SLOTS, "photo-slot-edges-d1-v7.json": { ...V7_EDGES, slots } }) })).toEqual({ ok: false, code: "EDGES_STALE" });
  });
  it("EDGES_STALE: edges at another shop's range widths (輪 measured at 1199, つぐ手 at 999)", () => {
    const at1199 = { ...V7_EDGES, edge_viewports: undefined, slots: (V7_EDGES.slots as Array<{ slot_id: string; edges: Array<Record<string, unknown>> }>).map((x) => ({ ...x, edges: x.edges.map((e) => (e.viewport === "tablet_999" ? { ...e, viewport: "tablet_1199" } : e)) })) };
    delete (at1199 as Record<string, unknown>).edge_viewports;
    expect(PhotoSlotEdges.safeParse(at1199).success).toBe(true); // a valid file, only at the wrong widths
    expect(loadInventory("bicycle", PAGE, { shopDir: at({ "photo-slots-d1-v7.json": V7_SLOTS, "photo-slot-edges-d1-v7.json": at1199 }) })).toEqual({ ok: false, code: "EDGES_STALE" });
    const tsSlots = json(`${TS}/photo-slots-d1-v10.json`);
    const tsEdges = json(`${TS}/photo-slot-edges-d1-v10.json`);
    expect(loadInventory("tsugute", `${TS}/fidelity/d1-v10`, { shopDir: at({ "photo-slots-d1-v10.json": tsSlots, "photo-slot-edges-d1-v10.json": tsEdges }) })).toMatchObject({ ok: true });
    const at999 = { ...tsEdges, edge_viewports: ["mobile_600", "tablet_999", "desktop_1920"], slots: (tsEdges.slots as Array<{ slot_id: string; edges: Array<Record<string, unknown>> }>).map((x) => ({ ...x, edges: x.edges.map((e) => (e.viewport === "tablet_1199" ? { ...e, viewport: "tablet_999" } : e)) })) };
    expect(PhotoSlotEdges.safeParse(at999).success).toBe(true);
    expect(loadInventory("tsugute", `${TS}/fidelity/d1-v10`, { shopDir: at({ "photo-slots-d1-v10.json": tsSlots, "photo-slot-edges-d1-v10.json": at999 }) })).toEqual({ ok: false, code: "EDGES_STALE" });
  });
  it("PAGE_NOT_IN_SPEC for both shops: an inventoried page that is not one of the spec's", () => {
    // 輪: the real repository, the old d1-v2 inventory
    expect(loadInventory("bicycle", `${POC}/fidelity/d1-v2`)).toEqual({ ok: false, code: "PAGE_NOT_IN_SPEC" });
    // つぐ手: an inventory naming d1-v8 (not d1-v3 / d1-v10)
    const tsSlots = json(`${TS}/photo-slots-d1-v10.json`);
    expect(loadInventory("tsugute", `${TS}/fidelity/d1-v8`, { shopDir: at({ "photo-slots-d1-v8.json": { ...tsSlots, page_dir: `${TS}/fidelity/d1-v8` } }) })).toEqual({ ok: false, code: "PAGE_NOT_IN_SPEC" });
  });
  it("PAGE_NOT_IN_SPEC compares the full path (L2): a 輪 inventory naming つぐ手's d1-v9 is not 輪's d1-v9", () => {
    expect(existsSync(join(REPO, TS, "fidelity/d1-v9/index.html"))).toBe(true);
    expect(loadInventory("bicycle", `${TS}/fidelity/d1-v9`, { shopDir: at({ "photo-slots-d1-v9.json": { ...V7_SLOTS, page_dir: `${TS}/fidelity/d1-v9` } }) })).toEqual({ ok: false, code: "PAGE_NOT_IN_SPEC" });
  });
});

describe("輪's transform (board directly before its caption)", () => {
  const html = readFileSync(join(REPO, PAGE, "index.html"), "utf8");
  const slotsIn = INV.slots.map((s) => ({ slot: s, alt: s.role, files: { desktop: `photos/${s.slot_id}-desktop.png`, tablet: `photos/${s.slot_id}-tablet.png`, mobile: `photos/${s.slot_id}-mobile.png` }, size: { width: 10, height: 10 } }));
  it("fills every board with a picture whose sources follow 輪's breakpoints, and changes nothing else", () => {
    const out = transformHtml(html, slotsIn, SPEC);
    expect(out.replace(/<wbr>/g, "")).not.toContain("写真｜");
    expect(out).not.toMatch(/<div class="photo"><\/div>/);
    for (const s of INV.slots)
      expect(out).toContain(`<div class="photo"><picture data-slot="${s.slot_id}"><source media="(max-width: 600px)" srcset="photos/${s.slot_id}-mobile.png"><source media="(max-width: 999px)" srcset="photos/${s.slot_id}-tablet.png"><img src="photos/${s.slot_id}-desktop.png" alt="${s.role}" width="10" height="10"></picture></div></div>`);
    const strip = (h: string) => h.replace(/<p class="ph(?: ph-bench)?">写真｜[\s\S]*?<\/p>|<picture[\s\S]*?<\/picture>/g, "");
    expect(strip(out)).toBe(strip(html));
  });
  it("つぐ手's structure on 輪's page, and 輪's on つぐ手's, are refused", () => {
    expect(() => transformHtml(html, slotsIn)).toThrow(/^CAPTION_NOT_FOUND: ph-d$/);
    const tsugute = readFileSync(join(REPO, "design-library/research/quality-pipeline/poc/tsugute/fidelity/d1-v10/index.html"), "utf8");
    expect(() => transformHtml(tsugute, slotsIn, SPEC)).toThrow(/^CAPTION_NOT_FOUND:/);
  });
  it.each([
    ["a board with content", (h: string) => h.replace('<div class="board"><div class="photo"></div></div><p class="ph">写真｜<wbr>パンクを', '<div class="board"><div class="photo"><b>x</b></div></div><p class="ph">写真｜<wbr>パンクを'), "BOARD_NOT_FOUND: ph-a"],
    ["something between the board and its caption", (h: string) => h.replace('</div></div><p class="ph">写真｜<wbr>外した', '</div></div><span></span><p class="ph">写真｜<wbr>外した'), "BOARD_NOT_FOUND: ph-c"],
    ["a container that is not the page's", (h: string) => h.replace('<figure class="bench"><div class="board board-bench">', '<figure class="bench x"><div class="board board-bench">'), "BOARD_NOT_FOUND: ph-bench"],
    ["a second copy of a caption", (h: string) => h.replace("</section>", '<p class="ph">写真｜ブレーキの接写</p></section>'), "CAPTION_NOT_FOUND: ph-b"],
    ["a caption broken by anything but <wbr>", (h: string) => h.replace("写真｜<wbr>振れ取り台の", "写真｜<i></i>振れ取り台の"), "CAPTION_NOT_FOUND: ph-d"],
  ])("fails closed on %s", (_, mutate, code) => {
    const bad = mutate(html);
    expect(bad).not.toBe(html);
    expect(() => transformHtml(bad, slotsIn, SPEC)).toThrow(new RegExp(`^${code}$`));
  });
  it("a slot left out leaves its 写真｜ and is refused; a seam-board slot kind is refused", () => {
    expect(() => transformHtml(html, slotsIn.slice(0, 4), SPEC)).toThrow(/CAPTION_LEFT/);
    expect(() => transformHtml(html, slotsIn.map((x, i) => (i === 0 ? { ...x, slot: { ...x.slot, placeholder: "css_board_with_svg" as const } } : x)), SPEC)).toThrow(/^BOARD_NOT_FOUND: ph-d$/);
  });
  it("puts $-patterns and markup of the alt text in literally and escaped", () => {
    const out = transformHtml(html, slotsIn.map((s, i) => (i === 0 ? { ...s, alt: 'a $& "b" <c>' } : s)), SPEC);
    expect(out).toContain('alt="a $&amp; &quot;b&quot; &lt;c&gt;"');
  });
});

describe("輪's image brief: a 未承認 draft, pinned by SHA-256", () => {
  const brief = readFileSync(join(REPO, "docs/design/bicycle-ai-photo-brief.md"), "utf8");
  const prompt = readFileSync(join(REPO, "docs/design/bicycle-ai-photo-prompt.txt"));
  it("records the prompt file's SHA-256 and size, and both say 未承認", () => {
    expect(brief).toContain(`\`${sha(prompt)}\` (${prompt.length} バイト)`);
    // DEV-190: the draft was updated for d1-v9 (same sizes and subjects; header and the bench note)
    expect(sha(prompt)).toBe("83c9b2c628873d645a78145065a5ff5befeab7f406555b79649f1f44d8275594");
    expect(brief).toContain("未承認");
    expect(prompt.toString("utf8").split("\n")[0]).toContain("未承認");
  });
  it("maps a prompt to every slot (the bench to a PC and an SP photo), 6 pictures in all, each at least the swap's request", () => {
    const text = prompt.toString("utf8");
    const heads = [...text.matchAll(/^(ph-[a-z-]+) \((\d+):(\d+)(?: portrait)?, at least (\d+)x(\d+) px; subject inside x ([\d.]+)-([\d.]+), y ([\d.]+)-([\d.]+)\):$/gm)];
    expect(heads.map((m) => m[1])).toEqual(["ph-d", "ph-a", "ph-c", "ph-b", "ph-bench-pc", "ph-bench-sp"]);
    const photo = Object.fromEntries(
      heads.map((m) => {
        const [w, h] = [+m[4]!, +m[5]!];
        expect(Math.abs(w / h - +m[2]! / +m[3]!), m[1]).toBeLessThan(0.01);
        return [m[1]!, { width: w, height: h, focal_box: { x: +m[6]!, y: +m[8]!, w: +m[7]! - +m[6]!, h: +m[9]! - +m[8]! } }];
      }),
    );
    // a picture of exactly that size and subject box passes the swap's plan at 2× (the bench with its PC/SP pair)
    for (const id of SLOT_IDS) {
      const photos = id === "ph-bench" ? { pc: photo["ph-bench-pc"]!, sp: photo["ph-bench-sp"]! } : { pc: photo[id]! };
      expect(planSlot(slot(id), photos, { spViewports: SPEC.spViewports, edges: EDGE_MAP.get(id)! }), id).toMatchObject({ ok: true, codes: [] });
    }
  });
  it("names no real place or brand, and asks for no text in the pictures", () => {
    expect(prompt.toString("utf8")).toMatch(/No text, letters, numbers, logos, brand names/);
    expect(prompt.toString("utf8")).toMatch(/Demo image, not a real shop/);
  });
});

describe("輪 E2E with MOCK photos: intake → rights → crop → swap → PC/SP render", () => {
  let root: string;
  let pipeline: string;
  let browser: Browser;
  let n = 0;
  const outDir = () => join(root, `out-${++n}`);
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "dev189-"));
    pipeline = join(root, "pipeline");
    mkdirSync(join(pipeline, ".intake", "photos"), { recursive: true });
    browser = await launch();
  });
  afterAll(async () => {
    await browser?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  /** intake: a mock PNG written to the private .intake/photos/ and a rights record of its measured bytes */
  async function mock(name: string, width: number, height: number, colour: number, over: Record<string, unknown> = {}) {
    const buf = await sharp({ create: { width, height, channels: 3, background: { r: (colour * 3) % 256, g: (colour * 11) % 256, b: (colour * 17) % 256 } } }).png().toBuffer();
    writeFileSync(join(pipeline, ".intake", "photos", `${name}.png`), buf);
    return {
      schema: "photo_rights_v0",
      asset_id: `photo-${name}`,
      sha256: sha(buf),
      bytes: buf.length,
      width,
      height,
      format: "png",
      source_kind: "owner_provided",
      owner: "mock test owner",
      license: "mock test only",
      paid: false,
      allowed_uses: { edit: true, crop: true, commercial: true, public_web: false },
      consent_record_ref: "mock-consent",
      received_at: "2026-11-01",
      expiry: null,
      private_path: `.intake/photos/${name}.png`,
      depicts_identifiable_person: false,
      depicts_real_shop: false,
      ...over,
    };
  }
  /** the 5 slots: one photo per station at its request; the bench a 4:3 PC photo and a 2:3 SP photo */
  async function fiveSlots(tag: string) {
    const out: Array<Record<string, unknown>> = [];
    for (const [i, s] of INV.slots.entries()) {
      if (s.slot_id === "ph-bench") {
        out.push({ slot_id: s.slot_id, pc: { rights: await mock(`b-${tag}-bench-pc`, 2030, 1523, 90), focal_box: CENTRE }, sp: { rights: await mock(`b-${tag}-bench-sp`, 590, 885, 91), focal_box: CENTRE } });
        continue;
      }
      const r = requestFor(s, { edges: EDGE_MAP.get(s.slot_id)! });
      if (!r.ok) throw new Error(s.slot_id);
      out.push({ slot_id: s.slot_id, pc: { rights: await mock(`b-${tag}-${s.slot_id}`, r.min_width_px, r.min_height_px, 20 * i + 7), focal_box: CENTRE } });
    }
    return out;
  }
  const manifest = (slots: unknown[]) => ({ schema: "photo_swap_manifest_v0", shop: "bicycle", slots });
  const run = (slots: unknown[], out = outDir(), b?: Browser, extra: Partial<Parameters<typeof swapPage>[0]> = {}) => swapPage({ pageDir: PAGE, manifest: manifest(slots), out, pipelineRoot: pipeline, now: NOW, forbiddenSha256: FORBIDDEN, browser: b, ...extra });
  const codesOf = (r: Awaited<ReturnType<typeof run>>) => (r.ok ? [] : r.refusals.flatMap((x) => x.codes));
  const nothingLeft = (out: string) => {
    expect(existsSync(out)).toBe(false);
    expect(readdirSync(root).filter((f) => f.includes(".partial-"))).toEqual([]);
  };

  /** Opens the written copy on its own (JS off, nothing outside the copy) and reads what a viewer would see. */
  async function inspect(pageDir: string, width: number, height: number) {
    const dir = realpathSync(pageDir);
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, javaScriptEnabled: false, serviceWorkers: "block" });
    try {
      const page = await ctx.newPage();
      const base = `file://${dir}${sep}`;
      const outside: string[] = [];
      await page.route("**/*", (route) => {
        const url = route.request().url();
        if (!url.startsWith(base)) return (outside.push(url), route.abort());
        return route.continue();
      });
      await page.goto(`${base}index.html`, { waitUntil: "load" });
      const seen = (await page.evaluate(`(() => {
        const imgs = Array.from(document.querySelectorAll("img"));
        const boards = ${JSON.stringify(INV.slots.map((s) => ({ id: s.slot_id, sel: s.board_selector, v: s.variants })))};
        const vp = window.innerWidth >= 1000 ? "desktop_1440" : "mobile_390";
        return {
          imgs: imgs.map((i) => ({ src: i.getAttribute("src"), current: i.currentSrc.split("/").pop(), natural: i.naturalWidth, complete: i.complete, alt: i.alt })),
          placeholders_left: document.querySelectorAll(".photo:empty").length,
          caption_left: document.body.innerText.includes("写真｜"),
          ph_labels: document.querySelectorAll("p.ph").length,
          scroll_width: document.documentElement.scrollWidth,
          inner_width: window.innerWidth,
          boards: boards.map((b) => {
            const el = document.querySelector(b.sel);
            const img = el && el.querySelector(".photo > picture > img");
            const want = b.v.find((x) => x.viewport === vp);
            return { id: b.id, w: el ? parseFloat(getComputedStyle(el).width) : 0, h: el ? parseFloat(getComputedStyle(el).height) : 0, iw: img ? img.offsetWidth : 0, ih: img ? img.offsetHeight : 0, ww: want.width_px, wh: want.height_px };
          }),
        };
      })()`)) as {
        imgs: Array<{ src: string; current: string; natural: number; complete: boolean; alt: string }>;
        placeholders_left: number;
        caption_left: boolean;
        ph_labels: number;
        scroll_width: number;
        inner_width: number;
        boards: Array<{ id: string; w: number; h: number; iw: number; ih: number; ww: number; wh: number }>;
      };
      return { ...seen, outside };
    } finally {
      await ctx.close();
    }
  }

  it("the whole chain: every slot shows a loaded mock photo at PC 1440 and SP 390, no placeholder, no overflow, layout intact", async () => {
    const slots = await fiveSlots("e2e");
    const out = outDir();
    const res = await run(slots, out, browser);
    if (!res.ok) throw new Error(JSON.stringify(res.refusals));
    // the swap's own render gate (the same for つぐ手)
    // DEV-190 (review L1): 輪 is also drawn and checked at tablet 768
    expect(res.renders.map((r) => r.viewport)).toEqual(["desktop_1440", "tablet_768", "mobile_390"]);
    for (const r of res.renders) {
      expect(r, r.viewport).toMatchObject({ images: 5, images_loaded: 5, boards_matched: 5, caption_text_left: false, horizontal_overflow: false, boards_intact: 5 });
      expect(existsSync(r.file)).toBe(true);
      const png = await sharp(r.file).metadata();
      expect(png.width).toBe({ desktop_1440: 1440, tablet_768: 768, mobile_390: 390 }[r.viewport]);
    }
    // the crops: 3 ranges × 5 slots; the bench's mobile file from its SP photo and tall, its desktop file wide
    expect(readdirSync(join(out, "page", "photos"))).toHaveLength(15);
    const crops = res.summary.crops as Record<string, { source: string }>;
    expect([crops["ph-bench/desktop"]!.source, crops["ph-bench/tablet"]!.source, crops["ph-bench/mobile"]!.source]).toEqual(["pc", "pc", "sp"]);
    const benchSp = await sharp(join(out, "page", "photos", "ph-bench-mobile.png")).metadata();
    expect(Math.abs(benchSp.width! / benchSp.height! - 226 / 414)).toBeLessThan(0.01);
    const benchPc = await sharp(join(out, "page", "photos", "ph-bench-desktop.png")).metadata();
    expect(Math.abs(benchPc.width! / benchPc.height! - 760 / 560)).toBeLessThan(0.01);
    expect(res.summary).toMatchObject({ shop: "bicycle", page_dir: PAGE, source_hashes: { html: INV.html_sha256, css: INV.css_sha256, copy: INV.copy_sha256 } });
    expect(String(res.summary.scale_checked_at)).toContain("(600, 999, 1920)");
    expect(readFileSync(join(out, "page", "style.css"), "utf8").endsWith(BICYCLE_SWAP_CSS)).toBe(true);

    // independently, on the written copy
    for (const [w, h, range] of [[1440, 900, "desktop"], [390, 844, "mobile"]] as const) {
      const seen = await inspect(join(out, "page"), w, h);
      expect(seen.outside, `${w}`).toEqual([]);
      expect(seen.imgs, `${w}`).toHaveLength(5);
      for (const i of seen.imgs) {
        expect(i.complete && i.natural > 0, `${w} ${i.src}`).toBe(true);
        expect(i.current, `${w} ${i.src}`).toMatch(new RegExp(`-${range}\\.png$`));
        expect(i.alt.length).toBeGreaterThan(0);
      }
      expect(seen.placeholders_left, `${w}`).toBe(0);
      expect(seen.caption_left, `${w}`).toBe(false);
      expect(seen.ph_labels, `${w}`).toBe(0);
      expect(seen.scroll_width, `${w}`).toBeLessThanOrEqual(seen.inner_width + 1);
      for (const b of seen.boards) {
        expect(Math.abs(b.w - b.ww), `${w} ${b.id} width`).toBeLessThanOrEqual(2);
        expect(Math.abs(b.h - b.wh), `${w} ${b.id} height`).toBeLessThanOrEqual(2);
        expect(Math.abs(b.iw - b.w), `${w} ${b.id} photo fills`).toBeLessThanOrEqual(1);
        expect(Math.abs(b.ih - b.h), `${w} ${b.id} photo fills`).toBeLessThanOrEqual(1);
      }
    }
    // private things stay out of what the browser reads and out of the summary; the repository page is unchanged
    expect(existsSync(join(out, "page", "rights.private.json"))).toBe(false);
    const summary = readFileSync(join(out, "swap-summary.json"), "utf8");
    for (const s of ["mock test owner", "mock-consent", ".intake/photos"]) expect(summary).not.toContain(s);
    expect(sha(readFileSync(join(REPO, PAGE, "index.html")))).toBe(INV.html_sha256);
    expect(readdirSync(root).filter((f) => f.includes(".partial-"))).toEqual([]);
  }, 180_000);

  describe("fail closed: refused, and no output at all", () => {
    it("輪 takes no ai_generated_demo picture (no owner approval): AI_DEMO_NOT_ALLOWED", async () => {
      expect(SWAP_SHOPS).toContain("bicycle");
      expect(AI_DEMO_SHOPS.has("bicycle")).toBe(false);
      const slots = await fiveSlots("ai");
      const pc0 = (slots[0]!.pc as { rights: Record<string, unknown> }).rights;
      const ai = { ...pc0, source_kind: "ai_generated_demo", owner: "mock (AI demo)", ai_provenance: { generator: "mock generator", model: "mock-model", generated_at: "2026-11-05T10:00:00Z", prompt_sha256: "8b659d0242340085e6bd7cc6422b4102fa02d75575e79a769d6b87ef1cb50bd7", approval_id: "bicycle-not-approved", demo_only: true } };
      slots[0] = { ...slots[0]!, pc: { rights: ai, focal_box: CENTRE } };
      const out = outDir();
      const res = await run(slots, out, browser);
      expect(res.ok ? [] : res.refusals).toEqual([{ slot_id: "ph-d", photo: "pc", codes: ["AI_DEMO_NOT_ALLOWED"] }]);
      nothingLeft(out);
    });
    it("a missing slot, an unknown slot, a bad rights record, a too-small photo", async () => {
      const slots = await fiveSlots("bad");
      let out = outDir();
      expect(codesOf(await run(slots.slice(0, 4), out))).toEqual(expect.arrayContaining(["SLOTS_INCOMPLETE", "missing:ph-bench"]));
      nothingLeft(out);
      expect(codesOf(await run([...slots, { ...slots[0]!, slot_id: "ph-ware" }]))).toContain("SLOT_UNKNOWN");
      const pc1 = (slots[1]!.pc as { rights: Record<string, unknown> }).rights;
      const tampered = [...slots];
      tampered[1] = { ...slots[1]!, pc: { rights: { ...pc1, sha256: "0".repeat(64) }, focal_box: CENTRE } };
      out = outDir();
      expect(codesOf(await run(tampered, out))).toEqual(["HASH_MISMATCH"]);
      nothingLeft(out);
      const small = [...slots];
      small[2] = { slot_id: "ph-c", pc: { rights: await mock("b-bad-c-small", 700, 467, 3), focal_box: CENTRE } };
      out = outDir();
      expect(codesOf(await run(small, out))).toContain("PHOTO_BELOW_MIN_SCALE");
      nothingLeft(out);
    });
    it("the bench without its SP photo: the wide PC photo loses its subject in the tall SP board", async () => {
      const slots = await fiveSlots("nosp");
      const bench = slots.findIndex((s) => s.slot_id === "ph-bench");
      slots[bench] = { slot_id: "ph-bench", pc: slots[bench]!.pc };
      const out = outDir();
      expect(codesOf(await run(slots, out))).toEqual(["SP_PHOTO_REQUIRED"]);
      nothingLeft(out);
    });
    it("a transform failure and a render-check failure after validation (forced) leave nothing", async () => {
      const slots = await fiveSlots("late");
      let out = outDir();
      expect(codesOf(await run(slots, out, undefined, { transform: () => { throw new Error("BOARD_NOT_FOUND: ph-bench"); } }))).toEqual(["BOARD_NOT_FOUND"]);
      nothingLeft(out);
      const fake = (check: Record<string, unknown>) =>
        ({
          newContext: async () => ({
            newPage: async () => ({ route: async () => {}, goto: async () => null, evaluate: async (e: string) => (e.startsWith("document.fonts") ? true : check), screenshot: async () => Buffer.from("png") }),
            close: async () => {},
          }),
        }) as unknown as Browser;
      const good = { images: 5, images_loaded: 5, boards_matched: 5, caption_text_left: false, scroll_width: 1440, horizontal_overflow: false, boards_intact: 5 };
      for (const bad of [{ images_loaded: 4 }, { horizontal_overflow: true, scroll_width: 1500 }, { boards_intact: 4 }, { caption_text_left: true }]) {
        out = outDir();
        expect(codesOf(await run(slots, out, fake({ ...good, ...bad }))), JSON.stringify(bad)).toEqual(["RENDER_CHECK_FAILED", "viewport:desktop_1440"]);
        nothingLeft(out);
      }
    });
  });

  it("the committed inventory and range edges are what the page measures now (within 2px)", async () => {
    const inv = await deriveSlots(browser, "bicycle", PAGE);
    expect({ ...inv, slots: [] }).toEqual({ ...INV, slots: [] });
    const edges = await deriveEdges(browser, inv);
    expect({ ...edges, slots: [] }).toEqual({ ...EDGES, slots: [] });
    for (const [i, s] of inv.slots.entries()) {
      const w = INV.slots[i]!;
      expect([s.slot_id, s.role, s.board_selector, s.placeholder]).toEqual([w.slot_id, w.role, w.board_selector, w.placeholder]);
      for (const [j, v] of [...s.variants, ...edges.slots[i]!.edges].entries()) {
        const c = [...w.variants, ...EDGES.slots[i]!.edges][j]!;
        expect(v.viewport).toBe(c.viewport);
        expect(Math.abs(v.width_px - c.width_px), `${s.slot_id} ${v.viewport}`).toBeLessThanOrEqual(2);
        expect(Math.abs(v.height_px - c.height_px), `${s.slot_id} ${v.viewport}`).toBeLessThanOrEqual(2);
      }
    }
  }, 180_000);
});
