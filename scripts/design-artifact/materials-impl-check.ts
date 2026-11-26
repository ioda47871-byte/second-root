/**
 * DEV-303 §6.1 change 7 CLI — OFFLINE, READ-ONLY: stage 4 → 5. The owner-approved image materials of a materials run
 * (lib/design-agent/imagefirst-worker/materials-approval.ts), and optionally an implemented site checked against them
 * (materials-impl-check.ts: only approved pictures, by SHA-256; no external picture; the イメージ label).
 *
 *   npx tsx scripts/design-artifact/materials-impl-check.ts \
 *     --design-bundle <review-inbox/<design id>> --design-review <review.json> --design-approval <approval.json> \
 *     --materials-bundle <review-inbox/<materials id>> --materials-review <materials-review.json> \
 *     [--materials-approval <materials-approval.json>] [--site <site dir>]
 *
 * Without --materials-approval: the review alone (draft; what the owner is about to decide on). With it: the gate (the
 * approved materials). With --site as well: the site check. These write nothing. Prints JSON.
 *
 *   ... materials-impl-check.ts --page <the five records above> --out <private empty dir outside the repo>
 *
 * --page writes the owner's viewing page (index.html + images/, the review's verdicts and notes, never the approval) and
 * prints its page_sha256 and the review_sha256 that the approval record must carry.
 *
 * Exit: 0 ok (draft read, gate passed, or site ok), 1 stopped or refused (a named code), 2 bad arguments.
 */
import { resolve } from "node:path";
import { approvedMaterials, checkMaterialsApproval, MaterialsApprovalStop, writeMaterialsReviewPage } from "../../lib/design-agent/imagefirst-worker/materials-approval";
import { checkMaterialsInSite, MaterialsImplStop } from "../../lib/design-agent/imagefirst-worker/materials-impl-check";

const REPO = resolve(__dirname, "../..");
const say = (o: object) => process.stdout.write(`${JSON.stringify(o, null, 2)}\n`);
const KEYS = ["--design-bundle", "--design-review", "--design-approval", "--materials-bundle", "--materials-review", "--materials-approval", "--site", "--out"] as const;
const REQUIRED = KEYS.slice(0, 5);

export function parseMaterialsArgs(argv: string[]): (Partial<Record<(typeof KEYS)[number], string>> & { page: boolean }) | null {
  const o: Partial<Record<(typeof KEYS)[number], string>> & { page: boolean } = { page: false };
  const rest = [...argv];
  // --page (a flag): write the owner's viewing page to --out (the review alone, before any approval)
  if (rest[0] === "--page") {
    rest.shift();
    o.page = true;
  }
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i] as (typeof KEYS)[number];
    const v = rest[i + 1];
    if (!k || !v || v.startsWith("--") || !KEYS.includes(k) || k in o) return null;
    o[k] = resolve(v);
  }
  if (REQUIRED.some((k) => !o[k])) return null;
  if (o["--site"] && !o["--materials-approval"]) return null;
  if (o.page !== !!o["--out"] || (o.page && (o["--materials-approval"] || o["--site"]))) return null;
  return o;
}

export async function materialsMain(argv: string[], repoRoot: string = REPO): Promise<number> {
  const a = parseMaterialsArgs(argv);
  if (!a) return (say({ status: "refused", code: "ARGS_INVALID" }), 2);
  const design = { bundleDir: a["--design-bundle"]!, reviewPath: a["--design-review"]!, approvalPath: a["--design-approval"]! };
  const common = { design, bundleDir: a["--materials-bundle"]!, reviewPath: a["--materials-review"]!, repo: repoRoot };
  try {
    if (a.page) {
      const c = await checkMaterialsApproval({ ...common, mode: "draft" });
      const w = await writeMaterialsReviewPage(c.review, c.run, { outDir: a["--out"]!, repo: repoRoot });
      say({ status: "page_written", page: w.page, page_sha256: w.page_sha256, review_sha256: c.review_sha256, request_id: c.request_id, ...(c.synthetic ? { synthetic: true } : {}) });
      return 0;
    }
    if (!a["--materials-approval"]) {
      const c = await checkMaterialsApproval({ ...common, mode: "draft" });
      say({ status: "draft", request_id: c.request_id, bundle_sha256: c.bundle_sha256, review_sha256: c.review_sha256, page_sha256: c.page_sha256, verdicts: c.verdicts, design: { request_id: c.design.request_id, approval_sha256: c.design.approval_sha256 }, ...(c.synthetic ? { synthetic: true } : {}) });
      return 0;
    }
    const approved = await approvedMaterials({ ...common, approvalPath: a["--materials-approval"] });
    const summary = { request_id: approved.request_id, approval_sha256: approved.approval_sha256, materials: approved.materials.map((m) => ({ id: m.id, file: m.file, sha256: m.sha256 })) };
    if (!a["--site"]) return (say({ status: "approved", ...summary }), 0);
    const r = await checkMaterialsInSite({ approved, siteDir: a["--site"], repo: repoRoot });
    say({ ...r, site_files: r.site_files.length });
    return r.status === "ok" ? 0 : 1;
  } catch (error) {
    if (error instanceof MaterialsApprovalStop || error instanceof MaterialsImplStop) return (say({ status: "stopped", code: error.code }), 1);
    throw error;
  }
}

if (require.main === module)
  materialsMain(process.argv.slice(2)).then(
    (code) => process.exit(code),
    () => {
      say({ status: "refused", code: "REFUSED" });
      process.exit(2);
    },
  );
