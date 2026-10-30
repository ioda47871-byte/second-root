/** Run: node --test design-library/intelligence/v01/registration-safety.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyCaseSafety, verifyEvidenceNotes, gitBlobSha } from "./registration-safety.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p) => readFileSync(resolve(root, p), "utf8");
const originalManifest = JSON.parse(read("design-library/success-cases/manifest.json"));
const originalPatterns = JSON.parse(read("design-library/intelligence/v01/success-patterns.json"));
const frozen = Object.freeze({
  manifest: read("design-library/intelligence/v01/frozen-23/manifest-23.original.json"),
  patterns: read("design-library/intelligence/v01/frozen-23/patterns-23.original.json"),
});
const copy = (x) => JSON.parse(JSON.stringify(x));
const valid = (m = originalManifest, p = originalPatterns, baseline = frozen) =>
  verifyCaseSafety(m, p, baseline);
const deny = (m = () => {}, p = () => {}, base = () => {}) => {
  const mm = copy(originalManifest), pp = copy(originalPatterns), ff = { ...frozen };
  m(mm); p(pp); base(ff);
  assert.throws(() => valid(mm, pp, ff), /RESEARCH_GUARD_/);
};

test("base 23 remains intact and additions are research-only", () => {
  assert.deepEqual(valid(), { cases: 30, local_poc: 17, unverified_additions: 7 });
  assert.equal(verifyEvidenceNotes(originalManifest, originalPatterns, read), true);
});
test("snapshot digests match PR #142 original Git blobs", () => {
  assert.equal(gitBlobSha(frozen.manifest), "4c386fcc33f89a2f25b462d8307267eb71c31a97");
  assert.equal(gitBlobSha(frozen.patterns), "9a8807b534679351510397649f5b2e3f6d6ea946");
});
const mutations = {
  "legacy owner status pending": [m => m.records[0].status = "awaiting_owner_review"],
  "legacy selection conditional changed": [m => m.records.find(x => x.id === "CP-021").status = "owner_selected_research_design_success"],
  "legacy title changed": [m => m.records[0].title += " edited"],
  "legacy extra unknown key": [m => m.records[1].new_claim = true],
  "legacy reordered records": [m => [m.records[0],m.records[1]]=[m.records[1],m.records[0]]],
  "legacy quoted string approval": [m => m.records[0].approved_for_generation = "true"],
  "legacy explicit true approval": [m => m.records[0].approved_for_generation = true],
  "legacy client authority": [m => m.records[0].merchant_authorized = true],
  "legacy patterns prompt right": [null, p => p.cases[0].approved_for_generation = true],
  "legacy patterns copied title": [null, p => p.cases[0].name = "Imposter"],
  "legacy patterns extra key": [null, p => p.cases[0].unknown = "yes"],
  "legacy patterns reordered": [null, p => [p.cases[0],p.cases[1]]=[p.cases[1],p.cases[0]]],
  "edited frozen manifest": [null,null,b => b.manifest += " "],
  "edited frozen patterns": [null,null,b => b.patterns += " "],
  "removed frozen snapshot": [null,null,b => delete b.manifest],
  "first new approval granted": [m => m.records[23].approved_for_generation = true],
  "string true approval": [m => m.records[23].approved_for_generation = "true"],
  "new sales permission": [m => m.records[24].approved_for_sales = true],
  "new production flag": [m => m.records[25].approved_for_production = true],
  "new merchant authority": [m => m.records[26].merchant_authorized = true],
  "new official client claim": [m => m.records[26].official_client_work = "true"],
  "new website claim": [m => m.records[27].website_deployed = true],
  "new original falsely verified": [m => m.records[27].binary_original_verification = "verified"],
  "new original fake hash": [m => m.records[26].research_zip_sha256 = "a".repeat(64)],
  "new replay flag": [m => m.records[28].owner_decision_quote_primary_replay_verified = true],
  "new unknown field": [m => m.records[29].unverified_certified = true],
  "new patterns prompt permission": [null,p => p.cases[28].approved_for_generation = true],
  "new patterns quoted permission": [null,p => p.cases[28].approved_for_generation = "true"],
  "new patterns unknown": [null,p => p.cases[25].new_metric = 1],
  "new evidence CP026 exaggerated": [m => m.records[23].owner_decision_evidence_level = "owner_explicit_selected_reported"],
  "new evidence CP031 exaggerated": [m => m.records[28].owner_decision_evidence_level = "owner_explicit_selected_reported"],
  "new pattern CP031 exaggerated": [null,p => p.cases[28].owner_selection = "owner_selected_research_reported"],
  "new evidence note SHA changed": [m => m.records[26].evidence_note_git_blob_sha = "0".repeat(40)],
  "new identity title mismatch": [m => m.records[27].title = "Wrong"],
  "new identity category mismatch": [m => m.records[27].category = "wrong"],
  "new key unknown top-level": [m => m.owner_override = true],
  "patterns unknown top-level": [null,p => p.override = true],
  "count changed": [m => m.registered_case_count = 31],
  "poc count changed": [null,p => p.registered_local_poc_count = 18],
  "CP033 added and counts updated": [m => {m.records.push({...m.records[23], id:"CP-033"});m.registered_case_count++;},p => {p.cases.push({...p.cases[23],id:"CP-033"});p.registered_case_count++;}],
  "cp014 disguised ID": [m => m.records[29].id = "cp-014", p => p.cases[29].id = "cp-014"],
  "CP025 inserted": [m => m.records[29].id = "CP-025",p => p.cases[29].id = "CP-025"],
  "metadata policy templating": [m => m.policy.not_templates = false],
  "reuse deny removed": [null,p => p.reuse_policy.deny.pop()],
  "wrong new evidence path": [m => m.records[28].analysis_evidence_ref = "design-library/success-cases/CP-027-wrong.md"],
  "shop motifs missing": [null,p => p.cases[24].shop_motifs=[]],
  "owner source changed": [m => m.records[24].owner_evidence_source = "2026-10-29 unsupported"],
};
for (const [name, mods] of Object.entries(mutations)) {
  test("reject " + name, () => deny(...mods));
}
test("a note claiming verbatim consent without pinned record fails", () => {
  const bad = (path) => read(path).replace("未確認（ほかの採用文言を創作しない）", "「成功例とします」と個別に明言");
  assert.throws(() => verifyEvidenceNotes(originalManifest, originalPatterns, bad), /RESEARCH_GUARD_NOTE_CHANGED/);
});
test("a changed note selection label fails", () => {
  const bad = (path) => read(path).replace("group_adoption_reported_no_individual_quote", "owner_explicit_selected_reported");
  assert.throws(() => verifyEvidenceNotes(originalManifest, originalPatterns, bad), /RESEARCH_GUARD_NOTE_CHANGED/);
});
