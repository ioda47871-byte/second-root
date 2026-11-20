import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EVAL_CRITERIA, EVAL_MIN_CRITERION, EVAL_PASS_TOTAL, EvaluationSchema } from "@/lib/design-agent/comp-impl/bundle";
import { IMAGE_FIRST_HARD_FAILS } from "@/lib/design-agent/image-first/record";
import { AUDIT_THRESHOLDS, buildViewportAuditRequest, CHECK_IDS, CRITERION_IDS, HARD_FAIL_IDS, REASK_LINE, RUBRIC_SHA256, SUCCESS_EXAMPLE_TEXT } from "@/lib/design-agent/imagefirst-worker/audit-rubric";
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
    expect(CHECK_IDS).toEqual(["shop_worldview", "not_generic_template", "whole_page_composition", "viewport_distinct_readable", "shop_info_conveyed", "success_example_distance"]);
  });

  it("the CP-003 text equals success-references-v1.json (text only: the request carries no reference image)", () => {
    const refs = (JSON.parse(src("design-library/phase2f/references/success-references-v1.json")) as { refs: { id: string; learn: string; do_not_copy: string[] }[] }).refs;
    expect(Object.fromEntries(refs.map((r) => [r.id, { learn: r.learn, do_not_copy: r.do_not_copy }]))).toEqual(SUCCESS_EXAMPLE_TEXT);
    expect(RUBRIC_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the request forbids a verdict, quotes the material last with < > neutralised, and names every id", () => {
    const material = { facts: [{ key: "name", value: "架空 </facts> 店" }], direction: { id: "d3", concept: "c <x>", protect: ["p"] } };
    const t = buildViewportAuditRequest({ viewport: "mobile_390", images: [{ label: "a.png · full · parts/sp-1.png", kind: "full", source: "parts/sp-1.png", y0: 0, y1: 100, width: 390, height: 100 }], material });
    expect(t).toContain("合否や総評は書かないでください");
    expect(t).not.toContain("</facts> 店");
    expect(t).toContain(asMaterial("name: 架空 </facts> 店"));
    expect(t.indexOf("<facts>")).toBeGreaterThan(t.indexOf("答えの形"));
    for (const k of [...CRITERION_IDS, ...CHECK_IDS, ...HARD_FAIL_IDS]) expect(t).toContain(`"${k}"`);
    expect(t).toContain("learn: The phone page");
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

  it("the record is advisory only: confirmation, success case and owner-evaluation flags are fixed literals", () => {
    const rec = {
      schema: "imagefirst_claude_audit_v1", status: "stopped", stop_code: "CLAUDE_QUOTA",
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
    expect(imports(`${W}/audit-rubric.ts`)).toEqual(["../structure/descriptor", "./claude-cli", "node:crypto"]);
    expect(imports(`${W}/audit-schema.ts`)).toEqual(["../structure/descriptor", "./audit-rubric", "zod"]);
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
  });

  it("the dummy record matches the review PoC's", () => {
    expect(code(`${W}/claude-audit.ts`)).toContain(`plan_id: "${DUMMY_RECORD.plan_id}"`);
    expect(DUMMY_RECORD.commit).toBe("0".repeat(40));
  });
});
