/**
 * DEV-303 Issue #336 CLI — OFFLINE: checks a shop's private success-case analysis record (`sr_case_study_v1`,
 * docs/design/image-first-production-flow.md §1 stage 1, §3.1) and writes the owner's viewing page.
 *
 *   npx tsx scripts/design-artifact/case-study-check.ts --check <case-study.json> [--draft]
 *   npx tsx scripts/design-artifact/case-study-check.ts --page <case-study.json> --out <private dir>
 *
 * --check  every viewed file exists with its SHA-256, and at least 3 originals count (image / page_render of an
 *          originals-index id with counts_as_reference, or a private_verified private original). Gate mode (the
 *          default; what request mode runs) also needs owner_confirmation whose selected_ids are exactly the counted
 *          ids. --draft skips the owner confirmation (the analysis before the owner has seen the page).
 * --page   the same file checks (no count or confirmation needed: the owner sees what is missing), then a static local
 *          HTML (no script, no network, no external font) with the viewed images copied next to it, written to --out
 *          (outside this repository, empty or absent). Open <out>/index.html in a browser.
 *
 * The record must be OUTSIDE this repository (e.g. ~/second-root-shops/<shop_id>/case-study.json). Repo-relative file
 * paths in it resolve against this repository. Only --page writes, and only into --out.
 *
 * Exit: 0 passed / page written, 1 stopped (a named CASE_STUDY_* code), 2 refused (bad arguments, the record in the
 * repository, unreadable).
 */
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { assertCaseStudyGate, CASE_STUDY_MAX_BYTES, inspectCaseStudy, writeViewingPage, type CaseStudyInspection } from "../../lib/design-agent/image-first/case-study";
import { PromptStop } from "../../lib/design-agent/image-first/prompt";

const REPO = resolve(__dirname, "../..");
const say = (o: object) => process.stdout.write(`${JSON.stringify(o, null, 2)}\n`);
const refuse = (code: string) => (say({ status: "refused", code }), 2);
const within = (child: string, parent: string) => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

type Args = { mode: "check"; file: string; draft: boolean } | { mode: "page"; file: string; out: string };
export function parseCaseStudyArgs(argv: string[]): Args | null {
  const o: Record<string, string> = {};
  let draft = false;
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    if (k === "--draft") {
      if (draft) return null;
      draft = true;
      continue;
    }
    const v = argv[i + 1];
    if (!["--check", "--page", "--out"].includes(k) || !v || v.startsWith("--") || k in o) return null;
    o[k] = v;
    i++;
  }
  if (!!o["--check"] === !!o["--page"]) return null;
  if (o["--check"]) return o["--out"] ? null : { mode: "check", file: resolve(o["--check"]), draft };
  return draft || !o["--out"] ? null : { mode: "page", file: resolve(o["--page"]!), out: resolve(o["--out"]) };
}

const summary = (i: CaseStudyInspection) => ({ shop_id: i.shop_id, case_study_sha256: i.case_study_sha256, counted: i.counted, not_counted: i.not_counted, owner_confirmed: i.owner_confirmed });

export async function caseStudyMain(argv: string[], repoRoot: string = REPO): Promise<number> {
  const args = parseCaseStudyArgs(argv);
  if (!args) return refuse("ARGS_INVALID");
  const repo = await realpath(repoRoot).catch(() => repoRoot);
  const real = await realpath(args.file).catch(() => null);
  if (real === null) return refuse("CASE_STUDY_RECORD_MISSING");
  // a shop's analysis is private: never read from (or encouraged into) this public repository
  if (within(real, repo) || within(args.file, repoRoot)) return refuse("CASE_STUDY_RECORD_IN_REPO");
  let bytes: Buffer;
  try {
    const h = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const st = await h.stat();
      if (!st.isFile()) return refuse("CASE_STUDY_RECORD_UNSAFE");
      if (st.size > CASE_STUDY_MAX_BYTES) return refuse("CASE_STUDY_TOO_LARGE");
      bytes = await h.readFile();
    } finally {
      await h.close();
    }
  } catch {
    return refuse("CASE_STUDY_RECORD_UNREADABLE");
  }
  let inspection: CaseStudyInspection | null = null;
  try {
    inspection = await inspectCaseStudy(bytes, { repo });
    if (args.mode === "check") {
      assertCaseStudyGate(inspection, args.draft ? "draft" : "gate");
      say({ status: "passed", mode: args.draft ? "draft" : "gate", ...summary(inspection) });
      return 0;
    }
    const written = await writeViewingPage(inspection, { outDir: args.out, repo });
    say({ status: "page_written", page: written.page, images: written.images.length, ...summary(inspection) });
    return 0;
  } catch (error) {
    if (!(error instanceof PromptStop)) throw error;
    say({ status: "stopped", code: error.code, ...(inspection ? summary(inspection) : {}) });
    return 1;
  }
}

if (require.main === module)
  caseStudyMain(process.argv.slice(2)).then(
    (code) => process.exit(code),
    () => {
      say({ status: "refused", code: "REFUSED" });
      process.exit(2);
    },
  );
