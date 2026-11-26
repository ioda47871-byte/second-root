/**
 * DEV-364 PR 3a CLI — OFFLINE: the second (photo-included) review (`sr_final_review_v1`) and the owner's approval
 * (`sr_final_approval_v1`) of a finished site (lib/design-agent/imagefirst-worker/final-approval.ts;
 * docs/design/quality-proof-plan.md §3.3).
 *
 *   npx tsx scripts/design-artifact/final-approval-check.ts --check <inputs> --review <review.json> [--approval <approval.json>] [--draft]
 *   npx tsx scripts/design-artifact/final-approval-check.ts --page  <inputs> --review <review.json> --out <private dir>
 *
 *   <inputs>  --design-bundle <review-inbox/<id>> --design-review <f> --design-approval <f>   (the first approval)
 *             [--materials-bundle <dir> --materials-review <f> --materials-approval <f>]     (needed when an A picture is shown)
 *             --slots <photo-slots.json> --provenance <private dir> --site <staged site> --impl-compare <comparison dir>
 *
 * --check  every SHA-256 the review names is recomputed from the files; gate mode (the default) also needs the approval,
 *          bound to all of them, decision approve, no axis `fail`, no major composition change, not synthetic. --draft
 *          checks the review alone (and the approval's binding when one is given, without asking for approve).
 * --page   the owner's private viewing page (static HTML, no script, no network; CSP; captures and pictures copied next
 *          to it) written to --out (outside this repository; empty or absent). The printed page_sha256 and review_sha256
 *          are what Claude records in the approval — only when the owner has decided, and never as the owner's signature.
 *
 * Every record and folder must be OUTSIDE this repository. Only --page writes, and only into --out.
 * Exit: 0 passed / page written, 1 stopped (a named code), 2 refused (bad arguments).
 */
import { resolve } from "node:path";
import { checkFinalApproval, FinalApprovalStop, writeFinalReviewPage, type FinalInputs } from "../../lib/design-agent/imagefirst-worker/final-approval";

const REPO = resolve(__dirname, "../..");
const say = (o: object) => process.stdout.write(`${JSON.stringify(o, null, 2)}\n`);

const VALUE_FLAGS = ["--design-bundle", "--design-review", "--design-approval", "--materials-bundle", "--materials-review", "--materials-approval", "--slots", "--provenance", "--site", "--impl-compare", "--review", "--approval", "--out"] as const;
type Args = { mode: "check" | "page"; inputs: FinalInputs; review: string; approval?: string; out?: string; draft: boolean };

export function parseFinalApprovalArgs(argv: string[]): Args | null {
  const flags = new Set<string>();
  const o: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    if (["--check", "--page", "--draft"].includes(k)) {
      if (flags.has(k)) return null;
      flags.add(k);
      continue;
    }
    const v = argv[i + 1];
    if (!(VALUE_FLAGS as readonly string[]).includes(k) || !v || v.startsWith("--") || k in o) return null;
    o[k] = v;
    i++;
  }
  if (flags.has("--check") === flags.has("--page")) return null;
  for (const k of ["--design-bundle", "--design-review", "--design-approval", "--slots", "--provenance", "--site", "--impl-compare", "--review"]) if (!o[k]) return null;
  const m = ["--materials-bundle", "--materials-review", "--materials-approval"].filter((k) => o[k]);
  if (m.length !== 0 && m.length !== 3) return null;
  const inputs: FinalInputs = {
    design: { bundleDir: resolve(o["--design-bundle"]!), reviewPath: resolve(o["--design-review"]!), approvalPath: resolve(o["--design-approval"]!) },
    ...(m.length ? { materials: { bundleDir: resolve(o["--materials-bundle"]!), reviewPath: resolve(o["--materials-review"]!), approvalPath: resolve(o["--materials-approval"]!) } } : {}),
    slotsPath: resolve(o["--slots"]!),
    provenanceDir: resolve(o["--provenance"]!),
    siteDir: resolve(o["--site"]!),
    implCompareDir: resolve(o["--impl-compare"]!),
  };
  if (flags.has("--check")) return o["--out"] ? null : { mode: "check", inputs, review: resolve(o["--review"]!), ...(o["--approval"] ? { approval: resolve(o["--approval"]) } : {}), draft: flags.has("--draft") };
  return flags.has("--draft") || o["--approval"] || !o["--out"] ? null : { mode: "page", inputs, review: resolve(o["--review"]!), out: resolve(o["--out"]), draft: false };
}

export async function finalApprovalMain(argv: string[], repoRoot: string = REPO): Promise<number> {
  const args = parseFinalApprovalArgs(argv);
  if (!args) return (say({ status: "refused", code: "ARGS_INVALID" }), 2);
  try {
    if (args.mode === "page") {
      // one read: the same checks as --check --draft, and the page rendered from exactly the bytes whose SHA-256 is printed
      const c = await checkFinalApproval({ ...args.inputs, reviewPath: args.review, repo: repoRoot, mode: "draft" });
      const w = await writeFinalReviewPage(c.review, c.evidence, { outDir: args.out!, repo: repoRoot });
      say({ status: "page_written", page: w.page, page_sha256: w.page_sha256, review_sha256: c.review_sha256, build_files_sha256: c.build_files_sha256, design: c.design, verdicts: c.verdicts, route: c.route, ...(c.synthetic ? { synthetic: true } : {}) });
      return 0;
    }
    const c = await checkFinalApproval({ ...args.inputs, reviewPath: args.review, repo: repoRoot, mode: args.draft ? "draft" : "gate", ...(args.approval ? { approvalPath: args.approval } : {}) });
    say({ status: "passed", mode: args.draft ? "draft" : "gate", design: c.design, review_sha256: c.review_sha256, page_sha256: c.page_sha256, build_files_sha256: c.build_files_sha256, verdicts: c.verdicts, route: c.route, approval: c.approval, ...(c.synthetic ? { synthetic: true } : {}) });
    return 0;
  } catch (error) {
    if (!(error instanceof FinalApprovalStop)) throw error;
    say({ status: "stopped", code: error.code });
    return 1;
  }
}

if (require.main === module)
  finalApprovalMain(process.argv.slice(2)).then(
    (code) => process.exit(code),
    () => {
      say({ status: "refused", code: "REFUSED" });
      process.exit(2);
    },
  );
