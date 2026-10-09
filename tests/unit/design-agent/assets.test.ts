import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PhotoAnalysisSchema, type PhotoAnalysis } from "@/lib/design-agent/assets/analysis";
import { checkImageDirection, ImageDirectionSchema, type ImageDirection } from "@/lib/design-agent/assets/direction";
import {
  assetStoreRoot,
  checkStoreRoot,
  chromiumNormalizer,
  intakeAsset,
  IntakeError,
  isReferenceLocation,
  loadManifest,
  pngChunkTypes,
  type IntakeOptions,
  type IntakeSource,
} from "@/lib/design-agent/assets/intake";
import { AssetManifestSchema, assetUsableIn, consentAllows, type AssetManifest, type AssetRecord } from "@/lib/design-agent/assets/manifest";
import { toPublicAssetId, toReferenceImagePath, type PublicAssetId, type ReferenceImagePath } from "@/lib/design-agent/assets/types";

// DEV-029 stage 1: asset types, manifest, analysis / direction schemas and
// intake. Every photo here is drawn by the test itself (shapes and gradients,
// no real shop, product or person); nothing is stored in the repository.

vi.setConfig({ testTimeout: 60_000 });

const REPO = process.cwd();
const MARKER = "SR-METADATA-MARKER-GPS-35.0-136.9";
const GENERATED: IntakeSource = { sourceKind: "generated_concept", createdBy: "designer", createdAt: "2026-10-02T09:00:00Z" };
const APPROVED: IntakeSource = { sourceKind: "approved_real", consentId: "consent-001", approvedBy: "sales-admin", approvedAt: "2026-10-02T09:00:00Z", scopes: ["local_preview"] };

let browser: Browser;
let base: string;
let env: Record<string, string>;
let store: string;
let photos: string;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  base = await mkdtemp(join(tmpdir(), "assets-test-"));
  // The store may not sit in TMPDIR, so the test's TMPDIR is a sibling of it.
  env = { HOME: join(base, "home"), TMPDIR: join(base, "tmp") };
  store = join(base, "store");
  photos = join(base, "photos");
  await Promise.all([mkdir(env.HOME, { recursive: true }), mkdir(env.TMPDIR, { recursive: true }), mkdir(photos, { recursive: true })]);
});
afterAll(async () => {
  await browser?.close();
  await rm(base, { recursive: true, force: true });
});

const scratch = async () => {
  const context = await browser.newContext({ offline: true });
  const page = await context.newPage();
  return { page, close: () => context.close() };
};

type Fake = { width: number; height: number; format: "png" | "jpeg" | "webp"; busy?: boolean; seed?: number };

/** A fictional photo: a gradient with soft shapes (quiet) or many small ones (busy). */
async function fakePhoto(f: Fake): Promise<Buffer> {
  const { page, close } = await scratch();
  try {
    const url = await page.evaluate(({ width, height, format, busy, seed }) => {
      const c = document.createElement("canvas");
      c.width = width;
      c.height = height;
      const ctx = c.getContext("2d")!;
      const g = ctx.createLinearGradient(0, 0, width, height);
      g.addColorStop(0, `hsl(${(seed * 47) % 360} 45% 78%)`);
      g.addColorStop(1, `hsl(${(seed * 47 + 40) % 360} 35% 42%)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, width, height);
      const n = busy ? 160 : 3;
      for (let i = 0; i < n; i++) {
        const r = busy ? 6 + ((i * 13) % 20) : Math.min(width, height) / 5;
        ctx.fillStyle = `hsla(${(i * 37 + seed * 11) % 360} 50% 55% / 0.8)`;
        ctx.beginPath();
        ctx.arc(((i * 97 + seed * 31) % 100) / 100 * width, ((i * 61 + seed * 17) % 100) / 100 * height, r, 0, Math.PI * 2);
        ctx.fill();
      }
      return c.toDataURL(`image/${format}`, 0.9);
    }, { ...f, busy: f.busy ?? false, seed: f.seed ?? 1 });
    return Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
  } finally {
    await close();
  }
}

/** Adds a tEXt chunk (with the marker) right after IHDR. */
function withPngText(png: Buffer): Buffer {
  const data = Buffer.from(`Comment\0${MARKER}`, "latin1");
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write("tEXt", 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  const ihdrEnd = 8 + 12 + png.readUInt32BE(8);
  return Buffer.concat([png.subarray(0, ihdrEnd), head, data, crc, png.subarray(ihdrEnd)]);
}

/** Adds an APP1 "Exif" segment (with the marker) right after SOI. */
function withJpegExif(jpeg: Buffer): Buffer {
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), Buffer.from(`MM\0*\0\0\0\x08${MARKER}`, "latin1")]);
  const segment = Buffer.alloc(4);
  segment.writeUInt16BE(0xffe1, 0);
  segment.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), segment, payload, jpeg.subarray(2)]);
}

let fileCount = 0;
async function photoFile(bytes: Buffer, ext: string, dir = photos): Promise<string> {
  const path = join(dir, `photo-${fileCount++}.${ext}`);
  await writeFile(path, bytes, { mode: 0o600 });
  return path;
}

function options(jobId: string, file: string, over: Partial<IntakeOptions> = {}): IntakeOptions {
  return { storeRoot: store, repoDir: REPO, env, jobId, file, source: GENERATED, peopleConfirmedNone: true, normalize: chromiumNormalizer(scratch), ...over };
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "ACCEPTED";
  } catch (error) {
    if (error instanceof IntakeError) return error.code;
    throw error;
  }
}

// ---------------------------------------------------------------- types

describe("asset types", () => {
  it("keeps public asset ids and reference paths apart", () => {
    const id = toPublicAssetId("asset-0123456789abcdef01234567");
    expect(id).not.toBeNull();
    expect(toPublicAssetId("../etc/passwd")).toBeNull();
    expect(toPublicAssetId("/tmp/sr-design-worker-abc123/reference-0.png")).toBeNull();
    const ref: ReferenceImagePath = toReferenceImagePath("/tmp/sr-design-worker-abc123/reference-0.png");
    const usePublic = (value: PublicAssetId) => value;
    const useReference = (value: ReferenceImagePath) => value;
    // @ts-expect-error a reference screenshot is never a public asset
    usePublic(ref);
    // @ts-expect-error nor the other way round
    useReference(id!);
    // @ts-expect-error a plain string is neither
    usePublic("asset-0123456789abcdef01234567");
  });
});

// ---------------------------------------------------------------- manifest

const record = (over: Partial<AssetRecord> & { assetId?: string } = {}): AssetRecord => {
  const assetId = over.assetId ?? "asset-0123456789abcdef01234567";
  return {
    assetId,
    file: `${assetId}.png`,
    sha256: "a".repeat(64),
    width: 1200,
    height: 900,
    bytes: 1000,
    intakeAt: "2026-10-02T09:00:00Z",
    people: "none",
    sourceKind: "generated_concept",
    generation: { method: "human_upload", createdBy: "designer", createdAt: "2026-10-02T09:00:00Z" },
    ...over,
  } as AssetRecord;
};
const approved = (scopes: string[], over: Record<string, unknown> = {}): AssetRecord => {
  const { generation: _generated, ...common } = record() as Extract<AssetRecord, { sourceKind: "generated_concept" }>;
  void _generated;
  const assetId = (over.assetId as string | undefined) ?? common.assetId;
  return {
    ...common,
    assetId,
    file: `${assetId}.png`,
    sourceKind: "approved_real",
    consent: { consentId: "consent-001", approvedBy: "sales-admin", approvedAt: "2026-10-02T09:00:00Z", scopes },
    ...over,
  } as unknown as AssetRecord;
};
const manifestOf = (...assets: AssetRecord[]) => ({ version: 1, jobId: "job-001", assets });

describe("asset manifest", () => {
  it("accepts generated and approved photos with their records", () => {
    expect(AssetManifestSchema.safeParse(manifestOf(record())).success).toBe(true);
    expect(AssetManifestSchema.safeParse(manifestOf(approved(["local_preview", "public_demo"]))).success).toBe(true);
  });

  it("refuses an approved photo without consent, with no scope or a repeated one", () => {
    const { consent: _drop, ...noConsent } = approved(["local_preview"]) as Extract<AssetRecord, { sourceKind: "approved_real" }>;
    void _drop;
    expect(AssetManifestSchema.safeParse(manifestOf(noConsent as AssetRecord)).success).toBe(false);
    expect(AssetManifestSchema.safeParse(manifestOf(approved([]))).success).toBe(false);
    expect(AssetManifestSchema.safeParse(manifestOf(approved(["local_preview", "local_preview"]))).success).toBe(false);
    expect(AssetManifestSchema.safeParse(manifestOf(approved(["everywhere"]))).success).toBe(false);
  });

  it("refuses people, a fourth photo, the same image twice, a file name not its id, and extra fields", () => {
    expect(AssetManifestSchema.safeParse(manifestOf(record({ people: "some" } as never))).success).toBe(false);
    const ids = ["a", "b", "c", "d"].map((c) => `asset-${c.repeat(24)}`);
    expect(AssetManifestSchema.safeParse(manifestOf(...ids.map((assetId, i) => record({ assetId, sha256: String(i).repeat(64) })))).success).toBe(false);
    expect(AssetManifestSchema.safeParse(manifestOf(record({ assetId: ids[0] }), record({ assetId: ids[1] }))).success).toBe(false);
    expect(AssetManifestSchema.safeParse(manifestOf(record({ file: `${ids[1]}.png` }))).success).toBe(false);
    expect(AssetManifestSchema.safeParse(manifestOf({ ...record(), caption: "shop text" } as unknown as AssetRecord)).success).toBe(false);
  });

  it("keeps the local preview and public demo scopes apart, and shows no photo on the public demo in DEV-029", () => {
    const localOnly = approved(["local_preview"]);
    const publicOnly = approved(["public_demo"]);
    const both = approved(["local_preview", "public_demo"]);
    expect(consentAllows(localOnly, "local_preview")).toBe(true);
    expect(consentAllows(localOnly, "public_demo")).toBe(false);
    expect(consentAllows(publicOnly, "local_preview")).toBe(false);
    expect(consentAllows(both, "public_demo")).toBe(true);
    for (const a of [localOnly, publicOnly, both, record()]) expect(assetUsableIn(a, "public_demo")).toBe(false);
    expect(assetUsableIn(record(), "local_preview")).toBe(true);
  });
});

// ---------------------------------------------------------------- analysis and direction

const A = "asset-aaaaaaaaaaaaaaaaaaaaaaaa";
const B = "asset-bbbbbbbbbbbbbbbbbbbbbbbb";
const C = "asset-cccccccccccccccccccccccc";

const analysis = (assetId: string, over: Partial<PhotoAnalysis> = {}): PhotoAnalysis => ({
  assetId,
  subject: "product_closeup",
  people: false,
  containsText: false,
  orientation: "portrait",
  quality: "ok",
  busy: "quiet",
  dominantColors: ["#F4E8D2", "#761D27", "#B08A5A"],
  focal: { x: 0.5, y: 0.4 },
  suitability: { hero: 5, feature: 4 },
  brandFit: 4,
  nearDuplicateOf: null,
  ...over,
});
const place = (assetId: string) => ({
  assetId,
  fit: "cover" as const,
  focal: { x: 0.5, y: 0.4 },
  mobileFocal: { x: 0.5, y: 0.35 },
  aspect: { desktop: "4:5" as const, mobile: "1:1" as const },
  treatment: "natural" as const,
});
const direction = (over: Partial<ImageDirection> = {}): ImageDirection => ({
  version: 1,
  layout: "split_hero",
  hero: place(A),
  features: [{ ...place(B), slot: "about", side: "right" }],
  rejected: [{ assetId: C, reason: "not_needed" }],
  paletteFit: 4,
  ...over,
});
const three = AssetManifestSchema.parse(manifestOf(record({ assetId: A, sha256: "1".repeat(64) }), record({ assetId: B, sha256: "2".repeat(64) }), record({ assetId: C, sha256: "3".repeat(64) })));
const analyses = [analysis(A), analysis(B, { orientation: "landscape" }), analysis(C, { orientation: "square" })];
const problems = (value: unknown, manifest: AssetManifest = three, a: PhotoAnalysis[] = analyses) => {
  const r = checkImageDirection(value, manifest, a);
  return r.ok ? [] : r.problems;
};

describe("photo analysis", () => {
  it("holds enums and numbers only: no free text can come out of a photo", () => {
    expect(PhotoAnalysisSchema.safeParse(analysis(A)).success).toBe(true);
    expect(PhotoAnalysisSchema.safeParse({ ...analysis(A), caption: "焼きたて ¥300" }).success).toBe(false);
    expect(PhotoAnalysisSchema.safeParse({ ...analysis(A), subject: "a cake" }).success).toBe(false);
    expect(PhotoAnalysisSchema.safeParse({ ...analysis(A), focal: { x: 1.2, y: 0 } }).success).toBe(false);
  });
});

describe("image direction", () => {
  it("accepts each MVP layout with the photos it needs", () => {
    expect(problems(direction())).toEqual([]);
    expect(problems(direction({ layout: "framed_hero" }))).toEqual([]);
    expect(problems(direction({ layout: "type_hero_feature_band", hero: null, rejected: [{ assetId: A, reason: "not_needed" }, { assetId: C, reason: "not_needed" }] }))).toEqual([]);
    const none = direction({ layout: "none", hero: null, features: [], rejected: [A, B, C].map((assetId) => ({ assetId, reason: "not_needed" as const })) });
    expect(problems(none)).toEqual([]);
    expect(problems(none, manifestOf() as AssetManifest, [])).toContain(`unknown asset ${A}`);
    expect(problems({ ...none, rejected: [] }, manifestOf() as AssetManifest, [])).toEqual([]);
  });

  it("refuses layouts without the photos they need, or with photos they must not have", () => {
    expect(problems(direction({ hero: null }))).toContain("split_hero needs a hero photo");
    expect(problems(direction({ layout: "none" }))).toContain("layout none uses photos");
    expect(problems(direction({ layout: "type_hero_feature_band" }))).toContain("type_hero_feature_band has no hero photo");
  });

  it("refuses unknown ids, a photo used twice, an undecided photo and near duplicates", () => {
    expect(problems(direction({ hero: place("asset-dddddddddddddddddddddddd") }))).toContain("unknown asset asset-dddddddddddddddddddddddd");
    expect(problems(direction({ features: [{ ...place(A), slot: "about", side: "right" }], rejected: [{ assetId: B, reason: "not_needed" }, { assetId: C, reason: "not_needed" }] }))).toContain("an asset appears twice");
    expect(problems(direction({ rejected: [] }))).toContain(`${C} is neither used nor rejected`);
    const twins = [analysis(A), analysis(B, { nearDuplicateOf: A }), analysis(C)];
    expect(problems(direction(), three, twins)).toContain(`${B} and ${A} are near duplicates`);
  });

  it("never uses a photo with people, or an approved photo without local preview consent", () => {
    expect(problems(direction(), three, [analysis(A, { people: true }), analyses[1], analyses[2]])).toContain(`${A} shows people`);
    expect(problems(direction(), three, [analysis(A, { subject: "people" }), analyses[1], analyses[2]])).toContain(`${A} shows people`);
    const publicOnly = AssetManifestSchema.parse(manifestOf(approved(["public_demo"], { assetId: A, sha256: "1".repeat(64) }), three.assets[1], three.assets[2]));
    expect(problems(direction(), publicOnly)).toContain(`${A} is not allowed in local_preview`);
  });

  it("has no menu slot (no photo as a menu item's picture), at most two features, no text fields", () => {
    expect(ImageDirectionSchema.safeParse(direction({ features: [{ ...place(B), slot: "menu" as never, side: "right" }] })).success).toBe(false);
    expect(ImageDirectionSchema.safeParse(direction({ features: [A, B, C].map((id, i) => ({ ...place(id), slot: (["about", "visit", "about"] as const)[i], side: "left" as const })) })).success).toBe(false);
    expect(ImageDirectionSchema.safeParse({ ...direction(), headline: "焼きたて" }).success).toBe(false);
    expect(ImageDirectionSchema.safeParse(direction({ layout: "gallery_grid" as never })).success).toBe(false);
    expect(problems(direction({ layout: "type_hero_feature_band", hero: null, features: [{ ...place(A), slot: "about", side: "left" }, { ...place(B), slot: "about", side: "right" }] }))).toContain("two photos in one slot");
  });
});

// ---------------------------------------------------------------- intake

describe("asset intake", () => {
  it("re-encodes PNG, JPEG and WebP as a plain PNG, in portrait, landscape and square, quiet and busy", async () => {
    const cases: Fake[] = [
      { width: 900, height: 1200, format: "png", seed: 1 },
      { width: 1600, height: 1000, format: "jpeg", busy: true, seed: 2 },
      { width: 800, height: 800, format: "webp", seed: 3 },
    ];
    for (const [i, f] of cases.entries()) {
      const file = await photoFile(await fakePhoto(f), f.format === "jpeg" ? "jpg" : f.format);
      const { assetId, manifest } = await intakeAsset(options("job-formats", file));
      const rec = manifest.assets[i];
      expect(rec.assetId).toBe(assetId);
      expect([rec.width, rec.height]).toEqual([f.width, f.height]);
      const png = await readFile(join(store, "job-formats", `${assetId}.png`));
      expect(pngChunkTypes(png).filter((t) => t !== "IDAT")).toEqual(["IHDR", "IEND"]);
    }
    const loaded = await loadManifest(store, "job-formats");
    expect(loaded?.assets.map((a) => a.sourceKind)).toEqual(["generated_concept", "generated_concept", "generated_concept"]);
  });

  it("leaves no metadata of the original file in the stored asset (EXIF, PNG text)", async () => {
    const jpeg = withJpegExif(await fakePhoto({ width: 1000, height: 800, format: "jpeg", seed: 4 }));
    const png = withPngText(await fakePhoto({ width: 800, height: 1000, format: "png", seed: 5 }));
    expect(jpeg.includes(MARKER)).toBe(true);
    expect(png.includes(MARKER)).toBe(true);
    for (const [bytes, ext] of [[jpeg, "jpg"], [png, "png"]] as const) {
      const { assetId } = await intakeAsset(options("job-metadata", await photoFile(bytes, ext)));
      const stored = await readFile(join(store, "job-metadata", `${assetId}.png`));
      expect(stored.includes(MARKER)).toBe(false);
      expect(stored.includes(Buffer.from("Exif"))).toBe(false);
      expect(pngChunkTypes(stored).filter((t) => t !== "IDAT")).toEqual(["IHDR", "IEND"]);
    }
  });

  it("scales a large photo down and refuses a small one", async () => {
    const big = await photoFile(await fakePhoto({ width: 3600, height: 2400, format: "jpeg", seed: 6 }), "jpg");
    const { manifest } = await intakeAsset(options("job-sizes", big));
    expect([manifest.assets[0].width, manifest.assets[0].height]).toEqual([2400, 1600]);
    const small = await photoFile(await fakePhoto({ width: 300, height: 600, format: "png", seed: 7 }), "png");
    expect(await refusal(intakeAsset(options("job-sizes", small)))).toBe("DIMENSIONS");
  });

  it("takes at most three photos per job and the same photo only once", async () => {
    const first = await fakePhoto({ width: 800, height: 600, format: "png", seed: 8 });
    await intakeAsset(options("job-count", await photoFile(first, "png")));
    expect(await refusal(intakeAsset(options("job-count", await photoFile(first, "png"))))).toBe("DUPLICATE");
    await intakeAsset(options("job-count", await photoFile(await fakePhoto({ width: 800, height: 600, format: "png", seed: 9 }), "png")));
    await intakeAsset(options("job-count", await photoFile(await fakePhoto({ width: 800, height: 600, format: "png", seed: 10 }), "png")));
    expect(await refusal(intakeAsset(options("job-count", await photoFile(await fakePhoto({ width: 800, height: 600, format: "png", seed: 11 }), "png"))))).toBe("COUNT");
  });

  it("refuses HEIC / HEIF, other types, files whose content is not their type, symlinks and empty files", async () => {
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic", "latin1"), Buffer.alloc(64)]);
    expect(await refusal(intakeAsset(options("job-types", await photoFile(heic, "heic"))))).toBe("TYPE_UNSUPPORTED");
    expect(await refusal(intakeAsset(options("job-types", await photoFile(heic, "jpg"))))).toBe("TYPE_UNSUPPORTED");
    expect(await refusal(intakeAsset(options("job-types", await photoFile(Buffer.from("GIF89a....."), "gif"))))).toBe("TYPE_UNSUPPORTED");
    const png = await fakePhoto({ width: 800, height: 600, format: "png", seed: 12 });
    expect(await refusal(intakeAsset(options("job-types", await photoFile(png, "jpg"))))).toBe("SIGNATURE");
    const target = await photoFile(png, "png");
    const link = join(photos, "link.png");
    await symlink(target, link);
    expect(await refusal(intakeAsset(options("job-types", link)))).toBe("SYMLINK");
    expect(await refusal(intakeAsset(options("job-types", await photoFile(Buffer.alloc(0), "png"))))).toBe("SIZE");
    expect(await refusal(intakeAsset(options("job-types", join(photos, "missing.png"))))).toBe("NOT_FILE");
  });

  it("needs a person's confirmation of no people, and a consent record for an approved photo", async () => {
    const file = await photoFile(await fakePhoto({ width: 800, height: 600, format: "png", seed: 13 }), "png");
    expect(await refusal(intakeAsset(options("job-consent", file, { peopleConfirmedNone: false })))).toBe("PEOPLE_NOT_CONFIRMED");
    expect(await refusal(intakeAsset(options("job-consent", file, { source: { ...APPROVED, scopes: [] } as IntakeSource })))).toBe("CONSENT");
    expect(await refusal(intakeAsset(options("job-consent", file, { source: { ...APPROVED, approvedBy: "" } as IntakeSource })))).toBe("CONSENT");
    expect(await refusal(intakeAsset(options("job-consent", file, { source: { ...APPROVED, consentId: "x" } as IntakeSource })))).toBe("CONSENT");
    const { manifest } = await intakeAsset(options("job-consent", file, { source: APPROVED }));
    expect(manifest.assets[0]).toMatchObject({ sourceKind: "approved_real", consent: { scopes: ["local_preview"] } });
    expect(await refusal(intakeAsset(options("bad/../id", file)))).toBe("JOB_ID");
  });

  it("never takes a reference screenshot: capture results, worker temp roots, preview output", async () => {
    const png = await fakePhoto({ width: 800, height: 600, format: "png", seed: 14 });
    const workerTemp = join(env.TMPDIR, "sr-design-worker-Ab12Cd");
    const codexTemp = join(env.TMPDIR, "sr-design-codex-Xy34Zw");
    const preview = join(base, "preview-out");
    const defaultOut = join(env.HOME, ".local", "share", "second-root-design", "run-1");
    for (const dir of [workerTemp, codexTemp, preview, defaultOut]) await mkdir(dir, { recursive: true });
    const withPreview = { ...env, SR_DESIGN_PREVIEW_ROOT: preview };
    for (const dir of [workerTemp, codexTemp, preview, defaultOut]) {
      const file = await photoFile(png, "png", dir);
      expect(await refusal(intakeAsset(options("job-reference", file, { env: withPreview }))), dir).toBe("SOURCE_REFERENCE");
    }
    expect(isReferenceLocation("/srv/sr-capture/results/req-1/reference-0.png", env)).toBe(true);
    expect(isReferenceLocation("/home/sr-igcapture/anything.png", env)).toBe(true);
    expect(isReferenceLocation(join(photos, "photo.png"), env)).toBe(false);
  });

  it("keeps the store out of the repository, temp directories and reference locations", () => {
    expect(checkStoreRoot(store, { repoDir: REPO, env })).toBe(true);
    expect(checkStoreRoot(join(REPO, "public", "assets"), { repoDir: REPO, env })).toBe(false);
    expect(checkStoreRoot("/", { repoDir: REPO, env })).toBe(false);
    expect(checkStoreRoot(join(env.TMPDIR, "store"), { repoDir: REPO, env })).toBe(false);
    expect(checkStoreRoot("/srv/sr-capture/assets", { repoDir: REPO, env })).toBe(false);
    expect(checkStoreRoot(join(env.HOME, ".local", "share", "second-root-design"), { repoDir: REPO, env })).toBe(false);
    expect(checkStoreRoot("relative/store", { repoDir: REPO, env })).toBe(false);
    expect(assetStoreRoot({ HOME: "/home/x" })).toBe("/home/x/.local/share/second-root-design-assets");
    expect(assetStoreRoot({ HOME: "/home/x", SR_DESIGN_ASSETS_ROOT: "rel" })).toBe("/home/x/.local/share/second-root-design-assets");
  });

  it("refuses to write into a store inside the repository, also through a link, and a broken manifest", async () => {
    const file = await photoFile(await fakePhoto({ width: 800, height: 600, format: "png", seed: 15 }), "png");
    expect(await refusal(intakeAsset(options("job-store", file, { storeRoot: join(REPO, "tmp-assets") })))).toBe("STORE_UNSAFE");
    const linkedRepoDir = join(base, "repo-target");
    await mkdir(linkedRepoDir, { recursive: true });
    const linkedStore = join(base, "store-link");
    await symlink(linkedRepoDir, linkedStore);
    expect(await refusal(intakeAsset(options("job-store", file, { storeRoot: linkedStore, repoDir: linkedRepoDir })))).toBe("STORE_UNSAFE");
    expect(await readdir(linkedRepoDir)).toEqual([]);
    await mkdir(join(store, "job-broken"), { recursive: true, mode: 0o700 });
    await writeFile(join(store, "job-broken", "manifest.json"), "{not json", { mode: 0o600 });
    expect(await refusal(intakeAsset(options("job-broken", file)))).toBe("MANIFEST_INVALID");
    expect(await loadManifest(store, "job-broken")).toBeNull();
  });
});
