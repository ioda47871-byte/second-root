import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { toDemoView, type DemoView } from "@/lib/sales/demo-content";
import { CATEGORIES, TEMPLATE_BY_CATEGORY, type Category } from "@/lib/sales/types";
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

export async function loadPreviewRun(root: string, runId: string, candidate: string): Promise<{ demo: DemoView; profile: DesignProfile | null } | null> {
  if (!RUN_ID.test(runId) || !CANDIDATE.test(candidate)) return null;
  const dir = join(root, runId);
  const demo = factsToDemoView(await readJson(join(dir, "facts.json")));
  if (!demo) return null;
  if (candidate === "none") return { demo, profile: null };
  const check = checkProfile(await readJson(join(dir, `${candidate}.json`)));
  // An unusable profile renders the existing template (fail-safe).
  return { demo, profile: check.ok ? check.profile : null };
}
