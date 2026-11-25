/**
 * DEV-303 §6.1 change 5 CLI — OFFLINE: the design review (`sr_design_review_v1`) and the owner's approval
 * (`sr_design_approval_v1`) of a delivered IMAGE_FIRST design run (lib/design-agent/imagefirst-worker/design-approval.ts;
 * docs/design/image-first-production-flow.md §1 stage 3, §3.3).
 *
 *   npx tsx scripts/design-artifact/design-approval-check.ts --check --bundle <review-inbox/<id>> --review <review.json> [--approval <approval.json>] [--draft]
 *   npx tsx scripts/design-artifact/design-approval-check.ts --page  --bundle <review-inbox/<id>> --review <review.json> --out <private dir>
 *
 * --check  the bundle verifies; the review names exactly its PC / SP images with their SHA-256s and carries the five
 *          axes, each with evidence. Gate mode (the default; what later stages run) also needs the approval: bound to
 *          the review's SHA-256, the page's SHA-256 and the same images, decision approve, no axis `fail`. --draft
 *          checks the review alone (and the approval's binding when one is given, without asking for approve).
 * --page   the review's owner viewing page (static HTML, no script, no network; CSP; images copied next to it) written
 *          to --out (outside this repository; empty or absent). The printed page_sha256 is what Claude records in the
 *          approval with the printed review_sha256 — only when the owner has decided, and never as the owner's signature.
 *
 * Both records must be OUTSIDE this repository. Only --page writes, and only into --out.
 *
 * Exit: 0 passed / page written, 1 stopped (a named DESIGN_* code), 2 refused (bad arguments).
 */
import { resolve } from "node:path";
import { checkDesignApproval, DesignApprovalStop, writeDesignReviewPage } from "../../lib/design-agent/imagefirst-worker/design-approval";

const REPO = resolve(__dirname, "../..");
const say = (o: object) => process.stdout.write(`${JSON.stringify(o, null, 2)}\n`);

type Args = { mode: "check"; bundle: string; review: string; approval?: string; draft: boolean } | { mode: "page"; bundle: string; review: string; out: string };
export function parseDesignApprovalArgs(argv: string[]): Args | null {
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
    if (!["--bundle", "--review", "--approval", "--out"].includes(k) || !v || v.startsWith("--") || k in o) return null;
    o[k] = v;
    i++;
  }
  if (flags.has("--check") === flags.has("--page") || !o["--bundle"] || !o["--review"]) return null;
  if (flags.has("--check")) return o["--out"] ? null : { mode: "check", bundle: resolve(o["--bundle"]), review: resolve(o["--review"]), ...(o["--approval"] ? { approval: resolve(o["--approval"]) } : {}), draft: flags.has("--draft") };
  return flags.has("--draft") || o["--approval"] || !o["--out"] ? null : { mode: "page", bundle: resolve(o["--bundle"]), review: resolve(o["--review"]), out: resolve(o["--out"]) };
}

export async function designApprovalMain(argv: string[], repoRoot: string = REPO): Promise<number> {
  const args = parseDesignApprovalArgs(argv);
  if (!args) return (say({ status: "refused", code: "ARGS_INVALID" }), 2);
  try {
    if (args.mode === "page") {
      // review L1: one read of the review and the bundle: the same checks as --check --draft, and the page rendered from
      // exactly the bytes whose SHA-256 is printed as review_sha256
      const c = await checkDesignApproval({ bundleDir: args.bundle, reviewPath: args.review, repo: repoRoot, mode: "draft" });
      const w = await writeDesignReviewPage(c.review, c.run, { outDir: args.out, repo: repoRoot });
      say({ status: "page_written", page: w.page, page_sha256: w.page_sha256, review_sha256: c.review_sha256, request_id: c.request_id, bundle_sha256: c.bundle_sha256, verdicts: c.verdicts });
      return 0;
    }
    const c = await checkDesignApproval({ bundleDir: args.bundle, reviewPath: args.review, repo: repoRoot, mode: args.draft ? "draft" : "gate", ...(args.approval ? { approvalPath: args.approval } : {}) });
    say({ status: "passed", mode: args.draft ? "draft" : "gate", request_id: c.request_id, bundle_sha256: c.bundle_sha256, review_sha256: c.review_sha256, page_sha256: c.page_sha256, verdicts: c.verdicts, approval: c.approval });
    return 0;
  } catch (error) {
    if (!(error instanceof DesignApprovalStop)) throw error;
    say({ status: "stopped", code: error.code });
    return 1;
  }
}

if (require.main === module)
  designApprovalMain(process.argv.slice(2)).then(
    (code) => process.exit(code),
    () => {
      say({ status: "refused", code: "REFUSED" });
      process.exit(2);
    },
  );
