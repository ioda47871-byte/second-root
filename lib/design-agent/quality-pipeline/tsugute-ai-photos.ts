/**
 * DEV-185 (owner approval, Option A, 2026-11-05): the つぐ手 (tsugute, a FICTIONAL kintsugi shop) AI demo photos —
 * the pure data: the one-run prompt (pinned by SHA-256 and length), the 6 slots of docs/design/tsugute-ai-photo-brief.md
 * (shape, 2× target, 1.5× floor on d1-v10, focal box, prompt), and the output manifest's schema. Demo images only: not
 * real products, workshops or craftspeople.
 *
 * Read by the one-shot run (the design-image tsugute-photos module, via scripts/sales-design-worker/tsugute-photos.ts) and by the offline import into the swap
 * (scripts/design-artifact/tsugute-ai-intake.ts). Nothing here calls a model, a process or the network.
 */
import { createHash } from "node:crypto";
import { z } from "zod";

export const TSUGUTE_PHOTOS_APPROVAL_ID = "tsugute-photos-20261106-01";
/** The receipt the gate writes into the one-use marker dir (the TS entry requires exactly this, with HEAD). */
export const TSUGUTE_PHOTOS_DIRECTION = "tsugute-photos";
export const TSUGUTE_PHOTOS_MAX_IMAGES = 6;
/** The owner-approved prompt of the one run (DEV-185): the gate, the TS entry and the import all compare against it. */
export const TSUGUTE_PROMPT_SHA256 = "dab7f2603c7495c4381035391a24ae98cc8bd07064295233fab034964ec33ed0";
export const TSUGUTE_PROMPT_CHARS = 4133;

/** The common paragraph, verbatim from the brief §1 (the test reads the brief and compares). */
export const TSUGUTE_COMMON = `Documentary still-life photograph for a fictional kintsugi (urushi lacquer repair) workshop. Demo image, not a real product.
Light: soft north-window daylight from the upper left, about 5000K, one large diffused source, gentle falloff, no flash,
no hard specular hotspots. Colour: warm washi off-white (#efe8dc) and pale cedar backgrounds, deep urushi brown-black
(#2a1d14), muted cream glaze; low saturation, slightly lifted shadows, fine natural grain, no HDR, no vignette.
Vessel: the SAME hand-thrown stoneware tea bowl in every frame — wide shallow chawan, about 12 cm across, off-white
crackle glaze over a light grey-buff clay body, a thin iron-brown rim, a low unglazed foot ring.
Lens: 85–100 mm macro-equivalent, f/5.6–f/8, eye-level or 30° above, straight verticals, shallow but readable depth of
field. Clean, quiet, plenty of empty space around the subject. No text, letters, logos, labels, signatures, maker's
marks, brand stamps, watermarks, price tags, faces, jewellery, tattoos, painted nails, or identifiable places.`;

export type TsuguteSlot = {
  slot_id: "ph-ware" | "ph-kake" | "ph-hibi" | "ph-dry" | "ph-hand" | "ph-desk";
  aspect: "4:3" | "16:9" | "1:1";
  /** the 2× target of the brief §2 (the larger of d1-v3 and d1-v10) */
  target: { width: number; height: number };
  /** the 1.5× floor on d1-v10 (requestFor at scale 1.5; below it the swap refuses even with an owner exception) */
  floor: { width: number; height: number };
  /** the brief's 主役の箱, as a FocalBox of the swap manifest */
  focal_box: { x: number; y: number; w: number; h: number };
  /** verbatim from the brief §2 */
  prompt: string;
};

export const TSUGUTE_SLOTS: readonly TsuguteSlot[] = [
  {
    slot_id: "ph-ware",
    aspect: "4:3",
    target: { width: 1610, height: 1208 },
    floor: { width: 1210, height: 908 },
    focal_box: { x: 0.3, y: 0.25, w: 0.4, h: 0.5 },
    prompt: "The tea bowl broken cleanly into two halves, the two pieces set side by side and almost touching, the jagged break running roughly vertically through the centre of the frame. Close-up from 30° above on pale cedar. Unrepaired: raw clay visible along the break, no gold, no glue.",
  },
  {
    slot_id: "ph-kake",
    aspect: "4:3",
    target: { width: 1370, height: 1028 },
    floor: { width: 1030, height: 773 },
    focal_box: { x: 0.3, y: 0.25, w: 0.4, h: 0.5 },
    prompt: "The same tea bowl, whole, with one small chip missing from the rim, the chip facing the camera at the centre. Eye level, washi-paper backdrop. Unrepaired: no gold, no filler.",
  },
  {
    slot_id: "ph-hibi",
    aspect: "16:9",
    target: { width: 1600, height: 900 },
    floor: { width: 1200, height: 675 },
    focal_box: { x: 0.25, y: 0.2, w: 0.5, h: 0.6 },
    prompt: "The same tea bowl, whole, with a fine hairline crack running sideways across the glaze from the rim, lit low from the left so the line catches the light. Wide close-up on pale cedar, empty space either side. No gold.",
  },
  {
    slot_id: "ph-dry",
    aspect: "1:1",
    target: { width: 1300, height: 1300 },
    floor: { width: 700, height: 700 },
    focal_box: { x: 0.2, y: 0.15, w: 0.6, h: 0.7 },
    prompt: "The same tea bowl after lacquer repair, resting inside a plain wooden drying cupboard (muro) with a damp cloth on the shelf, the joins coated in dark urushi (not yet gilded). Calm, dim, warm interior; the bowl centred with wide margins. No people, no labels.",
  },
  {
    slot_id: "ph-hand",
    aspect: "1:1",
    target: { width: 1660, height: 1660 },
    floor: { width: 1250, height: 1250 },
    focal_box: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
    prompt: "Two anonymous hands, sleeves of plain indigo work cloth, dusting gold powder with a soft brush onto a lacquered join of the same bowl. Only hands and forearms, no face, no jewellery, no nail polish, short plain nails. Close-up, the brush tip at the centre.",
  },
  {
    slot_id: "ph-desk",
    aspect: "4:3",
    target: { width: 1030, height: 773 },
    floor: { width: 630, height: 473 },
    focal_box: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
    prompt: "A worktable seen from above at 45°: the same broken bowl, a few fine brushes, a small lacquer palette and a blank sheet of washi paper with a faint pencil line sketch of a seam (no writing). Two chairs implied at the table edge, no people.",
  },
];

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

/** The per-picture prompt of the brief §3: the common paragraph and the slot's own, joined by a newline (UTF-8). */
export const slotPrompt = (s: TsuguteSlot) => `${TSUGUTE_COMMON}\n${s.prompt}`;
export const slotPromptSha256 = (s: TsuguteSlot) => sha256(slotPrompt(s));

const orientation = (a: TsuguteSlot["aspect"]) => (a === "1:1" ? "square" : "landscape");

/** The whole prompt of the one run (pinned by SHA-256 and length; the owner approved this text). */
export function buildTsugutePhotosPrompt(): string {
  const images = TSUGUTE_SLOTS.map(
    (s, i) => `Image ${i + 1} of 6 — ${s.slot_id} — ${orientation(s.aspect)} ${s.aspect}, at least ${s.target.width}x${s.target.height} px (or the largest ${orientation(s.aspect)} size the tool offers):\n${s.prompt}`,
  ).join("\n\n");
  return `Make a set of 6 demo photographs for a FICTIONAL shop with the image generation tool. They are demo images only: not real products, workshops or craftspeople.

Rules for this run:
- Call the image generation tool exactly 6 times, once per image below, in the order given (Image 1 first, Image 6 last). Never more than 6 calls in all.
- For each call, the image prompt is the COMMON paragraph followed by that image's own paragraph, exactly as written here.
- Ask for the shape and size given for each image; never a smaller size than the tool's largest in that shape.
- All 6 must look like one set: the same bowl, light, colour and lens as the COMMON paragraph says.
- If any call fails or is refused, stop at once: do not retry it, do not change the prompt, do not make any further call.
- Do not run shell commands, do not read or write files, do not browse. Never add text, letters or logos to an image.
- When you have finished, reply with one line only: DONE followed by the number of images saved.

COMMON:
${TSUGUTE_COMMON}

${images}
`;
}

/** Whether a picture's cover crop to the slot's shape still reaches a size (crop to the aspect first, then compare). */
export function cropReaches(img: { width: number; height: number }, aspect: TsuguteSlot["aspect"], need: { width: number; height: number }): boolean {
  const [a, b] = aspect.split(":").map(Number) as [number, number];
  const r = a / b;
  const w = img.width / img.height > r ? img.height * r : img.width;
  const h = w / r;
  return w + 0.5 >= need.width && h + 0.5 >= need.height;
}


const Sha = z.string().regex(/^[0-9a-f]{64}$/);
/** The run's manifest.json, as the import reads it back (strict: an edited or partial manifest is refused). */
export const TsugutePhotosManifestSchema = z.strictObject({
  schema: z.literal("tsugute_ai_photos_v0"),
  shop: z.literal("tsugute"),
  demo_only: z.literal(true),
  label: z.string(),
  approval_id: z.string(),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  prompt_sha256: Sha,
  prompt_chars: z.number().int().positive(),
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
  slots: z.array(
    z.strictObject({
      slot_id: z.string(),
      file: z.string().regex(/^ph-[a-z]+\.png$/),
      sha256: Sha,
      bytes: z.number().int().positive(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      format: z.literal("png"),
      slot_prompt_sha256: Sha,
      meets_floor_1_5x: z.boolean(),
      meets_target_2x: z.boolean(),
    }),
  ).max(6),
});
export type TsugutePhotosManifest = z.infer<typeof TsugutePhotosManifestSchema>;

export const DEMO_LABEL = "デモ用のイメージ（AI 生成）。実在の商品・工房・職人・修理の実績ではありません。";
export const GENERATOR = "codex-cli image_generation (owner WSL, sr-designgen jail, one run)";

