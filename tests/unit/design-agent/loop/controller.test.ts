import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LIMITS, runLoop, type Ports } from "@/lib/design-agent/loop/controller";

// DEV-129 (Phase 2g, MOCK ONLY, Issue #159): the deterministic controller with mock ports. No Codex, no image tool,
// no paid API, no process.

const ok = <T>(value: T) => ({ ok: true as const, value });
const fail = (code: string, stopClass: "environment" | "output" | "safety" | "policy" | "unknown") => ({ ok: false as const, code, stopClass });

function mocks(o: Partial<Ports> & { diffs?: string[][] } = {}) {
  const calls: string[] = [];
  let n = 0;
  const ports: Ports = {
    approval: o.approval ?? (() => "approved"),
    design: (id) => (calls.push(`design:${id}`), o.design ? o.design(id) : ok({ design_id: "D1" })),
    package: o.package ?? (() => ok({ artifact_id: "DA-1", state: "render_pair_complete" })),
    identity: o.identity ?? (() => ok("PASS_IDENTITY_ONLY")),
    structure: o.structure ?? (() => ok([])),
    ownerSelection: o.ownerSelection ?? (() => "selected"),
    implement: (a, fix) => (calls.push(`implement:${fix ?? "first"}`), o.implement ? o.implement(a, fix) : ok({ build_id: `B${++n}` })),
    compare: (b) => (o.compare ? o.compare(b) : ok({ differences: o.diffs?.[Number(b.slice(1)) - 1] ?? [] })),
  };
  return { ports, calls };
}

describe("the mock run controller", () => {
  it("a clean run ends at the owner's review, never as a design approval", () => {
    const m = mocks();
    const r = runLoop("run-1", m.ports);
    expect(r).toMatchObject({ status: "owner_review", code: null, design_approved: false, implementation_attempts: 1 });
    expect(r.events).toEqual(["approval:design_call:approved", "design:ok:D1", "package:render_pair_complete", "identity:PASS_IDENTITY_ONLY", "structure:none", "owner_selection:selected", "compare:1:match", "end:owner_review"]);
  });

  it("no approval, no paid call: the run waits", () => {
    const m = mocks({ approval: () => "pending" });
    expect(runLoop("run-1", m.ports)).toMatchObject({ status: "awaiting_approval", code: "DESIGN_CALL_NOT_APPROVED" });
    expect(m.calls).toEqual([]);
  });

  it("a failed paid call is never retried; environment waits, anything else goes to the owner", () => {
    for (const [cls, ownerCheck] of [["environment", false], ["output", true], ["safety", true], ["unknown", true]] as const) {
      const m = mocks({ design: () => fail("CODEX_EXEC_FAILED", cls) });
      expect(runLoop("run-1", m.ports)).toMatchObject({ status: "stopped", code: "CODEX_EXEC_FAILED", owner_check: ownerCheck });
      expect(m.calls.filter((c) => c.startsWith("design"))).toHaveLength(1);
    }
  });

  it("a page that is not this shop, or an artifact that is not complete, stops for the owner before anything is implemented", () => {
    for (const v of ["REJECT", "HOLD"] as const) {
      const m = mocks({ identity: () => ok(v) });
      expect(runLoop("run-1", m.ports)).toMatchObject({ status: "stopped", code: `IDENTITY_${v}`, owner_check: true });
      expect(m.calls.some((c) => c.startsWith("implement"))).toBe(false);
    }
    const c = mocks({ package: () => ok({ artifact_id: "DA-1", state: "concept_only" }) });
    expect(runLoop("run-1", c.ports)).toMatchObject({ status: "stopped", code: "ARTIFACT_CONCEPT_ONLY" });
  });

  it("structure findings are shown, never a stop; nothing is implemented before the owner selects the design", () => {
    expect(runLoop("run-1", mocks({ structure: () => ok(["TOO_CLOSE_TO_REFERENCE"]) }).ports).events).toContain("structure:TOO_CLOSE_TO_REFERENCE");
    const p = mocks({ ownerSelection: () => "pending" });
    expect(runLoop("run-1", p.ports).status).toBe("awaiting_owner_selection");
    expect(p.calls.some((c) => c.startsWith("implement"))).toBe(false);
    expect(runLoop("run-1", mocks({ ownerSelection: () => "rejected" }).ports)).toMatchObject({ status: "stopped", code: "DESIGN_NOT_SELECTED" });
  });

  it("repairs one cause at a time, offline, within the budget", () => {
    const m = mocks({ diffs: [["HERO_TYPE_SCALE", "SP_ORDER"], ["SP_ORDER"], []] });
    const r = runLoop("run-1", m.ports);
    expect(r).toMatchObject({ status: "owner_review", implementation_attempts: 3 });
    expect(m.calls).toEqual(["design:run-1", "implement:first", "implement:HERO_TYPE_SCALE", "implement:SP_ORDER"]);
  });

  it("stops at 3 attempts, or when the same cause needs a third fix", () => {
    const budget = runLoop("run-1", mocks({ diffs: [["A"], ["B"], ["C"], []] }).ports);
    expect(budget).toMatchObject({ status: "stopped", code: "RETRY_BUDGET_EXHAUSTED", implementation_attempts: LIMITS.implementationAttempts });
    const same = runLoop("run-1", mocks({ diffs: [["A"], ["A"], ["A"]] }).ports);
    expect(same).toMatchObject({ status: "stopped", code: "SAME_CAUSE_FIX_LIMIT", implementation_attempts: 3 });
    expect(same.events.filter((e) => e.startsWith("fix:A"))).toEqual(["fix:A:1", "fix:A:2"]);
  });

  it("is deterministic: the same answers give the same events", () => {
    const run = () => runLoop("run-1", mocks({ diffs: [["B", "A"], []] }).ports).events;
    expect(run()).toEqual(run());
    expect(run()).toContain("fix:A:1");
  });
});

describe("review fixes (DEV-129 Fresh Review)", () => {
  it("H1: only an explicit selection starts implementation; any other answer stops for the owner", () => {
    for (const v of [undefined, "", "approved", "SELECTED"]) {
      const m = mocks({ ownerSelection: () => v as never });
      expect(runLoop("run-1", m.ports)).toMatchObject({ status: "stopped", code: "OWNER_SELECTION_INVALID", owner_check: true });
      expect(m.calls.some((c) => c.startsWith("implement"))).toBe(false);
    }
  });

  it("L1: a fix that would not be tried is never recorded", () => {
    const r = runLoop("run-1", mocks({ diffs: [["A"], ["B"], ["C"]] }).ports);
    expect(r.events.filter((e) => e.startsWith("fix:"))).toEqual(["fix:A:1", "fix:B:1"]);
    expect(r.code).toBe("RETRY_BUDGET_EXHAUSTED");
  });

  it("L3 / L4: invalid cause codes, malformed answers and throwing ports stop for the owner, with a record", () => {
    for (const d of [[""], ["X,Y"], ["lower"]]) expect(runLoop("run-1", mocks({ diffs: [d] }).ports)).toMatchObject({ status: "stopped", code: "PORT_ANSWER_INVALID", owner_check: true });
    expect(runLoop("run-1", mocks({ design: () => ({ ok: "no" }) as never }).ports)).toMatchObject({ code: "PORT_ANSWER_INVALID" });
    const t = runLoop("run-1", mocks({ compare: () => { throw new Error("boom"); } }).ports);
    expect(t).toMatchObject({ status: "stopped", code: "PORT_THREW", owner_check: true, design_approved: false });
    expect(t.events).toEqual(["end:stopped:PORT_THREW"]);
  });

  it("L5: a denied approval stops (not waiting); a policy stop goes to the owner; a failed implement or compare is not repaired", () => {
    const d = mocks({ approval: () => "denied" });
    expect(runLoop("run-1", d.ports)).toMatchObject({ status: "stopped", code: "DESIGN_CALL_DENIED" });
    expect(d.calls).toEqual([]);
    expect(runLoop("run-1", mocks({ design: () => fail("TOOL_FAILED_POLICY", "policy") }).ports)).toMatchObject({ status: "stopped", owner_check: true });
    const i = mocks({ implement: () => fail("BUILD_FAILED", "output") });
    expect(runLoop("run-1", i.ports)).toMatchObject({ status: "stopped", code: "BUILD_FAILED", implementation_attempts: 1 });
    expect(i.calls.filter((c) => c.startsWith("implement"))).toHaveLength(1);
    expect(runLoop("run-1", mocks({ compare: () => fail("RENDER_FAILED", "environment") }).ports)).toMatchObject({ status: "stopped", owner_check: false, implementation_attempts: 1 });
  });
});

describe("isolation (mock only)", () => {
  it("imports nothing and is imported by no code: real ports are a separate approval", () => {
    const repo = resolve(__dirname, "../../../..");
    const src = readFileSync(resolve(repo, "lib/design-agent/loop/controller.ts"), "utf8");
    // the directory holds this one file (M1), and it imports, re-exports and loads nothing
    expect(readdirSync(resolve(repo, "lib/design-agent/loop"))).toEqual(["controller.ts"]);
    expect(src).not.toMatch(/^\s*import\s|^\s*export\s[^\n]*\sfrom\s|\bimport\(/m);
    expect(src).not.toMatch(/require\(|\bfetch\(|process\.|child_process/);
    const g = spawnSync("git", ["grep", "--untracked", "-lE", "loop/controller|from [\"'`]\\./controller[\"'`]", "--", "lib", "app", "components", "scripts", "proxy.ts", "supabase", ":!lib/design-agent/loop/**"], { cwd: repo, encoding: "utf8" });
    expect([g.status, g.stdout.trim()]).toEqual([1, ""]);
  });
});
