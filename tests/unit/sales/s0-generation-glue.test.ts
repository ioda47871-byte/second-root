import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDesignPrompt, promptVariantOf } from "@/lib/design-agent/phase2f/prompt";
import { runDesignCall } from "@/lib/design-agent/phase2f-live/design-call";
import { openLedger } from "@/lib/design-agent/phase2f-live/ledger";

// DEV-139 Stage 0 A-3 (Issue #139): one recorded route-B generation through the real CLIs, into the existing offline
// B-route chain, with the generation's receipt pinned all the way to the status beside the v2 package:
//
//   prepare-design-input → phase2f-design --print-pin (no model call)
//   → ONE recorded design step (runDesignCall with a recorded answer standing in for Codex, exactly as the phase2f-live
//     steps test records one: a temporary ledger, never the real one; no Codex, no network, no approval spent)
//   → phase2f-steps --package --route B --prompt-version v2 (ledger check, prompt rebuilt from facts + direction and
//     compared with the receipt, prototype safety, PC/SP render, intake) → Design Artifact
//   → from-generation.mjs (the glue) → from-prototype → prepare-offline (copy audit → render → --check-review → package)
//
// The recorded answer's prototype is NOT a model generation: it is 環's committed page (sendable-tamaki/page/index.html)
// with the CSS of its one visual-review round (step2-review/style.css), wrapped as a codex_design_v1 answer. Those are
// exactly the bytes step2-review/review.json was written for (Claude looked at their PC1440/SP390 renders, STEP 2), so the
// review honestly exists for what the glue renders; without it the chain must stop at VISUAL_REVIEW_MISSING.
// See docs/operations/s0-generation-glue.md. No DB, network, model, image generation, worker or sending is touched.

const REPO = resolve(__dirname, "../../..");
const POC = join(REPO, "design-library/research/quality-pipeline/poc");
const TAMAKI = join(POC, "sendable-tamaki");
const DIRECTION_ID = "d1-wheel-hub";
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const FACTS_SHA = sha(readFileSync(join(TAMAKI, "facts-pack.json")));
const REVIEW_PATH = join(TAMAKI, "step2-review", "review.json");
const REVIEW = readJson(REVIEW_PATH);
const HTML = readFileSync(join(TAMAKI, "page", "index.html"), "utf8");
const CSS = readFileSync(join(TAMAKI, "step2-review", "style.css"), "utf8");
/** A fictional commit for the recorded call (the receipt records it; the glue pins it, it does not re-check it). */
const COMMIT = "c".repeat(40);
const APPROVAL_ID = "fictional-s0-glue-design-01";
const PLAN_ID = "plan-fictional-s0-glue";

function browserAvailable(): boolean {
  const env = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (env) return existsSync(env);
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

let root = "";
let state = "";
function cli(args: string[], timeout = 280_000) {
  const r = spawnSync(process.execPath, args, { cwd: REPO, encoding: "utf8", timeout, env: { ...process.env, SR_PHASE2F_STATE: state } });
  let out: Record<string, unknown> | null = null;
  try {
    out = JSON.parse(r.stdout) as Record<string, unknown>;
  } catch {
    out = null;
  }
  return { status: r.status, out, stderr: r.stderr };
}
const tsx = (script: string, ...args: string[]) => cli(["--import", "tsx", join(REPO, script), ...args]);
const glue = (...args: string[]) => cli([join(REPO, "scripts/sales/demo-version/from-generation.mjs"), ...args]);

/** The recorded design answer (codex_design_v1): 環's reviewed page, a declaration naming only 環's fact ids. */
function recordedAnswer() {
  const box = (y: number, h: number, w: number) => ({ x: 0, y, w, h });
  const sections = [
    ["hero", "hero", 60, 960, 110, 844, ["F1", "F9"]],
    ["spokes", "products", 1020, 1180, 954, 1769, ["F10", "F11", "F12", "F13"]],
    ["truing", "story", 2200, 900, 2724, 792, ["F14"]],
    ["check", "story", 3100, 824, 3516, 792, ["F15"]],
    ["lesson", "other", 3924, 576, 4308, 500, ["F16"]],
    ["visit", "info", 4500, 760, 4808, 791, ["F4", "F5", "F6", "F7", "F8"]],
  ] as const;
  const ids = sections.map((s) => s[0]);
  const dna = (choice: string, refs: readonly string[]) => ({ choice, fact_refs: refs });
  return {
    schema: "codex_design_v1",
    design_dna: {
      hero: dna("A large wheel with the shop name in its hub", ["F1"]),
      typography: dna("Vertical headings beside the stations", ["F1"]),
      palette: dna("Yellow, black, grey and off-white", ["F1"]),
      product_visual: dna("Photo boards hung from the spokes", ["F10"]),
      section_rhythm: dna("Dark and yellow sections, words crossing the borders", ["F9"]),
      navigation: dna("A thin strip of phone, hours, closed days and address", ["F5", "F6", "F8"]),
      mobile: dna("The stations hang from a vertical spine", ["F7"]),
      implementation: dna("Plain HTML and CSS, inline SVG wheels", ["F9"]),
    },
    structure_spec: {
      page_height: { desktop_1440: 5260, mobile_390: 5599 },
      sections: sections.map(([id, role, dy, dh, my, mh, refs]) => ({ id, role, boxes: { desktop_1440: box(dy, dh, 1440), mobile_390: box(my, mh, 390) }, live_text: refs.map((r) => ({ fact_ref: r })), asset_refs: [] })),
      order: { desktop_1440: ids, mobile_390: ids },
      reading_path: { desktop_1440: ids, mobile_390: ids },
    },
    interaction_spec: [],
    prototype: { html: HTML, css: CSS },
  };
}
let facts = "";
let directions = "";
let designInput = "";
let designDir = "";
let promptPin = { sha256: "", chars: 0 };
let receipt: Record<string, unknown> = {};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "secondroot-s0-glue-"));
  state = join(root, "state");
  mkdirSync(join(root, "shop"));
  mkdirSync(join(root, "runs"));
  facts = join(root, "shop", "facts-pack.json");
  copyFileSync(join(TAMAKI, "facts-pack.json"), facts);
  // 環's direction set is 輪's, re-pinned to 環's shop id and facts SHA only (as in STEP 2; the C1–C7 gate still runs)
  const set = readJson(join(POC, "bicycle", "direction-set.json"));
  set.shop_id = readJson(facts).shop_id;
  set.facts_sha256 = FACTS_SHA;
  directions = join(root, "shop", "direction-set.json");
  writeFileSync(directions, `${JSON.stringify(set, null, 2)}\n`);
  designInput = join(root, "runs", "design-input");
  designDir = join(root, "runs", "design");
});
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("Stage 0 A-3: a recorded route-B generation through the glue into the offline B-route chain", () => {
  it("design input → prompt pin → one recorded design step whose receipt carries that prompt SHA (no browser)", { timeout: 200_000 }, async () => {
    const input = tsx("scripts/sales/demo-version/prepare-design-input.ts", "--facts", facts, "--directions", directions, "--direction-id", DIRECTION_ID, "--out", designInput);
    expect(input.status, input.stderr).toBe(0);
    expect(readJson(join(designInput, "pin.json"))).toMatchObject({ facts_sha256: FACTS_SHA, direction_id: DIRECTION_ID, design_generated: false, sendable: false });

    const printed = tsx("scripts/design-artifact/phase2f-design.ts", "--print-pin", "--route", "B", "--prompt-version", "v2", "--facts", facts,
      "--direction", join(designInput, "direction.json"), "--references", join(designInput, "references.json"));
    expect(printed.status, printed.stderr).toBe(0);
    promptPin = { sha256: String(printed.out?.prompt_sha256), chars: Number(printed.out?.prompt_chars) };
    expect(promptPin.sha256).toMatch(/^[0-9a-f]{64}$/);

    // the prompt the real call would send: the same builder and variant as the CLI (its SHA must be the printed pin)
    const variant = promptVariantOf({ route: "B_html_prototype", version: "v2", research: undefined, direction: readJson(join(designInput, "direction.json")), references: readJson(join(designInput, "references.json")) });
    if (!variant.ok) throw new Error(variant.code);
    const built = buildDesignPrompt({ route: "B_html_prototype", facts: readJson(facts), maxAssets: 1, variant: variant.variant });
    expect([built.sha256, built.chars]).toEqual([promptPin.sha256, promptPin.chars]);

    // ONE recorded design step: the ledger (a temporary state directory) reserves the approval and a slot exactly as a
    // real call would; the recorded answer stands in for Codex (nothing is called, no model name is recorded)
    const answer = recordedAnswer();
    const r = await runDesignCall(
      { route: "B_html_prototype", prompt: built.prompt, schema: {}, humanApprovalConfirmed: true, approvalId: APPROVAL_ID, planId: PLAN_ID, retryOf: null, expected: { promptSha256: built.sha256, promptChars: built.chars, commit: COMMIT }, outDir: designDir, promptVersion: "v2" },
      { ledger: openLedger(state), commit: async () => ({ head: COMMIT, base: COMMIT, clean: true }), codex: async () => ({ answer, meta: { threadId: null, cliVersion: null, modelReported: null, redactions: [] } }) },
    );
    expect(r.status).toBe("succeeded");
    const call = readJson(join(designDir, "call.json"));
    receipt = call.receipt;
    expect(call).toMatchObject({ status: "succeeded", prompt_version: "v2" });
    expect(receipt).toMatchObject({ approval_id: APPROVAL_ID, plan_id: PLAN_ID, kind: "design", route: "B_html_prototype", slot: "first-1", prompt_sha256: promptPin.sha256, commit: COMMIT });

    // the glue refuses before writing anything when its inputs are incomplete (here: no Design Artifact yet)
    const missing = glue("--facts", facts, "--directions", directions, "--direction-id", DIRECTION_ID, "--design-input", designInput,
      "--expected-prompt-sha256", promptPin.sha256, "--design", designDir, "--artifact", join(root, "runs", "absent"), "--result", join(root, "runs", "absent.json"),
      "--lane", "quality_research_fictional", "--out", join(root, "runs", "glue-refused"));
    expect(missing.status).toBe(2);
    expect(missing.out).toMatchObject({ status: "refused", sendable: false });
    expect(existsSync(join(root, "runs", "glue-refused"))).toBe(false);
  });

  describe.skipIf(!browserAvailable())("with a browser: the real packaging step, the glue and the offline chain", () => {
    const artifact = () => join(root, "runs", "artifact");
    const result = () => join(root, "runs", "artifact-result.json");
    const args = (out: string, ...extra: string[]) => ["--facts", facts, "--directions", directions, "--direction-id", DIRECTION_ID, "--design-input", designInput,
      "--expected-prompt-sha256", promptPin.sha256, "--design", designDir, "--artifact", artifact(), "--result", result(),
      "--lane", "quality_research_fictional", "--out", out, ...extra];

    it("phase2f-steps --package checks the recorded design against its ledger and prompt pin and packages it (route B, PC/SP)", { timeout: 300_000 }, () => {
      expect(receipt.approval_id, "the first test records the design step").toBe(APPROVAL_ID);
      const p = tsx("scripts/design-artifact/phase2f-steps.ts", "--package", "--route", "B", "--prompt-version", "v2",
        "--direction", join(designInput, "direction.json"), "--references", join(designInput, "references.json"),
        "--facts", facts, "--design", designDir, "--artifact-id", "DA-20261117-s0glue", "--shop-id", readJson(facts).shop_id, "--shop-name", "架空自転車修理 環",
        "--out", artifact(), "--result", result());
      expect(p.status, JSON.stringify(p.out)).toBe(0);
      expect(p.out).toMatchObject({ status: "done", record: { route: "B_html_prototype", verification_state: "render_pair_complete" } });
      const a = readJson(join(artifact(), "artifact.json"));
      expect(a.facts_pack_sha256).toBe(FACTS_SHA);
      expect(a.observed.generation).toMatchObject({ approval_id: APPROVAL_ID, run_id: receipt.run_id, prompt_sha256: promptPin.sha256 });
      expect(readFileSync(join(artifact(), "quarantine", "index.html"), "utf8")).toBe(HTML);
    });

    it("refuses a generation that is not the pinned one, or a prototype that is not the generated bytes, writing nothing", { timeout: 60_000 }, () => {
      const wrongPin = cli([join(REPO, "scripts/sales/demo-version/from-generation.mjs"), ...args(join(root, "runs", "glue-wrong-pin")).map((x) => (x === promptPin.sha256 ? "0".repeat(64) : x))]);
      expect([wrongPin.status, wrongPin.out?.code]).toEqual([2, "GENERATION_PROMPT_NOT_PINNED"]);
      expect(existsSync(join(root, "runs", "glue-wrong-pin"))).toBe(false);
      // another facts pack (one byte) is another shop state: the design input and the artifact no longer match
      const otherFacts = join(root, "shop", "facts-pack-other.json");
      writeFileSync(otherFacts, `${readFileSync(facts, "utf8")} `);
      const other = cli([join(REPO, "scripts/sales/demo-version/from-generation.mjs"), ...args(join(root, "runs", "glue-other")).map((x) => (x === facts ? otherFacts : x))]);
      expect([other.status, other.out?.code]).toEqual([2, "DESIGN_INPUT_MISMATCH"]);
      expect(existsSync(join(root, "runs", "glue-other"))).toBe(false);
      // a design output whose answer is not the one the Design Artifact was packaged from (same receipt, other CSS)
      const forged = join(root, "runs", "design-forged");
      mkdirSync(forged);
      for (const f of ["call.json", "generation.json"]) copyFileSync(join(designDir, f), join(forged, f));
      const a = readJson(join(designDir, "answer.json"));
      a.prototype.css += "\n.hero{outline:0}";
      writeFileSync(join(forged, "answer.json"), JSON.stringify(a));
      const swapped = cli([join(REPO, "scripts/sales/demo-version/from-generation.mjs"), ...args(join(root, "runs", "glue-forged")).map((x) => (x === designDir ? forged : x))]);
      expect([swapped.status, swapped.out?.code]).toEqual([2, "PROTOTYPE_NOT_FROM_GENERATION"]);
      expect(existsSync(join(root, "runs", "glue-forged"))).toBe(false);
    });

    it("without a visual review: copy audit and PC/SP render run for real, then the glue stops at VISUAL_REVIEW_MISSING (no package)", { timeout: 300_000 }, () => {
      const out = join(root, "runs", "glue-no-review");
      const r = glue(...args(out));
      const status = readJson(join(out, "status.json"));
      expect(r.status, JSON.stringify(status)).toBe(1);
      expect(status).toMatchObject({
        status: "blocked", code: "VISUAL_REVIEW_MISSING", stage: "offline", facts_sha256: FACTS_SHA, shop_id: "fictional-bicycle-repair-tamaki", site_name: "架空自転車修理 環",
        direction_id: DIRECTION_ID, review: { supplied: false, sha256: null }, package_sha256: null, owner_approval: "required", sendable: false,
      });
      // the generation pin: the ledger receipt, carried unchanged
      expect(status.generation).toMatchObject({ approval_id: receipt.approval_id, plan_id: receipt.plan_id, run_id: receipt.run_id, slot: receipt.slot, prompt_sha256: promptPin.sha256, prompt_chars: promptPin.chars, prompt_version: "v2", worker_commit: COMMIT });
      expect(status.generation.call_json_sha256).toBe(sha(readFileSync(join(designDir, "call.json"))));
      expect(status.prototype_sha256).toEqual({ html: sha(HTML), css: sha(CSS) });
      // the steps that ran, and where it stopped
      expect(status.offline.steps.map((s: { step: string; outcome: string; code?: string }) => [s.step, s.outcome, s.code ?? null])).toEqual([["copy", "ok", null], ["render", "ok", null], ["visual", "stopped", "VISUAL_REVIEW_MISSING"]]);
      expect(status.offline.steps[0].copy_step).toBe("owner_review");
      // the render ran (PC1440 and SP390 PNGs); there is no review to compare them with yet
      expect(status.offline.render_review).toBe("none");
      expect(existsSync(join(out, "offline", "renders", "desktop.png")) && existsSync(join(out, "offline", "renders", "mobile.png"))).toBe(true);
      expect(existsSync(join(out, "offline", "package"))).toBe(false);
      // one facts SHA across every artifact of the chain
      const handoff = readJson(join(out, "handoff", "status.json"));
      const copy = readJson(join(out, "comp", DIRECTION_ID, "copy.json"));
      const offline = readJson(join(out, "offline", "status.json"));
      expect([readJson(join(designInput, "pin.json")).facts_sha256, readJson(join(artifact(), "artifact.json")).facts_pack_sha256, handoff.facts_sha256, copy.facts_sha256, offline.facts_sha256, sha(readFileSync(join(out, "offline", "input", "facts-pack.json")))]).toEqual(Array(6).fill(FACTS_SHA));
      expect(handoff).toMatchObject({ shop_id: "fictional-bicycle-repair-tamaki", direction_id: DIRECTION_ID, sendable: false });
    });

    it("with the committed review of exactly these rendered bytes: --check-review passes and the v2 package is produced, pinned to the generation", { timeout: 300_000 }, () => {
      const out = join(root, "runs", "glue-reviewed");
      const r = glue(...args(out, "--review", REVIEW_PATH));
      const status = readJson(join(out, "status.json"));
      expect(r.status, JSON.stringify(status)).toBe(0);
      // the review is of exactly the bytes the glue rendered (page, CSS and derived copy), of this shop and direction
      const comp = join(out, "comp", DIRECTION_ID);
      expect(REVIEW).toMatchObject({ shop_id: "fictional-bicycle-repair-tamaki", direction_id: DIRECTION_ID, verdict: "show_owner" });
      expect([sha(readFileSync(join(comp, "index.html"))), sha(readFileSync(join(comp, "style.css"))), sha(readFileSync(join(comp, "copy.json")))]).toEqual([REVIEW.comp.html_sha256, REVIEW.comp.css_sha256, REVIEW.comp.copy_sha256]);
      expect(status).toMatchObject({ status: "package_prepared_owner_review_required", code: null, facts_sha256: FACTS_SHA, review: { supplied: true, sha256: sha(readFileSync(REVIEW_PATH)) }, owner_approval: "required", external_send: "disabled", sendable: false });
      expect(status.offline.steps.map((s: { step: string; outcome: string }) => [s.step, s.outcome])).toEqual([["copy", "ok"], ["render", "ok"], ["visual", "ok"], ["package", "ok"]]);
      expect(status.offline.render_review.structural_ok).toBe(true);
      expect(status.generation).toMatchObject({ approval_id: receipt.approval_id, run_id: receipt.run_id, slot: receipt.slot, prompt_sha256: promptPin.sha256 });
      const pkg = readJson(join(out, "offline", "package", "package.json"));
      expect(pkg.format).toBe("sales_demo_version_package_v2");
      expect(pkg.bundleSha256).toBe(status.package_sha256);
      expect(sha(readFileSync(join(out, "offline", "package", "copy", "facts-pack.json")))).toBe(FACTS_SHA);
      expect(readJson(join(out, "offline", "package", "copy", "copy.json")).facts_sha256).toBe(FACTS_SHA);
      expect(JSON.stringify(pkg)).not.toMatch(/"sendable"\s*:\s*true/);
    });
  });
});
