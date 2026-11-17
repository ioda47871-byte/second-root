import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  OfflinePrepStop, REPO, prepareOffline, runRepoStep, runSupervised,
} from "../../scripts/sales/demo-version/prepare-offline.mjs";

const roots = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const sha = (v) => createHash("sha256").update(v).digest("hex");
const tmpRoot = () => { const root = mkdtempSync(join(tmpdir(), "secondroot-offline-test-")); roots.push(root); return root; };
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const DIRECTION = "d1-fictional-adapter";

/** A fictional shop outside the repository: <root>/shop/facts-pack.json, <root>/shop/comps/<direction>, runs in <root>/runs. */
function fixture() {
  const root = tmpRoot();
  const shop = join(root, "shop");
  const compDir = join(shop, "comps", DIRECTION); mkdirSync(compDir, { recursive: true });
  mkdirSync(join(root, "runs"));
  const factsPath = join(shop, "facts-pack.json");
  const fact = JSON.stringify({ schema: "shop_facts_pack_v1", shop_id: "fictional-adapter", facts: [
    { id: "F1", key: "name", value: "架空の店舗", source_id: "S1" },
  ] });
  writeFileSync(factsPath, fact);
  writeFileSync(join(compDir, "index.html"), "<html><body>架空の店舗</body></html>");
  writeFileSync(join(compDir, "style.css"), "body { margin: 0; }");
  writeFileSync(join(compDir, "copy.json"), JSON.stringify({ schema: "comp_copy_v1", shop_id: "fictional-adapter", facts_sha256: sha(fact), items: [] }));
  writeFileSync(join(compDir, "review.json"), JSON.stringify({ verdict: "show_owner" }));
  return { root, compDir, factsPath, outDir: join(root, "runs", "out") };
}
const stagedDir = (f, name = DIRECTION) => join(f.outDir, "comp", name);
const ok = (step) => ({ exit: 0, output: step === "render" ? { status: "OK", findings: [], review: { structural_ok: true, renders_match_here: false } }
  : step === "copy" ? { step: "owner_review", mayShowOwner: true, codes: [] }
  : step === "visual" ? { ok: true, codes: [] }
  : { status: "OK", format: "sales_demo_version_package_v2", bundle_sha256: "f".repeat(64) } });

test("reuses existing four stages in order on staged copies that keep the direction id", () => {
  const f = fixture(), seen = [];
  const report = prepareOffline(f, (step, args) => { seen.push({ step, args }); return ok(step); });
  assert.equal(report.status, "package_prepared_owner_review_required");
  assert.equal(report.owner_approval, "required");
  assert.equal(report.external_send, "disabled");
  assert.equal(report.direction_id, DIRECTION);
  assert.deepEqual(seen.map((x) => x.step), ["copy", "render", "visual", "package"]);
  const stagedFacts = join(f.outDir, "input", "facts-pack.json");
  assert.equal(sha(readFileSync(stagedFacts)), report.facts_sha256);
  for (const { args } of seen) {
    // every step reads the staged copies only, never the originals
    assert.ok(args.includes(stagedDir(f)));
    assert.ok(args.includes(stagedFacts));
    assert.ok(!args.includes(f.compDir) && !args.includes(f.factsPath));
  }
  assert.equal(readJson(join(stagedDir(f), "review.json")).verdict, "show_owner");
  const status = readJson(join(f.outDir, "status.json"));
  assert.equal(status.package_sha256, "f".repeat(64));
  // L4: the render step's own answer whether the review is of these renders
  assert.deepEqual(status.render_review, { structural_ok: true, renders_match_here: false });
  // L2: exit code and finding codes per step
  assert.deepEqual(status.steps.map((s) => [s.step, s.outcome, s.exit]), [["copy", "ok", 0], ["render", "ok", 0], ["visual", "ok", 0], ["package", "ok", 0]]);
  assert.deepEqual(readdirSync(f.compDir).sort(), ["copy.json", "index.html", "review.json", "style.css"]);
});

test("copy HOLD stops before visual review or packaging and retains hold code", () => {
  const f = fixture(), seen = [];
  const report = prepareOffline(f, (step) => { seen.push(step); return step === "copy"
    ? { exit: 1, output: { step: "stop_hold", mayShowOwner: false, codes: ["COPY_INFORMATION_MISSING"] } }
    : ok(step); });
  assert.deepEqual(seen, ["copy"]);
  assert.equal(report.code, "COPY_STOP_HOLD");
  assert.deepEqual(report.steps[0].findings, ["COPY_INFORMATION_MISSING"]);
  assert.equal(report.steps[0].exit, 1);
  assert.equal(report.package_sha256, null);
});

test("review verdict revise/drop stops before packaging even when schema checks pass", () => {
  for (const verdict of ["revise", "drop"]) {
    const f = fixture();
    writeFileSync(join(f.compDir, "review.json"), JSON.stringify({ verdict }));
    const seen = [];
    const report = prepareOffline(f, (step) => { seen.push(step); return ok(step); });
    assert.deepEqual(seen, ["copy", "render", "visual"]);
    assert.equal(report.code, "VISUAL_NOT_READY_FOR_OWNER");
    assert.equal(report.package_sha256, null);
  }
});

test("findings are codes only and capped; stderr text is reduced to its leading code", () => {
  const f = fixture();
  const many = Array.from({ length: 100 }, (_, i) => `CODE_${i}`);
  const report = prepareOffline(f, (step) => step === "render"
    ? { exit: 1, stderrCode: "INPUT_ERROR", output: { status: "FAIL", findings: [...many.map((code) => ({ code, detail: "/private/path 架空" })), { code: "lower case text" }] } }
    : ok(step));
  assert.equal(report.code, "RENDER_GATE_STOP");
  const render = readJson(join(f.outDir, "status.json")).steps[1];
  assert.equal(render.findings.length, 40);
  assert.ok(render.findings.every((c) => /^[A-Z][A-Z0-9_]*$/.test(c)));
  assert.equal(render.stderr_code, "INPUT_ERROR");
  assert.ok(!readFileSync(join(f.outDir, "status.json"), "utf8").includes("/private/path"));
});

// M1: one row per stop code. `run` replaces one step's answer (or does something to the files during a step).
const stopTable = [
  ["render FAIL", { render: { exit: 1, output: { status: "FAIL", findings: [{ code: "TEXT_NOT_IN_RECORD" }] } } }, "RENDER_GATE_STOP"],
  ["render invalid output", { render: { exit: 1, output: null, errorCode: "STEP_INVALID_OUTPUT" } }, "STEP_INVALID_OUTPUT"],
  ["render non-object output", { render: { exit: 0, output: "OK" } }, "STEP_INVALID_OUTPUT"],
  ["render timeout", { render: { exit: 124, output: null, errorCode: "STEP_TIMEOUT" } }, "STEP_TIMEOUT"],
  ["render spawn error", { render: { exit: 2, output: null, errorCode: "STEP_ERROR" } }, "STEP_ERROR"],
  ["render OK with exit 1", { render: { exit: 1, output: { status: "OK" } } }, "RENDER_GATE_STOP"],
  ["visual not ok", { visual: { exit: 1, output: { ok: false, codes: ["REVIEW_OF_ANOTHER_DIRECTION"] } } }, "VISUAL_REVIEW_STOP"],
  ["package v1 format", { package: { exit: 0, output: { status: "OK", format: "sales_demo_version_package_v1", bundle_sha256: "a".repeat(64) } } }, "PACKAGE_STOP"],
  ["package missing format", { package: { exit: 0, output: { status: "OK", bundle_sha256: "a".repeat(64) } } }, "PACKAGE_STOP"],
  ["package FAIL", { package: { exit: 1, output: { status: "FAIL", code: "COPY_REVIEW_MISSING" } } }, "PACKAGE_STOP"],
  ["package invalid output", { package: { exit: 0, output: null, errorCode: "STEP_INVALID_OUTPUT" } }, "STEP_INVALID_OUTPUT"],
  ["package timeout", { package: { exit: 124, output: null, errorCode: "STEP_TIMEOUT" } }, "STEP_TIMEOUT"],
  ["copy revise", { copy: { exit: 1, output: { step: "revise", mayShowOwner: false, codes: ["COPY_REPETITIVE_CADENCE"] } } }, "COPY_REVISE"],
  ["copy fail", { copy: { exit: 1, output: { step: "stop_fail", mayShowOwner: false, codes: ["COPY_FACT_UNSUPPORTED"] } } }, "COPY_STOP_FAIL"],
  ["copy refused", { copy: { exit: 1, output: { step: "refused", mayShowOwner: false, codes: ["REVIEW_SCHEMA"] } } }, "COPY_REFUSED"],
  ["copy input error (no stdout)", { copy: { exit: 2, output: null, errorCode: "STEP_INVALID_OUTPUT", stderrCode: "INPUT_ERROR" } }, "STEP_INVALID_OUTPUT"],
  ["step throws", { render: () => { throw new Error("boom"); } }, "STEP_EXCEPTION"],
  ["original comp file changed mid-run", { render: (f) => { writeFileSync(join(f.compDir, "style.css"), "body{}"); } }, "INPUT_MUTATED"],
  ["original facts changed mid-run", { copy: (f) => { writeFileSync(f.factsPath, "changed"); } }, "INPUT_MUTATED"],
  ["staged comp changed by render", { render: (f) => { writeFileSync(join(stagedDir(f), "index.html"), "<p>x</p>"); } }, "STAGED_COMP_MUTATED"],
  ["file added to staged comp by visual", { visual: (f) => { writeFileSync(join(stagedDir(f), "hero.png"), "x"); } }, "STAGED_COMP_MUTATED"],
  ["copy audit changes more than copy-review.json", { copy: (f) => { writeFileSync(join(stagedDir(f), "copy-review.json"), "{}"); writeFileSync(join(stagedDir(f), "style.css"), "p{}"); } }, "STAGED_COMP_MUTATED"],
  ["staged facts changed", { render: (f) => { writeFileSync(join(f.outDir, "input", "facts-pack.json"), "{}"); } }, "STAGED_FACTS_MUTATED"],
];
for (const [name, overrides, code] of stopTable) {
  test(`stop table: ${name} -> ${code}`, () => {
    const f = fixture(), seen = [];
    const report = prepareOffline(f, (step) => {
      seen.push(step);
      const o = overrides[step];
      if (typeof o === "function") { o(f); return ok(step); }
      return o ?? ok(step);
    });
    assert.equal(report.code, code);
    assert.equal(report.status, "blocked");
    assert.equal(report.package_sha256, null);
    const status = readJson(join(f.outDir, "status.json"));
    assert.equal(status.code, code);
    assert.equal(status.steps.at(-1).code, code);
    assert.equal(status.steps.at(-1).step, seen.at(-1));
    const o = overrides[seen.at(-1)]?.output;
    assert.deepEqual(status.steps.at(-1).findings, [...(o?.codes ?? []), ...(o?.findings ?? []).map((x) => x.code), ...(o?.code ? [o.code] : [])]);
  });
}

// Refused before anything is written (no run directory is created).
const refuseTable = [
  ["output inside the repository", (f) => { f.outDir = join(REPO, `.offline-prep-test-${process.pid}-never-created`); }, "OUTPUT_IN_REPO"],
  ["output inside the comp", (f) => { f.outDir = join(f.compDir, "run"); }, "OUTPUT_OVERLAPS_INPUT"],
  ["output inside the facts directory", (f) => { f.outDir = join(f.root, "shop", "run"); }, "OUTPUT_OVERLAPS_INPUT"],
  ["output exists", (f) => { mkdirSync(f.outDir); }, "OUTPUT_EXISTS"],
  ["comp reached through a symlinked parent", (f) => {
    symlinkSync(join(f.root, "shop", "comps"), join(f.root, "linked-comps"));
    f.compDir = join(f.root, "linked-comps", DIRECTION);
  }, "INPUT_SYMLINK_PARENT"],
  ["facts reached through a symlink", (f) => {
    symlinkSync(f.factsPath, join(f.root, "facts-link.json"));
    f.factsPath = join(f.root, "facts-link.json");
  }, "INPUT_SYMLINK_PARENT"],
  ["unsafe direction name", (f) => {
    const other = join(f.root, "shop", "comps", "-x 店");
    cpSync(f.compDir, other, { recursive: true });
    f.compDir = other;
  }, "COMP_NAME_UNSAFE"],
  ["malformed copy-rounds (gap)", (f) => { mkdirSync(join(f.compDir, "copy-rounds", "1"), { recursive: true }); }, "COPY_ROUNDS_MALFORMED"],
  ["malformed copy-rounds (too many)", (f) => { for (const i of ["0", "1", "2"]) mkdirSync(join(f.compDir, "copy-rounds", i), { recursive: true }); }, "COPY_ROUNDS_MALFORMED"],
  ["copy-rounds round with a stray file", (f) => { mkdirSync(join(f.compDir, "copy-rounds", "0"), { recursive: true }); writeFileSync(join(f.compDir, "copy-rounds", "0", "x.png"), "x"); }, "COPY_ROUNDS_UNSAFE"],
  ["symlinked comp file", (f) => { rmSync(join(f.compDir, "style.css")); symlinkSync(join(f.compDir, "index.html"), join(f.compDir, "style.css")); }, "INPUT_FILE_UNSAFE"],
  ["unexpected photograph", (f) => { writeFileSync(join(f.compDir, "hero.png"), "example"); }, "COMP_UNEXPECTED_FILE"],
  ["mismatched facts", (f) => { writeFileSync(f.factsPath, JSON.stringify({ schema: "shop_facts_pack_v1", shop_id: "fictional-another", facts: [] })); }, "FACTS_COPY_MISMATCH"],
  ["invalid JSON", (f) => { writeFileSync(f.factsPath, "{"); }, "INPUT_JSON_INVALID"],
];
for (const [name, setup, code] of refuseTable) {
  test(`refuse table: ${name} -> ${code}`, () => {
    const f = fixture();
    setup(f);
    const existed = existsSync(f.outDir);
    assert.throws(() => prepareOffline(f, () => { throw Error("must not execute"); }), (e) => e instanceof OfflinePrepStop && e.code === code);
    assert.equal(existsSync(f.outDir), existed);
  });
}

test("the supervisor maps a timeout to STEP_TIMEOUT and kills the step's whole process tree", { skip: process.platform !== "linux" }, () => {
  const root = tmpRoot();
  const pidFile = join(root, "grandchild.pid");
  const child = `const { spawn } = require("node:child_process");
    const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
    setInterval(() => {}, 1000);`;
  const r = runSupervised(["-e", child], 1500);
  assert.equal(r.errorCode, "STEP_TIMEOUT");
  assert.equal(r.exit, 124);
  const pid = Number(readFileSync(pidFile, "utf8"));
  const alive = () => existsSync(`/proc/${pid}`) && !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  const until = Date.now() + 3000;
  while (alive() && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  assert.equal(alive(), false);
  assert.equal(runSupervised(["-e", "process.stdout.write('{\"ok\":true}')"], 10_000).output.ok, true);
  assert.equal(runSupervised(["-e", "process.stdout.write('not json')"], 10_000).errorCode, "STEP_INVALID_OUTPUT");
});

// ---- Real CLI contract tests: the repository's own comp-copy / comp-lane / package-local, no browser, no network. ----
const POC = join(REPO, "design-library/research/quality-pipeline/poc");
/** A copy of a committed fictional comp outside the repository, under its own direction id. */
function realFixture(shop, direction) {
  const root = tmpRoot();
  const shopDir = join(root, "shop");
  const compDir = join(shopDir, "comps", direction);
  mkdirSync(compDir, { recursive: true });
  for (const name of readdirSync(join(POC, shop, "comps", direction))) cpSync(join(POC, shop, "comps", direction, name), join(compDir, name));
  cpSync(join(POC, shop, "facts-pack.json"), join(shopDir, "facts-pack.json"));
  mkdirSync(join(root, "runs"));
  return { root, compDir, factsPath: join(shopDir, "facts-pack.json"), outDir: join(root, "runs", "run-1") };
}
const stub = (real) => (step, args) => real.includes(step) ? runRepoStep(step, args) : ok(step);

test("real CLI: the adapter runs the real copy audit on the staged copy and stops on its revise verdict", () => {
  const f = realFixture("bicycle", "d1-wheel-hub-v6");
  const before = readdirSync(f.compDir).sort();
  const cli = spawnSync(process.execPath, [join(REPO, "scripts/sales/demo-version/prepare-offline.mjs"), "--facts", f.factsPath, "--comp", f.compDir, "--out", f.outDir], { encoding: "utf8", timeout: 120_000 });
  assert.equal(cli.status, 1, cli.stderr);
  const printed = JSON.parse(cli.stdout);
  assert.equal(printed.code, "COPY_REVISE");
  assert.ok(!cli.stdout.includes(f.root));
  const status = readJson(join(f.outDir, "status.json"));
  assert.deepEqual(status.steps.map((s) => [s.step, s.outcome, s.exit, s.copy_step]), [["copy", "stopped", 1, "revise"]]);
  assert.ok(status.steps[0].findings.includes("COPY_RHETORICAL_OVERUSE"));
  // the audit was written in the staged copy only, and status records its hash
  assert.ok(existsSync(join(f.outDir, "comp", "d1-wheel-hub-v6", "copy-review.json")));
  assert.equal(status.staged_comp_after_copy_sha256["copy-review.json"], sha(readFileSync(join(f.outDir, "comp", "d1-wheel-hub-v6", "copy-review.json"))));
  assert.deepEqual(readdirSync(f.compDir).sort(), before);
});

test("real CLI: --check-review passes on the staged copy because it keeps the direction id (the old <out>/comp did not)", () => {
  // d1-wheel-hub's committed review is a schema-valid `revise`: the real check passes, then the adapter stops on the verdict
  const f = realFixture("bicycle", "d1-wheel-hub");
  const report = prepareOffline(f, stub(["visual"]));
  assert.deepEqual(report.steps.map((s) => [s.step, s.outcome, s.exit]), [["copy", "ok", 0], ["render", "ok", 0], ["visual", "stopped", 0]]);
  assert.deepEqual(report.steps[2].findings, []);
  assert.equal(report.code, "VISUAL_NOT_READY_FOR_OWNER");
  // the same files under the old staging name are refused as a review of another direction
  const old = join(tmpRoot(), "comp");
  cpSync(f.compDir, old, { recursive: true });
  const r = runRepoStep("visual", ["--check-review", old, "--facts", f.factsPath]);
  assert.equal(r.exit, 1);
  assert.ok(r.output.codes.includes("REVIEW_OF_ANOTHER_DIRECTION"));
});

test("real CLI: a show_owner review on the staged copy reaches the copy gate, not a direction refusal", () => {
  const f = realFixture("bicycle", "d1-wheel-hub-v6");
  const report = prepareOffline(f, stub(["copy", "visual"]));
  // the real copy audit says revise, so stop there; then run the real check on the same staged copy
  assert.equal(report.code, "COPY_REVISE");
  const r = runRepoStep("visual", ["--check-review", join(f.outDir, "comp", "d1-wheel-hub-v6"), "--facts", join(f.outDir, "input", "facts-pack.json")]);
  assert.equal(r.exit, 1);
  assert.ok(!r.output.codes.some((c) => c.startsWith("REVIEW_OF_ANOTHER")));
  assert.ok(r.output.codes.includes("COPY_REVISE"));
});

test("real CLI: the real packager refuses a comp without a copy audit, mapped to PACKAGE_STOP with its code", () => {
  const f = realFixture("bicycle", "d1-wheel-hub-v6");
  const report = prepareOffline(f, stub(["package"]));
  assert.equal(report.code, "PACKAGE_STOP");
  assert.deepEqual(report.steps.at(-1).findings, ["COPY_REVIEW_MISSING"]);
  assert.equal(report.steps.at(-1).exit, 1);
  assert.equal(existsSync(join(f.outDir, "package")), false);
});

// With a browser (PLAYWRIGHT_CHROMIUM_EXECUTABLE), the fictional sendable page goes through the real copy audit and the
// real renderer in the adapter, and the real v2 packager on the same staged copy. No committed comp has both an
// owner-review copy audit and a show_owner visual review (the page has none, so the adapter stops at the visual step).
const browser = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
test("real CLI with a browser: copy audit, render and v2 package of the fictional sendable page", { skip: !browser || !existsSync(browser) ? "PLAYWRIGHT_CHROMIUM_EXECUTABLE not set" : false, timeout: 180_000 }, () => {
  const root = tmpRoot();
  const compDir = join(root, "shop", "comps", "page");
  mkdirSync(compDir, { recursive: true });
  for (const name of readdirSync(join(POC, "sendable-tamaki", "page"))) cpSync(join(POC, "sendable-tamaki", "page", name), join(compDir, name));
  cpSync(join(POC, "sendable-tamaki", "facts-pack.json"), join(root, "shop", "facts-pack.json"));
  mkdirSync(join(root, "runs"));
  const f = { compDir, factsPath: join(root, "shop", "facts-pack.json"), outDir: join(root, "runs", "run-1") };
  const report = prepareOffline(f);
  assert.deepEqual(report.steps.map((s) => [s.step, s.outcome, s.exit]), [["copy", "ok", 0], ["render", "ok", 0], ["visual", "stopped", 2]], JSON.stringify(report.steps));
  assert.equal(report.code, "STEP_INVALID_OUTPUT");
  assert.equal(report.steps[2].stderr_code, "INPUT_ERROR");
  assert.equal(report.render_review, "none");
  assert.ok(existsSync(join(f.outDir, "renders", "desktop.png")));
  const pkg = runRepoStep("package", ["--out", join(f.outDir, "package"), "--copy", join(f.outDir, "comp", "page"), "--facts", join(f.outDir, "input", "facts-pack.json")]);
  assert.equal(pkg.exit, 0);
  assert.equal(pkg.output.format, "sales_demo_version_package_v2");
  assert.match(pkg.output.bundle_sha256, /^[0-9a-f]{64}$/);
});
