/**
 * DEV-158 (Issue #193 comments 6584276254 / 6591440695): Claude's own viewing of a success-case picture, and the gate
 * that decides which of three modes a case is in:
 *
 *   VISUAL_VERIFIED        Claude opened the exact picture (bytes and pixel size match the record), the crops it viewed
 *                          cover the picture, and a located observation of it passes (`checkObservation`).
 *   TEXT_ONLY_PROVISIONAL  only text about the picture: another AI's viewing summary, a case note, a manifest.
 *   MISSING_OR_HOLD        neither: no picture Claude can open and no text either.
 *
 * What a machine can and cannot check: it cannot see into the model. It can tie the record to the exact bytes and
 * size of a file it can hash now, require that the viewed crops cover the whole picture, and require located
 * observations spread over it (a description written without the picture rarely places boxes on the real layout,
 * and a reviewer opening the same file can check every box). A summary, a file name or a SHA alone never passes.
 *
 * Pure: zod and observation.ts. The caller reads files and hashes.
 */
import { z } from "zod";
import { checkObservation, ReferenceObservation } from "./observation";

const Box = z.strictObject({ x: z.number().int().min(0), y: z.number().int().min(0), w: z.number().int().min(1), h: z.number().int().min(1) });

export const VISUAL_MODES = ["VISUAL_VERIFIED", "TEXT_ONLY_PROVISIONAL", "MISSING_OR_HOLD"] as const;
export type VisualMode = (typeof VISUAL_MODES)[number];

export const ClaudeVisualRead = z.strictObject({
  schema: z.literal("claude_visual_read_v1"),
  case_id: z.string().regex(/^CP-\d{3}$/),
  view: z.enum(["desktop", "mobile", "concept"]),
  asset: z.strictObject({
    /** A path in the repository (a registered preview), or a private reference to a git-ignored intake file. */
    path: z.string().regex(/^(design-library\/success-cases\/assets\/[A-Za-z0-9._-]+\.(webp|png)|intake:(?![^]*\.\.)[A-Za-z0-9._\/-]+\.(webp|png))$/),
    kind: z.enum(["original", "registered_preview"]),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    width: z.number().int().min(1).max(20000),
    height: z.number().int().min(1).max(40000),
    /** Whether this SHA is one the inventory records for this case, view and kind (the gate checks it again). */
    recorded_in_manifest: z.boolean(),
  }),
  reader: z.strictObject({
    who: z.literal("claude"),
    /** The session that opened the picture (a URL); never a model name. */
    session: z.string().url(),
    viewed_at: z.string().datetime({ offset: true }),
    /** How the picture reached the model, e.g. "Read tool on PNG crops converted from the WebP". */
    how: z.string().min(1).max(300),
  }),
  actually_viewed: z.literal(true),
  /** The parts of the picture the model was shown, in the picture's pixels. Together they must cover it. */
  viewed_crops: z.array(Box).min(1).max(40),
  observation: ReferenceObservation,
});
export type ClaudeVisualRead = z.infer<typeof ClaudeVisualRead>;

/**
 * The file as the caller finds it now: its bytes' SHA and pixel size; `unreadable` when it is there but is not a
 * picture whose size can be read (it still has a SHA when it is a file); null only when it is absent.
 */
export type AssetNow = { sha256: string; width: number; height: number } | { unreadable: true; sha256: string | null } | null;

export type ReadCheck = { ok: true } | { ok: false; codes: string[] };

/**
 * Share of the picture's area covered by the crops, on a 4-pixel grid. A cell counts only when a crop covers it
 * whole (the last partial cell at the picture's edge counts when a crop reaches the edge), so crop edges never
 * round coverage up.
 */
export function coverage(crops: ReadonlyArray<{ x: number; y: number; w: number; h: number }>, width: number, height: number): number {
  const G = 4;
  const [gw, gh] = [Math.ceil(width / G), Math.ceil(height / G)];
  const cells = new Uint8Array(gw * gh);
  const span = (a: number, len: number, size: number, n: number) => [Math.ceil(a / G), a + len >= size ? n : Math.floor((a + len) / G)] as const;
  for (const c of crops) {
    const [y0, y1] = span(c.y, c.h, height, gh);
    const [x0, x1] = span(c.x, c.w, width, gw);
    for (let gy = y0; gy < Math.min(y1, gh); gy++) for (let gx = x0; gx < Math.min(x1, gw); gx++) cells[gy * gw + gx] = 1;
  }
  return cells.reduce((s, v) => s + v, 0) / cells.length;
}

export const READ_THRESHOLDS = { coverage: 0.98, min_items: 8, min_bands: 3 } as const;

/** One picture the inventory records for a case (originals-inventory.json `originals[]`). */
export type InventoryPicture = { sha256: string; kind: string; view: string; in_repo_path: string | null };

/**
 * A viewing record against the file it names (as found now) and the pictures the inventory records for its case.
 * The record must match exactly one recorded picture of the same view and kind: a registered preview at its
 * registered path, an original only through the private `intake:` folder (never a repository path).
 */
export function checkVisualRead(raw: unknown, now: AssetNow, o: { pictures: readonly InventoryPicture[] }): ReadCheck {
  const parsed = ClaudeVisualRead.safeParse(raw);
  if (!parsed.success) return { ok: false, codes: ["READ_SCHEMA"] };
  const r = parsed.data;
  const codes: string[] = [];
  if (!now) codes.push("ASSET_NOT_AVAILABLE");
  else if ("unreadable" in now) {
    codes.push("ASSET_UNREADABLE");
    if (now.sha256 !== r.asset.sha256) codes.push("ASSET_SHA_MISMATCH");
  } else {
    if (now.sha256 !== r.asset.sha256) codes.push("ASSET_SHA_MISMATCH");
    if (now.width !== r.asset.width || now.height !== r.asset.height) codes.push("ASSET_SIZE_MISMATCH");
  }
  const intake = r.asset.path.startsWith("intake:");
  if (r.asset.kind === "original" && !intake) codes.push("ORIGINAL_OUTSIDE_INTAKE");
  if (r.asset.kind === "registered_preview" && intake) codes.push("PREVIEW_IN_INTAKE");
  const match = o.pictures.filter((p) => p.sha256 === r.asset.sha256);
  const exact = match.filter((p) => p.kind === r.asset.kind && p.view === r.view && (r.asset.kind === "original" || p.in_repo_path === r.asset.path));
  if (exact.length !== 1) codes.push(match.length ? "PICTURE_KIND_VIEW_OR_PATH_MISMATCH" : "PICTURE_NOT_RECORDED_FOR_CASE");
  if (r.asset.recorded_in_manifest !== match.length > 0) codes.push("MANIFEST_CLAIM_WRONG");
  if (coverage(r.viewed_crops, r.asset.width, r.asset.height) < READ_THRESHOLDS.coverage) codes.push("CROPS_DO_NOT_COVER");
  if (r.viewed_crops.some((c) => c.x + c.w > r.asset.width || c.y + c.h > r.asset.height)) codes.push("CROP_OUTSIDE");
  const obs = checkObservation(r.observation, { case_id: r.case_id, image_sha256: r.asset.sha256, view: r.view, width: r.asset.width, height: r.asset.height });
  if (!obs.ok) codes.push(...obs.codes);
  const items = Object.values(r.observation.observed).flat();
  if (items.length < READ_THRESHOLDS.min_items) codes.push("TOO_FEW_LOCATED_OBSERVATIONS");
  // the boxes must be spread over the picture (top, middle, bottom thirds), not all on the first screen
  const bands = new Set(items.map((s) => Math.min(2, Math.floor(((s.box.y + s.box.h / 2) / r.asset.height) * 3))));
  if (bands.size < READ_THRESHOLDS.min_bands) codes.push("OBSERVATIONS_NOT_SPREAD");
  return codes.length ? { ok: false, codes } : { ok: true };
}

export type CaseText = { chatgpt_viewed: boolean; case_note: boolean };

/**
 * The mode of one view of a case. Only a passing viewing record of that view makes it VISUAL_VERIFIED; text of any
 * kind (another AI's viewing summary included) is TEXT_ONLY_PROVISIONAL; nothing is MISSING_OR_HOLD.
 */
export function visualMode(passingReads: number, text: CaseText): VisualMode {
  if (passingReads > 0) return "VISUAL_VERIFIED";
  if (text.chatgpt_viewed || text.case_note) return "TEXT_ONLY_PROVISIONAL";
  return "MISSING_OR_HOLD";
}

/** Pixel size from a PNG or WebP header (no decoding). Null for anything else or a truncated header. */
export function imageSize(b: Uint8Array): { width: number; height: number } | null {
  const u32be = (o: number) => ((b[o]! << 24) >>> 0) + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!;
  const tag = (o: number) => String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);
  if (b.length >= 24 && b[0] === 0x89 && tag(1) === "PNG\r" && tag(12) === "IHDR") return { width: u32be(16), height: u32be(20) };
  if (b.length >= 30 && tag(0) === "RIFF" && tag(8) === "WEBP") {
    const kind = tag(12);
    if (kind === "VP8X") return { width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) };
    if (kind === "VP8 " && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return { width: (b[26]! | (b[27]! << 8)) & 0x3fff, height: (b[28]! | (b[29]! << 8)) & 0x3fff };
    if (kind === "VP8L" && b[20] === 0x2f) {
      const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}
