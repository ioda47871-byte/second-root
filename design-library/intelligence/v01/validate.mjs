/**
 * Offline Design Intelligence pilot validator.
 * Usage from repository root: node design-library/intelligence/v01/validate.mjs
 * Only reads files. Never fetches, generates, deploys or changes production data.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const read = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const knowledge = read("design-library/intelligence/v01/success-patterns.json");
const queue = read("design-library/intelligence/v01/review-queue.json");
const manifest = read("design-library/success-cases/manifest.json");
const c1 = read("design-library/research/v03/candidates-20261025-01.json");
const c2 = read("design-library/research/v03/candidates-20261025-02.json");
const evidence = read("design-library/research/v03/viewport-evidence-20261025.json");
const cases = knowledge.cases;
const unique = (values) => values.length === new Set(values).size;
assert(knowledge.schema_version === 1 && queue.schema_version === 1, "unexpected schema version");
assert(knowledge.scope === "research_only_not_auto_prompt_input", "unsafe knowledge scope");
assert(knowledge.reuse_policy.design_principles_are_not_templates === true, "anti-template policy missing");
assert(unique(cases.map(x => x.id)) && cases.length === 15, "case count/IDs do not match pilot");
assert(cases.every(x => x.evidence_ref && x.structural_translation && x.shop_motifs.length >= 2 && x.known_failure_modes.length >= 1 && x.not_to_copy.length >= 1 && x.implementation_gap), "case incomplete");
assert(cases.every(x => manifest.records.some(y => y.id === x.id)), "case missing from source registry");
assert(cases.filter(x => x.implementation === "local_html_css_js_poc").length === 9, "PoC counts ambiguous");
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
console.log("PASS: 15 research success patterns; 20 source-traced review queue items; no auto-approved research.");
