/**
 * DEV-139: the ほし窯 (bakery, a FICTIONAL bakery) run-bundle writer — the same shape as 輪's (bicycle-photos.ts), for the 3
 * photos of ../quality-pipeline/hoshigama-ai-photos.ts. It refuses unless an approval record (default HOSHIGAMA_APPROVAL,
 * the owner's one-run approval of 2026-11-18) names exactly the prompt text's bytes and the run prompt. The worker's
 * image auto-run called writeHoshigamaPhotosForRun for that ONE run only; the run is used (Issue #139 comment
 * 6990007019) and Issue #290 P0 removed ほし窯 and this writer from the worker (autorun-shops.ts CLOSED_SHOPS), so
 * nothing in the worker calls it any more. The bundle schema stays: the offline intake verifies the photos already made.
 *
 * Output (outside the repository, 0700 dir, 0600 files): <root>/hoshigama-photos-XXXXXX/ with <photo_id>.png in call order
 * (Image 1 → ph-mouth-pc, 2 → ph-mouth-sp, 3 → ph-loaf) and manifest.json (photo → slot and use, file SHA-256, pixel
 * size, the approved prompt's SHA-256 and bytes, the run prompt's SHA-256, each photo's prompt SHA-256, generator, model
 * as reported, generated_at, demo_only, public_web: false). A stopped batch still leaves its manifest.
 */
import { createHash } from "node:crypto";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  checkApprovedHoshigamaPrompt,
  HOSHIGAMA_APPROVAL,
  HOSHIGAMA_DEMO_LABEL,
  HOSHIGAMA_GENERATOR,
  HOSHIGAMA_PHOTOS,
  HOSHIGAMA_PHOTOS_MAX_IMAGES,
  reachesHoshigamaTarget,
  readApprovedHoshigamaPrompt,
  type HoshigamaApproval,
  type HoshigamaPhotosManifest,
} from "../quality-pipeline/hoshigama-ai-photos";
import type { ImageBatchResult } from "./image-once";

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

export async function writeHoshigamaPhotos(o: {
  outRoot: string;
  batch: ImageBatchResult;
  commit: string;
  /** the prompt text (the file's bytes); refused unless the approval names exactly these bytes */
  approvedPrompt: string;
  /** the prompt the run actually sent (the run wrapper around the approved text) */
  runPrompt: string;
  generatedAt: string;
  /** the one-use approval id of the run: required, no default (the owner chooses it at run time) */
  approvalId: string;
  generator?: string;
  /** the owner's approval record; default HOSHIGAMA_APPROVAL. Tests may pass another (null: everything is refused). */
  approval?: HoshigamaApproval | null;
}): Promise<{ dir: string; manifest: HoshigamaPhotosManifest }> {
  const { batch } = o;
  const approval = o.approval === undefined ? HOSHIGAMA_APPROVAL : o.approval;
  const check = checkApprovedHoshigamaPrompt(o.approvedPrompt, approval);
  if (!check.ok || !approval) throw new Error(`PROMPT_NOT_APPROVED: ${check.ok ? "NO_APPROVAL" : check.codes.join(",")}`);
  if (!o.runPrompt.endsWith(check.parsed.fromCommon)) throw new Error("RUN_PROMPT_DOES_NOT_CARRY_THE_APPROVED_TEXT");
  if (sha256(o.runPrompt) !== approval.run_prompt_sha256 || o.runPrompt.length !== approval.run_prompt_chars) throw new Error("RUN_PROMPT_NOT_APPROVED");
  if (batch.images.length > HOSHIGAMA_PHOTOS_MAX_IMAGES) throw new Error("more pictures than photos");
  const dir = await mkdtemp(join(o.outRoot, "hoshigama-photos-"));
  await chmod(dir, 0o700);
  const photos: HoshigamaPhotosManifest["photos"] = [];
  for (const [i, img] of batch.images.entries()) {
    const p = HOSHIGAMA_PHOTOS[i]!;
    const file = `${p.photo_id}.png`;
    await writeFile(join(dir, file), img.png, { flag: "wx", mode: 0o600 });
    photos.push({ photo_id: p.photo_id, slot_id: p.slot_id, use: p.use, file, sha256: sha256(img.png), bytes: img.png.length, width: img.width, height: img.height, format: "png", photo_prompt_sha256: p.prompt_sha256, meets_target_2x: reachesHoshigamaTarget(img, p) });
  }
  const complete = batch.stopCode === null && batch.images.length === HOSHIGAMA_PHOTOS_MAX_IMAGES && batch.imageCalls === HOSHIGAMA_PHOTOS_MAX_IMAGES && batch.imageFailed === 0;
  const manifest: HoshigamaPhotosManifest = {
    schema: "hoshigama_ai_photos_v0",
    shop: "bakery",
    page: "d2-v2",
    demo_only: true,
    public_web: false,
    label: HOSHIGAMA_DEMO_LABEL,
    approval_id: o.approvalId,
    prompt_approval_record: approval.approval_record,
    commit: o.commit,
    prompt_sha256: approval.core_prompt_sha256,
    prompt_bytes: approval.core_prompt_bytes,
    run_prompt_sha256: sha256(o.runPrompt),
    generator: o.generator ?? HOSHIGAMA_GENERATOR,
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

/**
 * The worker hook's call of the one approved run (the same inputs as 輪's writeBicyclePhotosForRun). Issue #290 P0: no
 * longer wired into the worker (image-autorun.ts has no ほし窯 writer). The text is read from this checkout; unapproved
 * bytes or no approval → it throws.
 */
export async function writeHoshigamaPhotosForRun(o: { outRoot: string; batch: ImageBatchResult; commit: string; prompt: string; generatedAt: string; approvalId?: string }): Promise<{ dir: string; manifest: HoshigamaPhotosManifest }> {
  if (!o.approvalId) throw new Error("APPROVAL_ID_REQUIRED");
  const approvedPrompt = readApprovedHoshigamaPrompt();
  if (!approvedPrompt) throw new Error("PROMPT_NOT_APPROVED");
  return writeHoshigamaPhotos({ outRoot: o.outRoot, batch: o.batch, commit: o.commit, approvedPrompt, runPrompt: o.prompt, generatedAt: o.generatedAt, approvalId: o.approvalId });
}
