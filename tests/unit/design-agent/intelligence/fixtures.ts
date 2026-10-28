// DEV-112: fictional research corpus only (no real shop names, URLs or photos).

const DENY = [
  "copy_specific_composition",
  "copy_or_reuse_brand_logo_or_photography",
  "copy_specific_text_or_color_recipe",
  "claim_client_approval_or_website_launch",
  "feed_into_production_generators_without_separate_review",
];

export const fictionalCase = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: `Fictional ${id}`,
  category: "bakery",
  owner_selection: "owner_approved_research_success",
  implementation: "concept_image_only",
  shop_motifs: ["wooden shelf of loaves", "morning bake"],
  structural_translation: "Turn the shelf into the page grid so each product sits on its own ledge",
  visual_mechanisms: ["ledges as section dividers"],
  why_selected: [{ statement: "Owner selected the shelf structure", basis: "owner_selection" }],
  known_failure_modes: ["Falling back to a left-text right-image module"],
  not_to_copy: ["exact ledge proportions"],
  implementation_gap: "No HTML PoC",
  evidence_ref: `design-library/success-cases/${id}-Fictional.md`,
  ...over,
});

export function fictionalFiles() {
  return {
    manifest: {
      schema_version: 1,
      records: [
        { id: "CP-901", status: "owner_selected_research_success_example", view: "concept_art" },
        { id: "CP-902", status: "owner_selected_research_design_success", view: "interactive_html_css_js_local_poc", approved_html_sha256: "a".repeat(64) },
      ],
      policy: {
        not_templates: true,
        never_reuse_generated_photos_or_logos_for_other_shops: true,
        release_or_deployment_approval: false,
        do_not_mix_with_v02_v03_reference_candidate_counts: true,
      },
    },
    patterns: {
      schema_version: 1,
      as_of: "2026-10-28",
      scope: "research_only_not_auto_prompt_input",
      status: "owner_selected_case_analysis_not_approved_for_automatic_reuse",
      provenance: { basis: "Owner preferences; composition mappings are analysis, not measured causal facts" },
      limitations: ["User acceptance of a design is not confirmation of the causal mechanism inferred by analysis"],
      reuse_policy: {
        allow: "Reason about how shop-specific verified facts could inspire an original composition; require human selection",
        deny: [...DENY],
        design_principles_are_not_templates: true,
        quality_gates: ["verified_shop_facts", "human_signoff_before_promotion"],
      },
      cases: [
        fictionalCase("CP-901"),
        fictionalCase("CP-902", {
          category: "florist",
          implementation: "local_html_css_js_poc",
          shop_motifs: ["fitting room mirror", "seasonal stems"],
          structural_translation: "A fitting-room rail becomes the navigation between looks",
          visual_mechanisms: ["rail navigation", "partial mirror crops"],
          known_failure_modes: ["Generic photo cards"],
          not_to_copy: ["LOOK labels"],
        }),
      ],
    },
    queue: { schema_version: 1, status: "prioritized_research_queue_not_a_completed_audit", batch_a: { count: 1 }, batch_b: { count: 0 }, queue: [{ id: "DX-002", human_review: "pending", approval_for_generation: false }] },
    referencesV02: { counts: { total_research_references: 2 }, references: [{ id: "DX-001" }, { id: "DX-002" }] },
    candidatesV03: [
      { status: "research_candidates_not_approved", record_count: 1, references: [{ id: "DX-003" }] },
      { status: "research_candidates_not_approved", record_count: 1, references: [{ id: "DX-004" }] },
    ],
    sha256: {},
  };
}
