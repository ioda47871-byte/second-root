import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkIntake, EVIDENCE_KINDS, IntakeError } from "@/lib/design-agent/intelligence/intake";

// DEV-120: the intake of CP-026..032 (owner adoption reported, originals not checked) stays out of the research set.

const REPO = resolve(__dirname, "../../../..");
const FILE = "design-library/research-intake/cp-026-032.json";
// a mutable view of the JSON for building broken variants
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const intake = () => JSON.parse(readFileSync(resolve(REPO, FILE), "utf8")) as Json;
// the 23 owner-selected cases registered on PR #142 (CP-014 and CP-025 are not successes)
const REGISTERED = [...Array.from({ length: 24 }, (_, i) => `CP-${String(i + 1).padStart(3, "0")}`).filter((id) => id !== "CP-014")];
const codeOf = (f: () => unknown) => {
  try {
    f();
    return "ok";
  } catch (e) {
    return e instanceof IntakeError ? e.code : String(e);
  }
};

describe("the CP-026..032 intake", () => {
  it("holds the 7 adopted, unregistered cases: form unknown, none counted in the registered dataset, none promotable, all evidence missing", () => {
    const report = checkIntake(intake(), { registeredCaseIds: REGISTERED });
    expect(report.records.map((r) => `${r.id} ${r.title} ${r.version_label}`)).toEqual([
      "CP-026 Sawaddee Chao v5",
      "CP-027 MATO OBJECTS STORE v2",
      "CP-028 ユメツナベース v1",
      "CP-029 SNOWMY v4",
      "CP-030 高田時計店 v2",
      "CP-031 リフォーム 中村 v3",
      "CP-032 幸せを呼ぶ玉虫屋 v1",
    ]);
    expect(report.counts).toEqual({ intake_records: 7, counted_in_registered_dataset: 0, promotable: 0 });
    for (const r of report.records) {
      expect(r.promotable).toBe(false);
      expect(r.recorded_unverified).toEqual([]);
      expect(r.not_implemented).toEqual([]);
      expect(r.research_form).toBe("unknown");
      expect(r.missing).toEqual([...EVIDENCE_KINDS]);
      expect(r.blockers).toContain("originals_not_checked_by_a_person");
    }
    // 30 adopted by the owner = 23 registered on PR #142 (10 PoC + 13 images) + 7 here; CP-014 and CP-025 are not successes
    expect(intake().baseline).toMatchObject({ research_pr: 142, research_pr_head: "efe269f4b4a13f3c05bfb799891c8157c9be4c0b", owner_adopted_research_total: 30, registered_success_cases: 23, local_html_css_js_poc: 10, concept_image_only: 13, adopted_not_registered: 7, not_success: ["CP-014", "CP-025"] });
    for (const r of intake().records) expect(r.adoption.state).toBe("owner_adopted_originals_not_checked");
  });

  it("refuses to count, to feed a generator, or to be read by the adapter", () => {
    const set = (path: string[], value: unknown) => {
      const j = intake();
      let o = j;
      for (const k of path.slice(0, -1)) o = o[k];
      o[path.at(-1)!] = value;
      return j;
    };
    expect(codeOf(() => checkIntake(set(["policy", "counted_in_registered_dataset"], true), { registeredCaseIds: REGISTERED }))).toBe("INTAKE_SCHEMA_INVALID");
    // the totals must add up: 23 + 7 = 30, and 7 = the records here
    expect(codeOf(() => checkIntake(set(["baseline", "owner_adopted_research_total"], 31), { registeredCaseIds: REGISTERED }))).toBe("INTAKE_SCHEMA_INVALID");
    expect(codeOf(() => checkIntake(set(["baseline", "adopted_not_registered"], 6), { registeredCaseIds: REGISTERED }))).toBe("INTAKE_SCHEMA_INVALID");
    expect(codeOf(() => checkIntake(set(["policy", "approval_for_generation"], true), { registeredCaseIds: REGISTERED }))).toBe("INTAKE_SCHEMA_INVALID");
    expect(codeOf(() => checkIntake(set(["policy", "read_by_design_intelligence_adapter"], true), { registeredCaseIds: REGISTERED }))).toBe("INTAKE_SCHEMA_INVALID");
    expect(codeOf(() => checkIntake(set(["records", "0", "counted_in_registered_dataset"], true), { registeredCaseIds: REGISTERED }))).toBe("INTAKE_SCHEMA_INVALID");
    expect(codeOf(() => checkIntake(set(["records", "0", "adoption", "state"], "owner_selected"), { registeredCaseIds: REGISTERED }))).toBe("INTAKE_SCHEMA_INVALID");
  });

  it("evidence is missing or recorded-unverified (a SHA for files, a research record for the rest); there is no 'verified'", () => {
    const withEvidence = (kind: string, value: unknown) => {
      const j = intake();
      j.records[0].evidence[kind] = value;
      return j;
    };
    const sha = "a".repeat(64);
    const ok = checkIntake(withEvidence("html_source", { state: "recorded_unverified", sha256: sha }), { registeredCaseIds: REGISTERED });
    expect(ok.records[0]!.recorded_unverified).toEqual(["html_source"]);
    expect(ok.records[0]!.promotable).toBe(false);
    expect(ok.counts.promotable).toBe(0);
    for (const bad of [
      { state: "verified", sha256: sha },
      { state: "recorded_unverified" },
      { state: "recorded_unverified", sha256: "abc" },
      { state: "recorded_unverified", ref: "design-library/x.md" },
      { state: "missing", sha256: sha },
    ])
      expect(codeOf(() => checkIntake(withEvidence("html_source", bad), { registeredCaseIds: REGISTERED })), JSON.stringify(bad)).toBe("INTAKE_SCHEMA_INVALID");
    expect(codeOf(() => checkIntake(withEvidence("design_analysis", { state: "recorded_unverified", ref: "design-library/success-cases/CP-026-x.md" }), { registeredCaseIds: REGISTERED }))).toBe("ok");
    expect(codeOf(() => checkIntake(withEvidence("design_analysis", { state: "recorded_unverified", ref: "design-library/../x.md" }), { registeredCaseIds: REGISTERED }))).toBe("INTAKE_SCHEMA_INVALID");
    expect(codeOf(() => checkIntake(withEvidence("design_analysis", { state: "recorded_unverified", sha256: sha }), { registeredCaseIds: REGISTERED }))).toBe("INTAKE_SCHEMA_INVALID");
    // a deliverable the study never had is "not_implemented", said only once the form is known
    const form = (f: string, kind: string) => {
      const j = withEvidence(kind, { state: "not_implemented" });
      j.records[0].research_form = f;
      j.records[0].evidence.adopted_image = { state: "recorded_unverified", sha256: sha };
      return j;
    };
    // the form is set only once the adopted image is on record (never from a guess)
    const guessed = intake();
    guessed.records[0].research_form = "static_image_study";
    expect(codeOf(() => checkIntake(guessed, { registeredCaseIds: REGISTERED }))).toBe("INTAKE_SCHEMA_INVALID");
    expect(codeOf(() => checkIntake(withEvidence("html_source", { state: "not_implemented" }), { registeredCaseIds: REGISTERED }))).toBe("INTAKE_SCHEMA_INVALID");
    const still = checkIntake(form("static_image_study", "html_source"), { registeredCaseIds: REGISTERED });
    expect(still.records[0]!.not_implemented).toEqual(["html_source"]);
    expect(still.records[0]!.missing).not.toContain("html_source");
    expect(still.records[0]!.promotable).toBe(false);
    expect(checkIntake(form("static_image_study", "mobile_full_page_capture"), { registeredCaseIds: REGISTERED }).records[0]!.not_implemented).toEqual(["mobile_full_page_capture"]);
    expect(checkIntake(form("local_web_poc", "mobile_full_page_capture"), { registeredCaseIds: REGISTERED }).records[0]!.not_implemented).toEqual(["mobile_full_page_capture"]);
    expect(codeOf(() => checkIntake(form("local_web_poc", "html_source"), { registeredCaseIds: REGISTERED }))).toBe("INTAKE_SCHEMA_INVALID");
    // the adopted image itself is never "not implemented"
    // refused by the adopted image's own type (the error names that field), not only by the form rules
    const typeError = (() => {
      try {
        checkIntake(withEvidence("adopted_image", { state: "not_implemented" }), { registeredCaseIds: REGISTERED });
        return "ok";
      } catch (e) {
        return e instanceof IntakeError ? e.message : String(e);
      }
    })();
    expect(typeError).toBe("INTAKE_SCHEMA_INVALID: records.0.evidence.adopted_image");
    const noImage = form("static_image_study", "html_source");
    noImage.records[0].evidence.adopted_image = { state: "not_implemented" };
    expect(codeOf(() => checkIntake(noImage, { registeredCaseIds: REGISTERED }))).toBe("INTAKE_SCHEMA_INVALID");
    expect(codeOf(() => checkIntake(form("static_image_study", "design_analysis"), { registeredCaseIds: REGISTERED }))).toBe("INTAKE_SCHEMA_INVALID");
  });

  it("an intake ID never reuses a registered case, CP-014 / CP-025, or another intake record", () => {
    const j = intake();
    expect(codeOf(() => checkIntake(j, { registeredCaseIds: [...REGISTERED, "CP-030"] }))).toBe("INTAKE_ID_ALREADY_REGISTERED");
    const k = intake();
    k.records[1].id = "CP-025";
    expect(codeOf(() => checkIntake(k, { registeredCaseIds: REGISTERED }))).toBe("INTAKE_ID_ALREADY_REGISTERED");
    const d = intake();
    d.records[1].id = "CP-026";
    expect(codeOf(() => checkIntake(d, { registeredCaseIds: REGISTERED }))).toBe("INTAKE_DUPLICATE_ID");
  });

  it("is never read by the adapter or its CLI", () => {
    for (const f of ["lib/design-agent/intelligence/corpus.ts", "lib/design-agent/intelligence/brief.ts", "lib/design-agent/intelligence/ledger.ts", "scripts/design-intelligence/brief.ts"])
      expect(readFileSync(resolve(REPO, f), "utf8"), f).not.toMatch(/research-intake|intake/);
  });
});
