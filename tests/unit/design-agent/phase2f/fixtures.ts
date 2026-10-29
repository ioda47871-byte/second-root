// Phase 2f-1: fictional inputs only (no real shop, no Codex output, no generated image).
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";

export const FACTS = {
  schema: "shop_facts_pack_v1",
  shop_id: "fictional-wagashi",
  facts: [
    { id: "F1", key: "name", value: "架空菓庵", source_id: "S1" },
    { id: "F2", key: "hours", value: "9:00〜17:00", source_id: "S2" },
    { id: "F3", key: "description", value: "毎朝炊く粒あんのどら焼き", source_id: "S3" },
  ],
};

export const BRIEF = {
  schema: "phase2f_design_brief_v1",
  dna: {
    hero: "a single wrapped sweet, close and quiet",
    typography: "vertical shop name, calm serif",
    palette: "rice paper, azuki red, ink",
    product_visual: "one sweet at a time",
    section_rhythm: "slow, wide margins",
    navigation: "minimal, text only",
    mobile: "the morning story first, then the shop facts",
    implementation: "plain HTML and CSS",
  },
  avoid: ["generic hero with centred headline and button"],
};

const DNA = Object.fromEntries(Object.keys(BRIEF.dna).map((p) => [p, { choice: `架空の${p}`, fact_refs: ["F3"] }]));

/** A Codex-shaped answer for route B (or C with `asset`), with a prototype that renders something visible. */
export function answer(o: { asset?: "hero" | "story" | null; css?: string; html?: string; extraSection?: boolean } = {}) {
  const img = (where: string) => (o.asset === where ? `<img src="assets/A1.png" alt="A wrapped dorayaki on rice paper, morning light" style="width:240px;height:160px">` : "");
  const html =
    o.html ??
    `<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body>
<header data-section="header"><h1>架空菓庵</h1></header>
<section data-section="hero"><p>毎朝炊く粒あんのどら焼き</p>${img("hero")}</section>
<section data-section="story"><p>9:00〜17:00</p>${img("story")}</section>
<footer data-section="footer"><p>架空菓庵</p></footer>
</body></html>`;
  const css =
    o.css ??
    `body{margin:0;background:#f4efe6;color:#2b1d14;font-family:serif}header{padding:24px 48px;border-bottom:4px solid #8c2f39}
section{min-height:420px;padding:48px}[data-section=hero]{background:#8c2f39;color:#fff;min-height:1000px}footer{background:#2b1d14;color:#f4efe6;padding:32px}
@media (max-width:600px){section{padding:24px;min-height:300px}}`;
  const box = (y: number, h: number, w: number) => ({ x: 0, y, w, h });
  const sections = [
    { id: "header", role: "header", boxes: { desktop_1440: box(0, 100, 1440), mobile_390: box(0, 100, 390) }, live_text: [{ fact_ref: "F1" }], asset_refs: [] as string[] },
    { id: "hero", role: "hero", boxes: { desktop_1440: box(100, 500, 1440), mobile_390: box(100, 400, 390) }, live_text: [{ fact_ref: "F3" }], asset_refs: o.asset === "hero" ? ["A1"] : [] },
    { id: "story", role: "story", boxes: { desktop_1440: box(600, 500, 1440), mobile_390: box(500, 400, 390) }, live_text: [{ fact_ref: "F2" }], asset_refs: o.asset === "story" ? ["A1"] : [] },
    { id: "footer", role: "footer", boxes: { desktop_1440: box(1100, 100, 1440), mobile_390: box(900, 100, 390) }, live_text: [], asset_refs: [] as string[] },
  ];
  if (o.extraSection) sections.push({ id: "ghost", role: "other", boxes: { desktop_1440: box(0, 10, 10), mobile_390: box(0, 10, 10) }, live_text: [], asset_refs: [] });
  const ids = sections.map((s) => s.id);
  return {
    schema: "codex_design_v1",
    design_dna: DNA,
    structure_spec: { page_height: { desktop_1440: 1200, mobile_390: 1000 }, sections, order: { desktop_1440: ids, mobile_390: ids }, reading_path: { desktop_1440: ["hero", "story"], mobile_390: ["hero", "story"] } },
    interaction_spec: [],
    prototype: { html, css },
  };
}

export const GENERATION = {
  status: "succeeded" as const,
  tool: "codex_cli" as const,
  tool_version: "0.200.0",
  model_reported: "fictional-model-1",
  approval_id: "fictional-2f-b-20261029-01",
  prompt_sha256: "b".repeat(64),
  worker_commit: "c".repeat(40),
  run_id: "run_2fabcdef",
  started_at: "2026-10-29T10:00:00Z",
  finished_at: "2026-10-29T10:05:00Z",
};

/** A small valid RGB PNG with some variety (a stand-in for a generated image). */
export function colourPng(w = 64, h = 48): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.from(type, "latin1");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([(x * 4) & 255, (y * 5) & 255, 120], y * (w * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** A temp workspace with the facts pack written; returns its paths. */
export function workspace() {
  const base = mkdtempSync(join(tmpdir(), "dev115-"));
  const factsPath = join(base, "facts.json");
  writeFileSync(factsPath, JSON.stringify(FACTS));
  mkdirSync(join(base, "runs"));
  return { base, factsPath, out: (name: string) => join(base, "runs", name) };
}
