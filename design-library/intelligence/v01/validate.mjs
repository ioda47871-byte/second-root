/**
 * Offline Design Intelligence pilot validator.
 * Usage from repository root: node design-library/intelligence/v01/validate.mjs
 * Only reads files. Never fetches, generates, deploys or changes production data.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { verifyCaseSafety, verifyEvidenceNotes } from "./registration-safety.mjs";
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const read = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const knowledge = read("design-library/intelligence/v01/success-patterns.json");
const queue = read("design-library/intelligence/v01/review-queue.json");
const manifest = read("design-library/success-cases/manifest.json");
const frozen = {
  manifest: readFileSync(resolve(root, "design-library/intelligence/v01/frozen-23/manifest-23.original.json"), "utf8"),
  patterns: readFileSync(resolve(root, "design-library/intelligence/v01/frozen-23/patterns-23.original.json"), "utf8"),
};
const c1 = read("design-library/research/v03/candidates-20261025-01.json");
const c2 = read("design-library/research/v03/candidates-20261025-02.json");
const evidence = read("design-library/research/v03/viewport-evidence-20261025.json");
const cases = knowledge.cases;
const unique = (values) => values.length === new Set(values).size;
assert(knowledge.schema_version === 1 && queue.schema_version === 1, "unexpected schema version");
assert(knowledge.scope === "research_only_not_auto_prompt_input", "unsafe knowledge scope");
assert(knowledge.reuse_policy.design_principles_are_not_templates === true, "anti-template policy missing");
assert(unique(cases.map(x => x.id)), "duplicate case ID");
assert(unique(manifest.records.map(x => x.id)), "duplicate manifest ID");
assert(knowledge.registered_case_count === cases.length, "declared analysis count mismatch");
assert(manifest.registered_case_count === manifest.records.length, "declared registry count mismatch");
assert(cases.length === manifest.records.length, "manifest and analysis count mismatch");
assert(cases.every(x => manifest.records.some(y => y.id === x.id)), "analysis ID absent from registry");
assert(manifest.records.every(x => cases.some(y => y.id === x.id)), "registry ID absent from analysis");
assert(manifest.policy.release_or_deployment_approval === false, "unsafe release approval");
assert(manifest.policy.not_templates === true, "unsafe template policy");
assert(manifest.policy.never_reuse_generated_photos_or_logos_for_other_shops === true, "unsafe image reuse policy");
assert(cases.every(x => x.evidence_ref && x.structural_translation && x.shop_motifs.length >= 2 && x.known_failure_modes.length >= 1 && x.not_to_copy.length >= 1 && x.implementation_gap), "case incomplete");
assert(cases.every(x => manifest.records.some(y => y.id === x.id)), "case missing from source registry");
const localPocCount = cases.filter(x => x.implementation === "local_html_css_js_poc").length;
assert(localPocCount === knowledge.registered_local_poc_count, "analysis local PoC count mismatch");
assert(localPocCount === manifest.registered_local_poc_count, "registry local PoC count mismatch");
assert(manifest.records.every(x => {
 const impl = /html_css_js/.test(x.view) ? "local_html_css_js_poc" : "concept_image_only";
 return cases.some(y => y.id === x.id && y.implementation === impl);
}), "case implementation form mismatch");
const rows = queue.queue;
const audits = new Map(evidence.records.map(x => [x.id,x]));
const sources = new Map([...c1.references,...c2.references].map(x => [x.id,x]));
assert(rows.length === 20 && unique(rows.map(x => x.id)), "wrong review queue");
assert(rows.filter(x => x.phase === "A_existing_AI_viewport_evidence").length === 10, "wrong phase A");
assert(rows.filter(x => x.phase === "B_new_detailed_audits_needed").length === 10, "wrong phase B");
for (const row of rows) {
  const src = sources.get(row.id);
  assert(src && row.source_url === src.source_url, "missing/mismatched source URL: " + row.id);
  assert(row.approval_for_generation === false, "unapproved data marked usable: " + row.id);
  if (row.phase.startsWith("A")) {
    assert(audits.has(row.id) && row.human_review === "pending", "no AI viewport evidence or mislabeled human review");
    assert(audits.get(row.id).human_review.status === "pending", "source human review status changed");
  } else {
    assert(!audits.has(row.id) && row.existing_evidence === "text_checked_only_no_viewport_audit", "new case claimed audited: " + row.id);
  }
}
verifyCaseSafety(manifest, knowledge, frozen);
verifyEvidenceNotes(manifest, knowledge, (path) => readFileSync(resolve(root, path), "utf8"));
for (const c of cases.filter(x => /^CP-0(26|27|28|29|30|31|32)$/.test(x.id))) {
  const note = readFileSync(resolve(root, c.evidence_ref), "utf8");
  assert(note.startsWith("# " + c.id + " | "), "evidence note identity mismatch: " + c.id);
}
console.log(`PASS: ${cases.length} research success patterns (${localPocCount} local Web PoCs); 20 source-traced review queue items; no auto-approved research.`);
