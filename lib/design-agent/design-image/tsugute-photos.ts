/**
 * DEV-185 (owner approval, Option A, 2026-11-05): the つぐ手 (tsugute, a FICTIONAL kintsugi shop) AI demo photos.
 * ONE real Codex run on the owner's WSL machine (the existing jail) that asks the image tool for the 6 slot pictures
 * of docs/design/tsugute-ai-photo-brief.md. Demo images only: not real products, workshops or craftspeople.
 *
 * The output bundle here (the prompt and slot table are in ../quality-pipeline/tsugute-ai-photos.ts); the run is scripts/sales-design-worker/tsugute-photos.ts,
 * started only by run-tsugute-photos-once.sh → tsugute-photos-gate.sh (user, cgroup, worker lock, commit pin, prompt
 * pin, one-use approval marker). The image call is generateImagesInOneRun (image-once.ts): one `codex exec`, at most
 * 6 image calls, nothing retried.
 *
 * Output (outside the repository, 0700 dir, 0600 files): <root>/tsugute-photos-XXXXXX/ with <slot>.png and
 * manifest.json (slot → file, SHA-256, pixel size, prompt hashes, generator, model as reported, generated_at).
 */
import { createHash } from "node:crypto";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cropReaches, DEMO_LABEL, GENERATOR, slotPromptSha256, TSUGUTE_PHOTOS_APPROVAL_ID, TSUGUTE_PHOTOS_MAX_IMAGES, TSUGUTE_SLOTS, type TsugutePhotosManifest } from "../quality-pipeline/tsugute-ai-photos";
import type { ImageBatchResult } from "./image-once";

export { buildTsugutePhotosPrompt, TSUGUTE_PHOTOS_APPROVAL_ID, TSUGUTE_PHOTOS_DIRECTION, TSUGUTE_PHOTOS_MAX_IMAGES } from "../quality-pipeline/tsugute-ai-photos";

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

/**
 * Writes the batch into a NEW private dir under outRoot (0700; files 0600; created with mkdtemp, never reused): each
 * picture as <slot>.png in call order (Image 1 → ph-ware …), and manifest.json. A refused batch (no picture) still
 * leaves its manifest, so the stop is on record. Returns the dir and the manifest.
 */
export async function writeTsugutePhotos(o: {
  outRoot: string;
  batch: ImageBatchResult;
  commit: string;
  prompt: string;
  generatedAt: string;
}): Promise<{ dir: string; manifest: TsugutePhotosManifest }> {
  const { batch } = o;
  if (batch.images.length > TSUGUTE_PHOTOS_MAX_IMAGES) throw new Error("more pictures than slots");
  const dir = await mkdtemp(join(o.outRoot, "tsugute-photos-"));
  await chmod(dir, 0o700);
  const slots: TsugutePhotosManifest["slots"] = [];
  for (const [i, img] of batch.images.entries()) {
    const s = TSUGUTE_SLOTS[i]!;
    const file = `${s.slot_id}.png`;
    await writeFile(join(dir, file), img.png, { flag: "wx", mode: 0o600 });
    slots.push({
      slot_id: s.slot_id,
      file,
      sha256: sha256(img.png),
      bytes: img.png.length,
      width: img.width,
      height: img.height,
      format: "png",
      slot_prompt_sha256: slotPromptSha256(s),
      meets_floor_1_5x: cropReaches(img, s.aspect, s.floor),
      meets_target_2x: cropReaches(img, s.aspect, s.target),
    });
  }
  const complete = batch.stopCode === null && batch.images.length === TSUGUTE_PHOTOS_MAX_IMAGES && batch.imageCalls === TSUGUTE_PHOTOS_MAX_IMAGES && batch.imageFailed === 0;
  const manifest: TsugutePhotosManifest = {
    schema: "tsugute_ai_photos_v0",
    shop: "tsugute",
    demo_only: true,
    label: DEMO_LABEL,
    approval_id: TSUGUTE_PHOTOS_APPROVAL_ID,
    commit: o.commit,
    prompt_sha256: sha256(o.prompt),
    prompt_chars: o.prompt.length,
    generator: GENERATOR,
    model: batch.model,
    cli_version: batch.cliVersion,
    generated_at: o.generatedAt,
    status: complete ? "complete" : "stopped",
    stop_code: complete ? null : (batch.stopCode ?? "CODEX_IMAGES_INCOMPLETE"),
    image_tool_calls: batch.imageCalls,
    image_tool_failed: batch.imageFailed,
    codex_ms: batch.codexMs,
    slot_mapping: "call_order",
    slots,
  };
  await writeFile(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return { dir, manifest };
}
