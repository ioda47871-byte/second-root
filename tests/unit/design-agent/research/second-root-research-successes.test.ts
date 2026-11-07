/**
 * DEV-191 (Issue #193, owner approval 2026-11-06, comment 6687410438): the ledger of Second Root's own research success
 * examples (fictional shops, quality pipeline) — design-library/success-cases/second-root-research-successes.json.
 * Pins the adoption state and the counts, the scope of 輪 d1-v9's adoption (design structure with MOCK photos; no real
 * image), that the page it names is the merged d1-v9 byte for byte, that old versions are kept, and that the 30 external
 * research cases (manifest.json, guarded at exactly 30) are not changed by it.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "../../../..");
const read = (p: string) => readFileSync(join(REPO, p), "utf8");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
type Rec = Record<string, unknown> & { id: string; status: string; page_dir: string; page_hashes: { html_sha256: string; css_sha256: string; copy_sha256: string } };
const LEDGER = JSON.parse(read("design-library/success-cases/second-root-research-successes.json")) as {
  counts: Record<string, number | string>;
  policy: Record<string, boolean>;
  records: Rec[];
};
const MANIFEST = JSON.parse(read("design-library/success-cases/manifest.json")) as { registered_case_count: number; records: Array<{ id: string }> };

describe("DEV-191 Second Root research success ledger", () => {
  it("counts: 1 formal success example (輪 d1-v9), 1 candidate (つぐ手), 30 external cases unchanged, 31 success records", () => {
    const formal = LEDGER.records.filter((r) => r.status === "owner_formal_research_success_example");
    const candidates = LEDGER.records.filter((r) => r.status === "owner_confirmed_success_example_candidate_not_formal");
    expect(formal.map((r) => r.id)).toEqual(["SR-001"]);
    expect(candidates.map((r) => r.id)).toEqual(["SR-C01"]);
    expect(LEDGER.records).toHaveLength(formal.length + candidates.length);
    expect(LEDGER.counts.formal_success_examples).toBe(formal.length);
    expect(LEDGER.counts.success_example_candidates).toBe(candidates.length);
    // the external corpus is untouched: still exactly 30, no SR id in it
    expect(MANIFEST.registered_case_count).toBe(30);
    expect(MANIFEST.records).toHaveLength(30);
    expect(MANIFEST.records.some((r) => r.id.startsWith("SR-"))).toBe(false);
    expect(LEDGER.counts.external_research_success_cases).toBe(MANIFEST.records.length);
    expect(LEDGER.counts.all_research_success_records).toBe(MANIFEST.records.length + formal.length);
    expect(LEDGER.policy).toEqual({ not_templates: true, not_added_to_external_case_count: true, not_fed_to_generators_automatically: true, release_or_deployment_approval: false, old_versions_kept_unedited: true });
  });

  it("輪 d1-v9: the merged page (PR #232, 38e396e), byte for byte; the owner's decisions; AI-photo demo complete, owner-approved (DEV-193)", () => {
    const r = LEDGER.records.find((x) => x.id === "SR-001")!;
    expect(r).toMatchObject({
      shop: "bicycle",
      adopted_version: "d1-v9",
      merge_commit: "38e396eedf2de3f7472fd29052036b8ca0f7541e",
      merged_pr: 232,
      owner_decision: { decided_by: "owner", decided_on: "2026-11-06", evidence: "Issue #193 comment 6687410438" },
      success_scope: "design_structure_and_ai_photo_demo_complete",
      viewports: ["desktop_1440", "tablet_768", "mobile_390"],
      design_status: "success",
      photo_status: "ai_generated_demo_owner_approved_complete",
      real_images_generated: 6,
      photo_prompt: { sha256: "83c9b2c628873d645a78145065a5ff5befeab7f406555b79649f1f44d8275594", bytes: 3865, approved: true, real_generation_approved: true },
      // DEV-192 one approved run, executed once (DONE, 6 image calls); DEV-193: the owner adopted the AI-photo version (6703047826)
      real_generation: { approval: "one_time_run_only", decided_on: "2026-11-07", evidence: "Issue #193 comment 6689664215", run_prompt_sha256: "4b8081e02c08e1d0842c27bf28afab2bc647a9c80acce8464c23acf20e6d7447", executed: true, standing_auto_run: false, execution_result: "DONE", image_tool_calls: 6, job_id: "job-bicycle-20261106201051-2bba09", worker_commit: "334f771fed0c953158aefc3926a208adf8a8ddc5", images_private: true, switch_off_verified: true },
      ai_photo_complete: "owner_approved",
      ai_photo_final_decision: { decided_by: "owner", decided_on: "2026-11-07", decision: "adopt_ai_photo_complete_research_success", evidence: "Issue #193 comment 6703047826", scope: "private ai_generated_demo study only" },
      approved_for_generation: false,
      approved_for_sales: false,
      approved_for_production: false,
      website_deployed: false,
    });
    const inv = JSON.parse(read("design-library/research/quality-pipeline/poc/bicycle/photo-slots-d1-v9.json")) as { page_dir: string; html_sha256: string; css_sha256: string; copy_sha256: string };
    expect(r.page_dir).toBe(inv.page_dir);
    expect(r.page_hashes).toEqual({ html_sha256: inv.html_sha256, css_sha256: inv.css_sha256, copy_sha256: inv.copy_sha256 });
    for (const [f, h] of [["index.html", r.page_hashes.html_sha256], ["style.css", r.page_hashes.css_sha256], ["copy.json", r.page_hashes.copy_sha256]] as const) expect(sha(readFileSync(join(REPO, r.page_dir, f))), f).toBe(h);
    expect(r.not_claimed).toEqual(["automatic reproduction by the production B pipeline", "published to Production or any public site", "a real shop or merchant approval", "real merchant photographs (the photos are ai_generated_demo)"]);
    expect(r.image_rights_status).toMatch(/ai_generated_demo; demo only; public_web=false/);
  });

  it("old versions are kept (every fidelity version of 輪 is listed and exists); d1-v9's README carries the appended SR-001 status line", () => {
    const r = LEDGER.records.find((x) => x.id === "SR-001")!;
    const dir = join(REPO, "design-library/research/quality-pipeline/poc/bicycle/fidelity");
    expect([...(r.previous_versions_kept as string[]), "d1-v9"].sort()).toEqual(readdirSync(dir).sort());
    // PR #233 review M1: the README is append-only — the dated status line is appended (the DEV-190 sentence stays as history)
    const readme = read("design-library/research/quality-pipeline/poc/bicycle/fidelity/d1-v9/README.md");
    const status = "- 2026-11-06 (DEV-191、オーナーの Issue #193 コメント `6687410438`): このページ d1-v9 を研究用の正式成功例 **SR-001** として登録した (デザインの構造の成功、写真は MOCK、実画像は未生成)。";
    expect(readme).toContain(status);
    expect(readme.indexOf("## 状態の追記 (2026-11-06、DEV-191)")).toBeGreaterThan(readme.indexOf("成功例として採用したのではない"));
  });

  it("つぐ手 stays a candidate (not formal); its page is the merged d1-v10", () => {
    const r = LEDGER.records.find((x) => x.id === "SR-C01")!;
    expect(r).toMatchObject({ shop: "tsugute", adopted_version: null, candidate_version: "d1-v10", owner_decision: { evidence: "Issue #193 comment 6676754174" }, approved_for_production: false });
    for (const [f, h] of [["index.html", r.page_hashes.html_sha256], ["style.css", r.page_hashes.css_sha256], ["copy.json", r.page_hashes.copy_sha256]] as const) expect(sha(readFileSync(join(REPO, r.page_dir, f))), f).toBe(h);
  });

  it("the README and the index record it with the same counts and scope", () => {
    const readme = read("design-library/success-cases/README.md");
    for (const s of ["second-root-research-successes.json", "SR-001", "研究用の正式成功例", "写真は MOCK、実画像は未生成（0枚）", "研究成功の記録 31件", "6687410438"]) expect(readme, s).toContain(s);
    expect(read("docs/design/success-cases-index.md")).toContain("SR-001: 輪 d1-v9");
    expect(existsSync(join(REPO, "design-library/success-cases/assets"))).toBe(true);
  });
});
