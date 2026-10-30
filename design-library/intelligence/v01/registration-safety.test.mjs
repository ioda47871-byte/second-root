/** Run: node --test design-library/intelligence/v01/registration-safety.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyCaseSafety } from "./registration-safety.mjs";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"../../..");
const originalManifest=JSON.parse(readFileSync(resolve(root,"design-library/success-cases/manifest.json"),"utf8"));
const originalPatterns=JSON.parse(readFileSync(resolve(root,"design-library/intelligence/v01/success-patterns.json"),"utf8"));
const clone=x=>JSON.parse(JSON.stringify(x));
test("research-only staged 30-case corpus",()=>assert.deepEqual(verifyCaseSafety(originalManifest,originalPatterns),{cases:30,local_poc:17,unverified_additions:7}));
const mutations=["generation","sales","production","official-client","merchant-authority","binary-verified","owner-quote-replay","review-unneeded","cp026-explicit","fake-sha","html-verified","web-qualified","bad-status","missing-last","duplicate-id","insert-cp025","bad-declared-count","unsafe-policy","remove-deny","promote-source-scope","spoof-cp026-analysis","invalid-evidence","no-reuse-ban","poc-count","legacy-status-pending","legacy-status-rejected"];
const mutators={
"generation":m=>m.records[23].approved_for_generation=true,
"sales":m=>m.records[24].approved_for_sales=true,
"production":m=>m.records[25].approved_for_production=true,
"official-client":m=>m.records[26].official_client_work=true,
"merchant-authority":m=>m.records[27].merchant_authorized=true,
"binary-verified":m=>m.records[28].binary_original_verification="verified",
"owner-quote-replay":m=>m.records[23].owner_decision_quote_primary_replay_verified=true,
"review-unneeded":m=>m.records[24].analysis_requires_independent_review=false,
"cp026-explicit":m=>m.records[23].owner_decision_evidence_level="owner_explicit_selected_reported",
"fake-sha":m=>m.records[23].research_zip_sha256="a".repeat(64),
"html-verified":m=>m.records[25].html_css_impl_verified="local_chromium_verified",
"web-qualified":m=>m.records[27].sales_qualification="APPROVED",
"bad-status":m=>m.records[28].status="pending",
"missing-last":m=>m.records.pop(),
"duplicate-id":m=>m.records[28].id=m.records[29].id,
"insert-cp025":m=>m.records[25].id="CP-025",
"bad-declared-count":m=>m.registered_case_count=31,
"unsafe-policy":m=>m.policy.not_templates=false,
"remove-deny":(_,k)=>k.reuse_policy.deny.pop(),
"promote-source-scope":(_,k)=>k.scope="approved_for_generation",
"spoof-cp026-analysis":(_,k)=>k.cases[23].owner_selection="owner_selected_research_reported",
"invalid-evidence":(_,k)=>k.cases[23].evidence_ref="design-library/success-cases/CP-031-foo.md",
"no-reuse-ban":(_,k)=>k.cases[29].not_to_copy=[],
"poc-count":(_,k)=>k.registered_local_poc_count=16,
"legacy-status-pending":m=>m.records[0].status="awaiting_owner_review",
"legacy-status-rejected":m=>m.records[0].status="owner_rejected_explicit",
};
for(const name of mutations)test("reject "+name,()=>{const m=clone(originalManifest),k=clone(originalPatterns);mutators[name](m,k);assert.throws(()=>verifyCaseSafety(m,k),/RESEARCH_GUARD_/);});
