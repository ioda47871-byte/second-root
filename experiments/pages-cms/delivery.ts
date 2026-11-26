/**
 * DEV-364 P0 (the fictional bakery end to end): the DELIVERY writer of a shop repository — what Second Root writes into
 * the shop's repository (and its private provenance folder) when it hands the site over, from data a caller has
 * ALREADY VERIFIED against the gate records (the first approval and the approved materials; experiments/ may not import
 * the gate modules, so the caller — a test, or later a script — reads and verifies them and passes plain values here).
 *
 *   content/generated-materials.json   every handed-over generated picture (A): file, SHA-256, material id and the
 *                                      materials approval's SHA-256 (photos.ts GeneratedRecord)
 *   content/photo-slots.json           the photo-slot spec (photo-slots.ts sr_photo_slots_v1), bound to the first approval
 *   content/photo-provenance.json      the B index (provenance.ts), when the shop provided photos
 *   <provenanceDir>/<sha256>.json      the private provenance records: A (material + materials approval) and B (rights)
 *
 * Checks before anything is written: each A picture is in media/ with exactly the verified SHA-256
 * (DELIVERY_PICTURE_MISMATCH), the spec is a valid sr_photo_slots_v1 bound to the given approval and names only handed-over
 * materials (DELIVERY_SLOTS_INVALID / DELIVERY_SLOTS_UNBOUND), each B record is a valid rights record of a picture in
 * media/ (DELIVERY_RIGHTS_INVALID), and the provenance folder is outside the repository (DELIVERY_PROVENANCE_IN_REPO).
 * The writer itself checks no approval: that is the caller's job, and it is named in every record it binds.
 * Offline and fictional only.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { GENERATED_RECORD } from "./photos";
import { PHOTO_SLOTS_FILE, PhotoSlots, type ApprovedDesign } from "./photo-slots";
import { PROVENANCE_INDEX, PROVENANCE_SCHEMA, ProvenanceB, rightsFiles, type ProvenanceB as ProvenanceBRecord } from "./provenance";

export class DeliveryError extends Error {
  constructor(
    readonly code: "DELIVERY_PICTURE_MISMATCH" | "DELIVERY_SLOTS_INVALID" | "DELIVERY_SLOTS_UNBOUND" | "DELIVERY_RIGHTS_INVALID" | "DELIVERY_PROVENANCE_IN_REPO",
    readonly detail: string,
  ) {
    super(`${code} ${detail}`);
    this.name = "DeliveryError";
  }
}

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const json = (o: unknown) => `${JSON.stringify(o, null, 2)}\n`;

/** One handed-over generated picture (A), as the verified approved materials name it. */
export type DeliveredMaterial = { file: string; sha256: string; material_id: string; materials_approval_sha256: string };

export async function writeDelivery(o: {
  repo: string;
  provenanceDir: string;
  /** The first approval the spec binds (the ApprovedDesignRef fields and approval_sha256), verified by the caller. */
  approval: ApprovedDesign;
  materials: readonly DeliveredMaterial[];
  /** The photo-slot spec's slots (their material ids among `materials`). */
  slots: unknown[];
  /** The shop's own photos (B) with their rights records, when there are any. */
  shopPhotos?: readonly { file: string; rights: ProvenanceBRecord }[];
}): Promise<{ written: string[] }> {
  const repo = resolve(o.repo);
  const prov = resolve(o.provenanceDir);
  const realRepo = await realpath(repo).catch(() => repo);
  const realProv = await realpath(join(prov, "..")).catch(() => prov);
  const inside = (p: string, r: string) => {
    const rel = relative(r, p);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  if (inside(prov, repo) || inside(realProv, realRepo)) throw new DeliveryError("DELIVERY_PROVENANCE_IN_REPO", "provenanceDir");
  for (const m of o.materials) {
    const bytes = await readFile(join(repo, "media", m.file)).catch(() => null);
    if (!bytes || sha256(bytes) !== m.sha256) throw new DeliveryError("DELIVERY_PICTURE_MISMATCH", m.file);
  }
  const spec = { schema: "sr_photo_slots_v1", approved_design: o.approval, slots: o.slots };
  const parsed = PhotoSlots.safeParse(spec);
  if (!parsed.success) throw new DeliveryError("DELIVERY_SLOTS_INVALID", PHOTO_SLOTS_FILE);
  const ids = new Set(o.materials.map((m) => m.material_id));
  if (parsed.data.slots.some((s) => s.material_ids.some((id) => !ids.has(id)))) throw new DeliveryError("DELIVERY_SLOTS_UNBOUND", PHOTO_SLOTS_FILE);
  for (const p of o.shopPhotos ?? []) {
    const bytes = await readFile(join(repo, "media", p.file)).catch(() => null);
    if (!bytes || !ProvenanceB.safeParse(p.rights).success || p.rights.sha256 !== sha256(bytes)) throw new DeliveryError("DELIVERY_RIGHTS_INVALID", p.file);
  }
  // write: the repository's records, then the private provenance records
  const written: string[] = [];
  await writeFile(join(repo, GENERATED_RECORD), json({ schema: "generated_materials_v1", files: [...o.materials].sort((a, b) => (a.file < b.file ? -1 : 1)).map((m) => ({ file: m.file, sha256: m.sha256, material_id: m.material_id, materials_approval_sha256: m.materials_approval_sha256 })) }));
  written.push(GENERATED_RECORD);
  await writeFile(join(repo, PHOTO_SLOTS_FILE), json(parsed.data));
  written.push(PHOTO_SLOTS_FILE);
  await mkdir(prov, { recursive: true, mode: 0o700 });
  for (const m of o.materials) await writeFile(join(prov, `${m.sha256}.json`), json({ schema: PROVENANCE_SCHEMA, class: "A", sha256: m.sha256, material_id: m.material_id, materials_approval_sha256: m.materials_approval_sha256 }), { mode: 0o600 });
  if (o.shopPhotos?.length) {
    const files = rightsFiles(o.shopPhotos.map((p) => p.rights));
    await writeFile(join(repo, PROVENANCE_INDEX), json(files.index));
    written.push(PROVENANCE_INDEX);
    for (const [name, text] of Object.entries(files.private)) await writeFile(join(prov, name), text, { mode: 0o600 });
  }
  return { written };
}
