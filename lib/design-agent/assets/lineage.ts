import { createHash } from "node:crypto";
import { z } from "zod";
import type { DesignProfile } from "../profile";
import { CANDIDATE, RUN_ID } from "../run-id";
import { PhotoAnalysesSchema, type PhotoAnalyses } from "./analysis";
import { ImageDirectionSchema, type ImageDirection } from "./direction";
import { JOB_ID, type AssetManifest } from "./manifest";

// Where every photo artifact of a design run comes from (DEV-029 stage 4).
//
//   assets.json             the run's asset set: run id, job id, each asset id + sha256
//   photo-analyses.json     PhotoAnalyses + the asset set it was made from
//   <candidate>.images.json ImageDirection + the asset set, analyses and profile it was made for
//
// Each carries the run id, the job id, the asset-set digest, an input digest
// and the digest of its own value. The preview and the pipeline accept an
// artifact only when all of them match the run, the job's current manifest
// and the other artifacts it depends on; so nothing of another run, another
// job or another asset set can be mixed in, and no value can be edited
// without its digest changing. The worker's asset job is the store job with
// the worker job's own id.

/** JSON with object keys sorted at every level (stable digests). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** The verified asset set: which photos, exactly which bytes, of which job. */
export function assetSetDigest(m: AssetManifest): string {
  return digest({ jobId: m.jobId, assets: m.assets.map((a) => ({ assetId: a.assetId, sha256: a.sha256 })) });
}

const DIGEST = z.string().regex(/^[a-f0-9]{64}$/);
const lineage = { version: z.literal(1), runId: z.string().regex(RUN_ID), jobId: z.string().regex(JOB_ID), assetSetDigest: DIGEST };

export const AssetsArtifactSchema = z.strictObject({
  ...lineage,
  assets: z.array(z.strictObject({ assetId: z.string(), sha256: DIGEST })).max(3),
});
export const AnalysesArtifactSchema = z.strictObject({ ...lineage, inputDigest: DIGEST, outputDigest: DIGEST, value: PhotoAnalysesSchema });
export const ImagesArtifactSchema = z.strictObject({
  ...lineage,
  candidate: z.string().regex(CANDIDATE),
  analysesDigest: DIGEST,
  profileDigest: DIGEST,
  inputDigest: DIGEST,
  outputDigest: DIGEST,
  value: ImageDirectionSchema,
});

export type AssetsArtifact = z.infer<typeof AssetsArtifactSchema>;
export type AnalysesArtifact = z.infer<typeof AnalysesArtifactSchema>;
export type ImagesArtifact = z.infer<typeof ImagesArtifactSchema>;

export function assetsArtifact(runId: string, m: AssetManifest): AssetsArtifact {
  return { version: 1, runId, jobId: m.jobId, assetSetDigest: assetSetDigest(m), assets: m.assets.map((a) => ({ assetId: a.assetId, sha256: a.sha256 })) };
}

export function analysesArtifact(runId: string, m: AssetManifest, value: PhotoAnalyses): AnalysesArtifact {
  const set = assetSetDigest(m);
  return { version: 1, runId, jobId: m.jobId, assetSetDigest: set, inputDigest: set, outputDigest: digest(value), value };
}

export function imagesArtifact(runId: string, candidate: string, m: AssetManifest, analyses: AnalysesArtifact, profile: DesignProfile, sections: { about: boolean; visit: boolean }, value: ImageDirection): ImagesArtifact {
  const set = assetSetDigest(m);
  const profileDigest = digest(profile);
  return {
    version: 1,
    runId,
    jobId: m.jobId,
    candidate,
    assetSetDigest: set,
    analysesDigest: analyses.outputDigest,
    profileDigest,
    inputDigest: digest({ assetSetDigest: set, analysesDigest: analyses.outputDigest, profileDigest, sections }),
    outputDigest: digest(value),
    value,
  };
}

const sameRun = (a: { runId: string; jobId: string; assetSetDigest: string }, runId: string, m: AssetManifest) =>
  a.runId === runId && a.jobId === m.jobId && a.assetSetDigest === assetSetDigest(m);

export function verifyAssets(value: unknown, runId: string, m: AssetManifest): boolean {
  const p = AssetsArtifactSchema.safeParse(value);
  return p.success && sameRun(p.data, runId, m) && digest(p.data.assets) === digest(m.assets.map((a) => ({ assetId: a.assetId, sha256: a.sha256 })));
}

/** The analyses of this run and asset set, or null. */
export function verifyAnalyses(value: unknown, runId: string, m: AssetManifest): PhotoAnalyses | null {
  const p = AnalysesArtifactSchema.safeParse(value);
  if (!p.success || !sameRun(p.data, runId, m) || p.data.inputDigest !== p.data.assetSetDigest || p.data.outputDigest !== digest(p.data.value)) return null;
  return p.data.value;
}

/** An earlier analysis that may be used again: same run, same verified asset set (ids and sha256). */
export function reusableAnalyses(value: unknown, runId: string, m: AssetManifest): PhotoAnalyses | null {
  return verifyAnalyses(value, runId, m);
}

/** The direction of this candidate, made from these analyses and this profile, or null. */
export function verifyImages(value: unknown, runId: string, candidate: string, m: AssetManifest, analyses: unknown, profile: DesignProfile): ImageDirection | null {
  const p = ImagesArtifactSchema.safeParse(value);
  const a = AnalysesArtifactSchema.safeParse(analyses);
  if (!p.success || !a.success || !sameRun(p.data, runId, m) || p.data.candidate !== candidate) return null;
  if (!verifyAnalyses(a.data, runId, m) || p.data.analysesDigest !== a.data.outputDigest) return null;
  if (p.data.profileDigest !== digest(profile) || p.data.outputDigest !== digest(p.data.value)) return null;
  return p.data.value;
}
