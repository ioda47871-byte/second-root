// DEV-114: fictional Design Artifact packages (no real shop, no Codex output, no real image).
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { crc32, deflateSync } from "node:zlib";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

export const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** One PNG chunk with a correct CRC (type is written as given, even when invalid). */
export function pngChunk(type: string, data: Buffer): Buffer {
  const t = Buffer.from(type, "latin1");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0);
  return Buffer.concat([len, t, data, crc]);
}

export function ihdr(width: number, height: number, over: { depth?: number; colour?: number; interlace?: number } = {}): Buffer {
  const d = Buffer.alloc(13);
  d.writeUInt32BE(width, 0);
  d.writeUInt32BE(height, 4);
  d[8] = over.depth ?? 8;
  d[9] = over.colour ?? 0;
  d[12] = over.interlace ?? 0;
  return d;
}

/**
 * An 8-bit greyscale PNG of the given size (blank). The IDAT is a valid stream only for small images; for very
 * large sizes it is a short placeholder (the structural check never decodes pixels). `extra` chunks go before IEND.
 */
export function makePng(width: number, height: number, extra: Buffer[] = []): Buffer {
  const idat = width * height <= 40_000_000 ? deflateSync(Buffer.alloc((width + 1) * height)) : deflateSync(Buffer.alloc(16));
  return Buffer.concat([PNG_SIG, pngChunk("IHDR", ihdr(width, height)), pngChunk("IDAT", idat), ...extra, pngChunk("IEND", Buffer.alloc(0))]);
}

export const FACTS = {
  schema: "shop_facts_pack_v1",
  shop_id: "fictional-bakery",
  facts: [
    { id: "F1", key: "name", value: "架空ベーカリー", source_id: "S1" },
    { id: "F2", key: "hours", value: "8:00〜17:00", source_id: "S2" },
    { id: "F3", key: "motif", value: "木の棚に毎朝のパンを並べる", source_id: "S3" },
  ],
};

const DNA = Object.fromEntries(
  ["hero", "typography", "palette", "product_visual", "section_rhythm", "navigation", "mobile", "implementation"].map((p) => [p, { choice: `架空の${p}の選択`, fact_refs: ["F3"] }]),
);

export const HEIGHTS = { desktop_1440: 2000, mobile_390: 3000 };

export function declared() {
  return {
    schema: "codex_design_v1",
    design_dna: structuredClone(DNA),
    structure_spec: {
      page_height: { ...HEIGHTS },
      sections: [
        { id: "header", role: "header", boxes: { desktop_1440: { x: 0, y: 0, w: 1440, h: 120 }, mobile_390: { x: 0, y: 0, w: 390, h: 100 } }, live_text: [{ fact_ref: "F1" }], asset_refs: [] },
        { id: "shelf_hero", role: "hero", boxes: { desktop_1440: { x: 0, y: 120, w: 1440, h: 900 }, mobile_390: { x: 0, y: 100, w: 390, h: 1400 } }, live_text: [{ fact_ref: "F3" }], asset_refs: [] },
        { id: "info", role: "info", boxes: { desktop_1440: { x: 0, y: 1020, w: 1440, h: 800 }, mobile_390: { x: 0, y: 1500, w: 390, h: 1300 } }, live_text: [{ ui_label: "営業時間" }, { fact_ref: "F2" }], asset_refs: [] },
        { id: "footer", role: "footer", boxes: { desktop_1440: { x: 0, y: 1820, w: 1440, h: 180 }, mobile_390: { x: 0, y: 2800, w: 390, h: 200 } }, live_text: [], asset_refs: [] },
      ],
      order: { desktop_1440: ["header", "shelf_hero", "info", "footer"], mobile_390: ["header", "shelf_hero", "info", "footer"] },
      reading_path: { desktop_1440: ["shelf_hero", "info"], mobile_390: ["shelf_hero", "info"] },
    },
    interaction_spec: [],
  };
}

export const HTML = "<!doctype html><html><body><header>架空ベーカリー</header></body></html>";
export const CSS = "body{margin:0}";

const GEN = {
  status: "succeeded",
  tool: "codex_cli",
  tool_version: "0.200.0",
  model_reported: "fictional-model-1",
  approval_id: "fictional-run-20261028-01",
  prompt_sha256: "b".repeat(64),
  worker_commit: "c".repeat(40),
  run_id: "run_abcdef",
  started_at: "2026-10-28T10:00:00Z",
  finished_at: "2026-10-28T10:05:00Z",
  image_outcome: "not_applicable",
};

type Files = Record<string, Buffer | string>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests mutate nested fields freely to build invalid artifacts
export type Pkg = { artifact: Record<string, any>; files: Files };

const role = (p: string) => (p.startsWith("originals/") ? "original" : p.startsWith("assets/") ? "asset" : "prototype");

/** Route B: a prototype and two browser renders. */
export function routeB(): Pkg {
  const files: Files = {
    "originals/desktop_1440.png": makePng(1440, HEIGHTS.desktop_1440),
    "originals/mobile_390.png": makePng(390, HEIGHTS.mobile_390),
    "quarantine/index.html": HTML,
    "quarantine/styles.css": CSS,
  };
  const render = (path: string, w: number, h: number) => ({ state: "present", path, kind: "viewport_render", rendered_from: "html_prototype_screenshot", width: w, height: h });
  return {
    files,
    artifact: {
      schema: "design_artifact_v1",
      artifact_id: "DA-20261028-abc123",
      route: "B_html_prototype",
      source_kind: "codex_generated",
      shop: { shop_id: "fictional-bakery", display_name: "架空ベーカリー" },
      facts_pack_sha256: "",
      declared: declared(),
      observed: {
        files: [],
        originals: { desktop_1440: render("originals/desktop_1440.png", 1440, HEIGHTS.desktop_1440), mobile_390: render("originals/mobile_390.png", 390, HEIGHTS.mobile_390) },
        render: { device_scale_factor: 1, javascript: "disabled", network: "blocked", full_page: true },
        assets: [],
        prototype: { html_path: "quarantine/index.html", css_path: "quarantine/styles.css" },
        generation: { ...GEN },
        stops: [],
        missing: [],
      },
    },
  };
}

/** Route A: two concept images from the image tool. */
export function routeA(): Pkg {
  const p = routeB();
  p.files = { "originals/desktop_concept.png": makePng(1024, 1536), "originals/mobile_concept.png": makePng(1024, 1536) };
  const concept = (path: string) => ({ state: "present", path, kind: "concept_image", rendered_from: "image_tool", width: 1024, height: 1536 });
  p.artifact.route = "A_image";
  p.artifact.observed.originals = { desktop_1440: concept("originals/desktop_concept.png"), mobile_390: concept("originals/mobile_concept.png") };
  p.artifact.observed.render = null;
  p.artifact.observed.prototype = null;
  p.artifact.observed.generation.image_outcome = "IMAGE_SAVED";
  return p;
}

/** Route C: route B plus one approved generated asset used by the hero. */
export function routeC(): Pkg {
  const p = routeB();
  p.files["assets/a1.png"] = makePng(800, 600);
  p.artifact.route = "C_hybrid";
  p.artifact.observed.assets = [{ id: "A1", path: "assets/a1.png", kind: "ai_concept", approval_id: "fictional-asset-20261028-01", use: "design_only" }];
  p.artifact.observed.generation.image_outcome = "IMAGE_SAVED";
  p.artifact.declared.structure_spec.sections[1].asset_refs = ["A1"];
  return p;
}

/**
 * Writes a package (files + artifact.json) and the facts pack to a new temp dir.
 * observed.files and facts_pack_sha256 are filled from the real bytes unless `raw` is set.
 */
export function writePackage(p: Pkg, opts: { raw?: boolean; facts?: unknown } = {}) {
  const base = mkdtempSync(join(tmpdir(), "dev114-"));
  const dir = join(base, "pkg");
  mkdirSync(dir);
  for (const [rel, data] of Object.entries(p.files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), data);
  }
  const factsBytes = Buffer.from(JSON.stringify(opts.facts ?? FACTS));
  const factsPath = join(base, "facts.json");
  writeFileSync(factsPath, factsBytes);
  const artifact = structuredClone(p.artifact);
  if (!opts.raw) {
    artifact.facts_pack_sha256 = sha(factsBytes);
    artifact.observed.files = Object.entries(p.files).map(([path, data]) => ({ path, role: role(path), sha256: sha(data), bytes: Buffer.byteLength(data) }));
  }
  writeFileSync(join(dir, "artifact.json"), JSON.stringify(artifact));
  return { base, dir, factsPath, artifact };
}
