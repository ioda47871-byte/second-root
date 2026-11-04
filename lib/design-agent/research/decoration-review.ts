/**
 * DEV-174 (Issue #193 comment 6628165899, the owner's follow-up plan) — RESEARCH ONLY, NOT ENABLED.
 *
 * The per-asset owner visual review record that N1 (a decorative SVG shown only through `<img>`) would need before any
 * asset could be used, and the check that refuses an asset without a matching record. It extends DEV-165's
 * OwnerVisualReview (decoration-svg.ts, five keys, bound to the file's sha256) with what that record could not say:
 * - WHAT the owner looked at: the sha256 of a preview PNG rendered from exactly those bytes (renderN1Preview: the asset
 *   through `<img>` at its recorded size on white, JS off, network refused), and the renderer that drew it. A different
 *   renderer (another Chromium build) or a different picture voids the record: the owner has to look again.
 * - a `pending` state: the only state an agent may write (pendingN1Review). A pending record is refused like a missing one.
 * - an attestation hook: an `approved` record passes only when a verifier proves it came from the owner. HOW that is
 *   proven is an OPEN OWNER DECISION (docs/design/n1-implementation-prep.md §5); no verifier exists, so the default
 *   (NO_ATTESTATION) refuses every approved record with N1_REVIEW_UNATTESTED. Today no record can pass.
 *
 * Claude (or any agent, worker or script) never writes `approved` or `rejected`, never fills `reviewed_at`, never copies
 * an owner's chat words into a record. Records in the repository are `pending` only, and today there are none (pinned
 * by tests/unit/design-agent/research/n1-owner-review.test.ts). Nothing in a lane imports this module.
 */
import { createHash } from "node:crypto";
import type { Browser } from "playwright";
import { checkDecorationSvg, decorationAssetFileProblems, DECORATION_FILE, DECORATION_ID, reviewDateOk, type DecorationAsset } from "./decoration-svg";

export const N1_REVIEW_SCHEMA = "second-root/n1-owner-visual-review@2";
export const N1_REVIEW_KEYS = ["asset_file", "asset_id", "asset_sha256", "decision", "note", "preview", "reviewed_at", "reviewer", "schema"] as const;
export const N1_PREVIEW_KEYS = ["background", "height", "renderer", "scale", "sha256", "width"] as const;
export const N1_REVIEW_NOTE_MAX = 500;
/** The preview's fixed drawing conditions (the owner sees the asset at its recorded size, at 2 device pixels per css px, on white). */
export const N1_PREVIEW_SCALE = 2;
export const N1_PREVIEW_BACKGROUND = "#ffffff";

export type N1Preview = { sha256: string; renderer: string; width: number; height: number; scale: typeof N1_PREVIEW_SCALE; background: typeof N1_PREVIEW_BACKGROUND };
export type N1Decision = "pending" | "approved" | "rejected";
export type N1OwnerReview = {
  schema: typeof N1_REVIEW_SCHEMA;
  asset_id: string;
  asset_file: string;
  asset_sha256: string;
  preview: N1Preview;
  /** Who must review: always the owner. Not a claim that the owner did (that is `decision` + the attestation). */
  reviewer: "owner";
  decision: N1Decision;
  /** null while pending; an ISO date once the owner decided. */
  reviewed_at: string | null;
  note: string;
};
/** An N1 asset record: DEV-165's asset shape without its embedded review (the record above is kept apart from it). */
export type N1Asset = Omit<DecorationAsset, "owner_visual_review">;

/**
 * Proof that an approved record came from the owner. OPEN OWNER DECISION: there is none. A verifier gets the record and
 * answers; it must not trust anything inside the record (every field is a claim).
 */
export type N1Attestation = (record: Readonly<N1OwnerReview>) => boolean;
export const NO_ATTESTATION: N1Attestation = () => false;

/** What the record is checked against: the asset as recorded, the bytes as read, the preview as rendered now. */
export type N1ReviewBinding = {
  assetId: string;
  assetFile: string;
  /** sha256 of the bytes read (null: not read, so the record cannot be bound). */
  assetSha256: string | null;
  /** The preview rendered now from those bytes (null: not rendered, so the record cannot be bound). */
  preview: Pick<N1Preview, "sha256" | "renderer" | "width" | "height"> | null;
};

const HEX64 = /^[0-9a-f]{64}$/;
const sameKeys = (o: Record<string, unknown>, keys: readonly string[]) => {
  const k = Object.keys(o).sort();
  return k.length === keys.length && k.every((x, i) => x === keys[i]);
};
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The record an agent may write for an asset: `pending`, no date, empty note, bound to the asset's bytes and to the
 * preview it rendered. It is a request for the owner's review, never a review.
 */
export function pendingN1Review(asset: Pick<N1Asset, "id" | "file">, assetSha256: string, preview: N1Preview): N1OwnerReview {
  return { schema: N1_REVIEW_SCHEMA, asset_id: asset.id, asset_file: asset.file, asset_sha256: assetSha256, preview: { ...preview }, reviewer: "owner", decision: "pending", reviewed_at: null, note: "" };
}

/**
 * The record against its binding. Codes: N1_REVIEW_MISSING (no object), N1_REVIEW_SHAPE (keys other than exactly the
 * nine), N1_REVIEW_SCHEMA, N1_REVIEW_ASSET (another asset's id or file), N1_REVIEW_ASSET_SHA256 (not the bytes read, or
 * nothing read), N1_REVIEW_PREVIEW_SHAPE (preview keys, scale or background), N1_REVIEW_PREVIEW_SHA256 (not the picture
 * rendered now, or nothing rendered), N1_REVIEW_PREVIEW_RENDERER (drawn by another renderer: look again),
 * N1_REVIEW_PREVIEW_SIZE (not the size rendered now), N1_REVIEW_REVIEWER (not "owner"), N1_REVIEW_PENDING,
 * N1_REVIEW_REJECTED, N1_REVIEW_DECISION (none of the three), N1_REVIEW_DATE (pending with a date, or a decision without a
 * real, past date), N1_REVIEW_NOTE (not a string of at most 500), N1_REVIEW_UNATTESTED (approved, and no verifier proves
 * it came from the owner — the default). Never throws. An empty list means the record passes.
 */
export function n1ReviewProblems(record: unknown, bound: N1ReviewBinding, o: { now?: Date; attest?: N1Attestation } = {}): string[] {
  try {
    if (!isObject(record)) return ["N1_REVIEW_MISSING"];
    const r = record;
    const p: string[] = [];
    if (!sameKeys(r, N1_REVIEW_KEYS)) p.push("N1_REVIEW_SHAPE");
    if (r.schema !== N1_REVIEW_SCHEMA) p.push("N1_REVIEW_SCHEMA");
    if (r.asset_id !== bound.assetId || r.asset_file !== bound.assetFile || !DECORATION_ID.test(String(r.asset_id)) || !DECORATION_FILE.test(String(r.asset_file))) p.push("N1_REVIEW_ASSET");
    if (typeof r.asset_sha256 !== "string" || !HEX64.test(r.asset_sha256) || bound.assetSha256 === null || r.asset_sha256 !== bound.assetSha256) p.push("N1_REVIEW_ASSET_SHA256");
    const pv = r.preview;
    if (!isObject(pv) || !sameKeys(pv, N1_PREVIEW_KEYS) || pv.scale !== N1_PREVIEW_SCALE || pv.background !== N1_PREVIEW_BACKGROUND) p.push("N1_REVIEW_PREVIEW_SHAPE");
    const pvo = isObject(pv) ? pv : {};
    if (typeof pvo.sha256 !== "string" || !HEX64.test(pvo.sha256) || bound.preview === null || pvo.sha256 !== bound.preview.sha256) p.push("N1_REVIEW_PREVIEW_SHA256");
    if (bound.preview === null || typeof pvo.renderer !== "string" || pvo.renderer !== bound.preview.renderer) p.push("N1_REVIEW_PREVIEW_RENDERER");
    if (bound.preview === null || pvo.width !== bound.preview.width || pvo.height !== bound.preview.height) p.push("N1_REVIEW_PREVIEW_SIZE");
    if (r.reviewer !== "owner") p.push("N1_REVIEW_REVIEWER");
    const decision = r.decision;
    if (decision === "pending") {
      p.push("N1_REVIEW_PENDING");
      if (r.reviewed_at !== null) p.push("N1_REVIEW_DATE");
    } else if (decision === "approved" || decision === "rejected") {
      if (decision === "rejected") p.push("N1_REVIEW_REJECTED");
      if (!reviewDateOk(r.reviewed_at, o.now ?? new Date())) p.push("N1_REVIEW_DATE");
    } else p.push("N1_REVIEW_DECISION");
    if (typeof r.note !== "string" || r.note.length > N1_REVIEW_NOTE_MAX) p.push("N1_REVIEW_NOTE");
    // the attestation is asked only of an otherwise clean approved record, and a verifier that throws attests nothing
    if (decision === "approved" && p.length === 0) {
      let ok = false;
      try {
        ok = (o.attest ?? NO_ATTESTATION)(r as N1OwnerReview) === true;
      } catch {
        ok = false;
      }
      if (!ok) p.push("N1_REVIEW_UNATTESTED");
    }
    return p;
  } catch {
    return ["N1_REVIEW_MISSING"];
  }
}

/**
 * One N1 asset as a whole: the file side of DEV-162 / DEV-165 (name, no symlink or hardlink, inside `dir`, bytes, sha256,
 * size, dimensions, the strict SVG check) and its owner record bound to the bytes read and to `preview` (the preview
 * rendered now from the same bytes; null when it was not rendered). The asset passes only when both are clean. Never throws.
 */
export function checkN1Asset(dir: string, asset: N1Asset, record: unknown, o: { preview: N1ReviewBinding["preview"]; now?: Date; attest?: N1Attestation }): string[] {
  let file: { problems: string[]; sha256: string | null };
  try {
    file = decorationAssetFileProblems(dir, asset);
  } catch {
    file = { problems: ["ASSET_CHECK_ERROR"], sha256: null };
  }
  let id = "";
  let name = "";
  try {
    id = typeof asset?.id === "string" ? asset.id : "";
    name = typeof asset?.file === "string" ? asset.file : "";
  } catch {
    // a hostile asset record: the binding stays empty and the record cannot match it
  }
  return [...new Set([...file.problems, ...n1ReviewProblems(record, { assetId: id, assetFile: name, assetSha256: file.sha256, preview: o.preview }, o)])];
}

export const N1_PREVIEW_ORIGIN = "http://n1-preview.invalid";

export type N1PreviewRender = { problems: string[]; preview: N1Preview | null; png: Buffer | null; unexpected: string[] };

/**
 * Renders the preview the owner looks at: the bytes (they must pass checkDecorationSvg, or nothing is drawn) as the one
 * `<img>` of a blank page at exactly `width` × `height` css px, scale 2, on white, JavaScript off, service workers
 * blocked, every request but the page and the asset aborted (N1_PREVIEW_UNEXPECTED_REQUEST). The sha256 is of the PNG
 * Chromium returns. Codes: the SVG checker's, N1_PREVIEW_SIZE (the size is not the file's own), N1_PREVIEW_UNEXPECTED_REQUEST,
 * N1_PREVIEW_ERROR. Never throws.
 */
export async function renderN1Preview(browser: Browser, bytes: Uint8Array, width: number, height: number): Promise<N1PreviewRender> {
  const c = checkDecorationSvg(bytes);
  if (!c.ok) return { problems: [...new Set(c.findings.map((f) => f.code))], preview: null, png: null, unexpected: [] };
  if (c.width !== width || c.height !== height) return { problems: ["N1_PREVIEW_SIZE"], preview: null, png: null, unexpected: [] };
  const page = `${N1_PREVIEW_ORIGIN}/preview/index.html`;
  const svg = `${N1_PREVIEW_ORIGIN}/preview/asset.svg`;
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:${N1_PREVIEW_BACKGROUND}"><img src="asset.svg" alt="" aria-hidden="true" referrerpolicy="no-referrer" style="display:block;width:${width}px;height:${height}px"></body></html>`;
  const unexpected: string[] = [];
  let ctx;
  try {
    ctx = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: "block", viewport: { width, height }, deviceScaleFactor: N1_PREVIEW_SCALE });
    const tab = await ctx.newPage();
    await tab.route("**/*", (route) => {
      const url = route.request().url();
      if (url === page) return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html });
      if (url === svg) return route.fulfill({ status: 200, contentType: "image/svg+xml", body: Buffer.from(bytes) });
      if (url !== `${N1_PREVIEW_ORIGIN}/favicon.ico`) unexpected.push(url);
      return route.abort("blockedbyclient");
    });
    await tab.goto(page, { waitUntil: "load" });
    const png = await tab.screenshot({ clip: { x: 0, y: 0, width, height }, animations: "disabled", omitBackground: false });
    const problems = unexpected.length ? ["N1_PREVIEW_UNEXPECTED_REQUEST"] : [];
    const preview: N1Preview = {
      sha256: createHash("sha256").update(png).digest("hex"),
      renderer: `${browser.browserType().name()}/${browser.version()}`,
      width,
      height,
      scale: N1_PREVIEW_SCALE,
      background: N1_PREVIEW_BACKGROUND,
    };
    return { problems, preview: problems.length ? null : preview, png: problems.length ? null : png, unexpected: [...new Set(unexpected)] };
  } catch {
    return { problems: ["N1_PREVIEW_ERROR"], preview: null, png: null, unexpected: [...new Set(unexpected)] };
  } finally {
    await ctx?.close().catch(() => undefined);
  }
}
