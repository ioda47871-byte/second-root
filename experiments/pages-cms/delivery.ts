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
 * Checks before anything is written (PR #376 review M1-M3 included):
 *   - the provenance folder ITSELF, resolved, is outside the repository (DELIVERY_PROVENANCE_IN_REPO) and is no link and
 *     no file (DELIVERY_PROVENANCE_UNSAFE);
 *   - each delivered file name and material id has the record's form (DELIVERY_RECORD_INVALID);
 *   - each delivered picture is one of the VERIFIED approved materials the caller passes (plain SHA-256s and the one
 *     materials approval's SHA-256, as approvedMaterials returns them), with that same approval SHA-256
 *     (DELIVERY_MATERIAL_NOT_APPROVED), and is in media/ with exactly that SHA-256 (DELIVERY_PICTURE_MISMATCH);
 *   - an existing handover record is never shortened: its entries are kept and merged; an entry that disagrees with a
 *     delivered one (another SHA-256 or material id for the same file) is refused (DELIVERY_RECORD_CONFLICT);
 *   - the merged record covers every shown picture the content marks `generated` (DELIVERY_RECORD_INCOMPLETE), so the
 *     build's CONTENT_GENERATED_AS_SHOP keeps catching a relabel after any re-delivery;
 *   - the spec is a valid sr_photo_slots_v1 bound to the given approval and names only handed-over materials
 *     (DELIVERY_SLOTS_INVALID / DELIVERY_SLOTS_UNBOUND); each B record is a valid rights record of a picture in media/
 *     (DELIVERY_RIGHTS_INVALID).
 * The writer itself checks no approval: that is the caller's job, and it is named in every record it binds.
 * Offline and fictional only.
 */
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { loadContent, viewOf } from "./content-model";
import { GENERATED_RECORD, loadGeneratedEntries } from "./photos";
import { PHOTO_SLOTS_FILE, PhotoSlots, type ApprovedDesign } from "./photo-slots";
import { PROVENANCE_INDEX, PROVENANCE_SCHEMA, ProvenanceB, rightsFiles, type ProvenanceB as ProvenanceBRecord } from "./provenance";

export class DeliveryError extends Error {
  constructor(
    readonly code:
      | "DELIVERY_PICTURE_MISMATCH"
      | "DELIVERY_SLOTS_INVALID"
      | "DELIVERY_SLOTS_UNBOUND"
      | "DELIVERY_RIGHTS_INVALID"
      | "DELIVERY_PROVENANCE_IN_REPO"
      | "DELIVERY_PROVENANCE_UNSAFE"
      | "DELIVERY_RECORD_INVALID"
      | "DELIVERY_MATERIAL_NOT_APPROVED"
      | "DELIVERY_RECORD_CONFLICT"
      | "DELIVERY_RECORD_INCOMPLETE",
    readonly detail: string,
  ) {
    super(`${code} ${detail}`);
    this.name = "DeliveryError";
  }
}

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const json = (o: unknown) => `${JSON.stringify(o, null, 2)}\n`;

/** The nearest existing ancestor's real path joined with the rest (a link above is resolved). */
async function realPlace(path: string): Promise<string | null> {
  const rest: string[] = [];
  let anc = resolve(path);
  while (!(await lstat(anc).then(() => true, () => false))) {
    const up = dirname(anc);
    if (up === anc) return null;
    rest.unshift(basename(anc));
    anc = up;
  }
  const real = await realpath(anc).catch(() => null);
  return real === null ? null : join(real, ...rest);
}
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const MATERIAL_ID_RE = /^[a-z][a-z0-9-]{1,30}$/;
const SHA_RE = /^[0-9a-f]{64}$/;

/** One handed-over generated picture (A), as the verified approved materials name it. */
export type DeliveredMaterial = { file: string; sha256: string; material_id: string; materials_approval_sha256: string };

export async function writeDelivery(o: {
  repo: string;
  provenanceDir: string;
  /** The first approval the spec binds (the ApprovedDesignRef fields and approval_sha256), verified by the caller. */
  approval: ApprovedDesign;
  /**
   * PR #376 review M3: the VERIFIED approved materials (approvedMaterials' result as plain data): the approved pictures'
   * SHA-256s and the one materials approval's SHA-256. Every delivered picture must be one of them, with that approval.
   */
  approvedMaterials: { approval_sha256: string; sha256s: readonly string[] };
  materials: readonly DeliveredMaterial[];
  /** The photo-slot spec's slots (their material ids among `materials`). */
  slots: unknown[];
  /** The shop's own photos (B) with their rights records, when there are any. */
  shopPhotos?: readonly { file: string; rights: ProvenanceBRecord }[];
}): Promise<{ written: string[] }> {
  const repo = resolve(o.repo);
  const prov = resolve(o.provenanceDir);
  const realRepo = await realpath(repo).catch(() => repo);
  const inside = (p: string | null, r: string) => {
    if (p === null) return true;
    const rel = relative(r, p);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  // M1: the folder itself, resolved (a link to anywhere is refused; one into the repository is "in the repository")
  const provStat = await lstat(prov).catch(() => null);
  const realProv = provStat ? await realpath(prov).catch(() => null) : await realPlace(prov);
  if (inside(prov, repo) || inside(realProv, realRepo)) throw new DeliveryError("DELIVERY_PROVENANCE_IN_REPO", "provenanceDir");
  if (provStat && (provStat.isSymbolicLink() || !provStat.isDirectory())) throw new DeliveryError("DELIVERY_PROVENANCE_UNSAFE", "provenanceDir");
  // M3: the record's form, and only verified approved materials with their one approval
  const approvedShas = new Set(o.approvedMaterials.sha256s);
  if (!SHA_RE.test(o.approvedMaterials.approval_sha256)) throw new DeliveryError("DELIVERY_MATERIAL_NOT_APPROVED", "materials approval");
  for (const m of o.materials) {
    if (!FILE_RE.test(m.file) || !MATERIAL_ID_RE.test(m.material_id) || !SHA_RE.test(m.sha256) || !SHA_RE.test(m.materials_approval_sha256)) throw new DeliveryError("DELIVERY_RECORD_INVALID", m.file);
    if (!approvedShas.has(m.sha256) || m.materials_approval_sha256 !== o.approvedMaterials.approval_sha256) throw new DeliveryError("DELIVERY_MATERIAL_NOT_APPROVED", m.file);
    const bytes = await readFile(join(repo, "media", m.file)).catch(() => null);
    if (!bytes || sha256(bytes) !== m.sha256) throw new DeliveryError("DELIVERY_PICTURE_MISMATCH", m.file);
  }
  // M2: merge with an existing handover record (never drop an entry), then it must cover every shown generated picture
  const existing = await loadGeneratedEntries(repo);
  const merged = new Map(existing.map((e) => [e.file, { ...e }]));
  for (const m of o.materials) {
    const old = merged.get(m.file);
    if (old && (old.sha256 !== m.sha256 || (old.material_id !== undefined && old.material_id !== m.material_id))) throw new DeliveryError("DELIVERY_RECORD_CONFLICT", m.file);
    merged.set(m.file, { file: m.file, sha256: m.sha256, material_id: m.material_id, materials_approval_sha256: m.materials_approval_sha256 });
  }
  const recordShas = new Set([...merged.values()].map((e) => e.sha256));
  const shown = viewOf(await loadContent(repo)).sections.flatMap((x) => x.items).filter((m) => m.image && m.imageKind === "generated");
  for (const m of shown) {
    const bytes = await readFile(join(repo, "media", m.image.replace(/^\/media\//, ""))).catch(() => null);
    if (!bytes || !recordShas.has(sha256(bytes))) throw new DeliveryError("DELIVERY_RECORD_INCOMPLETE", `menu/${m.id}`);
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
  await writeFile(join(repo, GENERATED_RECORD), json({ schema: "generated_materials_v1", files: [...merged.values()].sort((a, b) => (a.file < b.file ? -1 : 1)) }));
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
