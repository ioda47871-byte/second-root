/**
 * Design DNA: an OFFLINE, research-only contract between store analysis and
 * original art direction. It does not choose a preset, invoke a model, fetch a
 * URL, touch the worker, or authorize publishing.
 *
 * Human / art-director judgment supplies the creative decisions. This module
 * checks provenance, coverage, and a coarse copy/paste signature only.
 */
export const DESIGN_DNA_PARTS = [
  "hero", "typography", "palette", "product_visual", "section_rhythm",
  "navigation", "mobile", "implementation",
] as const;
export type DesignDnaPart = (typeof DESIGN_DNA_PARTS)[number];
export type DesignDnaEvidence = {
  id: string;
  origin: "verified_shop_fact" | "owner_direction";
  observation: string;
  source_label: string;
};
export type DesignDnaReference = {
  id: string;
  url: string;
  scope: "public_visual_only" | "site_structure_only" | "desktop_reviewed";
  observed_principle: string;
  transferable_idea: string;
  rights: "analysis_only";
};
export type DesignDnaDecision = {
  part: DesignDnaPart;
  choice: string;
  rationale: string;
  evidence_ids: string[];
  reference_ids: string[];
};
export type DesignDnaBrief = {
  schema_version: 1;
  shop_key: string;
  status: "research_only";
  factual_copy: "verified_facts_only";
  asset_policy: "none" | "ai_concept_review_required" | "approved_real_only";
  evidence: DesignDnaEvidence[];
  references: DesignDnaReference[];
  decisions: DesignDnaDecision[];
};

export class DesignDnaError extends Error {
  readonly code = "DESIGN_DNA_INVALID";
  constructor(reason: string) {
    super(reason);
    this.name = "DesignDnaError";
  }
}
type Dict = Record<string, unknown>;
const isDict = (value: unknown): value is Dict =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const fail = (reason: string): never => { throw new DesignDnaError(reason); };
const exact = (value: Dict, keys: readonly string[], context: string): void => {
  if (Object.keys(value).sort().join("|") !== [...keys].sort().join("|")) fail(`${context}:fields`);
};
const str = (value: unknown, context: string, max = 360): string => {
  if (typeof value !== "string" || value.trim().length < 2 || value.length > max ||
      /[\u0000-\u001f\u007f]/.test(value) || value.includes("<<<") || value.includes(">>>"))
    fail(`${context}:text`);
  return value as string;
};
const id = (value: unknown, context: string): string => {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/.test(value))
    fail(`${context}:id`);
  return value as string;
};
const choose = <T extends string>(value: unknown, choices: readonly T[], context: string): T => {
  if (typeof value !== "string" || !choices.includes(value as T)) fail(`${context}:enum`);
  return value as T;
};
const list = (value: unknown, min: number, max: number, context: string): unknown[] => {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(`${context}:count`);
  return value as unknown[];
};
const ids = (value: unknown, context: string): string[] => {
  const found = list(value, 0, 8, context).map((v) => id(v, context));
  if (new Set(found).size !== found.length) fail(`${context}:duplicate`);
  return found;
};
const dict = (value: unknown, context: string): Dict => {
  if (!isDict(value)) fail(`${context}:object`);
  return value as Dict;
};

/**
 * Validate a manually curated, store-specific brief. No third-party words or
 * media become shop facts. An absent evidence link fails closed.
 */
export function parseDesignDna(value: unknown): DesignDnaBrief {
  const b = dict(value, "brief");
  exact(b, ["schema_version", "shop_key", "status", "factual_copy", "asset_policy", "evidence", "references", "decisions"], "brief");
  if (b.schema_version !== 1) fail("brief:version");
  const shop_key = id(b.shop_key, "shop_key");
  const status = choose(b.status, ["research_only"] as const, "status");
  const factual_copy = choose(b.factual_copy, ["verified_facts_only"] as const, "factual_copy");
  const asset_policy = choose(b.asset_policy, ["none", "ai_concept_review_required", "approved_real_only"] as const, "asset_policy");
  const evidence = list(b.evidence, 1, 16, "evidence").map((v, i) => {
    const e = dict(v, `evidence:${i}`);
    exact(e, ["id", "origin", "observation", "source_label"], "evidence");
    return {
      id: id(e.id, "evidence_id"),
      origin: choose(e.origin, ["verified_shop_fact", "owner_direction"] as const, "origin"),
      observation: str(e.observation, "observation"),
      source_label: str(e.source_label, "source_label", 160),
    };
  });
  const references = list(b.references, 0, 8, "references").map((v, i) => {
    const r = dict(v, `reference:${i}`);
    exact(r, ["id", "url", "scope", "observed_principle", "transferable_idea", "rights"], "reference");
    const url = str(r.url, "reference_url", 600);
    let parsed: URL;
    try { parsed = new URL(url); } catch { return fail("reference_url:parse"); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || !parsed.hostname)
      fail("reference_url:unsafe");
    return {
      id: id(r.id, "reference_id"), url,
      scope: choose(r.scope, ["public_visual_only", "site_structure_only", "desktop_reviewed"] as const, "reference_scope"),
      observed_principle: str(r.observed_principle, "observed_principle"),
      transferable_idea: str(r.transferable_idea, "transferable_idea"),
      rights: choose(r.rights, ["analysis_only"] as const, "rights"),
    };
  });
  const ev = new Set(evidence.map((e) => e.id)), refs = new Set(references.map((r) => r.id));
  if (ev.size !== evidence.length || refs.size !== references.length) fail("duplicate_ids");
  const decisions = list(b.decisions, DESIGN_DNA_PARTS.length, DESIGN_DNA_PARTS.length, "decisions").map((v, i) => {
    const d = dict(v, `decision:${i}`);
    exact(d, ["part", "choice", "rationale", "evidence_ids", "reference_ids"], "decision");
    const evidence_ids = ids(d.evidence_ids, "decision_evidence"), reference_ids = ids(d.reference_ids, "decision_refs");
    if (!evidence_ids.length || evidence_ids.some((e) => !ev.has(e)) || reference_ids.some((r) => !refs.has(r)))
      fail("decision:unverified_link");
    return {
      part: choose(d.part, DESIGN_DNA_PARTS, "part"),
      choice: str(d.choice, "choice"),
      rationale: str(d.rationale, "rationale"),
      evidence_ids, reference_ids,
    };
  });
  if (new Set(decisions.map((d) => d.part)).size !== DESIGN_DNA_PARTS.length)
    fail("decisions:coverage");
  return { schema_version: 1, shop_key, status, factual_copy, asset_policy, evidence, references, decisions };
}

/** Coarse collision test: catches wholesale reuse, NOT conceptual similarity. */
export function sameDesignDna(a: DesignDnaBrief, b: DesignDnaBrief): boolean {
  const fingerprint = (brief: DesignDnaBrief) =>
    DESIGN_DNA_PARTS.map((part) =>
      brief.decisions.find((d) => d.part === part)!.choice.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase(),
    ).join("\u241e");
  return fingerprint(a) === fingerprint(b);
}
