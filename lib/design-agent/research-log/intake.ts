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
import { LogStop } from "./store";
import { Sha, Slug, type ResearchEntry } from "./schema";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

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
  inbox: string;
  bundleId: string;
  shop: string;
  direction: string;
  iteration: number;
  parentEntryId: string | null;
  now: string;
};

/** Builds (does not write) the entry. Throws LogStop with a fixed code on any disagreement. */
export async function entryFromInbox(o: IntakeInput): Promise<ResearchEntry> {
  if (!Slug.safeParse(o.bundleId).success) throw new LogStop("INTAKE_ID_INVALID", o.bundleId);
  const dir = join(o.inbox, "previews", o.bundleId);
  const indexBytes = await readFile(join(dir, "INDEX.json")).catch(() => {
    throw new LogStop("INTAKE_NO_PREVIEWS", `${dir}/INDEX.json is missing`);
  });
  const idx = PreviewIndex.safeParse(JSON.parse(indexBytes.toString("utf8")));
  if (!idx.success) throw new LogStop("INTAKE_INDEX_INVALID", "INDEX.json does not match imagefirst_review_previews_v1");
  if (idx.data.bundle_id !== o.bundleId) throw new LogStop("INTAKE_INDEX_INVALID", "INDEX.json names another bundle");

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
    const a = AuditRecord.safeParse(JSON.parse(auditBytes.toString("utf8")));
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
