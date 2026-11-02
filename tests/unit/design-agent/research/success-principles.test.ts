import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// DEV-156 (Issue #193): the success principles from the 20 viewed cases, the failure codes and the checklist.
// The data is research; these tests only keep it honest: the cases are the ones the owner recorded as viewed, the
// evidence levels are not overstated, and every code and check is defined once and used.

const REPO = resolve(__dirname, "../../../..");
const read = (p: string) => readFileSync(resolve(REPO, p), "utf8");
type Case = { id: string; evidence: string[]; sources: string[]; principles: string[]; recorded_failures: string[]; pc_sp: string; picture_identity: string; note_kind: string; owner_decision_evidence_level?: string };
const doc = JSON.parse(read("design-library/research/quality-pipeline/principles-v1.json")) as {
  cases: Case[];
  not_viewed: string[];
  principles: Array<{ id: string }>;
  failure_codes: Array<{ code: string; checks: string[]; evidence: string[]; evidence_kind: string }>;
  checklist: Array<{ id: string; failure_codes: string[] }>;
  evidence_levels: Record<string, string>;
  picture_identity_levels: Record<string, string>;
};
const manifest = JSON.parse(read("design-library/success-cases/manifest.json")) as {
  registered_case_count: number;
  records: Array<{ id: string; owner_decision_evidence_level?: string; binary_original_verification?: string }>;
};
const failurePatterns = read(".claude/skills/second-root-design-director/references/failure-patterns.md");
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
  it("CP-026〜032 are candidate pictures with draft notes; only CP-009 / CP-016 have a matched picture identity", () => {
    for (const c of doc.cases) {
      expect(Object.keys(doc.picture_identity_levels)).toContain(c.picture_identity);
      const late = Number(c.id.slice(3)) >= 26;
      expect(c.note_kind).toBe(late ? "draft_needs_independent_review" : "adoption_record");
      if (late) {
        const rec = manifest.records.find((r) => r.id === c.id)!;
        expect(c.picture_identity).toBe("candidate_sha_unverified");
        expect(rec.binary_original_verification).toBe("original_unavailable");
        expect(c.owner_decision_evidence_level).toBe(rec.owner_decision_evidence_level);
      }
    }
    expect(doc.cases.filter((c) => c.picture_identity === "owner_terminal_sha_match").map((c) => c.id)).toEqual(["CP-009", "CP-016"]);
  });

  it("every principle rests on at least 2 viewed cases; the document cites not-viewed cases only with a label", () => {
    for (const p of doc.principles) expect(doc.cases.filter((c) => c.principles.includes(p.id)).length, p.id).toBeGreaterThanOrEqual(2);
    const section2 = principlesDoc.slice(principlesDoc.indexOf("## 2. "), principlesDoc.indexOf("## 3. "));
    for (const line of section2.split("\n"))
      for (const id of doc.not_viewed) if (line.includes(id)) expect(line, line).toMatch(/参考|未見/);
  });

  it("the document's checklist columns name the same failure codes as the data", () => {
    for (const ch of doc.checklist) {
      const row = processDoc.split("\n").find((l) => l.startsWith(`| ${ch.id} |`))!;
      const named = [...row.split("|").at(-2)!.matchAll(/`([A-Z_]+)`/g)].map((m) => m[1]);
      expect(named.sort(), ch.id).toEqual([...ch.failure_codes].sort());
    }
  });

  it("failure-code evidence is honest: derived and hypothesis codes are labelled, cited cases exist", () => {
    const known = new Set([...manifest.records.map((r) => r.id)]);
    for (const f of doc.failure_codes) {
      expect(["observed", "derived", "hypothesis"]).toContain(f.evidence_kind);
      const row = principlesDoc.split("\n").find((l) => l.startsWith(`| \`${f.code}\` |`))!;
      if (f.evidence_kind === "derived") expect(row).toContain("(導出)");
      if (f.evidence_kind === "hypothesis") expect(row).toContain("(仮説)");
      for (const e of f.evidence)
        for (const id of e.match(/CP-\d{3}|PT-\d{2}/g) ?? []) expect(known.has(id) || failurePatterns.includes(id), `${f.code}:${id}`).toBe(true);
    }
  });
  it("the principle text cites only cases the data tags with that principle (counterexamples and references aside)", () => {
    expect(doc.cases.filter((c) => c.principles.includes("P6")).map((c) => c.id)).toEqual(["CP-009", "CP-016", "CP-028"]);
    const section2 = principlesDoc.slice(principlesDoc.indexOf("## 2. "), principlesDoc.indexOf("## 3. "));
    for (const block of section2.split("\n### ").slice(1)) {
      const pid = block.slice(0, 2);
      for (const line of block.split("\n").slice(1)) {
        // only the part before a counterexample or reference marker; lines that discuss a case's history are skipped
        if (/何が変わった|記録ではない|JSON で/.test(line)) continue;
        const cited = line.split(/反例|参考/)[0]!;
        for (const m of cited.matchAll(/(?<!\d)0(\d\d)(?!\d)/g)) {
          const id = `CP-0${m[1]}`;
          if (pid === "P1" && id === "CP-008") continue; // named as the one case without P1
          expect(doc.cases.find((c) => c.id === id)?.principles, `${pid} cites ${id}: ${line}`).toContain(pid);
        }
      }
    }
  });

  it("neither document claims success-level quality", () => {
    for (const text of [principlesDoc, processDoc]) {
      expect(text).toMatch(/「成功例レベル」とは言わない|「成功例レベル」に達したとは言わない/);
      expect(text).not.toMatch(/成功例レベルに達した(?!とは言わない)|成功例レベルを達成/);
    }
  });
});
