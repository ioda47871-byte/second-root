/**
 * Issue #293 P1: DUMMY fixtures for the IMAGE_FIRST contract. Everything here is synthetic and made in the test:
 * a fictional shop (架空ランプ店 テスト灯), a five-section dummy direction, flat-colour "pictures" drawn in memory
 * (no photo, no real comp, nothing taken from any earlier shop design), and the side records bound to their SHAs.
 *
 * makeRun writes one run directory under the OS temp dir (outside the repository, as a real run must be).
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodePng, type RgbImage } from "@/lib/design-agent/image-first/pixels";
import { compSetSha256 } from "@/lib/design-agent/image-first/owner-gate";
import type { ModelFullPageComp } from "@/lib/design-agent/image-first/record";

export const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

export const SHOP = { shop_id: "fictional-test-lamp", display_name: "架空ランプ店 テスト灯", category_code: "lamp_shop" } as const;
export const FACTS = {
  schema: "shop_facts_pack_v1",
  shop_id: SHOP.shop_id,
  facts: [
    { id: "F1", key: "name", value: "架空ランプ店 テスト灯", source_id: "S1" },
    { id: "F2", key: "feature", value: "毎晩灯す小さなランプを並べています。", source_id: "S1" },
    { id: "F3", key: "hours", value: "18:00〜22:00", source_id: "S1" },
  ],
};
export const SECTION_IDS = ["header", "hero", "story", "info", "footer"] as const;
export const DIRECTION = { id: "t1-dummy-lamp-axis", concept: "dummy direction for tests only", sections: SECTION_IDS.map((id) => ({ id, motif_facet: `dummy ${id}` })) };

/** Flat colour per section (the same palette on PC and SP; the layouts differ). */
const COLOURS: Record<string, [number, number, number]> = { header: [30, 30, 40], hero: [200, 150, 60], story: [240, 235, 220], info: [70, 110, 90], footer: [20, 20, 25] };

type Band = { id: string; y0: number; y1: number };
/** A synthetic picture: section bands of flat colour with a layout of blocks inside (two columns on PC, one on SP). */
export function drawPart(width: number, height: number, bands: Band[], layout: "pc" | "sp", seed = 0): RgbImage {
  const data = Buffer.alloc(width * height * 3, 255);
  const fill = (x0: number, y0: number, x1: number, y1: number, c: [number, number, number]) => {
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(height, Math.floor(y1)); y++)
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(width, Math.floor(x1)); x++) data.set(c, (y * width + x) * 3);
  };
  for (const b of bands) {
    const c = COLOURS[b.id]!;
    const y0 = b.y0 * height;
    const y1 = b.y1 * height;
    fill(0, y0, width, y1, c);
    const ink: [number, number, number] = c[0] + c[1] + c[2] > 380 ? [40, 40, 40] : [245, 240, 230];
    const h = y1 - y0;
    if (layout === "pc") {
      // a media block on the left, text lines on the right
      fill(width * 0.06, y0 + h * 0.15, width * 0.46, y0 + h * 0.85, [ink[0] * 0.6 + c[0] * 0.4, ink[1] * 0.6 + c[1] * 0.4, ink[2] * 0.6 + c[2] * 0.4] as [number, number, number]);
      for (let i = 0; i < 4; i++) fill(width * 0.54, y0 + h * (0.2 + i * 0.16), width * (0.9 - i * 0.07 - seed * 0.01), y0 + h * (0.27 + i * 0.16), ink);
    } else {
      // one column: a full-width media block, then text lines under it
      fill(width * 0.08, y0 + h * 0.08, width * 0.92, y0 + h * 0.5, [ink[0] * 0.6 + c[0] * 0.4, ink[1] * 0.6 + c[1] * 0.4, ink[2] * 0.6 + c[2] * 0.4] as [number, number, number]);
      for (let i = 0; i < 3; i++) fill(width * 0.08, y0 + h * (0.58 + i * 0.12), width * (0.86 - i * 0.12 - seed * 0.01), y0 + h * (0.64 + i * 0.12), ink);
    }
  }
  return { width, height, data };
}

type PartPlan = { index: number; name: string; bands: Band[] };
const PC_PLAN: PartPlan[] = [
  { index: 1, name: "pc-01", bands: [{ id: "header", y0: 0, y1: 0.12 }, { id: "hero", y0: 0.12, y1: 1 }] },
  { index: 2, name: "pc-02", bands: [{ id: "story", y0: 0, y1: 0.45 }, { id: "info", y0: 0.45, y1: 0.85 }, { id: "footer", y0: 0.85, y1: 1 }] },
];
const SP_PLAN: PartPlan[] = [
  { index: 1, name: "sp-01", bands: [{ id: "header", y0: 0, y1: 0.1 }, { id: "hero", y0: 0.1, y1: 1 }] },
  { index: 2, name: "sp-02", bands: [{ id: "story", y0: 0, y1: 0.6 }, { id: "info", y0: 0.6, y1: 1 }] },
  // info continues over the seam (continuous): its colour runs across the cut
  { index: 3, name: "sp-03", bands: [{ id: "info", y0: 0, y1: 0.4 }, { id: "footer", y0: 0.4, y1: 1 }] },
];
export const PC_SIZE = { width: 1152, height: 768 };
export const SP_SIZE = { width: 768, height: 1152 };

const THREAD = "0193a7c2-1111-4222-8333-944455556666";
export const APPROVAL = "if-test-approval-01";

export type RunOptions = {
  /** Replace a picture's bytes (by part name) after the record is written (SHA mismatch, JPEG, …). */
  replaceBytes?: Record<string, Buffer>;
  /** Pictures to use instead of the drawn ones (by part name), BEFORE the record is written. */
  pictures?: Record<string, RgbImage>;
  /** Change the record before it is written (the SHAs are already computed). */
  mutate?: (r: ModelFullPageComp) => void;
  /** Change the visual read / identity file before they are written. */
  mutateRead?: (read: ReturnType<typeof visualRead>) => void;
  mutateIdentity?: (id: { schema: string; run_id: string; audits: Record<string, unknown>[] }) => void;
  /** Leave files out. */
  omit?: ("visual-read.json" | "identity.json" | "facts-pack.json" | "direction.json" | "prompts")[];
  /** Write an owner evaluation (passing unless changed by the callback). */
  owner?: boolean | ((ev: Record<string, unknown>) => void);
};

export const made: string[] = [];
export const cleanup = () => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
};

function visualRead(record: ModelFullPageComp) {
  const parts = (["desktop_1440", "mobile_390"] as const).flatMap((v) => {
    const c = record.viewports[v];
    if (!c) return [];
    return c.parts.map((p, i) => ({
      inspected_sha256: p.png_sha256,
      observed_section_ids: p.sections.map((s) => s.id),
      header_visible: i === 0,
      footer_visible: i === c.parts.length - 1,
      web_structure: { nav: i === 0, text_blocks: true, info_block: p.sections.some((s) => s.id === "info") },
      photo_only: false,
      looks_like_browser_screenshot: false,
      visible_texts: i === 0 ? [{ text: SHOP.display_name, kind: "shop_name" }, { text: "毎晩灯す小さなランプを並べています", kind: "fact" }, { text: "灯りのある夜へ", kind: "creative" }] : [{ text: "営業時間", kind: "ui_label" }, { text: "18:00〜22:00", kind: "fact" }],
      note: "dummy synthetic picture: flat bands and blocks",
    }));
  });
  return { schema: "image_first_visual_read_v0", run_id: record.run_id, method: "assistant_visual", parts, sp_independent: { judged: true, note: "single column with its own order and spacing (dummy)" } };
}

function identityAudit(imageSha: string, name: string = SHOP.display_name) {
  return {
    schema_version: 1,
    case_id: "CP-901",
    attempt_id: "dummy",
    target: { official_name: SHOP.display_name, allowed_aliases: [], category_code: SHOP.category_code, official_source_url: "https://example.com/fictional-test-lamp" },
    prompt: { shop_name: SHOP.display_name, category_code: SHOP.category_code, is_research_only: true },
    output: { image_sha256: imageSha },
    visual_inspection: { status: "completed", method: "assistant_visual", inspected_image_sha256: imageSha, reviewer_note: "dummy", visible_site_identity_labels: [name], category_code: SHOP.category_code, unreadable_site_identity: false, image_looks_like_unrelated_shop: false },
  };
}

/** A passing owner evaluation for the record as written (the dummy is scored as a `real` comp to exercise the gate). */
export function ownerEvaluation(record: ModelFullPageComp, recordBytes: Buffer) {
  const set = compSetSha256(record)!;
  return {
    schema: "image_first_owner_evaluation_v0",
    run_id: record.run_id,
    record_sha256: sha(recordBytes),
    comp_set_sha256: set,
    viewed_composites: true,
    image_first_hard_fails: { not_a_website: false, hero_only: false, sp_not_independent: false, other_shop: false, fabricated_text: false },
    evaluation: {
      version: 1,
      comp_sha256: set,
      comp_kind: "real",
      hard_fails: { invented_facts: false, store_or_people: false, disclosure: false, logo_or_realism: false, shop_facts: false },
      scores: { beauty: 5, fit: 4, originality: 5, structure: 4, implementability: 5 },
      total: 23,
      human_confirmed: true,
      confirmed_by: "owner-dummy",
      confirmed_at: "2026-11-19T12:00:00+09:00",
    },
  };
}

/** Writes a dummy run; returns its directory, the record and the pictures. */
export function makeRun(o: RunOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sr-image-first-"));
  made.push(dir);
  mkdirSync(join(dir, "parts"));
  mkdirSync(join(dir, "prompts"));
  const factsBytes = Buffer.from(`${JSON.stringify(FACTS, null, 2)}\n`);
  const directionBytes = Buffer.from(`${JSON.stringify(DIRECTION, null, 2)}\n`);
  if (!o.omit?.includes("facts-pack.json")) writeFileSync(join(dir, "facts-pack.json"), factsBytes);
  if (!o.omit?.includes("direction.json")) writeFileSync(join(dir, "direction.json"), directionBytes);
  const pictures: Record<string, RgbImage> = {};
  const part = (plan: PartPlan, layout: "pc" | "sp", call: number) => {
    const size = layout === "pc" ? PC_SIZE : SP_SIZE;
    const img = o.pictures?.[plan.name] ?? drawPart(size.width, size.height, plan.bands, layout, plan.index);
    pictures[plan.name] = img;
    const png = encodePng(img);
    writeFileSync(join(dir, "parts", `${plan.name}.png`), png);
    const prompt = `DUMMY prompt for ${plan.name}: a ${layout} section picture of a fictional lamp shop (test only).\n`;
    if (!o.omit?.includes("prompts")) writeFileSync(join(dir, "prompts", `${plan.name}.txt`), prompt);
    return {
      index: plan.index,
      file: `parts/${plan.name}.png`,
      png_sha256: sha(png),
      width: img.width,
      height: img.height,
      bytes: png.length,
      rendered_from: "image_tool",
      prompt_file: `prompts/${plan.name}.txt`,
      prompt_sha256: sha(prompt),
      prompt_chars: prompt.length,
      call: { thread_id: THREAD, item_id: `ig_${call}`, approval_id: APPROVAL },
      sections: plan.bands.map((b) => ({ id: b.id, box: { x: 0, y: b.y0, w: 1, h: b.y1 - b.y0 } })),
    };
  };
  const record: ModelFullPageComp = {
    schema: "model_full_page_comp_v0",
    output_kind: "MODEL_GENERATED_FULL_PAGE_COMP",
    route: "IMAGE_FIRST",
    run_id: "if-dummy-lamp-01",
    shop: { ...SHOP },
    facts_pack_sha256: sha(factsBytes),
    direction: { direction_id: DIRECTION.id, direction_sha256: sha(directionBytes), set_sha256: null },
    viewports: {
      desktop_1440: { target_css_width: 1440, mode: "section_sequence", section_order: [...SECTION_IDS], parts: PC_PLAN.map((p, i) => part(p, "pc", i + 1)), seams: [{ after_part: 1, kind: "section_break" }] },
      mobile_390: {
        target_css_width: 390,
        mode: "section_sequence",
        section_order: [...SECTION_IDS],
        parts: SP_PLAN.map((p, i) => part(p, "sp", i + 3)),
        seams: [
          { after_part: 1, kind: "section_break" },
          { after_part: 2, kind: "continuous" },
        ],
      },
    },
    generation: {
      tool: "codex_cli",
      cli_version: "0.169.0",
      session_model: null,
      image_tool: "image_gen.imagegen",
      image_model: "gpt-image-2",
      repo_commit: "0".repeat(40),
      plan_id: "if-dummy-plan-01",
      approval_ids: [APPROVAL],
      approval_packet_sha256: sha("dummy approval packet (test only)"),
      started_at: "2026-11-19T10:00:00Z",
      finished_at: "2026-11-19T10:05:00Z",
      image_calls: 5,
      image_completed: 5,
      image_failed: 0,
      outcome: "IMAGE_SAVED",
      stop_code: null,
    },
    rights: { use: "design_reference_only", page_asset: false, public_web: false, ai_generated: true, crop_as_asset: false, text_is_fact_source: false },
    storage: { location_kind: "private_outside_repo", path_in_record: false },
    generated_at: "2026-11-19T10:06:00Z",
  };
  o.mutate?.(record);
  const recordBytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
  writeFileSync(join(dir, "manifest.json"), recordBytes);
  for (const [name, bytes] of Object.entries(o.replaceBytes ?? {})) writeFileSync(join(dir, "parts", `${name}.png`), bytes);
  const read = visualRead(record);
  o.mutateRead?.(read);
  if (!o.omit?.includes("visual-read.json")) writeFileSync(join(dir, "visual-read.json"), JSON.stringify(read));
  const allShas = (["desktop_1440", "mobile_390"] as const).flatMap((v) => record.viewports[v]?.parts.map((p) => p.png_sha256) ?? []);
  const identity = { schema: "image_first_identity_v0", run_id: record.run_id, audits: allShas.map((s) => identityAudit(s) as Record<string, unknown>) };
  o.mutateIdentity?.(identity);
  if (!o.omit?.includes("identity.json")) writeFileSync(join(dir, "identity.json"), JSON.stringify(identity));
  if (o.owner) {
    const ev = ownerEvaluation(record, recordBytes) as unknown as Record<string, unknown>;
    if (typeof o.owner === "function") o.owner(ev);
    writeFileSync(join(dir, "owner-evaluation.json"), JSON.stringify(ev));
  }
  return { dir, record, recordBytes, pictures };
}
