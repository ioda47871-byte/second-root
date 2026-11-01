import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { intakeArtifact } from "@/lib/design-agent/artifact/intake";
import { FactsPack } from "@/lib/design-agent/artifact/schema";
import { LOCATE_SCRIPT } from "@/lib/design-agent/autofix-mock/locate";
import { runAutofixMock, type AutofixPorts, type Measurement, type Target } from "@/lib/design-agent/autofix-mock/run";
import { pixelDifference } from "@/lib/design-agent/compare/metrics";
import { auditPageText } from "@/lib/design-agent/identity/identity-lock";
import { compareImplementation } from "@/lib/design-agent/impl-lane/impl-compare";
import { prepareImplementationLane } from "@/lib/design-agent/impl-lane/handoff";
import { DesignBrief } from "@/lib/design-agent/phase2f/prompt";
import { renderPrototype } from "@/lib/design-agent/phase2f/render-prototype";
import { runPrototypeRoute, type DesignPort } from "@/lib/design-agent/phase2f/runner";
import { observeStructure } from "@/lib/design-agent/structure/observe";
import { ReferenceDescriptors } from "@/lib/design-agent/structure/references";
import { MOCK, MOCK_GENERATION, readRepo, REPO, STUDY, visibleText, type Page } from "../research/three-methods-mock";
import { buildReport, proposalRecheck, sha256, summariseAutofix, summariseCompare, summariseMobile, summariseStructure, type Identity, type IntegrationReport, type ReportInput, type Stop } from "./integration-check";

// DEV-147 (Issue #177 E, MOCK ONLY, offline, report-only): Phases A–D chained as one offline pipeline on the fictional
// shop of the three-method study (its saved MOCK fixtures, DEV-142), producing one integration_check_report_v0 per case.
// The design is the study's Route B prototype through the real Phase 2f runner with a fake DesignPort; the
// implementation is the study's separately written Claude fixture (and variants of it written here). Every check is an
// existing tool; nothing is wired into the runner, worker, loop or any lib code. No Codex, image generation, network,
// paid API or WSL. NOTHING HERE IS A PASS, AN ADOPTION OR EVIDENCE OF QUALITY: every report is run_kind "mock".

let browser: Browser;
let work: string;
let laneDir: string;
let laneHashesBefore: Record<string, string>;
let design: ReportInput["design"];
const keepOut = process.env.INTEGRATION_CHECK_OUT;

const factsPath = resolve(REPO, STUDY, "facts-pack.json");
const pack = FactsPack.parse(JSON.parse(readRepo(`${STUDY}/facts-pack.json`)));
const factValues = Object.freeze(pack.facts.map((f) => f.value));
const shopName = pack.facts.find((f) => f.key === "name")!.value;
const lockText = readRepo(`${STUDY}/identity-lock.json`);
const lock = JSON.parse(lockText);
const references = ReferenceDescriptors.parse(JSON.parse(readRepo("design-library/intelligence/v02/structure-descriptors-v0.json")));
const brief = DesignBrief.parse(JSON.parse(readRepo(`${MOCK}/runner-brief.json`)));
const answerFixture = JSON.parse(readRepo(`${MOCK}/visual-first/codex-answer.json`));
const SECTIONS: string[] = answerFixture.structure_spec.sections.map((s: { id: string }) => s.id);
const LINK = '<link rel="stylesheet" href="style.css">';
const shop = { shop_id: pack.shop_id, facts_pack_sha256: sha256(readFileSync(factsPath)), identity_lock_sha256: sha256(lockText) };
const IMPL = { html: readRepo(`${MOCK}/visual-first/claude-impl/index.html`), css: readRepo(`${MOCK}/visual-first/claude-impl/style.css`) };

/** Every file under a directory, by its SHA-256 (to show the chain leaves the lane byte for byte as it was). */
function hashTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = sha256(readFileSync(p));
    }
  };
  walk(dir);
  return out;
}

beforeAll(async () => {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  work = mkdtempSync(join(tmpdir(), "dev147-integration-"));
  // the design: the study's Route B prototype fixture, returned by a fake DesignPort, through the real Phase 2f runner
  const proto = { html: readRepo(`${MOCK}/visual-first/codex-prototype/index.html`), css: readRepo(`${MOCK}/visual-first/codex-prototype/style.css`) };
  const answer = { ...answerFixture, prototype: proto };
  let calls = 0;
  const designPort: DesignPort = async (req) => (calls++, { answer, generation: { ...MOCK_GENERATION, run_id: "mock_dev147_ic", prompt_sha256: req.promptSha256 } });
  const packageDir = join(work, "package");
  const r = await runPrototypeRoute({ route: "B_html_prototype", browser, facts: { path: factsPath, pack }, shop: { shop_id: pack.shop_id, display_name: shopName }, brief, artifactId: "DA-20261101-mockic", outDir: packageDir, designPort });
  if (r.status !== "done") throw new Error(`runner: ${r.status}`);
  const intake = await intakeArtifact({ packageDir, factsPath });
  laneDir = join(work, "lane");
  await prepareImplementationLane({ packageDir, factsPath, laneDir });
  laneHashesBefore = hashTree(laneDir);
  design = {
    artifact_id: "DA-20261101-mockic",
    verification_state: intake.verification_state,
    implementation_handoff_allowed: intake.implementation_handoff_allowed,
    artifact_json_sha256: laneHashesBefore["artifact.json"]!,
    lane_json_sha256: laneHashesBefore["lane.json"]!,
    design_calls: calls,
    mock_note: "MOCK: a fake DesignPort returned the study's saved fixture (visual-first/codex-answer.json + codex-prototype/); nothing was sent",
  };
}, 180_000);
afterAll(async () => {
  await browser?.close();
  if (work) rmSync(work, { recursive: true, force: true });
});

const worst = (a: Identity[]): Identity => (a.includes("REJECT") ? "REJECT" : a.includes("HOLD") ? "HOLD" : "PASS_IDENTITY_ONLY");
/** The study's identity check: the lock against the visible text at both widths (the existing auditPageText). */
async function identityOf(p: Page) {
  const pc = auditPageText(lock, await visibleText(browser, p, 1440)).status;
  const sp = auditPageText(lock, await visibleText(browser, p, 390)).status;
  return { status: worst([pc, sp]), desktop_1440: pc, mobile_390: sp };
}

/** Phase D's ports: the real ones (identity above, Phase 2f render + SP checks, the locator, compare/metrics' pixel share). */
function autofixPorts(seen: string[]): AutofixPorts {
  return {
    identity: async (h, css) => (seen.push(h), (await identityOf({ html: h, css, assets: new Map() })).status),
    measure: async (h, css): Promise<Measurement> => {
      seen.push(h);
      const r = await renderPrototype(browser, { html: h, css }, new Map(), SECTIONS, { facts: factValues, shopName });
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, javaScriptEnabled: false });
      try {
        const page = await ctx.newPage();
        await page.route("**/*", (route) => route.abort());
        await page.setContent(h.replace(LINK, `<style>${css}</style>`));
        const targets = (await page.evaluate(LOCATE_SCRIPT)) as Target[];
        const q = r.mobile_390.mobileQuality!;
        return { sp_findings: q.findings, sp_scroll_width: r.mobile_390.scrollWidth, instances: q.examples ?? [], counts: q.counts, targets, pc_png: r.desktop_1440.png, blocked: r.desktop_1440.blocked + r.mobile_390.blocked };
      } finally {
        await ctx.close();
      }
    },
    pcChange: (a, b) => pixelDifference(Buffer.from(a), Buffer.from(b), 900).full,
  };
}

const phaseA = async (p: Page) => summariseCompare(await compareImplementation(browser, laneDir, p));
const phaseB = async (p: Page) => summariseMobile(await renderPrototype(browser, p, p.assets, SECTIONS, { facts: factValues, shopName }));

/** The chain on one implementation: identity first, then A → B → C → D, then A and B on the proposal (in memory). */
async function chain(caseId: string, impl: { html: string; css: string }, note: string) {
  const p: Page = { html: impl.html, css: impl.css, assets: new Map() };
  const htmlCopy = Buffer.from(impl.html);
  const cssCopy = Buffer.from(impl.css);
  const identity = await identityOf(p);
  const stops: Stop[] = [];
  const notRun = (reason: string) => ({ status: "not_run" as const, reason });
  let phases: ReportInput["phases"];
  const seen: string[] = [];
  if (identity.status !== "PASS_IDENTITY_ONLY") {
    // identity REJECT / HOLD stops the chain at once: nothing is compared, checked, observed or patched
    stops.push({ code: `IDENTITY_${identity.status}`, stage: "implementation", reason: "MOCK: the implementation is not this shop's (Identity Lock); the chain stops for the owner, never repaired" });
    const why = `identity ${identity.status}: the chain stopped before this phase`;
    phases = { a_impl_compare: notRun(why), b_mobile_quality: notRun(why), c_structure: notRun(why), d_autofix: notRun(why), d_proposal_recheck: notRun(why) };
  } else {
    const a = await phaseA(p);
    const b = await phaseB(p);
    const c = summariseStructure(await observeStructure(browser, { html: p.html, css: p.css }, references));
    const fix = await runAutofixMock({ source: "implementation", html: p.html, css: p.css, css_path: "style.css" }, autofixPorts(seen));
    const d = summariseAutofix(fix);
    if (fix.status === "stopped") stops.push({ code: fix.code!, stage: "d_autofix", reason: "MOCK: the limited autofix stopped for the owner and kept the original CSS" });
    let recheck: ReportInput["phases"]["d_proposal_recheck"] = notRun(fix.status === "no_change" ? "no proposal: nothing in scope was located" : "no proposal: the autofix stopped");
    if (fix.status === "owner_review") {
      // the PROPOSED CSS, rendered in memory only: never written, never applied
      const proposed: Page = { html: p.html, css: fix.proposed_css!, assets: new Map() };
      recheck = proposalRecheck({ compareBefore: a, compareAfter: await phaseA(proposed), mobileBefore: b, mobileAfter: await phaseB(proposed) });
    }
    phases = { a_impl_compare: a, b_mobile_quality: b, c_structure: c, d_autofix: d, d_proposal_recheck: recheck };
  }
  const report = buildReport({ run_kind: "mock", case_id: caseId, shop, design, implementation: { html_sha256: sha256(impl.html), css_sha256: sha256(impl.css), note }, identity, phases, stops });
  // nothing in the chain changed the implementation's bytes, the facts or the lane
  expect(Buffer.from(impl.html).equals(htmlCopy) && Buffer.from(impl.css).equals(cssCopy)).toBe(true);
  for (const h of seen) expect(h).toBe(impl.html);
  expect(factValues).toEqual(pack.facts.map((f) => f.value));
  expect(hashTree(laneDir)).toEqual(laneHashesBefore);
  if (keepOut) {
    if (!existsSync(keepOut)) mkdirSync(keepOut, { recursive: true });
    writeFileSync(join(keepOut, `${caseId}.json`), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  }
  return report;
}

/** What every report says, whatever happened. */
function invariant(r: IntegrationReport) {
  expect(r).toMatchObject({ schema: "integration_check_report_v0", run_kind: "mock", scope: "offline_report_only", advisory: true, passing: false, design_approved: false, applied: false });
  expect(r.design).toMatchObject({ verification_state: "render_pair_complete", implementation_handoff_allowed: true, design_calls: 1 });
  const p = r.phases;
  if (p.a_impl_compare.status === "ran") expect(p.a_impl_compare.passing).toBe(false);
  if (p.d_autofix.status === "ran") expect(p.d_autofix).toMatchObject({ applied: false, mock: true, design_approved: false });
  expect(JSON.parse(JSON.stringify(r))).toEqual(r);
}

const variant = (html: (h: string) => string, cssExtra: string) => ({ html: html(IMPL.html), css: `${IMPL.css}${cssExtra}` });

const ran = <T extends { status: string }>(x: T | { status: "not_run"; reason: string }) => {
  expect(x.status).toBe("ran");
  return x as T;
};
type Phases = IntegrationReport["phases"];
const A = (r: IntegrationReport) => ran(r.phases.a_impl_compare) as Extract<Phases["a_impl_compare"], { status: "ran" }>;
const B = (r: IntegrationReport) => ran(r.phases.b_mobile_quality) as Extract<Phases["b_mobile_quality"], { status: "ran" }>;
const C = (r: IntegrationReport) => ran(r.phases.c_structure) as Extract<Phases["c_structure"], { status: "ran" }>;
const D = (r: IntegrationReport) => ran(r.phases.d_autofix) as Extract<Phases["d_autofix"], { status: "ran" }>;
const R = (r: IntegrationReport) => ran(r.phases.d_proposal_recheck) as Extract<Phases["d_proposal_recheck"], { status: "ran" }>;

/** Phases A–C ran on the implementation as given: compared against both originals, SP checked, structure observed (advisory). */
function phasesAtoC(r: IntegrationReport) {
  const a = A(r);
  expect(a.compare_status).toBe("compared");
  for (const v of ["desktop_1440", "mobile_390"] as const) expect(a.viewports[v]).toMatchObject({ design_state: "present", box_source: "measured_by_runner", implementation_state: "rendered", blocked_requests: 0 });
  expect(B(r)).toMatchObject({ blocked_requests: 0, advisory: true });
  const c = C(r);
  expect(c).toMatchObject({ observation_status: "observed", check_failed: null, advisory: true });
  // DEV-144: the 24 thin references are always undecided, kept apart from the candidate-side undecided ones
  for (const v of ["desktop_1440", "mobile_390"] as const) {
    expect(c.viewports![v].undecided_too_thin).toBe(24);
    expect(c.viewports![v].undecided).toBe(c.viewports![v].undecided_too_thin + c.viewports![v].undecided_candidate_side);
    expect(c.viewports![v].blocked_requests).toBe(0);
  }
}

/** The proposal re-run in memory: PC 1440 unchanged (the patch is SP-only), the SP checks no longer name what was fixed. */
function recheckOf(r: IntegrationReport) {
  const x = R(r);
  expect(x).toMatchObject({ in_memory_only: true, applied: false });
  expect(x.a_impl_compare.page.desktop_1440.after).toEqual(x.a_impl_compare.page.desktop_1440.before);
  expect(x.b_mobile_quality.before).toEqual(B(r).findings);
  expect(x.b_mobile_quality.after).toEqual(D(r).findings_after);
  expect(x.a_impl_compare.before).toEqual(A(r).differences);
  return x;
}

describe("integration check (MOCK): Phases A–D as one offline pipeline on a fictional shop, one combined report", () => {
  it("(a) clean: the study's implementation runs through every phase; Phase D finds nothing in scope and proposes nothing", async () => {
    const r = await chain("a-clean", IMPL, "MOCK: the study's separately written Claude implementation (visual-first/claude-impl)");
    invariant(r);
    expect(r.identity.status).toBe("PASS_IDENTITY_ONLY");
    phasesAtoC(r);
    expect(B(r)).toMatchObject({ findings: [], scroll_width: { desktop_1440: 1440, mobile_390: 390 } });
    expect(D(r)).toMatchObject({ autofix_status: "no_change", code: null, owner_check: false, attempts: [], proposed_css_sha256: null, proposed_diff: "" });
    expect(D(r).events).toEqual(["identity:PASS_IDENTITY_ONLY", "measure:0:none", "end:no_change"]);
    expect(r.phases.d_proposal_recheck).toEqual({ status: "not_run", reason: "no proposal: nothing in scope was located" });
    expect(r.stops).toEqual([]);
  }, 300_000);

  it("(b) an SP problem Phase D can fix (a tap target too small): owner_review, and A/B before and after on the proposal", async () => {
    const impl = variant((h) => h.replace('<span class="visit__v">052-000-0418</span>', '<a class="visit__v visit__tel" href="#tel">052-000-0418</a>'), "\n.visit__tel{display:inline-block;font-size:15px;line-height:1;color:inherit}\n");
    const r = await chain("b-tap-target", impl, "MOCK: the study's implementation with the phone number as a small link (written here)");
    invariant(r);
    phasesAtoC(r);
    expect(B(r).findings).toEqual(["SP_TAP_TARGET_TOO_SMALL"]);
    expect(D(r)).toMatchObject({ autofix_status: "owner_review", code: null, owner_check: false, findings_before: ["SP_TAP_TARGET_TOO_SMALL"], findings_after: [] });
    expect(D(r).attempts.map((a) => [a.cause, a.variant, a.kept, a.selectors, a.pc_change])).toEqual([["TAP_TARGET", 1, true, ["a.visit__v.visit__tel"], 0]]);
    expect(D(r).proposed_diff).toContain("+  a.visit__v.visit__tel { min-width: 44px; min-height: 44px; box-sizing: border-box; }");
    const x = recheckOf(r);
    expect(x.b_mobile_quality).toMatchObject({ removed: ["SP_TAP_TARGET_TOO_SMALL"], added: [] });
    expect(x.b_mobile_quality.counts.after).toMatchObject({ tap_targets: 1, tap_targets_below_recommended: 0, tap_targets_below_minimum: 0 });
    // the proposal is a record for the owner: never applied, the stored report keeps only its hash and diff
    expect(D(r).proposed_css_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.stops).toEqual([]);
  }, 300_000);

  it("(c) an identity REJECT (another shop's name in the footer) stops the chain before any phase; Phase D refuses it on its own too", async () => {
    const impl = variant((h) => h.replace("</footer>", " 架空菓庵</footer>"), "");
    const r = await chain("c-identity-reject", impl, "MOCK: the study's implementation with another fictional shop's name in the footer");
    invariant(r);
    expect(r.identity).toEqual({ status: "REJECT", desktop_1440: "REJECT", mobile_390: "REJECT" });
    expect(r.stops).toEqual([{ code: "IDENTITY_REJECT", stage: "implementation", reason: expect.stringContaining("never repaired") }]);
    for (const phase of Object.values(r.phases)) expect(phase).toEqual({ status: "not_run", reason: "identity REJECT: the chain stopped before this phase" });
    // Phase D's own first step is the same check: given the page anyway, it stops before any render or patch
    const seen: string[] = [];
    const fix = await runAutofixMock({ source: "implementation", html: impl.html, css: impl.css, css_path: "style.css" }, autofixPorts(seen));
    expect(fix).toMatchObject({ status: "stopped", code: "IDENTITY_REJECT", owner_check: true, attempts: [], proposed_css: null, applied: false });
    expect(seen).toEqual([impl.html]);
  }, 300_000);

  it("(d) a fix that would clip facts is reverted; only the variant that clips nothing is proposed, and A/B are re-run on it", async () => {
    const impl = variant((h) => h, "\n@media (max-width:600px){.visit__row{flex-direction:row;width:720px;overflow:hidden}.visit__k{flex:0 0 120px}.visit__v{flex:none;width:400px}}\n");
    const r = await chain("d-revert-clipping", impl, "MOCK: the study's implementation with its info rows wider than the phone (written here)");
    invariant(r);
    phasesAtoC(r);
    expect(B(r).findings).toEqual(["SP_TEXT_OFFSCREEN"]);
    expect(B(r).scroll_width.mobile_390).toBeGreaterThan(390);
    const d = D(r);
    expect(d.findings_before).toEqual(["PAGE_HORIZONTAL_OVERFLOW", "SP_TEXT_OFFSCREEN"]);
    // v1 (max-width) squeezes the rows under overflow:hidden and clips the hours, the address and the access: reverted
    expect(d.attempts.map((a) => [a.cause, a.variant, a.kept, a.reverted_because])).toEqual([
      ["HORIZONTAL_OVERFLOW", 1, false, "NEW_FINDING"],
      ["HORIZONTAL_OVERFLOW", 2, true, null],
    ]);
    const clipped = d.attempts[0]!.new_findings;
    for (const fact of ["hours", "address", "access"]) expect(clipped, fact).toContain(`SP_TEXT_CLIPPED:${pack.facts.find((f) => f.key === fact)!.value.slice(0, 40)}`);
    expect(d.attempts[1]!.new_findings).toEqual([]);
    expect(d).toMatchObject({ autofix_status: "owner_review", findings_after: [] });
    // the reverted v1 is not in the proposal
    expect(d.proposed_diff).toContain("HORIZONTAL_OVERFLOW v2");
    expect(d.proposed_diff).not.toContain("HORIZONTAL_OVERFLOW v1");
    const x = recheckOf(r);
    expect(x.b_mobile_quality).toMatchObject({ removed: ["SP_TEXT_OFFSCREEN"], added: [] });
    expect(x.b_mobile_quality.scroll_width.after.mobile_390).toBe(390);
  }, 300_000);

  it("(e) a fix that cannot win (sizes held with !important): both variants reverted, the run stops for the owner with no proposal", async () => {
    const impl = variant(
      (h) => h.replace('<span class="visit__v">052-000-0418</span>', '<a class="visit__v visit__tel" href="#tel">052-000-0418</a>'),
      "\n.visit__tel{display:inline-block;font-size:15px;line-height:1;color:inherit;height:20px !important;min-height:20px !important;max-height:20px !important}\n",
    );
    const r = await chain("e-stop-not-resolved", impl, "MOCK: the study's implementation with a small phone link held small by !important (written here)");
    invariant(r);
    phasesAtoC(r);
    expect(B(r).findings).toEqual(["SP_TAP_TARGET_TOO_SMALL"]);
    expect(D(r).attempts.map((a) => [a.variant, a.kept, a.reverted_because])).toEqual([
      [1, false, "NOT_RESOLVED"],
      [2, false, "NOT_RESOLVED"],
    ]);
    expect(D(r)).toMatchObject({ autofix_status: "stopped", code: "SAME_CAUSE_FIX_LIMIT", owner_check: true, proposed_css_sha256: null, proposed_diff: "", findings_after: ["SP_TAP_TARGET_TOO_SMALL"] });
    expect(r.phases.d_proposal_recheck).toEqual({ status: "not_run", reason: "no proposal: the autofix stopped" });
    expect(r.stops).toEqual([{ code: "SAME_CAUSE_FIX_LIMIT", stage: "d_autofix", reason: expect.stringContaining("kept the original CSS") }]);
  }, 300_000);

  it("(f) a DEV-140 known false positive (an unmarked decorative word): Phase B records it, Phase D leaves it alone", async () => {
    // the corpus's deco_type_not_marked, on this shop's hero: a big decorative word, positioned, not aria-hidden
    const impl = variant(
      (h) => h.replace('<span class="fire__arch"></span>', '<span class="fire__arch"></span><span class="fire__deco">KOMUGI</span>'),
      "\n.fire{position:relative;overflow:hidden}.fire__deco{position:absolute;top:40px;left:-20px;font-size:120px;line-height:1;color:#3a2a1e;z-index:0}.fire__copy{position:relative;z-index:1}\n",
    );
    const r = await chain("f-known-false-positive", impl, "MOCK: the study's implementation with an unmarked decorative word in the hero (DEV-140 deco_type_not_marked)");
    invariant(r);
    phasesAtoC(r);
    expect(B(r).findings).toEqual(["SP_TEXT_CLIPPED", "SP_TEXT_OFFSCREEN"]);
    expect(D(r)).toMatchObject({ autofix_status: "no_change", attempts: [], proposed_css_sha256: null });
    expect(D(r).events).toContain("skip:TEXT_CLIPPED:not_located");
    expect(r.stops).toEqual([]);
  }, 300_000);
});

describe("the combined report refuses what it must never say (pure)", () => {
  const notRun = { status: "not_run" as const, reason: "x" };
  const base = (): ReportInput => ({
    run_kind: "mock",
    case_id: "t",
    shop: { shop_id: "s", facts_pack_sha256: "0".repeat(64), identity_lock_sha256: "0".repeat(64) },
    design: { artifact_id: "DA-20261101-mockic", verification_state: "render_pair_complete", implementation_handoff_allowed: true, artifact_json_sha256: "0".repeat(64), lane_json_sha256: "0".repeat(64), design_calls: 1, mock_note: "MOCK" },
    implementation: { html_sha256: "0".repeat(64), css_sha256: "0".repeat(64), note: "MOCK" },
    identity: { status: "PASS_IDENTITY_ONLY", desktop_1440: "PASS_IDENTITY_ONLY", mobile_390: "PASS_IDENTITY_ONLY" },
    phases: { a_impl_compare: notRun, b_mobile_quality: notRun, c_structure: notRun, d_autofix: notRun, d_proposal_recheck: notRun },
    stops: [],
  });
  const autofix = (o: Record<string, unknown>) => ({ status: "ran", autofix_status: "owner_review", applied: false, design_approved: false, mock: true, ...o }) as unknown as ReportInput["phases"]["d_autofix"];

  it("is always mock, never passing, approved or applied", () => {
    expect(buildReport(base())).toMatchObject({ run_kind: "mock", passing: false, design_approved: false, applied: false, advisory: true });
    expect(() => buildReport({ ...base(), run_kind: "live" })).toThrow(/separate approval/);
  });

  it("refuses a phase that claims a pass, an applied fix or an approval", () => {
    const b = base();
    expect(() => buildReport({ ...b, phases: { ...b.phases, a_impl_compare: { status: "ran", passing: true } as unknown as ReportInput["phases"]["a_impl_compare"] } })).toThrow(/never pass/);
    for (const o of [{ applied: true }, { design_approved: true }, { mock: false }]) expect(() => buildReport({ ...b, phases: { ...b.phases, d_autofix: autofix(o) } })).toThrow(/never apply/);
  });

  it("refuses a recheck without an owner_review proposal", () => {
    const b = base();
    const recheck = { status: "ran" } as unknown as ReportInput["phases"]["d_proposal_recheck"];
    expect(() => buildReport({ ...b, phases: { ...b.phases, d_proposal_recheck: recheck } })).toThrow(/owner_review/);
    expect(() => buildReport({ ...b, phases: { ...b.phases, d_autofix: autofix({ autofix_status: "stopped" }), d_proposal_recheck: recheck } })).toThrow(/owner_review/);
  });

  it("an identity stop ends the chain: no phase after it, and the stop is recorded", () => {
    const b = { ...base(), identity: { status: "HOLD" as const, desktop_1440: "HOLD" as const, mobile_390: "PASS_IDENTITY_ONLY" as const } };
    expect(() => buildReport(b)).toThrow(/must be recorded/);
    const stops: Stop[] = [{ code: "IDENTITY_HOLD", stage: "implementation", reason: "x" }];
    expect(buildReport({ ...b, stops }).stops).toEqual(stops);
    expect(() => buildReport({ ...b, stops, phases: { ...b.phases, d_autofix: autofix({ autofix_status: "no_change" }) } })).toThrow(/no phase may run/);
  });
});
