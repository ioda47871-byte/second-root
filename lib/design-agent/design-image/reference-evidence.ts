/**
 * DEV-106 (Issue #128): evidence records for ten design-reference cases, observed in a real browser at 1440 px and
 * 390 px. OFFLINE validation only: nothing here fetches a page, stores an image, calls a model or the worker.
 *
 * What a record may claim, and what it may not:
 * - Captures are listed with their viewport, outcome and the sha256 of a screenshot kept OUTSIDE the repository for
 *   the analysis (image_committed is always false; no image bytes or image URLs can be stored).
 * - An observation is `observed` only for a viewport that has a loaded capture; otherwise it is `unknown` with a
 *   reason. There is no `pass` — an observation describes, it does not grade.
 * - The analysis is the AI's (a Claude session, optionally with a second opinion the owner pastes from ChatGPT). It is
 *   never a human review: human_review is `pending` in this schema version. Only the owner's own recorded decision,
 *   in a later version, may accept or reject a technique.
 * - Techniques are principles to test in an original design, each with its risk; `do_not_transfer` names what must not
 *   be copied (images, copy, logos, the site's own layout).
 */
import { z } from "zod";
import { studyTextIsUnsafe } from "./research-bridge";

/** The ten cases of Issue #128, in its order; nothing else may be recorded here. */
export const DEV106_QUEUE = ["DX-005", "DX-002", "DX-006", "DX-033", "DX-027", "DX-036", "DX-008", "DX-011", "DX-013", "DX-023"] as const;
export const VIEWPORTS = { desktop_1440: 1440, mobile_390: 390 } as const;
export type ViewportKey = keyof typeof VIEWPORTS;
const VIEWPORT_KEYS = Object.keys(VIEWPORTS) as ViewportKey[];

const clean = (s: string) => !/[\u0000-\u001f\u007f]/.test(s) && !studyTextIsUnsafe(s);
/** Short, own-words notes: long enough to say something concrete, short enough not to carry a site's copy. */
const Note = z.string().trim().min(12).max(320).refine(clean, "unsafe or control text");
const Short = z.string().trim().min(3).max(120).refine(clean, "unsafe or control text");

/** A public HTTPS page: no credentials, no fragment, no IP literal, no internal or single-label host. */
const PageUrl = z.string().max(600).superRefine((value, ctx) => {
  try {
    const u = new URL(value);
    const h = u.hostname.toLowerCase().replace(/\.$/, "");
    if (u.protocol !== "https:" || u.username || u.password || u.hash || u.port || !h.includes(".") || h.startsWith("[") ||
        /^\d{1,3}(?:\.\d{1,3}){3}$/.test(h) ||
        /(?:^|\.)(?:localhost|local|internal|localdomain|home|lan|corp|intranet|test|invalid|example|onion)$/.test(h))
      throw new Error("unsafe");
  } catch {
    ctx.addIssue({ code: "custom", message: "a public https page" });
  }
});

const Capture = z.strictObject({
  viewport: z.enum(VIEWPORT_KEYS as [ViewportKey, ...ViewportKey[]]),
  width: z.number().int(),
  height: z.number().int().min(480).max(20000),
  user_agent: z.string().min(10).max(300).refine((s) => !/[\u0000-\u001f\u007f]/.test(s)),
  /** The URL the browser ended on (after redirects); may differ from the page URL. */
  loaded_url: PageUrl.nullable(),
  http_status: z.number().int().min(100).max(599).nullable(),
  outcome: z.enum(["loaded", "blocked", "error", "unreachable"]),
  /** Fixed codes for what went wrong or was dismissed (e.g. COOKIE_BANNER_DISMISSED, NAV_TIMEOUT). */
  problems: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{2,40}$/)).max(8),
  captured_at: z.string().datetime({ offset: true }),
  /** The screenshot stays in a temporary local directory for the analysis and is never committed. */
  image_committed: z.literal(false),
  image_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
});
export type ReferenceCapture = z.infer<typeof Capture>;

const Page = z.strictObject({
  role: z.enum(["recorded_candidate_page", "first_party_brand_site"]),
  url: PageUrl,
  source_kind: z.enum(["official_brand_site", "agency_case_study", "design_gallery", "portfolio_page"]),
  /** Whether the business shown is operating; `unknown` unless a public notice or the live first-party site says so. */
  operating_status: z.enum(["live_first_party_site", "closed_per_public_notice", "unknown"]),
  operating_note: Note.nullable(),
  captures: z.array(Capture).length(2),
});

const Observation = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("observed"), note: Note }),
  z.strictObject({ status: z.literal("unknown"), reason: Note }),
]);
export const OBSERVATION_ASPECTS = ["hero", "product_or_service_visibility", "typography", "section_rhythm", "primary_cta", "practical_info", "navigation", "visual_material"] as const;
const PerViewport = z.strictObject({ desktop_1440: Observation, mobile_390: Observation });

const Technique = z.strictObject({
  technique: Short,
  why_it_works: Note,
  where_it_fits: Note,
  risk: Note,
});

const EvidenceRecord = z.strictObject({
  id: z.enum(DEV106_QUEUE),
  case_name: Short,
  candidate_source_url: PageUrl,
  pages: z.array(Page).min(1).max(2),
  observations: z.strictObject(Object.fromEntries(OBSERVATION_ASPECTS.map((a) => [a, PerViewport])) as Record<(typeof OBSERVATION_ASPECTS)[number], typeof PerViewport>),
  design_features: z.array(Note).min(1).max(8),
  transferable_techniques: z.array(Technique).max(5),
  weaknesses: z.array(Note).min(1).max(6),
  desktop_vs_mobile: z.array(Note).max(6),
  do_not_transfer: z.array(Note).min(1).max(6),
  analysis: z.strictObject({
    primary: z.literal("claude_session"),
    /** A second opinion the owner pasted from a ChatGPT session; null until then. Still not a human review. */
    second_opinion: z.strictObject({ by: z.literal("chatgpt_via_owner"), summary: Note }).nullable(),
  }),
  /** v1: always pending. Accepting or rejecting is the owner's own decision, recorded in a later version. */
  human_review: z.strictObject({ status: z.literal("pending") }),
});
export type ReferenceEvidence = z.infer<typeof EvidenceRecord>;

const File = z.strictObject({
  schema_version: z.literal(1),
  task: z.literal("DEV-106"),
  status: z.literal("ai_analysis_pending_owner_review"),
  method: Note,
  records: z.array(EvidenceRecord).max(DEV106_QUEUE.length),
});
export type ReferenceEvidenceFile = z.infer<typeof File>;

export class ReferenceEvidenceError extends Error {
  readonly code = "REFERENCE_EVIDENCE_INVALID";
  constructor(message: string) { super(message); this.name = "ReferenceEvidenceError"; }
}

/**
 * Parses an evidence file against the DEV-105 candidates (id → recorded source URL). Fails closed on anything a
 * record could overclaim: an observation for a viewport no loaded capture backs, a width that is not the viewport's,
 * a candidate URL that is not the recorded one, a missing or doubled viewport.
 */
export function parseReferenceEvidence(input: unknown, candidateUrls: ReadonlyMap<string, string>): ReferenceEvidenceFile {
  const parsed = File.safeParse(input);
  if (!parsed.success) throw new ReferenceEvidenceError("schema_or_overclaim");
  const file = parsed.data;
  const ids = file.records.map((r) => r.id);
  if (new Set(ids).size !== ids.length) throw new ReferenceEvidenceError("duplicate_id");
  for (const r of file.records) {
    if (candidateUrls.get(r.id) !== r.candidate_source_url) throw new ReferenceEvidenceError("candidate_url_mismatch");
    if (r.pages.filter((p) => p.role === "recorded_candidate_page").length !== 1 || r.pages[0]!.role !== "recorded_candidate_page" || r.pages[0]!.url !== r.candidate_source_url)
      throw new ReferenceEvidenceError("candidate_page_missing");
    for (const p of r.pages) {
      const seen = p.captures.map((c) => c.viewport).sort().join("|");
      if (seen !== [...VIEWPORT_KEYS].sort().join("|")) throw new ReferenceEvidenceError("viewport_missing_or_doubled");
      for (const c of p.captures) {
        if (c.width !== VIEWPORTS[c.viewport]) throw new ReferenceEvidenceError("width_not_viewport");
        // a loaded capture has a screenshot hash and an end URL; anything else has none to point to
        if (c.outcome === "loaded" && (c.image_sha256 === null || c.loaded_url === null)) throw new ReferenceEvidenceError("loaded_without_capture");
        if (c.outcome !== "loaded" && c.image_sha256 !== null) throw new ReferenceEvidenceError("image_without_load");
      }
    }
    for (const v of VIEWPORT_KEYS) {
      const loaded = r.pages.some((p) => p.captures.some((c) => c.viewport === v && c.outcome === "loaded"));
      for (const a of OBSERVATION_ASPECTS) if (!loaded && r.observations[a][v].status === "observed") throw new ReferenceEvidenceError("observed_without_loaded_capture");
    }
    // a technique is only offered from a case someone could actually see
    const anyLoaded = r.pages.some((p) => p.captures.some((c) => c.outcome === "loaded"));
    if (!anyLoaded && r.transferable_techniques.length > 0) throw new ReferenceEvidenceError("technique_without_evidence");
  }
  return file;
}

/** Counts that cannot be read as approval: observed vs unknown per viewport, and nothing human-reviewed. */
export function referenceEvidenceSummary(file: ReferenceEvidenceFile) {
  const count = (v: ViewportKey, s: "observed" | "unknown") =>
    file.records.reduce((n, r) => n + OBSERVATION_ASPECTS.filter((a) => r.observations[a][v].status === s).length, 0);
  return {
    records: file.records.length,
    queue: DEV106_QUEUE.length,
    observed: { desktop_1440: count("desktop_1440", "observed"), mobile_390: count("mobile_390", "observed") },
    unknown: { desktop_1440: count("desktop_1440", "unknown"), mobile_390: count("mobile_390", "unknown") },
    techniques_proposed: file.records.reduce((n, r) => n + r.transferable_techniques.length, 0),
    human_reviewed: 0 as const,
  };
}
