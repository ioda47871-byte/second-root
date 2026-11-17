/**
 * DEV-139 P0-2b: adapt a checked shop-specific 3-direction research record to
 * the existing v2 open-direction INPUT CONTRACT. This module deliberately does
 * NOT import the isolated design prompt, model runner, or artifact intake.
 *
 * The protected existing design CLI must validate the resulting direction and
 * owner-scoped references, build/print the prompt SHA, and request an individual
 * owner approval before any actual model call. A C1-C7 machine check is a
 * prerequisite, not a quality verdict.
 */
import { DirectionSet } from "@/lib/design-agent/quality-pipeline/direction-set";

export class BRoutePromptStop extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "BRoutePromptStop";
  }
}

/**
 * The v2 open-direction `direction_id` rule, copied (not imported: the phase2f prompt modules stay isolated) from
 * `OpenDirection.direction_id` (the Phase 2f open-direction schema). The direction-set schema allows 3-char
 * ids that v2 refuses, so such an id is stopped here instead of failing later in the protected CLI. A unit test
 * reads that file as text and fails if the two drift.
 */
export const V2_DIRECTION_ID = /^[a-z0-9][a-z0-9-]{3,60}$/;

type Reference = {
  id: string;
  case_id: string;
  view: string;
  source: { commit: string; path: string };
  webp_sha256: string;
  width: number;
  height: number;
  learn: string;
  do_not_copy: string[];
};
type ReferenceManifest = {
  schema: "phase2f_references_v1";
  owner_scope: {
    quote_verbatim: string;
    decided_on: string;
    use: "visual_reference_for_design_generation";
    max_refs_per_call: number;
  };
  refs: Reference[];
};

/**
 * Prepare the data that the *existing* v2 prompt CLI consumes.
 * No duplicate prompt builder and no wrapper that could bypass its guards.
 * A reference named in text alone never grants rights to its image.
 */
export function buildBRouteGenerationInput(input: {
  facts: unknown;
  directionSet: unknown;
  directionId: string;
  referenceManifest: unknown;
}): {
  direction: {
    schema: "phase2f_open_direction_v1";
    direction_id: string;
    concept: string;
    composition: { hero: string; flow: string };
    research: { case_id: string; adopted_for: string; lost_or_rejected: string; translate_to_this_shop: string }[];
    reference_ids: string[];
  };
  references: ReferenceManifest;
  reference_ids: string[];
  reference_count: number;
  prompt_version: "v2";
  route: "B_html_prototype";
  prompt_pin_required: true;
  executable_without_owner_approval: false;
} {
  const set = DirectionSet.safeParse(input.directionSet);
  if (!set.success) throw new BRoutePromptStop("DIRECTION_SET_SCHEMA");
  const facts = input.facts as { shop_id?: unknown } | null;
  if (!facts || typeof facts !== "object" || set.data.shop_id !== facts.shop_id)
    throw new BRoutePromptStop("SHOP_ID_MISMATCH");
  const selected = set.data.directions.find((d) => d.id === input.directionId);
  if (!selected) throw new BRoutePromptStop("DIRECTION_UNKNOWN");
  if (!V2_DIRECTION_ID.test(selected.id)) throw new BRoutePromptStop("DIRECTION_ID_NOT_V2");
  const motif = set.data.motif.candidates.find((m) => m.id === selected.motif_focus);
  if (!motif) throw new BRoutePromptStop("MOTIF_UNKNOWN");

  // The protected CLI validates the full v2 reference schema again. Here we
  // only read its explicit authorization scope, never discover extra assets.
  const manifest = input.referenceManifest as ReferenceManifest | null;
  if (
    !manifest || manifest.schema !== "phase2f_references_v1" ||
    !manifest.owner_scope ||
    manifest.owner_scope.use !== "visual_reference_for_design_generation" ||
    !Number.isInteger(manifest.owner_scope.max_refs_per_call) ||
    manifest.owner_scope.max_refs_per_call < 1 ||
    manifest.owner_scope.max_refs_per_call > 4 ||
    !Array.isArray(manifest.refs)
  ) throw new BRoutePromptStop("REFERENCES_SCHEMA");

  const research = selected.references.slice(0, 3).map((r) => ({
    case_id: r.case_id,
    adopted_for: r.use,
    lost_or_rejected: "Do not reuse the referenced shop's brand identity, photographs, composition or words. Transfer only the cited design principle.",
    translate_to_this_shop: motif.becomes_structure,
  }));
  if (research.length < 1) throw new BRoutePromptStop("DIRECTION_WITHOUT_REFERENCES");
  const caseIds = new Set(research.map((r) => r.case_id));
  const scoped = manifest.refs.filter((r) => caseIds.has(r.case_id));
  // Duplicate IDs are invalid; never silently choose an ambiguous asset.
  if (new Set(scoped.map((r) => r.id)).size !== scoped.length)
    throw new BRoutePromptStop("DUPLICATE_REFERENCES");
  const ids = scoped.slice(0, manifest.owner_scope.max_refs_per_call).map((r) => r.id);
  return {
    direction: {
      schema: "phase2f_open_direction_v1",
      direction_id: selected.id,
      concept: selected.concept,
      composition: selected.composition,
      research,
      reference_ids: ids,
    },
    references: manifest,
    reference_ids: ids,
    reference_count: ids.length,
    prompt_version: "v2",
    route: "B_html_prototype",
    prompt_pin_required: true,
    executable_without_owner_approval: false,
  };
}
