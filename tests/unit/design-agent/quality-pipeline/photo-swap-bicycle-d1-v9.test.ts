/**
 * DEV-190 (Issue #193, owner decision 2026-11-06): 輪's INTEGRATED research page d1-v9 = d1-v7 + the three owner-approved
 * options (B1 d1-v8-opt-hub-disc, B2 d1-v8-opt-cta-hero, B3 d1-v8-opt-check-horizontal). The options are approved; the page
 * as a whole is NOT an adopted success example. 5 photo slots, 6 pictures (the bench has a PC and an SP photo).
 *
 * Every picture here is a MOCK made by code at test time under os.tmpdir(); nothing is generated, fetched or committed.
 *
 * E2E: intake → rights → crop → swap → full-page renders at PC 1440, tablet 768 and SP 390 (the swap's own gate), then the
 * written copy is opened again on its own at 1440, 1024, 1000, 999, 768, 601, 600, 390 and 1920 and checked: no placeholder,
 * every image loaded, no horizontal overflow, boards at their measured size where one was measured, and no text overlap
 * or clipping at the Hero info band (B2), the 輪 hub (B1) and the vertical heading (B3) — by layout boxes AND by paint
 * (the text's own pixels, with its colour turned off, must lie inside its box / the hub's disc). Run this file again with
 * FONTCONFIG_FILE set to a CI-like font set to check the vertical heading under font fallback.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadForbiddenSha256 } from "@/lib/design-agent/quality-pipeline/photo-rights";
import { edgesFor, PhotoSlotEdges, PhotoSlotInventory, planSlot, type FocalBox } from "@/lib/design-agent/quality-pipeline/photo-slots";
import { SWAP_SHOP_SPECS } from "@/lib/design-agent/quality-pipeline/photo-swap-shops";
import { loadInventory, swapPage, transformHtml } from "../../../../scripts/design-artifact/photo-swap";
import { deriveEdges, deriveSlots } from "../../../../scripts/design-artifact/photo-slots";

const REPO = resolve(__dirname, "../../../..");
const POC = "design-library/research/quality-pipeline/poc/bicycle";
const FID = `${POC}/fidelity`;
const PAGE = `${FID}/d1-v9`;
const INV = PhotoSlotInventory.parse(JSON.parse(readFileSync(join(REPO, POC, "photo-slots-d1-v9.json"), "utf8")));
const EDGES = PhotoSlotEdges.parse(JSON.parse(readFileSync(join(REPO, POC, "photo-slot-edges-d1-v9.json"), "utf8")));
const EDGE_MAP = edgesFor(INV, EDGES)!;
const V7 = PhotoSlotInventory.parse(JSON.parse(readFileSync(join(REPO, POC, "photo-slots-d1-v7.json"), "utf8")));
const SPEC = SWAP_SHOP_SPECS.bicycle;
const SLOT_IDS = ["ph-d", "ph-a", "ph-c", "ph-b", "ph-bench"];
const FORBIDDEN = loadForbiddenSha256(REPO);
const NOW = "2026-11-06";
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const read = (p: string) => readFileSync(join(REPO, p), "utf8");
const slot = (id: string) => INV.slots.find((s) => s.slot_id === id)!;
const launch = () => chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });

describe("d1-v9: d1-v7 + the three owner-approved options, nothing else", () => {
  const v7 = read(`${FID}/d1-v7/index.html`).split("\n");
  const opt = (o: string) => read(`${FID}/d1-v8-opt-${o}/index.html`).split("\n");
  it("the HTML is d1-v7 with exactly the lines B1 and B3 change and the info band B2 inserts", () => {
    const out = [...v7];
    for (const o of ["hub-disc", "check-horizontal"]) {
      const lines = opt(o);
      expect(lines.length, o).toBe(v7.length);
      lines.forEach((l, i) => {
        if (l !== v7[i]) {
          expect(out[i], `${o} line ${i + 1} also changed by another option`).toBe(v7[i]);
          out[i] = l;
        }
      });
    }
    const cta = opt("cta-hero");
    expect(cta.slice(0, 11)).toEqual(v7.slice(0, 11));
    expect(cta.slice(19)).toEqual(v7.slice(11));
    expect(read(`${PAGE}/index.html`)).toBe([...out.slice(0, 11), ...cta.slice(11, 19), ...out.slice(11)].join("\n"));
  });
  it("the CSS is d1-v7's rules followed by each option's own block, verbatim; copy.json is d1-v7's bytes", () => {
    const css = read(`${PAGE}/style.css`);
    const body7 = read(`${FID}/d1-v7/style.css`).split("\n").slice(4).join("\n").trimEnd();
    expect(css).toContain(body7);
    for (const [o, marker] of [["hub-disc", "/* DEV-183 別案 B"], ["cta-hero", "/* DEV-183 別案 (a)"], ["check-horizontal", "/* DEV-183 横書き案"]] as const) {
      const c = read(`${FID}/d1-v8-opt-${o}/style.css`);
      const block = c.slice(c.indexOf(marker), c.indexOf("/* DEV-183 (review H1)")).trimEnd();
      expect(block.length, o).toBeGreaterThan(200);
      expect(css, o).toContain(block);
    }
    expect(css).toContain(':root { --mincho: "IPAMincho", "IPAGothic", serif; }');
    expect(readFileSync(join(REPO, PAGE, "copy.json"))).toEqual(readFileSync(join(REPO, FID, "d1-v7/copy.json")));
  });
  it("records its provenance: options approved 2026-11-06, the page is not a success example, 5 slots / 6 pictures", () => {
    const readme = read(`${PAGE}/README.md`);
    for (const s of ["2026-11-06", "成功例として採用したのではない", "5枠・6枚", "d1-v8-opt-hub-disc", "d1-v8-opt-cta-hero", "d1-v8-opt-check-horizontal", "copy.json は d1-v7 と同じバイト"]) expect(readme, s).toContain(s);
  });
  it("keeps the drawings and shows only the shop's existing facts in the info band (no link, form or booking)", () => {
    const html = read(`${PAGE}/index.html`);
    for (const c of ["wheel-art wheel-pc", "wheel-art wheel-sp", "reach", "reach-tab", "sp-reach", 'class="hub-name">輪<', "true-art", "gauge-art", "ghost"]) expect(html, c).toContain(c);
    const band = html.slice(html.indexOf('<div class="quick">'), html.indexOf("</div>\n<section"));
    expect(band).not.toMatch(/<(a|form|button|input|script)\b/i);
    const facts = JSON.parse(read(`${POC}/facts-pack.json`)) as { facts: Array<{ key: string; value: string }> };
    const fact = (k: string) => facts.facts.find((f) => f.key === k)!.value;
    const dd = [...band.matchAll(/<dd>([\s\S]*?)<\/dd>/g)].map((m) => m[1]!.replace(/<wbr>/g, ""));
    expect(dd).toEqual([fact("phone"), fact("hours"), fact("closed_days"), fact("address")]);
  });
});

describe("d1-v9's 5 slots, measured again on its own HTML, CSS and copy", () => {
  it("are pinned to d1-v9 (not the d1-v7 files), 5 slots, the d1-v7 slot set", () => {
    expect(INV.page_dir).toBe(PAGE);
    expect(EDGES.page_dir).toBe(PAGE);
    for (const [f, h] of [["index.html", INV.html_sha256], ["style.css", INV.css_sha256], ["copy.json", INV.copy_sha256]] as const) expect(sha(readFileSync(join(REPO, PAGE, f))), f).toBe(h);
    expect(INV.html_sha256).not.toBe(V7.html_sha256);
    expect(INV.css_sha256).not.toBe(V7.css_sha256);
    expect(INV.slots.map((s) => s.slot_id)).toEqual(SLOT_IDS);
    expect(INV.slots.map((s) => s.board_selector)).toEqual(V7.slots.map((s) => s.board_selector));
    expect(EDGES.edge_viewports).toEqual(["mobile_600", "tablet_999", "desktop_1920"]);
    expect(read(`${PAGE}/index.html`).replace(/<wbr>/g, "").match(/写真｜/g)).toHaveLength(5);
  });
  it.each([
    ["ph-d", "desktop_1440", 260, 200],
    ["ph-a", "tablet_1024", 199, 144],
    ["ph-c", "tablet_768", 236, 182],
    ["ph-b", "mobile_390", 278, 188],
    ["ph-bench", "desktop_1440", 760, 560],
    ["ph-bench", "tablet_768", 406, 299],
    // B3 frees the bench's column on SP: 226×414 on d1-v7, 240×440 (its cap) here
    ["ph-bench", "mobile_390", 240, 440],
    ["ph-bench", "mobile_600", 240, 440],
    ["ph-bench", "tablet_999", 527, 389],
    ["ph-bench", "desktop_1920", 1014, 747],
  ])("%s at %s is %i×%i", (id, v, w, h) => {
    expect([...slot(id).variants, ...EDGE_MAP.get(id)!].find((x) => x.viewport === v)).toMatchObject({ width_px: w, height_px: h });
  });
  it("the swap spec names d1-v9 and d1-v7 and renders 輪 at PC, tablet and SP", () => {
    expect(SPEC.pages).toEqual(["d1-v7", "d1-v9"]);
    expect(SPEC.renders.map((r) => r.viewport)).toEqual(["desktop_1440", "tablet_768", "mobile_390"]);
    expect(loadInventory("bicycle", PAGE)).toMatchObject({ ok: true });
    expect(loadInventory("bicycle", `${FID}/d1-v7`)).toMatchObject({ ok: true });
  });
  it("the 6 pictures of the brief's prompt pass the plan on d1-v9 at 2× (range edges included)", () => {
    const text = read("docs/design/bicycle-ai-photo-prompt.txt");
    expect(sha(text)).toBe("83c9b2c628873d645a78145065a5ff5befeab7f406555b79649f1f44d8275594");
    expect(text.split("\n")[0]).toContain("未承認");
    expect(text).toContain("fidelity/d1-v9");
    const photo = Object.fromEntries(
      [...text.matchAll(/^(ph-[a-z-]+) \((\d+):(\d+)(?: portrait)?, at least (\d+)x(\d+) px; subject inside x ([\d.]+)-([\d.]+), y ([\d.]+)-([\d.]+)\):$/gm)].map((m) => [m[1]!, { width: +m[4]!, height: +m[5]!, focal_box: { x: +m[6]!, y: +m[8]!, w: +m[7]! - +m[6]!, h: +m[9]! - +m[8]! } }]),
    );
    expect(Object.keys(photo)).toEqual(["ph-d", "ph-a", "ph-c", "ph-b", "ph-bench-pc", "ph-bench-sp"]);
    for (const id of SLOT_IDS) {
      const photos = id === "ph-bench" ? { pc: photo["ph-bench-pc"]!, sp: photo["ph-bench-sp"]! } : { pc: photo[id]! };
      expect(planSlot(slot(id), photos, { spViewports: SPEC.spViewports, edges: EDGE_MAP.get(id)! }), id).toMatchObject({ ok: true, codes: [] });
    }
    expect(read("docs/design/bicycle-ai-photo-brief.md")).toContain("`83c9b2c628873d645a78145065a5ff5befeab7f406555b79649f1f44d8275594` (3865 バイト)");
  });
});

describe("輪's placeholder structure: exact (container, board, caption) triples (DEV-189 review L2)", () => {
  const html = read(`${PAGE}/index.html`);
  const slotsIn = INV.slots.map((s) => ({ slot: s, alt: s.role, files: { desktop: `photos/${s.slot_id}-desktop.png`, tablet: `photos/${s.slot_id}-tablet.png`, mobile: `photos/${s.slot_id}-mobile.png` }, size: { width: 10, height: 10 } }));
  it("transforms d1-v9 whole, leaving no 写真｜ and no empty board", () => {
    const out = transformHtml(html, slotsIn, SPEC);
    expect(out.replace(/<wbr>/g, "")).not.toContain("写真｜");
    expect(out).not.toContain('<div class="photo"></div>');
    expect((out.match(/<picture data-slot=/g) ?? []).length).toBe(5);
  });
  it.each([
    ["a bench container around a station board", (h: string) => h.replace('<figure class="bench"><div class="board board-bench">', '<figure class="bench"><div class="board">'), "BOARD_NOT_FOUND: ph-bench"],
    ["a station container around a bench board", (h: string) => h.replace('<div class="fig"><div class="board"><div class="photo"></div></div><p class="ph">写真｜<wbr>パンクを', '<div class="fig"><div class="board board-bench"><div class="photo"></div></div><p class="ph">写真｜<wbr>パンクを'), "BOARD_NOT_FOUND: ph-a"],
    ["a station caption under the bench board", (h: string) => h.replace('<p class="ph ph-bench">写真｜', '<p class="ph">写真｜'), "BOARD_NOT_FOUND: ph-bench"],
    ["a bench caption under a station board", (h: string) => h.replace('<p class="ph">写真｜<wbr>外した', '<p class="ph ph-bench">写真｜<wbr>外した'), "BOARD_NOT_FOUND: ph-c"],
  ])("refuses %s (each tag on its own is allowed; the mix is not)", (_, mutate, code) => {
    const bad = mutate(html);
    expect(bad).not.toBe(html);
    expect(() => transformHtml(bad, slotsIn, SPEC)).toThrow(new RegExp(`^${code}$`));
  });
});

type Rect = { l: number; t: number; r: number; b: number };
type Layout = {
  issues: string[];
  band: Rect;
  hub: { cx: number; cy: number; rad: number };
  check_h: Rect;
  /** the union of the heading's character boxes (its element box is the taller grid cell) */
  check_h_text: Rect;
  writing_mode: string;
  counts: { band_lines: number; heading_chars: number; fact_lines: number };
};

/** Layout-box checks for B1, B2 and B3, run in the page (the page's own JS is off). Page coordinates. */
const LAYOUT = String.raw`(() => {
  const sy = window.scrollY, W = window.innerWidth;
  const abs = (q) => ({ l: q.left, t: q.top + sy, r: q.right, b: q.bottom + sy });
  const hit = (a, b) => a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5;
  const inside = (a, b, m = 0.5) => a.l >= b.l - m && a.r <= b.r + m && a.t >= b.t - m && a.b <= b.b + m;
  const lines = (el) => {
    const out = [];
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (!n.textContent.trim()) continue;
      const r = document.createRange(); r.selectNodeContents(n);
      for (const q of Array.from(r.getClientRects())) if (q.width >= 1 && q.height >= 1) out.push(abs(q));
    }
    return out;
  };
  const chars = (el) => {
    const out = [];
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) for (let i = 0; i < n.textContent.length; i++) {
      if (!n.textContent[i].trim()) continue;
      const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 1);
      const q = r.getBoundingClientRect();
      if (q.width >= 1 && q.height >= 1) out.push({ c: n.textContent[i], ...abs(q) });
    }
    return out;
  };
  const issues = [];
  const viewport = { l: 0, r: W, t: -1e9, b: 1e9 };
  // B2: the info band — its words never touch each other, stay inside the band and the window
  const band = document.querySelector(".quick");
  const bb = abs(band.getBoundingClientRect());
  const items = Array.from(band.querySelectorAll("dt, dd")).map((e) => ({ name: e.textContent.trim().slice(0, 12), rs: lines(e) }));
  let bandLines = 0;
  items.forEach((a, i) => {
    bandLines += a.rs.length;
    for (const r of a.rs) { if (!inside(r, bb)) issues.push("band_clip:" + a.name); if (!inside(r, viewport)) issues.push("band_offscreen:" + a.name); }
    items.slice(i + 1).forEach((b) => { if (a.rs.some((p) => b.rs.some((q) => hit(p, q)))) issues.push("band_overlap:" + a.name + "/" + b.name); });
  });
  if (bb.r > W + 0.5) issues.push("band_wider_than_window");
  // PR #232 review L3: the band sits wholly above the hero, so it can never cover the hero's drawing
  const heroTop = abs(document.querySelector('[data-comp-section="hero"]').getBoundingClientRect()).t;
  if (bb.b > heroTop + 0.5) issues.push("band_over_hero");
  const heroText = Array.from(document.querySelectorAll(".name-full, .tagline, .how")).flatMap(lines);
  if (heroText.some((r) => hit(r, bb))) issues.push("band_over_hero_text");
  // B1: 輪 in its disc — the glyph's em square inside the circle, nothing written over the disc
  const hub = document.querySelector(".hub-name");
  const hr = abs(hub.getBoundingClientRect());
  const cx = (hr.l + hr.r) / 2, cy = (hr.t + hr.b) / 2, rad = (hr.r - hr.l) / 2;
  const fs = parseFloat(getComputedStyle(hub).fontSize);
  const g = lines(hub);
  if (g.length !== 1) issues.push("hub_glyph_lines:" + g.length);
  for (const q of g) {
    const gx = (q.l + q.r) / 2, gy = (q.t + q.b) / 2;
    for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) if (Math.hypot(gx + dx * fs / 2 - cx, gy + dy * fs / 2 - cy) > rad + 0.5) issues.push("hub_glyph_outside_disc");
  }
  if (!inside(hr, viewport)) issues.push("hub_offscreen");
  if ([...heroText, ...items.flatMap((i) => i.rs)].some((r) => hit(r, hr))) issues.push("text_over_hub");
  // B3: the vertical heading — vertical, its characters apart, clear of the fact, the bench board and the window edge
  const h = document.querySelector(".check-h");
  const hc = chars(h);
  const fact = lines(document.querySelector(".check-fact"));
  const benchBoard = abs(document.querySelector(".board-bench").getBoundingClientRect());
  const sec = abs(document.querySelector('[data-comp-section="check"]').getBoundingClientRect());
  hc.forEach((a, i) => {
    hc.slice(i + 1).forEach((b) => { if (hit(a, b)) issues.push("heading_chars_overlap:" + a.c + b.c); });
    if (fact.some((f) => hit(a, f))) issues.push("heading_over_fact:" + a.c);
    if (hit(a, benchBoard)) issues.push("heading_over_bench:" + a.c);
    if (!inside(a, sec) || !inside(a, viewport)) issues.push("heading_clipped:" + a.c);
  });
  for (const f of fact) { if (hit(f, benchBoard)) issues.push("fact_over_bench"); if (!inside(f, viewport)) issues.push("fact_offscreen"); }
  return { issues, band: bb, hub: { cx, cy, rad }, check_h: abs(h.getBoundingClientRect()), check_h_text: { l: Math.min(...hc.map((c) => c.l)), t: Math.min(...hc.map((c) => c.t)), r: Math.max(...hc.map((c) => c.r)), b: Math.max(...hc.map((c) => c.b)) }, writing_mode: getComputedStyle(h).writingMode, counts: { band_lines: bandLines, heading_chars: hc.length, fact_lines: fact.length } };
})()`;

/**
 * Paint check: the pixels the element's text puts on the page (its colour on, then turned off) must lie inside `allowed`
 * (a box or a circle, page coordinates) plus a 2px margin. Returns how many pixels the text paints and how many fall outside.
 */
async function inkOutside(page: Page, sel: string, allowed: { box: Rect } | { circle: { cx: number; cy: number; rad: number } }, around: Rect) {
  const full = (await page.evaluate("[document.documentElement.scrollWidth, document.documentElement.scrollHeight]")) as [number, number];
  const pad = 40;
  const clip = { x: Math.max(0, Math.floor(around.l - pad)), y: Math.max(0, Math.floor(around.t - pad)), width: 0, height: 0 };
  clip.width = Math.min(full[0], Math.ceil(around.r + pad)) - clip.x;
  clip.height = Math.min(full[1], Math.ceil(around.b + pad)) - clip.y;
  const shot = () => page.screenshot({ fullPage: true, clip, animations: "disabled" });
  const on = await shot();
  await page.evaluate(`(() => { const s = document.createElement("style"); s.id = "ink-off"; s.textContent = ${JSON.stringify(`${sel}, ${sel} * { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; }`)}; document.head.appendChild(s); })()`);
  const off = await shot();
  await page.evaluate(`document.getElementById("ink-off").remove()`);
  const a = await sharp(on).raw().toBuffer({ resolveWithObject: true });
  const b = await sharp(off).raw().toBuffer();
  const ch = a.info.channels;
  let ink = 0;
  let outside = 0;
  const m = 2;
  for (let y = 0; y < a.info.height; y++)
    for (let x = 0; x < a.info.width; x++) {
      const i = (y * a.info.width + x) * ch;
      if (Math.max(Math.abs(a.data[i]! - b[i]!), Math.abs(a.data[i + 1]! - b[i + 1]!), Math.abs(a.data[i + 2]! - b[i + 2]!)) <= 32) continue;
      ink += 1;
      const px = clip.x + x + 0.5;
      const py = clip.y + y + 0.5;
      const ok = "box" in allowed ? px >= allowed.box.l - m && px <= allowed.box.r + m && py >= allowed.box.t - m && py <= allowed.box.b + m : Math.hypot(px - allowed.circle.cx, py - allowed.circle.cy) <= allowed.circle.rad + m;
      if (!ok) outside += 1;
    }
  return { ink, outside };
}

describe("d1-v9 E2E with 6 MOCK photos: intake → rights → crop → swap → PC 1440 / tablet 768 / SP 390", () => {
  let root: string;
  let pipeline: string;
  let browser: Browser;
  let n = 0;
  const outDir = () => join(root, `out-${++n}`);
  const CENTRE: FocalBox = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "dev190-"));
    pipeline = join(root, "pipeline");
    mkdirSync(join(pipeline, ".intake", "photos"), { recursive: true });
    browser = await launch();
  });
  afterAll(async () => {
    await browser?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  /** intake: a mock PNG in the private .intake/photos/ and the rights record of its measured bytes */
  async function mock(name: string, width: number, height: number, colour: number, over: Record<string, unknown> = {}) {
    const buf = await sharp({ create: { width, height, channels: 3, background: { r: (colour * 5) % 256, g: (colour * 13) % 256, b: (colour * 19) % 256 } } }).png().toBuffer();
    writeFileSync(join(pipeline, ".intake", "photos", `${name}.png`), buf);
    return { schema: "photo_rights_v0", asset_id: `photo-${name}`, sha256: sha(buf), bytes: buf.length, width, height, format: "png", source_kind: "owner_provided", owner: "mock test owner", license: "mock test only", paid: false, allowed_uses: { edit: true, crop: true, commercial: true, public_web: false }, consent_record_ref: "mock-consent", received_at: "2026-11-01", expiry: null, private_path: `.intake/photos/${name}.png`, depicts_identifiable_person: false, depicts_real_shop: false, ...over };
  }
  /** the 6 pictures at the brief's sizes: ph-d/a/c/b one each, the bench a 4:3 PC and a 2:3 SP picture */
  async function sixPhotos(tag: string) {
    const size: Record<string, [number, number]> = { "ph-d": [980, 735], "ph-a": [1040, 694], "ph-c": [1040, 694], "ph-b": [980, 735] };
    const out: Array<Record<string, unknown>> = [];
    for (const [i, s] of INV.slots.entries()) {
      if (s.slot_id === "ph-bench") out.push({ slot_id: s.slot_id, pc: { rights: await mock(`n-${tag}-bench-pc`, 2030, 1523, 70), focal_box: CENTRE }, sp: { rights: await mock(`n-${tag}-bench-sp`, 590, 885, 71), focal_box: CENTRE } });
      else out.push({ slot_id: s.slot_id, pc: { rights: await mock(`n-${tag}-${s.slot_id}`, ...size[s.slot_id]!, 17 * i + 3), focal_box: CENTRE } });
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

  /** the measured board size at a width, where one was measured (the 4 viewports and the 3 range edges) */
  const measured = (id: string, width: number) => {
    const key = { 1440: "desktop_1440", 1024: "tablet_1024", 768: "tablet_768", 390: "mobile_390", 600: "mobile_600", 999: "tablet_999", 1920: "desktop_1920" }[width];
    return key ? [...slot(id).variants, ...EDGE_MAP.get(id)!].find((v) => v.viewport === key)! : null;
  };

  async function openCopy(pageDir: string, width: number, height: number) {
    const dir = realpathSync(pageDir);
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, javaScriptEnabled: false, serviceWorkers: "block" });
    const page = await ctx.newPage();
    const base = `file://${dir}${sep}`;
    const outside: string[] = [];
    await page.route("**/*", (route) => (route.request().url().startsWith(base) ? route.continue() : (outside.push(route.request().url()), route.abort())));
    await page.goto(`${base}index.html`, { waitUntil: "load" });
    await page.evaluate("document.fonts.ready.then(() => true)");
    return { ctx, page, outside };
  }

  it("the whole chain, then every width checked again on the written copy (photos, overflow, boards, B1/B2/B3 by box and by paint)", async () => {
    const out = outDir();
    const res = await run(await sixPhotos("e2e"), out, browser);
    if (!res.ok) throw new Error(JSON.stringify(res.refusals));
    // the swap's own render gate at PC, tablet and SP: every board a loaded photo, no 写真｜, no overflow, boards intact
    expect(res.renders.map((r) => r.viewport)).toEqual(["desktop_1440", "tablet_768", "mobile_390"]);
    for (const r of res.renders) expect(r, r.viewport).toMatchObject({ images: 5, images_loaded: 5, boards_matched: 5, caption_text_left: false, horizontal_overflow: false, boards_intact: 5 });
    // all 6 pictures are used: 3 crop files × 5 slots, the bench's mobile file cut from its SP picture
    const crops = res.summary.crops as Record<string, { source: string; asset_id: string }>;
    expect(new Set(Object.values(crops).map((c) => c.asset_id)).size).toBe(6);
    expect([crops["ph-bench/desktop"]!.source, crops["ph-bench/tablet"]!.source, crops["ph-bench/mobile"]!.source]).toEqual(["pc", "pc", "sp"]);
    expect(readdirSync(join(out, "page", "photos"))).toHaveLength(15);
    expect(res.summary).toMatchObject({ page_dir: PAGE, source_hashes: { html: INV.html_sha256, css: INV.css_sha256, copy: INV.copy_sha256 } });

    const widths: Array<[number, number, "desktop" | "tablet" | "mobile"]> = [[1440, 900, "desktop"], [768, 1024, "tablet"], [390, 844, "mobile"], [1920, 1080, "desktop"], [1024, 768, "desktop"], [1000, 900, "desktop"], [999, 900, "tablet"], [601, 900, "tablet"], [600, 900, "mobile"]];
    for (const [w, h, range] of widths) {
      const { ctx, page, outside } = await openCopy(join(out, "page"), w, h);
      try {
        const seen = (await page.evaluate(`(() => {
          const boards = ${JSON.stringify(INV.slots.map((s) => ({ id: s.slot_id, sel: s.board_selector })))};
          return {
            imgs: Array.from(document.querySelectorAll("img")).map((i) => ({ current: i.currentSrc.split("/").pop(), natural: i.naturalWidth, complete: i.complete, alt: i.alt })),
            placeholders: document.querySelectorAll(".photo:empty").length + document.querySelectorAll("p.ph").length,
            caption_left: document.body.innerText.includes("写真｜"),
            scroll_width: document.documentElement.scrollWidth,
            boards: boards.map((b) => { const el = document.querySelector(b.sel); const img = el.querySelector(".photo > picture > img"); const cs = getComputedStyle(el); return { id: b.id, w: parseFloat(cs.width), h: parseFloat(cs.height), iw: img ? img.offsetWidth : 0, ih: img ? img.offsetHeight : 0 }; }),
          };
        })()`)) as { imgs: Array<{ current: string; natural: number; complete: boolean; alt: string }>; placeholders: number; caption_left: boolean; scroll_width: number; boards: Array<{ id: string; w: number; h: number; iw: number; ih: number }> };
        expect(outside, `${w}`).toEqual([]);
        expect(seen.imgs, `${w}`).toHaveLength(5);
        for (const i of seen.imgs) {
          expect(i.complete && i.natural > 0, `${w} ${i.current}`).toBe(true);
          expect(i.current, `${w}`).toMatch(new RegExp(`-${range}\\.png$`));
          expect(i.alt.length).toBeGreaterThan(0);
        }
        expect([seen.placeholders, seen.caption_left], `${w}`).toEqual([0, false]);
        expect(seen.scroll_width, `${w} horizontal overflow`).toBeLessThanOrEqual(w + 1);
        for (const b of seen.boards) {
          expect(Math.abs(b.iw - b.w) <= 1 && Math.abs(b.ih - b.h) <= 1, `${w} ${b.id} photo fills its board`).toBe(true);
          const m = measured(b.id, w);
          if (m) expect(Math.abs(b.w - m.width_px) <= 2 && Math.abs(b.h - m.height_px) <= 2, `${w} ${b.id} ${b.w}×${b.h} vs ${m.width_px}×${m.height_px}`).toBe(true);
        }
        // B1 / B2 / B3 by layout boxes
        const lay = (await page.evaluate(LAYOUT)) as Layout;
        expect(lay.issues, `${w}`).toEqual([]);
        expect(lay.writing_mode, `${w}`).toBe("vertical-rl");
        expect(lay.counts.band_lines, `${w}`).toBeGreaterThanOrEqual(8);
        expect(lay.counts.heading_chars, `${w}`).toBe([..."どこを直すか、先に決める。"].length);
        expect(lay.counts.fact_lines, `${w}`).toBeGreaterThanOrEqual(1);
        // ... and by paint: the text's own pixels stay in its box / in the disc
        const band = await inkOutside(page, ".quick", { box: lay.band }, lay.band);
        const hubBox = { l: lay.hub.cx - lay.hub.rad, r: lay.hub.cx + lay.hub.rad, t: lay.hub.cy - lay.hub.rad, b: lay.hub.cy + lay.hub.rad };
        const hub = await inkOutside(page, ".hub-name", { circle: lay.hub }, hubBox);
        const head = await inkOutside(page, ".check-h", { box: lay.check_h_text }, lay.check_h);
        for (const [name, r] of [["band", band], ["hub", hub], ["heading", head]] as const) {
          expect(r.ink, `${w} ${name} paints something`).toBeGreaterThan(50);
          expect(r.outside, `${w} ${name} ink outside its box`).toBe(0);
        }
      } finally {
        await ctx.close();
      }
    }
    expect(sha(readFileSync(join(REPO, PAGE, "index.html")))).toBe(INV.html_sha256);
  }, 300_000);

  it("the overlap checks see a real overlap: the heading moved onto the fact, the band's words pushed together", async () => {
    const res = await run(await sixPhotos("neg"), outDir());
    if (!res.ok) throw new Error(JSON.stringify(res.refusals));
    const { ctx, page } = await openCopy(join(res.out, "page"), 1440, 900);
    try {
      await page.evaluate(`(() => { const s = document.createElement("style"); s.textContent = ".check-h { grid-column: 2 !important; } .quick-info div { margin-right: -60px; }"; document.head.appendChild(s); })()`);
      const lay = (await page.evaluate(LAYOUT)) as Layout;
      expect(lay.issues.some((i) => i.startsWith("heading_over_fact"))).toBe(true);
      expect(lay.issues.some((i) => i.startsWith("band_overlap"))).toBe(true);
      // paint: glyphs drawn 120px below the heading's layout box (what a font without vertical metrics does) are caught
      const box = lay.check_h_text;
      await page.evaluate(`(() => { const s = document.createElement("style"); s.textContent = ".check-h { transform: translateY(120px); }"; document.head.appendChild(s); })()`);
      const ink = await inkOutside(page, ".check-h", { box }, { ...box, b: box.b + 140 });
      expect(ink.ink).toBeGreaterThan(50);
      expect(ink.outside).toBeGreaterThan(0);
      // L3: a band pushed down over the hero is caught
      await page.evaluate(`(() => { const s = document.createElement("style"); s.textContent = ".quick { margin-bottom: -40px; }"; document.head.appendChild(s); })()`);
      expect(((await page.evaluate(LAYOUT)) as Layout).issues).toContain("band_over_hero");
    } finally {
      await ctx.close();
    }
  }, 120_000);

  describe("fail closed: refused, and no output at all", () => {
    // DEV-192 (owner GO 2026-11-07): 輪's ai_generated_demo pictures are taken now; one generated "in the future" (a
    // provenance that cannot be true) is still refused, and nothing is written
    it("輪 takes an ai_generated_demo picture only with a sound provenance (DEV-192): AI_GENERATED_IN_FUTURE", async () => {
      const slots = await sixPhotos("ai");
      const r0 = (slots[0]!.pc as { rights: Record<string, unknown> }).rights;
      slots[0] = { ...slots[0]!, pc: { rights: { ...r0, source_kind: "ai_generated_demo", ai_provenance: { generator: "mock generator", model: "mock-model", generated_at: "2026-11-09T10:00:00Z", prompt_sha256: "83c9b2c628873d645a78145065a5ff5befeab7f406555b79649f1f44d8275594", approval_id: "bicycle-mock-run", demo_only: true } }, focal_box: CENTRE } };
      const out = outDir();
      expect((await run(slots, out)) as unknown).toEqual({ ok: false, refusals: [{ slot_id: "ph-d", photo: "pc", codes: ["AI_GENERATED_IN_FUTURE"] }] });
      nothingLeft(out);
    });
    it("the bench without its SP picture, a missing slot, a tampered hash", async () => {
      const slots = await sixPhotos("bad");
      let out = outDir();
      const bench = slots.findIndex((s) => s.slot_id === "ph-bench");
      expect(codesOf(await run(slots.map((s, i) => (i === bench ? { slot_id: "ph-bench", pc: s.pc } : s)), out))).toEqual(["SP_PHOTO_REQUIRED"]);
      nothingLeft(out);
      out = outDir();
      expect(codesOf(await run(slots.slice(0, 4), out))).toEqual(expect.arrayContaining(["SLOTS_INCOMPLETE", "missing:ph-bench"]));
      nothingLeft(out);
      const r1 = (slots[1]!.pc as { rights: Record<string, unknown> }).rights;
      out = outDir();
      expect(codesOf(await run(slots.map((s, i) => (i === 1 ? { ...s, pc: { rights: { ...r1, sha256: "0".repeat(64) }, focal_box: CENTRE } } : s)), out))).toEqual(["HASH_MISMATCH"]);
      nothingLeft(out);
    });
    it("a late failure at the tablet render leaves nothing", async () => {
      const slots = await sixPhotos("late");
      let call = 0;
      const good = { images: 5, images_loaded: 5, boards_matched: 5, caption_text_left: false, scroll_width: 1440, horizontal_overflow: false, boards_intact: 5 };
      const fake = {
        newContext: async () => ({
          newPage: async () => ({ route: async () => {}, goto: async () => null, evaluate: async (e: string) => (e.startsWith("document.fonts") ? true : (call += 1) === 2 ? { ...good, horizontal_overflow: true, scroll_width: 800 } : good), screenshot: async () => Buffer.from("png") }),
          close: async () => {},
        }),
      } as unknown as Browser;
      const out = outDir();
      expect(codesOf(await run(slots, out, fake))).toEqual(["RENDER_CHECK_FAILED", "viewport:tablet_768"]);
      nothingLeft(out);
    });
    it("the d1-v8 options (same placeholders, no inventory) are refused as not inventoried", () => {
      for (const o of ["hub-disc", "cta-hero", "check-horizontal"]) expect(loadInventory("bicycle", `${FID}/d1-v8-opt-${o}`), o).toEqual({ ok: false, code: "PAGE_NOT_INVENTORIED" });
    });
  });

  it("the committed d1-v9 inventory and range edges are what the page measures now (within 2px)", async () => {
    const inv = await deriveSlots(browser, "bicycle", PAGE);
    expect({ ...inv, slots: [] }).toEqual({ ...INV, slots: [] });
    const edges = await deriveEdges(browser, inv);
    expect({ ...edges, slots: [] }).toEqual({ ...EDGES, slots: [] });
    for (const [i, s] of inv.slots.entries())
      for (const [j, v] of [...s.variants, ...edges.slots[i]!.edges].entries()) {
        const c = [...INV.slots[i]!.variants, ...EDGES.slots[i]!.edges][j]!;
        expect([v.viewport, Math.abs(v.width_px - c.width_px) <= 2, Math.abs(v.height_px - c.height_px) <= 2], s.slot_id).toEqual([c.viewport, true, true]);
      }
  }, 180_000);
});
