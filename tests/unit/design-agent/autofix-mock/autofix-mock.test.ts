import { describe, expect, it } from "vitest";
import { LIMITS } from "@/lib/design-agent/loop/controller";
import { applyPatch, candidatePatch, CAUSE_OF_CODE, isSelector, PATCH_PROPERTIES, unifiedDiff, VARIANTS, type Cause } from "@/lib/design-agent/autofix-mock/patches";
import { AUTOFIX_LIMITS, INSTANCE_CAP, PC_CHANGE_MAX, runAutofixMock, type AutofixPorts, type Measurement } from "@/lib/design-agent/autofix-mock/run";

// DEV-146 (Issue #177 D, MOCK ONLY): the limited autofix loop with fake ports (no browser), and its pure parts.

const HTML = "<!doctype html><html><body><h1>架空珈琲 灯</h1></body></html>";
const PNG = new Uint8Array([1, 2, 3]);
const Z = { text_nodes_with_problems: 0, tap_targets_below_recommended: 0, tap_targets_below_minimum: 0 };
const m = (sp: string[], targets: { code: string; selector: string }[] = [], o: Partial<Measurement> = {}): Measurement => ({ sp_findings: sp, sp_scroll_width: 390, instances: [], counts: Z, targets, pc_png: PNG, blocked: 0, ...o });
const T = (code: string, selector = "a.b") => ({ code, selector });

/** A fake page: each in-scope cause is resolved by the patch variants listed in `fixedBy` (cause → variants that work). */
function fake(start: string[], fixedBy: Partial<Record<Cause, number[]>> = {}, o: { identity?: AutofixPorts["identity"]; extra?: (css: string) => string[]; pc?: number } = {}) {
  const calls: string[] = [];
  const ports: AutofixPorts = {
    identity: async (h, css) => (calls.push(`identity:${h === HTML}`), o.identity ? o.identity(h, css) : "PASS_IDENTITY_ONLY"),
    measure: async (h, css) => {
      calls.push(`measure:${h === HTML}`);
      const resolved = (code: string) => {
        const cause = CAUSE_OF_CODE[code as keyof typeof CAUSE_OF_CODE];
        return !!cause && (fixedBy[cause] ?? []).some((v) => css.includes(`${cause} v${v} `));
      };
      const left = start.filter((c) => !resolved(c));
      return m([...left, ...(o.extra?.(css) ?? [])], left.filter((c) => c in CAUSE_OF_CODE).map((c) => T(c, `div.${c.toLowerCase().replace(/_/g, "-")}`)));
    },
    pcChange: () => o.pc ?? 0,
  };
  return { ports, calls };
}
const input = (css = "body{margin:0}\n") => ({ source: "implementation" as const, html: HTML, css, css_path: "style.css" });

describe("limits and scope", () => {
  it("uses the mock run controller's limits (DEV-129): 3 attempts, 2 per cause", () => {
    expect(AUTOFIX_LIMITS).toEqual({ attempts: LIMITS.implementationAttempts, fixesPerCause: LIMITS.fixesPerCause });
    expect(PC_CHANGE_MAX).toBeLessThanOrEqual(0.001);
  });

  it("acts only on measurable codes; overlap, cover, offscreen, fading, facts and the shop name are out of scope", () => {
    expect(Object.keys(CAUSE_OF_CODE).sort()).toEqual(["PAGE_HORIZONTAL_OVERFLOW", "SP_TAP_TARGET_BELOW_44", "SP_TAP_TARGET_TOO_SMALL", "SP_TEXT_CLIPPED", "SP_TEXT_TOO_SMALL"]);
  });

  it("every patch variant sets only sizes, wrapping and released heights (never colour, type face, visibility, content or position)", () => {
    for (const variants of Object.values(VARIANTS))
      for (const decls of variants)
        for (const d of decls) {
          const [prop] = d.split(":");
          expect(PATCH_PROPERTIES).toContain(prop!.trim());
          expect(d).not.toMatch(/!important|[{};]|url\(|content|display:\s*none|visibility|opacity|color|position|transform|font-family/);
        }
  });

  it("names only safe selectors (nothing that closes a rule, opens a comment or holds a string)", () => {
    for (const ok of ["a.b", "div.box", "#menu", "body > section:nth-of-type(2) > a", "nav > a.icon-link"]) expect(isSelector(ok), ok).toBe(true);
    for (const bad of ["a{}", "a,b", "a /* x */", 'a[href="x"]', "a } body { display:none", "", "A", "a:hover", "a\nb", "*"]) expect(isSelector(bad), bad).toBe(false);
    expect(candidatePatch("TAP_TARGET", ["a}b"], 1)).toBeNull();
    expect(candidatePatch("TAP_TARGET", [], 1)).toBeNull();
    expect(candidatePatch("TEXT_TOO_SMALL", ["p"], 2)).toBeNull();
  });
});

describe("patch and diff", () => {
  it("appends one SP-only rule and diffs it as added lines only", () => {
    const p = candidatePatch("TAP_TARGET", ["a.b", "a.b", "button.c"], 1)!;
    expect(p.selectors).toEqual(["a.b", "button.c"]);
    const before = "body{margin:0}\n.b{width:30px}\n";
    const after = applyPatch(before, p);
    expect(after.startsWith(before)).toBe(true);
    expect(after.slice(before.length)).toBe(
      "/* sr-autofix-mock DEV-146: TAP_TARGET v1 (SP only, proposal) */\n@media (max-width: 480px) {\n  a.b, button.c { min-width: 44px; min-height: 44px; box-sizing: border-box; }\n}\n",
    );
    expect(unifiedDiff("style.css", before, after)).toBe(
      [
        "--- a/style.css",
        "+++ b/style.css",
        "@@ -1,2 +1,6 @@",
        " body{margin:0}",
        " .b{width:30px}",
        "+/* sr-autofix-mock DEV-146: TAP_TARGET v1 (SP only, proposal) */",
        "+@media (max-width: 480px) {",
        "+  a.b, button.c { min-width: 44px; min-height: 44px; box-sizing: border-box; }",
        "+}",
        "",
      ].join("\n"),
    );
    expect(unifiedDiff("style.css", before, before)).toBe("");
  });

  it("marks a last line without a newline, and keeps 3 lines of context", () => {
    const p = candidatePatch("TEXT_TOO_SMALL", ["p"], 1)!;
    const d = unifiedDiff("style.css", "a{}", applyPatch("a{}", p));
    expect(d).toContain("@@ -1,1 +1,5 @@\n-a{}\n\\ No newline at end of file\n+a{}\n+/* sr-autofix-mock");
    const long = "1\n2\n3\n4\n5\n";
    expect(unifiedDiff("x.css", long, `${long}6\n`)).toBe("--- a/x.css\n+++ b/x.css\n@@ -3,3 +3,4 @@\n 3\n 4\n 5\n+6\n");
    expect(unifiedDiff("x.css", "", "a\n")).toBe("--- a/x.css\n+++ b/x.css\n@@ -0,0 +1,1 @@\n+a\n");
  });
});

describe("the loop (fake ports)", () => {
  it("nothing in scope: no change, no patch, one measure", async () => {
    const f = fake(["SP_TEXT_OVERLAP", "SP_TEXT_COVERED"]);
    const r = await runAutofixMock(input(), f.ports);
    expect(r).toMatchObject({ status: "no_change", code: null, owner_check: false, attempts: [], proposed_css: null, proposed_diff: "", applied: false, mock: true, design_approved: false });
    expect(f.calls).toEqual(["identity:true", "measure:true"]);
  });

  it("a fixable page ends at the owner's review with a proposal that is never applied", async () => {
    const f = fake(["SP_TEXT_CLIPPED", "SP_TAP_TARGET_BELOW_44", "SP_TEXT_OVERLAP"], { TEXT_CLIPPED: [1], TAP_TARGET: [1] });
    const r = await runAutofixMock(input(), f.ports);
    expect(r).toMatchObject({ status: "owner_review", owner_check: false, findings_before: ["SP_TAP_TARGET_BELOW_44", "SP_TEXT_CLIPPED", "SP_TEXT_OVERLAP"], findings_after: ["SP_TEXT_OVERLAP"], applied: false });
    expect(r.attempts.map((a) => [a.cause, a.kept])).toEqual([
      ["TAP_TARGET", true],
      ["TEXT_CLIPPED", true],
    ]);
    expect(r.proposed_css!.startsWith(input().css)).toBe(true);
    expect(r.proposed_diff).toContain("+@media (max-width: 480px) {");
    // every port got the original HTML
    expect(f.calls.every((c) => c.endsWith(":true"))).toBe(true);
  });

  it("caps the run at 3 attempts across causes, then stops for the owner and keeps the original", async () => {
    const f = fake(["PAGE_HORIZONTAL_OVERFLOW", "SP_TAP_TARGET_BELOW_44", "SP_TEXT_CLIPPED", "SP_TEXT_TOO_SMALL"], { HORIZONTAL_OVERFLOW: [1], TAP_TARGET: [1], TEXT_CLIPPED: [1], TEXT_TOO_SMALL: [1] });
    const r = await runAutofixMock(input(), f.ports);
    expect(r.attempts.map((a) => [a.cause, a.kept])).toEqual([
      ["HORIZONTAL_OVERFLOW", true],
      ["TAP_TARGET", true],
      ["TEXT_CLIPPED", true],
    ]);
    expect(r).toMatchObject({ status: "stopped", code: "RETRY_BUDGET_EXHAUSTED", owner_check: true, proposed_css: null, proposed_diff: "" });
    expect(r.findings_after).toEqual(r.findings_before);
  });

  it("a cause no patch resolves: 2 tries, then SAME_CAUSE_FIX_LIMIT", async () => {
    const r = await runAutofixMock(input(), fake(["SP_TEXT_CLIPPED"]).ports);
    expect(r.attempts.map((a) => [a.variant, a.reverted_because])).toEqual([
      [1, "NOT_RESOLVED"],
      [2, "NOT_RESOLVED"],
    ]);
    expect(r).toMatchObject({ status: "stopped", code: "SAME_CAUSE_FIX_LIMIT" });
  });

  it("the second variant may resolve what the first did not", async () => {
    const r = await runAutofixMock(input(), fake(["SP_TAP_TARGET_TOO_SMALL"], { TAP_TARGET: [2] }).ports);
    expect(r.attempts.map((a) => [a.variant, a.kept])).toEqual([
      [1, false],
      [2, true],
    ]);
    // the reverted first patch is not in the proposal
    expect(r.proposed_css).toContain("TAP_TARGET v2");
    expect(r.proposed_css).not.toContain("TAP_TARGET v1");
    expect(r.status).toBe("owner_review");
  });

  it("a cause with one variant stops with NO_FURTHER_PATCH", async () => {
    const r = await runAutofixMock(input(), fake(["SP_TEXT_TOO_SMALL"]).ports);
    expect(r).toMatchObject({ status: "stopped", code: "NO_FURTHER_PATCH" });
    expect(r.attempts).toHaveLength(1);
  });

  it("a new finding or a changed PC render reverts the patch", async () => {
    const neu = await runAutofixMock(input(), fake(["SP_TEXT_CLIPPED"], { TEXT_CLIPPED: [1, 2] }, { extra: (css) => (css.includes("TEXT_CLIPPED v") ? ["SP_TEXT_OVERLAP"] : []) }).ports);
    expect(neu.attempts.map((a) => [a.reverted_because, a.new_findings])).toEqual([
      ["NEW_FINDING", ["SP_TEXT_OVERLAP"]],
      ["NEW_FINDING", ["SP_TEXT_OVERLAP"]],
    ]);
    expect(neu.code).toBe("SAME_CAUSE_FIX_LIMIT");
    const pc = await runAutofixMock(input(), fake(["SP_TEXT_CLIPPED"], { TEXT_CLIPPED: [1, 2] }, { pc: 0.01 }).ports);
    expect(pc.attempts.map((a) => a.reverted_because)).toEqual(["PC_CHANGED", "PC_CHANGED"]);
  });

  it("a finding of the same cause in another form is not resolved (24 px → 44 px tap target)", async () => {
    const ports = fake(["SP_TAP_TARGET_TOO_SMALL"]).ports;
    const measure = ports.measure;
    ports.measure = async (h, css) => (css.includes("TAP_TARGET v") ? m(["SP_TAP_TARGET_BELOW_44"], [T("SP_TAP_TARGET_BELOW_44")]) : measure(h, css));
    const r = await runAutofixMock(input(), ports);
    expect(r.attempts.map((a) => [a.reverted_because, a.new_findings])).toEqual([
      ["NOT_RESOLVED", []],
      ["NOT_RESOLVED", []],
    ]);
  });

  it("a finding the locator cannot place stays a report-only finding", async () => {
    const ports = fake([]).ports;
    ports.measure = async () => m(["SP_TEXT_CLIPPED", "SP_TEXT_OFFSCREEN"]);
    const r = await runAutofixMock(input(), ports);
    expect(r).toMatchObject({ status: "no_change", attempts: [] });
    expect(r.events).toContain("skip:TEXT_CLIPPED:not_located");
  });

  it("derives the page-width finding from the SP scrollWidth", async () => {
    const ports = fake([]).ports;
    ports.measure = async () => m([], [T("PAGE_HORIZONTAL_OVERFLOW", "div.row")], { sp_scroll_width: 391 });
    const r = await runAutofixMock(input(), ports);
    expect(r.findings_before).toEqual(["PAGE_HORIZONTAL_OVERFLOW"]);
    expect(r.attempts[0]!.cause).toBe("HORIZONTAL_OVERFLOW");
  });
});

describe("stops (the original kept, nothing proposed)", () => {
  it.each([["REJECT"], ["HOLD"]])("identity %s at the start: no measure, no patch", async (v) => {
    const f = fake(["SP_TEXT_CLIPPED"], {}, { identity: async () => v as "REJECT" | "HOLD" });
    const r = await runAutofixMock(input(), f.ports);
    expect(r).toMatchObject({ status: "stopped", code: `IDENTITY_${v}`, owner_check: true, attempts: [], proposed_css: null });
    expect(f.calls).toEqual(["identity:true"]);
  });

  it("identity HOLD on a patched CSS: stop at once, before it is measured", async () => {
    const f = fake(["SP_TEXT_CLIPPED"], { TEXT_CLIPPED: [1] }, { identity: async (_h, css) => (css.includes("sr-autofix-mock") ? "HOLD" : "PASS_IDENTITY_ONLY") });
    const r = await runAutofixMock(input(), f.ports);
    expect(r).toMatchObject({ status: "stopped", code: "IDENTITY_HOLD", attempts: [], proposed_css: null });
    expect(f.calls).toEqual(["identity:true", "measure:true", "identity:true"]);
  });

  it("refuses anything but the implementation's CSS (a Codex prototype is never patched)", async () => {
    const f = fake(["SP_TEXT_CLIPPED"]);
    const r = await runAutofixMock({ ...input(), source: "codex_prototype" } as never, f.ports);
    expect(r).toMatchObject({ status: "stopped", code: "NOT_IMPLEMENTATION_CSS" });
    expect(f.calls).toEqual([]);
    const bad = await runAutofixMock({ ...input(), css_path: "../x\n" }, f.ports);
    expect(bad.code).toBe("INPUT_INVALID");
  });

  it("a blocked request, a check that could not run, a malformed answer or a port that throws stops the run", async () => {
    const cases: [Partial<AutofixPorts>, string][] = [
      [{ measure: async () => m([], [], { blocked: 1 }) }, "RENDER_BLOCKED_REQUEST"],
      [{ measure: async () => m(["SP_CHECK_FAILED"]) }, "SP_CHECK_UNAVAILABLE"],
      [{ measure: async () => m(["SP_CHECK_SCOPE_CONFLICT"]) }, "SP_CHECK_UNAVAILABLE"],
      [{ measure: async () => m(["bad code"]) }, "PORT_ANSWER_INVALID"],
      [{ measure: async () => m(["SP_TEXT_CLIPPED"], [T("SP_TEXT_CLIPPED", "div{} body")]) }, "PORT_ANSWER_INVALID"],
      [{ measure: async () => ({ ...m([]), pc_png: "x" }) as never }, "PORT_ANSWER_INVALID"],
      [{ identity: async () => "PASS" as never }, "PORT_ANSWER_INVALID"],
      [{ measure: async () => m(["SP_TEXT_CLIPPED"], [T("SP_TEXT_CLIPPED", "div.c")]), pcChange: () => Number.NaN }, "PORT_ANSWER_INVALID"],
      [
        {
          measure: async () => {
            throw new Error("boom");
          },
        },
        "PORT_THREW",
      ],
    ];
    for (const [over, code] of cases) {
      const r = await runAutofixMock(input(), { ...fake([]).ports, ...over });
      expect([r.status, r.code, r.owner_check, r.proposed_css], code).toEqual(["stopped", code, true, null]);
    }
  });
});

describe("nothing gets worse, per instance (review round 1, H1)", () => {
  // a code already on the page (a false positive, an out-of-scope finding) must not hide a new instance of it
  const page = (after: (css: string) => Partial<Measurement>) => {
    const ports: AutofixPorts = {
      identity: async () => "PASS_IDENTITY_ONLY",
      measure: async (_h, css) => {
        const patched = css.includes("@media");
        const base = m(patched ? ["SP_TEXT_CLIPPED"] : ["PAGE_HORIZONTAL_OVERFLOW", "SP_TEXT_CLIPPED"], patched ? [] : [T("PAGE_HORIZONTAL_OVERFLOW", "div.row")], {
          sp_scroll_width: patched ? 390 : 900,
          instances: [{ code: "SP_TEXT_CLIPPED", text: "架空の飾り文字" }],
          counts: { ...Z, text_nodes_with_problems: 1 },
        });
        return patched ? { ...base, ...after(css) } : base;
      },
      pcChange: () => 0,
    };
    return runAutofixMock(input(), ports);
  };

  it("a newly clipped text under a code that was already there is reverted, never proposed", async () => {
    const r = await page(() => ({
      instances: [
        { code: "SP_TEXT_CLIPPED", text: "架空の飾り文字" },
        { code: "SP_TEXT_CLIPPED", text: "8:00〜19:00 定休 水" },
      ],
      counts: { ...Z, text_nodes_with_problems: 2 },
    }));
    expect(r.attempts[0]).toMatchObject({ kept: false, reverted_because: "NEW_FINDING" });
    expect(r.attempts[0]!.new_findings).toEqual(["SP_TEXT_CLIPPED:8:00〜19:00 定休 水", "COUNT:text_nodes_with_problems"]);
    expect(r.proposed_css).toBeNull();
  });

  it("a rise in the text nodes with problems is a regression even with the same examples", async () => {
    const r = await page(() => ({ counts: { ...Z, text_nodes_with_problems: 2 } }));
    expect(r.attempts[0]).toMatchObject({ kept: false, reverted_because: "NEW_FINDING", new_findings: ["COUNT:text_nodes_with_problems"] });
  });

  it("a hidden fact is a new instance (the check does not count it among the text nodes with problems)", async () => {
    const r = await page(() => ({ sp_findings: ["SP_FACT_HIDDEN", "SP_TEXT_CLIPPED"], instances: [{ code: "SP_TEXT_CLIPPED", text: "架空の飾り文字" }, { code: "SP_FACT_HIDDEN", text: "架空の定休日" }] }));
    expect(r.attempts[0]!.new_findings).toEqual(["SP_FACT_HIDDEN", "SP_FACT_HIDDEN:架空の定休日"]);
    expect(r.attempts[0]!.kept).toBe(false);
  });

  it("smaller tap targets after a fix for another cause are a regression", async () => {
    const r = await page(() => ({ counts: { ...Z, text_nodes_with_problems: 1, tap_targets_below_recommended: 1 } }));
    expect(r.attempts[0]).toMatchObject({ kept: false, new_findings: ["COUNT:tap_targets_below_recommended"] });
  });

  it("the same instances and counts: the fix is kept for the owner", async () => {
    const r = await page(() => ({}));
    expect(r).toMatchObject({ status: "owner_review", applied: false });
    expect(r.attempts[0]).toMatchObject({ kept: true, new_findings: [] });
  });

  it("a list of examples at the check's cap may be cut off: the run stops, nothing proposed", async () => {
    const many = Array.from({ length: INSTANCE_CAP }, (_, i) => ({ code: "SP_TEXT_CLIPPED", text: `架空の文${i}` }));
    const r = await page(() => ({ instances: many }));
    expect(r).toMatchObject({ status: "stopped", code: "INSTANCES_TRUNCATED", proposed_css: null });
    expect(INSTANCE_CAP).toBe(10);
  });

  it("instances and counts must be well formed", async () => {
    for (const bad of [{ instances: undefined }, { instances: [{ code: "x", text: "a" }] }, { counts: { ...Z, text_nodes_with_problems: -1 } }, { counts: undefined }]) {
      const ports: AutofixPorts = { identity: async () => "PASS_IDENTITY_ONLY", measure: async () => ({ ...m([]), ...bad }) as Measurement, pcChange: () => 0 };
      expect((await runAutofixMock(input(), ports)).code).toBe("PORT_ANSWER_INVALID");
    }
  });
});
