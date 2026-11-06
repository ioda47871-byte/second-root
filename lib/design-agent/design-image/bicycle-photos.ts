/**
 * DEV-191: the 輪 (bicycle, a FICTIONAL shop) run-bundle writer — the same shape as つぐ手's (tsugute-photos.ts), for the
 * 6 photos of the owner-approved prompt (../quality-pipeline/bicycle-ai-photos.ts). Prepared, NOT wired to any run: no
 * entry script, no worker shop entry and no root allowlist names 輪, so nothing can hand this writer a real batch. The
 * offline tests hand it stub batches only.
 *
 * Output (outside the repository, 0700 dir, 0600 files): <root>/bicycle-photos-XXXXXX/ with <photo_id>.png in call order
 * (Image 1 → ph-d … Image 6 → ph-bench-sp) and manifest.json (photo → slot and use, file SHA-256, pixel size, the
 * approved prompt's SHA-256 and bytes, the run prompt's SHA-256, each photo's prompt SHA-256, generator, model as
 * reported, generated_at, demo_only, public_web: false). A stopped batch still leaves its manifest, so the stop is on record.
 */
import { createHash } from "node:crypto";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BICYCLE_DEMO_LABEL, BICYCLE_GENERATOR, BICYCLE_PHOTOS, BICYCLE_PHOTOS_MAX_IMAGES, BICYCLE_PROMPT_APPROVAL, BICYCLE_PROMPT_BYTES, BICYCLE_PROMPT_SHA256, BICYCLE_RUN_PROMPT_CANDIDATE_SHA256, checkApprovedBicyclePrompt, reachesTarget, type BicyclePhotosManifest } from "../quality-pipeline/bicycle-ai-photos";
import type { ImageBatchResult } from "./image-once";

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

export async function writeBicyclePhotos(o: {
  outRoot: string;
  batch: ImageBatchResult;
  commit: string;
  /** the owner-approved prompt text (the file's bytes); refused unless it matches the pins */
  approvedPrompt: string;
  /** the prompt the run actually sent (the candidate wrapper around the approved text) */
  runPrompt: string;
  generatedAt: string;
  /** the one-use approval id of the run: required, there is no default (no 輪 run is approved) */
  approvalId: string;
  /** the means; the real run's label unless an offline stub writes its own */
  generator?: string;
}): Promise<{ dir: string; manifest: BicyclePhotosManifest }> {
  const { batch } = o;
  const check = checkApprovedBicyclePrompt(o.approvedPrompt);
  if (!check.ok) throw new Error(`PROMPT_NOT_APPROVED: ${check.codes.join(",")}`);
  if (!o.runPrompt.endsWith(check.parsed.fromCommon)) throw new Error("RUN_PROMPT_DOES_NOT_CARRY_THE_APPROVED_TEXT");
  // PR #233 review L2: only the pinned candidate run prompt (checked before anything is written; the owner approves its SHA with a run)
  if (sha256(o.runPrompt) !== BICYCLE_RUN_PROMPT_CANDIDATE_SHA256) throw new Error("RUN_PROMPT_NOT_THE_CANDIDATE");
  if (batch.images.length > BICYCLE_PHOTOS_MAX_IMAGES) throw new Error("more pictures than photos");
  const dir = await mkdtemp(join(o.outRoot, "bicycle-photos-"));
  await chmod(dir, 0o700);
  const photos: BicyclePhotosManifest["photos"] = [];
  for (const [i, img] of batch.images.entries()) {
    const p = BICYCLE_PHOTOS[i]!;
    const file = `${p.photo_id}.png`;
    await writeFile(join(dir, file), img.png, { flag: "wx", mode: 0o600 });
    photos.push({
      photo_id: p.photo_id,
      slot_id: p.slot_id,
      use: p.use,
      file,
      sha256: sha256(img.png),
      bytes: img.png.length,
      width: img.width,
      height: img.height,
      format: "png",
      photo_prompt_sha256: p.prompt_sha256,
      meets_target_2x: reachesTarget(img, p),
    });
  }
  const complete = batch.stopCode === null && batch.images.length === BICYCLE_PHOTOS_MAX_IMAGES && batch.imageCalls === BICYCLE_PHOTOS_MAX_IMAGES && batch.imageFailed === 0;
  const manifest: BicyclePhotosManifest = {
    schema: "bicycle_ai_photos_v0",
    shop: "bicycle",
    page: "d1-v9",
    demo_only: true,
    public_web: false,
    label: BICYCLE_DEMO_LABEL,
    approval_id: o.approvalId,
    prompt_approval_id: BICYCLE_PROMPT_APPROVAL.approval_id,
    commit: o.commit,
    prompt_sha256: BICYCLE_PROMPT_SHA256,
    prompt_bytes: BICYCLE_PROMPT_BYTES,
    run_prompt_sha256: sha256(o.runPrompt),
    generator: o.generator ?? BICYCLE_GENERATOR,
    model: batch.model,
    cli_version: batch.cliVersion,
    generated_at: o.generatedAt,
    status: complete ? "complete" : "stopped",
    stop_code: complete ? null : (batch.stopCode ?? "CODEX_IMAGES_INCOMPLETE"),
    image_tool_calls: batch.imageCalls,
    image_tool_failed: batch.imageFailed,
    codex_ms: batch.codexMs,
    slot_mapping: "call_order",
    photos,
  };
  await writeFile(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return { dir, manifest };
}
