/**
 * Issue #293 P1: reads a PRIVATE IMAGE_FIRST run directory (outside the repository) into the validator's evidence.
 * Read only: every file is opened without following a link, with no link on its path, within a size cap
 * (impl-compare.ts readInside). Nothing is written, uploaded or copied anywhere.
 *
 *   <run>/manifest.json          model_full_page_comp_v0 (written by the generation entry; P3, after approval)
 *   <run>/facts-pack.json        shop_facts_pack_v1 (its bytes' SHA is in the record)
 *   <run>/direction.json         the ONE chosen direction object (never the whole set)
 *   <run>/parts/<name>.png       the image tool's pictures, as taken from CODEX_HOME/generated_images/<thread>/
 *   <run>/prompts/<name>.txt     each call's full prompt text (kept private; only SHA and length go into the record)
 *   <run>/visual-read.json       image_first_visual_read_v0 (the located read of each picture, bound to its SHA)
 *   <run>/identity.json          image_first_identity_v0 (one Identity Lock audit per picture)
 *   <run>/owner-evaluation.json  image_first_owner_evaluation_v0 (absent until the owner has judged the pictures)
 *
 * assembleRecord builds manifest.json's content from <run>/run-plan.json (the same record with the computed fields
 * left out: every SHA-256, size and dimension) and the files themselves, and RETURNS it; the operator saves it in the
 * private run directory. It never writes.
 *
 * and, at implementation time, an implementation directory: assets/*.png and assets.json
 * (image_first_impl_assets_v0: each asset's source and rights record SHA), for the comp-crop check.
 */
import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { readInside } from "../impl-lane/impl-compare";
import { MOCKUP_PNG_LIMITS, checkPng } from "../design-image/png";
import { ModelFullPageComp, VIEWPORTS, type ModelFullPageComp as Record_ } from "./record";
import { UNPARSEABLE, type ImplementationAsset, type JsonInput, type RunEvidence } from "./validate";

const MiB = 1024 * 1024;
export const RUN_LIMITS = { json: MiB, prompt: 64 * 1024, part: MOCKUP_PNG_LIMITS.maxBytes, asset: 16 * MiB, assets: 32 } as const;

async function readJson(dir: string, rel: string): Promise<{ bytes: Buffer | null; value: JsonInput }> {
  const bytes = await readInside(dir, rel, RUN_LIMITS.json);
  if (!bytes) return { bytes: null, value: undefined };
  try {
    return { bytes, value: JSON.parse(bytes.toString("utf8")) as unknown };
  } catch {
    return { bytes, value: UNPARSEABLE };
  }
}

/** Reads the run directory; missing files are left null / undefined for the validator to name. */
export async function readImageFirstRun(runDir: string, o: { implDir?: string } = {}): Promise<RunEvidence> {
  const manifest = await readJson(runDir, "manifest.json");
  const parts = new Map<string, Buffer | null>();
  const prompts = new Map<string, Buffer | null>();
  const rec = ModelFullPageComp.safeParse(manifest.value);
  if (rec.success) {
    for (const v of VIEWPORTS)
      for (const p of rec.data.viewports[v]?.parts ?? []) {
        if (!parts.has(p.file)) parts.set(p.file, await readInside(runDir, p.file, RUN_LIMITS.part));
        if (!prompts.has(p.prompt_file)) prompts.set(p.prompt_file, await readInside(runDir, p.prompt_file, RUN_LIMITS.prompt));
      }
  }
  const owner = await readJson(runDir, "owner-evaluation.json");
  return {
    recordBytes: manifest.bytes,
    record: manifest.value,
    factsPack: await readInside(runDir, "facts-pack.json", RUN_LIMITS.json),
    direction: await readInside(runDir, "direction.json", RUN_LIMITS.json),
    parts,
    prompts,
    visualRead: (await readJson(runDir, "visual-read.json")).value,
    identity: (await readJson(runDir, "identity.json")).value,
    ownerEvaluation: owner.value,
    ...(o.implDir ? { implementationAssets: await readImplementationAssets(o.implDir) } : {}),
  };
}

/** The implementation's assets with their declared source; an undeclared or unreadable asset is reported as such (never skipped). */
export async function readImplementationAssets(implDir: string): Promise<ImplementationAsset[]> {
  const decl = await readJson(implDir, "assets.json");
  const listed = new Map<string, { source: string; rights_record_sha256: string | null }>();
  const v = decl.value as { schema?: unknown; assets?: unknown } | undefined;
  if (v && v !== (UNPARSEABLE as unknown) && v.schema === "image_first_impl_assets_v0" && Array.isArray(v.assets))
    for (const a of v.assets as { path?: unknown; source?: unknown; rights_record_sha256?: unknown }[])
      if (a && typeof a.path === "string" && typeof a.source === "string") listed.set(a.path, { source: a.source, rights_record_sha256: typeof a.rights_record_sha256 === "string" ? a.rights_record_sha256 : null });
  const dir = join(implDir, "assets");
  const st = await lstat(dir).catch(() => null);
  if (!st) return [];
  if (!st.isDirectory()) return [{ path: "assets", bytes: Buffer.alloc(0), source: "unreadable", rights_record_sha256: null }];
  const out: ImplementationAsset[] = [];
  for (const name of (await readdir(dir)).sort().slice(0, RUN_LIMITS.assets + 1)) {
    const path = `assets/${name}`;
    const bytes = /^[a-z0-9][a-z0-9_-]{0,40}\.png$/i.test(name) ? await readInside(implDir, path, RUN_LIMITS.asset) : null;
    const d = listed.get(path);
    out.push({ path, bytes: bytes ?? Buffer.alloc(0), source: bytes ? (d?.source ?? "undeclared") : "unreadable", rights_record_sha256: d?.rights_record_sha256 ?? null });
  }
  return out;
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/**
 * Builds the record from run-plan.json and the files: facts_pack_sha256, direction.direction_sha256 and, per part,
 * png_sha256 / width / height / bytes / prompt_sha256 / prompt_chars are computed from the bytes (any value in the plan
 * is replaced). Returns the record, or the fixed problems that kept it from being built. Read only.
 */
export async function assembleRecord(runDir: string): Promise<{ record: Record_ | null; problems: string[] }> {
  const plan = await readJson(runDir, "run-plan.json");
  if (plan.value === undefined || plan.value === UNPARSEABLE || typeof plan.value !== "object" || plan.value === null) return { record: null, problems: ["PLAN_MISSING_OR_INVALID"] };
  const draft = structuredClone(plan.value) as { facts_pack_sha256?: unknown; direction?: Record<string, unknown>; viewports?: Record<string, { parts?: Record<string, unknown>[] } | null> };
  const problems: string[] = [];
  const facts = await readInside(runDir, "facts-pack.json", RUN_LIMITS.json);
  if (facts) draft.facts_pack_sha256 = sha256(facts);
  else problems.push("FACTS_PACK_MISSING");
  const direction = await readInside(runDir, "direction.json", RUN_LIMITS.json);
  if (direction && draft.direction && typeof draft.direction === "object") draft.direction.direction_sha256 = sha256(direction);
  else problems.push("DIRECTION_MISSING");
  for (const v of VIEWPORTS)
    for (const part of draft.viewports?.[v]?.parts ?? []) {
      const file = typeof part.file === "string" && /^parts\/[a-z0-9][a-z0-9_-]{0,40}\.png$/.test(part.file) ? part.file : null;
      const png = file ? await readInside(runDir, file, RUN_LIMITS.part) : null;
      let info: { width: number; height: number } | null = null;
      try {
        info = png ? checkPng(png, MOCKUP_PNG_LIMITS) : null;
      } catch {
        info = null;
      }
      if (!png || !info) problems.push(`PART_UNREADABLE_${v}_${String(part.index)}`);
      else Object.assign(part, { png_sha256: sha256(png), width: info.width, height: info.height, bytes: png.length });
      const pf = typeof part.prompt_file === "string" && /^prompts\/[a-z0-9][a-z0-9_-]{0,40}\.txt$/.test(part.prompt_file) ? part.prompt_file : null;
      const prompt = pf ? await readInside(runDir, pf, RUN_LIMITS.prompt) : null;
      if (!prompt) problems.push(`PROMPT_UNREADABLE_${v}_${String(part.index)}`);
      else Object.assign(part, { prompt_sha256: sha256(prompt), prompt_chars: prompt.toString("utf8").length });
    }
  const parsed = ModelFullPageComp.safeParse(draft);
  if (!parsed.success) problems.push("RECORD_SCHEMA");
  return problems.length === 0 && parsed.success ? { record: parsed.data, problems } : { record: null, problems };
}
