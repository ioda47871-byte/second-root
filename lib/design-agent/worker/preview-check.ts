// Production preview check (DEV-029): the worker's real render path for one
// photo candidate, without Codex and without any job. Run before a photo PoC
// (docs/operations/design-photo-poc.md); RENDER_OK is the go signal.
//
//   next build → preview server → /design-preview/<run>?profile=… and the
//   asset route → Chromium screenshots and section crops (capturePage, the
//   page-side script) → the mechanical render check
//
// The run is a temporary fixture: fictional facts, the bakery default
// profile, two photos drawn here (no image file, no real shop), a temporary
// asset store outside the repository and the temp dir, removed afterwards. It
// never touches the worker's queue, results, ledger or real asset store.
// Output: codes and counts only.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import type { Browser } from "playwright";
import { RunDeadline } from "../bounded-process";
import type { PhotoAnalysis } from "../assets/analysis";
import type { ImageDirection } from "../assets/direction";
import { analysesArtifact, assetsArtifact, imagesArtifact } from "../assets/lineage";
import { AssetManifestSchema, type AssetManifest } from "../assets/manifest";
import { checkRenderedPhotos } from "../assets/render-check";
import { sectionsPresent } from "../assets/resolve";
import { CATEGORY_DEFAULT_PROFILES } from "../defaults";
import { factsToDemoView } from "../preview";
import { productionPreview } from "./preview";

export const MIN_AVAILABLE_MIB = 3072;

export type PreviewCheckResult =
  | { code: "RENDER_OK"; desktop: { photos: number; sections: number }; mobile: { photos: number; sections: number } }
  | { code: "RENDER_MISMATCH"; problems: string[] }
  | { code: "RESOURCE_STOP"; availableMiB: number }
  | { code: "PREVIEW_CHECK_FAILED"; reason: string };

/** A PNG with a soft gradient and a disc, drawn here (no image file). */
export function drawPng(width: number, height: number, seed: number): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      const u = x / width;
      const v = y / height;
      const dx = (u - 0.5) * (width / Math.max(width, height));
      const dy = (v - 0.45) * (height / Math.max(width, height));
      const disc = dx * dx + dy * dy < 0.05;
      const at = row + 1 + x * 3;
      raw[at] = disc ? 150 : 225 - 60 * v + seed * 5;
      raw[at + 1] = disc ? 95 : 205 - 50 * u;
      raw[at + 2] = disc ? 60 : 175 - 40 * v;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

export function availableMiB(meminfo = "/proc/meminfo"): number {
  try {
    const kb = /^MemAvailable:\s+(\d+)\s+kB/m.exec(readFileSync(meminfo, "utf8"))?.[1];
    return kb ? Math.floor(Number(kb) / 1024) : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

const FACTS = {
  name: "PREVIEW CHECK BAKERY",
  category: "baked_goods",
  ward: "北区",
  address: "名古屋市北区テスト町1-2-3",
  description: "production preview の確認用の架空のパン屋です。実在の店舗ではありません。",
};

/** Writes the temporary run (facts, profile, lineage artifacts) and its asset store. */
export async function writeFixture(previewRoot: string, storeRoot: string, runId: string): Promise<{ manifest: AssetManifest; direction: ImageDirection }> {
  const photos = [
    { id: `asset-${randomBytes(12).toString("hex")}`, png: drawPng(720, 900, 1), orientation: "portrait" as const },
    { id: `asset-${randomBytes(12).toString("hex")}`, png: drawPng(960, 640, 2), orientation: "landscape" as const },
  ];
  const at = new Date().toISOString();
  const manifest = AssetManifestSchema.parse({
    version: 1,
    jobId: runId,
    assets: photos.map((p) => ({
      assetId: p.id,
      file: `${p.id}.png`,
      sha256: createHash("sha256").update(p.png).digest("hex"),
      width: p.png.readUInt32BE(16),
      height: p.png.readUInt32BE(20),
      bytes: p.png.length,
      intakeAt: at,
      people: "none",
      sourceKind: "generated_concept",
      generation: { method: "human_upload", createdBy: "preview-check", createdAt: at },
    })),
  });
  const jobDir = join(storeRoot, runId);
  await mkdir(jobDir, { recursive: true, mode: 0o700 });
  for (const p of photos) await writeFile(join(jobDir, `${p.id}.png`), p.png, { mode: 0o600 });
  await writeFile(join(jobDir, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });

  const analyses: PhotoAnalysis[] = photos.map((p) => ({
    assetId: p.id,
    subject: "product_closeup",
    people: false,
    containsText: false,
    orientation: p.orientation,
    quality: "ok",
    busy: "quiet",
    dominantColors: ["#F4E8D2", "#761D27", "#B08A5A"],
    focal: { x: 0.5, y: 0.45 },
    suitability: { hero: 4, feature: 4 },
    brandFit: 4,
    nearDuplicateOf: null,
  }));
  const place = (assetId: string, aspect: "4:5" | "3:2") => ({ assetId, fit: "cover" as const, focal: { x: 0.5, y: 0.45 }, mobileFocal: { x: 0.5, y: 0.45 }, aspect: { desktop: aspect, mobile: aspect }, treatment: "natural" as const });
  const direction: ImageDirection = {
    version: 1,
    layout: "split_hero",
    hero: place(photos[0]!.id, "4:5"),
    features: [{ ...place(photos[1]!.id, "3:2"), slot: "visit", side: "right" }],
    rejected: [],
    paletteFit: 4,
  };
  const demo = factsToDemoView(FACTS);
  if (!demo) throw new Error("fixture facts");
  const profile = CATEGORY_DEFAULT_PROFILES.baked_goods;
  const runDir = join(previewRoot, runId);
  await mkdir(join(runDir, "shots"), { recursive: true, mode: 0o700 });
  const analysesArt = analysesArtifact(runId, manifest, { photos: analyses });
  const files: Record<string, unknown> = {
    "facts.json": FACTS,
    "candidate-0.json": profile,
    "assets.json": assetsArtifact(runId, manifest),
    "photo-analyses.json": analysesArt,
    "candidate-0.images.json": imagesArtifact(runId, "candidate-0", manifest, analysesArt, profile, sectionsPresent(demo), direction),
  };
  for (const [name, value] of Object.entries(files)) await writeFile(join(runDir, name), JSON.stringify(value, null, 2), { mode: 0o600 });
  return { manifest, direction };
}

export async function runPreviewCheck(o: {
  repoDir: string;
  env: NodeJS.ProcessEnv;
  launch: (env: NodeJS.ProcessEnv) => Promise<Browser>;
  log: (line: string) => void;
  budgetMs?: number;
  meminfo?: string;
}): Promise<PreviewCheckResult> {
  const avail = availableMiB(o.meminfo);
  if (avail < MIN_AVAILABLE_MIB) return { code: "RESOURCE_STOP", availableMiB: avail };
  const runId = `preview-check-${randomBytes(4).toString("hex")}`;
  const previewRoot = await mkdtemp(join(tmpdir(), "sr-preview-check-"));
  // The store must be outside the temp dir and the repository (checkStoreRoot): a private dir under ~/.cache.
  await mkdir(join(o.env.HOME ?? homedir(), ".cache"), { recursive: true, mode: 0o700 });
  const storeRoot = await mkdtemp(join(o.env.HOME ?? homedir(), ".cache", "sr-preview-check-store-"));
  const env = { ...o.env, SR_DESIGN_ASSETS_ROOT: storeRoot };
  let session: Awaited<ReturnType<ReturnType<typeof productionPreview>>> | undefined;
  try {
    const { manifest, direction } = await writeFixture(previewRoot, storeRoot, runId);
    o.log("building and starting the production preview");
    session = await productionPreview(o.repoDir, o.launch)({ previewRoot, env, deadline: new RunDeadline(Date.now() + (o.budgetMs ?? 20 * 60_000)) });
    const shots = join(previewRoot, runId, "shots");
    await session.renderer.render(runId, "none", shots);
    const rendered = await session.renderer.render(runId, "candidate-0", shots);
    const placed = rendered.placed ?? [];
    const problems = [...checkRenderedPhotos(direction, manifest, placed), ...rendered.overflow];
    if (placed.length === 0) problems.push("no photo on the page");
    if (problems.length > 0) return { code: "RENDER_MISMATCH", problems };
    const count = (device: "desktop" | "mobile") => ({
      photos: placed.filter((p) => p.device === device).length,
      sections: (rendered.sections ?? []).filter((s) => s.includes(`-${device}-section-`)).length,
    });
    return { code: "RENDER_OK", desktop: count("desktop"), mobile: count("mobile") };
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    const message = error instanceof Error ? error.message.split("\n")[0]!.slice(0, 160) : "error";
    return { code: "PREVIEW_CHECK_FAILED", reason: typeof code === "string" ? `${code}: ${message}` : message };
  } finally {
    await session?.stop().catch(() => undefined);
    await rm(previewRoot, { recursive: true, force: true });
    await rm(storeRoot, { recursive: true, force: true });
  }
}
