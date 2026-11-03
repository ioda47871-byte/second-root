import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { cssProblems, htmlSourceProblems } from "@/lib/design-agent/comp-impl/page";

// DEV-160 (Issue #193 comment 6596798696): what the three fictional shops lost between the comp and the strict-lane
// implementation, by source. The record is Claude's reading of its own renders; this test keeps it consistent with the
// comps' review records and with the implementation rules as they are now (a rule loss must still be refused by them).
const REPO = resolve(__dirname, "../../../..");
const POC = resolve(REPO, "design-library/research/quality-pipeline/poc");
const record = JSON.parse(readFileSync(resolve(POC, "loss-analysis.json"), "utf8"));
const PREFIX: Record<string, RegExp> = { comp_quality: /^COMP_[A-Z_]+$/, placeholder_photo: /^PLACEHOLDER_PHOTO$/, impl_rule_limit: /^IMPL_RULE_[A-Z0-9_]+$/, impl_mistake: /^IMPL_MISTAKE_[A-Z_]+$/ };
type Loss = { code: string; source: string; where: string[]; view: string; what: string };
type Shop = { shop: string; comp: string; verdict: string; motif: string; losses: Loss[] };
const shops: Shop[] = record.shops;

describe("DEV-160: the comp-to-implementation loss analysis", () => {
  it("covers the three fictional shops in different trades, each with its comp, review and both implementations", () => {
    expect(record.schema).toBe("comp_impl_loss_analysis_v0");
    expect(shops.map((s) => s.shop)).toEqual(["tsugute", "bicycle", "sento"]);
    for (const s of shops) {
      const comp = resolve(POC, s.shop, s.comp);
      for (const f of ["index.html", "style.css", "copy.json", "review.json"]) expect(existsSync(resolve(comp, f)), `${s.shop}/${f}`).toBe(true);
      expect(JSON.parse(readFileSync(resolve(comp, "review.json"), "utf8")).verdict, s.shop).toBe(s.verdict);
      expect(existsSync(resolve(POC, s.shop, "impl/README.md")), s.shop).toBe(true);
    }
  });

  it("gives every loss one known source, a code of that source's family, where it was seen and a view", () => {
    expect(Object.keys(record.views).sort()).toEqual(["both", "pc", "sp", "tablet"]);
    for (const s of shops)
      for (const l of s.losses) {
        expect(Object.keys(record.sources), `${s.shop} ${l.code}`).toContain(l.source);
        expect(l.code, `${s.shop} ${l.code}`).toMatch(PREFIX[l.source]!);
        expect(l.where.length).toBeGreaterThan(0);
        for (const w of l.where) expect(["comp", "a", "b"]).toContain(w);
        expect(Object.keys(record.views)).toContain(l.view);
        expect(l.what.trim().length).toBeGreaterThan(0);
        // a comp-quality loss is the comp's own; an implementation loss is never blamed on the comp
        if (l.source === "comp_quality") expect(l.where).toEqual(["comp"]);
        if (l.source.startsWith("impl_")) expect(l.where).not.toContain("comp");
      }
  });

  it("keeps the shops' verdicts honest: a shop shown to the owner carries no comp failure the review left open", () => {
    // show_owner is not success; it only may not hide an open failure code (comp_review_v1 SHOW_WITH_KNOWN_FAILURE)
    for (const s of shops) {
      const review = JSON.parse(readFileSync(resolve(POC, s.shop, s.comp, "review.json"), "utf8"));
      if (s.verdict === "show_owner") expect(review.failure_codes, s.shop).toEqual([]);
      else expect(review.failure_codes.length, s.shop).toBeGreaterThan(0);
    }
  });

  it("names, for every rule loss, a probe that the implementation rules still refuse (if the rules change, revisit the analysis)", () => {
    const used = new Set(shops.flatMap((s) => s.losses.filter((l) => l.source === "impl_rule_limit").map((l) => l.code)));
    expect([...used].sort()).toEqual(Object.keys(record.rule_probes).sort());
    for (const [code, probe] of Object.entries(record.rule_probes as Record<string, { css?: string[]; html?: string[] }>)) {
      for (const decl of probe.css ?? []) expect(cssProblems(`.x { ${decl}; }`), `${code}: ${decl}`).not.toEqual([]);
      for (const html of probe.html ?? []) expect(htmlSourceProblems(html), `${code}: ${html}`).not.toEqual([]);
    }
  });

  it("finds each mistake the strict lane could have avoided (they are the implementer's to fix, not the rules')", () => {
    // the fixes used in b are inside the rules; this pins that they were available
    for (const decl of ["aspect-ratio: 1.45", "border-left: 3px solid #b88a35", "text-wrap: balance", "grid-template-columns: 1fr auto 1fr"]) expect(cssProblems(`.x { ${decl}; }`), decl).toEqual([]);
    expect(htmlSourceProblems("<p>まわ<br>る</p>")).toEqual([]);
    // a word kept whole by nowrap / keep-all is not available, so a mid-word break is avoided by size and <br>
    for (const decl of ["white-space: nowrap", "word-break: keep-all"]) expect(cssProblems(`.x { ${decl}; }`), decl).not.toEqual([]);
    const mistakes = shops.flatMap((s) => s.losses.filter((l) => l.source === "impl_mistake"));
    expect(mistakes.length).toBeGreaterThan(0);
  });
});
