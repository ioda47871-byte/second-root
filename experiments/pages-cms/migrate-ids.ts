/**
 * Issue #380 live trial (2026-11-28): makes already-delivered entries editable again in Pages CMS. A works or news entry
 * whose `id` is not a UUID (the pre-registered `job-1`, `news-1`, …) cannot be saved: Pages CMS validates its hidden uuid
 * id field and shows only "Please fix the errors before saving." (uuid.ts). This rewrites ONLY such ids, to the
 * deterministic version-5 UUID of "<collection>/<old id>" (uuid.ts uuidV5 — the ids the fixtures now ship), and keeps
 * everything else byte for byte: the file name (job-1.json stays job-1.json — the build never ties an id to a file
 * name), the photos, every other field, the key order and the formatting. Only the characters of the id value change.
 *
 *   - collections: content/works/ and content/news/ only (nothing refers to their ids; menu items refer to category
 *     ids, so categories are NOT touched here)
 *   - a UUID id is left as it is (a second run changes nothing: idempotent)
 *   - refused, with nothing written: a file that is not valid JSON or has no string id, an id written so that its value
 *     cannot be found exactly once in the text, two entries ending with the same id
 *   - dry run unless { write: true }; the report lists every file, its old and new id and what was (or would be) done
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isUuid, uuidV5 } from "./uuid";

export const MIGRATED_COLLECTIONS = ["works", "news"] as const;

export type IdChange = { file: string; old_id: string; new_id: string; action: "kept" | "rewrite" };
export type MigrationReport = { status: "dry_run" | "written" | "refused"; changes: IdChange[]; errors: string[] };

/** The text with only the top-level id's value replaced, or null when it cannot be found exactly once. */
function replaceId(text: string, oldId: string, newId: string): string | null {
  const encoded = JSON.stringify(oldId);
  const re = new RegExp(`("id"\\s*:\\s*)${encoded.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "g");
  const hits = [...text.matchAll(re)];
  if (hits.length !== 1) return null;
  return text.replace(re, `$1${JSON.stringify(newId)}`);
}

const sameExceptId = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export async function migrateIds(repo: string, o: { write?: boolean } = {}): Promise<MigrationReport> {
  const changes: IdChange[] = [];
  const errors: string[] = [];
  const planned: { path: string; text: string }[] = [];
  for (const collection of MIGRATED_COLLECTIONS) {
    const dir = join(repo, "content", collection);
    const names = ((await readdir(dir).catch(() => [])) as string[]).filter((n) => n.endsWith(".json")).sort();
    const finalIds = new Map<string, string>();
    for (const name of names) {
      const file = `content/${collection}/${name}`;
      const text = await readFile(join(dir, name), "utf8");
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(text) as Record<string, unknown>;
      } catch {
        errors.push(`${file}: not valid JSON`);
        continue;
      }
      if (typeof entry.id !== "string" || entry.id === "") {
        errors.push(`${file}: no string id`);
        continue;
      }
      const oldId = entry.id;
      const newId = isUuid(oldId) ? oldId : uuidV5(`${collection}/${oldId}`);
      const seen = finalIds.get(newId);
      if (seen) errors.push(`${file}: id ${newId} is also ${seen}`);
      finalIds.set(newId, file);
      if (newId === oldId) {
        changes.push({ file, old_id: oldId, new_id: newId, action: "kept" });
        continue;
      }
      const next = replaceId(text, oldId, newId);
      // the result must be the same entry with only the id changed (same keys, order and values)
      if (next === null || !sameExceptId(JSON.parse(next), { ...entry, id: newId })) {
        errors.push(`${file}: the id cannot be replaced exactly once`);
        continue;
      }
      changes.push({ file, old_id: oldId, new_id: newId, action: "rewrite" });
      planned.push({ path: join(dir, name), text: next });
    }
  }
  if (errors.length) return { status: "refused", changes, errors };
  if (!o.write) return { status: "dry_run", changes, errors };
  for (const p of planned) await writeFile(p.path, p.text);
  return { status: "written", changes, errors };
}
