import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { OfflinePrepStop, prepareOffline } from "../../scripts/sales/demo-version/prepare-offline.mjs";

const roots = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const sha = (v) => createHash("sha256").update(v).digest("hex");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "secondroot-offline-test-")); roots.push(root);
  const compDir = join(root, "comp"); mkdirSync(compDir);
  const factsPath = join(root, "facts-pack.json");
  const fact = JSON.stringify({ schema: "shop_facts_pack_v1", shop_id: "fictional-adapter", facts: [
    { id: "F1", key: "name", value: "架空の店舗", source_id: "S1" },
  ] });
  writeFileSync(factsPath, fact);
  writeFileSync(join(compDir, "index.html"), "<html><body>架空の店舗</body></html>");
  writeFileSync(join(compDir, "style.css"), "body { margin: 0; }");
  writeFileSync(join(compDir, "copy.json"), JSON.stringify({ schema: "comp_copy_v1", shop_id: "fictional-adapter", facts_sha256: sha(fact), items: [] }));
  writeFileSync(join(compDir, "review.json"), JSON.stringify({ verdict: "show_owner" }));
  return { root, compDir, factsPath, outDir: join(root, "out") };
}
const ok = (step) => ({ exit: 0, output: step === "render" ? { status: "OK" }
  : step === "copy" ? { step: "owner_review", mayShowOwner: true, codes: [] }
  : step === "visual" ? { ok: true, codes: [] }
  : { status: "OK", format: "sales_demo_version_package_v2", bundle_sha256: "f".repeat(64) } });

test("reuses existing four stages in order, stages copy without overwriting original", () => {
  const f = fixture(), seen = [];
  const report = prepareOffline(f, (step, args) => { seen.push({ step, args }); return ok(step); });
  assert.equal(report.status, "package_prepared_owner_review_required");
  assert.equal(report.owner_approval, "required");
  assert.equal(report.external_send, "disabled");
  assert.deepEqual(seen.map((x) => x.step), ["copy", "render", "visual", "package"]);
  assert.equal(JSON.parse(readFileSync(join(f.compDir, "copy.json"), "utf8")).shop_id, "fictional-adapter");
  assert.equal(JSON.parse(readFileSync(join(f.outDir, "comp", "review.json"), "utf8")).verdict, "show_owner");
  assert.equal(JSON.parse(readFileSync(join(f.outDir, "status.json"), "utf8")).package_sha256, "f".repeat(64));
  assert.ok(seen[3].args.includes(join(f.outDir, "comp")));
});

test("copy HOLD stops before visual review or packaging and retains hold code", () => {
  const f = fixture(), seen = [];
  const report = prepareOffline(f, (step) => { seen.push(step); return step === "copy"
    ? { exit: 1, output: { step: "stop_hold", mayShowOwner: false, codes: ["COPY_INFORMATION_MISSING"] } }
    : ok(step); });
  assert.deepEqual(seen, ["copy"]);
  assert.equal(report.code, "COPY_STOP_HOLD");
  assert.deepEqual(report.steps[0].findings, ["COPY_INFORMATION_MISSING"]);
  assert.equal(report.package_sha256, null);
});

test("missing visual review never packages", () => {
  const f = fixture(), seen = [];
  const report = prepareOffline(f, (step) => { seen.push(step); return step === "visual" ? { exit: 1, output: { ok: false, codes: ["REVIEW_MISSING"] } } : ok(step); });
  assert.deepEqual(seen, ["copy", "render", "visual"]);
  assert.equal(report.code, "VISUAL_REVIEW_STOP");
});

test("a changed original facts file is refused before the next step", () => {
  const f = fixture();
  const report = prepareOffline(f, (step) => {
    if (step === "copy") writeFileSync(f.factsPath, "changed");
    return ok(step);
  });
  assert.equal(report.code, "INPUT_MUTATED");
  assert.equal(report.steps.length, 1);
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

test("mismatched facts hash or shop id is refused before executing scripts", () => {
  const f = fixture();
  writeFileSync(f.factsPath, JSON.stringify({ schema: "shop_facts_pack_v1", shop_id: "fictional-another", facts: [] }));
  assert.throws(() => prepareOffline(f, () => { throw Error("must not execute"); }), (e) => e instanceof OfflinePrepStop && e.code === "FACTS_COPY_MISMATCH");
});

test("refuses a symlinked comp input and never creates an output", () => {
  const f = fixture();
  rmSync(join(f.compDir, "style.css")); symlinkSync(join(f.compDir, "index.html"), join(f.compDir, "style.css"));
  assert.throws(() => prepareOffline(f, () => ok("render")), (e) => e instanceof OfflinePrepStop && e.code === "INPUT_FILE_UNSAFE");
});

test("refuses to overwrite a previous run", () => {
  const f = fixture(); mkdirSync(f.outDir);
  assert.throws(() => prepareOffline(f, () => ok("render")), (e) => e instanceof OfflinePrepStop && e.code === "OUTPUT_EXISTS");
});

test("unexpected files (including photographs) are rejected", () => {
  const f = fixture(); writeFileSync(join(f.compDir, "hero.png"), "example");
  assert.throws(() => prepareOffline(f, () => ok("render")), (e) => e instanceof OfflinePrepStop && e.code === "COMP_UNEXPECTED_FILE");
});
