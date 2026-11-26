/**
 * DEV-364 PR 2a (docs/design/quality-proof-plan.md §2.2, §3.2): the provenance of every picture a shop page shows,
 * in three classes that never mix. Offline and fictional only.
 *
 *   A  generated   AI-generated proposal material. Its record: the material id, the approved SHA-256 and the
 *                  materials approval it came from (the handover record content/generated-materials.json lists the
 *                  delivered files). The page shows 「イメージ」 (figure / figcaption). Checked by the existing
 *                  materials-impl-check (exact bytes) — not changed here.
 *   B  shop_provided  a real photo the shop provided, with confirmed permission. Its full record
 *                  (sr_photo_provenance_v1, class B: who provided it — a role, never a person's name —, the source,
 *                  the permission's scope, date and confirming role, the facts check, the SHA-256) is kept OUTSIDE the
 *                  shop repository (plan §3.2: 保存はリポジトリの外), one file per picture named <sha256>.json. The shop
 *                  repository keeps only an index, content/photo-provenance.json (sr_photo_provenance_index_v1: each
 *                  B picture's SHA-256 and the SHA-256 of its private record), written at delivery and not in
 *                  .pages.yml, so the customer's own build (which cannot see the private folder) still knows the
 *                  picture is B. The build stops when a B picture is not in the index; Second Root's build, which is
 *                  given the private folder, also checks the full record against the index
 *                  (CONTENT_PHOTO_RIGHTS_MISSING either way). No イメージ label.
 *   C  customer_cms  a photo the customer uploaded or chose in Pages CMS after the contract (uploaded_via
 *                  pages_cms). No per-update owner approval: the automatic checks only (photos.ts limits; Q1); the
 *                  build writes its record from those check results. No イメージ label. Chosen explicitly only.
 *
 * Second Root places A or B, never C. A picture whose SHA-256 is in the handover record of generated materials is
 * refused when marked B or C (CONTENT_GENERATED_AS_SHOP; exact bytes only — a converted copy is not caught, a known
 * limit). The transform / pairing record (sr_photo_transform_v1) is a later PR.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ContentError } from "./content-model";

export const PROVENANCE_SCHEMA = "sr_photo_provenance_v1";
const SHA = z.string().regex(/^[0-9a-f]{64}$/);
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** A role or a short plain phrase; no link, markup or e-mail address (a role, never a person's contact). */
const Plain = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => s === s.trim() && !/[<>@]|https?:|www\./i.test(s), "plain_text");

export const ProvenanceA = z.strictObject({
  schema: z.literal(PROVENANCE_SCHEMA),
  class: z.literal("A"),
  sha256: SHA,
  material_id: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),
  materials_approval_sha256: SHA,
});
export const ProvenanceB = z.strictObject({
  schema: z.literal(PROVENANCE_SCHEMA),
  class: z.literal("B"),
  sha256: SHA,
  provided_by: Plain(40),
  source: Plain(120),
  permission: z.strictObject({ scope: Plain(200), confirmed_at: IsoDate, confirmed_by: Plain(40) }),
  facts_check: z.strictObject({ shown_as_fact: z.boolean(), confirmed: z.boolean() }).refine((f) => !f.shown_as_fact || f.confirmed, "facts_unconfirmed"),
});
export const ProvenanceC = z.strictObject({
  schema: z.literal(PROVENANCE_SCHEMA),
  class: z.literal("C"),
  sha256: SHA,
  uploaded_via: z.literal("pages_cms"),
  commit: z.string().regex(/^[0-9a-f]{7,40}$/).optional(),
  checks: z.strictObject({ type: z.literal("ok"), bytes: z.literal("ok"), dimensions: z.literal("ok"), ratio: z.literal("ok") }),
});
export const Provenance = z.discriminatedUnion("class", [ProvenanceA, ProvenanceB, ProvenanceC]);
export type Provenance = z.infer<typeof Provenance>;
export type ProvenanceB = z.infer<typeof ProvenanceB>;

/** The class of each imageKind. */
export const CLASS_OF = { generated: "A", shop_provided: "B", customer_cms: "C" } as const;

export const PROVENANCE_INDEX = "content/photo-provenance.json";
const ProvenanceIndex = z.strictObject({
  schema: z.literal("sr_photo_provenance_index_v1"),
  b: z.array(z.strictObject({ sha256: SHA, record_sha256: SHA })).max(500),
});
export type ProvenanceIndex = z.infer<typeof ProvenanceIndex>;

/** The repository's B index (SHA-256 → the private record's SHA-256); empty when absent (ENOENT only). */
export async function loadProvenanceIndex(repo: string): Promise<Map<string, string>> {
  let bytes: Buffer;
  try {
    bytes = await readFile(join(repo, PROVENANCE_INDEX));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw new ContentError("CONTENT_INVALID", PROVENANCE_INDEX);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ContentError("CONTENT_INVALID", PROVENANCE_INDEX);
  }
  const r = ProvenanceIndex.safeParse(raw);
  if (!r.success) throw new ContentError("CONTENT_INVALID", PROVENANCE_INDEX);
  return new Map(r.data.b.map((e) => [e.sha256, e.record_sha256]));
}

const sha256Of = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** What the delivery writes for B pictures: the private records' bytes (by picture SHA-256) and the repository index. */
export function rightsFiles(records: readonly ProvenanceB[]): { private: Record<string, string>; index: ProvenanceIndex } {
  const priv: Record<string, string> = {};
  for (const r of records) priv[`${r.sha256}.json`] = `${JSON.stringify(r, null, 2)}\n`;
  return { private: priv, index: { schema: "sr_photo_provenance_index_v1", b: records.map((r) => ({ sha256: r.sha256, record_sha256: sha256Of(priv[`${r.sha256}.json`]!) })) } };
}

/**
 * A B picture's provenance: it must be in the repository index; with the private folder (Second Root's build) its full
 * record must exist, be valid, name this picture and match the index's record SHA-256. Otherwise
 * CONTENT_PHOTO_RIGHTS_MISSING. Without the folder (the customer's build) the index entry is what is known (null).
 */
export async function loadRightsRecord(index: Map<string, string>, dir: string | undefined, sha256: string, file: string): Promise<ProvenanceB | null> {
  const recordSha = index.get(sha256);
  if (!recordSha) throw new ContentError("CONTENT_PHOTO_RIGHTS_MISSING", file);
  if (!dir) return null;
  const bytes = await readFile(join(dir, `${sha256}.json`)).catch(() => null);
  if (bytes === null || sha256Of(bytes) !== recordSha) throw new ContentError("CONTENT_PHOTO_RIGHTS_MISSING", file);
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ContentError("CONTENT_PHOTO_RIGHTS_MISSING", file);
  }
  const r = ProvenanceB.safeParse(raw);
  if (!r.success || r.data.sha256 !== sha256) throw new ContentError("CONTENT_PHOTO_RIGHTS_MISSING", file);
  return r.data;
}

/** The C record the build writes for a customer's picture: the automatic checks it passed (photos.ts). */
export const customerRecord = (sha256: string): Provenance => ({ schema: PROVENANCE_SCHEMA, class: "C", sha256, uploaded_via: "pages_cms", checks: { type: "ok", bytes: "ok", dimensions: "ok", ratio: "ok" } });
