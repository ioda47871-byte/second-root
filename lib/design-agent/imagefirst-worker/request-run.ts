/**
 * DEV-303 (owner decision 2026-11-24): the entry's request mode after loadRequestRun — one request, one Codex run, by
 * stage: photo_materials → runRequestPhotoCall (1..6 picture materials); design → runRequestFullPageCall (PC 2 + SP 4, or a whole_page PC 1 + SP 1 with its reference pictures),
 * with the resolved photo inputs (if the request names them) attached to that one run. Used by the IMAGE_FIRST entry's
 * request mode (cycle.ts GENERATE_ENTRY) and its in-process test mirror, so both dispatch the same way.
 * No process and no network here.
 */
import { isPhotoRequest, type PhotoPlan, type RequestPlan } from "../image-first/request-prompt";
import { runRequestFullPageCall, runRequestPhotoCall, type FullPageCallDeps, type FullPageCallResult } from "../phase2f-live/full-page-call";
import type { RequestRunInputs } from "./request";

export type LoadedRequestOptions = {
  run: RequestRunInputs;
  expected: { promptSha256: string; promptChars: number; commit: string; planSha256: string };
  outDir: string;
  repoRoot: string;
  signal?: AbortSignal;
};

export async function runLoadedRequest(o: LoadedRequestOptions, d: Omit<FullPageCallDeps, "packetAt">): Promise<FullPageCallResult> {
  const { run } = o;
  const common = {
    inputs: { factsBytes: run.factsBytes, directionBytes: run.directionBytes },
    requestId: run.request.id,
    requestSha256: run.requestSha256,
    expected: o.expected,
    outDir: o.outDir,
    repoRoot: o.repoRoot,
    ...(o.signal === undefined ? {} : { signal: o.signal }),
  };
  if (isPhotoRequest(run.request)) return runRequestPhotoCall({ ...common, plan: run.plan as PhotoPlan }, d);
  // a run never starts on unchecked photo inputs (only --validate-request leaves them unchecked)
  if (run.photos === "unchecked") return { status: "stopped", code: "PHOTO_INPUT_RUN_MISSING", stage: "precheck", aborted: false };
  // DEV-303 §6.1 row 3: a whole_page run carries its success-case reference pictures (exactly the plan's references)
  return runRequestFullPageCall({ ...common, plan: run.plan as RequestPlan, ...(run.photos ? { photos: run.photos } : {}), ...(run.references ? { references: run.references } : {}) }, d);
}
