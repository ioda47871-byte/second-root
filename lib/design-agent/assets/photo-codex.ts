// Codex's two photo calls (DEV-029 stage 3). Not wired into the worker yet.
//
// 1. analyzePhotos: the job's checked photos (0–3) are attached as copies;
//    Codex returns PhotoAnalyses (enums and numbers only), which must match
//    the manifest exactly.
// 2. directImages: the same copies, the analyses, the fixed DesignProfile and
//    which sections the page has; Codex returns an ImageDirection, which must
//    pass checkImageDirection for the local preview and fit the page.
//
// Each step returns a fixed failure code instead of throwing, so the caller
// can always fall back to the page without photos. No retry here (revisions
// are stage 4). Nothing of Codex's output is logged; prompts never carry a
// path, the store, a job id or consent records.
import type { DemoView } from "@/lib/sales/demo-content";
import { CodexError, runCodexJson } from "../codex";
import { buildImageDirectionPrompt, buildPhotoAnalysisPrompt } from "../photo-prompts";
import type { PhotoIssue } from "../photo-review";
import type { DesignProfile } from "../profile";
import type { CodexSandbox } from "../sandbox";
import { photoAnalysesJsonSchema, PhotoAnalysesSchema, type PhotoAnalysis } from "./analysis";
import { checkImageDirection, imageDirectionJsonSchema, NO_IMAGES, type ImageDirection } from "./direction";
import { type AssetManifest } from "./manifest";
import { readVerifiedAsset } from "./read";
import { sectionsPresent } from "./resolve";
import { toPublicAssetId, type PublicAssetId } from "./types";

export type PhotoInput = { assetId: PublicAssetId; png: Buffer; width: number; height: number };

/** One Codex JSON call with checked PNG bytes attached as copies (production: runCodexJson in the sandbox). */
export type CodexPhotoCall = (request: { prompt: string; schema: object; imageBytes: readonly Buffer[] }) => Promise<unknown>;

export type PhotoFailureCode = "PHOTO_INPUT_REJECTED" | "PHOTO_ANALYSIS_INVALID" | "IMAGE_DIRECTION_INVALID" | CodexError["code"];
export type PhotoStep<T> = { ok: true; value: T } | { ok: false; code: PhotoFailureCode; problems: string[] };

/** The production call: runCodexJson inside the OS sandbox; the photos reach Codex as work-dir copies only. */
export function sandboxPhotoCall(sandbox: CodexSandbox, timeoutMs?: number): CodexPhotoCall {
  return ({ prompt, schema, imageBytes }) => runCodexJson({ sandbox, prompt, schema, imageBytes, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
}

const fail = <T>(code: PhotoFailureCode, problems: string[] = []): PhotoStep<T> => ({ ok: false, code, problems });

/** Every photo of the job, read and checked for the local preview, in manifest order. Any failure: none. */
export async function loadPhotoInputs(o: { store: string; jobId: string; manifest: AssetManifest }): Promise<PhotoStep<PhotoInput[]>> {
  if (o.manifest.jobId !== o.jobId) return fail("PHOTO_INPUT_REJECTED", ["manifest of another job"]);
  const inputs: PhotoInput[] = [];
  for (const asset of o.manifest.assets) {
    const id = toPublicAssetId(asset.assetId);
    const png = id ? await readVerifiedAsset(o.store, o.jobId, asset, "local_preview") : null;
    if (!id || !png) return fail("PHOTO_INPUT_REJECTED", [`${asset.assetId} unreadable or not allowed`]);
    inputs.push({ assetId: id, png, width: asset.width, height: asset.height });
  }
  return { ok: true, value: inputs };
}

/** The orientations a photo of this pixel shape may be called (near-square shapes allow either). */
export function orientationsFor(width: number, height: number): PhotoAnalysis["orientation"][] {
  const r = width / height;
  if (r >= 1.15) return ["landscape"];
  if (r <= 1 / 1.15) return ["portrait"];
  if (r > 1.02) return ["square", "landscape"];
  if (r < 1 / 1.02) return ["square", "portrait"];
  return ["square"];
}

/** Codex's analyses, checked against the photos actually attached. In attachment order. */
export function checkPhotoAnalyses(value: unknown, inputs: readonly PhotoInput[]): PhotoStep<PhotoAnalysis[]> {
  const parsed = PhotoAnalysesSchema.safeParse(value);
  if (!parsed.success) return fail("PHOTO_ANALYSIS_INVALID", parsed.error.issues.slice(0, 8).map((i) => `${i.path.join(".") || "(root)"}: ${i.code}`));
  const photos = parsed.data.photos;
  const ids = inputs.map((p) => p.assetId as string);
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const a of photos) {
    if (seen.has(a.assetId)) problems.push(`${a.assetId} analysed twice`);
    seen.add(a.assetId);
    const input = inputs.find((p) => p.assetId === a.assetId);
    if (!input) {
      problems.push(`${a.assetId} is not an attached photo`);
      continue;
    }
    if (a.nearDuplicateOf !== null && (a.nearDuplicateOf === a.assetId || !ids.includes(a.nearDuplicateOf))) problems.push(`${a.assetId} has an invalid nearDuplicateOf`);
    if (!orientationsFor(input.width, input.height).includes(a.orientation)) problems.push(`${a.assetId} orientation does not match its size`);
  }
  for (const id of ids) if (!seen.has(id)) problems.push(`${id} not analysed`);
  if (problems.length > 0) return fail("PHOTO_ANALYSIS_INVALID", problems);
  return { ok: true, value: ids.map((id) => photos.find((a) => a.assetId === id)!) };
}

async function ask(call: CodexPhotoCall, request: Parameters<CodexPhotoCall>[0]): Promise<{ ok: true; answer: unknown } | { ok: false; code: PhotoFailureCode }> {
  try {
    return { ok: true, answer: await call(request) };
  } catch (error) {
    if (error instanceof CodexError) return { ok: false, code: error.code };
    throw error;
  }
}

export async function analyzePhotos(o: { call: CodexPhotoCall; inputs: readonly PhotoInput[]; category: DemoView["category"] }): Promise<PhotoStep<PhotoAnalysis[]>> {
  if (o.inputs.length === 0) return { ok: true, value: [] };
  const prompt = buildPhotoAnalysisPrompt({ category: o.category, photos: o.inputs.map(({ assetId, width, height }) => ({ assetId, width, height })) });
  const result = await ask(o.call, { prompt, schema: photoAnalysesJsonSchema(), imageBytes: o.inputs.map((p) => p.png) });
  if (!result.ok) return fail(result.code);
  return checkPhotoAnalyses(result.answer, o.inputs);
}

export async function directImages(o: {
  call: CodexPhotoCall;
  inputs: readonly PhotoInput[];
  analyses: readonly PhotoAnalysis[];
  manifest: AssetManifest;
  profile: DesignProfile;
  demo: DemoView;
  /** Photo issues of the previous direction (a revision with target images / both). */
  feedback?: readonly PhotoIssue[];
}): Promise<PhotoStep<ImageDirection>> {
  if (o.inputs.length === 0) return { ok: true, value: NO_IMAGES };
  const sections = sectionsPresent(o.demo);
  const prompt = buildImageDirectionPrompt({ photos: o.inputs.map(({ assetId, width, height }) => ({ assetId, width, height })), analyses: o.analyses, profile: o.profile, sections, feedback: o.feedback });
  const result = await ask(o.call, { prompt, schema: imageDirectionJsonSchema(), imageBytes: o.inputs.map((p) => p.png) });
  if (!result.ok) return fail(result.code);
  const check = checkImageDirection(result.answer, o.manifest, o.analyses, "local_preview");
  if (!check.ok) return fail("IMAGE_DIRECTION_INVALID", check.problems);
  const missing = check.direction.features.filter((f) => !sections[f.slot]).map((f) => `slot ${f.slot} has no section`);
  if (missing.length > 0) return fail("IMAGE_DIRECTION_INVALID", missing);
  return { ok: true, value: check.direction };
}
