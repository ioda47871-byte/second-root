import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { audit, structuralSimilarity, multisetOverlap, DEFAULT_EXPERIMENT } from "./structure-audit.mjs";

const specimen = JSON.parse(readFileSync(DEFAULT_EXPERIMENT, "utf8"));

test("three paper-theater proposals have distinct authored structures and no automatic approval", () => {
  const result = audit(specimen);
  assert.equal(result.errors.length, 0, result.errors.join("; "));
  assert.equal(specimen.selection_status, "pending_owner_review");
  assert.equal(result.comparisons.length, 3);
  assert.ok(result.comparisons.every(p => p.score < 0.5), JSON.stringify(result.comparisons));
  assert.equal(result.outcome, "structure_stage_pass");
});

test("brand name and palette changes alone do not hide the same skeleton", () => {
  const copy = structuredClone(specimen.proposals[0]);
  copy.id = "SURFACE-ONLY-CHANGE";
  copy.name = "Different name, same structure";
  copy.core_device = "different colors";
  assert.equal(structuralSimilarity(specimen.proposals[0], copy), 1);
  const variant = structuredClone(specimen);
  variant.proposals[1] = copy;
  const check = audit(variant);
  assert.ok(check.warnings.some(x => x.includes("repeat despite surface differences")));
});

test("a conventional sequence of split/alternating LP bands emits warnings", () => {
  const variant = structuredClone(specimen);
  variant.proposals[0].hero_structure = "copy_left_photo_right";
  variant.proposals[0].sections[0].layout = "copy_left_photo_right";
  variant.proposals[0].sections[1].layout = "alternate_photo_text";
  variant.proposals[0].sections[2].layout = "two_column_text_image";
  variant.proposals[0].sections[3].layout = "alternate_photo_text";
  const check = audit(variant);
  assert.ok(check.warnings.some(x => x.includes("generic left/right hero")));
  assert.ok(check.warnings.some(x => x.includes("three or more generic LP sections")));
});

test("cannot silently promote unreviewed structures or omit practical shop information", () => {
  const variant = structuredClone(specimen);
  variant.chosen_proposal_id = "PT-01";
  variant.selection_status = "approved";
  variant.proposals[1].sections.pop();
  const check = audit(variant);
  assert.equal(check.outcome, "invalid");
  assert.ok(check.errors.some(x => x.includes("research-only")));
  assert.ok(check.errors.some(x => x.includes("no practical visitor information")));
});

test("multiset ratio handles repeated scene types without treating it as a set", () => {
  assert.equal(multisetOverlap(["a","a","b"],["a","b","b"]), 0.5);
  assert.equal(multisetOverlap([],[]),1);
});
