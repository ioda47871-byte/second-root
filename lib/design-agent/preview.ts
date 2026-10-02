import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { toDemoView, type DemoView } from "@/lib/sales/demo-content";
import { CATEGORIES, TEMPLATE_BY_CATEGORY, type Category } from "@/lib/sales/types";
import { resolvePhotos, type RenderPhotos } from "./assets/resolve";
import { previewAssetUrl, runAssets } from "./assets/serve";
import { checkProfile, type DesignProfile } from "./profile";

// Reads a design run for the local preview route. Paths are built only from
// validated parts: the root comes from the machine's environment, the run id
// and the candidate name must match fixed patterns.

export const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{5,79}$/;
const CANDIDATE = /^(none|default|final|candidate-[0-9]{1,2})$/;

export function previewRoot(env: Record<string, string | undefined>): string | null {
  const root = env.SR_DESIGN_PREVIEW_ROOT;
  return root && isAbsolute(root) ? root : null;
}

/** Facts in the shape of sales_demos.content, passed through the fact-only filter. */
export function factsToDemoView(content: unknown): DemoView | null {
  const category = (content as { category?: unknown } | null)?.category;
  if (!CATEGORIES.includes(category as Category)) return null;
  return toDemoView(TEMPLATE_BY_CATEGORY[category as Category], content);
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

export type PreviewRun = { demo: DemoView; profile: DesignProfile | null; photos: RenderPhotos | null };

export async function loadPreviewRun(
  root: string,
  runId: string,
  candidate: string,
  options: { env?: Record<string, string | undefined>; repoDir?: string } = {},
): Promise<PreviewRun | null> {
  if (!RUN_ID.test(runId) || !CANDIDATE.test(candidate)) return null;
  const dir = join(root, runId);
  const demo = factsToDemoView(await readJson(join(dir, "facts.json")));
  if (!demo) return null;
  if (candidate === "none") return { demo, profile: null, photos: null };
  const check = checkProfile(await readJson(join(dir, `${candidate}.json`)));
  // An unusable profile renders the existing template (fail-safe).
  if (!check.ok) return { demo, profile: null, photos: null };
  return { demo, profile: check.profile, photos: await loadPhotos(dir, runId, candidate, demo, options) };
}

/**
 * The candidate's photos (DEV-029): its image direction (`<candidate>.images.json`),
 * the run's photo analyses (`photo-analyses.json`) and the asset job's manifest.
 * Anything missing or wrong means no photos; nothing here can break the page.
 */
async function loadPhotos(dir: string, runId: string, candidate: string, demo: DemoView, options: { env?: Record<string, string | undefined>; repoDir?: string }): Promise<RenderPhotos | null> {
  try {
    const direction = await readJson(join(dir, `${candidate}.images.json`));
    if (direction === undefined) return null;
    const run = await runAssets(dir, { env: options.env ?? process.env, repoDir: options.repoDir ?? process.cwd() });
    const analyses = await readJson(join(dir, "photo-analyses.json"));
    return resolvePhotos({ demo, manifest: run?.manifest ?? null, analyses, direction, src: (id) => previewAssetUrl(runId, id) }).photos;
  } catch {
    return null;
  }
}
