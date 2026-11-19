/**
 * DEV-139: the ほし窯 (bakery, a FICTIONAL bakery) AI demo photos — the pure data.
 *
 * **Owner-approved on 2026-11-18 for ONE run** (Issue #139 comment 6970468763 follow-up, owner message 2026-11-18): the
 * prompt text docs/design/hoshigama-ai-photo-prompt.txt exactly as committed (its bytes, the 3-line header included —
 * the owner approved the file's content and SHA-256 as they are), the run prompt built from it, 3 photos (ph-mouth-pc,
 * ph-mouth-sp, ph-loaf), 1 job, at most 3 image calls, 1 Codex run, 15 minutes, no retry, ほし窯 d2-v2 only, and
 * enlargement (never above the existing 2×) for ph-mouth-pc and ph-loaf only. The record is HOSHIGAMA_APPROVAL. It is
 * void if EITHER byte sequence changes: every check compares the file's bytes and the built run prompt with the pins.
 * The "_DRAFT_" names of the pins are kept: the owner approved exactly the draft's bytes, and renaming changes nothing.
 *
 * Not a standing permission. ほし窯 was in scripts/sales-design-worker/autorun-shops.ts AUTORUN_SHOPS and root's
 * IMAGE_AUTORUN_SHOPS ('bakery:3') only so that the owner's one run could be started. That run is done (Issue #139
 * comment 6990007019), and Issue #290 P0 removed ほし窯 from both lists again (CLOSED_SHOPS; the run sheet's (g)/(k)):
 * no new generation, not under a new id either. The record and pins below stay only to verify the photos already made.
 *
 * The 3 photos (2 slots; the oven mouth takes a PC and an SP picture) follow the brief §3 recommendation. Nothing here
 * calls a model, a process or the network.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join as joinPath, resolve as resolvePath } from "node:path";
import { z } from "zod";
import { cropReaches } from "./tsugute-ai-photos";

/** the approved prompt text, by repository path (read by the tests and by the run's caller; never written) */
export const HOSHIGAMA_PROMPT_FILE = "docs/design/hoshigama-ai-photo-prompt.txt";
/** the prompt file's bytes (UTF-8): SHA-256, byte count and String.length — owner-approved 2026-11-18, exactly these */
export const HOSHIGAMA_PROMPT_DRAFT_SHA256 = "372f7802101f679a519bca9ee2af57a07cbd6faf9df5371b70888e9a7ce3a8f6";
export const HOSHIGAMA_PROMPT_DRAFT_BYTES = 2007;
export const HOSHIGAMA_PROMPT_DRAFT_CHARS = 1988;
/** the run prompt built from those bytes (buildHoshigamaRunPromptCandidate): its pins — owner-approved 2026-11-18 */
export const HOSHIGAMA_RUN_PROMPT_DRAFT_SHA256 = "a7b7d524470a6e271503ca1820db0f0693cecd28e9c51bf4b19b3543f62be7f1";
export const HOSHIGAMA_RUN_PROMPT_DRAFT_CHARS = 2668;

export const HOSHIGAMA_PHOTOS_MAX_IMAGES = 3;
/**
 * The largest enlargement the ほし窯 intake may give a picture: an explicit per-shop value, left at the existing rule
 * (tsugute-ai-intake.ts MAX_UPSCALE = 2, pinned equal by the tests). Raising it is an owner decision, never a default.
 */
export const HOSHIGAMA_MAX_UPSCALE = 2;

export type HoshigamaPhotoId = "ph-mouth-pc" | "ph-mouth-sp" | "ph-loaf";
export type HoshigamaAspect = "1:1" | "2:3" | "4:3";
export type HoshigamaPhoto = {
  /** the photo's id in the prompt (its paragraph heading) and its file name in the run bundle */
  photo_id: HoshigamaPhotoId;
  /** the swap slot it fills (photo-slots-d2-v2.json) */
  slot_id: "ph-mouth" | "ph-loaf";
  /** which photo of the slot: the PC photo (every range, or ≥601 when an SP photo is given) or the SP photo (≤600) */
  use: "pc" | "sp";
  aspect: HoshigamaAspect;
  /** the 2× target of the brief §3 (the slot's boxes at its range edges, photo-slot-edges-d2-v2.json; rounded up, as the brief states it) */
  target: { width: number; height: number };
  /** the 1.5× floor (only with an owner scale exception in the swap); recorded for the owner's size decision */
  floor: { width: number; height: number };
  /** the draft prompt's "inside" box, as a FocalBox of the swap manifest */
  focal_box: { x: number; y: number; w: number; h: number };
  /** SHA-256 of this photo's prompt (the COMMON paragraph and its own paragraph, joined by a newline), DRAFT */
  prompt_sha256: string;
};

export const HOSHIGAMA_PHOTOS: readonly HoshigamaPhoto[] = [
  { photo_id: "ph-mouth-pc", slot_id: "ph-mouth", use: "pc", aspect: "1:1", target: { width: 1370, height: 1370 }, floor: { width: 1020, height: 1020 }, focal_box: { x: 0.25, y: 0.48, w: 0.5, h: 0.4 }, prompt_sha256: "4df1be15702f92b2e2686b214bd752a4204aec584116a00860b82907e28faf66" },
  { photo_id: "ph-mouth-sp", slot_id: "ph-mouth", use: "sp", aspect: "2:3", target: { width: 650, height: 975 }, floor: { width: 490, height: 735 }, focal_box: { x: 0.2, y: 0.42, w: 0.6, h: 0.46 }, prompt_sha256: "b4956f7fa31bedc948cb0267c13c5fb5dce50d2cfa06ea1b4fd48ab82b5103ad" },
  { photo_id: "ph-loaf", slot_id: "ph-loaf", use: "pc", aspect: "4:3", target: { width: 1750, height: 1313 }, floor: { width: 1310, height: 983 }, focal_box: { x: 0.18, y: 0.2, w: 0.5, h: 0.6 }, prompt_sha256: "b1261248a0fff67e566ddf4feeac7c087bddfa8057b309032e39cffbc13d0f87" },
];

/**
 * The owner's approval of the prompt text AND of one run. The writer, the intake and buildHoshigamaRunPrompt take
 * HOSHIGAMA_APPROVAL as their default; tests may hand another record (null, or one naming other bytes) to show the
 * refusals. No test record ever reaches the worker.
 */
export type HoshigamaApproval = {
  approval_record: string;
  decided_by: "owner";
  decided_on: string;
  evidence: string;
  shop: "bakery";
  page: "d2-v2";
  jobs: 1;
  max_image_calls: number;
  codex_runs: 1;
  timeout_minutes: number;
  retry: false;
  /** the approved core text (the prompt file) and the approved run prompt: both pinned, void if either changes */
  core_prompt_sha256: string;
  core_prompt_bytes: number;
  run_prompt_sha256: string;
  run_prompt_chars: number;
  /** the photos the owner allows the intake to enlarge (≤ HOSHIGAMA_MAX_UPSCALE, lanczos3); every other must reach its target */
  upscale_allowed: readonly HoshigamaPhotoId[];
};
/**
 * DEV-139: the owner's GO for ONE real run (2026-11-18) — its scope and both pinned byte sequences. Void if either
 * changes (every check compares the bytes with these pins). No run approval id or expiry is written in code.
 * USED (Issue #139 comment 6990007019; Issue #290 P0): the worker and root no longer list ほし窯
 * (scripts/sales-design-worker/autorun-shops.ts CLOSED_SHOPS). This record stays ONLY so the offline intake, the swap
 * and the v2 package can verify the photos that run already made; it is not a permission to generate again.
 */
export const HOSHIGAMA_APPROVAL: HoshigamaApproval | null = {
  approval_record: "hoshigama-one-time-run-20261118",
  decided_by: "owner",
  decided_on: "2026-11-18",
  evidence: "Issue #139 comment 6970468763 follow-up, owner message 2026-11-18",
  shop: "bakery",
  page: "d2-v2",
  jobs: 1,
  max_image_calls: 3,
  codex_runs: 1,
  timeout_minutes: 15,
  retry: false,
  core_prompt_sha256: HOSHIGAMA_PROMPT_DRAFT_SHA256,
  core_prompt_bytes: HOSHIGAMA_PROMPT_DRAFT_BYTES,
  run_prompt_sha256: HOSHIGAMA_RUN_PROMPT_DRAFT_SHA256,
  run_prompt_chars: HOSHIGAMA_RUN_PROMPT_DRAFT_CHARS,
  upscale_allowed: ["ph-mouth-pc", "ph-loaf"],
};

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

/** The draft split into its COMMON paragraph and its 3 photo paragraphs, in file order. */
export type ParsedHoshigamaPrompt = { common: string; fromCommon: string; photos: Array<{ photo_id: string; aspect: string; paragraph: string }> };

/**
 * Reads the prompt text into its parts. Throws (fail closed) unless it has exactly one "COMMON: " paragraph and the 3
 * photo paragraphs in HOSHIGAMA_PHOTOS' order, each starting with that photo's id and shape and naming its pinned box.
 */
export function parseHoshigamaPrompt(text: string): ParsedHoshigamaPrompt {
  const at = text.indexOf("\nCOMMON: ");
  if (at < 0 || text.indexOf("\nCOMMON: ", at + 1) >= 0) throw new Error("PROMPT_NO_COMMON");
  const fromCommon = text.slice(at + 1);
  const blocks = fromCommon.replace(/\n+$/, "").split(/\n\n/);
  const common = blocks[0]!;
  const photos = blocks.slice(1).map((b) => {
    const m = /^(ph-[a-z-]+) \(([0-9]+:[0-9]+)\): /.exec(b);
    if (!m) throw new Error("PROMPT_PARAGRAPH_INVALID");
    return { photo_id: m[1]!, aspect: m[2]!, paragraph: b };
  });
  if (photos.map((p) => p.photo_id).join(",") !== HOSHIGAMA_PHOTOS.map((p) => p.photo_id).join(",")) throw new Error("PROMPT_PHOTO_ORDER");
  for (const [i, p] of photos.entries()) {
    const pin = HOSHIGAMA_PHOTOS[i]!;
    if (p.aspect !== pin.aspect || !p.paragraph.includes(`inside ${boxText(pin.focal_box)})`)) throw new Error(`PROMPT_PARAGRAPH_MISMATCH: ${p.photo_id}`);
  }
  return { common, fromCommon, photos };
}

const num = (n: number) => String(Number(n.toFixed(2)));
/** a focal box as the draft writes it: "x 0.25-0.75, y 0.45-0.85" */
export function boxText(b: HoshigamaPhoto["focal_box"]): string {
  return `x ${num(b.x)}-${num(b.x + b.w)}, y ${num(b.y)}-${num(b.y + b.h)}`;
}

/** One photo's prompt: the COMMON paragraph and the photo's paragraph, joined by a newline (UTF-8). */
export function hoshigamaPhotoPrompt(parsed: ParsedHoshigamaPrompt, photoId: HoshigamaPhotoId): string {
  const p = parsed.photos.find((x) => x.photo_id === photoId);
  if (!p) throw new Error(`PROMPT_PHOTO_MISSING: ${photoId}`);
  return `${parsed.common}\n${p.paragraph}`;
}

export type HoshigamaPromptCheck = { ok: true; parsed: ParsedHoshigamaPrompt } | { ok: false; codes: string[] };

/**
 * Whether a text is the pinned text (SHA-256, byte count, each photo's prompt). This says only that the bytes are the
 * pinned ones; the approval record is checked by checkApprovedHoshigamaPrompt.
 */
export function checkDraftHoshigamaPrompt(text: string): HoshigamaPromptCheck {
  const codes: string[] = [];
  if (sha256(text) !== HOSHIGAMA_PROMPT_DRAFT_SHA256) codes.push("PROMPT_SHA_NOT_THE_DRAFT");
  if (Buffer.byteLength(text, "utf8") !== HOSHIGAMA_PROMPT_DRAFT_BYTES || text.length !== HOSHIGAMA_PROMPT_DRAFT_CHARS) codes.push("PROMPT_LENGTH_NOT_THE_DRAFT");
  if (codes.length) return { ok: false, codes };
  let parsed: ParsedHoshigamaPrompt;
  try {
    parsed = parseHoshigamaPrompt(text);
  } catch (e) {
    return { ok: false, codes: [String((e as Error).message).split(":")[0]!] };
  }
  for (const p of HOSHIGAMA_PHOTOS) if (sha256(hoshigamaPhotoPrompt(parsed, p.photo_id)) !== p.prompt_sha256) codes.push(`PHOTO_PROMPT_NOT_PINNED:${p.photo_id}`);
  return codes.length ? { ok: false, codes } : { ok: true, parsed };
}

/**
 * The text is the pinned text AND an approval record names exactly its bytes (default: HOSHIGAMA_APPROVAL; null, or a
 * record naming other bytes, refuses with PROMPT_NOT_APPROVED).
 */
export function checkApprovedHoshigamaPrompt(text: string, approval: HoshigamaApproval | null = HOSHIGAMA_APPROVAL): HoshigamaPromptCheck {
  if (!approval) return { ok: false, codes: ["PROMPT_NOT_APPROVED"] };
  const draft = checkDraftHoshigamaPrompt(text);
  if (!draft.ok) return draft;
  if (approval.core_prompt_sha256 !== sha256(text) || approval.core_prompt_bytes !== Buffer.byteLength(text, "utf8")) return { ok: false, codes: ["PROMPT_NOT_APPROVED"] };
  return draft;
}

/**
 * The run prompt of the pinned text: fixed run rules (as 輪's run had), then the text from its "COMMON: " line to the
 * end, byte for byte (the file's 3-line header is left out). Its SHA-256 and length are HOSHIGAMA_RUN_PROMPT_DRAFT_*,
 * owner-approved 2026-11-18; read only through buildHoshigamaRunPrompt, which checks the approval record (Issue #290 P0:
 * the worker no longer reads it).
 */
export function buildHoshigamaRunPromptCandidate(draftText: string): string {
  const check = checkDraftHoshigamaPrompt(draftText);
  if (!check.ok) throw new Error(`PROMPT_NOT_THE_DRAFT: ${check.codes.join(",")}`);
  return `Make a set of 3 demo photographs for a FICTIONAL bakery with the image generation tool. They are demo images only: not a real shop, oven, product or person.

Rules for this run:
- Call the image generation tool exactly 3 times, once per image below, in the order given (ph-mouth-pc first, ph-loaf last). Never more than 3 calls in all.
- For each call, the image prompt is the COMMON paragraph followed by that image's own paragraph, exactly as written here.
- Ask for the shape given for each image (1:1 square, 2:3 portrait, 4:3 landscape) at the tool's largest size in that shape.
- ph-mouth-pc and ph-mouth-sp show the SAME oven and the SAME fire, framed for a wide and a tall screen.
- If any call fails or is refused, stop at once: do not retry it, do not change the prompt, do not make any further call.
- Do not run shell commands, do not read or write files, do not browse. Never add text, letters, numbers or logos to an image.
- When you have finished, reply with one line only: DONE followed by the number of images saved.

${check.parsed.fromCommon}`;
}

const REPO_ROOT = resolvePath(__dirname, "../../..");
/**
 * The approved run prompt from this checkout (the worker used it for the one run; Issue #290 P0: no worker path reads it
 * any more, it stays for verifying the photos already made) — "" unless an approval record names exactly the file's
 * bytes and the built prompt (default HOSHIGAMA_APPROVAL). Never throws. `o` is for tests only.
 */
export function buildHoshigamaRunPrompt(o: { text?: string; approval?: HoshigamaApproval | null } = {}): string {
  try {
    const approval = o.approval === undefined ? HOSHIGAMA_APPROVAL : o.approval;
    const text = o.text ?? readFileSync(joinPath(REPO_ROOT, HOSHIGAMA_PROMPT_FILE), "utf8");
    if (!approval || !checkApprovedHoshigamaPrompt(text, approval).ok) return "";
    const run = buildHoshigamaRunPromptCandidate(text);
    return sha256(run) === approval.run_prompt_sha256 && run.length === approval.run_prompt_chars ? run : "";
  } catch {
    return "";
  }
}

/** The approved prompt TEXT from this checkout, or "" when it is not approved (or its bytes changed). Never throws. */
export function readApprovedHoshigamaPrompt(approval: HoshigamaApproval | null = HOSHIGAMA_APPROVAL): string {
  try {
    const text = readFileSync(joinPath(REPO_ROOT, HOSHIGAMA_PROMPT_FILE), "utf8");
    return checkApprovedHoshigamaPrompt(text, approval).ok ? text : "";
  } catch {
    return "";
  }
}

/** Whether a picture reaches its photo's 2× target (or a cover crop to its shape does), as 輪's reachesTarget. */
export function reachesHoshigamaTarget(img: { width: number; height: number }, p: Pick<HoshigamaPhoto, "aspect" | "target">): boolean {
  return (img.width >= p.target.width && img.height >= p.target.height) || cropReaches(img, p.aspect, p.target);
}

/** the orientation a photo's shape asks for (the intake refuses a picture of another orientation) */
export function hoshigamaOrientationOf(a: HoshigamaAspect): "landscape" | "portrait" | "square" {
  return a === "1:1" ? "square" : a === "2:3" ? "portrait" : "landscape";
}

export const HOSHIGAMA_DEMO_LABEL = "デモ用のイメージ（AI 生成）。実在の店・商品・人・窯ではありません。";
/** the means of a real run (the same jail and CLI as 輪's); an offline stub writes its own label instead */
export const HOSHIGAMA_GENERATOR = "codex-cli image_generation (owner WSL, sr-designgen jail, one run)";
/** the label of the OFFLINE stub batches the tests write; the intake takes it only when a test passes it explicitly */
export const HOSHIGAMA_OFFLINE_STUB_GENERATOR = "offline-stub (test only; no model, no image tool, no network)";

const Sha = z.string().regex(/^[0-9a-f]{64}$/);
/** The run bundle's manifest.json, as the intake reads it back (strict). */
export const HoshigamaPhotosManifestSchema = z.strictObject({
  schema: z.literal("hoshigama_ai_photos_v0"),
  shop: z.literal("bakery"),
  page: z.literal("d2-v2"),
  demo_only: z.literal(true),
  public_web: z.literal(false),
  label: z.string(),
  approval_id: z.string().regex(/^[a-z0-9][a-z0-9._-]{3,95}$/),
  prompt_approval_record: z.string(),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
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
    .max(HOSHIGAMA_PHOTOS_MAX_IMAGES),
});
export type HoshigamaPhotosManifest = z.infer<typeof HoshigamaPhotosManifestSchema>;
