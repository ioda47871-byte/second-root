import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// DEV-139 STEP 2 (Issue #139 / #263): the real CLIs on develop, in order, on committed fictional data, in a tmpdir:
//   verified facts (committed fictional pack bytes) → prepare-design-input → phase2f-design --print-pin (no model call)
//   → from-prototype (existing HTML/CSS → comp_copy_v1) → prepare-offline (copy audit → PC/SP render →
//   --check-review → v2 package).
// Nothing is mocked. The visual review (step2-review/review.json) was written by Claude after looking at the PC1440 and
// SP390 renders; see docs/operations/step2-fictional-e2e.md. The DB read path (verified-generation-facts.ts) is NOT
// exercised here (it has its own unit test); no DB, network, model, image generation or sending is touched.

const REPO = resolve(__dirname, "../../..");
const POC = join(REPO, "design-library/research/quality-pipeline/poc");
const TAMAKI = join(POC, "sendable-tamaki");
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const FACTS_SHA = sha(readFileSync(join(TAMAKI, "facts-pack.json")));
const REVIEW = readJson(join(TAMAKI, "step2-review", "review.json"));

/** Chromium for the render and package steps: the env override (as the CLIs read it), else Playwright's own install (CI). */
function browserAvailable(): boolean {
  const env = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (env) return existsSync(env);
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

/** A repository CLI as a separate process, cwd = repo; stdout parsed as JSON (the CLIs print status JSON only). */
function cli(args: string[], timeout = 150_000) {
  const r = spawnSync(process.execPath, args, { cwd: REPO, encoding: "utf8", timeout, env: { ...process.env } });
  let out: Record<string, unknown> | null = null;
  try {
    out = JSON.parse(r.stdout) as Record<string, unknown>;
  } catch {
    out = null;
  }
  return { status: r.status, out, stderr: r.stderr };
}
const tsx = (script: string, ...args: string[]) => cli(["--import", "tsx", join(REPO, script), ...args]);

let root = "";
let facts = "";
let directions = "";
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "secondroot-step2-"));
  mkdirSync(join(root, "shop"));
  mkdirSync(join(root, "runs"));
  facts = join(root, "shop", "facts-pack.json");
  copyFileSync(join(TAMAKI, "facts-pack.json"), facts);
  // 環 has no direction set of its own: its page is the 輪 d1-wheel-hub design. The 輪 set refers to facts by id only
  // (F10–F16 have the same values in both packs; F9 differs only in its leading phrase, and the set uses it only for
  // 「店先の作業台」, same in both), so it is re-pinned to 環's shop id and facts SHA, nothing else. The
  // direction-set gate (C1–C7) still runs on it against 環's facts.
  const set = readJson(join(POC, "bicycle", "direction-set.json"));
  set.shop_id = readJson(facts).shop_id;
  set.facts_sha256 = FACTS_SHA;
  directions = join(root, "shop", "direction-set.json");
  writeFileSync(directions, `${JSON.stringify(set, null, 2)}\n`);
});
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("STEP 2: one fictional shop through the real B-route CLIs", () => {
  it("keeps one facts SHA through design input, prompt pin and derived copy to the reviewed comp (no browser)", { timeout: 300_000 }, () => {
    // 1. design input (no prompt, no model)
    const input = tsx("scripts/sales/demo-version/prepare-design-input.ts", "--facts", facts, "--directions", directions,
      "--direction-id", "d1-wheel-hub", "--out", join(root, "runs", "design-input"));
    expect(input.status, input.stderr).toBe(0);
    expect(input.out).toMatchObject({ facts_sha256: FACTS_SHA, prompt_pin_required: true, sendable: false });
    const pin = readJson(join(root, "runs", "design-input", "pin.json"));
    expect(pin).toMatchObject({ facts_sha256: FACTS_SHA, direction_id: "d1-wheel-hub", design_generated: false, sendable: false });

    // 2. the existing phase2f prompt pin, offline (--print-pin only: no Codex, no approval used)
    const printed = tsx("scripts/design-artifact/phase2f-design.ts", "--print-pin", "--route", "B", "--prompt-version", "v2",
      "--facts", facts, "--direction", join(root, "runs", "design-input", "direction.json"),
      "--references", join(root, "runs", "design-input", "references.json"));
    expect(printed.status, printed.stderr).toBe(0);
    expect(printed.out).toMatchObject({ mode: "print_pin", route: "B_html_prototype", prompt_version: "v2" });
    expect(String(printed.out?.prompt_sha256)).toMatch(/^[0-9a-f]{64}$/);

    // 3. the existing fictional HTML/CSS → comp_copy_v1 (copy derived from the page and the facts, nothing hand-written)
    const proto = tsx("scripts/sales/demo-version/from-prototype.ts", "--facts", facts, "--prototype", join(TAMAKI, "page"),
      "--directions", directions, "--direction-id", "d1-wheel-hub", "--lane", "quality_research_fictional",
      "--out", join(root, "runs", "prototype"));
    expect(proto.status, proto.stderr).toBe(0);
    const handoff = readJson(join(root, "runs", "prototype", "status.json"));
    expect(handoff).toMatchObject({ facts_sha256: FACTS_SHA, direction_id: "d1-wheel-hub", owner_approval: "required", sendable: false });
    expect(handoff.copy.label_bound_fact_lines).toBeGreaterThan(0);
    const derived = join(root, "runs", "prototype", "comp", "d1-wheel-hub");
    expect(readJson(join(derived, "copy.json")).facts_sha256).toBe(FACTS_SHA);
    // the visual review is of exactly these derived bytes
    expect(sha(readFileSync(join(derived, "copy.json")))).toBe(REVIEW.comp.copy_sha256);
    expect(sha(readFileSync(join(derived, "index.html")))).toBe(REVIEW.comp.html_sha256);

    // 4. the reviewed comp: the derived page and copy, with the style.css of the review's one round and its review.json
    const comp = join(root, "shop", "comps", "d1-wheel-hub");
    mkdirSync(comp, { recursive: true });
    for (const f of ["index.html", "copy.json"]) copyFileSync(join(derived, f), join(comp, f));
    for (const f of ["style.css", "review.json"]) copyFileSync(join(TAMAKI, "step2-review", f), join(comp, f));
    expect(sha(readFileSync(join(comp, "style.css")))).toBe(REVIEW.comp.css_sha256);
    expect(REVIEW).toMatchObject({ shop_id: handoff.shop_id, direction_id: "d1-wheel-hub", verdict: "show_owner" });

    // without a browser: the real copy audit and the real visual-review check on a copy of the reviewed comp
    const probe = join(root, "probe", "d1-wheel-hub");
    mkdirSync(probe, { recursive: true });
    for (const f of ["index.html", "copy.json", "style.css", "review.json"]) copyFileSync(join(comp, f), join(probe, f));
    const audit = tsx("scripts/design-artifact/comp-copy.ts", "--audit", probe, "--facts", facts);
    expect(audit.status, audit.stderr).toBe(0);
    expect(audit.out).toMatchObject({ step: "owner_review", mayShowOwner: true });
    const visual = tsx("scripts/design-artifact/comp-lane.ts", "--check-review", probe, "--facts", facts);
    expect(visual.status, JSON.stringify(visual.out)).toBe(0);
    expect(visual.out).toMatchObject({ ok: true });

  });

  // Without Chromium this is reported as skipped (not silently passed). CI's unit job installs Playwright's Chromium.
  it.skipIf(!browserAvailable())("with a browser: the offline adapter runs all four gates for real and packages v2", { timeout: 300_000 }, () => {
    const comp = join(root, "shop", "comps", "d1-wheel-hub");
    expect(existsSync(join(comp, "review.json")), "the first test stages the reviewed comp").toBe(true);
    const out = join(root, "runs", "offline");
    const run = cli([join(REPO, "scripts/sales/demo-version/prepare-offline.mjs"), "--facts", facts, "--comp", comp, "--out", out], 280_000);
    const status = readJson(join(out, "status.json"));
    expect(run.status, JSON.stringify(status.steps)).toBe(0);
    expect(status).toMatchObject({
      status: "package_prepared_owner_review_required", code: null, facts_sha256: FACTS_SHA,
      owner_approval: "required", external_send: "disabled", sendable: false,
    });
    expect(status.steps.map((s: { step: string; outcome: string }) => [s.step, s.outcome])).toEqual([["copy", "ok"], ["render", "ok"], ["visual", "ok"], ["package", "ok"]]);
    expect(status.steps[0].copy_step).toBe("owner_review");
    expect(status.render_review.structural_ok).toBe(true);
    expect(existsSync(join(out, "renders", "desktop.png")) && existsSync(join(out, "renders", "mobile.png"))).toBe(true);
    // the package: v2, its facts are the same bytes, its copy record names the same SHA, the bundle hash is the one reported
    const pkg = readJson(join(out, "package", "package.json"));
    expect(pkg.format).toBe("sales_demo_version_package_v2");
    expect(pkg.bundleSha256).toBe(status.package_sha256);
    expect(sha(readFileSync(join(out, "package", "copy", "facts-pack.json")))).toBe(FACTS_SHA);
    expect(readJson(join(out, "package", "copy", "copy.json")).facts_sha256).toBe(FACTS_SHA);
    expect(readJson(join(out, "package", "copy", "review.json")).facts_sha256).toBe(FACTS_SHA);
    expect(JSON.stringify(pkg)).not.toMatch(/"sendable"\s*:\s*true/);
  });
});
