/**
 * DEV-185 — OFFLINE. The import of the つぐ手 (fictional) AI demo photos into the photo swap (photo-swap.ts):
 *
 *   npx tsx scripts/design-artifact/tsugute-ai-intake.ts --from <run dir with manifest.json> --manifest-out <file>
 *
 * Reads the one-shot run's manifest.json (run-tsugute-photos-once.sh), refuses it unless it is `complete` (6 pictures,
 * 6 calls, none failed), it carries the approved run's pins (prompt SHA-256 and length, each slot's prompt SHA-256,
 * the generator and the demo label), each picture's bytes match its SHA-256, size and slot in the manifest, and the model is
 * reported. Then copies the 6 PNGs (unchanged) into the private, git-ignored
 * design-library/research/quality-pipeline/.intake/photos/ as tsugute-ai-<slot>.png (0600; an existing file is never
 * overwritten) and writes a photo_swap_manifest_v0 (0600) whose rights records are `ai_generated_demo` with the full
 * provenance and demo_only. --manifest-out must be outside the repository or under that .intake/.
 *
 * Never calls a model, a generator or the network. Nothing is committed. Exit 0 written, 2 refused (nothing written).
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { measurePhotoBytes, PHOTO_INTAKE_DIR } from "../../lib/design-agent/quality-pipeline/photo-rights";
import { DEMO_LABEL, GENERATOR, slotPromptSha256, TSUGUTE_PHOTOS_APPROVAL_ID, TSUGUTE_PHOTOS_MAX_IMAGES, TSUGUTE_PROMPT_CHARS, TSUGUTE_PROMPT_SHA256, TSUGUTE_SLOTS, TsugutePhotosManifestSchema } from "../../lib/design-agent/quality-pipeline/tsugute-ai-photos";

const REPO = resolve(__dirname, "../..");
export const PIPELINE_ROOT = join(REPO, "design-library/research/quality-pipeline");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const inside = (child: string, parent: string) => (child + sep).startsWith(parent + sep);

export type IntakeResult = { ok: true; manifest: Record<string, unknown>; files: string[] } | { ok: false; codes: string[] };

/**
 * Builds the swap manifest and copies the pictures. Everything is checked first; files are written only when nothing
 * is refused. `pipelineRoot` defaults to the repository's quality pipeline (tests give a temporary one).
 */
export function importTsuguteAiPhotos(o: { from: string; manifestOut: string; pipelineRoot?: string }): IntakeResult {
  const pipelineRoot = o.pipelineRoot ?? PIPELINE_ROOT;
  const codes: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(o.from, "manifest.json"), "utf8"));
  } catch {
    return { ok: false, codes: ["RUN_MANIFEST_UNREADABLE"] };
  }
  const parsed = TsugutePhotosManifestSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, codes: ["RUN_MANIFEST_INVALID"] };
  const m = parsed.data;
  if (m.status !== "complete" || m.stop_code !== null) codes.push("RUN_NOT_COMPLETE");
  if (m.approval_id !== TSUGUTE_PHOTOS_APPROVAL_ID) codes.push("RUN_APPROVAL_UNKNOWN");
  if (m.slots.length !== TSUGUTE_PHOTOS_MAX_IMAGES || m.image_tool_calls !== TSUGUTE_PHOTOS_MAX_IMAGES || m.image_tool_failed !== 0) codes.push("RUN_NOT_SIX_IMAGES");
  if (m.model === null) codes.push("MODEL_NOT_REPORTED");
  // PR #227 review M1: the manifest must be the approved run's, not one written by hand next to any 6 PNGs
  if (m.prompt_sha256 !== TSUGUTE_PROMPT_SHA256 || m.prompt_chars !== TSUGUTE_PROMPT_CHARS) codes.push("RUN_PROMPT_NOT_APPROVED");
  if (m.generator !== GENERATOR) codes.push("RUN_GENERATOR_UNKNOWN");
  if (m.label !== DEMO_LABEL) codes.push("RUN_DEMO_LABEL_MISSING");
  if (!manifestOutOk(o.manifestOut, pipelineRoot)) codes.push("MANIFEST_OUT_NOT_PRIVATE");
  const photos = join(pipelineRoot, PHOTO_INTAKE_DIR);
  const loaded: Array<{ slot: (typeof TSUGUTE_SLOTS)[number]; buf: Buffer; name: string; width: number; height: number }> = [];
  for (const [i, s] of m.slots.entries()) {
    const slot = TSUGUTE_SLOTS[i];
    if (!slot || s.slot_id !== slot.slot_id || s.file !== `${slot.slot_id}.png`) {
      codes.push(`SLOT_ORDER:${s.slot_id}`);
      continue;
    }
    if (s.slot_prompt_sha256 !== slotPromptSha256(slot)) codes.push(`SLOT_PROMPT_NOT_APPROVED:${s.slot_id}`);
    const file = join(o.from, s.file);
    let buf: Buffer;
    try {
      const st = lstatSync(file);
      if (!st.isFile() || st.nlink > 1) throw new Error("not a plain file");
      buf = readFileSync(file);
    } catch {
      codes.push(`FILE_UNREADABLE:${s.slot_id}`);
      continue;
    }
    const info = measurePhotoBytes(buf);
    if (!info || info.format !== "png" || sha(buf) !== s.sha256 || info.width !== s.width || info.height !== s.height) {
      codes.push(`FILE_MISMATCH:${s.slot_id}`);
      continue;
    }
    const name = `tsugute-ai-${slot.slot_id}.png`;
    if (existsSync(join(photos, name))) codes.push(`INTAKE_EXISTS:${s.slot_id}`);
    loaded.push({ slot, buf, name, width: info.width, height: info.height });
  }
  if (codes.length) return { ok: false, codes };
  const receivedAt = m.generated_at.slice(0, 10);
  const swap = {
    schema: "photo_swap_manifest_v0",
    shop: "tsugute",
    slots: loaded.map(({ slot, buf, name, width, height }) => ({
      slot_id: slot.slot_id,
      pc: {
        focal_box: slot.focal_box,
        rights: {
          schema: "photo_rights_v0",
          asset_id: `photo-tsugute-ai-${slot.slot_id.slice(3)}`,
          sha256: sha(buf),
          bytes: buf.length,
          width,
          height,
          format: "png",
          source_kind: "ai_generated_demo",
          owner: "Second Root (AI-generated demo for a fictional shop; no third-party rights holder)",
          license: `ai-generated demo, owner approval ${m.approval_id}`,
          paid: false,
          allowed_uses: { edit: true, crop: true, commercial: true, public_web: false },
          consent_record_ref: m.approval_id,
          received_at: receivedAt,
          expiry: null,
          private_path: `${PHOTO_INTAKE_DIR}/${name}`,
          depicts_identifiable_person: false,
          depicts_real_shop: false,
          ai_provenance: { generator: m.generator, model: m.model, generated_at: m.generated_at, prompt_sha256: m.prompt_sha256, approval_id: m.approval_id, demo_only: true },
        },
      },
    })),
  };
  mkdirSync(photos, { recursive: true, mode: 0o700 });
  const files: string[] = [];
  for (const { buf, name } of loaded) {
    writeFileSync(join(photos, name), buf, { flag: "wx", mode: 0o600 });
    files.push(join(photos, name));
  }
  writeFileSync(o.manifestOut, `${JSON.stringify(swap, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  chmodSync(o.manifestOut, 0o600);
  return { ok: true, manifest: swap, files };
}

/** The swap manifest names the approval and private paths: outside the repository, or under the private .intake/. */
function manifestOutOk(file: string, pipelineRoot: string): boolean {
  const abs = resolve(file);
  if (existsSync(abs)) return false;
  let parent: string;
  try {
    parent = realpathSync(dirname(abs));
  } catch {
    return false;
  }
  const repo = realpathSync(REPO);
  if (!inside(parent, repo)) return true;
  try {
    return inside(parent, realpathSync(join(pipelineRoot, ".intake")));
  } catch {
    return false;
  }
}

function main(argv: string[]): number {
  const arg = (k: string) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const from = arg("--from");
  const manifestOut = arg("--manifest-out");
  if (!from || !manifestOut || argv.length !== 4) return (process.stderr.write("usage: --from <run dir> --manifest-out <new file outside the repository or under .intake/>\n"), 2);
  const r = importTsuguteAiPhotos({ from: resolve(from), manifestOut: resolve(manifestOut) });
  if (!r.ok) return (process.stderr.write(`REFUSED: ${r.codes.join(",")}\n`), 2);
  process.stdout.write(`${JSON.stringify({ manifest: resolve(manifestOut), photos: r.files.length })}\n`);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
