import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EVAL_CRITERIA, EVAL_MIN_CRITERION, EVAL_PASS_TOTAL, EvaluationSchema } from "@/lib/design-agent/comp-impl/bundle";
import { IMAGE_FIRST_HARD_FAILS } from "@/lib/design-agent/image-first/record";
import { FAILURE_CAUSES, SUCCESS_PRINCIPLES } from "@/lib/design-agent/imagefirst-worker/audit-principles";
import { AUDIT_RUBRIC_VERSION, AUDIT_THRESHOLDS, buildViewportAuditRequest, CHECK_IDS, CHECKS, CRITERION_IDS, HARD_FAIL_IDS, HARD_FAILS, IMITATION_RULE, principlesFor, REASK_LINE, RUBRIC_SHA256 } from "@/lib/design-agent/imagefirst-worker/audit-rubric";
import { AuditRecord, deriveViewport, incoherence, overallVerdict, ViewportAnswer } from "@/lib/design-agent/imagefirst-worker/audit-schema";
import { asMaterial, buildUserMessage, CLAUDE_BLOCKED_ENV, CLAUDE_PRINT_ARGS, claudeEnvironment, extractJsonObject } from "@/lib/design-agent/imagefirst-worker/claude-cli";
import { DUMMY_RECORD } from "@/lib/design-agent/imagefirst-worker/review-poc";
import { AUDIT_LIMITS, AUDIT_TIER } from "@/lib/design-agent/imagefirst-worker/claude-audit";
import { answerTemplate, REPO } from "./claude-audit-support";

// Issue #302: the Claude CLI audit's rubric, schema and runner pinned to their sources, and the module boundaries that keep
// the audit advisory (it can never write a success case or an owner evaluation, never reach Codex, the cycle or the ledger).

const src = (rel: string) => readFileSync(join(REPO, rel), "utf8");
const code = (rel: string) => src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const imports = (rel: string) => [...src(rel).matchAll(/^import[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]!).sort();
const W = "lib/design-agent/imagefirst-worker";

describe("Issue #302: the rubric is the adopted one", () => {
  it("the 5 criteria, the thresholds and the hard fails are exactly the owner-adopted rubric's and IMAGE_FIRST's", () => {
    expect(CRITERION_IDS).toEqual([...EVAL_CRITERIA]);
    expect(AUDIT_THRESHOLDS.passTotal).toBe(EVAL_PASS_TOTAL);
    expect(AUDIT_THRESHOLDS.minCriterion).toBe(EVAL_MIN_CRITERION);
    expect(HARD_FAIL_IDS).toEqual([...IMAGE_FIRST_HARD_FAILS, ...Object.keys(EvaluationSchema.shape.hard_fails.shape)]);
    expect(CHECK_IDS).toEqual(["shop_worldview", "not_generic_template", "whole_page_composition", "viewport_distinct_readable", "shop_info_conveyed", "success_principles_applied"]);
  });

  it("owner comment 7053442141 (c): every success-example principle and do-not-copy line is verbatim from the source its provenance names", () => {
    expect(AUDIT_RUBRIC_VERSION).toBe("if-claude-audit-v2");
    expect(RUBRIC_SHA256).toMatch(/^[0-9a-f]{64}$/);
    // the examples used, with differing structures (two concept pictures, a PC page and its phone page)
    expect(SUCCESS_PRINCIPLES.map((p) => p.id)).toEqual(["CP-001-concept", "CP-002-concept", "CP-003-pc", "CP-003-sp"]);
    for (const p of SUCCESS_PRINCIPLES) {
      const pv = p.provenance;
      // the case record exists in the catalogue and is the registered example's own record
      expect(existsSync(join(REPO, pv.record)), pv.record).toBe(true);
      expect(pv.record.startsWith(`design-library/success-cases/${pv.example_id}-`), pv.record).toBe(true);
      expect(p.id.startsWith(`${pv.example_id}-`)).toBe(true);
      expect(p.principles.length).toBeGreaterThan(0);
      if (pv.source.endsWith(".read.json")) {
        // Claude's own viewing record of the registered preview (VISUAL_VERIFIED in the visual-read matrix)
        const r = JSON.parse(src(pv.source)) as { case_id: string; actually_viewed: boolean; asset: { path: string; sha256: string }; observation: { learn: string[]; do_not_copy: string[] } };
        expect(r.case_id).toBe(pv.example_id);
        expect(r.actually_viewed).toBe(true);
        expect(r.asset.sha256).toBe(pv.asset_sha256);
        expect(existsSync(join(REPO, r.asset.path)), r.asset.path).toBe(true);
        expect([...p.principles]).toEqual(r.observation.learn);
        expect([...p.do_not_copy]).toEqual(r.observation.do_not_copy);
        const matrix = (JSON.parse(src("design-library/research/quality-pipeline/visual-read-matrix.json")) as { cases: { id: string; modes: Record<string, string> }[] }).cases;
        const view = pv.source.split("/").pop()!.replace(".read.json", "");
        expect(matrix.find((c) => c.id === pv.example_id)?.modes[view]).toBe("VISUAL_VERIFIED");
      } else {
        // the owner-approved generation reference (text only: the request carries no reference image)
        expect(pv.source).toBe("design-library/phase2f/references/success-references-v1.json");
        const ref = (JSON.parse(src(pv.source)) as { refs: { id: string; case_id: string; learn: string; do_not_copy: string[]; webp_sha256: string }[] }).refs.find((r) => r.id === p.id)!;
        expect(ref.case_id).toBe(pv.example_id);
        expect(ref.webp_sha256).toBe(pv.asset_sha256);
        expect([...p.principles]).toEqual([ref.learn]);
        expect([...p.do_not_copy]).toEqual(ref.do_not_copy);
      }
    }
    // every viewport gets principles from three different examples (differing structures), never CP-003 alone
    for (const vp of ["desktop_1440", "mobile_390"] as const) expect(new Set(principlesFor(vp).map((p) => p.provenance.example_id)).size).toBe(3);
  });

  it("owner comment 7053442141 (c): every failure cause is verbatim from the principles synthesis, and its case record states the rejection", () => {
    const codes = (JSON.parse(src("design-library/research/quality-pipeline/principles-v1.json")) as { failure_codes: { pattern: string; evidence: string[]; evidence_kind: string }[] }).failure_codes;
    const said: Record<string, string> = { "CP-016": "同じような構成になってきた", "CP-023": "下部3枚の汎用写真カード", "CP-011": "ちょっとありきたりかな" };
    expect(FAILURE_CAUSES.map((f) => f.provenance.example_id)).toEqual(Object.keys(said));
    for (const f of FAILURE_CAUSES) {
      const c = codes.find((x) => x.pattern === f.pattern);
      expect(c, f.pattern).toBeDefined();
      expect(c!.evidence).toContain(f.evidence);
      expect(c!.evidence_kind).toBe("observed");
      expect(f.provenance.source).toBe("design-library/research/quality-pipeline/principles-v1.json");
      expect(f.evidence.startsWith(f.provenance.example_id)).toBe(true);
      expect(f.provenance.record.startsWith(`design-library/success-cases/${f.provenance.example_id}-`)).toBe(true);
      expect(src(f.provenance.record), f.provenance.record).toContain(said[f.provenance.example_id]!);
    }
  });

  it("owner comment 7053442141 (a, b): the request measures principles, not closeness, and says imitation is penalised", () => {
    const material = { facts: [{ key: "name", value: "架空の店" }], direction: { id: "d3", concept: "c", protect: ["p"] } };
    for (const viewport of ["desktop_1440", "mobile_390"] as const) {
      const t = buildViewportAuditRequest({ viewport, images: [], material });
      // no "close to CP-003" wording anywhere: closeness to an example is never a criterion
      expect(t).not.toMatch(/近さ|近いほど|に近いか|似ているか|success_example_distance|<success-example>|close to|closeness|similar to/i);
      expect(t).toContain("success_principles_applied");
      expect(t).toContain(IMITATION_RULE);
      expect(t).toContain("見た目が近いことは加点しません"); // PR #314 review L2: "no credit", not "not assessed"
      expect(t).not.toContain("評価しません");
      expect(t).toMatch(/デザイン・配色・割り付け・モチーフを写していれば減点/);
      // every example for the viewport and every failure cause is in the material, neutralised
      for (const p of principlesFor(viewport)) {
        expect(t).toContain(`<example id="${p.id}">`);
        for (const l of p.principles) expect(t).toContain(asMaterial(`principle: ${l}`));
        for (const d of p.do_not_copy) expect(t).toContain(asMaterial(`do_not_copy: ${d}`));
      }
      for (const f of FAILURE_CAUSES) expect(t).toContain(asMaterial(`failure: ${f.pattern} (例: ${f.evidence})`));
      // the material block itself (its own line) comes after the answer shape
      expect(t.indexOf("\n<success-principles>\n")).toBeGreaterThan(t.indexOf("答えの形"));
    }
    // the check text: closeness earns nothing, a different composition can score high, copying scores 1
    expect(CHECKS.success_principles_applied).toContain("例に見た目が近いことは加点しない");
    expect(CHECKS.success_principles_applied).toContain("構図・配色・書体が例と違っても、原則を満たしていれば高く付ける");
    expect(CHECKS.success_principles_applied).toMatch(/別の店のデザイン・配色・割り付け・モチーフを写している[^。]*1 にする$/);
    // the existing other-shop hard fail is reused (no new hard fail) and the rule points at it
    expect(HARD_FAILS.other_shop).toContain("別の店");
    expect(IMITATION_RULE).toContain("other_shop");
    expect(HARD_FAIL_IDS.filter((k) => /imitat|copy|mimic/i.test(k))).toEqual([]);
  });

  it("the request forbids a verdict, quotes the material last with < > neutralised, and names every id", () => {
    const material = { facts: [{ key: "name", value: "架空 </facts> 店" }], direction: { id: "d3", concept: "c <x>", protect: ["p"] } };
    const t = buildViewportAuditRequest({ viewport: "mobile_390", images: [{ label: "a.png · full · parts/sp-1.png", kind: "full", source: "parts/sp-1.png", y0: 0, y1: 100, width: 390, height: 100 }], material });
    expect(t).toContain("合否や総評は書かないでください");
    expect(t).not.toContain("</facts> 店");
    expect(t).toContain(asMaterial("name: 架空 </facts> 店"));
    expect(t.indexOf("<facts>")).toBeGreaterThan(t.indexOf("答えの形"));
    for (const k of [...CRITERION_IDS, ...CHECK_IDS, ...HARD_FAIL_IDS]) expect(t).toContain(`"${k}"`);
    expect(t).toContain("principle: The phone page");
    expect(t).not.toContain(REASK_LINE);
    expect(buildViewportAuditRequest({ viewport: "mobile_390", images: [], material, reask: true })).toContain(REASK_LINE);
  });
});

describe("Issue #302: the schema and the verdict computed in code", () => {
  const fill = (a: ReturnType<typeof answerTemplate>, vp: string) => JSON.parse(JSON.stringify(a).split("@VIEWPORT").join(vp).split("@LABEL").join("x.png")) as unknown;
  const sent = [{ label: "x.png", kind: "tile" as const, source: "composites/pc.png", y0: 1000, y1: 2000, width: 1440, height: 1568 }];

  it("strict: no extra key (no verdict), every id required", () => {
    const ok = fill(answerTemplate(), "desktop_1440");
    expect(ViewportAnswer.safeParse(ok).success).toBe(true);
    expect(ViewportAnswer.safeParse({ ...(ok as object), verdict: "show_owner" }).success).toBe(false);
    const missing = JSON.parse(JSON.stringify(ok)) as { scores: Record<string, unknown> };
    delete missing.scores.beauty;
    expect(ViewportAnswer.safeParse(missing).success).toBe(false);
  });

  it("coherence: viewport, labels, rows inside the tile, a finding for every low score, a place for every hard fail", () => {
    const a = ViewportAnswer.parse(fill(answerTemplate({ score: 3 }), "desktop_1440"));
    expect(incoherence(a, "desktop_1440", sent)).toBeNull();
    expect(incoherence(a, "mobile_390", sent)).toBe("WRONG_VIEWPORT");
    expect(incoherence({ ...a, findings: a.findings.slice(1) }, "desktop_1440", sent)).toBe("LOW_SCORE_WITHOUT_FINDING");
    const rows = (y0: number | null, y1: number | null) => ({ ...a, findings: a.findings.map((f) => ({ ...f, where: { ...f.where, y0, y1 } })) });
    expect(incoherence(rows(1200, 1300), "desktop_1440", sent)).toBeNull();
    expect(incoherence(rows(10, 1300), "desktop_1440", sent)).toBe("ROWS_OUT_OF_RANGE");
    expect(incoherence(rows(1500, 1400), "desktop_1440", sent)).toBe("ROWS_OUT_OF_RANGE");
    expect(incoherence(rows(1200, 2001), "desktop_1440", sent)).toBe("ROWS_OUT_OF_RANGE");
    const h = ViewportAnswer.parse(fill(answerTemplate({ hit: "hero_only" }), "desktop_1440"));
    expect(incoherence({ ...h, hard_fails: { ...h.hard_fails, hero_only: { hit: true, where: null, note: "" } } }, "desktop_1440", sent)).toBe("HARD_FAIL_WITHOUT_PLACE");
  });

  it("deriveViewport: 22/25 with every criterion and check ≥ 4 → show_owner; one 3 → revise; any hard fail → drop", () => {
    const a = ViewportAnswer.parse(fill(answerTemplate({ score: 5 }), "desktop_1440"));
    expect(deriveViewport(a)).toMatchObject({ total: 25, verdict: "show_owner", hard_fail_hits: [] });
    const at = (scores: number[], check = 5) => ({ ...a, scores: Object.fromEntries(CRITERION_IDS.map((k, i) => [k, { score: scores[i]!, reason: "r" }])) as typeof a.scores, checks: Object.fromEntries(CHECK_IDS.map((k) => [k, { score: check, reason: "r" }])) as typeof a.checks });
    expect(deriveViewport(at([5, 5, 4, 4, 4])).verdict).toBe("show_owner"); // 22
    expect(deriveViewport(at([5, 5, 5, 5, 3]))).toMatchObject({ total: 23, verdict: "revise", low_criteria: ["implementability"] });
    expect(deriveViewport(at([4, 4, 4, 4, 5])).verdict).toBe("revise"); // 21
    expect(deriveViewport(at([5, 5, 5, 5, 5], 3))).toMatchObject({ verdict: "revise", low_checks: [...CHECK_IDS] });
    const h = ViewportAnswer.parse(fill(answerTemplate({ hit: "other_shop" }), "desktop_1440"));
    expect(deriveViewport(h)).toMatchObject({ total: 25, verdict: "drop", hard_fail_hits: ["other_shop"] });
    expect(overallVerdict(["show_owner", "revise"])).toBe("revise");
    expect(overallVerdict(["revise", "drop"])).toBe("drop");
    expect(overallVerdict(["show_owner", "show_owner"])).toBe("show_owner");
  });

  it("owner comment 7053442141 (a): a composition unlike CP-003 that applies the principles well is not failed → show_owner", () => {
    // PR #314 review L4: fairness to a design unlike the examples comes from the request wording, which the test above checks
    // (no closeness wording; "a different composition can score high"). This test only shows the code side: the verdict reads the
    // scores and hard fails, never the reason text, and the answer has no similarity / closeness field at all to read.
    expect(Object.keys(ViewportAnswer.shape.checks.shape).filter((k) => /similar|close|distance|near/i.test(k))).toEqual([]);
    // a fake answer: high scores everywhere, the principles check 5 with a reason that names a composition unlike CP-003's
    const a = ViewportAnswer.parse(fill(answerTemplate({ score: 4 }), "desktop_1440"));
    const unlike = { ...a, scores: { ...a.scores, beauty: { score: 5, reason: "窯の炎の層で組んだ独自の構図" }, fit: { score: 5, reason: "この店だけ" } }, checks: { ...a.checks, success_principles_applied: { score: 5, reason: "CP-003 とは構図も配色も違うが、境をまたぐ大きな文字と節ごとの律動の原則を窯の層で満たす" } } };
    expect(deriveViewport(unlike)).toMatchObject({ total: 22, verdict: "show_owner", low_checks: [], hard_fail_hits: [] });
    // and both viewports so → the whole audit shows the owner
    const sp = ViewportAnswer.parse(fill({ ...JSON.parse(JSON.stringify(unlike)), viewport: "@VIEWPORT" } as ReturnType<typeof answerTemplate>, "mobile_390"));
    expect(overallVerdict([deriveViewport(unlike).verdict, deriveViewport(sp).verdict])).toBe("show_owner");
  });

  it("owner comment 7053442141 (b): an imitation the model scores as the rubric directs cannot reach show_owner, however high the other scores", () => {
    // PR #314 review L1: the code cannot detect copying. Spotting it is the advisory model's job (IMITATION_RULE); what the code
    // guarantees is that once the model scores it as directed (the check ≤ 3, or other_shop hit), no other score can outweigh it.
    const a = ViewportAnswer.parse(fill(answerTemplate({ score: 5 }), "desktop_1440"));
    // the check scores imitation 1 → revise, even at 25/25
    const copied = { ...a, checks: { ...a.checks, success_principles_applied: { score: 1, reason: "CP-003 の地図と配色を写している" } } };
    expect(deriveViewport(copied)).toMatchObject({ total: 25, verdict: "revise", low_checks: ["success_principles_applied"] });
    // any score of 3 or less on it blocks show_owner
    for (const score of [1, 2, 3]) expect(deriveViewport({ ...a, checks: { ...a.checks, success_principles_applied: { score, reason: "r" } } }).verdict).toBe("revise");
    // the page reads as the other shop's → the existing other_shop hard fail → drop, even with every score and check at 5
    const h = ViewportAnswer.parse(fill(answerTemplate({ hit: "other_shop" }), "desktop_1440"));
    expect(Object.values(h.checks).every((c) => c.score === 5)).toBe(true);
    expect(deriveViewport(h)).toMatchObject({ total: 25, verdict: "drop", hard_fail_hits: ["other_shop"] });
    expect(overallVerdict(["show_owner", deriveViewport(copied).verdict])).toBe("revise");
    expect(overallVerdict(["show_owner", deriveViewport(h).verdict])).toBe("drop");
  });

  it("the record is advisory only: confirmation, success case and owner-evaluation flags are fixed literals", () => {
    const rec = {
      schema: "imagefirst_claude_audit_v2", status: "stopped", stop_code: "CLAUDE_QUOTA",
      binding: { approval_id: "a", bundle_id: "a", bundle_sha256: "a".repeat(64), plan_id: "p", commit: "0".repeat(40), previews_index_sha256: "b".repeat(64), rubric_version: "v", rubric_sha256: "c".repeat(64), audit_tier: "jpeg-q85-444-v1", request_sha256: { desktop_1440: null, mobile_390: null }, images: [{ viewport: "desktop_1440", label: "l", preview_file: "composite-pc.png", preview_sha256: "d".repeat(64), preview_bytes: 2, audit_sha256: "f".repeat(64), audit_bytes: 1, media_type: "image/jpeg", opaque: true, kind: "full", source: "composites/pc.png", source_sha256: "e".repeat(64), y0: 0, y1: 1 }] },
      auditor: { via: "claude_cli_print_no_tools", cli_version: null, model_reported: null, started_at: "2026-11-20T00:00:00.000Z", finished_at: "2026-11-20T00:00:00.000Z", calls: 1, reasks: 0 },
      viewports: { desktop_1440: null, mobile_390: null },
      derived: { desktop_1440: null, mobile_390: null, verdict: null },
      advisory_only: true, human_confirmed: false, registers_success_case: false, not_owner_evaluation: true,
    };
    expect(AuditRecord.safeParse(rec).success).toBe(true);
    for (const [k, v] of [["advisory_only", false], ["human_confirmed", true], ["registers_success_case", true], ["not_owner_evaluation", false]] as const) expect(AuditRecord.safeParse({ ...rec, [k]: v }).success, k).toBe(false);
    expect(AuditRecord.safeParse({ ...rec, status: "completed" }).success).toBe(false); // completed needs both answers and a verdict
    expect(AuditRecord.safeParse({ ...rec, stop_code: null }).success).toBe(false);
  });
});

describe("Issue #302: the runner (copied from curiosity-media) keeps its guards", () => {
  it("no credential name reaches the child, the allowlist still applies, no model flag", () => {
    const env = claudeEnvironment({ PATH: "/bin", HOME: "/h", ANTHROPIC_API_KEY: "k", ANTHROPIC_X: "x", CLAUDE_CODE_OAUTH_TOKEN: "t", CLAUDE_CODE_OAUTH_SOMETHING: "s", CLAUDE_CONFIG_DIR: "/c", OPENAI_API_KEY: "o", GH_TOKEN: "g" });
    expect(Object.keys(env).filter((k) => /^(ANTHROPIC_|CLAUDE_|OPENAI_|GH_)/.test(k))).toEqual([]);
    expect(env.HOME).toBe("/h");
    expect(CLAUDE_BLOCKED_ENV).toEqual(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN"]);
    expect([...CLAUDE_PRINT_ARGS]).toEqual(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--setting-sources", ""]);
    expect(code(`${W}/claude-cli.ts`)).not.toMatch(/--model|--mcp-config|--allowed|--dangerously/);
    // no model is named or pinned anywhere in the audit code: no model-id-shaped literal (the record only keeps what the CLI reports)
    for (const m of ["claude-cli.ts", "claude-audit.ts", "audit-rubric.ts", "audit-schema.ts"]) expect(code(`${W}/${m}`), m).not.toMatch(/["'`]claude-[a-z]+-\d/);
  });

  it("one user message: a label before each image, the request last; JSON extraction prefers a fence", () => {
    const m = JSON.parse(buildUserMessage([{ label: "L1", bytes: Buffer.from("ab"), mediaType: "image/png" }], "T")) as { type: string; message: { role: string; content: { type: string; text?: string; source?: { data: string } }[] } };
    expect(m.type).toBe("user");
    expect(m.message.content.map((c) => c.type)).toEqual(["text", "image", "text"]);
    expect(m.message.content[0]!.text).toBe("[image] L1");
    expect(Buffer.from(m.message.content[1]!.source!.data, "base64").toString()).toBe("ab");
    expect(extractJsonObject('x {"a":1} ```json\n{"b":2}\n``` y')).toEqual({ b: 2 });
    expect(() => extractJsonObject("none")).toThrow("CLAUDE_NO_JSON");
  });
});

describe("Issue #302: module boundaries (the audit can never write a success case or an owner evaluation)", () => {
  it("imports are pinned", () => {
    expect(imports(`${W}/claude-cli.ts`)).toEqual(["../bounded-process", "../worker/env"]);
    expect(imports(`${W}/audit-rubric.ts`)).toEqual(["./audit-principles", "./claude-cli", "node:crypto"]);
    // the principles are data only: no import, no file, no process, no network (the paths in it are provenance, never opened)
    expect(imports(`${W}/audit-principles.ts`)).toEqual([]);
    expect(code(`${W}/audit-principles.ts`)).not.toMatch(/\bimport\b|require\(|\bfetch\(|readFile|process\.|child_process|spawn/);
    // PR #314 review M1: the principles' paths must not let the audit reach the success-example catalogue by data instead of text
    // (the guard below checks path TEXT only). The rubric never touches provenance; claude-audit.ts uses only provenance.source,
    // only as text inside the AUDIT.md line, never provenance.record, never in a file-system call or path join
    expect(code(`${W}/audit-rubric.ts`)).not.toMatch(/provenance/);
    for (const f of [`${W}/claude-cli.ts`, `${W}/audit-schema.ts`, "scripts/sales-design-worker/imagefirst-audit.ts"]) expect(code(f), f).not.toMatch(/provenance/);
    const auditCode = code(`${W}/claude-audit.ts`);
    expect(auditCode.match(/provenance\s*(\?\.|\.|\[)\s*\w*/g)).toEqual(["provenance.source"]);
    expect(auditCode.match(/provenance/g)).toHaveLength(1);
    const provLines = auditCode.split("\n").filter((l) => l.includes("provenance"));
    expect(provLines).toHaveLength(1);
    expect(provLines[0]!).toMatch(/^\s*L\.push\(`- success_principles_applied: /);
    expect(provLines[0]!).not.toMatch(/\b(readFile|writeFile|open|stat|lstat|readdir|mkdir|rm|rename|copyFile|access|realpath|createReadStream|createWriteStream)\s*\(/);
    // node:path's join / resolve / dirname are imported bare; the line's only `.join(", ")` is the array join of the label text
    expect(provLines[0]!).not.toMatch(/(?<![.\w])(join|resolve|dirname|basename|relative)\s*\(/);
    // PR #314 second review L1': the per-file pins above only cover named files. Repo-wide, only audit-rubric.ts may import
    // the principles (everyone else reaches them through the rubric), and no non-test source ever names provenance.record
    const tracked = spawnSync("git", ["ls-files", "-z", "--", "lib", "app", "scripts", "components"], { cwd: REPO, encoding: "utf8" });
    expect(tracked.status).toBe(0);
    const sources = tracked.stdout.split("\0").filter((f) => /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(f));
    expect(sources.length).toBeGreaterThan(50);
    const principlesImporters = sources.filter((f) => /["']\.{0,2}[\w./-]*audit-principles["']/.test(src(f)));
    expect(principlesImporters).toEqual([`${W}/audit-rubric.ts`]);
    const recordUsers = sources.filter((f) => /provenance\s*(\?\.|\.)\s*record\b|["']record["']\s*\]/.test(src(f)) && /provenance/.test(src(f)));
    expect(recordUsers).toEqual([]);
    expect(imports(`${W}/audit-schema.ts`)).toEqual(["./audit-rubric", "zod"]);
    // the gated structure modules are never reached (the path is assembled, so this test does not name it either)
    const gated = new RegExp(["struct", "ure/", "(descr", "iptor|measure|references|observe)"].join(""));
    for (const f of ["claude-cli.ts", "audit-rubric.ts", "audit-principles.ts", "audit-schema.ts", "claude-audit.ts"]) expect(src(`${W}/${f}`), f).not.toMatch(gated);
    expect(src("scripts/sales-design-worker/imagefirst-audit.ts")).not.toMatch(gated);
    // nor copied: none of the gated vocabulary's ids appears in the audit sources (PR #311 sixth review L1). The ids are read
    // as text from the gated file (path assembled, nothing imported), so a list copied into the audit fails here
    const vocab = src(["lib/design-agent/struct", "ure/descr", "iptor.ts"].join(""));
    const block = vocab.slice(vocab.indexOf("export const VOCABULARY"), vocab.indexOf("} as const;", vocab.indexOf("export const VOCABULARY")));
    const ids = [...new Set([...block.matchAll(/"([a-z]+(?:_[a-z]+)+)"/g)].map((m) => m[1]!))];
    expect(ids.length).toBeGreaterThan(10);
    for (const f of [`${W}/claude-cli.ts`, `${W}/audit-rubric.ts`, `${W}/audit-principles.ts`, `${W}/audit-schema.ts`, `${W}/claude-audit.ts`, "scripts/sales-design-worker/imagefirst-audit.ts"]) {
      const s = src(f);
      expect(ids.filter((id) => s.includes(id)), f).toEqual([]);
    }
    expect(imports(`${W}/claude-audit.ts`)).toEqual(["../image-first/prompt", "../worker/state", "./audit-rubric", "./audit-schema", "./bundle", "./claude-cli", "./preview", "node:crypto", "node:fs", "node:fs/promises", "node:path", "sharp"]);
    expect(imports("scripts/sales-design-worker/imagefirst-audit.ts")).toEqual(["../../lib/design-agent/imagefirst-worker/claude-audit", "../../lib/design-agent/imagefirst-worker/jail-state", "../../lib/design-agent/worker/env", "node:fs/promises", "node:os", "node:path"]);
  });

  it("no code path names success cases, references, owner gates, evaluations, Codex, the cycle, claims or the ledger", () => {
    for (const f of [`${W}/claude-cli.ts`, `${W}/audit-rubric.ts`, `${W}/audit-schema.ts`, `${W}/claude-audit.ts`, "scripts/sales-design-worker/imagefirst-audit.ts"]) {
      expect(code(f), f).not.toMatch(/success-cases|phase2f\/references|owner-gate|EvaluationSchema|comp-impl|intelligence\/|codex|runImagefirstCycle|claimApproval|\/cycle["']|ledger|claims|deliverReview|local-inbox|transport|packBundle|\bfetch\(|node:https?|child_process|spawn\(|execFile/i);
    }
    // the only process is the claude CLI, through runBounded in claude-cli.ts
    expect(code(`${W}/claude-audit.ts`)).not.toMatch(/runBounded|bounded-process/);
  });

  it("nothing starts the audit: no unit, timer, wrapper, worker or automatic start names it", () => {
    const hits = spawnSync("git", ["grep", "--untracked", "-lE", "(tsx|node|sh|ExecStart)\\b.*imagefirst-audit|runClaudeAudit\\(", "--", ".", ":!tests/**", ":!docs/**", ":!.ai/**"], { cwd: REPO, encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean).sort();
    expect(hits).toEqual(["lib/design-agent/imagefirst-worker/claude-audit.ts", "scripts/sales-design-worker/imagefirst-audit.ts"]);
  });

  it("PR #311 re-review L-a: the audit tier and the cap are pinned (changing the quality, sampling or fill fails here)", () => {
    expect(AUDIT_TIER).toEqual({ id: "jpeg-q85-444-v1", mediaType: "image/jpeg", quality: 85, chromaSubsampling: "4:4:4", background: "#ffffff" });
    expect(AUDIT_LIMITS).toEqual({ maxImages: 20, maxBytes: 18 * 1024 * 1024 });
  });

  it("PR #311 re-review L-c: the production CLI takes claude and systemctl from nowhere but its own constants", () => {
    const cli = code("scripts/sales-design-worker/imagefirst-audit.ts");
    expect(cli).not.toMatch(/SR_IMAGEFIRST_AUDIT|_CLAUDE_BIN|_SYSTEMCTL|TEST_MODE/);
    expect(cli.match(/auditCli\(process\.argv\.slice\(2\), \{[^}]*\}\)/g)).toEqual(['auditCli(process.argv.slice(2), { claudeBin: "claude", systemctl: SYSTEMCTL })']);
    // PR #311 third review L3: the whole file reads the environment only for XDG_STATE_HOME, plus the whole environment
    // handed to childEnvironment (the allowlist) and to runClaudeAudit (scrubbed by claude-cli.ts). These are TEXT checks: a hook
    // spelled `process.env.X`, `process[...]`, a process import or require fails, but indirect forms (e.g. Reflect.get on process,
    // a type cast, or a binary name held in a constant) are not seen; the runtime guard for the last is the stub PATH that
    // claude-audit.test.ts gives every CLI spawn (PR #311 fifth review N-1)
    expect(cli.match(/process\.env\b(\s*\.\s*\w+|\s*\[[^\]]*\])?/g)).toEqual(["process.env.XDG_STATE_HOME", "process.env", "process.env"]);
    expect(cli).toMatch(/childEnvironment\(process\.env\)/);
    expect(cli).toMatch(/env: process\.env, jailIdle/);
    expect(cli).not.toMatch(/\bprocess\.argv\b(?!\.slice\(2\), \{ claudeBin: "claude", systemctl: SYSTEMCTL \})/);
    // PR #311 fourth review L-1: no audit test names the bare `claude` as a binary to run (the core tests pass a fake's
    // absolute path; the CLI tests put logging stubs first on PATH for every spawn and assert they never ran)
    // (this file spawns only git; it names "claude" only inside the expectations above)
    for (const t of ["claude-audit.test.ts", "claude-audit-support.ts", "fixtures/audit-cli-entry.ts"]) {
      expect(code(`tests/unit/design-agent/imagefirst-worker/${t}`), t).not.toMatch(/claudeBin\s*:\s*["'`]claude["'`]|(spawn|spawnSync|execFile|execFileSync|runBounded)\s*\(\s*["'`]claude["'`]/);
    }
    // the test entry reads no environment at all; neither file reaches the environment any other way (PR #311 fourth review N-1)
    const entry = code("tests/unit/design-agent/imagefirst-worker/fixtures/audit-cli-entry.ts");
    expect(entry).not.toMatch(/process\.env/);
    for (const [name, src] of [["cli", cli], ["entry", entry]] as const) {
      expect(src, name).not.toMatch(/process\s*\[|process\s*\?\.|\{[^}]*\benv\b[^}]*\}\s*=\s*process\b|=\s*process\s*;|globalThis|from\s+["'](node:)?process["']|require\s*\(\s*["'](node:)?process["']\s*\)|import\s*\(\s*["'](node:)?process["']/);
    }
  });

  it("the dummy record matches the review PoC's", () => {
    expect(code(`${W}/claude-audit.ts`)).toContain(`plan_id: "${DUMMY_RECORD.plan_id}"`);
    expect(DUMMY_RECORD.commit).toBe("0".repeat(40));
  });
});
