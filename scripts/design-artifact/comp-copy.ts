/**
 * DEV-199b (owner Issue #258, 2/3): the copy quality audit in the comp lane, offline. No network, no model.
 *
 *   npx tsx scripts/design-artifact/comp-copy.ts --audit  <comp dir> --facts <facts-pack.json>
 *   npx tsx scripts/design-artifact/comp-copy.ts --revise <comp dir> --facts <facts-pack.json>
 *   npx tsx scripts/design-artifact/comp-copy.ts --gate   <comp dir> --facts <facts-pack.json>
 *   (any mode) --ja-renderings <ja-renderings.json>   DEV-303 §6.1 change 4: the shop's owner-approved Japanese renderings
 *     (`sr_ja_renderings_v1`, private, checked in gate mode against the facts pack). A copy item of claim_type
 *     approved_rendering is accepted only when its text equals the approved ja_text of its one fact's key; every other
 *     text is judged as before. The review binds the record's SHA-256 (ja_renderings_sha256).
 *
 * Files of a comp (beside copy.json, index.html, style.css):
 *   copy-review.json                          the audit (copy_quality_review_v1) of the current files
 *   copy-rounds/<i>/{copy.json,index.html,style.css,copy-review.json}
 *                                             the earlier rounds of the revision chain, in order (i = 0 … n-1)
 *
 * --audit runs the existing audit (reviewCopyQuality) on the current files as the next round of the chain and writes
 *   copy-review.json. It refuses to replace a review of other files of the same chain: a changed page is revised as a
 *   new round (--revise), never re-audited in place as if it were new (the store's append-only rule, DEV-199a).
 * --revise starts the next round when the gate says `revise` (never after hold or fail, never past the cap): the current
 *   files and their review move into copy-rounds/<n>/ and the files stay in place to be edited (words only: a changed
 *   structure, attribute or CSS keeps the round from approve_candidate). Then edit and --audit again; every revision
 *   is checked by validateCopyRevision and the re-run audit of the whole chain.
 * --gate prints the gate (lib/design-agent/quality-pipeline/comp-copy-gate.ts); --audit prints it too. Exit 0 only at
 *   owner review.
 *
 * The comp lane's own `--check-review` refuses a `show_owner` comp review whose copy is not at owner review
 * (comp-lane.ts checkReviewFile). Exit 0 / 1 as above, 2 for a usage or input error.
 */
import { closeSync, constants, copyFileSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { compCopyGate, type CompCopyGate } from "../../lib/design-agent/quality-pipeline/comp-copy-gate";
import { CopyQualityReview, JA_RENDERINGS_MAX_BYTES, MAX_COPY_REVISION_ROUNDS, reviewCopyQuality, type CopyQualityFiles, type PriorRound } from "../../lib/design-agent/quality-pipeline/copy-quality-review";

export const COPY_REVIEW_FILE = "copy-review.json";
export const COPY_ROUNDS_DIR = "copy-rounds";
const PAGE_FILES = ["copy.json", "index.html", "style.css"] as const;

export class CompCopyError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
const parse = (b: Buffer): unknown => {
  try {
    return JSON.parse(b.toString("utf8"));
  } catch {
    return null;
  }
};

const REPO = resolve(__dirname, "../..");
const within = (child: string, parent: string) => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/**
 * Review L5: the shop's renderings record, read as ja-renderings-check.ts reads it: outside this repository (links
 * resolved), a regular file opened without following a link, at most JA_RENDERINGS_MAX_BYTES. Fixed codes otherwise.
 */
export function readRenderingsFile(path: string, repoRoot: string = REPO): Buffer {
  const full = resolve(path);
  let real: string;
  try {
    real = realpathSync(full);
  } catch {
    throw new CompCopyError("JA_RENDERINGS_RECORD_MISSING");
  }
  const repo = (() => {
    try {
      return realpathSync(repoRoot);
    } catch {
      return resolve(repoRoot);
    }
  })();
  if (within(real, repo) || within(full, resolve(repoRoot))) throw new CompCopyError("JA_RENDERINGS_RECORD_IN_REPO");
  let fd: number;
  try {
    fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw new CompCopyError("JA_RENDERINGS_RECORD_UNSAFE");
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) throw new CompCopyError("JA_RENDERINGS_RECORD_UNSAFE");
    if (st.size > JA_RENDERINGS_MAX_BYTES) throw new CompCopyError("JA_RENDERINGS_TOO_LARGE");
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    return buf.subarray(0, off);
  } finally {
    closeSync(fd);
  }
}

/** The current files of a comp with the facts pack given (bytes as read). */
export function compFiles(dir: string, factsPath: string, jaRenderingsPath?: string): CopyQualityFiles {
  return {
    factsPack: readFileSync(factsPath),
    copyRecord: readFileSync(join(dir, "copy.json")),
    pageHtml: readFileSync(join(dir, "index.html")),
    pageCss: readFileSync(join(dir, "style.css")),
    ...(jaRenderingsPath !== undefined ? { jaRenderings: readRenderingsFile(jaRenderingsPath) } : {}),
  };
}

/** The earlier rounds in copy-rounds/0 … n-1 (contiguous, each complete); anything else is malformed. */
export function compPriorRounds(dir: string): PriorRound[] {
  const root = join(dir, COPY_ROUNDS_DIR);
  if (!existsSync(root)) return [];
  const names = readdirSync(root).sort();
  if (names.length > MAX_COPY_REVISION_ROUNDS || names.some((n, i) => n !== String(i))) throw new CompCopyError("COPY_ROUNDS_MALFORMED");
  return names.map((n) => {
    const d = join(root, n);
    for (const f of [...PAGE_FILES, COPY_REVIEW_FILE]) if (!existsSync(join(d, f))) throw new CompCopyError("COPY_ROUNDS_MALFORMED");
    return { review: parse(readFileSync(join(d, COPY_REVIEW_FILE))), copyRecord: readFileSync(join(d, "copy.json")), pageHtml: readFileSync(join(d, "index.html")), pageCss: readFileSync(join(d, "style.css")), ownerRevision: null };
  });
}

/** The gate of a comp's copy now. */
export function checkCompCopy(dir: string, factsPath: string, jaRenderingsPath?: string): CompCopyGate {
  const file = join(dir, COPY_REVIEW_FILE);
  return compCopyGate({ files: compFiles(dir, factsPath, jaRenderingsPath), review: existsSync(file) ? parse(readFileSync(file)) : null, previous: compPriorRounds(dir) });
}

/** Audit the current files as the next round and write copy-review.json; returns the gate of what was written. */
export function auditCompCopy(dir: string, factsPath: string, jaRenderingsPath?: string): CompCopyGate {
  const files = compFiles(dir, factsPath, jaRenderingsPath);
  const previous = compPriorRounds(dir);
  const file = join(dir, COPY_REVIEW_FILE);
  const review = reviewCopyQuality(files, { round: previous.length, previousCopySha256: prevCopy(previous), earlierRounds: previous });
  if (existsSync(file)) {
    const old = CopyQualityReview.safeParse(parse(readFileSync(file)));
    // the same files again: the audit is deterministic, nothing changes. Other files of the same facts: a revision.
    if (old.success && old.data.facts_content_sha256 === review.facts_content_sha256) {
      const same = old.data.copy_sha256 === review.copy_sha256 && old.data.page_html_sha256 === review.page_html_sha256 && old.data.page_css_sha256 === review.page_css_sha256 && old.data.facts_sha256 === review.facts_sha256 && old.data.ja_renderings_sha256 === review.ja_renderings_sha256;
      if (!same) throw new CompCopyError("COPY_REVIEW_EXISTS_FOR_OTHER_FILES");
    } else if (previous.length) throw new CompCopyError("COPY_ROUNDS_FOR_OTHER_FACTS");
  }
  writeFileSync(file, json(review));
  return compCopyGate({ files, review, previous });
}

/** Start the next round: only when the gate says revise. Moves the current round into copy-rounds/<n>/. */
export function startCompCopyRevision(dir: string, factsPath: string, jaRenderingsPath?: string): { round: number } {
  const gate = checkCompCopy(dir, factsPath, jaRenderingsPath);
  if (gate.step !== "revise") throw new CompCopyError(gate.step === "refused" ? "COPY_REVIEW_REFUSED" : `COPY_NOT_REVISABLE_${gate.step.toUpperCase()}`);
  const n = compPriorRounds(dir).length;
  const target = join(dir, COPY_ROUNDS_DIR, String(n));
  if (existsSync(target)) throw new CompCopyError("COPY_ROUNDS_MALFORMED");
  mkdirSync(target, { recursive: true });
  for (const f of PAGE_FILES) copyFileSync(join(dir, f), join(target, f));
  renameSync(join(dir, COPY_REVIEW_FILE), join(target, COPY_REVIEW_FILE));
  return { round: n + 1 };
}

function prevCopy(previous: readonly PriorRound[]): string | null {
  const last = previous.at(-1);
  if (!last) return null;
  const p = CopyQualityReview.safeParse(last.review);
  if (!p.success) throw new CompCopyError("COPY_ROUNDS_MALFORMED");
  return p.data.copy_sha256;
}

function main(): number {
  const arg = (k: string) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const facts = arg("--facts");
  const ja = arg("--ja-renderings");
  if (process.argv.includes("--ja-renderings") && !ja) {
    process.stderr.write("USAGE: --ja-renderings <ja-renderings.json>\n");
    return 2;
  }
  const jaPath = ja ? resolve(ja) : undefined;
  const [mode, dir] = (["--audit", "--revise", "--gate"] as const).map((m) => [m, arg(m)] as const).find(([, d]) => d) ?? [];
  if (!mode || !dir || !facts) {
    process.stderr.write("USAGE: --audit|--revise|--gate <comp dir> --facts <facts-pack.json>\n");
    return 2;
  }
  try {
    const d = resolve(dir);
    if (mode === "--revise") {
      process.stdout.write(`${JSON.stringify(startCompCopyRevision(d, resolve(facts), jaPath))}\n`);
      return 0;
    }
    const gate = mode === "--audit" ? auditCompCopy(d, resolve(facts), jaPath) : checkCompCopy(d, resolve(facts), jaPath);
    process.stdout.write(json(gate));
    return gate.mayShowOwner ? 0 : 1;
  } catch (e) {
    process.stderr.write(`INPUT_ERROR: ${(e as Error).message}\n`);
    return 2;
  }
}

if (require.main === module) process.exit(main());
