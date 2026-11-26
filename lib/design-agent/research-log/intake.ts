/**
 * Issue #302 P5: turn one delivered IMAGE_FIRST run in the private review inbox into a research-log entry.
 *
 * Reads only the inbox's own derived files (previews/<id>/INDEX.json, the preview PNGs, audits/<id>/audit.json) and checks
 * them against each other before recording anything: every preview's bytes against INDEX.json, and the audit's binding
 * (bundle SHA, previews index SHA, approval and plan IDs) against the same index. A mismatch stops with a code; nothing is
 * repaired. Copies no picture and no findings text into the log: SHA-256s, IDs and scores only.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { assertFictionalShop } from "./shops";
import { LogStop } from "./store";
import { Sha, Slug, type ResearchEntry } from "./schema";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const parseJson = (b: Buffer, code: string, what: string): unknown => {
  try {
    return JSON.parse(b.toString("utf8"));
  } catch {
    throw new LogStop(code, `${what} is not JSON`);
  }
};

const PreviewIndex = z.object({
  schema: z.literal("imagefirst_review_previews_v1"),
  bundle_id: Slug,
  bundle_sha256: Sha,
  approval_id: Slug,
  plan_id: Slug,
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  previews: z.array(z.object({ file: z.string(), source: z.string(), source_sha256: Sha, preview_sha256: Sha, width: z.number().int(), height: z.number().int() })).min(2),
});

const ViewportDerived = z.object({ total: z.number().int(), lowest: z.number().int(), verdict: z.string(), low_criteria: z.array(z.string()) });
const AuditRecord = z.object({
  schema: z.string(),
  status: z.literal("completed"),
  binding: z.object({ approval_id: Slug, bundle_sha256: Sha, plan_id: Slug, previews_index_sha256: Sha, rubric_version: z.string(), rubric_sha256: Sha }),
  derived: z.object({ desktop_1440: ViewportDerived, mobile_390: ViewportDerived, verdict: z.string() }),
  advisory_only: z.literal(true),
  human_confirmed: z.literal(false),
});

export type IntakeInput = {
  /** The repository whose facts packs decide which shops are fictional (shops.ts). */
  repo: string;
  inbox: string;
  bundleId: string;
  shop: string;
  direction: string;
  iteration: number;
  parentEntryId: string | null;
  now: string;
};

/** A fixed IMAGE_FIRST approval id's form (`<shop>-imagefirst-<direction>-YYYYMMDD-NN`); anything else is a request run. */
const APPROVAL_RUN_ID = /^[a-z0-9][a-z0-9-]{1,40}-imagefirst-d\d{1,2}-\d{8}-\d{2}$/;
const RequestManifest = z.object({ bundle_id: Slug, mode: z.literal("request"), kind: z.enum(["real_shop", "fictional"]), shop: z.string(), image_material: z.literal(true).optional(), synthetic: z.literal(true).optional() });

/**
 * DEV-303: a request-mode run (its bundle id is the request id) is logged only when its sealed bundle in the inbox says it
 * is a FICTIONAL shop's, and the same shop as `--shop`. A real shop's run never enters the committed log (its private
 * record is ~/second-root-shops/<shop_id>/runs/<id>.json, written by the worker): REAL_SHOP_NOT_LOGGED.
 */
async function assertLoggableRun(o: IntakeInput): Promise<void> {
  if (APPROVAL_RUN_ID.test(o.bundleId)) return;
  const bytes = await readFile(join(o.inbox, o.bundleId, "manifest.json")).catch(() => {
    throw new LogStop("INTAKE_MANIFEST_MISSING", `${o.bundleId}/manifest.json is missing (a request run is logged from its sealed bundle)`);
  });
  const m = RequestManifest.safeParse(parseJson(bytes, "INTAKE_MANIFEST_INVALID", "manifest.json"));
  if (!m.success || m.data.bundle_id !== o.bundleId) throw new LogStop("INTAKE_MANIFEST_INVALID", "manifest.json is not this request run's bundle");
  if (m.data.kind !== "fictional") throw new LogStop("REAL_SHOP_NOT_LOGGED", "a real shop's run is recorded privately, never in the research log");
  // DEV-303 (owner goal 2026-11-26): a synthetic rehearsal bundle (imagefirst-worker/rehearsal.ts) is not a design result
  if (m.data.synthetic === true) throw new LogStop("SYNTHETIC_NOT_LOGGED", "a synthetic rehearsal bundle is not a generated design");
  // DEV-303 (owner decision 2026-11-24): photo materials are not a design comp; they are never logged as one
  if (m.data.image_material === true) throw new LogStop("PHOTO_MATERIALS_NOT_LOGGED", "a photo-materials bundle is not a design comp");
  if (m.data.shop !== o.shop) throw new LogStop("INTAKE_SHOP_MISMATCH", `the bundle is ${m.data.shop}'s, not ${o.shop}'s`);
}

/** Builds (does not write) the entry. Throws LogStop with a fixed code on any disagreement. */
export async function entryFromInbox(o: IntakeInput): Promise<ResearchEntry> {
  if (!Slug.safeParse(o.bundleId).success) throw new LogStop("INTAKE_ID_INVALID", o.bundleId);
  await assertFictionalShop(o.repo, o.shop);
  const dir = join(o.inbox, "previews", o.bundleId);
  const indexBytes = await readFile(join(dir, "INDEX.json")).catch(() => {
    throw new LogStop("INTAKE_NO_PREVIEWS", `${dir}/INDEX.json is missing`);
  });
  const idx = PreviewIndex.safeParse(parseJson(indexBytes, "INTAKE_INDEX_INVALID", "INDEX.json"));
  if (!idx.success) throw new LogStop("INTAKE_INDEX_INVALID", "INDEX.json does not match imagefirst_review_previews_v1");
  if (idx.data.bundle_id !== o.bundleId) throw new LogStop("INTAKE_INDEX_INVALID", "INDEX.json names another bundle");
  await assertLoggableRun(o);

  const previews: ResearchEntry["provenance"]["previews"] = [];
  for (const p of idx.data.previews) {
    if (!/^[a-z0-9-]+\.png$/.test(p.file)) throw new LogStop("INTAKE_INDEX_INVALID", `unexpected preview name ${p.file}`);
    const bytes = await readFile(join(dir, p.file)).catch(() => {
      throw new LogStop("INTAKE_PREVIEW_MISSING", p.file);
    });
    if (sha(bytes) !== p.preview_sha256) throw new LogStop("INTAKE_PREVIEW_MISMATCH", `${p.file} does not match INDEX.json`);
    const viewport = p.file.startsWith("pc-") ? "desktop_1440" : p.file.startsWith("sp-") ? "mobile_390" : null;
    if (!viewport) throw new LogStop("INTAKE_INDEX_INVALID", `${p.file} is neither pc- nor sp-`);
    previews.push({ file: p.file, viewport, source: p.source, source_sha256: p.source_sha256, preview_sha256: p.preview_sha256, width: p.width, height: p.height });
  }
  if (!previews.some((p) => p.viewport === "desktop_1440") || !previews.some((p) => p.viewport === "mobile_390")) throw new LogStop("INTAKE_VIEWPORT_MISSING", "both PC and SP previews are required");

  const indexSha = sha(indexBytes);
  let audit: ResearchEntry["audit"] = null;
  const auditBytes = await readFile(join(o.inbox, "audits", o.bundleId, "audit.json")).catch(() => null);
  if (auditBytes) {
    const a = AuditRecord.safeParse(parseJson(auditBytes, "INTAKE_AUDIT_INVALID", "audit.json"));
    if (!a.success) throw new LogStop("INTAKE_AUDIT_INVALID", "audit.json is not a completed advisory audit");
    const b = a.data.binding;
    if (b.bundle_sha256 !== idx.data.bundle_sha256 || b.previews_index_sha256 !== indexSha || b.approval_id !== idx.data.approval_id || b.plan_id !== idx.data.plan_id) {
      throw new LogStop("INTAKE_AUDIT_BINDING", "audit.json was made for other bytes than these previews");
    }
    const vp = (v: z.infer<typeof ViewportDerived>) => ({ total: v.total, lowest: v.lowest, verdict: v.verdict, low_criteria: v.low_criteria });
    audit = {
      schema: a.data.schema,
      rubric_version: b.rubric_version,
      rubric_sha256: b.rubric_sha256,
      audit_json_sha256: sha(auditBytes),
      advisory_only: true,
      verdict: a.data.derived.verdict,
      viewports: { desktop_1440: vp(a.data.derived.desktop_1440), mobile_390: vp(a.data.derived.mobile_390) },
    };
  }

  return {
    schema: "design_research_entry_v1",
    entry_id: o.bundleId,
    shop: o.shop,
    fictional: true,
    direction: o.direction,
    iteration: o.iteration,
    parent_entry_id: o.parentEntryId,
    provenance: { approval_id: idx.data.approval_id, plan_id: idx.data.plan_id, commit: idx.data.commit, bundle_sha256: idx.data.bundle_sha256, previews_index_sha256: indexSha, previews },
    audit,
    recorded_at: o.now,
  };
}
