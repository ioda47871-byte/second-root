/**
 * DEV-196s: a SYNTHETIC 輪 photo-swap output in photo-swap.ts's layout, for tests only: the committed d1-v9 page
 * transformed by the real photo-swap transform, tiny generated pictures for every crop and every original, a fake rights
 * file (a fixture model name, the approved prompt's sha256) and the summary. The real photos never enter.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { BICYCLE_PROMPT_SHA256 } from "@/lib/design-agent/quality-pipeline/bicycle-ai-photos";
import { PhotoSlotInventory } from "@/lib/design-agent/quality-pipeline/photo-slots";
import { BICYCLE_SWAP_CSS, SWAP_SHOP_SPECS } from "@/lib/design-agent/quality-pipeline/photo-swap-shops";
import { transformHtml } from "../../scripts/design-artifact/photo-swap";

export const REPO = join(__dirname, "../..");
export const POC = "design-library/research/quality-pipeline/poc/bicycle";
export const PAGE = `${POC}/fidelity/d1-v9`;
export const INV = PhotoSlotInventory.parse(JSON.parse(readFileSync(join(REPO, POC, "photo-slots-d1-v9.json"), "utf8")));
export const SPEC = SWAP_SHOP_SPECS.bicycle;
export const RANGES = ["desktop", "tablet", "mobile"] as const;
export const NOW = "2026-11-11";
export const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const tmp: string[] = [];
export const cleanupDirs = () => tmp.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
export const newDir = () => {
  const d = mkdtempSync(join(tmpdir(), "rin-swap-"));
  tmp.push(d);
  return d;
};

export const png = (w: number, h: number, c: number) => sharp({ create: { width: w, height: h, channels: 3, background: { r: c, g: (c * 7) % 255, b: 200 - (c % 150) } } }).png().toBuffer();
/** a gradient with grain (much larger lossless than lossy) for the size-limit branches */
export const noise = (w: number, h: number) => {
  const raw = Buffer.alloc(w * h * 3);
  let x = 12345;
  for (let i = 0; i < raw.length; i += 1) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const px = Math.floor(i / 3);
    raw[i] = (((px % w) + Math.floor(px / w)) + ((x >> 16) & 0x3f)) & 0xff;
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
};

export type Obj = Record<string, unknown>;
export const sub = (o: Obj, k: string) => o[k] as Obj;
export const recOf = (r: Obj, slot: number, photo = 0) => (r.slots as { photos: { rights: Obj }[] }[])[slot]!.photos[photo]!.rights;

export type Fixture = { root: string; page: string; rightsPath: string; summaryPath: string; originals: string; rights: Record<string, unknown>; summary: Record<string, unknown> };

export const SOURCES = ["ph-a", "ph-b", "ph-c", "ph-d", "ph-bench-pc", "ph-bench-sp"] as const;
export function record(id: string, bytes: Buffer, w: number, h: number): Record<string, unknown> {
  return {
    schema: "photo_rights_v0",
    asset_id: `photo-${id}`,
    sha256: sha(bytes),
    bytes: bytes.byteLength,
    width: w,
    height: h,
    format: "png",
    source_kind: "ai_generated_demo",
    owner: "fixture owner",
    license: "fixture licence",
    paid: false,
    allowed_uses: { edit: true, crop: true, commercial: true, public_web: false },
    consent_record_ref: "fixture-consent",
    received_at: "2026-11-06",
    expiry: null,
    private_path: `.intake/photos/${id}.png`,
    depicts_identifiable_person: false,
    depicts_real_shop: false,
    ai_provenance: { generator: "fixture generator", model: "fixture-gen", generated_at: "2026-11-06T20:10:51+09:00", prompt_sha256: BICYCLE_PROMPT_SHA256, approval_id: "fixture-approval-01", demo_only: true },
  };
}

/** A swap output in the photo-swap layout, built from synthetic pictures. */
export async function fixture(mutate?: { rights?: (r: Record<string, unknown>) => void; summary?: (s: Record<string, unknown>) => void }): Promise<Fixture> {
  const root = newDir();
  const page = join(root, "swap", "page");
  mkdirSync(join(page, "photos"), { recursive: true });
  const originals = join(root, "photos", "bicycle-photos-fixture");
  mkdirSync(originals, { recursive: true });
  const recs: Record<string, Record<string, unknown>> = {};
  for (const [i, id] of SOURCES.entries()) {
    const b = await png(64, 48, 20 + i * 30);
    writeFileSync(join(originals, `${id}.png`), b);
    recs[id] = record(id, b, 64, 48);
  }
  writeFileSync(join(originals, "manifest.json"), "{}\n");
  const files: Record<string, string> = {};
  const crops: Record<string, unknown> = {};
  const slotsIn = [];
  for (const [i, s] of INV.slots.entries()) {
    const names = {} as Record<(typeof RANGES)[number], string>;
    for (const [j, r] of RANGES.entries()) {
      const name = `photos/${s.slot_id}-${r}.png`;
      const b = await png(24 + j * 4, 18 + j * 3, 10 + i * 40 + j * 9);
      writeFileSync(join(page, name), b);
      files[name] = sha(b);
      names[r] = name;
      const sp = s.slot_id === "ph-bench" && r === "mobile";
      const source = s.slot_id === "ph-bench" ? (sp ? "ph-bench-sp" : "ph-bench-pc") : s.slot_id;
      crops[`${s.slot_id}/${r}`] = { source: sp ? "sp" : "pc", asset_id: `photo-${source}`, rect: { left: 0, top: 0, width: 24, height: 18 } };
    }
    slotsIn.push({ slot: s, alt: s.role, files: names, size: { width: 24, height: 18 } });
  }
  const html = transformHtml(readFileSync(join(REPO, PAGE, "index.html"), "utf8"), slotsIn, SPEC);
  const css = readFileSync(join(REPO, PAGE, "style.css"), "utf8") + BICYCLE_SWAP_CSS;
  writeFileSync(join(page, "index.html"), html);
  writeFileSync(join(page, "style.css"), css);
  writeFileSync(join(page, "copy.json"), "{}\n");
  const rights: Record<string, unknown> = {
    schema: "photo_swap_rights_private_v0",
    warning: "PRIVATE: fixture",
    slots: INV.slots.map((s) => ({
      slot_id: s.slot_id,
      scale_exception: null,
      photos: s.slot_id === "ph-bench" ? [{ which: "pc", focal_box: {}, rights: recs["ph-bench-pc"] }, { which: "sp", focal_box: {}, rights: recs["ph-bench-sp"] }] : [{ which: "pc", focal_box: {}, rights: recs[s.slot_id] }],
    })),
  };
  const summary: Record<string, unknown> = { schema: "photo_swap_summary_v0", shop: "bicycle", page_dir: PAGE, copy_hashes: { html: sha(html), css: sha(css) }, crops, files, renders: [] };
  mutate?.rights?.(rights);
  mutate?.summary?.(summary);
  const rightsPath = join(root, "swap", "rights.private.json");
  const summaryPath = join(root, "swap", "swap-summary.json");
  writeFileSync(rightsPath, JSON.stringify(rights));
  writeFileSync(summaryPath, JSON.stringify(summary));
  return { root, page, rightsPath, summaryPath, originals, rights, summary };
}

