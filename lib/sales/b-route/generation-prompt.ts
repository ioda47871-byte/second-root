/**
 * DEV-139: make a pinned, original-direction B-route prompt from the existing
 * shop-specific three-direction study. This does not execute Codex and NEVER
 * approves the resulting design. The direction-set's full C1-C7 check is run
 * by the CLI before calling this pure adapter.
 */
import { createHash } from "node:crypto";
import { DirectionSet } from "@/lib/design-agent/quality-pipeline/direction-set";
import { OpenDirection, ReferenceManifest, resolveDirection } from "@/lib/design-agent/phase2f/open-direction";
import { buildDesignPrompt } from "@/lib/design-agent/phase2f/prompt";
import { FactsPack } from "@/lib/design-agent/artifact/schema";

export class BRoutePromptStop extends Error {
  constructor(public readonly code: string) { super(code); this.name = "BRoutePromptStop"; }
}

export function buildBRouteGenerationPrompt(input: {
  facts: unknown; directionSet: unknown; directionId: string; referenceManifest: unknown;
}) {
  const facts = FactsPack.safeParse(input.facts);
  const set = DirectionSet.safeParse(input.directionSet);
  const refs = ReferenceManifest.safeParse(input.referenceManifest);
  if (!facts.success) throw new BRoutePromptStop("FACTS_SCHEMA");
  if (!set.success) throw new BRoutePromptStop("DIRECTION_SET_SCHEMA");
  if (!refs.success) throw new BRoutePromptStop("REFERENCES_SCHEMA");
  if (set.data.shop_id !== facts.data.shop_id) throw new BRoutePromptStop("SHOP_ID_MISMATCH");

  const selected = set.data.directions.find((d) => d.id === input.directionId);
  if (!selected) throw new BRoutePromptStop("DIRECTION_UNKNOWN");
  const chosenMotif = set.data.motif.candidates.find((m) => m.id === selected.motif_focus);
  if (!chosenMotif) throw new BRoutePromptStop("MOTIF_UNKNOWN");
  // Do not invent source observations. A transferable reference must come from
  // the checked direction's own notes, not from a generic list of case names.
  const research = selected.references.slice(0, 3).map((r) => ({
    case_id: r.case_id,
    adopted_for: r.use,
    lost_or_rejected: "Do not reuse that shop's brand identity, imagery, layout, typography or copy. Only the named principle is transferable.",
    translate_to_this_shop: chosenMotif.becomes_structure,
  }));
  if (!research.length) throw new BRoutePromptStop("DIRECTION_WITHOUT_REFERENCES");
  // Only use model input assets already in the explicitly owner-scoped manifest.
  // A case cited as TEXT_ONLY has no image just because its ID was mentioned.
  const caseIds = new Set(research.map((x) => x.case_id));
  const referenceIds = refs.data.refs.filter((r) => caseIds.has(r.case_id))
    .slice(0, refs.data.owner_scope.max_refs_per_call).map((r) => r.id);
  const raw = {
    schema: "phase2f_open_direction_v1" as const,
    direction_id: selected.id, concept: selected.concept,
    composition: selected.composition, research, reference_ids: referenceIds,
  };
  const open = OpenDirection.safeParse(raw);
  if (!open.success) throw new BRoutePromptStop("OPEN_DIRECTION_SCHEMA");
  const resolved = resolveDirection(open.data, refs.data);
  if (!resolved.ok) throw new BRoutePromptStop(resolved.code);
  // Reuse the existing v2 prompt. No v3 experimental copy rules are activated.
  const pin = buildDesignPrompt({
    route: "B_html_prototype", facts: facts.data, maxAssets: 0,
    variant: { version: "v2", direction: resolved.direction, references: resolved.references },
  });
  return {
    direction: open.data, references: refs.data, prompt: pin.prompt,
    prompt_sha256: pin.sha256, prompt_chars: pin.chars,
    prompt_version: "v2" as const,
    route: "B_html_prototype" as const,
    reference_count: resolved.references.length,
    reference_ids: referenceIds,
    // The prompt bytes, not only these source IDs, are the execution pin.
    direction_set_content_sha256: createHash("sha256").update(JSON.stringify(set.data)).digest("hex"),
    executable_without_owner_approval: false as const,
  };
}
