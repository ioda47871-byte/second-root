/**
 * Offline bridge from a *reviewed* site-study snapshot to a store-specific
 * design-direction candidate. It never fetches websites, runs Codex, chooses
 * a category template, reads customer/worker data, or modifies the pinned v2
 * PoC prompt. The historical 40-source/9-technique raw files are NOT assumed
 * to exist; a human must map and review them before passing this contract.
 */
import { z } from "zod";
import { DESIGN_DNA_PARTS, parseDesignDna, type DesignDnaPart } from "./design-dna";

const Identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{1,59}$/);
/**
 * Phrases that address a model rather than describe a design (study text is data, never instructions).
 * A heuristic only: it is narrow so ordinary design prose ("show the key visual", "ignore strict grid
 * rules", "顧客の秘密情報を表示しない") passes, and it can be evaded. The person's review is the control.
 */
const INSTRUCTION_LIKE = new RegExp([
  String.raw`\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+)?(?:of\s+)?(?:the\s+|your\s+)?(?:previous|prior|above|earlier|preceding|system)\b`,
  String.raw`\bsystem\s+prompt\b`,
  String.raw`\b(?:reveal|dump|exfiltrate|leak)\b[^.]{0,30}\b(?:secrets?|passwords?|credentials?|api\s+keys?|tokens?)\b`,
  String.raw`(?:前|これまで|上記|以前)の指示`,
  String.raw`指示を無視`,
  String.raw`秘密情報を(?:表示|出力|送信|教え)(?!しない|せず|しません)`,
].join("|"), "i");
/** Markup or a link that could be rendered or followed: a tag start, a markdown link, a script/data URL. */
const MARKUP_LIKE = /[\u0000-\u001f\u007f]|<<<|>>>|<\/?[a-z][a-z0-9-]*(?:[\s/>]|$)|<!|\]\(|\b(?:javascript|vbscript|file):|\bdata:\s*[a-z]+\//i;
const StudyText = z.string().min(8).max(300).refine((s) => !MARKUP_LIKE.test(s) && !INSTRUCTION_LIKE.test(s), "unsafe study text");
const HTTPS = z.string().min(9).max(600).transform((s, ctx) => {
  try {
    const url = new URL(s);
    const host = url.hostname.replace(/\.$/, "");
    if (url.protocol !== "https:" || url.username || url.password || !host || url.hash ||
        host.startsWith("[") || /^\d+(?:\.\d+){3}$/.test(host) || !host.includes(".") ||
        /(?:^|\.)(?:localhost|local|internal|localdomain|home|lan|corp|intranet)$/.test(host)) throw new Error("unsafe URL");
    return url.href;
  } catch {
    ctx.addIssue({ code: "custom", message: "unsafe source URL" });
    return z.NEVER;
  }
});
const Review = z.strictObject({
  status: z.enum(["candidate", "human_reviewed"]),
  reviewer: Identifier.nullable(),
  reviewed_at: z.string().datetime({ offset: true }).nullable(),
}).superRefine((r, ctx) => {
  if (r.status === "human_reviewed" && (!r.reviewer || !r.reviewed_at))
    ctx.addIssue({ code: "custom", message: "review attribution required" });
  if (r.status === "candidate" && (r.reviewer !== null || r.reviewed_at !== null))
    ctx.addIssue({ code: "custom", message: "candidate is not reviewed" });
});
/**
 * Where an imported record came from (optional). It keeps the original library's own review label verbatim
 * (e.g. "partial_visual_review_of_public_reference"); that label is NOT a human review and never sets `review`.
 */
const SourceProvenance = z.strictObject({
  library: z.literal("design_research_v02"),
  original_id: Identifier,
  original_review_status: z.string().regex(/^[a-z][a-z_]{2,59}$/),
});
const Source = z.strictObject({
  id: Identifier,
  url: HTTPS,
  scope: z.enum(["public_visual_only", "site_structure_only", "desktop_reviewed"]),
  rights: z.literal("analysis_only"),
  observed_principle: StudyText,
  review: Review,
  provenance: SourceProvenance.optional(),
});
const Card = z.strictObject({
  id: Identifier,
  part: z.enum(DESIGN_DNA_PARTS),
  source_ids: z.array(Identifier).min(1).max(6),
  transferable_principle: StudyText,
  use: StudyText,
  avoid: StudyText,
  review: Review,
  /** An imported card: its original id, and that its Design DNA part was assigned by a Claude session (unreviewed). */
  provenance: z.strictObject({
    library: z.literal("design_research_v02"),
    original_id: Identifier,
    part_assigned_by: z.literal("claude_session_unreviewed"),
  }).optional(),
});
const Snapshot = z.strictObject({
  schema_version: z.literal(1),
  status: z.literal("research_only"),
  sources: z.array(Source).min(1).max(100),
  technique_cards: z.array(Card).min(1).max(30),
});
export type DesignResearchSnapshot = z.infer<typeof Snapshot>;
export class DesignResearchError extends Error {
  readonly code = "DESIGN_RESEARCH_INVALID";
  constructor(message: string) { super(message); this.name = "DesignResearchError"; }
}
export function parseDesignResearchSnapshot(input: unknown): DesignResearchSnapshot {
  const parsed = Snapshot.safeParse(input);
  if (!parsed.success) throw new DesignResearchError("snapshot:schema");
  const data = parsed.data;
  const ids = (a: readonly { id: string }[]) => new Set(a.map((v) => v.id)).size === a.length;
  if (!ids(data.sources) || !ids(data.technique_cards)) throw new DesignResearchError("snapshot:duplicate_ids");
  const sources = new Set(data.sources.map((s) => s.id));
  for (const c of data.technique_cards) {
    if (new Set(c.source_ids).size !== c.source_ids.length || c.source_ids.some((s) => !sources.has(s)))
      throw new DesignResearchError("card:unknown_or_duplicate_source");
  }
  // one page counts once: /a, /a/ and /a?utm=1 are the same source
  const page = (u: string) => { const x = new URL(u); return x.origin + x.pathname.replace(/\/+$/, ""); };
  if (new Set(data.sources.map((s) => page(s.url))).size !== data.sources.length)
    throw new DesignResearchError("snapshot:duplicate_urls");
  return data;
}
export type SelectedResearchTechnique = {
  part: DesignDnaPart;
  design_choice: string;
  evidence_ids: string[];
  technique_id: string;
  technique_principle: string;
  proposed_use: string;
  avoid_copy: string;
  reference_urls: string[];
};
export type ResearchToDnaPlan = {
  kind: "offline_design_research_candidate";
  shop_key: string;
  status: "review_ready" | "insufficient_reviewed_sources";
  selected: SelectedResearchTechnique[];
  distinct_sources: number;
  /** This is NOT authorization to call imagegen or rewrite the v2 prompt. */
  image_generation_approved: false;
  warnings: string[];
};
/**
 * A card is usable ONLY if its reviewed source is in the brief's declared
 * reference list AND cited by that part's decision. That prevents a random
 * site's branding, photography or statements becoming a shop direction.
 *
 * Results are hypotheses for a human art director; source review metadata
 * alone cannot prove originality, factual truth or a real human review.
 */
export function selectDesignResearch(
  rawBrief: unknown, rawSnapshot: unknown, limit = 5,
): ResearchToDnaPlan {
  const brief = parseDesignDna(rawBrief);
  const snapshot = parseDesignResearchSnapshot(rawSnapshot);
  if (!Number.isSafeInteger(limit) || limit < 3 || limit > 5) throw new DesignResearchError("limit");
  const sourceById = new Map(snapshot.sources.map((s) => [s.id, s]));
  const refByUrl = new Map(brief.references.map((r) => [r.url, r]));
  const picked: SelectedResearchTechnique[] = [];
  const parts = new Set<string>();
  const sourcesUsed = new Set<string>();
  for (const part of DESIGN_DNA_PARTS) {
    if (picked.length >= limit) break;
    const decision = brief.decisions.find((d) => d.part === part)!;
    const card = snapshot.technique_cards.find((c) =>
      c.part === part && c.review.status === "human_reviewed" &&
      c.source_ids.some((id) => {
        const source = sourceById.get(id);
        const ref = source && refByUrl.get(source.url);
        return source?.review.status === "human_reviewed" && !!ref &&
          decision.reference_ids.includes(ref.id) && ref.rights === "analysis_only" &&
          ref.scope === source.scope;
      }),
    );
    if (!card) continue;
    const urls = card.source_ids.flatMap((id) => {
      const s = sourceById.get(id)!;
      const ref = refByUrl.get(s.url);
      return s.review.status === "human_reviewed" && ref &&
        decision.reference_ids.includes(ref.id) && ref.scope === s.scope ? [s.url] : [];
    });
    if (!urls.length) continue;
    parts.add(part);
    urls.forEach((u) => sourcesUsed.add(u));
    picked.push({
      part, design_choice: decision.choice, evidence_ids: [...decision.evidence_ids],
      technique_id: card.id, technique_principle: card.transferable_principle,
      proposed_use: card.use, avoid_copy: card.avoid, reference_urls: urls,
    });
  }
  const enough = picked.length >= 3 && sourcesUsed.size >= 2;
  return {
    kind: "offline_design_research_candidate",
    shop_key: brief.shop_key,
    status: enough ? "review_ready" : "insufficient_reviewed_sources",
    selected: picked,
    distinct_sources: sourcesUsed.size,
    image_generation_approved: false,
    warnings: [
      "Source material and the original 40/9 corpus must be verified; a declared human_reviewed status is not proof of actual review.",
      "This report is NOT a live image prompt. Existing pinned v1/v2 prompts, PoC, worker and publication are unchanged.",
      ...(!enough ? ["Need at least three linked reviewed techniques across two distinct reviewed sources."] : []),
    ],
  };
}
