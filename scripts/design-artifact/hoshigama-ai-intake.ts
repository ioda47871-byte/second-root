/**
 * DEV-139 — OFFLINE. The import of ほし窯's (bakery, a FICTIONAL bakery) AI demo photos into the photo swap
 * (photo-swap.ts), the same steps as 輪's (bicycle-ai-intake.ts). Called without an approval record it uses
 * HOSHIGAMA_APPROVAL (the owner's one-run approval of 2026-11-18; a null record refuses every bundle with
 * RUN_PROMPT_NOT_APPROVED), and without approvalIds it accepts no run id. The worker's image auto-run calls it with the
 * job's one run approval id (autorun-shops.ts AUTORUN_SHOPS.bakery); the offline tests pass a stub approval id and the
 * stub generator.
 *
 * Refuses (nothing written) unless the bundle's manifest.json (hoshigama_ai_photos_v0, design-image/hoshigama-photos.ts)
 *  - is complete: 3 pictures, 3 calls, none failed, the model reported;
 *  - names an accepted approval id and generator, the demo label, and the approved prompt (SHA-256, bytes and approval
 *    record) inside the approved run prompt;
 *  - lists the 3 photos in call order (ph-mouth-pc, ph-mouth-sp, ph-loaf), each with its pinned slot, use and prompt
 *    SHA-256 — the oven mouth's SP picture is required (SP_MOUTH_MISSING);
 *  - and each picture's bytes match its SHA-256, size and orientation, and reach its photo's 2× target: only the photos
 *    the approval lists in upscale_allowed may be enlarged, by the smallest factor that reaches it and never above
 *    HOSHIGAMA_MAX_UPSCALE (= the existing 2×; sharp lanczos3; UPSCALE_EXCEEDS_MAX beyond), recording the original's size
 *    and SHA-256, the factor and the method.
 * Then copies the pictures (0600, never overwriting) into <pipeline>/.intake/photos/ as hoshigama-ai-<photo>.png and
 * writes a photo_swap_manifest_v0 for ほし窯 d2-v2 (2 slots; the oven mouth with its PC and SP photo) whose rights
 * records are `ai_generated_demo`, demo only, public_web false, with the provenance (generator, model, date, prompt
 * SHA-256, approval id), plus <manifest-out>.provenance.json.
 *
 * The swap takes these pictures because ほし窯's swap spec allows AI demo pictures of the approved prompt only
 * (photo-swap-shops.ts aiDemoAllowed / aiDemoPromptSha256, the owner's approval of 2026-11-18). Never calls a model, a
 * generator or the network. Nothing is committed.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { measurePhotoBytes, PHOTO_INTAKE_DIR } from "../../lib/design-agent/quality-pipeline/photo-rights";
import {
  HOSHIGAMA_APPROVAL,
  HOSHIGAMA_DEMO_LABEL,
  HOSHIGAMA_GENERATOR,
  HOSHIGAMA_MAX_UPSCALE,
  HOSHIGAMA_PHOTOS,
  HOSHIGAMA_PHOTOS_MAX_IMAGES,
  HoshigamaPhotosManifestSchema,
  hoshigamaOrientationOf,
  reachesHoshigamaTarget,
  type HoshigamaApproval,
  type HoshigamaPhoto,
} from "../../lib/design-agent/quality-pipeline/hoshigama-ai-photos";
import { manifestOutOk, PIPELINE_ROOT, upscaleFactor } from "./tsugute-ai-intake";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

type Upscale = { original_width: number; original_height: number; original_sha256: string; factor: number; method: "sharp-lanczos3" };
export type HoshigamaProvenance = {
  photo_id: string;
  slot_id: string;
  use: "pc" | "sp";
  asset_id: string;
  source_kind: "ai_generated_demo";
  demo_only: true;
  public_web: false;
  generator: string;
  model: string;
  generated_at: string;
  approval_id: string;
  prompt_sha256: string;
  prompt_approval_record: string;
  run_prompt_sha256: string;
  photo_prompt_sha256: string;
  sha256: string;
  width: number;
  height: number;
  upscale: Upscale | null;
};
export type HoshigamaIntakeResult = { ok: true; manifest: Record<string, unknown>; provenance: HoshigamaProvenance[]; files: string[] } | { ok: false; codes: string[] };

export async function importHoshigamaAiPhotos(o: {
  from: string;
  manifestOut: string;
  pipelineRoot?: string;
  /** the run approval ids accepted. Default: none */
  approvalIds?: readonly string[];
  /** the generators accepted. Default: the real run's label only */
  generators?: readonly string[];
  /** the owner's approval record; default HOSHIGAMA_APPROVAL. Tests may pass another (null: every bundle is refused). */
  approval?: HoshigamaApproval | null;
}): Promise<HoshigamaIntakeResult> {
  const pipelineRoot = o.pipelineRoot ?? PIPELINE_ROOT;
  const approval = o.approval === undefined ? HOSHIGAMA_APPROVAL : o.approval;
  if (!approval) return { ok: false, codes: ["RUN_PROMPT_NOT_APPROVED"] };
  const approvalIds = o.approvalIds ?? [];
  const codes: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(o.from, "manifest.json"), "utf8"));
  } catch {
    return { ok: false, codes: ["RUN_MANIFEST_UNREADABLE"] };
  }
  const parsed = HoshigamaPhotosManifestSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, codes: ["RUN_MANIFEST_INVALID"] };
  const m = parsed.data;
  if (m.status !== "complete" || m.stop_code !== null) codes.push("RUN_NOT_COMPLETE");
  if (!approvalIds.includes(m.approval_id)) codes.push("RUN_APPROVAL_UNKNOWN");
  if (m.photos.length !== HOSHIGAMA_PHOTOS_MAX_IMAGES || m.image_tool_calls !== HOSHIGAMA_PHOTOS_MAX_IMAGES || m.image_tool_failed !== 0) codes.push("RUN_NOT_THREE_IMAGES");
  if (!m.photos.some((p) => p.photo_id === "ph-mouth-sp")) codes.push("SP_MOUTH_MISSING");
  if (m.model === null) codes.push("MODEL_NOT_REPORTED");
  if (m.prompt_sha256 !== approval.core_prompt_sha256 || m.prompt_bytes !== approval.core_prompt_bytes || m.prompt_approval_record !== approval.approval_record) codes.push("RUN_PROMPT_NOT_APPROVED");
  if (m.run_prompt_sha256 !== approval.run_prompt_sha256) codes.push("RUN_PROMPT_NOT_THE_APPROVED_ONE");
  if (!(o.generators ?? [HOSHIGAMA_GENERATOR]).includes(m.generator)) codes.push("RUN_GENERATOR_UNKNOWN");
  if (m.label !== HOSHIGAMA_DEMO_LABEL) codes.push("RUN_DEMO_LABEL_MISSING");
  if (!manifestOutOk(o.manifestOut, pipelineRoot) || existsSync(`${o.manifestOut}.provenance.json`)) codes.push("MANIFEST_OUT_NOT_PRIVATE");
  const photosDir = join(pipelineRoot, PHOTO_INTAKE_DIR);
  const loaded: Array<{ photo: HoshigamaPhoto; buf: Buffer; name: string; width: number; height: number; upscale: Upscale | null }> = [];
  for (const [i, s] of m.photos.entries()) {
    const photo = HOSHIGAMA_PHOTOS[i];
    if (!photo || s.photo_id !== photo.photo_id || s.slot_id !== photo.slot_id || s.use !== photo.use || s.file !== `${photo.photo_id}.png`) {
      codes.push(`SLOT_ORDER:${s.photo_id}`);
      continue;
    }
    if (s.photo_prompt_sha256 !== photo.prompt_sha256) codes.push(`SLOT_PROMPT_NOT_APPROVED:${s.photo_id}`);
    const file = join(o.from, s.file);
    let buf: Buffer;
    try {
      const st = lstatSync(file);
      if (!st.isFile() || st.nlink > 1) throw new Error("not a plain file");
      buf = readFileSync(file);
    } catch {
      codes.push(`FILE_UNREADABLE:${s.photo_id}`);
      continue;
    }
    const info = measurePhotoBytes(buf);
    if (!info || info.format !== "png" || sha(buf) !== s.sha256 || info.width !== s.width || info.height !== s.height) {
      codes.push(`FILE_MISMATCH:${s.photo_id}`);
      continue;
    }
    if ((info.width > info.height ? "landscape" : info.width < info.height ? "portrait" : "square") !== hoshigamaOrientationOf(photo.aspect)) {
      codes.push(`ORIENTATION_MISMATCH:${s.photo_id}`);
      continue;
    }
    const name = `hoshigama-ai-${photo.photo_id}.png`;
    if (existsSync(join(photosDir, name))) codes.push(`INTAKE_EXISTS:${s.photo_id}`);
    if (reachesHoshigamaTarget(info, photo)) {
      loaded.push({ photo, buf, name, width: info.width, height: info.height, upscale: null });
      continue;
    }
    if (!approval.upscale_allowed.includes(photo.photo_id)) {
      codes.push(`BELOW_TARGET:${s.photo_id}`);
      continue;
    }
    const factor = upscaleFactor(info, photo, HOSHIGAMA_MAX_UPSCALE);
    if (factor === null) {
      codes.push(`UPSCALE_EXCEEDS_MAX:${s.photo_id}`);
      continue;
    }
    const width = Math.round(info.width * factor);
    const height = Math.round(info.height * factor);
    let big: Buffer;
    try {
      big = await sharp(buf).resize(width, height, { kernel: "lanczos3", fit: "fill" }).png().toBuffer();
    } catch {
      codes.push(`UPSCALE_FAILED:${s.photo_id}`);
      continue;
    }
    loaded.push({ photo, buf: big, name, width, height, upscale: { original_width: info.width, original_height: info.height, original_sha256: s.sha256, factor, method: "sharp-lanczos3" } });
  }
  if (codes.length) return { ok: false, codes };
  const receivedAt = m.generated_at.slice(0, 10);
  const model = m.model!;
  const assetId = (p: HoshigamaPhoto) => `photo-hoshigama-ai-${p.photo_id.slice(3)}`;
  const ref = (l: (typeof loaded)[number]) => ({
    focal_box: l.photo.focal_box,
    rights: {
      schema: "photo_rights_v0",
      asset_id: assetId(l.photo),
      sha256: sha(l.buf),
      bytes: l.buf.length,
      width: l.width,
      height: l.height,
      format: "png",
      source_kind: "ai_generated_demo",
      owner: "Second Root (AI-generated demo for a fictional shop; no third-party rights holder)",
      license: `ai-generated demo, run approval ${m.approval_id}, prompt approval ${approval.approval_record}, photo ${l.photo.photo_id}`,
      paid: false,
      allowed_uses: { edit: true, crop: true, commercial: true, public_web: false },
      consent_record_ref: m.approval_id,
      received_at: receivedAt,
      expiry: null,
      private_path: `${PHOTO_INTAKE_DIR}/${l.name}`,
      depicts_identifiable_person: false,
      depicts_real_shop: false,
      ai_provenance: { generator: m.generator, model, generated_at: m.generated_at, prompt_sha256: m.prompt_sha256, approval_id: m.approval_id, demo_only: true, ...(l.upscale ? { upscale: l.upscale } : {}) },
    },
  });
  const bySlot = (slot: string, use: "pc" | "sp") => loaded.find((l) => l.photo.slot_id === slot && l.photo.use === use);
  const swap = {
    schema: "photo_swap_manifest_v0",
    shop: "bakery",
    slots: [...new Set(loaded.map((l) => l.photo.slot_id))].map((slot) => {
      const sp = bySlot(slot, "sp");
      return { slot_id: slot, pc: ref(bySlot(slot, "pc")!), ...(sp ? { sp: ref(sp) } : {}) };
    }),
  };
  const provenance: HoshigamaProvenance[] = loaded.map((l) => ({
    photo_id: l.photo.photo_id,
    slot_id: l.photo.slot_id,
    use: l.photo.use,
    asset_id: assetId(l.photo),
    source_kind: "ai_generated_demo",
    demo_only: true,
    public_web: false,
    generator: m.generator,
    model,
    generated_at: m.generated_at,
    approval_id: m.approval_id,
    prompt_sha256: m.prompt_sha256,
    prompt_approval_record: approval.approval_record,
    run_prompt_sha256: m.run_prompt_sha256,
    photo_prompt_sha256: l.photo.prompt_sha256,
    sha256: sha(l.buf),
    width: l.width,
    height: l.height,
    upscale: l.upscale,
  }));
  mkdirSync(photosDir, { recursive: true, mode: 0o700 });
  const files: string[] = [];
  for (const { buf, name } of loaded) {
    writeFileSync(join(photosDir, name), buf, { flag: "wx", mode: 0o600 });
    files.push(join(photosDir, name));
  }
  writeFileSync(o.manifestOut, `${JSON.stringify(swap, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  chmodSync(o.manifestOut, 0o600);
  writeFileSync(`${o.manifestOut}.provenance.json`, `${JSON.stringify({ schema: "hoshigama_ai_photo_provenance_v0", max_upscale: HOSHIGAMA_MAX_UPSCALE, photos: provenance }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return { ok: true, manifest: swap, provenance, files };
}
