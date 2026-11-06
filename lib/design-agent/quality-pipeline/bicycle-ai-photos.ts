/**
 * DEV-191 (Issue #193, owner approval 2026-11-06, comment 6687410438): the 輪 (bicycle, a FICTIONAL bicycle repair shop)
 * AI demo photos — the pure data, prepared but NOT runnable.
 *
 * What the owner approved on 2026-11-06: the FULL TEXT of docs/design/bicycle-ai-photo-prompt.txt as it stood at DEV-190
 * (UTF-8 SHA-256 83c9b2c6…5594, 3865 bytes). The file's bytes are not edited: its first lines still say "DRAFT (未承認)",
 * which the owner's decision made historical. The approval is recorded HERE (BICYCLE_PROMPT_APPROVAL) and in
 * docs/design/bicycle-ai-photo-brief.md §5, never by rewriting the approved bytes.
 *
 * What the owner did NOT approve: a real generation run (Codex, the image tool, the ChatGPT quota), the auto-run, 輪 in
 * the worker's AUTORUN_SHOPS or root's IMAGE_AUTORUN_SHOPS, or the swap taking 輪's ai_generated_demo pictures
 * unconditionally. The real gates against a run are the worker's job schema (AUTORUN_SHOP_IDS has no 輪), root's
 * IMAGE_AUTORUN_SHOPS in cycle.sh, and the swap's aiDemoAllowed (false for 輪). Beside them, no generation approval id
 * is recorded here (BICYCLE_RUN_APPROVAL_ID is null, a record, not a gate), the intake accepts
 * none by default, the swap spec keeps aiDemoAllowed: false, and the run prompt below is a CANDIDATE whose SHA the owner
 * must approve with the one-time run.
 *
 * Pinned like つぐ手's prompt (tsugute-ai-photos.ts): SHA-256 and length in code, the 6 fixed photos in call order with
 * their shape, 2× target, 1.5× floor, subject box and per-photo prompt SHA-256 — read back from the approved file and
 * compared, so a changed file fails closed. Nothing here calls a model, a process or the network.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { cropReaches } from "./tsugute-ai-photos";

/** the approved prompt text, by repository path (read by the run's caller and the tests; never written) */
export const BICYCLE_PROMPT_FILE = "docs/design/bicycle-ai-photo-prompt.txt";
/** the owner-approved bytes (UTF-8): SHA-256, byte count, and its length in UTF-16 code units (String.length) */
export const BICYCLE_PROMPT_SHA256 = "83c9b2c628873d645a78145065a5ff5befeab7f406555b79649f1f44d8275594";
export const BICYCLE_PROMPT_BYTES = 3865;
export const BICYCLE_PROMPT_CHARS = 3851;

/** The owner's approval of the prompt TEXT (not of a run). Recorded here because the approved bytes stay unedited. */
export const BICYCLE_PROMPT_APPROVAL = {
  approval_id: "bicycle-photo-prompt-20261106",
  scope: "prompt_text_only_not_a_generation_run",
  decided_by: "owner",
  decided_on: "2026-11-06",
  evidence: "Issue #193 comment 6687410438",
  file: BICYCLE_PROMPT_FILE,
  sha256: BICYCLE_PROMPT_SHA256,
  bytes: BICYCLE_PROMPT_BYTES,
  /** the file's leading "DRAFT (未承認)" lines predate the approval; they are history, not the current state */
  leading_draft_note_is_historical: true,
} as const;

/**
 * The approval id of a real generation run of these 6 pictures. null: none exists. This is a RECORD and the intake's
 * default, not a gate by itself: what stops a run is the worker's job schema (輪 is not in AUTORUN_SHOP_IDS), root's
 * IMAGE_AUTORUN_SHOPS (cycle.sh, 'tsugute:6') and the swap's aiDemoAllowed (false for 輪). A future owner GO sets it
 * together with those (code reviewed, root's config on WSL).
 */
export const BICYCLE_RUN_APPROVAL_ID: string | null = null;

export const BICYCLE_PHOTOS_MAX_IMAGES = 6;

export type BicyclePhotoId = "ph-d" | "ph-a" | "ph-c" | "ph-b" | "ph-bench-pc" | "ph-bench-sp";
export type BicycleAspect = "4:3" | "3:2" | "2:3";
export type BicyclePhoto = {
  /** the photo's id in the prompt (its paragraph heading) and its file name in the run bundle */
  photo_id: BicyclePhotoId;
  /** the swap slot it fills (photo-slots-d1-v9.json) */
  slot_id: "ph-d" | "ph-a" | "ph-c" | "ph-b" | "ph-bench";
  /** which photo of the slot: the PC photo (every range) or the bench's separate SP photo (≤600 only) */
  use: "pc" | "sp";
  aspect: BicycleAspect;
  /** the 2× target of the brief §3 (requestFor with d1-v9's range edges) */
  target: { width: number; height: number };
  /** the 1.5× floor of the brief §3 (only with an owner exception record in the swap) */
  floor: { width: number; height: number };
  /** the prompt's "subject inside" box, as a FocalBox of the swap manifest */
  focal_box: { x: number; y: number; w: number; h: number };
  /** the owner allowed ONE picture to be enlarged (≤2×, lanczos3): the PC bench (brief §3). Every other photo must reach its target. */
  upscale_allowed: boolean;
  /** SHA-256 of this photo's prompt: the COMMON paragraph, its heading line and its paragraph, joined by newlines */
  prompt_sha256: string;
};

export const BICYCLE_PHOTOS: readonly BicyclePhoto[] = [
  { photo_id: "ph-d", slot_id: "ph-d", use: "pc", aspect: "4:3", target: { width: 980, height: 735 }, floor: { width: 740, height: 555 }, focal_box: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, upscale_allowed: false, prompt_sha256: "327e66c7832dbeaa573d99366e28598fa5bb59a470abd6f77a9e5aefb60a4fda" },
  { photo_id: "ph-a", slot_id: "ph-a", use: "pc", aspect: "3:2", target: { width: 1040, height: 694 }, floor: { width: 780, height: 520 }, focal_box: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, upscale_allowed: false, prompt_sha256: "a8b8a156f7611f4e76c878311bef4d348712ef0d1e71461c7edbd072bd1034bc" },
  { photo_id: "ph-c", slot_id: "ph-c", use: "pc", aspect: "3:2", target: { width: 1040, height: 694 }, floor: { width: 780, height: 520 }, focal_box: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, upscale_allowed: false, prompt_sha256: "d1eb5334bea1aca41b64da4fd39e6f82f5931ea9fc945d8f5c6880e16a23afe2" },
  { photo_id: "ph-b", slot_id: "ph-b", use: "pc", aspect: "4:3", target: { width: 980, height: 735 }, floor: { width: 740, height: 555 }, focal_box: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, upscale_allowed: false, prompt_sha256: "b46c340f282f532e66e4a253ebfdca10a5b3219375e3d6ff3a847714c0659520" },
  { photo_id: "ph-bench-pc", slot_id: "ph-bench", use: "pc", aspect: "4:3", target: { width: 2030, height: 1523 }, floor: { width: 1530, height: 1148 }, focal_box: { x: 0.2, y: 0.2, w: 0.6, h: 0.6 }, upscale_allowed: true, prompt_sha256: "e26d328546109b7cee5d4a4dea9efa76c793b3aa773822413d2f3bece3064e39" },
  { photo_id: "ph-bench-sp", slot_id: "ph-bench", use: "sp", aspect: "2:3", target: { width: 590, height: 885 }, floor: { width: 440, height: 660 }, focal_box: { x: 0.2, y: 0.15, w: 0.6, h: 0.7 }, upscale_allowed: false, prompt_sha256: "f464fc333e11347514d54aa0b72547aa472a986d60bc34a8ec92c176cbecddc1" },
];

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

/** The approved file split into its COMMON paragraph and its 6 photo paragraphs (heading line + body), in file order. */
export type ParsedBicyclePrompt = { common: string; fromCommon: string; photos: Array<{ photo_id: string; heading: string; body: string }> };

/**
 * Reads the prompt text into its parts. Throws (fail closed) unless it has exactly one "COMMON:" block and the 6
 * photo paragraphs in BICYCLE_PHOTOS' order, each heading naming that photo's shape, target and subject box.
 */
export function parseBicyclePrompt(text: string): ParsedBicyclePrompt {
  const at = text.indexOf("\nCOMMON:\n");
  if (at < 0 || text.indexOf("\nCOMMON:\n", at + 1) >= 0) throw new Error("PROMPT_NO_COMMON");
  const fromCommon = text.slice(at + 1);
  const blocks = fromCommon.replace(/\n+$/, "").split(/\n\n/);
  const common = blocks[0]!.replace(/^COMMON:\n/, "");
  const photos = blocks.slice(1).map((b) => {
    const [heading, ...rest] = b.split("\n");
    const m = /^(ph-[a-z-]+) \(/.exec(heading ?? "");
    if (!m) throw new Error("PROMPT_PARAGRAPH_INVALID");
    return { photo_id: m[1]!, heading: heading!, body: rest.join("\n") };
  });
  if (photos.map((p) => p.photo_id).join(",") !== BICYCLE_PHOTOS.map((p) => p.photo_id).join(",")) throw new Error("PROMPT_PHOTO_ORDER");
  for (const [i, p] of photos.entries()) if (p.heading !== photoHeading(BICYCLE_PHOTOS[i]!)) throw new Error(`PROMPT_HEADING_MISMATCH: ${p.photo_id}`);
  return { common, fromCommon, photos };
}

const fx = (n: number) => n.toFixed(2);
/** The heading the approved file gives a photo (shape, target, subject box), rebuilt from the pinned values. */
export function photoHeading(p: BicyclePhoto): string {
  const shape = p.aspect === "2:3" ? "2:3 portrait" : p.aspect;
  const box = `x ${fx(p.focal_box.x)}-${fx(p.focal_box.x + p.focal_box.w)}, y ${fx(p.focal_box.y)}-${fx(p.focal_box.y + p.focal_box.h)}`;
  return `${p.photo_id} (${shape}, at least ${p.target.width}x${p.target.height} px; subject inside ${box}):`;
}

/** One photo's prompt: the COMMON paragraph, the photo's heading line and its paragraph, joined by newlines (UTF-8). */
export function photoPrompt(parsed: ParsedBicyclePrompt, photoId: BicyclePhotoId): string {
  const p = parsed.photos.find((x) => x.photo_id === photoId);
  if (!p) throw new Error(`PROMPT_PHOTO_MISSING: ${photoId}`);
  return `${parsed.common}\n${p.heading}\n${p.body}`;
}

export type PromptCheck = { ok: true; parsed: ParsedBicyclePrompt } | { ok: false; codes: string[] };

/**
 * Whether a text is the owner-approved prompt: the SHA-256 and byte count, then each photo's prompt against its pin.
 * The one entry point every 輪 path (bundle writer, run prompt) uses before it trusts the text.
 */
export function checkApprovedBicyclePrompt(text: string): PromptCheck {
  const codes: string[] = [];
  if (sha256(text) !== BICYCLE_PROMPT_SHA256) codes.push("PROMPT_SHA_NOT_APPROVED");
  if (Buffer.byteLength(text, "utf8") !== BICYCLE_PROMPT_BYTES || text.length !== BICYCLE_PROMPT_CHARS) codes.push("PROMPT_LENGTH_NOT_APPROVED");
  if (codes.length) return { ok: false, codes };
  let parsed: ParsedBicyclePrompt;
  try {
    parsed = parseBicyclePrompt(text);
  } catch (e) {
    return { ok: false, codes: [String((e as Error).message).split(":")[0]!] };
  }
  for (const p of BICYCLE_PHOTOS) if (sha256(photoPrompt(parsed, p.photo_id)) !== p.prompt_sha256) codes.push(`PHOTO_PROMPT_NOT_PINNED:${p.photo_id}`);
  return codes.length ? { ok: false, codes } : { ok: true, parsed };
}

/**
 * The CANDIDATE prompt of a future one-time run: fixed run rules (as つぐ手's run had), then the approved text from its
 * "COMMON:" line to the end, byte for byte. The approved file's 3 leading lines (the historical DRAFT note, which tells a
 * reader not to call any tool) are left out; everything after them is the approved bytes unchanged, which the tests
 * prove by suffix. NOT APPROVED: the owner approves this candidate's SHA-256 (BICYCLE_RUN_PROMPT_CANDIDATE_SHA256) with
 * the one-time run, or it is changed first.
 */
export function buildBicycleRunPromptCandidate(approvedText: string): string {
  const check = checkApprovedBicyclePrompt(approvedText);
  if (!check.ok) throw new Error(`PROMPT_NOT_APPROVED: ${check.codes.join(",")}`);
  return `Make a set of 6 demo photographs for a FICTIONAL bicycle repair shop with the image generation tool. They are demo images only: not a real shop, product, mechanic or repair.

Rules for this run:
- Call the image generation tool exactly 6 times, once per image below, in the order given (ph-d first, ph-bench-sp last). Never more than 6 calls in all.
- For each call, the image prompt is the COMMON paragraph followed by that image's own heading line and paragraph, exactly as written here.
- Ask for the shape and size given for each image; never a smaller size than the tool's largest in that shape.
- ph-bench-pc and ph-bench-sp show the SAME bench and bicycle, framed for a wide and a tall screen.
- If any call fails or is refused, stop at once: do not retry it, do not change the prompt, do not make any further call.
- Do not run shell commands, do not read or write files, do not browse. Never add text, letters, numbers or logos to an image.
- When you have finished, reply with one line only: DONE followed by the number of images saved.

${check.parsed.fromCommon}`;
}
/** the candidate run prompt's pins (NOT approved; listed for the owner's one-time GO) */
export const BICYCLE_RUN_PROMPT_CANDIDATE_SHA256 = "4b8081e02c08e1d0842c27bf28afab2bc647a9c80acce8464c23acf20e6d7447";
export const BICYCLE_RUN_PROMPT_CANDIDATE_CHARS = 4566;

/**
 * Whether a picture reaches its photo's 2× target: at least the prompt's "at least W x H" pixels, or a cover crop to the
 * photo's shape that still reaches it (the prompt's targets are rounded, e.g. 1040x694 is not exactly 3:2, so a picture
 * of exactly the asked size must pass). The swap's own density check runs on it afterwards either way.
 */
export function reachesTarget(img: { width: number; height: number }, p: Pick<BicyclePhoto, "aspect" | "target">): boolean {
  return (img.width >= p.target.width && img.height >= p.target.height) || cropReaches(img, p.aspect, p.target);
}

/** the orientation a photo's shape asks for (a picture of the other orientation is refused by the intake) */
export function orientationOf(a: BicycleAspect): "landscape" | "portrait" {
  return a === "2:3" ? "portrait" : "landscape";
}

export const BICYCLE_DEMO_LABEL = "デモ用のイメージ（AI 生成）。実在の店・商品・整備士・修理の実績ではありません。";
/** the means of a real run (the same jail and CLI as つぐ手's); an offline stub writes its own label instead */
export const BICYCLE_GENERATOR = "codex-cli image_generation (owner WSL, sr-designgen jail, one run)";
/**
 * The label of the OFFLINE stub batches the tests write (no model, no tool). The swap's test-only candidate seam
 * (photo-swap.ts offlineAiDemoCandidate) takes 輪's ai_generated_demo pictures ONLY with this generator, so a real
 * picture cannot pass through the seam.
 */
export const BICYCLE_OFFLINE_STUB_GENERATOR = "offline-stub (test only; no model, no image tool, no network)";

const Sha = z.string().regex(/^[0-9a-f]{64}$/);
/** The run bundle's manifest.json, as the intake reads it back (strict: an edited or partial manifest is refused). */
export const BicyclePhotosManifestSchema = z.strictObject({
  schema: z.literal("bicycle_ai_photos_v0"),
  shop: z.literal("bicycle"),
  page: z.literal("d1-v9"),
  demo_only: z.literal(true),
  public_web: z.literal(false),
  label: z.string(),
  approval_id: z.string().regex(/^[a-z0-9][a-z0-9._-]{3,95}$/),
  prompt_approval_id: z.string(),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  /** the approved prompt text's pins (the run prompt wraps it; its own SHA is recorded beside it) */
  prompt_sha256: Sha,
  prompt_bytes: z.number().int().positive(),
  run_prompt_sha256: Sha,
  generator: z.string().min(1),
  model: z.string().nullable(),
  cli_version: z.string().nullable(),
  generated_at: z.string(),
  status: z.enum(["complete", "stopped"]),
  stop_code: z.string().nullable(),
  image_tool_calls: z.number().int().nonnegative(),
  image_tool_failed: z.number().int().nonnegative(),
  codex_ms: z.number().nonnegative(),
  slot_mapping: z.literal("call_order"),
  photos: z
    .array(
      z.strictObject({
        photo_id: z.string(),
        slot_id: z.string(),
        use: z.enum(["pc", "sp"]),
        file: z.string().regex(/^ph-[a-z-]+\.png$/),
        sha256: Sha,
        bytes: z.number().int().positive(),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        format: z.literal("png"),
        photo_prompt_sha256: Sha,
        meets_target_2x: z.boolean(),
      }),
    )
    .max(6),
});
export type BicyclePhotosManifest = z.infer<typeof BicyclePhotosManifestSchema>;
