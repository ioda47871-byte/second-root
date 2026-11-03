/**
 * DEV-158 (Issue #193): check Claude's viewing records against the pictures they name, and write the matrix of all
 * registered cases: what Claude can open, what Claude has read, and each view's mode (offline, read-only on images).
 *
 *   npx tsx scripts/design-artifact/visual-read.ts            write design-library/research/quality-pipeline/visual-read-matrix.json
 *   npx tsx scripts/design-artifact/visual-read.ts --check    write nothing; exit 1 if a record fails or the matrix is stale
 *
 * A record names a repository file (a registered preview) or `intake:<path>` under the git-ignored .intake/ folder.
 * An intake file that is not present here counts as not available, so its record does not pass in CI: originals stay
 * out of the public repository, and their reads are verified only where the file is.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkVisualRead, imageSize, visualMode, type AssetNow, type ReadCheck, type VisualMode } from "../../lib/design-agent/reference-originals/visual-read";

const REPO = resolve(__dirname, "../..");
const READS = "design-library/research/quality-pipeline/visual-reads";
const INTAKE = "design-library/research/quality-pipeline/.intake";
const OUT = "design-library/research/quality-pipeline/visual-read-matrix.json";

type Inventory = { cases: Array<{ id: string; form: string; has_desktop: boolean; has_mobile: boolean; originals: Array<{ view: string; in_repo_path: string | null }> }> };
type Principles = { cases: Array<{ id: string; evidence: string[] }> };

export function assetNow(path: string): AssetNow {
  const file = path.startsWith("intake:") ? join(REPO, INTAKE, path.slice("intake:".length)) : join(REPO, path);
  if (path.includes("..") || !existsSync(file)) return null;
  const b = readFileSync(file);
  const size = imageSize(b);
  return size ? { sha256: createHash("sha256").update(b).digest("hex"), ...size } : null;
}

export type ReadResult = { file: string; case_id: string; view: string; check: ReadCheck };

export function checkAllReads(): ReadResult[] {
  const manifest = JSON.parse(readFileSync(join(REPO, "design-library/success-cases/manifest.json"), "utf8")) as { records: Array<Record<string, unknown> & { id: string }> };
  const out: ReadResult[] = [];
  const dir = join(REPO, READS);
  if (!existsSync(dir)) return out;
  for (const c of readdirSync(dir).sort())
    for (const f of readdirSync(join(dir, c)).filter((x) => x.endsWith(".read.json")).sort()) {
      const raw = JSON.parse(readFileSync(join(dir, c, f), "utf8")) as { case_id?: string; view?: string; asset?: { path?: string } };
      const rec = manifest.records.find((r) => r.id === raw.case_id);
      const shas = rec ? Object.values(rec).filter((v): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v)) : [];
      const now = typeof raw.asset?.path === "string" ? assetNow(raw.asset.path) : null;
      const check = c !== raw.case_id ? { ok: false as const, codes: ["READ_FOLDER_MISMATCH"] } : checkVisualRead(raw, now, { manifestSha256s: shas });
      out.push({ file: `${READS}/${c}/${f}`, case_id: String(raw.case_id), view: String(raw.view), check });
    }
  return out;
}

export function matrixText(reads: ReadResult[]): string {
  const inv = JSON.parse(readFileSync(join(REPO, "design-library/research/quality-pipeline/originals-inventory.json"), "utf8")) as Inventory;
  const pr = JSON.parse(readFileSync(join(REPO, "design-library/research/quality-pipeline/principles-v1.json"), "utf8")) as Principles;
  const cases = inv.cases.map((c) => {
    const views = c.form === "static_concept_image" ? ["concept"] : [...(c.has_desktop ? ["desktop"] : []), ...(c.has_mobile ? ["mobile"] : [])];
    const repoFiles = c.originals.filter((o) => o.in_repo_path);
    const text = {
      chatgpt_viewed: pr.cases.some((p) => p.id === c.id && p.evidence.includes("chatgpt_viewed")),
      case_note: readdirSync(join(REPO, "design-library/success-cases")).some((f) => f.startsWith(`${c.id}-`) && f.endsWith(".md")),
    };
    const modes: Record<string, VisualMode> = {};
    for (const v of views.length ? views : ["concept"]) modes[v] = visualMode(reads.filter((r) => r.case_id === c.id && r.view === v && r.check.ok).length, text);
    return {
      id: c.id,
      form: c.form,
      available_for_Claude_visual_read: repoFiles.map((o) => `${o.view}:${o.in_repo_path}`),
      read_by_Claude: reads.filter((r) => r.case_id === c.id && r.check.ok).map((r) => r.view),
      text,
      modes,
    };
  });
  const count = (m: VisualMode) => cases.reduce((n, c) => n + Object.values(c.modes).filter((x) => x === m).length, 0);
  return `${JSON.stringify(
    {
      schema: "visual_read_matrix_v1",
      note: "Only Claude's own passing viewing record makes a view VISUAL_VERIFIED. Another AI's viewing summary or a case note is TEXT_ONLY_PROVISIONAL. Originals kept in the git-ignored .intake/ folder are not available in CI, so their reads verify only where the file is.",
      counts: { VISUAL_VERIFIED: count("VISUAL_VERIFIED"), TEXT_ONLY_PROVISIONAL: count("TEXT_ONLY_PROVISIONAL"), MISSING_OR_HOLD: count("MISSING_OR_HOLD") },
      cases,
    },
    null,
    2,
  )}\n`;
}

if (require.main === module) {
  const reads = checkAllReads();
  for (const r of reads) process.stdout.write(`${r.check.ok ? "READ_OK" : `READ_FAIL ${r.check.codes.join(",")}`} ${r.file}\n`);
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
    process.exit(reads.some((r) => !r.check.ok) || stale ? 1 : 0);
  }
  writeFileSync(join(REPO, OUT), text);
  process.stdout.write(`${OUT}\n`);
}
