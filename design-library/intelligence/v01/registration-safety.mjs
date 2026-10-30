/**
 * Research-only registration guard for PR #158.
 * Never grants production, merchant, sales or model-generation permissions.
 *
 * The original CP-001..024 set (excluding 014 and 025) is frozen as two
 * Git-blob-pinned JSON files from PR #142. The pin prevents treating a
 * modified "baseline" as the owner's approved 23-case record.
 */
import { createHash } from "node:crypto";

const ORIGINAL_BLOBS = Object.freeze({
  manifest: "4c386fcc33f89a2f25b462d8307267eb71c31a97",
  patterns: "9a8807b534679351510397649f5b2e3f6d6ea946",
});
const EXTRA_IDS = ["CP-026","CP-027","CP-028","CP-029","CP-030","CP-031","CP-032"];
const EXTRA_LEVELS = [
  "positive_then_continued_plus_group_adoption",
  "verbatim_quote_retrieved_not_repo_archived",
  "group_adoption_reported_no_individual_quote",
  "group_adoption_reported_no_individual_quote",
  "group_adoption_reported_no_individual_quote",
  "group_adoption_reported_no_individual_quote",
  "group_adoption_reported_no_individual_quote",
];
const RECORD_FIELDS = "id title status source_kind category view owner_selected_at design_approval_scope owner_decision_evidence_level owner_decision_quote_primary_replay_verified analysis_requires_independent_review binary_original_verification research_original_candidate_filename official_client_work merchant_authorized website_deployed nextjs_build_verified html_css_impl_verified mobile_web_impl_verified image_asset_uploaded_to_github approved_for_generation approved_for_sales approved_for_production web_presence_status sales_qualification approved_version analysis_evidence_ref owner_evidence_source evidence_note_git_blob_sha".split(" ");
const PATTERN_FIELDS = "id name category owner_selection implementation shop_motifs structural_translation visual_mechanisms why_selected known_failure_modes not_to_copy implementation_gap evidence_ref".split(" ");
const MANIFEST_FIELDS = "schema_version dataset catalog_date records policy registered_case_count registered_local_poc_count".split(" ");
const MANIFEST_POLICY_FIELDS = "not_templates never_reuse_generated_photos_or_logos_for_other_shops not_official_client_work release_or_deployment_approval do_not_mix_with_v02_v03_reference_candidate_counts source_master_assets".split(" ");
const PROVENANCE_FIELDS = "case_docs case_registry basis".split(" ");
const PATTERNS_FIELDS = "schema_version dataset as_of scope status owner_acceptance provenance reuse_policy cases limitations registered_case_count registered_local_poc_count".split(" ");
const REQUIRED_DENY = ["copy_specific_composition","copy_or_reuse_brand_logo_or_photography","copy_specific_text_or_color_recipe","claim_client_approval_or_website_launch","feed_into_production_generators_without_separate_review"];
const fail = (code) => { throw new Error("RESEARCH_GUARD_" + code); };
const assert = (condition, code) => { if (!condition) fail(code); };
const keysEqual = (object, allowed) =>
  object !== null && typeof object === "object" && !Array.isArray(object) &&
  Object.keys(object).sort().join("|") === [...allowed].sort().join("|");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function gitBlobSha(text) {
  const bytes = Buffer.from(text, "utf8");
  return createHash("sha1").update("blob " + bytes.length + "\0").update(bytes).digest("hex");
}

function parseOriginal(raw, expected, kind) {
  assert(typeof raw === "string" && gitBlobSha(raw) === expected, "FROZEN_" + kind + "_SHA");
  try { return JSON.parse(raw); }
  catch { fail("FROZEN_" + kind + "_JSON"); }
}

/**
 * raw originals are required; never accept a caller-supplied unpinned baseline.
 */
export function verifyCaseSafety(manifest, patterns, originals) {
  assert(originals !== null && typeof originals === "object", "FROZEN_BASE_REQUIRED");
  const frozenManifest = parseOriginal(originals.manifest, ORIGINAL_BLOBS.manifest, "MANIFEST");
  const frozenPatterns = parseOriginal(originals.patterns, ORIGINAL_BLOBS.patterns, "PATTERNS");
  assert(keysEqual(manifest, MANIFEST_FIELDS) && keysEqual(patterns, PATTERNS_FIELDS), "TOP_LEVEL_KEYS");
  assert(manifest.schema_version === 1 && patterns.schema_version === 1, "SCHEMA_VERSION");
  assert(manifest.dataset === frozenManifest.dataset && patterns.dataset === frozenPatterns.dataset, "DATASET_IDENTITY");
  assert(manifest.catalog_date === "2026-10-31" && patterns.as_of === "2026-10-31", "CATALOG_DATE");
  assert(Array.isArray(manifest.records) && Array.isArray(patterns.cases), "CASE_ARRAYS");
  const records = manifest.records, cases = patterns.cases;
  assert(records.length === 30 && cases.length === 30, "REGISTERED_COUNT");
  assert(manifest.registered_case_count === 30 && patterns.registered_case_count === 30, "DECLARED_COUNT");
  const pocCount = cases.filter(x => x && x.implementation === "local_html_css_js_poc").length;
  assert(pocCount === 17 && manifest.registered_local_poc_count === 17 && patterns.registered_local_poc_count === 17, "POC_COUNT");

  assert(same(records.slice(0, 23), frozenManifest.records), "LEGACY_MANIFEST_MUTATED");
  assert(same(cases.slice(0, 23), frozenPatterns.cases), "LEGACY_PATTERNS_MUTATED");
  assert(frozenManifest.records.length === 23 && frozenPatterns.cases.length === 23, "FROZEN_COUNTS");
  const expected = [...frozenManifest.records.map(x => x.id), ...EXTRA_IDS];
  assert(same(records.map(x => x.id), expected) && same(cases.map(x => x.id), expected), "EXACT_ID_ORDER");
  assert(expected.every(x => /^CP-\d{3}$/.test(x)), "ID_FORMAT");
  assert(keysEqual(manifest.policy, MANIFEST_POLICY_FIELDS) && keysEqual(patterns.provenance, PROVENANCE_FIELDS), "POLICY_AND_PROVENANCE_KEYS");
  assert(manifest.policy?.not_templates === true &&
    manifest.policy?.never_reuse_generated_photos_or_logos_for_other_shops === true &&
    manifest.policy?.not_official_client_work === true &&
    manifest.policy?.release_or_deployment_approval === false &&
    manifest.policy?.do_not_mix_with_v02_v03_reference_candidate_counts === true,
    "MANIFEST_POLICY");
  assert(patterns.scope === "research_only_not_auto_prompt_input" &&
    patterns.status === "owner_selected_case_analysis_not_approved_for_automatic_reuse" &&
    patterns.owner_acceptance === frozenPatterns.owner_acceptance &&
    patterns.reuse_policy?.design_principles_are_not_templates === true &&
    REQUIRED_DENY.every(x => patterns.reuse_policy.deny?.includes(x)) &&
    same(patterns.reuse_policy, frozenPatterns.reuse_policy), "PATTERN_POLICY");

  // Even an older case with no approval flag must not gain one.
  for (const x of records) {
    assert(x.approved_for_generation !== true && x.approved_for_sales !== true &&
      x.approved_for_production !== true && x.official_client_work !== true &&
      x.merchant_authorized !== true && x.website_deployed !== true,
      "NO_LEGACY_PERMISSION_ESCALATION");
  }
  for (let i = 0; i < EXTRA_IDS.length; i++) {
    const id = EXTRA_IDS[i], x = records[23 + i], y = cases[23 + i];
    assert(keysEqual(x, RECORD_FIELDS) && keysEqual(y, PATTERN_FIELDS), "UNKNOWN_FIELD_" + id);
    assert(x.id === id && y.id === id && x.title === y.name && x.category === y.category, "CASE_IDENTITY_" + id);
    assert(x.status === "owner_selected_research_design_success" &&
      x.design_approval_scope === "second_root_research_success_full_page_only" &&
      x.owner_selected_at === "2026-10-29", "RESEARCH_SCOPE_" + id);
    assert(x.owner_decision_evidence_level === EXTRA_LEVELS[i] &&
      y.owner_selection === EXTRA_LEVELS[i] &&
      x.owner_decision_quote_primary_replay_verified === false &&
      x.analysis_requires_independent_review === true, "EVIDENCE_LEVEL_" + id);
    assert(typeof x.owner_evidence_source === "string" &&
      x.owner_evidence_source.includes("2026-10-29") &&
      (id === "CP-027" ? x.owner_evidence_source.includes("成功例とします") :
        x.owner_evidence_source.includes("grouped adoption")),
      "EVIDENCE_SOURCE_" + id);
    assert(x.source_kind === "chat_research_analysis_metadata_original_binary_unverified" &&
      x.binary_original_verification === "original_unavailable" &&
      /^SecondRoot_CP0(26|27|28|29|30|31|32)_[A-Za-z0-9_]+\.zip$/.test(x.research_original_candidate_filename), "ORIGINAL_UNVERIFIED_" + id);
    assert(x.official_client_work === false && x.merchant_authorized === false &&
      x.website_deployed === false && x.nextjs_build_verified === false &&
      x.image_asset_uploaded_to_github === false && x.approved_for_generation === false &&
      x.approved_for_sales === false && x.approved_for_production === false,
      "NO_PERMISSION_" + id);
    assert(x.html_css_impl_verified === "reported_local_chromium_not_replayed" &&
      x.mobile_web_impl_verified === "reported_local_chromium_not_replayed" &&
      x.web_presence_status === "HOLD_UNCONFIRMED_SOCIAL_BIO_LINK" &&
      x.sales_qualification === "HOLD_UNVERIFIED_WEBSITE_ABSENCE",
      "NOT_VERIFIED_" + id);
    assert(x.view === "interactive_html_css_js_local_poc_full_page" &&
      y.implementation === "local_html_css_js_poc", "IMPLEMENTATION_" + id);
    assert(typeof x.approved_version === "string" && x.approved_version.length > 3, "VERSION_" + id);
    assert(typeof x.evidence_note_git_blob_sha === "string" &&
      /^[0-9a-f]{40}$/.test(x.evidence_note_git_blob_sha), "NOTE_BLOB_" + id);
    assert(typeof y.evidence_ref === "string" &&
      /^design-library\/success-cases\/CP-\d{3}-[A-Za-z0-9-]+\.md$/.test(y.evidence_ref) &&
      y.evidence_ref.startsWith("design-library/success-cases/" + id + "-") &&
      y.evidence_ref === x.analysis_evidence_ref, "EVIDENCE_REF_" + id);
    assert(Array.isArray(y.why_selected) && y.why_selected.length >= 1 &&
      y.why_selected.every(z => keysEqual(z, ["statement", "basis"])), "WHY_SELECTED_KEYS_" + id);
    assert(Array.isArray(y.shop_motifs) && y.shop_motifs.length >= 2 &&
      Array.isArray(y.visual_mechanisms) && y.visual_mechanisms.length >= 1 &&
      Array.isArray(y.known_failure_modes) && y.known_failure_modes.length >= 1 &&
      Array.isArray(y.not_to_copy) && y.not_to_copy.length >= 1 &&
      typeof y.structural_translation === "string" && y.structural_translation.length > 10 &&
      typeof y.implementation_gap === "string" && y.implementation_gap.length > 10,
      "PATTERN_INCOMPLETE_" + id);
  }
  return { cases: records.length, local_poc: pocCount, unverified_additions: EXTRA_IDS.length };
}

/** Bind each evidence note byte-for-byte to the reviewed manifest entry. */
export function verifyEvidenceNotes(manifest, patterns, readNote) {
  assert(typeof readNote === "function", "EVIDENCE_READER_MISSING");
  for (let i = 0; i < EXTRA_IDS.length; i++) {
    const rec = manifest.records[23 + i], study = patterns.cases[23 + i];
    let text;
    try { text = readNote(study.evidence_ref); }
    catch { fail("NOTE_MISSING_" + rec.id); }
    assert(typeof text === "string" && gitBlobSha(text) === rec.evidence_note_git_blob_sha, "NOTE_CHANGED_" + rec.id);
    assert(text.startsWith("# " + rec.id + " | ") &&
      text.includes("- 採用判断の証拠レベル：" + rec.owner_decision_evidence_level) &&
      text.includes("- 一次証拠の確認状態：GitHubの原メッセージURL・原本ZIP/HTML/PNGバイトは未照合。"),
      "NOTE_EVIDENCE_MISMATCH_" + rec.id);
  }
  return true;
}
