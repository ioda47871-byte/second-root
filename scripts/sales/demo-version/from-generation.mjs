/**
 * DEV-139 Stage 0 A-3 (Issue #139): the glue from ONE recorded route-B generation to the existing offline B-route chain.
 *
 *   node scripts/sales/demo-version/from-generation.mjs \
 *     --facts /private/shop/facts-pack.json --directions /private/shop/direction-set.json --direction-id <id> \
 *     --design-input /private/runs/design-input --expected-prompt-sha256 <the owner-approved prompt SHA> \
 *     --design /private/runs/design --artifact /private/runs/artifact --result /private/runs/artifact-result.json \
 *     --lane quality_research_fictional|real_shop_proposal --out /private/runs/new-glue-run [--review <comp_review_v1 file>]
 *
 * Inputs, all produced by the existing CLIs and only read here (docs/operations/s0-generation-glue.md):
 *   --design-input  the design-input step's directory (pin.json: facts SHA, direction set SHA, direction id)
 *   --design        the design call's output directory (answer.json, generation.json, call.json with the ledger receipt)
 *   --artifact      the existing offline packaging step's Design Artifact for that design (artifact.json, quarantine/)
 *   --result        that packaging step's result file (phase2f_package_result_v1: the run result and the call it used)
 * The packaging step is the one that checks the design call against its ledger, rebuilds the prompt from the facts and
 * direction and refuses another SHA, and runs the prototype safety check and the PC/SP render; this glue does not repeat
 * or replace any of that, and it starts neither of those entry points (they are run by hand). It only checks that the
 * four inputs name the SAME generation (approval, run, slot, prompt SHA), that the packaging step rebuilt the prompt from
 * this design input's own direction.json and references.json (their SHA-256 in the result file), that the artifact is
 * render_pair_complete, the same facts bytes and the same shop, and that the HTML/CSS it hands on are byte for byte the
 * generated ones; then:
 *
 *   from-prototype.ts (copy derived from the page and the facts) → <out>/comp/<direction-id>/ (+ the review, if given)
 *   → prepare-offline.mjs (copy audit → comp-lane PC1440/SP390 render → --check-review → package-local --copy)
 *
 * A step that stops stops the glue with that step's code (for example VISUAL_REVIEW_MISSING when nobody has looked at
 * the renders yet): nothing is retried, no review is written here, no gate is changed. <out>/status.json records the
 * generation pin, every SHA and the outcome; owner_approval is required and sendable is false, always.
 * No model or Codex call, network, DB, worker, upload, publishing or sending. --out must be new and outside this
 * repository and every input. Exit: 0 package prepared (owner review required), 1 a step stopped (status.json says
 * which), 2 refused before anything was written.
 */
import { createHash } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareOffline, REPO, runSupervised } from "./prepare-offline.mjs";

const FROM_PROTOTYPE = "scripts/sales/demo-version/from-prototype.ts";
const DIRECTION_ID = /^[a-z0-9][a-z0-9-]{2,40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const LANES = new Set(["quality_research_fictional", "real_shop_proposal"]);
const sha = (data) => createHash("sha256").update(data).digest("hex");
const inside = (root, path) => {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

export class GlueStop extends Error {
  constructor(code) { super(code); this.name = "GlueStop"; this.code = code; }
}

/** A regular file (no link, no link in its path), at most `max` bytes. */
function file(path, max = 1024 * 1024) {
  const full = resolve(path);
  let stat;
  try { stat = lstatSync(full); } catch { throw new GlueStop("INPUT_FILE_INVALID"); }
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(full) !== full || stat.size > max) throw new GlueStop("INPUT_FILE_INVALID");
  return readFileSync(full);
}
function dir(path) {
  const full = resolve(path);
  let stat;
  try { stat = lstatSync(full); } catch { throw new GlueStop("INPUT_DIR_INVALID"); }
  if (!stat.isDirectory() || realpathSync(full) !== full) throw new GlueStop("INPUT_DIR_INVALID");
  return full;
}
function json(bytes) {
  try { return JSON.parse(bytes.toString("utf8")); } catch { throw new GlueStop("INPUT_JSON_INVALID"); }
}
const same = (a, b, keys) => keys.every((k) => typeof a?.[k] === "string" && a[k] === b?.[k]);

/**
 * Reads and cross-checks the four recorded inputs. Pure reading: nothing is written. Returns the generation pin and the
 * generated HTML/CSS bytes. Exported for tests.
 */
export function readGeneration(o) {
  const factsBytes = file(o.factsPath);
  const facts = json(factsBytes);
  const factsSha = sha(factsBytes);
  const siteName = Array.isArray(facts.facts) ? facts.facts.find((f) => f?.key === "name")?.value : undefined;
  if (facts.schema !== "shop_facts_pack_v1" || typeof facts.shop_id !== "string" || typeof siteName !== "string") throw new GlueStop("FACTS_INVALID");
  if (!DIRECTION_ID.test(o.directionId)) throw new GlueStop("DIRECTION_ID_INVALID");
  if (!SHA256.test(o.expectedPromptSha256 ?? "")) throw new GlueStop("EXPECTED_PROMPT_SHA_INVALID");
  const directionsBytes = file(o.directionsPath);

  // the design input the prompt was pinned from: same facts bytes, same direction set, same direction
  const designInput = dir(o.designInputDir);
  const pinBytes = file(join(designInput, "pin.json"));
  const pin = json(pinBytes);
  if (pin.schema !== "sales_broute_design_input_v1" || pin.facts_sha256 !== factsSha || pin.shop_id !== facts.shop_id ||
      pin.direction_set_sha256 !== sha(directionsBytes) || pin.direction_id !== o.directionId) throw new GlueStop("DESIGN_INPUT_MISMATCH");
  const directionSha = sha(file(join(designInput, "direction.json")));
  const referencesSha = sha(file(join(designInput, "references.json")));

  // the design call: succeeded, route B, the ledger receipt, and the owner-approved prompt SHA
  const design = dir(o.designDir);
  const callBytes = file(join(design, "call.json"));
  const call = json(callBytes);
  const generation = json(file(join(design, "generation.json")));
  const answerBytes = file(join(design, "answer.json"), 2 * 1024 * 1024);
  const answer = json(answerBytes);
  const receipt = call.receipt ?? {};
  if (call.schema !== "phase2f_live_call_v1" || receipt.schema !== "phase2f_live_receipt_v1") throw new GlueStop("GENERATION_RECORD_INVALID");
  if (call.status !== "succeeded" || generation.status !== "succeeded") throw new GlueStop("GENERATION_NOT_SUCCEEDED");
  if (receipt.kind !== "design" || receipt.route !== "B_html_prototype") throw new GlueStop("GENERATION_NOT_ROUTE_B");
  // the design input is an open direction: only a v2 or (DEV-139) v2.1 design can have been made from it
  if (call.prompt_version !== "v2" && call.prompt_version !== "v2.1") throw new GlueStop("GENERATION_NOT_V2");
  if (receipt.prompt_sha256 !== o.expectedPromptSha256) throw new GlueStop("GENERATION_PROMPT_NOT_PINNED");
  if (typeof receipt.slot !== "string" || receipt.slot === "none") throw new GlueStop("GENERATION_RECORD_INVALID");
  if (!same(generation, receipt, ["approval_id", "run_id", "prompt_sha256"])) throw new GlueStop("GENERATION_RECEIPT_MISMATCH");
  const html = answer?.prototype?.html;
  const css = answer?.prototype?.css;
  if (typeof html !== "string" || typeof css !== "string") throw new GlueStop("GENERATION_NO_PROTOTYPE");

  // the packaging step's result: done, route B, and it used exactly this call (same approval, run, slot and prompt)
  const result = json(file(o.resultPath));
  const used = Array.isArray(result.calls) ? result.calls : [];
  if (result.schema !== "phase2f_package_result_v1" || result.route !== "B_html_prototype") throw new GlueStop("PACKAGE_RESULT_INVALID");
  if (result.result?.status !== "done") throw new GlueStop("DESIGN_PACKAGE_NOT_DONE");
  if (used.length !== 1 || used[0].kind !== "design" || used[0].status !== "succeeded" ||
      !same(used[0], receipt, ["approval_id", "run_id", "prompt_sha256", "slot"])) throw new GlueStop("PACKAGE_RESULT_MISMATCH");
  // review M1: the packaging step rebuilt the prompt from exactly these direction and reference files and found the
  // receipt's SHA; they must be this design input's files (another direction's input never rides on this generation)
  const inputs = result.prompt_inputs_sha256 ?? {};
  if (inputs.direction !== directionSha || inputs.references !== referencesSha || inputs.brief !== null || inputs.tm_brief !== null || inputs.research !== null) {
    throw new GlueStop("GENERATION_DIRECTION_MISMATCH");
  }
  // review M2: only a complete PC/SP render pair goes on (the intake's rule: an incomplete artifact never hands off)
  if (result.result.record?.verification_state !== "render_pair_complete") throw new GlueStop("DESIGN_ARTIFACT_NOT_COMPLETE");

  // the Design Artifact: same generation, same facts bytes, same shop, and the prototype files are the generated bytes
  const artifactDir = dir(o.artifactDir);
  if (typeof result.result.packageDir !== "string" || realpathSync(resolve(result.result.packageDir)) !== artifactDir) throw new GlueStop("PACKAGE_RESULT_MISMATCH");
  const artifactBytes = file(join(artifactDir, "artifact.json"));
  const artifact = json(artifactBytes);
  const observed = artifact.observed ?? {};
  if (artifact.schema !== "design_artifact_v1" || artifact.route !== "B_html_prototype" || result.result.record?.route !== "B_html_prototype") throw new GlueStop("DESIGN_ARTIFACT_INVALID");
  if (!same(observed.generation, receipt, ["approval_id", "run_id", "prompt_sha256"])) throw new GlueStop("DESIGN_ARTIFACT_GENERATION_MISMATCH");
  if (artifact.facts_pack_sha256 !== factsSha) throw new GlueStop("FACTS_SHA_MISMATCH");
  if (artifact.shop?.shop_id !== facts.shop_id || artifact.shop?.display_name !== siteName) throw new GlueStop("SITE_IDENTITY_MISMATCH");
  const proto = observed.prototype ?? {};
  if (proto.html_path !== "quarantine/index.html" || proto.css_path !== "quarantine/style.css") throw new GlueStop("DESIGN_ARTIFACT_INVALID");
  const htmlBytes = file(join(artifactDir, "quarantine", "index.html"), 384 * 1024);
  const cssBytes = file(join(artifactDir, "quarantine", "style.css"), 256 * 1024);
  const recorded = new Map((Array.isArray(observed.files) ? observed.files : []).map((f) => [f?.path, f?.sha256]));
  if (recorded.get(proto.html_path) !== sha(htmlBytes) || recorded.get(proto.css_path) !== sha(cssBytes)) throw new GlueStop("DESIGN_ARTIFACT_FILES_MISMATCH");
  if (!htmlBytes.equals(Buffer.from(html, "utf8")) || !cssBytes.equals(Buffer.from(css, "utf8"))) throw new GlueStop("PROTOTYPE_NOT_FROM_GENERATION");

  return {
    facts, factsBytes, factsSha, siteName, directionsBytes, htmlBytes, cssBytes,
    pin: {
      approval_id: receipt.approval_id,
      plan_id: receipt.plan_id,
      run_id: receipt.run_id,
      slot: receipt.slot,
      retry_of: receipt.retry_of ?? null,
      route: receipt.route,
      prompt_sha256: receipt.prompt_sha256,
      prompt_chars: receipt.prompt_chars,
      prompt_version: typeof call.prompt_version === "string" ? call.prompt_version : null,
      worker_commit: receipt.commit,
      reserved_at: receipt.reserved_at,
      call_json_sha256: sha(callBytes),
      answer_sha256: sha(answerBytes),
    },
    designInput: { pin_sha256: sha(pinBytes), direction_sha256: directionSha, references_sha256: referencesSha, direction_set_sha256: pin.direction_set_sha256, references_manifest_sha256: pin.references_manifest_sha256 ?? null, reference_mode: pin.reference_mode ?? null },
    designArtifact: { artifact_id: artifact.artifact_id, artifact_json_sha256: sha(artifactBytes), verification_state: result.result.record?.verification_state ?? null },
  };
}

function checkOutput(out, inputs) {
  try { lstatSync(out); throw new GlueStop("OUTPUT_EXISTS"); } catch (e) { if (e instanceof GlueStop) throw e; }
  let parent;
  try { parent = realpathSync(dirname(out)); } catch { throw new GlueStop("OUTPUT_PARENT_MISSING"); }
  if (inside(REPO, out) || inside(realpathSync(REPO), parent)) throw new GlueStop("OUTPUT_IN_REPO");
  const name = basename(out);
  if (name === "." || name === "..") throw new GlueStop("OUTPUT_UNSAFE");
  const real = join(parent, name);
  if (inputs.some((p) => inside(p, real) || inside(real, p))) throw new GlueStop("OUTPUT_OVERLAPS_INPUT");
  return real;
}

/**
 * The whole glue. `runStep` (from-prototype as a supervised process) and `offline` (prepareOffline) are injectable for
 * tests; the CLI uses the real ones.
 */
export function fromGeneration(o, deps = {}) {
  const runFromPrototype = deps.runFromPrototype ?? ((args) => runSupervised(["--import", "tsx", resolve(REPO, FROM_PROTOTYPE), ...args]));
  const offline = deps.offline ?? prepareOffline;
  if (!LANES.has(o.lane)) throw new GlueStop("LANE_INVALID");
  const g = readGeneration(o);
  const reviewBytes = o.reviewPath ? file(o.reviewPath) : null;
  const out = checkOutput(resolve(o.outDir), [o.factsPath, o.directionsPath, o.designInputDir, o.designDir, o.artifactDir, o.resultPath, ...(o.reviewPath ? [o.reviewPath] : [])].map((p) => realpathSync(resolve(p))));

  mkdirSync(out, { mode: 0o700 });
  const status = {
    schema: "sales_generation_glue_v1",
    status: "blocked",
    code: "RUN_INCOMPLETE",
    stage: "staging",
    shop_id: g.facts.shop_id,
    site_name: g.siteName,
    facts_sha256: g.factsSha,
    direction_id: o.directionId,
    design_input: g.designInput,
    generation: g.pin,
    design_artifact: g.designArtifact,
    prototype_sha256: { html: sha(g.htmlBytes), css: sha(g.cssBytes) },
    // review L3: who checked what. The glue compares records; it does not re-run the packaging step's checks.
    checks: {
      ledger_and_output_agree: "packaging_step",
      prompt_rebuilt_from_direction_and_compared: "packaging_step",
      prototype_safety_and_render_pair: "packaging_step",
      repeated_by_glue: false,
      glue_compared: ["receipt_across_records", "expected_prompt_sha256", "direction_and_references_sha256", "facts_sha256", "site_identity", "prototype_bytes", "verification_state"],
    },
    handoff: null,
    review: { supplied: reviewBytes !== null, sha256: reviewBytes ? sha(reviewBytes) : null },
    offline: null,
    package_sha256: null,
    generated_design_quality: "not_assessed",
    owner_approval: "required",
    external_send: "disabled",
    sendable: false,
  };
  const save = () => writeFileSync(join(out, "status.json"), `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
  const stop = (stage, code) => { status.stage = stage; status.code = code; save(); return status; };
  save();
  // review L1: once --out exists, an unexpected failure is a stop recorded in status.json (exit 1), never "refused"
  try {
    return runChain(o, g, status, out, reviewBytes, { stop, save, runFromPrototype, offline });
  } catch (error) {
    return stop(status.stage, error instanceof GlueStop ? error.code : "GLUE_EXCEPTION");
  }
}

function runChain(o, g, status, out, reviewBytes, { stop, save, runFromPrototype, offline }) {
  // 1. the generated HTML/CSS, byte for byte, as the prototype from-prototype reads
  const protoDir = join(out, "prototype");
  mkdirSync(protoDir, { mode: 0o700 });
  writeFileSync(join(protoDir, "index.html"), g.htmlBytes, { mode: 0o600, flag: "wx" });
  writeFileSync(join(protoDir, "style.css"), g.cssBytes, { mode: 0o600, flag: "wx" });

  // 2. from-prototype: the direction-set gate, the copy derived from the page and the facts (never hand-written)
  const handoffDir = join(out, "handoff");
  const r = runFromPrototype(["--facts", resolve(o.factsPath), "--prototype", protoDir, "--directions", resolve(o.directionsPath),
    "--direction-id", o.directionId, "--lane", o.lane, "--out", handoffDir]);
  if (r.errorCode || r.exit !== 0 || !r.output || r.output.status === "blocked") {
    return stop("from_prototype", typeof r.output?.code === "string" && /^[A-Z][A-Z0-9_]{1,79}$/.test(r.output.code) ? r.output.code : (r.errorCode ?? "FROM_PROTOTYPE_STOP"));
  }
  let handoff;
  try { handoff = json(file(join(handoffDir, "status.json"))); } catch { return stop("from_prototype", "FROM_PROTOTYPE_STOP"); }
  const derived = join(handoffDir, "comp", o.directionId);
  if (handoff.facts_sha256 !== g.factsSha || handoff.shop_id !== g.facts.shop_id || handoff.direction_id !== o.directionId ||
      handoff.prototype_sha256?.html !== status.prototype_sha256.html || handoff.prototype_sha256?.css !== status.prototype_sha256.css) {
    return stop("from_prototype", "HANDOFF_MISMATCH");
  }
  // review L2: the handoff names the same direction set and reference mode as the design input
  if (handoff.direction_set_sha256 !== sha(g.directionsBytes) || handoff.direction_set_sha256 !== g.designInput.direction_set_sha256 ||
      handoff.reference_mode !== g.designInput.reference_mode) {
    return stop("from_prototype", "HANDOFF_MISMATCH");
  }
  status.handoff = { copy_sha256: handoff.copy_sha256, copy: handoff.copy, direction_set_sha256: handoff.direction_set_sha256, reference_mode: handoff.reference_mode };

  // 3. the comp the offline chain reads: the derived page, CSS and copy, and the review only if one was supplied
  const comp = join(out, "comp", o.directionId);
  mkdirSync(comp, { recursive: true, mode: 0o700 });
  for (const name of ["index.html", "style.css", "copy.json"]) copyFileSync(join(derived, name), join(comp, name));
  if (reviewBytes) writeFileSync(join(comp, "review.json"), reviewBytes, { mode: 0o600, flag: "wx" });
  if (sha(readFileSync(join(comp, "copy.json"))) !== handoff.copy_sha256 || sha(readFileSync(join(comp, "index.html"))) !== status.prototype_sha256.html ||
      sha(readFileSync(join(comp, "style.css"))) !== status.prototype_sha256.css) {
    return stop("stage_comp", "STAGING_MISMATCH");
  }

  // 4. the existing offline chain, unchanged: copy audit → render → --check-review → v2 package
  status.stage = "offline";
  save();
  let report;
  try {
    report = offline({ factsPath: resolve(o.factsPath), compDir: comp, outDir: join(out, "offline") });
  } catch (error) {
    return stop("offline", typeof error?.code === "string" ? error.code : "OFFLINE_EXCEPTION");
  }
  status.offline = {
    status: report.status,
    code: report.code,
    facts_sha256: report.facts_sha256,
    steps: report.steps.map(({ step, outcome, code, copy_step, findings }) => ({ step, outcome, ...(code ? { code } : {}), ...(copy_step !== undefined ? { copy_step } : {}), findings })),
    render_review: report.render_review,
    package_sha256: report.package_sha256,
  };
  if (report.facts_sha256 !== g.factsSha) return stop("offline", "FACTS_SHA_MISMATCH");
  if (report.status !== "package_prepared_owner_review_required") return stop("offline", report.code ?? "OFFLINE_STOP");
  status.package_sha256 = report.package_sha256;
  status.status = "package_prepared_owner_review_required";
  status.code = null;
  status.stage = "package_prepared";
  save();
  return status;
}

function arg(k) { const i = process.argv.indexOf(k); return i > 1 ? process.argv[i + 1] : undefined; }
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const keys = ["--facts", "--directions", "--direction-id", "--design-input", "--expected-prompt-sha256", "--design", "--artifact", "--result", "--lane", "--out"];
  const values = Object.fromEntries(keys.map((k) => [k, arg(k)]));
  const review = arg("--review");
  const expectedLength = 2 + keys.length * 2 + (review ? 2 : 0);
  if (keys.some((k) => !values[k] || values[k].startsWith("--")) || (review !== undefined && review.startsWith("--")) || process.argv.length !== expectedLength) {
    process.stderr.write(`usage: node scripts/sales/demo-version/from-generation.mjs ${keys.map((k) => `${k} <…>`).join(" ")} [--review <comp_review_v1 file>]\n`);
    process.exit(2);
  }
  let status;
  try {
    status = fromGeneration({
      factsPath: values["--facts"], directionsPath: values["--directions"], directionId: values["--direction-id"],
      designInputDir: values["--design-input"], expectedPromptSha256: values["--expected-prompt-sha256"],
      designDir: values["--design"], artifactDir: values["--artifact"], resultPath: values["--result"],
      lane: values["--lane"], outDir: values["--out"], ...(review ? { reviewPath: review } : {}),
    });
  } catch (error) {
    // refused before --out was created: codes only, never a path or shop text
    process.stdout.write(`${JSON.stringify({ status: "refused", code: error instanceof GlueStop ? error.code : "INPUT_ERROR", sendable: false })}\n`);
    process.exit(2);
  }
  // ids, hashes and codes only (no path, no shop text beyond what status.json in --out holds)
  process.stdout.write(`${JSON.stringify({ status: status.status, code: status.code, stage: status.stage, facts_sha256: status.facts_sha256,
    generation: { approval_id: status.generation.approval_id, run_id: status.generation.run_id, slot: status.generation.slot, prompt_sha256: status.generation.prompt_sha256 },
    package_sha256: status.package_sha256, sendable: false })}\n`);
  process.exit(status.status === "package_prepared_owner_review_required" ? 0 : 1);
}
