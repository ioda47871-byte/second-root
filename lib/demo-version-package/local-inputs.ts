/**
 * DEV-263a (Issue #263): the local inputs of a sendable, photo-less demo version — read by the local package / import
 * CLIs (scripts/sales/demo-version/package-local.ts --copy, import-local.ts --trusted-facts) and nothing else.
 *
 *   - compCopyInput: a comp directory's copy (copy.json, copy-review.json written by scripts/design-artifact/comp-copy.ts
 *     --audit, and the earlier rounds in copy-rounds/<i>/) with the facts pack given, as the bytes buildPackage's `copy`
 *     takes. Nothing is audited here: buildPackage checks the copy again (verifyPackageCopy) and refuses what fails.
 *   - readCommittedFacts: the LOCAL facts path. The facts pack must be a file inside the repository, not a symbolic link,
 *     exactly the bytes committed at HEAD (an untracked, staged-only or edited file is refused) AND the same blob at
 *     origin/develop (PR #266 M1: a pack committed only on a local branch is refused; nothing is fetched, the local
 *     origin/develop ref is read). Those bytes are what the importer passes as `trustedFactsPack`.
 *   - assertDemoContentFromFacts: the demo row and the facts evidence share one origin — the demo's
 *     sales_demos.content must hold the sha256 of exactly these facts pack bytes (content.facts_pack_sha256, written by
 *     the seed) and equal the content derived from them (demoContentFromFacts, the derivation the 輪 seed has always
 *     used, here with every fact key mapped: an unmapped key is refused), compared as canonical JSON (jsonb does not keep
 *     key order). A 輪 demo (content.facts_pack = RIN_SHOP_ID) is refused: its photo packages are ai_demo_internal.
 *
 * This is the local facts path only. The hosted facts store (an append-only table written at registration) and the
 * send-time re-compare of the stored facts pack with the facts path are NOT here: both stay open owner-approval items
 * (.ai/reviews/DEV-263a.md).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { FactsPack } from "@/lib/design-agent/quality-pipeline/facts-pack";
import { demoContentFromFacts, RIN_SHOP_ID } from "./seed-rin";

export class LocalInputError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

/** The comp files of the copy (the names scripts/design-artifact/comp-copy.ts uses). */
export const COMP_COPY_REVIEW = "copy-review.json";
export const COMP_COPY_ROUNDS = "copy-rounds";
const MAX_ROUNDS = 9;

type Bytes = Uint8Array;
export type CompCopyInput = {
  html: string;
  css: string;
  copy: { factsPack: Bytes; copyRecord: Bytes; review: Bytes; rounds: Array<{ copyRecord: Bytes; pageHtml: Bytes; pageCss: Bytes; review: Bytes }> };
};

const bytes = (p: string, code: string): Bytes => {
  if (!existsSync(p) || !lstatSync(p).isFile()) throw new LocalInputError(code);
  return new Uint8Array(readFileSync(p));
};

/** A comp directory's page and copy (see the file comment). Refuses a missing copy record, review or facts pack. */
export function compCopyInput(dir: string, factsPath: string): CompCopyInput {
  const html = bytes(join(dir, "index.html"), "PAGE_HTML_MISSING");
  const css = bytes(join(dir, "style.css"), "PAGE_CSS_MISSING");
  const copyRecord = bytes(join(dir, "copy.json"), "COPY_RECORD_MISSING");
  const review = bytes(join(dir, COMP_COPY_REVIEW), "COPY_REVIEW_MISSING");
  const factsPack = bytes(factsPath, "FACTS_PACK_MISSING");
  const root = join(dir, COMP_COPY_ROUNDS);
  const names = existsSync(root) ? readdirSync(root).sort((a, b) => Number(a) - Number(b)) : [];
  if (names.length > MAX_ROUNDS || names.some((n, i) => n !== String(i))) throw new LocalInputError("COPY_ROUNDS_MALFORMED");
  const rounds = names.map((n) => {
    const d = join(root, n);
    const r = (f: string) => bytes(join(d, f), "COPY_ROUNDS_MALFORMED");
    return { copyRecord: r("copy.json"), pageHtml: r("index.html"), pageCss: r("style.css"), review: r(COMP_COPY_REVIEW) };
  });
  const utf8 = (b: Bytes) => new TextDecoder("utf-8", { fatal: true }).decode(b);
  return { html: utf8(html), css: utf8(css), copy: { factsPack, copyRecord, review, rounds } };
}

/** `git` in the repository, bytes out (fixed arguments, no shell). */
export type GitRunner = (args: string[]) => Buffer;
export const repoGit =
  (repo: string): GitRunner =>
  (args) =>
    execFileSync("git", args, { cwd: repo, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 8 * 1024 * 1024 });

/**
 * The branch whose blob the facts pack must be: the local remote-tracking ref, spelled out in full so a local branch
 * or tag named `origin/develop` can never stand in for it (DEV-263e, PR #266 review Low). Nothing is fetched.
 */
export const FACTS_BASE_REF = "refs/remotes/origin/develop";

/**
 * The facts pack from the local facts path: inside the repository, a regular file (no symbolic link anywhere on the
 * way), tracked, byte-identical to HEAD and the same blob at FACTS_BASE_REF (unless `requireBase` is false: the seed
 * reads a committed pack before it is on develop; the trusted import never does). Returns the committed bytes.
 */
export function readCommittedFacts(repo: string, path: string, o: { git?: GitRunner; requireBase?: boolean } = {}): Bytes {
  const git = o.git ?? repoGit(repo);
  const abs = resolve(repo, path);
  const repoReal = realpathSync(repo);
  const inside = (p: string, base: string) => {
    const rel = relative(base, p);
    return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
  };
  if (!inside(abs, resolve(repo))) throw new LocalInputError("TRUSTED_FACTS_OUTSIDE_REPO");
  if (!existsSync(abs)) throw new LocalInputError("TRUSTED_FACTS_MISSING");
  if (lstatSync(abs).isSymbolicLink()) throw new LocalInputError("TRUSTED_FACTS_SYMLINK");
  const real = realpathSync(abs);
  if (!inside(real, repoReal)) throw new LocalInputError("TRUSTED_FACTS_OUTSIDE_REPO");
  if (real !== join(repoReal, relative(resolve(repo), abs))) throw new LocalInputError("TRUSTED_FACTS_SYMLINK");
  if (!lstatSync(real).isFile()) throw new LocalInputError("TRUSTED_FACTS_MISSING");
  const rel = relative(repoReal, real).split(sep).join("/");
  let committed: Buffer;
  try {
    committed = git(["cat-file", "blob", `HEAD:${rel}`]);
  } catch {
    throw new LocalInputError("TRUSTED_FACTS_NOT_COMMITTED");
  }
  const onDisk = readFileSync(real);
  if (!committed.equals(onDisk)) throw new LocalInputError("TRUSTED_FACTS_MODIFIED");
  if (o.requireBase !== false) {
    const blob = (ref: string) => {
      try {
        return git(["rev-parse", "--verify", "--quiet", `${ref}:${rel}`]).toString("utf8").trim();
      } catch {
        return "";
      }
    };
    const base = blob(FACTS_BASE_REF);
    if (!/^[0-9a-f]{40,64}$/.test(base) || base !== blob("HEAD")) throw new LocalInputError("TRUSTED_FACTS_NOT_ON_DEVELOP");
  }
  return new Uint8Array(committed);
}

/** The fact keys the demo content maps (demoContentFromFacts): one of each, and numbered services / statements. */
const SINGLE_KEYS = new Set(["name", "category", "ward", "address", "hours", "closed_days", "access", "phone", "description", "workshop"]);
const MANY_KEY = /^(service|statement)_[1-9][0-9]{0,2}$/;

export const factsPackSha256 = (b: Bytes) => createHash("sha256").update(b).digest("hex");

/**
 * The demo content derived from facts pack bytes (FactsPack schema — strict, no extra field —, every key mapped, no
 * key twice, then demoContentFromFacts). An unmapped key (a fact the demo would not carry) is refused.
 */
export function demoContentFromFactsBytes(b: Bytes): Record<string, unknown> {
  let pack: FactsPack;
  try {
    pack = FactsPack.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(b)));
  } catch {
    throw new LocalInputError("TRUSTED_FACTS_INVALID");
  }
  const seen = new Set<string>();
  for (const f of pack.facts) {
    if (!SINGLE_KEYS.has(f.key) && !MANY_KEY.test(f.key)) throw new LocalInputError("TRUSTED_FACTS_UNMAPPED_KEY");
    if (seen.has(f.key)) throw new LocalInputError("TRUSTED_FACTS_DUPLICATE_KEY");
    seen.add(f.key);
  }
  try {
    return demoContentFromFacts(pack);
  } catch {
    throw new LocalInputError("TRUSTED_FACTS_INCOMPLETE");
  }
}

/** The content a demo seeded from these facts pack bytes holds: the derived content and the bytes' sha256. */
export function demoContentWithFactsSha(b: Bytes): Record<string, unknown> {
  return { ...demoContentFromFactsBytes(b), facts_pack_sha256: factsPackSha256(b) };
}

/** JSON with object keys sorted at every level (jsonb's key order is not the writer's). */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}

/**
 * Refuses unless the demo's content is exactly demoContentWithFactsSha of these facts pack bytes (it names their
 * sha256 and holds what they derive to). A 輪 demo is refused first.
 */
export function assertDemoContentFromFacts(content: unknown, factsPack: Bytes): void {
  const c = content && typeof content === "object" && !Array.isArray(content) ? (content as Record<string, unknown>) : null;
  if (c?.facts_pack === RIN_SHOP_ID) throw new LocalInputError("TRUSTED_FACTS_RIN_DEMO");
  if (!c || c.facts_pack_sha256 !== factsPackSha256(factsPack)) throw new LocalInputError("TRUSTED_FACTS_SHA_MISMATCH");
  if (canonicalJson(c) !== canonicalJson(demoContentWithFactsSha(factsPack))) throw new LocalInputError("TRUSTED_FACTS_CONTENT_MISMATCH");
}
