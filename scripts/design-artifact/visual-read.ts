/**
 * DEV-158 (Issue #193): check Claude's viewing records against the pictures they name, and write the matrix of all
 * registered cases: what Claude can open, what Claude has read, and each view's mode (offline, read-only on images).
 *
 *   npx tsx scripts/design-artifact/visual-read.ts            write design-library/research/quality-pipeline/visual-read-matrix.json
 *   npx tsx scripts/design-artifact/visual-read.ts --check    write nothing; exit 1 if a record fails or the matrix is stale
 *
 * A record names a repository file (a registered preview) or `intake:<path>` under the git-ignored .intake/ folder.
 * An intake file that is not present here cannot be verified here: its record is reported as UNVERIFIABLE_HERE, does
 * not fail --check, and does not make the view VISUAL_VERIFIED in this run. Originals stay out of the public
 * repository; their reads are verified only where the file is.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
  const file = path.startsWith("intake:") ? join(REPO, INTAKE, path.slice("intake:".length)) : join(REPO, path);
  if (path.includes("..") || !existsSync(file) || !statSync(file).isFile()) return null;
  const b = readFileSync(file);
  const size = imageSize(b);
  return size ? { sha256: createHash("sha256").update(b).digest("hex"), ...size } : null;
}

export type ReadResult = { file: string; case_id: string; view: string; kind: string; sha256: string; verifiableHere: boolean; check: ReadCheck };

export function checkAllReads(): ReadResult[] {
  const inv = readInventory();
  const out: ReadResult[] = [];
  const dir = join(REPO, READS);
  if (!existsSync(dir)) return out;
  for (const c of readdirSync(dir).sort())
    for (const f of readdirSync(join(dir, c)).filter((x) => x.endsWith(".read.json")).sort()) {
      const raw = JSON.parse(readFileSync(join(dir, c, f), "utf8")) as { case_id?: string; view?: string; asset?: { path?: string; kind?: string; sha256?: string } };
      const pictures = (inv.cases.find((x) => x.id === raw.case_id)?.originals ?? []).filter((p) => ADOPTED.has(p.kind));
      const path = typeof raw.asset?.path === "string" ? raw.asset.path : "";
      const now = path ? assetNow(path) : null;
      const verifiableHere = !(path.startsWith("intake:") && now === null);
      const placed = c === raw.case_id && f === `${String(raw.view)}.read.json`;
      const check: ReadCheck = !placed ? { ok: false, codes: ["READ_FILE_PLACEMENT"] } : checkVisualRead(raw, now, { pictures });
      out.push({ file: `${READS}/${c}/${f}`, case_id: String(raw.case_id), view: String(raw.view), kind: String(raw.asset?.kind), sha256: String(raw.asset?.sha256), verifiableHere, check });
    }
  return out;
}

export function matrixText(reads: ReadResult[]): string {
  const inv = readInventory();
  const pr = JSON.parse(readFileSync(join(REPO, "design-library/research/quality-pipeline/principles-v1.json"), "utf8")) as Principles;
  const notes = readdirSync(join(REPO, "design-library/success-cases"));
  const cases = inv.cases.map((c) => {
    const adopted = c.originals.filter((p) => ADOPTED.has(p.kind) && ["concept", "desktop", "mobile"].includes(p.view));
    const views = [...new Set(adopted.map((p) => p.view))].sort();
    const text = {
      chatgpt_viewed: pr.cases.some((p) => p.id === c.id && p.evidence.includes("chatgpt_viewed")),
      case_note: notes.some((f) => f.startsWith(`${c.id}-`) && f.endsWith(".md")),
    };
    const passed = reads.filter((r) => r.case_id === c.id && r.check.ok);
    const modes: Record<string, VisualMode> = {};
    for (const v of views.length ? views : ["unknown"]) modes[v] = visualMode(passed.filter((r) => r.view === v).length, text);
    return {
      id: c.id,
      form: c.form,
      available_for_Claude_visual_read: adopted.filter((p) => p.in_repo_path).map((p) => ({ view: p.view, kind: p.kind, path: p.in_repo_path, sha256: p.sha256 })),
      read_by_Claude: passed.map((r) => ({ view: r.view, kind: r.kind, sha256: r.sha256 })),
      unverifiable_here: reads.filter((r) => r.case_id === c.id && !r.verifiableHere).map((r) => r.view),
      text,
      modes,
    };
  });
  const count = (m: VisualMode) => cases.reduce((n, c) => n + Object.values(c.modes).filter((x) => x === m).length, 0);
  return `${JSON.stringify(
    {
      schema: "visual_read_matrix_v1",
      note: "Only Claude's own passing viewing record of an adopted picture (registered preview or original) makes a view VISUAL_VERIFIED; the kind read is listed. Another AI's viewing summary or a case note is TEXT_ONLY_PROVISIONAL. A case with no recorded view is keyed 'unknown'. Reads of originals in the git-ignored .intake/ folder are UNVERIFIABLE_HERE where the file is absent (as in CI) and do not count there.",
      counts: { VISUAL_VERIFIED: count("VISUAL_VERIFIED"), TEXT_ONLY_PROVISIONAL: count("TEXT_ONLY_PROVISIONAL"), MISSING_OR_HOLD: count("MISSING_OR_HOLD") },
      cases,
    },
    null,
    2,
  )}\n`;
}

/** --check fails on a read that can be verified here and does not pass; a read of an original absent here is only reported. */
export const checkFails = (reads: readonly ReadResult[]) => reads.some((r) => r.verifiableHere && !r.check.ok);

if (require.main === module) {
  const reads = checkAllReads();
  for (const r of reads) process.stdout.write(`${r.check.ok ? "READ_OK" : r.verifiableHere ? `READ_FAIL ${r.check.codes.join(",")}` : "UNVERIFIABLE_HERE"} ${r.file}\n`);
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
