/**
 * Issue #302: the IMAGE_FIRST design-image audit by the owner's signed-in Claude CLI, WITHOUT Remote Control (ported from
 * curiosity-media's Kaii Dokuhon image worker: verified image bytes go as base64 into one tool-less `claude -p` call,
 * claude-cli.ts). A separate, manual step after the review hand-off (deliver-review.ts) has delivered a run:
 *
 *   approval id → the delivery the worker recorded (<state>/deliveries/<id>.json, "delivered") and the receiver's record
 *   (<inbox>/.records/<id>.json) agree on one bundle SHA → verifyBundleDir(<inbox>/<id>) = that SHA → verifyPreviews
 *   (<inbox>/previews/<id>) for that SHA, every preview's source SHA = the bundle's file → the chosen previews read ONCE
 *   more, each SHA = INDEX.json's → the AUDIT TIER derived in memory from exactly those bytes (AUDIT_TIER) is attached
 *   → one call per viewport (PC 1440, SP 390) → strict schema + coherence (at most ONE re-ask with the same bytes)
 *   → verdict computed in code (audit-schema.ts) → <inbox>/audits/<id>/audit.json + AUDIT.md (0700 / 0600, written
 *   under a temporary name and renamed, never overwritten).
 *
 * The audit tier (PR #311 review M2): the previews are PNG (lossless, or palette when lossless is over 3.5 MiB), so a
 * tall PC page (≈ 11 tiles + overview) can be 25–40 MiB, over what one call carries. Each attached image is therefore
 * the SAME pixels at the SAME size (≤ 1568 px a side, preview.ts) re-encoded once as JPEG at a fixed quality with no
 * chroma subsampling (text stays sharp). Deterministic (fixed settings, the repository's sharp), never a smaller size;
 * the source preview SHA and the derived SHA of every image are recorded. Still over the hard cap → AUDIT_INPUT_TOO_LARGE.
 *
 * Spending is one-use: a marker <state>/audits/<bundle SHA>.<rubric SHA>.used is created (O_EXCL) right before the first
 * call. A second run for the same bundle and rubric is refused (AUDIT_ALREADY_SPENT) until the owner removes the marker
 * (and the audit directory) by hand.
 *
 * It never runs Codex, the worker, a cycle or the entry, never claims an approval, never touches the ledger or a claim
 * (a test pins the imports and compares content hashes), and is never chained into the automatic start here. It refuses
 * while the jailed Claude (sr-jail-claude) may run, since both use the same ~/.claude, and checks again before every
 * call. Nothing leaves the machine except the CLI call: no GitHub, no spool, no public storage.
 *
 * Refusals before the marker throw AuditStop (fixed code, nothing spent, nothing written). After the marker, every
 * outcome is a returned result: "completed", or "stopped" with a fixed code (login, quota, timeout, exec, schema, abort,
 * jail, and AUDIT_EXISTS / AUDIT_DIR_UNSAFE / AUDIT_WRITE_FAILED when the record cannot be written). Codes only.
 */
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { DIRECTIONS, loadPromptInputs, type Reader } from "../image-first/prompt";
import { acquireLock } from "../worker/state";
import { AUDIT_RUBRIC_VERSION, buildViewportAuditRequest, CHECK_IDS, CRITERION_IDS, HARD_FAIL_IDS, principlesFor, RUBRIC_SHA256, VIEWPORT_IDS, VIEWPORTS, type AuditMaterial, type AuditViewport, type SentImage } from "./audit-rubric";
import { AUDIT_SCHEMA, AuditRecord, deriveViewport, incoherence, overallVerdict, ViewportAnswer, type Derived, type Verdict } from "./audit-schema";
import { APPROVAL_ID_RE, BundleStop, verifyBundleDir } from "./bundle";
import { assertClaudeSignedIn, buildUserMessage, claudeEnvironment, ClaudeCallError, extractJsonObject, runClaudeWithoutTools, type ClaudeImage } from "./claude-cli";
import { PREVIEW_LIMITS, PreviewStop, verifyPreviewsDetailed, type PreviewEntry } from "./preview";
import { isRequestRunId, runOfApprovalId, type RunDirection } from "./run-directions";

const MiB = 1024 * 1024;
/**
 * Hard cap per call (one viewport), on the AUDIT TIER bytes actually attached: at most 20 images and 18 MiB (about
 * 24 MiB once base64), under the request size a call can carry. Callers (tests) may only lower these.
 */
export const AUDIT_LIMITS = { maxImages: 20, maxBytes: 18 * MiB } as const;
/** The audit tier: same pixels and size as the preview, JPEG at a fixed quality, 4:4:4 (no chroma subsampling). */
export const AUDIT_TIER = { id: "jpeg-q85-444-v1", mediaType: "image/jpeg", quality: 85, chromaSubsampling: "4:4:4", background: "#ffffff" } as const;
/** Per call; the run as a whole makes at most 3 calls (2 viewports + 1 re-ask). */
export const AUDIT_CALL_TIMEOUT_MS = 10 * 60_000;
export const AUDITS = "audits";
const PREVIEWS = "previews";
const RECORDS = ".records";
const DELIVERIES = "deliveries";
/** The review PoC's reserved id and record (review-poc.ts; pinned by a test). Accepted only with `dummy: true`. */
const RESERVED_DATE = "00000000";
export const DUMMY_AUDIT_ID = `hoshigama-imagefirst-d3-${RESERVED_DATE}-00`;
const DUMMY_AUDIT_RECORD = { plan_id: "review-poc-dummy", commit: "0".repeat(40) } as const;

export class AuditStop extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AuditStop";
  }
}
const stop = (code: string): never => {
  throw new AuditStop(code);
};
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** The same rule as the worker's real-run id check (cycle.ts checkRealApprovalId; a test compares them), without importing the cycle. */
export function auditIdCheck(id: string, dummy: boolean): "ok" | "APPROVAL_ID_INVALID" | "APPROVAL_ID_RESERVED" | "DUMMY_ID_REQUIRED" {
  if (dummy) return id === DUMMY_AUDIT_ID ? "ok" : "DUMMY_ID_REQUIRED";
  // DEV-303: a request run's id (never an approval id's form); its material comes from its own private run
  if (isRequestRunId(id)) return "ok";
  if (!APPROVAL_ID_RE.test(id)) return "APPROVAL_ID_INVALID";
  const date = id.split("-")[3]!;
  if (date === RESERVED_DATE) return "APPROVAL_ID_RESERVED";
  const [y, m, d] = [Number(date.slice(0, 4)), Number(date.slice(4, 6)), Number(date.slice(6, 8))];
  const t = new Date(Date.UTC(y, m - 1, d));
  return y >= 2000 && t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? "ok" : "APPROVAL_ID_INVALID";
}

/** The direction an audit id names (d3 / d4); d3 for anything else, which auditIdCheck then refuses anyway. */
export const auditDirectionOf = (id: string): RunDirection => runOfApprovalId(id)?.direction ?? "d3";

/**
 * The material the request quotes: the facts pack's key / value lines and the chosen direction's concept and protect
 * list (ほし窯 d3 by default; d4 for a d4 approval — the CLI passes the direction its approval id names), read through
 * the IMAGE_FIRST prompt builder's own loader, so every SHA-256 pin it holds applies.
 */
export async function loadAuditMaterial(reader: Reader, direction: RunDirection = "d3"): Promise<AuditMaterial> {
  const inputs = await loadPromptInputs(reader, direction);
  const d = JSON.parse(inputs.directionBytes.toString("utf8")) as { id?: unknown; concept?: unknown; protect?: unknown };
  if (typeof d.id !== "string" || typeof d.concept !== "string" || !Array.isArray(d.protect) || d.protect.some((p) => typeof p !== "string")) throw new AuditStop("MATERIAL_INVALID");
  return { facts: inputs.facts.facts.map((f) => ({ key: f.key, value: f.value })), direction: { id: d.id, concept: d.concept, protect: d.protect as string[] } };
}

export { isRequestRunId };
/** DEV-303: the material id a request run's audit quotes (and the audit requires). */
export const requestMaterialId = (id: string) => `request-${id}`;
const RECEIPT_STAMP = "\\d{8}T\\d{6}Z";

/**
 * DEV-303: a request run's material, from its own private run directory (~/sr-runs/<id>-<UTC>/): the facts pack the run
 * used (its SHA-256 = the receipt's facts_sha256) and the request's direction (concept; palette, typography and what to
 * avoid as the things to keep). Read only; nothing from the repository (a real shop's facts are never in it).
 */
/** DEV-303 (owner decision 2026-11-24): what the audit CLI says instead of auditing an image-materials bundle. */
export const IMAGE_MATERIAL_AUDIT_SKIPPED = "image materials are reviewed by Claude, no audit call";

/**
 * DEV-303: a request run whose inbox bundle (<inbox>/<id>) is a photo-materials bundle (manifest image_material: true) is
 * not audited (there is no page to audit; Claude reviews each material itself). Returns that bundle's SHA-256 after the
 * full verifier passed, or null when the bundle is not an image-materials one (the design audit goes on unchanged).
 * A bundle that says image_material but does not verify throws (BundleStop's fixed code).
 */
export async function imageMaterialBundle(runsDir: string, id: string, inboxDir: string = join(runsDir, "review-inbox")): Promise<string | null> {
  if (!isRequestRunId(id)) return null;
  const dir = join(inboxDir, id);
  let m: { image_material?: unknown } | null = null;
  try {
    const bytes = await readPrivate(join(dir, "manifest.json"), 64 * 1024, "MATERIAL_INVALID", process.getuid?.() ?? -1);
    if (!bytes) return null;
    m = JSON.parse(bytes.toString("utf8")) as { image_material?: unknown };
  } catch {
    return null;
  }
  if (m?.image_material !== true) return null;
  const v = await verifyBundleDir(dir);
  if (v.manifest.image_material !== true || v.manifest.bundle_id !== id) throw new AuditStop("MATERIAL_INVALID");
  return v.bundle_sha256;
}

export async function loadRequestAuditMaterial(runsDir: string, id: string): Promise<AuditMaterial> {
  if (!isRequestRunId(id)) throw new AuditStop("APPROVAL_ID_INVALID");
  const re = new RegExp(`^${id}-${RECEIPT_STAMP}\\.receipt\\.json$`);
  const found = (await readdir(runsDir).catch(() => [] as string[])).filter((n) => re.test(n));
  if (found.length !== 1) throw new AuditStop(found.length === 0 ? "MATERIAL_MISSING" : "MATERIAL_INVALID");
  const runDir = join(runsDir, found[0]!.slice(0, -".receipt.json".length));
  const read = async (p: string, max: number) => {
    const b = await readPrivate(p, max, "MATERIAL_INVALID", process.getuid?.() ?? -1).catch(() => null);
    if (!b) throw new AuditStop("MATERIAL_MISSING");
    return b;
  };
  let receipt: { mode?: unknown; request_id?: unknown; facts_sha256?: unknown };
  let facts: { facts?: unknown };
  let direction: { concept?: unknown; palette?: unknown; typography?: unknown; avoid?: unknown };
  const factsBytes = await read(join(runDir, "facts-pack.json"), 256 * 1024);
  try {
    receipt = JSON.parse((await read(join(runsDir, found[0]!), 256 * 1024)).toString("utf8")) as typeof receipt;
    facts = JSON.parse(factsBytes.toString("utf8")) as typeof facts;
    direction = JSON.parse((await read(join(runDir, "direction.json"), 64 * 1024)).toString("utf8")) as typeof direction;
  } catch {
    throw new AuditStop("MATERIAL_INVALID");
  }
  if (receipt.mode !== "request" || receipt.request_id !== id || receipt.facts_sha256 !== sha256(factsBytes)) throw new AuditStop("MATERIAL_INVALID");
  const list = Array.isArray(facts.facts) ? (facts.facts as { key?: unknown; value?: unknown }[]) : [];
  const texts = [direction.concept, direction.palette, direction.typography, direction.avoid];
  if (list.length === 0 || list.some((f) => typeof f?.key !== "string" || typeof f.value !== "string") || texts.some((t) => typeof t !== "string")) throw new AuditStop("MATERIAL_INVALID");
  return {
    facts: list.map((f) => ({ key: f.key as string, value: f.value as string })),
    direction: { id: requestMaterialId(id), concept: direction.concept as string, protect: [`色: ${direction.palette as string}`, `文字の組み方: ${direction.typography as string}`, `避けること: ${direction.avoid as string}`] },
  };
}

/**
 * The audit tier of one verified preview (in memory): the same pixels and size, alpha flattened on white, JPEG at
 * AUDIT_TIER's fixed settings. Refuses (AUDIT_TIER_FAILED) a decode error or any change of size.
 */
export async function auditTierOf(png: Buffer, width: number, height: number): Promise<{ bytes: Buffer; opaque: boolean }> {
  let out;
  let opaque: boolean;
  try {
    const img = () => sharp(png, { failOn: "error", limitInputPixels: PREVIEW_LIMITS.maxSide * PREVIEW_LIMITS.maxSide });
    // PR #311 re-review L-d: whether any pixel is not fully opaque (those are filled white for the audit; recorded)
    opaque = (await img().stats()).isOpaque;
    out = await img()
      .flatten({ background: AUDIT_TIER.background })
      .jpeg({ quality: AUDIT_TIER.quality, chromaSubsampling: AUDIT_TIER.chromaSubsampling, mozjpeg: false })
      .toBuffer({ resolveWithObject: true });
  } catch {
    return stop("AUDIT_TIER_FAILED");
  }
  if (out.info.width !== width || out.info.height !== height) stop("AUDIT_TIER_FAILED");
  return { bytes: out.data, opaque };
}

export type ClaudeAuditOptions = {
  approvalId: string;
  /** The worker's private runs directory (~/sr-runs, ours, 0700). */
  runsDir: string;
  /** The worker's state directory: deliveries/ (read only), its lock, audits/ (the one-use markers), the call's empty cwd. */
  stateDir: string;
  /** Default <runsDir>/review-inbox. */
  inboxDir?: string;
  /** The facts and the direction text (the CLI reads them from the repository, pinned by SHA-256). */
  material: AuditMaterial;
  /** The claude binary (default "claude" on PATH, chosen by the CLI). */
  claudeBin: string;
  /** The parent environment; claude-cli.ts claudeEnvironment() is applied to it. */
  env: Record<string, string | undefined>;
  /** true only when sr-jail-claude is stopped AND disabled or masked (jail-state.ts); false / null refuse. Asked again before every call. */
  jailIdle: () => Promise<boolean | null>;
  /** Audit the review PoC's dummy bundle (the reserved id only; never a real id). */
  dummy?: boolean;
  /** Verify and plan only: no marker, no claude process, no write. */
  dryRun?: boolean;
  timeoutMs?: number;
  limits?: { maxImages: number; maxBytes: number };
  signal?: AbortSignal;
  now?: () => number;
  /**
   * Tests only (PR #311 review M1 / L1 / L2): seams that run at fixed points (after the previews were verified; right
   * before the record is written) and the uid the ownership checks expect (default: this process's), so checks that
   * cannot be exercised as root can be.
   */
  testSeams?: { afterVerify?: () => Promise<void> | void; beforeWrite?: () => Promise<void> | void; dirUid?: number; fileUid?: number };
};
export type PlannedCall = { viewport: AuditViewport; images: number; bytes: number; preview_bytes: number };
export type ClaudeAuditResult = {
  status: "completed" | "stopped" | "planned";
  code: string | null;
  approval_id: string;
  bundle_sha256: string;
  verdict: Verdict | null;
  dir: string | null;
  calls: number;
  plan: PlannedCall[];
  /** The limits applied (AUDIT_LIMITS, or lower) and the audit tier. */
  limits: { maxImages: number; maxBytes: number };
  tier: string;
};

const exists = (p: string) => lstat(p).then(() => true, () => false);

/** A small regular file of ours, 0600-ish, one name, no link; read on the same handle. Missing = null. */
async function readPrivate(path: string, max: number, bad: string, uid: number | undefined): Promise<Buffer | null> {
  let h;
  try {
    h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    return (error as { code?: string }).code === "ENOENT" ? null : stop(bad);
  }
  try {
    const st = await h.stat();
    if (!st.isFile() || st.nlink !== 1 || st.uid !== uid || (st.mode & 0o077) !== 0 || st.size > max) stop(bad);
    return await h.readFile();
  } finally {
    await h.close();
  }
}

/** The previews of one viewport: its composite (overview first, then the tiles in order, or the one full preview); the parts only without a composite. */
function choose(previews: readonly PreviewEntry[], viewport: AuditViewport): PreviewEntry[] {
  const s = VIEWPORTS[viewport].source;
  const order = (p: PreviewEntry) => (p.kind === "overview" ? 0 : p.kind === "full" ? 1 : 1 + (p.tile?.index ?? 0));
  const comp = previews.filter((p) => p.source === `composites/${s}.png`);
  const picked = comp.length > 0 ? comp : previews.filter((p) => p.source.startsWith(`parts/${s}-`));
  return [...picked].sort((a, b) => (a.source === b.source ? order(a) - order(b) : a.source < b.source ? -1 : 1));
}
const labelOf = (p: PreviewEntry) => `${p.file} · ${p.kind}${p.tile ? ` ${p.tile.index}/${p.tile.count}` : ""} · ${p.source}`;
const rowsOf = (p: PreviewEntry) => (p.tile ? { y0: p.tile.y0, y1: p.tile.y1 } : { y0: 0, y1: p.source_height });

async function writeFile0600(path: string, bytes: string) {
  const h = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await h.writeFile(bytes);
    await h.sync();
  } finally {
    await h.close();
  }
}

function renderAuditMd(r: AuditRecord): string {
  const b = r.binding;
  const L: string[] = [
    `# IMAGE_FIRST Claude CLI audit — ${b.approval_id}`,
    "",
    "**Advisory only.** Not an owner evaluation, not a confirmation, never a success case. The owner decides: adopt, revise or reject.",
    "",
    `- status: \`${r.status}\`${r.stop_code ? ` · stop code: \`${r.stop_code}\`` : ""}`,
    `- advisory verdict (computed in code from the scores and hard fails): \`${r.derived.verdict ?? "none"}\``,
    `- bundle SHA-256: \`${b.bundle_sha256}\` · plan: \`${b.plan_id}\` · commit: \`${b.commit}\``,
    `- rubric: \`${b.rubric_version}\` (\`${b.rubric_sha256}\`) · audit tier: \`${b.audit_tier}\` · via: ${r.auditor.via} · calls: ${r.auditor.calls} (re-asks ${r.auditor.reasks})`,
    "",
  ];
  for (const vp of VIEWPORT_IDS) {
    const a = r.viewports[vp];
    const d = r.derived[vp];
    L.push(`## ${VIEWPORTS[vp].name}`, "");
    if (!a || !d) {
      L.push("(no usable answer)", "");
      continue;
    }
    L.push(`- verdict: \`${d.verdict}\` · total ${d.total}/25 · lowest ${d.lowest}${d.low_criteria.length ? ` · below 4: ${d.low_criteria.join(", ")}` : ""}${d.low_checks.length ? ` · checks below 4: ${d.low_checks.join(", ")}` : ""}`);
    L.push(`- hard fails: ${d.hard_fail_hits.length ? d.hard_fail_hits.join(", ") : "none"}`);
    L.push(`- success_principles_applied: the principles (text only) of ${principlesFor(vp).map((p) => `${p.id} (${p.provenance.source})`).join(", ")}. Closeness to an example is not a criterion; imitating another shop's design, colours or layout is penalised.`, "");
    L.push("| item | score | reason |", "|---|---|---|");
    for (const k of CRITERION_IDS) L.push(`| ${k} | ${a.scores[k].score} | ${a.scores[k].reason.replace(/\|/g, "/")} |`);
    for (const k of CHECK_IDS) L.push(`| ${k} (check) | ${a.checks[k].score} | ${a.checks[k].reason.replace(/\|/g, "/")} |`);
    for (const k of HARD_FAIL_IDS) if (a.hard_fails[k].hit) L.push(`| ${k} (HARD FAIL) | hit | ${a.hard_fails[k].note.replace(/\|/g, "/")} |`);
    L.push("", "### Findings", "");
    if (a.findings.length === 0) L.push("(none)");
    for (const f of a.findings) {
      const rows = f.where.y0 !== null || f.where.y1 !== null ? ` rows ${f.where.y0 ?? "?"}–${f.where.y1 ?? "?"}` : "";
      L.push(`- **${f.target}** (${f.severity}) — ${f.where.image}${rows}: ${f.where.area}`, `  - problem: ${f.problem}`, `  - suggestion: ${f.suggestion}`, `  - protect: ${f.protect}`);
    }
    L.push("");
  }
  L.push(
    "## Images attached (SHA-256 computed by the worker: the verified preview, and the audit-tier bytes derived from it and sent)",
    "",
    "| viewport | preview | preview SHA-256 | sent (audit tier) SHA-256 | sent bytes | opaque | source | source SHA-256 |",
    "|---|---|---|---|---|---|---|---|",
  );
  for (const i of b.images) L.push(`| ${i.viewport} | \`${i.preview_file}\` | \`${i.preview_sha256}\` | \`${i.audit_sha256}\` | ${i.audit_bytes} | ${i.opaque ? "yes" : "**no**"} | \`${i.source}\` | \`${i.source_sha256}\` |`);
  if (b.images.some((i) => !i.opaque)) L.push("", "**Note:** at least one preview is not fully opaque; its transparent areas were filled white for the audit (the audit tier), so the model saw them as white.");
  L.push("");
  return L.join("\n");
}

type Sent = { images: ClaudeImage[]; meta: SentImage[]; entries: PreviewEntry[]; previewSha: string[]; previewBytes: number[]; opaque: boolean[] };

/** The audit of one delivered IMAGE_FIRST bundle (see the header). */
export async function runClaudeAudit(o: ClaudeAuditOptions): Promise<ClaudeAuditResult> {
  const now = o.now ?? Date.now;
  const dummy = o.dummy === true;
  const id = o.approvalId;
  const seams = o.testSeams ?? {};
  const dirUid = seams.dirUid ?? process.getuid?.();
  const fileUid = seams.fileUid ?? process.getuid?.();
  const ownPrivateDir = async (p: string) => {
    const info = await lstat(p).catch(() => null);
    return !!info && info.isDirectory() && !info.isSymbolicLink() && info.uid === dirUid && (info.mode & 0o077) === 0;
  };
  const readJson = async (path: string, bad: string): Promise<Record<string, unknown> | null> => {
    const b = await readPrivate(path, 64 * 1024, bad, fileUid);
    if (!b) return null;
    try {
      const v = JSON.parse(b.toString("utf8")) as unknown;
      return v && typeof v === "object" ? (v as Record<string, unknown>) : stop(bad);
    } catch {
      return stop(bad);
    }
  };
  const idOk = auditIdCheck(id, dummy);
  if (idOk !== "ok") stop(idOk);
  // a caller may only lower the limits
  const limits = { maxImages: Math.min(o.limits?.maxImages ?? AUDIT_LIMITS.maxImages, AUDIT_LIMITS.maxImages), maxBytes: Math.min(o.limits?.maxBytes ?? AUDIT_LIMITS.maxBytes, AUDIT_LIMITS.maxBytes) };
  if (o.signal?.aborted) stop("AUDIT_ABORTED");
  // the jailed Claude shares ~/.claude: never at the same time
  const jailCode = async (): Promise<string | null> => {
    const idle = await o.jailIdle().catch(() => null);
    return idle === null ? "JAIL_STATE_UNKNOWN" : idle !== true ? "JAIL_ACTIVE" : null;
  };
  const firstJail = await jailCode();
  if (firstJail) stop(firstJail);
  if (!(await ownPrivateDir(o.runsDir))) stop("RUNS_DIR_UNSAFE");
  const inbox = o.inboxDir ?? join(o.runsDir, "review-inbox");
  if (!(await ownPrivateDir(inbox))) stop("AUDIT_NOT_DELIVERED");

  let lock: Awaited<ReturnType<typeof acquireLock>>;
  try {
    lock = await acquireLock(o.stateDir, new Date(now()), "imagefirst.lock");
  } catch {
    return stop("AUDIT_LOCK_FAILED");
  }
  if (lock === undefined) return stop("AUDIT_LOCKED");
  let cwd: string | null = null;
  try {
    // 1. which bundle was delivered: the receiver's record, and (a real run) the worker's own delivery job, agree
    const rec = await readJson(join(inbox, RECORDS, `${id}.json`), "DELIVERY_RECORD_INVALID");
    if (!rec) return stop("AUDIT_NOT_DELIVERED");
    if (rec.bundle_id !== id || typeof rec.bundle_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(rec.bundle_sha256)) stop("DELIVERY_RECORD_INVALID");
    const bundleSha = rec.bundle_sha256 as string;
    if (!dummy) {
      const job = await readJson(join(o.stateDir, DELIVERIES, `${id}.json`), "DELIVERY_RECORD_INVALID");
      if (!job || job.state !== "delivered") return stop("AUDIT_NOT_DELIVERED");
      if (job.schema !== "imagefirst_bundle_delivery_v1" || job.bundle_id !== id || job.bundle_sha256 !== bundleSha) stop("DELIVERY_MISMATCH");
    }
    // 2. the sealed bundle in the inbox, verified from scratch, is that SHA
    const bundleDir = join(inbox, id);
    if (!(await exists(bundleDir))) stop("AUDIT_NOT_DELIVERED");
    let v;
    try {
      v = await verifyBundleDir(bundleDir);
    } catch (error) {
      if (error instanceof BundleStop) return stop("BUNDLE_UNVERIFIED");
      throw error;
    }
    const m = v.manifest;
    if (v.bundle_sha256 !== bundleSha || m.bundle_id !== id || m.approval_id !== id) stop("BUNDLE_UNVERIFIED");
    if (dummy && (m.plan_id !== DUMMY_AUDIT_RECORD.plan_id || m.commit !== DUMMY_AUDIT_RECORD.commit)) stop("BUNDLE_UNVERIFIED");
    // the quoted direction is the bundle's own (the id names it; verifyBundleDir tied the manifest's direction to the
    // receipt's and the id's): a d3 material never audits a d4 bundle, nor the other way round
    if (isRequestRunId(id)) {
      // DEV-303: a request run's bundle is audited against its own request's material (loadRequestAuditMaterial)
      if (m.mode !== "request" || m.direction !== "request" || o.material.direction.id !== requestMaterialId(id)) stop("AUDIT_MATERIAL_MISMATCH");
    } else if (runOfApprovalId(id)?.direction !== m.direction || o.material.direction.id !== DIRECTIONS[m.direction as RunDirection].id) stop("AUDIT_MATERIAL_MISMATCH");
    // 3. the previews already delivered next to it, for exactly this bundle (INDEX.json hashed as verifyPreviews read it)
    const previewsDir = join(inbox, PREVIEWS, id);
    if (!(await exists(previewsDir))) stop("AUDIT_NOT_DELIVERED");
    let checked;
    try {
      checked = await verifyPreviewsDetailed(previewsDir, { bundle_sha256: bundleSha });
    } catch (error) {
      if (error instanceof PreviewStop) return stop(error.code);
      throw error;
    }
    const ix = checked.index;
    if (ix.bundle_id !== id || ix.approval_id !== id || ix.plan_id !== m.plan_id || ix.commit !== m.commit) stop("PREVIEWS_NOT_FROM_BUNDLE");
    const fileSha = new Map(m.files.map((f) => [f.path, f.sha256]));
    for (const p of ix.previews) if (fileSha.get(p.source) !== p.source_sha256) stop("PREVIEWS_NOT_FROM_BUNDLE");
    await seams.afterVerify?.();
    // 4. each chosen preview read once more: its SHA must still be INDEX.json's (a file swapped after the check stops
    //    here), then the audit tier is derived in memory from exactly those bytes
    const sent: Record<AuditViewport, Sent> = { desktop_1440: { images: [], meta: [], entries: [], previewSha: [], previewBytes: [], opaque: [] }, mobile_390: { images: [], meta: [], entries: [], previewSha: [], previewBytes: [], opaque: [] } };
    const plan: PlannedCall[] = [];
    for (const vp of VIEWPORT_IDS) {
      const chosen = choose(ix.previews, vp);
      if (chosen.length === 0) stop("AUDIT_NO_IMAGES");
      if (chosen.length > limits.maxImages) stop("AUDIT_INPUT_TOO_LARGE");
      let bytes = 0;
      let previewBytes = 0;
      for (const p of chosen) {
        const b = await readPrivate(join(previewsDir, p.file), PREVIEW_LIMITS.maxBytes, "PREVIEW_SHA_MISMATCH", fileUid);
        if (!b || sha256(b) !== p.preview_sha256 || b.length !== p.bytes) return stop("PREVIEW_SHA_MISMATCH");
        const tier = await auditTierOf(b, p.width, p.height);
        bytes += tier.bytes.length;
        previewBytes += b.length;
        const label = labelOf(p);
        sent[vp].images.push({ label, bytes: tier.bytes, mediaType: AUDIT_TIER.mediaType });
        sent[vp].opaque.push(tier.opaque);
        sent[vp].meta.push({ label, kind: p.kind, source: p.source, ...rowsOf(p), width: p.width, height: p.height });
        sent[vp].entries.push(p);
        sent[vp].previewSha.push(sha256(b));
        sent[vp].previewBytes.push(b.length);
      }
      // the hard cap on what is actually sent; never shrunk further
      if (bytes > limits.maxBytes) stop("AUDIT_INPUT_TOO_LARGE");
      plan.push({ viewport: vp, images: chosen.length, bytes, preview_bytes: previewBytes });
    }
    // 5. one audit per bundle and rubric; the output is never overwritten
    const outRoot = join(inbox, AUDITS);
    if ((await exists(outRoot)) && !(await ownPrivateDir(outRoot))) stop("AUDIT_DIR_UNSAFE");
    if (await exists(join(outRoot, id))) stop("AUDIT_EXISTS");
    const markers = join(o.stateDir, AUDITS);
    const marker = join(markers, `${bundleSha}.${RUBRIC_SHA256}.used`);
    if (await exists(marker)) stop("AUDIT_ALREADY_SPENT");
    const base = { approval_id: id, bundle_sha256: bundleSha, verdict: null, plan, limits, tier: AUDIT_TIER.id };
    if (o.dryRun) return { ...base, status: "planned", code: null, dir: null, calls: 0 };

    // 6. the signed-in CLI (subscription login only), from an empty private directory outside the repository
    const env = claudeEnvironment(o.env);
    cwd = await mkdtemp(join(o.stateDir, ".claude-cwd-"));
    try {
      await assertClaudeSignedIn({ claudeBin: o.claudeBin, env, cwd, ...(o.signal ? { signal: o.signal } : {}) });
    } catch (error) {
      if (error instanceof ClaudeCallError) return stop(error.code);
      throw error;
    }
    if (o.signal?.aborted) stop("AUDIT_ABORTED");
    // PR #311 re-review L-b: the jail once more right before anything is spent (a refusal, nothing spent)
    const preMarkerJail = await jailCode();
    if (preMarkerJail) stop(preMarkerJail);
    await mkdir(markers, { recursive: true, mode: 0o700 });
    if (!(await ownPrivateDir(markers))) stop("AUDIT_DIR_UNSAFE");
    try {
      await writeFile0600(marker, `${JSON.stringify({ approval_id: id, bundle_sha256: bundleSha, rubric_sha256: RUBRIC_SHA256, at: new Date(now()).toISOString() })}\n`);
    } catch (error) {
      return stop((error as { code?: string }).code === "EEXIST" ? "AUDIT_ALREADY_SPENT" : "AUDIT_DIR_UNSAFE");
    }

    // ---- spent from here: every outcome is a returned result, never a refusal (PR #311 review L1) ----
    let calls = 0;
    try {
      // 7. one call per viewport; one re-ask in all for an unusable answer; any CLI failure stops; the jail checked before each call
      const started = new Date(now()).toISOString();
      const viewports: Record<AuditViewport, ViewportAnswer | null> = { desktop_1440: null, mobile_390: null };
      const derived: Record<AuditViewport, Derived | null> = { desktop_1440: null, mobile_390: null };
      const requestSha: Record<AuditViewport, string | null> = { desktop_1440: null, mobile_390: null };
      let reasks = 0;
      let model: string | null = null;
      let cliVersion: string | null = null;
      let stopCode: string | null = null;
      outer: for (const vp of VIEWPORT_IDS) {
        let reask = false;
        for (;;) {
          if (o.signal?.aborted) {
            stopCode = "AUDIT_ABORTED";
            break outer;
          }
          const jail = await jailCode();
          if (jail) {
            stopCode = jail;
            break outer;
          }
          const text = buildViewportAuditRequest({ viewport: vp, images: sent[vp].meta, material: o.material, reask });
          requestSha[vp] = sha256(buildUserMessage(sent[vp].images, text));
          calls += 1;
          let answer: string;
          try {
            const r = await runClaudeWithoutTools({ claudeBin: o.claudeBin, env, cwd, images: sent[vp].images, text, timeoutMs: o.timeoutMs ?? AUDIT_CALL_TIMEOUT_MS, ...(o.signal ? { signal: o.signal } : {}) });
            answer = r.answer;
            model = r.model ?? model;
            cliVersion = r.cliVersion ?? cliVersion;
          } catch (error) {
            if (!(error instanceof ClaudeCallError)) throw error;
            stopCode = error.code;
            break outer;
          }
          let parsed: ViewportAnswer | null = null;
          try {
            const p = ViewportAnswer.safeParse(extractJsonObject(answer));
            if (p.success && incoherence(p.data, vp, sent[vp].meta) === null) parsed = p.data;
          } catch (error) {
            if (!(error instanceof ClaudeCallError)) throw error;
          }
          if (parsed) {
            viewports[vp] = parsed;
            derived[vp] = deriveViewport(parsed);
            break;
          }
          if (reasks >= 1) {
            stopCode = "AUDIT_SCHEMA";
            break outer;
          }
          reasks += 1;
          reask = true;
        }
      }
      const verdict = stopCode === null ? overallVerdict([derived.desktop_1440!.verdict, derived.mobile_390!.verdict]) : null;

      // 8. the private record: validated against the strict schema, written under a temporary name, renamed into place
      const record = AuditRecord.parse({
        schema: AUDIT_SCHEMA,
        status: stopCode === null ? "completed" : "stopped",
        stop_code: stopCode,
        binding: {
          approval_id: id,
          bundle_id: m.bundle_id,
          bundle_sha256: bundleSha,
          plan_id: m.plan_id,
          commit: m.commit,
          previews_index_sha256: checked.index_sha256,
          rubric_version: AUDIT_RUBRIC_VERSION,
          rubric_sha256: RUBRIC_SHA256,
          audit_tier: AUDIT_TIER.id,
          request_sha256: requestSha,
          images: VIEWPORT_IDS.flatMap((vp) =>
            sent[vp].entries.map((p, i) => ({
              viewport: vp,
              label: sent[vp].meta[i]!.label,
              preview_file: p.file,
              preview_sha256: sent[vp].previewSha[i]!,
              preview_bytes: sent[vp].previewBytes[i]!,
              audit_sha256: sha256(sent[vp].images[i]!.bytes),
              audit_bytes: sent[vp].images[i]!.bytes.length,
              media_type: AUDIT_TIER.mediaType,
              opaque: sent[vp].opaque[i]!,
              kind: p.kind,
              source: p.source,
              source_sha256: p.source_sha256,
              ...rowsOf(p),
            })),
          ),
        },
        auditor: { via: "claude_cli_print_no_tools", cli_version: cliVersion, model_reported: model, started_at: started, finished_at: new Date(now()).toISOString(), calls, reasks },
        viewports,
        derived: { ...derived, verdict },
        advisory_only: true,
        human_confirmed: false,
        registers_success_case: false,
        not_owner_evaluation: true,
      });
      await seams.beforeWrite?.();
      await mkdir(outRoot, { mode: 0o700 }).catch((e: { code?: string }) => (e.code === "EEXIST" ? undefined : Promise.reject(e)));
      if (!(await ownPrivateDir(outRoot))) stop("AUDIT_DIR_UNSAFE");
      const tmp = join(outRoot, `.tmp-audit-${randomBytes(6).toString("hex")}`);
      const final = join(outRoot, id);
      try {
        await mkdir(tmp, { mode: 0o700 });
        await writeFile0600(join(tmp, "audit.json"), `${JSON.stringify(record, null, 2)}\n`);
        await writeFile0600(join(tmp, "AUDIT.md"), renderAuditMd(record));
        // an empty directory under the final name would be silently replaced by rename(2): checked first
        if (await exists(final)) stop("AUDIT_EXISTS");
        await rename(tmp, final);
      } finally {
        await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
      }
      return { ...base, status: record.status, code: stopCode, verdict, dir: final, calls };
    } catch (error) {
      // spent, but the record could not be written: a stop with a fixed code, never "refused" / nothing spent
      return { ...base, status: "stopped", code: error instanceof AuditStop ? error.code : "AUDIT_WRITE_FAILED", verdict: null, dir: null, calls };
    }
  } finally {
    if (cwd) await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
    await lock.release().catch(() => undefined);
  }
}

/**
 * Issue #302 (the owner's one-shot pilot, docs/operations/imagefirst-pilot.md): the audit's own sign-in check ALONE, for
 * the read-only preflight. The jail must be idle (as for the audit: both use the same ~/.claude), `parentDir` (the worker's state
 * directory) must be a private directory of ours (STATE_DIR_UNSAFE), then claude-cli.ts
 * assertClaudeSignedIn — `claude --setting-sources "" auth status` with the same scrubbed environment, from an empty
 * private directory under `parentDir` that is removed afterwards — must report the claude.ai subscription, first party,
 * with no API key. No model call, no marker, no bundle read, nothing else written. Refusals throw AuditStop.
 */
export async function checkAuditAuth(o: { claudeBin: string; env: Record<string, string | undefined>; parentDir: string; jailIdle: () => Promise<boolean | null>; signal?: AbortSignal }): Promise<void> {
  const idle = await o.jailIdle().catch(() => null);
  if (idle !== true) stop(idle === null ? "JAIL_STATE_UNKNOWN" : "JAIL_ACTIVE");
  // the worker's state directory, as for the audit's own call: a real directory of ours, closed to group and others
  const info = await lstat(o.parentDir).catch(() => null);
  if (!info || !info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) stop("STATE_DIR_UNSAFE");
  const cwd = await mkdtemp(join(o.parentDir, ".claude-auth-"));
  try {
    await assertClaudeSignedIn({ claudeBin: o.claudeBin, env: claudeEnvironment(o.env), cwd, ...(o.signal ? { signal: o.signal } : {}) });
  } catch (error) {
    if (error instanceof ClaudeCallError) stop(error.code);
    throw error;
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  }
}
