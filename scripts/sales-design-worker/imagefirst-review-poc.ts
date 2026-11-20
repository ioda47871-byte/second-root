/**
 * Issue #302 P3: the DUMMY proof that a private, verified IMAGE_FIRST bundle can be handed to the owner's LOCAL jailed
 * Claude Code (Remote Control) and read there (docs/operations/imagefirst-review-handoff.md). Harmless synthetic images
 * only: no Codex, no model, no image tool, no network, no shop content.
 *
 *   node --import tsx scripts/sales-design-worker/imagefirst-review-poc.ts [--inbox <dir>]
 *
 * Run as the worker user (sr-designgen, the same user the jailed Claude runs as), e.g. from the root-only admin clone:
 *   sudo bash /root/sr-capture-admin/scripts/sales-design-capture/admin.sh run sr-designgen -- \
 *     bash -c 'cd ~/work/second-root && node --import tsx scripts/sales-design-worker/imagefirst-review-poc.ts'
 *
 * The dummy run, its bundle and the delivery state go to a fresh 0700 temporary directory (removed at the end); the
 * delivered copy and its previews go to the inbox, by default ~/sr-runs/review-inbox (0700; ~/sr-runs is created 0700
 * when missing, as the worker does). An inbox inside this repository is refused. The last section of the output says
 * what each dummy picture shows: it is for the owner's eyes (the evidence), never for the Claude session.
 *
 * Exit: 0 delivered and previews built, 2 refused (usage, inbox inside the repository), 1 stopped (a code is printed).
 */
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { REVIEW_INBOX } from "../../lib/design-agent/imagefirst-worker/local-inbox";
import { runReviewPoc } from "../../lib/design-agent/imagefirst-worker/review-poc";

process.umask(0o077);
const REPO = resolve(__dirname, "../..");

/** A path with links resolved as far as it exists (the part that does not exist yet is kept as written). */
async function real(p: string): Promise<string> {
  const abs = resolve(p);
  const r = await realpath(abs).catch(() => null);
  if (r) return r;
  const parent = dirname(abs);
  return parent === abs ? abs : join(await real(parent), relative(parent, abs));
}
const within = (child: string, parent: string) => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  let inbox = join(homedir(), "sr-runs", REVIEW_INBOX);
  if (args.length === 2 && args[0] === "--inbox" && args[1]) inbox = resolve(args[1]);
  else if (args.length !== 0) return (console.log("IMAGEFIRST_REVIEW_POC USAGE: imagefirst-review-poc.ts [--inbox <dir>]"), 2);
  const repo = await real(REPO);
  if (within(await real(inbox), repo)) return (console.log("IMAGEFIRST_REVIEW_POC INBOX_INSIDE_REPO: the inbox must be outside the repository"), 2);
  const base = await real(tmpdir());
  if (within(base, repo)) return (console.log("IMAGEFIRST_REVIEW_POC WORK_INSIDE_REPO: the temporary directory is inside the repository"), 2);
  // the default inbox's parent (~/sr-runs) is created private when missing, exactly as the worker creates it
  if (args.length === 0 && !(await lstat(dirname(inbox)).then(() => true, () => false))) await mkdir(dirname(inbox), { mode: 0o700 });

  const work = await mkdtemp(join(base, "sr-review-poc-"));
  try {
    await chmod(work, 0o700);
    const r = await runReviewPoc({ workDir: work, inboxDir: inbox });
    if (r.delivery.state !== "delivered" || !r.previews || !r.bundleDir) {
      console.log(`IMAGEFIRST_REVIEW_POC NOT_DELIVERED code=${r.delivery.code ?? "none"}`);
      return 1;
    }
    const lines = [
      `IMAGEFIRST_REVIEW_POC DELIVERED bundle=${r.delivery.job.bundle_id} sha256=${r.bundle_sha256} previews=${r.previews.status}`,
      `inbox bundle: ${r.bundleDir}`,
      `previews:     ${r.previews.dir}`,
      "",
      "--- INDEX.md ---",
      await readFile(join(r.previews.dir, "INDEX.md"), "utf8"),
      "--- what to ask the Claude session (Remote Control) ---",
      `Use only the Read tool. Read each of these files and, for each, tell me the background colour, the white shape and the 4-digit number:`,
      ...r.previews.index.previews.filter((p) => p.kind === "full" && p.source.startsWith("parts/")).map((p) => `  ${join(r.previews!.dir, p.file)}`),
      "",
      "--- OWNER ONLY: the answers (do not paste these into the Claude session) ---",
      ...r.challenges.map((c) => `  ${c.part}: background ${c.colour}, ${c.shape}, number ${c.number}`),
    ];
    console.log(lines.join("\n"));
    return 0;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    console.log(`IMAGEFIRST_REVIEW_POC STOPPED code=${typeof code === "string" && /^[A-Z_]+$/.test(code) ? code : (error as Error).message === "WORK_DIR_UNSAFE" ? "WORK_DIR_UNSAFE" : "UNEXPECTED"}`);
    return 1;
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().then((c) => process.exit(c), () => process.exit(1));
