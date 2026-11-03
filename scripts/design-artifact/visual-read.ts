/**
 * DEV-158 (Issue #193): check Claude's viewing records against the pictures they name, and write the matrix of all
 * registered cases: what Claude can open, what Claude has read, and each view's mode (offline, read-only on images).
 *
 *   npx tsx scripts/design-artifact/visual-read.ts            write design-library/research/quality-pipeline/visual-read-matrix.json
 *   npx tsx scripts/design-artifact/visual-read.ts --check    write nothing; exit 1 if a record fails or the matrix is stale
 *
 * A record names a repository file (a registered preview) or `intake:<path>` under the git-ignored .intake/ folder.
 * A read of an original names `intake:<path>` (the git-ignored .intake/ folder). Where that file is absent (CI), the
 * missing file is the only thing excused: every other check (schema, placement, the picture recorded for that case,
 * view and kind, crops, observations) still runs and still fails --check; a file that is present but unreadable
 * fails. Because the original's SHA is public and its size is not recorded, nothing in CI ties such a read to real
 * bytes: it never makes a view VISUAL_VERIFIED in the matrix. It is listed as `original_reads_pending_owner`, the
 * same wherever the matrix is built, until the owner confirms it on the machine that has the file (Issue #193).
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkVisualRead, imageSize, visualMode, type AssetNow, type InventoryPicture, type ReadCheck, type VisualMode } from "../../lib/design-agent/reference-originals/visual-read";

const REPO = resolve(__dirname, "../..");
const READS = "design-library/research/quality-pipeline/visual-reads";
const INTAKE = "design-library/research/quality-pipeline/.intake";
const OUT = "design-library/research/quality-pipeline/visual-read-matrix.json";

type Inventory = { cases: Array<{ id: string; form: string; originals: InventoryPicture[] }> };
const readInventory = () => JSON.parse(readFileSync(join(REPO, "design-library/research/quality-pipeline/originals-inventory.json"), "utf8")) as Inventory;
/** Only the adopted pictures count: comparisons, superseded and rejected versions never do. */
const ADOPTED = new Set(["original", "registered_preview"]);
type Principles = { cases: Array<{ id: string; evidence: string[] }> };

export function assetNow(path: string): AssetNow {
  if (path.includes("..")) return null;
  const file = path.startsWith("intake:") ? join(REPO, INTAKE, path.slice("intake:".length)) : join(REPO, path);
  let isFile: boolean;
  try {
    isFile = lstatSync(file).isFile() || statSync(file).isFile();
  } catch {
    return null; // absent: the only state an original's read may be excused for
  }
  if (!isFile) return { unreadable: true, sha256: null };
  const b = readFileSync(file);
  const sha256 = createHash("sha256").update(b).digest("hex");
  const size = imageSize(b);
  return size ? { sha256, ...size } : { unreadable: true, sha256 };
}

export type ReadResult = { file: string; case_id: string; view: string; kind: string; sha256: string; bytes: "in_repo" | "not_in_ci"; check: ReadCheck };

export function checkAllReads(dir = join(REPO, READS)): ReadResult[] {
  const inv = readInventory();
  const out: ReadResult[] = [];
  if (!existsSync(dir)) return out;
  for (const c of readdirSync(dir).sort()) {
    if (!statSync(join(dir, c)).isDirectory()) {
      out.push({ file: `${READS}/${c}`, case_id: c, view: "", kind: "", sha256: "", bytes: "in_repo", check: { ok: false, codes: ["READ_FILE_PLACEMENT"] } });
      continue;
    }
    for (const f of readdirSync(join(dir, c)).sort()) {
      let raw: { case_id?: string; view?: string; asset?: { path?: string; kind?: string; sha256?: string } } = {};
      let parsedOk = f.endsWith(".read.json");
      try {
        const v: unknown = JSON.parse(readFileSync(join(dir, c, f), "utf8"));
        if (v && typeof v === "object" && !Array.isArray(v)) raw = v as typeof raw;
        else parsedOk = false;
      } catch {
        parsedOk = false;
      }
      if (!parsedOk) {
        out.push({ file: `${READS}/${c}/${f}`, case_id: c, view: "", kind: "", sha256: "", bytes: "in_repo", check: { ok: false, codes: [f.endsWith(".read.json") ? "READ_SCHEMA" : "READ_FILE_PLACEMENT"] } });
        continue;
      }
      const pictures = (inv.cases.find((x) => x.id === raw.case_id)?.originals ?? []).filter((p) => ADOPTED.has(p.kind));
      const path = typeof raw.asset?.path === "string" ? raw.asset.path : "";
      const now = path ? assetNow(path) : null;
      const placed = c === raw.case_id && f === `${String(raw.view)}.read.json`;
      let check: ReadCheck = !placed ? { ok: false, codes: ["READ_FILE_PLACEMENT"] } : checkVisualRead(raw, now, { pictures });
      const intake = path.startsWith("intake:");
      // only the missing file of an original is excused; any other code still fails
      if (intake && !check.ok && check.codes.length === 1 && check.codes[0] === "ASSET_NOT_AVAILABLE") check = { ok: true };
      out.push({ file: `${READS}/${c}/${f}`, case_id: c, view: String(raw.view), kind: String(raw.asset?.kind), sha256: String(raw.asset?.sha256), bytes: intake ? "not_in_ci" : "in_repo", check });
    }
  }
  return out;
}

export function matrixText(reads: ReadResult[]): string {
  const inv = readInventory();
  const pr = JSON.parse(readFileSync(join(REPO, "design-library/research/quality-pipeline/principles-v1.json"), "utf8")) as Principles;
  const notes = readdirSync(join(REPO, "design-library/success-cases"));
  const cases = inv.cases.map((c) => {
    const adoptedAll = c.originals.filter((p) => ADOPTED.has(p.kind));
    const adopted = adoptedAll.filter((p) => ["concept", "desktop", "mobile"].includes(p.view));
    const views = [...new Set(adopted.map((p) => p.view))].sort();
    const text = {
      chatgpt_viewed: pr.cases.some((p) => p.id === c.id && p.evidence.includes("chatgpt_viewed")),
      case_note: notes.some((f) => f.startsWith(`${c.id}-`) && f.endsWith(".md")),
    };
    // only reads tied to bytes the repository holds count; reads of originals wait for the owner (see the header)
    const passed = reads.filter((r) => r.case_id === c.id && r.check.ok && r.bytes === "in_repo");
    const pending = reads.filter((r) => r.case_id === c.id && r.check.ok && r.bytes === "not_in_ci");
    const modes: Record<string, VisualMode> = {};
    for (const v of views.length ? views : ["unknown"]) modes[v] = visualMode(passed.filter((r) => r.view === v).length, text);
    return {
      id: c.id,
      form: c.form,
      available_for_Claude_visual_read: adoptedAll.filter((p) => p.in_repo_path).map((p) => ({ view: p.view, kind: p.kind, path: p.in_repo_path, sha256: p.sha256 })),
      read_by_Claude: passed.map((r) => ({ view: r.view, kind: r.kind, sha256: r.sha256 })),
      original_reads_pending_owner: pending.map((r) => ({ view: r.view, kind: r.kind, sha256: r.sha256 })),
      text,
      modes,
    };
  });
  const count = (m: VisualMode) => cases.reduce((n, c) => n + Object.values(c.modes).filter((x) => x === m).length, 0);
  return `${JSON.stringify(
    {
      schema: "visual_read_matrix_v1",
      note: "Only Claude's own passing viewing record of an adopted picture (registered preview or original) makes a view VISUAL_VERIFIED; the kind read is listed. Another AI's viewing summary or a case note is TEXT_ONLY_PROVISIONAL. A case with no recorded view is keyed 'unknown'; adopted pictures of view 'other' are listed as available but have no mode. Reads of originals in the git-ignored .intake/ folder must pass every check but the missing file; since CI cannot tie them to bytes, they are listed as original_reads_pending_owner and never make a view VISUAL_VERIFIED until the owner confirms them.",
      counts: { VISUAL_VERIFIED: count("VISUAL_VERIFIED"), TEXT_ONLY_PROVISIONAL: count("TEXT_ONLY_PROVISIONAL"), MISSING_OR_HOLD: count("MISSING_OR_HOLD") },
      cases,
    },
    null,
    2,
  )}\n`;
}

/** --check fails on any read that does not pass (a read of an original absent here passes only when nothing else fails). */
export const checkFails = (reads: readonly ReadResult[]) => reads.some((r) => !r.check.ok);

if (require.main === module) {
  const reads = checkAllReads();
  for (const r of reads) process.stdout.write(`${r.check.ok ? (r.bytes === "in_repo" ? "READ_OK" : "READ_OK_PENDING_OWNER") : `READ_FAIL ${r.check.codes.join(",")}`} ${r.file}\n`);
  const text = matrixText(reads);
  if (process.argv.includes("--check")) {
    let committed = "";
    try {
      committed = readFileSync(join(REPO, OUT), "utf8");
    } catch {
      /* missing counts as stale */
    }
    const stale = committed !== text;
    if (stale) process.stdout.write(`MATRIX_STALE: run npx tsx scripts/design-artifact/visual-read.ts\n`);
    // a read of an original absent here is reported, not failed; every other read must pass
    process.exit(checkFails(reads) || stale ? 1 : 0);
  }
  writeFileSync(join(REPO, OUT), text);
  process.stdout.write(`${OUT}\n`);
}
