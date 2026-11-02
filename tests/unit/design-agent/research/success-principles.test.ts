import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// DEV-156 (Issue #193): the success principles from the 20 viewed cases, the failure codes and the checklist.
// The data is research; these tests only keep it honest: the cases are the ones the owner recorded as viewed, the
// evidence levels are not overstated, and every code and check is defined once and used.

const REPO = resolve(__dirname, "../../../..");
const read = (p: string) => readFileSync(resolve(REPO, p), "utf8");
type Case = { id: string; evidence: string[]; sources: string[]; principles: string[]; recorded_failures: string[]; pc_sp: string };
const doc = JSON.parse(read("design-library/research/quality-pipeline/principles-v1.json")) as {
  cases: Case[];
  not_viewed: string[];
  principles: Array<{ id: string }>;
  failure_codes: Array<{ code: string; checks: string[] }>;
  checklist: Array<{ id: string; failure_codes: string[] }>;
  evidence_levels: Record<string, string>;
};
const manifest = JSON.parse(read("design-library/success-cases/manifest.json")) as { registered_case_count: number; records: Array<{ id: string }> };
const inventory = JSON.parse(read("design-library/research/quality-pipeline/originals-inventory.json")) as { cases: Array<{ id: string; state: string }> };
const principlesDoc = read("docs/design/success-principles-v1.md");
const processDoc = read("docs/design/quality-first-process.md");

/** The 20 cases the owner recorded as viewed (Issue #193 comment 6584049255). */
const VIEWED = ["CP-001", "CP-002", "CP-008", "CP-009", "CP-012", "CP-016", "CP-017", "CP-018", "CP-019", "CP-020", "CP-021", "CP-022", "CP-023", "CP-026", "CP-027", "CP-028", "CP-029", "CP-030", "CP-031", "CP-032"];

describe("success principles v1 (DEV-156, Issue #193)", () => {
  it("covers exactly the 20 viewed cases; the other 10 registered cases are listed as not viewed", () => {
    expect(doc.cases.map((c) => c.id)).toEqual(VIEWED);
    const all = new Set([...doc.cases.map((c) => c.id), ...doc.not_viewed]);
    expect(all.size).toBe(manifest.registered_case_count);
    expect([...all].sort()).toEqual(manifest.records.map((r) => r.id).sort());
  });

  it("does not overstate evidence: SHA matches only for CP-009 / CP-016, Claude's own viewing only where a preview is in the repository", () => {
    for (const c of doc.cases) for (const e of c.evidence) expect(Object.keys(doc.evidence_levels)).toContain(e);
    expect(doc.cases.filter((c) => c.evidence.includes("owner_terminal_sha_match")).map((c) => c.id)).toEqual(["CP-009", "CP-016"]);
    const claude = doc.cases.filter((c) => c.evidence.includes("claude_viewed_registered_preview")).map((c) => c.id);
    for (const id of claude) expect(inventory.cases.find((x) => x.id === id)?.state).toBe("preview_in_repo");
    for (const c of doc.cases) expect(c.evidence).toContain("chatgpt_viewed");
  });

  it("every principle, failure code and check is defined once and used", () => {
    const pIds = doc.principles.map((p) => p.id);
    const codes = doc.failure_codes.map((f) => f.code);
    const checks = doc.checklist.map((c) => c.id);
    for (const ids of [pIds, codes, checks]) expect(new Set(ids).size).toBe(ids.length);
    for (const c of doc.cases) {
      for (const p of c.principles) expect(pIds).toContain(p);
      for (const f of c.recorded_failures) expect(codes).toContain(f);
    }
    for (const f of doc.failure_codes) {
      expect(f.checks.length).toBeGreaterThan(0);
      for (const ch of f.checks) expect(checks).toContain(ch);
    }
    for (const ch of doc.checklist) {
      expect(ch.failure_codes.length).toBeGreaterThan(0);
      expect(ch.failure_codes).toEqual(doc.failure_codes.filter((f) => f.checks.includes(ch.id)).map((f) => f.code));
    }
  });

  it("the documents name every failure code, check and principle that the data defines", () => {
    for (const f of doc.failure_codes) expect(principlesDoc).toContain(`\`${f.code}\``);
    for (const ch of doc.checklist) expect(processDoc).toContain(`| ${ch.id} |`);
    for (const p of doc.principles) expect(principlesDoc).toContain(`### ${p.id} `);
  });

  it("the source counts in the principles document are the data's", () => {
    const count = (pred: (c: Case) => boolean) => doc.cases.filter(pred).length;
    const has = (s: string) => (c: Case) => c.sources.includes(s);
    const rows: Array<[string, number]> = [
      ["製法・行為", count((c) => c.sources.includes("process") || c.sources.includes("action"))],
      ["素材", count(has("material"))],
      ["空間", count(has("space"))],
      ["物", count(has("object"))],
      ["時間", count(has("time"))],
      ["物理", count(has("physics"))],
    ];
    for (const [label, n] of rows) expect(principlesDoc).toMatch(new RegExp(`\\| ${label} \\| ${n} \\|`));
  });

  it("SP principles come only from cases with a phone page (Web PoC)", () => {
    const p6 = doc.cases.filter((c) => c.principles.includes("P6"));
    expect(p6.length).toBeGreaterThan(0);
    for (const c of p6) expect(c.pc_sp).toBe("web_poc_pc_sp");
  });
});
