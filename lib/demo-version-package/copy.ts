/**
 * DEV-199d (owner Issue #258, decision ②): the copy of a demo version package, stored in structured form and checked
 * again on every read and import.
 *
 * Package format `sales_demo_version_package_v2` (package.ts PACKAGE_FORMAT_COPY) adds, beside the page manifest:
 *
 *   copy/facts-pack.json              the shop's facts pack (shop_facts_pack_v1)
 *   copy/copy.json                    the copy record of the page (comp_copy_v1)
 *   copy/review.json                  the copy quality review of this page (copy_quality_review_v1)
 *   copy/rounds/<i>/copy.json         round i < review.round: the earlier copy record,
 *   copy/rounds/<i>/index.html        its page HTML,
 *   copy/rounds/<i>/style.css         its page CSS
 *   copy/rounds/<i>/review.json       and its review (the revision chain, in order)
 *
 * bound by the package's copy manifest (`copy`: name, role, sha256 and size of each file, and the page bundle's
 * `bundle_sha256`). The page manifest itself (ArtifactManifest, version 1) is NOT changed: it is the database's
 * manifest (sales_demo_version_files allows only html / css / photo / render), so the copy files never go into it and
 * the bundle hash of a page does not move. The copy files are never uploaded or served.
 *
 * What the check does (verifyPackageCopy), on the bytes it is given, never on a declared verdict:
 *   1. every copy file re-hashed against the copy manifest; names, roles, sizes and UTF-8 fixed; the copy manifest
 *      names the package's bundle; the page HTML / CSS re-hashed against the page manifest;
 *   2. the facts pack parsed; when the caller has the facts pack from the facts path (`trustedFactsPack`), the
 *      package's must be the same bytes, otherwise the result carries FACTS_NOT_FROM_FACTS_PATH (never sendable);
 *   3. the existing artifact copy check (checkArtifactCopy over checkArtifactHtml's texts, unchanged) must pass, and
 *      every record item must be on the page (record ↔ page in both directions);
 *   4. the review chain must be appendable in order (copyReviewAppendBlockers, round by round), and the review must be
 *      valid for these exact files (checkCopyQualityReview: hashes recomputed, audit re-run and compared whole, every
 *      earlier round re-audited, every step through validateCopyRevision) with the page's photo URLs;
 *   5. a `fail` verdict is refused; anything else is returned as the verdict this check computed (the audit re-run),
 *      with the send blockers copyGateSendBlockers gives WITHOUT an owner approval (owner records are never taken from
 *      a package): the result is never sendable (`sendable: false` by type).
 *
 * A v1 package (no copy) is still read, but its result is `copy_unreviewed` with COPY_UNREVIEWED_LEGACY_PACKAGE: it can
 * never become sendable, and taking the copy out of a v2 package only lands it there.
 *
 * Not here: the append-only review store across packages (a fresh round 0 replayed from an earlier package is not
 * visible inside one package) and persisting the result — DEV-199e does both in import.ts (lib/sales/copy-review). The
 * owner's revise requests come only from the owner's store, as `ownerRevisions`.
 *
 * Pure apart from sha256 (node:crypto). No file access, no network, no model call.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { pageText } from "@/lib/design-agent/quality-pipeline/copy-quality-page";
import {
  checkCopyQualityReview,
  copyGateSendBlockers,
  copyReviewAppendBlockers,
  copyVerdict,
  CopyQualityReview,
  isOwnerRevisionFor,
  MAX_COPY_REVISION_ROUNDS,
  nextCopyStep,
  reviewCopyQuality,
  type CopyQualityFiles,
  type OwnerCopyApproval,
  type PriorRound,
  type Verdict,
} from "@/lib/design-agent/quality-pipeline/copy-quality-review";
import { CopyRecord } from "@/lib/design-agent/quality-pipeline/copy-record";
import { FactsPack } from "@/lib/design-agent/quality-pipeline/facts-pack";
import { checkArtifactCopy } from "@/lib/sales/demo-version/copy-check";
import { checkArtifactHtml } from "@/lib/sales/demo-version/html-safety";
import { ARTIFACT_LIMITS, bundleSha256, CSS_NAME, HTML_NAME, photoUrlPaths, type ArtifactManifest } from "@/lib/sales/demo-version/manifest";

export const COPY_MANIFEST_VERSION = 1;

export const COPY_ROLES = ["facts_pack", "copy_record", "review", "prior_copy_record", "prior_page_html", "prior_page_css", "prior_review"] as const;
export type CopyRole = (typeof COPY_ROLES)[number];

export const COPY_FACTS_NAME = "copy/facts-pack.json";
export const COPY_RECORD_NAME = "copy/copy.json";
export const COPY_REVIEW_NAME = "copy/review.json";
const PRIOR_NAME = /^copy\/rounds\/([0-9])\/(copy\.json|index\.html|style\.css|review\.json)$/;
const PRIOR_ROLE: Record<string, CopyRole> = { "copy.json": "prior_copy_record", "index.html": "prior_page_html", "style.css": "prior_page_css", "review.json": "prior_review" };
export const priorName = (round: number, file: "copy.json" | "index.html" | "style.css" | "review.json") => `copy/rounds/${round}/${file}`;

/** Size limits of the copy files (the page's own limits for an earlier round's HTML / CSS). */
export const COPY_LIMITS = { jsonBytes: 1024 * 1024, totalBytes: 6 * 1024 * 1024 } as const;

/** The role a copy file name must have, and the round of an earlier-round file. null: not allowed. */
export function copyRoleOfName(name: string): { role: CopyRole; round: number | null } | null {
  if (name === COPY_FACTS_NAME) return { role: "facts_pack", round: null };
  if (name === COPY_RECORD_NAME) return { role: "copy_record", round: null };
  if (name === COPY_REVIEW_NAME) return { role: "review", round: null };
  const p = PRIOR_NAME.exec(name);
  if (!p) return null;
  const round = Number(p[1]);
  return round < MAX_COPY_REVISION_ROUNDS ? { role: PRIOR_ROLE[p[2]!]!, round } : null;
}

const limitOf = (role: CopyRole) => (role === "prior_page_html" ? ARTIFACT_LIMITS.htmlBytes : role === "prior_page_css" ? ARTIFACT_LIMITS.cssBytes : COPY_LIMITS.jsonBytes);

export const CopyManifestFile = z.strictObject({
  name: z.string().min(1).max(80),
  role: z.enum(COPY_ROLES),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().positive().max(COPY_LIMITS.jsonBytes),
});
export type CopyManifestFile = z.infer<typeof CopyManifestFile>;

/** The copy manifest of a v2 package: no verdict, no score, no approval (those are computed, never declared). */
export const CopyManifest = z.strictObject({
  version: z.literal(COPY_MANIFEST_VERSION),
  bundle_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  files: z.array(CopyManifestFile).min(3).max(3 + 4 * MAX_COPY_REVISION_ROUNDS),
});
export type CopyManifest = z.infer<typeof CopyManifest>;

export class CopyPackageError extends Error {
  /** DEV-199e: set when the refused review is the honest audit of the files and says fail (the round of that review) */
  failedRound?: number;
  constructor(
    public readonly code: string,
    public readonly details: readonly string[] = [],
  ) {
    super(details.length ? `${code}: ${details.join(",")}` : code);
  }
}

const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const enc = (s: string | Uint8Array) => (typeof s === "string" ? new TextEncoder().encode(s) : s);

/** One earlier round of the revision chain, as the package builder receives it. */
export type CopyRoundInput = { copyRecord: string | Uint8Array; pageHtml: string | Uint8Array; pageCss: string | Uint8Array; review: string | Uint8Array };
export type CopyInput = { factsPack: string | Uint8Array; copyRecord: string | Uint8Array; review: string | Uint8Array; rounds?: readonly CopyRoundInput[] };

/** The copy files and their manifest, for a page bundle (the builder's side; verifyPackageCopy checks them again). */
export function makeCopyFiles(input: CopyInput, bundle: string): { copy: CopyManifest; copyFiles: Record<string, Uint8Array> } {
  const files: Record<string, Uint8Array> = { [COPY_FACTS_NAME]: enc(input.factsPack), [COPY_RECORD_NAME]: enc(input.copyRecord), [COPY_REVIEW_NAME]: enc(input.review) };
  (input.rounds ?? []).forEach((r, i) => {
    files[priorName(i, "copy.json")] = enc(r.copyRecord);
    files[priorName(i, "index.html")] = enc(r.pageHtml);
    files[priorName(i, "style.css")] = enc(r.pageCss);
    files[priorName(i, "review.json")] = enc(r.review);
  });
  const entries = Object.keys(files)
    .sort()
    .map((name) => {
      const role = copyRoleOfName(name);
      if (!role) throw new CopyPackageError("COPY_NAME_NOT_ALLOWED", [name]);
      return { name, role: role.role, sha256: sha256(files[name]!), bytes: files[name]!.byteLength };
    });
  return { copy: { version: COPY_MANIFEST_VERSION, bundle_sha256: bundle, files: entries }, copyFiles: files };
}

/**
 * What the check computed about a package's copy. Never sendable here: the owner's approval is not in a package.
 *
 * `checked` means only that the copy files are intact, the existing checks pass and the review is valid for these exact
 * files (fail is refused before this). It does NOT mean the copy passed: hold and revise are `checked` too. What the
 * copy earns is `copy_verdict`, and whether anything stands in the way of sending is `send_blockers` (non-empty here
 * always, at least OWNER_APPROVAL_MISSING). A send path must decide on those two, never on `status` or `verdict` alone.
 */
export type PackageCopyResult =
  | { status: "copy_unreviewed"; sendable: false; send_blockers: ["COPY_UNREVIEWED_LEGACY_PACKAGE"] }
  | {
      status: "checked";
      sendable: false;
      shop_id: string;
      lane: CopyRecord["lane"];
      round: number;
      /** the verdict of the audit as re-run by this check (never the package's declared one) */
      verdict: Exclude<Verdict, "fail">;
      /** the verdict with COPY_APPROVAL_MISSING set aside (copyVerdict) */
      copy_verdict: Exclude<Verdict, "fail">;
      next_step: ReturnType<typeof nextCopyStep>;
      unresolved: string[];
      auditor_version: string;
      review_sha256: string;
      facts_sha256: string;
      facts_content_sha256: string;
      copy_sha256: string;
      page_html_sha256: string;
      page_css_sha256: string;
      /** the facts pack was compared with the one from the facts path (trustedFactsPack) */
      facts_from_facts_path: boolean;
      /** copyGateSendBlockers without an owner approval, plus FACTS_NOT_FROM_FACTS_PATH when the facts were not compared */
      send_blockers: string[];
    };

export const LEGACY_COPY_RESULT: PackageCopyResult = { status: "copy_unreviewed", sendable: false, send_blockers: ["COPY_UNREVIEWED_LEGACY_PACKAGE"] };

const decode = (name: string, b: Uint8Array) => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    throw new CopyPackageError("COPY_FILE_NOT_UTF8", [name]);
  }
};
const parse = (code: string, s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    throw new CopyPackageError(code);
  }
};

/**
 * Checks the copy of a v2 package on its bytes (see the file comment). Throws CopyPackageError when the package must be
 * refused; returns the computed result otherwise.
 */
export function verifyPackageCopy(
  pkg: { manifest: ArtifactManifest; bundleSha256: string; files: Readonly<Record<string, Uint8Array>>; images: readonly unknown[]; copy?: unknown; copyFiles?: Readonly<Record<string, Uint8Array>> },
  o: {
    trustedFactsPack?: string | Uint8Array | null;
    /**
     * DEV-199e: the owner's revise requests from the owner's store (sales_demo_copy_owner_decisions, never the package):
     * an earlier real-shop round at owner review may be followed by a revision only when one of these is for exactly
     * that round (isOwnerRevisionFor). Left out (undefined) means the store was not consulted (build / read): see
     * ownerRevisionFor below. The importer always passes the store's records (an empty list when there are none).
     */
    ownerRevisions?: readonly OwnerCopyApproval[];
  } = {},
): Extract<PackageCopyResult, { status: "checked" }> {
  // 1. the copy manifest and the bytes
  const cm = CopyManifest.safeParse(pkg.copy);
  if (!cm.success) throw new CopyPackageError("COPY_MANIFEST_INVALID");
  const copy = cm.data;
  const given = pkg.copyFiles ?? {};
  if (copy.bundle_sha256 !== pkg.bundleSha256 || copy.bundle_sha256 !== bundleSha256(pkg.manifest)) throw new CopyPackageError("COPY_BUNDLE_MISMATCH");
  const seen = new Set<string>();
  let total = 0;
  const text: Record<string, string> = {};
  const raw: Record<string, Uint8Array> = {};
  for (const f of copy.files) {
    if (seen.has(f.name)) throw new CopyPackageError("COPY_DUPLICATE_NAME", [f.name]);
    seen.add(f.name);
    const role = copyRoleOfName(f.name);
    if (!role) throw new CopyPackageError("COPY_NAME_NOT_ALLOWED", [f.name]);
    if (role.role !== f.role) throw new CopyPackageError("COPY_ROLE_MISMATCH", [f.name]);
    if (f.bytes > limitOf(f.role)) throw new CopyPackageError("COPY_FILE_TOO_LARGE", [f.name]);
    total += f.bytes;
    const bytes = given[f.name];
    if (!bytes) throw new CopyPackageError("COPY_FILE_MISSING", [f.name]);
    if (bytes.byteLength !== f.bytes || sha256(bytes) !== f.sha256) throw new CopyPackageError("COPY_FILE_HASH_MISMATCH", [f.name]);
    raw[f.name] = bytes;
    text[f.name] = decode(f.name, bytes);
  }
  if (total > COPY_LIMITS.totalBytes) throw new CopyPackageError("COPY_TOTAL_TOO_LARGE");
  for (const name of Object.keys(given)) if (!seen.has(name)) throw new CopyPackageError("COPY_FILE_NOT_IN_MANIFEST", [name]);
  for (const name of [COPY_FACTS_NAME, COPY_RECORD_NAME, COPY_REVIEW_NAME]) if (!seen.has(name)) throw new CopyPackageError("COPY_FILE_MISSING", [name]);

  // the page the copy describes is the page of the manifest, re-hashed
  const htmlEntry = pkg.manifest.files.find((f) => f.name === HTML_NAME);
  const cssEntry = pkg.manifest.files.find((f) => f.name === CSS_NAME);
  const htmlBytes = pkg.files[HTML_NAME];
  const cssBytes = pkg.files[CSS_NAME];
  if (!htmlEntry || !cssEntry || !htmlBytes || !cssBytes || sha256(htmlBytes) !== htmlEntry.sha256 || sha256(cssBytes) !== cssEntry.sha256) throw new CopyPackageError("COPY_PAGE_NOT_MANIFEST_PAGE");
  const html = decode(HTML_NAME, htmlBytes);
  const css = decode(CSS_NAME, cssBytes);
  const files: CopyQualityFiles = { factsPack: raw[COPY_FACTS_NAME]!, copyRecord: raw[COPY_RECORD_NAME]!, pageHtml: htmlBytes, pageCss: cssBytes };

  // 2. the facts pack (and, when the caller has it, the one from the facts path)
  const facts = FactsPack.safeParse(parse("COPY_FACTS_PACK_INVALID", text[COPY_FACTS_NAME]!));
  if (!facts.success) throw new CopyPackageError("COPY_FACTS_PACK_INVALID");
  const trusted = o.trustedFactsPack ?? null;
  if (trusted !== null && sha256(enc(trusted)) !== sha256(raw[COPY_FACTS_NAME]!)) throw new CopyPackageError("COPY_FACTS_NOT_FROM_FACTS_PATH");

  const ownerRevisionFor = (r: unknown): OwnerCopyApproval | null => {
    const q = CopyQualityReview.safeParse(r);
    if (!q.success) return null;
    if (o.ownerRevisions !== undefined) return o.ownerRevisions.find((a) => isOwnerRevisionFor(a, q.data)) ?? null;
    // DEV-199e: the owner's store was not consulted (buildPackage / readPackage, which never store or send). A real-shop
    // round at owner review is checked AS IF the owner had asked for a revision, so a package holding such a chain can
    // be built and read; the importer always consults the store (its records only) and the database requires the real
    // revise record before it stores the next round (sales_check_copy_review_write). Nothing here is ever stored.
    const x = q.data;
    return x.lane === "real_shop_proposal" && nextCopyStep(x) === "owner_review"
      ? { shop_id: x.shop_id, facts_sha256: x.facts_sha256, copy_sha256: x.copy_sha256, page_html_sha256: x.page_html_sha256, page_css_sha256: x.page_css_sha256, decision: "revise" }
      : null;
  };

  // DEV-199e (PR #262 M1): a review that is the honest audit of these files and says `fail` is kept by the store (fail
  // is terminal), so the importer can record it before refusing. Honest: it parses, says fail, its rounds are complete
  // and in order, and checkCopyQualityReview finds nothing but the failed revision step the review itself names.
  const photoUrls = photoUrlPaths(pkg.manifest);
  const failedRound = (): number | undefined => {
    try {
      const q = CopyQualityReview.safeParse(JSON.parse(text[COPY_REVIEW_NAME]!));
      if (!q.success || q.data.verdict !== "fail") return undefined;
      const n = q.data.round;
      const prior: PriorRound[] = [];
      const priorRaw: unknown[] = [];
      for (let i = 0; i < n; i++) {
        const t = text[priorName(i, "review.json")];
        if (t === undefined || !raw[priorName(i, "copy.json")] || !raw[priorName(i, "index.html")] || !raw[priorName(i, "style.css")]) return undefined;
        const r = JSON.parse(t) as unknown;
        priorRaw.push(r);
        prior.push({ review: r, copyRecord: raw[priorName(i, "copy.json")]!, pageHtml: raw[priorName(i, "index.html")]!, pageCss: raw[priorName(i, "style.css")]!, ownerRevision: ownerRevisionFor(r) });
      }
      const all = [...priorRaw, q.data];
      for (let i = 0; i < all.length; i++) if (copyReviewAppendBlockers(all.slice(0, i), all[i], { ownerRevision: i > 0 ? prior[i - 1]!.ownerRevision : null }).length) return undefined;
      const named = new Set(q.data.revision_findings.filter((x) => x.severity === "fail").map((x) => x.code));
      const c = checkCopyQualityReview(q.data, files, { previous: prior, photoUrls });
      return c.codes.every((code) => code === "REVISION_INVALID" || named.has(code)) ? n : undefined;
    } catch {
      return undefined;
    }
  };
  const failing = (e: CopyPackageError): CopyPackageError => Object.assign(e, { failedRound: failedRound() });

  // 3. the existing copy check (unchanged), and record ↔ page
  const safety = checkArtifactHtml(html, css, photoUrls);
  if (!safety.ok) throw failing(new CopyPackageError("COPY_PAGE_CHECK_FAILED", safety.findings.map((f) => f.code)));
  const copyRaw = parse("COPY_RECORD_INVALID", text[COPY_RECORD_NAME]!);
  const base = checkArtifactCopy({ texts: safety.texts, copyRecord: copyRaw, shopId: facts.data.shop_id, factsSha256: sha256(raw[COPY_FACTS_NAME]!), facts: facts.data.facts });
  if (!base.ok) throw failing(new CopyPackageError("COPY_CHECK_FAILED", [...new Set(base.findings.map((f) => f.code))]));
  const record = CopyRecord.parse(copyRaw);
  const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, "");
  const page = pageText(html);
  const shown = [...page.sections.flatMap((s) => s.entries.map((e) => e.text)), ...page.otherTexts].map(norm);
  // the item's own text must be on the page: a label alone (所在地, 営業時間 …) does not show the item it introduces
  const missing = record.items.filter((i) => !shown.some((t) => t.includes(norm(i.text))));
  if (missing.length) throw failing(new CopyPackageError("COPY_RECORD_ITEM_NOT_ON_PAGE", missing.map((i) => i.id).slice(0, 20)));
  if (pkg.images.length > 0 && record.lane !== "quality_research_fictional") throw new CopyPackageError("COPY_REAL_SHOP_LANE_WITH_AI_IMAGES");

  // 4. the review chain, in order, then the review against these exact files
  const review = parse("COPY_REVIEW_INVALID", text[COPY_REVIEW_NAME]!);
  const head = CopyQualityReview.safeParse(review);
  if (!head.success) throw failing(new CopyPackageError("COPY_REVIEW_INVALID", ["REVIEW_SCHEMA"]));
  const rounds = head.data.round;
  const priorFiles = copy.files.filter((f) => f.role.startsWith("prior_"));
  if (priorFiles.length !== 4 * rounds || priorFiles.some((f) => copyRoleOfName(f.name)!.round! >= rounds)) throw failing(new CopyPackageError("COPY_ROUNDS_INCOMPLETE"));
  const previous: PriorRound[] = [];
  const priorReviews: unknown[] = [];
  for (let i = 0; i < rounds; i++) {
    const r = parse("COPY_REVIEW_INVALID", text[priorName(i, "review.json")]!);
    priorReviews.push(r);
    // owner records are never taken from a package: only from the owner's store (DEV-199e, o.ownerRevisions)
    previous.push({ review: r, copyRecord: raw[priorName(i, "copy.json")]!, pageHtml: raw[priorName(i, "index.html")]!, pageCss: raw[priorName(i, "style.css")]!, ownerRevision: ownerRevisionFor(r) });
  }
  const chain = [...priorReviews, review];
  for (let i = 0; i < chain.length; i++) {
    const blockers = copyReviewAppendBlockers(chain.slice(0, i), chain[i], { ownerRevision: i > 0 ? previous[i - 1]!.ownerRevision : null });
    if (blockers.length) throw failing(new CopyPackageError("COPY_REVIEW_CHAIN_INVALID", blockers));
  }
  const check = checkCopyQualityReview(review, files, { previous, photoUrls });
  if (!check.ok) throw failing(new CopyPackageError("COPY_REVIEW_INVALID", check.codes));

  // 5. the verdict as computed here
  const computed = reviewCopyQuality(files, { round: rounds, previousCopySha256: head.data.previous_copy_sha256, photoUrls, earlierRounds: previous });
  if (computed.verdict === "fail") throw failing(new CopyPackageError("COPY_REVIEW_FAIL", computed.unresolved));
  const factsFromPath = trusted !== null;
  const send = copyGateSendBlockers(computed, files, null, { previous, photoUrls });
  return {
    status: "checked",
    sendable: false,
    shop_id: computed.shop_id,
    lane: computed.lane,
    round: computed.round,
    verdict: computed.verdict,
    copy_verdict: copyVerdict(computed) as Exclude<Verdict, "fail">,
    next_step: nextCopyStep(computed),
    unresolved: computed.unresolved,
    auditor_version: computed.auditor_version,
    review_sha256: sha256(raw[COPY_REVIEW_NAME]!),
    facts_sha256: computed.facts_sha256,
    facts_content_sha256: computed.facts_content_sha256,
    copy_sha256: computed.copy_sha256,
    page_html_sha256: computed.page_html_sha256,
    page_css_sha256: computed.page_css_sha256,
    facts_from_facts_path: factsFromPath,
    send_blockers: [...new Set([...send, ...(factsFromPath ? [] : ["FACTS_NOT_FROM_FACTS_PATH"])])],
  };
}
