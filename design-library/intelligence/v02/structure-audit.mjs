/**
 * Design Intelligence v0.2 | structural comparison, not a visual quality score.
 * No network, screenshots, model calls, DB writes, or changes to generators.
 * Usage: node design-library/intelligence/v02/structure-audit.mjs
 *        node design-library/intelligence/v02/structure-audit.mjs path/to/experiment.json
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const cwd = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_EXPERIMENT = resolve(cwd, "experiments/paper-theater.json");

export function multisetOverlap(a, b) {
  const ac = new Map(), bc = new Map();
  for (const k of a) ac.set(k, (ac.get(k) || 0) + 1);
  for (const k of b) bc.set(k, (bc.get(k) || 0) + 1);
  const keys = new Set([...ac.keys(), ...bc.keys()]);
  let intersection = 0, union = 0;
  for (const k of keys) {
    intersection += Math.min(ac.get(k) || 0, bc.get(k) || 0);
    union += Math.max(ac.get(k) || 0, bc.get(k) || 0);
  }
  return union ? intersection / union : 1;
}

export function structuralSimilarity(a, b) {
  const layoutsA = a.sections.map(x => x.layout);
  const layoutsB = b.sections.map(x => x.layout);
  const edges = layouts => layouts.slice(1).map((x, i) => layouts[i] + " > " + x);
  const equality = (x, y) => x === y ? 1 : 0;
  return Number((
    0.3 * equality(a.hero_structure, b.hero_structure) +
    0.15 * equality(a.navigation_model, b.navigation_model) +
    0.1 * equality(a.reading_path, b.reading_path) +
    0.3 * multisetOverlap(layoutsA, layoutsB) +
    0.15 * multisetOverlap(edges(layoutsA), edges(layoutsB))
  ).toFixed(3));
}

const GENERIC_LAYOUTS = new Set(["copy_left_photo_right", "photo_left_copy_right", "two_column_text_image", "alternate_photo_text", "repeated_wave_photo_band"]);
const GENERIC_HERO = new Set(["copy_left_photo_right", "photo_left_copy_right", "split_hero_photo_text"]);

export function audit(experiment) {
  const errors = [], warnings = [], comparisons = [];
  if (experiment.schema_version !== 1) errors.push("schema_version must be 1");
  if (!experiment.research_only || experiment.selection_status !== "pending_owner_review" || experiment.chosen_proposal_id !== null) {
    errors.push("Experimental proposals must remain research-only and unapproved");
  }
  if (experiment.comparison_basis?.qualitative_only !== true) {
    errors.push("Previous 9 cases cannot be assigned numeric structural similarity without section maps");
  }
  const options = Array.isArray(experiment.proposals) ? experiment.proposals : [];
  if (options.length < 3) errors.push("At least 3 alternatives required before image generation");
  if (new Set(options.map(p => p.id)).size !== options.length) errors.push("duplicate proposal IDs");
  for (const p of options) {
    if (!p || typeof p !== "object") { errors.push("invalid proposal entry"); continue; }
    if (!p.id || !p.core_device || !p.first_screen?.composition || !p.accessibility || !p.mobile_strategy) {
      errors.push((p.id || "unknown") + ": missing core concept or mobile/a11y planning");
      continue;
    }
    if (GENERIC_HERO.has(p.hero_structure)) warnings.push(p.id + ": generic left/right hero");
    if (!Array.isArray(p.sections) || p.sections.length < 4) {
      errors.push(p.id + ": fewer than four structural scenes");
      continue;
    }
    if (p.sections[0].layout !== p.hero_structure) errors.push(p.id + ": hero differs from opening section");
    if (!p.sections.some(s => s.role === "access_and_contact")) errors.push(p.id + ": no practical visitor information");
    if (p.sections.at(-1)?.role !== "access_and_contact") warnings.push(p.id + ": ensure practical information is easily found");
    if (!p.sections.some(s => s.density === "low") || !p.sections.some(s => s.density === "high")) {
      warnings.push(p.id + ": no contrast between dense and quiet scenes");
    }
    const layouts = p.sections.map(s => s.layout);
    if (new Set(layouts).size < 3) warnings.push(p.id + ": fewer than 3 distinct scene structures");
    if (layouts.filter(s => GENERIC_LAYOUTS.has(s)).length >= 3) warnings.push(p.id + ": three or more generic LP sections");
    let run = 1;
    for (let i = 1; i < layouts.length; i++) {
      run = layouts[i] === layouts[i-1] ? run+1 : 1;
      if (run === 3) warnings.push(p.id + ": 3 consecutive same-layout scenes");
    }
  }
  for (let i = 0; i < options.length; i++) for (let j = i + 1; j < options.length; j++) {
    if (!Array.isArray(options[i]?.sections) || !Array.isArray(options[j]?.sections) || !options[i].hero_structure || !options[j].hero_structure) continue;
    const score = structuralSimilarity(options[i], options[j]);
    const verdict = score >= 0.75 ? "probable_structural_repeat" : score >= 0.5 ? "needs_human_comparison" : "distinct_by_declared_structure";
    comparisons.push({a:options[i].id,b:options[j].id,score,verdict});
    if (score >= 0.75) warnings.push(options[i].id + "/" + options[j].id + ": repeat despite surface differences");
  }
  return {
    experiment:experiment.experiment_id,
    outcome:errors.length?"invalid":warnings.length?"review_warnings":"structure_stage_pass",
    errors,warnings,comparisons,
    caveat:"Scores compare author-declared tokens only. Zero is not proof of novel design; photographs, wireframes, navigation and responsive screenshots require human review. Previous CP-001..009 are qualitative comparisons only."
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = resolve(process.argv[2] || DEFAULT_EXPERIMENT);
  const result = audit(JSON.parse(readFileSync(path, "utf8")));
  console.log(JSON.stringify(result, null, 2));
  if (result.errors.length) process.exitCode = 1;
}
