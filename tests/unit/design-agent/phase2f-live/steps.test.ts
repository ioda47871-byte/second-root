import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexAbortedError, CodexError } from "@/lib/design-agent/codex";
import { buildDesignPrompt } from "@/lib/design-agent/phase2f/prompt";
import { runDesignCall } from "@/lib/design-agent/phase2f-live/design-call";
import { runImageCall, type ImageRequest, type ImageTool } from "@/lib/design-agent/phase2f-live/image-call";
import { openLedger } from "@/lib/design-agent/phase2f-live/ledger";
import { readStep, sha256 } from "@/lib/design-agent/phase2f-live/steps";
import { answer, BRIEF, colourPng, FACTS } from "../phase2f/fixtures";

// DEV-117: the steps after a design call, end to end with fake tools and fictional data only: pre-render → image
// request → per-image approval → image → packaging (records cross-checked) → comparison sheet. No Codex, no image tool.

const REPO = resolve(__dirname, "../../../..");
const STEPS = resolve(REPO, "scripts/design-artifact/phase2f-steps.ts");
const COMMIT = "c".repeat(40);
const META = { threadId: "00000000-0000-4000-8000-000000000000", cliVersion: "0.200.0", modelReported: "gpt-fictional-5", redactions: [] };
const clean = async () => ({ head: COMMIT, base: COMMIT, clean: true });
let n = 0;

function world() {
  const base = mkdtempSync(join(tmpdir(), "dev117-steps-"));
  const state = join(base, "state");
  const runs = join(base, "runs");
  mkdirSync(runs);
  const factsPath = join(base, "facts.json");
  writeFileSync(factsPath, JSON.stringify(FACTS));
  const briefPath = join(base, "brief.json");
  writeFileSync(briefPath, JSON.stringify(BRIEF));
  const ledger = openLedger(state);
  const cli = (args: string[]) => {
    const r = spawnSync(process.execPath, ["--import", "tsx", STEPS, ...args], { encoding: "utf8", env: { ...process.env, SR_PHASE2F_STATE: state } });
    return { status: r.status, out: JSON.parse(r.stdout || "{}") as Record<string, unknown>, stderr: r.stderr };
  };
  const design = async (route: "B_html_prototype" | "C_hybrid", ans: unknown, o: { meta?: typeof META; plan?: string; fail?: boolean } = {}) => {
    const built = buildDesignPrompt({ route, facts: FACTS as never, brief: BRIEF as never, maxAssets: 1 });
    const outDir = join(runs, `design-${++n}`);
    const r = await runDesignCall(
      { route, prompt: built.prompt, schema: {}, humanApprovalConfirmed: true, approvalId: `fictional-design-${n}`, planId: o.plan ?? "plan-fictional-1", retryOf: null, expected: { promptSha256: built.sha256, promptChars: built.chars, commit: COMMIT }, outDir },
      { ledger, commit: clean, codex: async () => (o.fail ? Promise.reject(new CodexError("CODEX_EXEC_FAILED", "x")) : { answer: ans, meta: o.meta ?? META }) },
    );
    return { outDir, r };
  };
  const prerender = (designDir: string, route = "C") => {
    const out = join(runs, `pre-${++n}`);
    const r = cli(["--prerender", "--route", route, "--design", designDir, "--facts", factsPath, "--out", out]);
    return { ...r, dir: out };
  };
  const image = async (request: ImageRequest, tool: ImageTool, o: { approvalId?: string; planId?: string; retryOf?: string } = {}) => {
    const outDir = join(runs, `image-${++n}`);
    const r = await runImageCall(
      { route: "C_hybrid", request, common: { humanApprovalConfirmed: true, approvalId: o.approvalId ?? `fictional-image-${n}`, planId: o.planId ?? request.design.plan_id, retryOf: o.retryOf ?? null, expected: { promptSha256: request.prompt_sha256, promptChars: request.prompt_chars, commit: COMMIT }, outDir } },
      { ledger, commit: clean, image: tool },
    );
    return { outDir, r };
  };
  const pkg = (route: string, extra: string[]) => {
    const id = ++n;
    const result = join(runs, `result-${id}.json`);
    const r = cli(["--package", "--route", route, "--facts", factsPath, "--artifact-id", `DA-20261029-pk${String(id).padStart(4, "0")}`, "--shop-id", "fictional-wagashi", "--shop-name", "架空菓庵", "--out", join(runs, `pkg-${id}`), "--result", result, ...extra]);
    return { ...r, result };
  };
  return { base, state, runs, ledger, factsPath, briefPath, cli, design, prerender, image, pkg };
}

const saved: ImageTool = async () => ({ png: colourPng(1024, 1024), width: 1024, height: 1024, outcome: "IMAGE_SAVED", stopCode: null, cliVersion: "0.163.0", model: "gpt-fictional-image", threadId: null });
const failed = (outcome: string, stopCode: string): ImageTool => async () => ({ png: null, width: null, height: null, outcome, stopCode, cliVersion: "0.163.0", model: null, threadId: null });
const readRequest = (dir: string, id = "A1") => JSON.parse(readFileSync(join(dir, `image-request-${id}.json`), "utf8")) as ImageRequest;

describe("route C end to end: design → pre-render → one approved image → package → sheet", () => {
  it("a normal run reaches render_pair_complete as route C; the owner sees everything one image approval is for", async () => {
    const w = world();
    const d = await w.design("C_hybrid", answer({ asset: "story" }));
    expect(d.r.status).toBe("succeeded");
    const pre = w.prerender(d.outDir);
    expect(pre.status, pre.stderr).toBe(0);
    expect(pre.out).toMatchObject({ status: "ready", route: "C_hybrid" });
    const req = readRequest(pre.dir);
    // the request names its design run and carries the final prompt with its SHA
    expect(req.design).toMatchObject({ approval_id: d.r.status === "succeeded" ? d.r.receipt.approval_id : "", commit: COMMIT, plan_id: "plan-fictional-1" });
    expect(sha256(Buffer.from(req.prompt, "utf8"))).toBe(req.prompt_sha256);
    expect(req.essential).toBe(false);
    expect((req.placement as { desktop_1440: { sections: string[] } }).desktop_1440.sections).toEqual(["story"]);
    const md = readFileSync(join(pre.dir, "prerender.md"), "utf8");
    for (const s of [req.design.run_id, req.prompt, req.prompt_sha256, COMMIT, "主役画像: いいえ", "初回 1/4", "画像の承認ID"]) expect(md).toContain(s);

    const img = await w.image(req, saved);
    expect(img.r.status).toBe("succeeded");
    const c = w.pkg("C", ["--brief", w.briefPath, "--design", d.outDir, "--image", img.outDir]);
    expect(c.status, JSON.stringify(c.out)).toBe(0);
    expect(c.out).toMatchObject({ status: "done", record: { route: "C_hybrid", verification_state: "render_pair_complete" } });
    expect((c.out.calls as { kind: string }[]).map((x) => x.kind)).toEqual(["design", "image"]);

    const b = await w.design("B_html_prototype", answer());
    const pb = w.pkg("B", ["--brief", w.briefPath, "--design", b.outDir]);
    expect(pb.out).toMatchObject({ status: "done", record: { route: "B_html_prototype", verification_state: "render_pair_complete" } });

    const sheet = w.cli(["--sheet", "--results", `${c.result},${pb.result}`, "--out", join(w.runs, "sheet")]);
    expect(sheet.status).toBe(0);
    const sheetMd = readFileSync(join(w.runs, "sheet", "sheet.md"), "utf8");
    for (const s of ["## C_hybrid", "## B_html_prototype", "ブラウザ描画（PC1440・SP390）", "（未記入）", "判定: pending"]) expect(sheetMd).toContain(s);
    const sheetJson = JSON.parse(readFileSync(join(w.runs, "sheet", "sheet.json"), "utf8")) as { entries: { calls: unknown[]; scores: Record<string, unknown> }[] };
    expect(sheetJson.entries[0]!.calls).toHaveLength(2);
    expect(Object.values(sheetJson.entries[0]!.scores).every((v) => v === null)).toBe(true);
  }, 120_000);

  it("an unknown model and CLI version do not stop a normal design (warnings only)", async () => {
    const w = world();
    const b = await w.design("B_html_prototype", answer(), { meta: { ...META, cliVersion: null as never, modelReported: null as never } });
    const pb = w.pkg("B", ["--brief", w.briefPath, "--design", b.outDir]);
    expect(pb.out).toMatchObject({ status: "done", record: { verification_state: "render_pair_complete" } });
    expect((pb.out.record as { warnings: string[] }).warnings).toEqual(expect.arrayContaining(["generation_model_unknown", "generation_tool_version_unknown"]));
  }, 60_000);

  it("expressive prototypes are not refused before the image (vertical text, overlap, SVG, clip-path)", async () => {
    const w = world();
    const css = "body{margin:0;background:#f4efe6;color:#222}header h1{writing-mode:vertical-rl}[data-section=hero]{clip-path:polygon(0 0,100% 0,100% 90%,0 100%);min-height:600px}[data-section=story]{margin-top:-80px;transform:rotate(-2deg)}section{min-height:300px}";
    const a = answer({ asset: "story", css });
    a.prototype.html = a.prototype.html.replace("</footer>", '</footer><svg width="40" height="40" aria-hidden="true"><circle cx="20" cy="20" r="18" fill="#6b2e2e"/></svg>');
    const d = await w.design("C_hybrid", a);
    expect(w.prerender(d.outDir).out).toMatchObject({ status: "ready" });
  }, 60_000);
});

describe("records must agree before anything is used", () => {
  it("an image request changed after the pre-render is refused before the approval is used", async () => {
    const w = world();
    const d = await w.design("C_hybrid", answer({ asset: "story" }));
    const req = readRequest(w.prerender(d.outDir).dir);
    let called = 0;
    const tool: ImageTool = async (o) => ((called += 1), saved(o));
    // the prompt changed but not its SHA
    expect((await w.image({ ...req, prompt: `${req.prompt} and a logo` }, tool)).r).toMatchObject({ status: "stopped", code: "IMAGE_REQUEST_INVALID", stage: "precheck" });
    // another design run (its record does not say this)
    expect((await w.image({ ...req, design: { ...req.design, run_id: "p2f-otherrun" } }, tool)).r).toMatchObject({ code: "RECORD_MISMATCH", stage: "precheck" });
    // another plan
    expect((await w.image({ ...req, design: { ...req.design, plan_id: "plan-other" } }, tool)).r).toMatchObject({ code: "RECORD_MISMATCH", stage: "precheck" });
    expect(called).toBe(0);
    expect((await w.ledger.calls("plan-fictional-1")).map((c) => c.receipt.kind)).toEqual(["design"]);
  }, 60_000);

  it("a design run whose output folder says succeeded but whose ledger says failed is never used", async () => {
    const w = world();
    const d = await w.design("C_hybrid", answer({ asset: "story" }), { fail: true });
    // someone rewrites the output folder: an answer and a "succeeded" call.json
    const call = JSON.parse(readFileSync(join(d.outDir, "call.json"), "utf8"));
    writeFileSync(join(d.outDir, "answer.json"), JSON.stringify(answer({ asset: "story" })));
    writeFileSync(join(d.outDir, "call.json"), JSON.stringify({ ...call, status: "succeeded", code: null }), { flag: "w" });
    expect(w.prerender(d.outDir).out).toMatchObject({ status: "stopped", code: "RECORD_MISMATCH" });
    await expect(readStep(d.outDir, w.ledger, { kind: "design", route: "C_hybrid" })).rejects.toMatchObject({ code: "RECORD_MISMATCH" });
    // and a step of another kind is not taken for this one
    const b = await w.design("B_html_prototype", answer());
    await expect(readStep(b.outDir, w.ledger, { kind: "design", route: "C_hybrid" })).rejects.toMatchObject({ code: "RECORD_WRONG_STEP" });
  }, 60_000);

  it("a complete, consistent output folder is still not used when the ledger says the call failed", async () => {
    const w = world();
    const d = await w.design("B_html_prototype", answer());
    const call = JSON.parse(readFileSync(join(d.outDir, "call.json"), "utf8")) as { receipt: { approval_id: string } };
    const result = join(w.state, "approvals", call.receipt.approval_id, "result.json");
    const recorded = JSON.parse(readFileSync(result, "utf8"));
    writeFileSync(result, JSON.stringify({ ...recorded, status: "failed", code: "CODEX_EXEC_FAILED" }));
    await expect(readStep(d.outDir, w.ledger, { kind: "design", route: "B_html_prototype" })).rejects.toMatchObject({ code: "RECORD_MISMATCH" });
    expect(w.pkg("B", ["--brief", w.briefPath, "--design", d.outDir]).out).toMatchObject({ status: "stopped", code: "RECORD_MISMATCH" });
  }, 60_000);

  it("a call without a result in the ledger (crashed) is never used", async () => {
    const w = world();
    const d = await w.design("B_html_prototype", answer());
    const call = JSON.parse(readFileSync(join(d.outDir, "call.json"), "utf8")) as { receipt: { approval_id: string } };
    spawnSync("rm", [join(w.state, "approvals", call.receipt.approval_id, "result.json")]);
    await expect(readStep(d.outDir, w.ledger, { kind: "design", route: "B_html_prototype" })).rejects.toMatchObject({ code: "RECORD_UNFINISHED" });
  });

  it("a picture made from another prompt than the one the checks rebuild is not packaged", async () => {
    const w = world();
    const d = await w.design("C_hybrid", answer({ asset: "story" }));
    const req = readRequest(w.prerender(d.outDir).dir);
    const other = `${req.prompt} (edited)`;
    const img = await w.image({ ...req, prompt: other, prompt_sha256: sha256(Buffer.from(other, "utf8")), prompt_chars: other.length }, saved);
    expect(img.r.status).toBe("succeeded");
    expect(w.pkg("C", ["--brief", w.briefPath, "--design", d.outDir, "--image", img.outDir]).out).toMatchObject({ status: "stopped", code: "RECORD_MISMATCH" });
  }, 60_000);

  it("a picture file swapped after the call is not packaged", async () => {
    const w = world();
    const d = await w.design("C_hybrid", answer({ asset: "story" }));
    const img = await w.image(readRequest(w.prerender(d.outDir).dir), saved);
    writeFileSync(join(img.outDir, "image.png"), colourPng(1024, 1000));
    expect(w.pkg("C", ["--brief", w.briefPath, "--design", d.outDir, "--image", img.outDir]).out).toMatchObject({ status: "stopped", code: "RECORD_MISMATCH" });
  }, 60_000);
});

describe("image failures follow the owner's rules (never rewritten as a success)", () => {
  it("a picture that is not essential and was not run, or failed: explicit fallback to B, the failure kept", async () => {
    const w = world();
    const d = await w.design("C_hybrid", answer({ asset: "story" }));
    const none = w.pkg("C", ["--brief", w.briefPath, "--design", d.outDir]);
    expect(none.out).toMatchObject({ status: "done", record: { route: "B_html_prototype" } });
    expect((none.out.record as { warnings: string[] }).warnings).toContain("fallback_from_c_hybrid:image_TOOL_NOT_CALLED");

    const req = readRequest(w.prerender(d.outDir).dir);
    const img = await w.image(req, failed("TOOL_FAILED", "CODEX_IMAGE_TOOL_FAILED"));
    expect(img.r).toMatchObject({ status: "stopped", stage: "call", code: "CODEX_IMAGE_TOOL_FAILED", outcome: "TOOL_FAILED" });
    expect(existsSync(join(img.outDir, "image.png"))).toBe(false);
    const fell = w.pkg("C", ["--brief", w.briefPath, "--design", d.outDir, "--image", img.outDir]);
    expect(fell.out).toMatchObject({ status: "done", record: { route: "B_html_prototype" } });
    expect((fell.out.record as { warnings: string[] }).warnings).toContain("fallback_from_c_hybrid:image_TOOL_FAILED");
  }, 120_000);

  it("an essential picture that failed stops for the owner; a policy refusal is never bypassed", async () => {
    const w = world();
    const hero = await w.design("C_hybrid", answer({ asset: "hero" }));
    const req = readRequest(w.prerender(hero.outDir).dir);
    expect(req.essential).toBe(true);
    expect(readFileSync(join(w.runs, readdirSync(w.runs).filter((f) => f.startsWith("pre-")).at(-1)!, "prerender.md"), "utf8")).toContain("主役画像: はい");
    const img = await w.image(req, failed("TOOL_FAILED", "CODEX_IMAGE_TOOL_FAILED"));
    expect(w.pkg("C", ["--brief", w.briefPath, "--design", hero.outDir, "--image", img.outDir]).out).toMatchObject({ status: "stopped", code: "IMAGE_ESSENTIAL_FAILED", ownerCheck: true });
    // the image call that ran must be given; an essential picture that was never run stops for the owner too
    expect(w.pkg("C", ["--brief", w.briefPath, "--design", hero.outDir]).out).toMatchObject({ status: "stopped", code: "IMAGE_RUN_NOT_GIVEN" });
    const hero2 = await w.design("C_hybrid", answer({ asset: "hero" }), { plan: "plan-fictional-3" });
    expect(w.pkg("C", ["--brief", w.briefPath, "--design", hero2.outDir]).out).toMatchObject({ status: "stopped", code: "IMAGE_ESSENTIAL_FAILED" });

    const story = await w.design("C_hybrid", answer({ asset: "story" }), { plan: "plan-fictional-2" });
    const policy = await w.image(readRequest(w.prerender(story.outDir).dir), failed("TOOL_FAILED_POLICY", "CODEX_IMAGE_TOOL_FAILED"));
    expect(w.pkg("C", ["--brief", w.briefPath, "--design", story.outDir, "--image", policy.outDir]).out).toMatchObject({ status: "stopped", code: "IMAGE_POLICY_REFUSAL", ownerCheck: true });
  }, 120_000);

  it("a tool result that claims a saved picture without one is a fault, never a success", async () => {
    const w = world();
    const d = await w.design("C_hybrid", answer({ asset: "story" }));
    const img = await w.image(readRequest(w.prerender(d.outDir).dir), async () => ({ png: null, width: null, height: null, outcome: "IMAGE_SAVED", stopCode: null, cliVersion: null, model: null, threadId: null }));
    expect(img.r).toMatchObject({ status: "stopped", code: "IMAGE_TOOL_RESULT_INVALID" });
  }, 60_000);
});

describe("each image is its own approval, inside the plan's limits", () => {
  it("an approval is never reused: not the design's, not an earlier image's, whatever the outcome", async () => {
    const w = world();
    const d = await w.design("C_hybrid", answer({ asset: "story" }));
    const req = readRequest(w.prerender(d.outDir).dir);
    expect((await w.image(req, saved, { approvalId: req.design.approval_id })).r).toMatchObject({ code: "APPROVAL_ALREADY_USED", stage: "precheck" });
    await w.image(req, failed("TOOL_FAILED", "CODEX_IMAGE_TOOL_FAILED"), { approvalId: "fictional-image-once" });
    expect((await w.image(req, saved, { approvalId: "fictional-image-once" })).r).toMatchObject({ code: "APPROVAL_ALREADY_USED" });
  }, 60_000);

  it("A, B, C design and C image are the 4 first calls of a plan; a fifth is refused before anything is used", async () => {
    const w = world();
    const c = await w.design("C_hybrid", answer({ asset: "story" }));
    await w.design("B_html_prototype", answer());
    const req = readRequest(w.prerender(c.outDir).dir);
    await w.image(req, saved);
    const a = await runImageCall(
      { route: "A_image", prompt: "concept", common: { humanApprovalConfirmed: true, approvalId: "fictional-concept-1", planId: "plan-fictional-1", retryOf: null, expected: { promptSha256: sha256(Buffer.from("concept")), promptChars: 7, commit: COMMIT }, outDir: join(w.runs, "concept-1") } },
      { ledger: w.ledger, commit: clean, image: saved },
    );
    expect(a.status).toBe("succeeded");
    let called = 0;
    const fifth = await w.image(req, async (o) => ((called += 1), saved(o)));
    expect(fifth.r).toMatchObject({ code: "RUN_LIMIT_FIRST_CALLS", stage: "precheck" });
    expect(called).toBe(0);

    // route A packages as a concept image, never a browser render
    const pa = w.pkg("A", ["--image", join(w.runs, "concept-1"), "--expected-prompt-sha256", sha256(Buffer.from("concept"))]);
    expect(pa.out).toMatchObject({ status: "done", record: { route: "A_image", implementation_handoff_allowed: false } });
  }, 120_000);
});

describe("Fresh Review 1 fixes", () => {
  it("an image call the ledger knows of must be given to the package: never packaged as 'not run'", async () => {
    const w = world();
    const d = await w.design("C_hybrid", answer({ asset: "story" }));
    await w.image(readRequest(w.prerender(d.outDir).dir), failed("TOOL_FAILED_POLICY", "CODEX_IMAGE_TOOL_FAILED"));
    expect(w.pkg("C", ["--brief", w.briefPath, "--design", d.outDir]).out).toMatchObject({ status: "stopped", code: "IMAGE_RUN_NOT_GIVEN" });
  }, 60_000);

  it("an image request for a design run that did not succeed, or under another plan, is refused before anything is used", async () => {
    const w = world();
    const d = await w.design("C_hybrid", answer({ asset: "story" }));
    const req = readRequest(w.prerender(d.outDir).dir);
    let called = 0;
    const tool: ImageTool = async (o) => ((called += 1), saved(o));
    expect((await w.image(req, tool, { planId: "plan-fictional-9" })).r).toMatchObject({ code: "IMAGE_REQUEST_OTHER_PLAN", stage: "precheck" });
    const bad = await w.design("C_hybrid", answer({ asset: "story" }), { fail: true });
    const call = JSON.parse(readFileSync(join(bad.outDir, "call.json"), "utf8")) as { receipt: { approval_id: string; run_id: string; prompt_sha256: string; commit: string } };
    const toFailed = { ...req, design: { ...req.design, dir: bad.outDir, approval_id: call.receipt.approval_id, run_id: call.receipt.run_id } };
    expect((await w.image(toFailed, tool)).r).toMatchObject({ code: "DESIGN_RUN_NOT_SUCCEEDED", stage: "precheck" });
    expect(called).toBe(0);
  }, 60_000);

  it("an aborted image is never a fallback: the package stops", async () => {
    const w = world();
    const d = await w.design("C_hybrid", answer({ asset: "story" }));
    const img = await w.image(readRequest(w.prerender(d.outDir).dir), async () => Promise.reject(new CodexAbortedError()));
    expect(img.r).toMatchObject({ status: "stopped", code: "CODEX_ABORTED", aborted: true });
    expect(w.pkg("C", ["--brief", w.briefPath, "--design", d.outDir, "--image", img.outDir]).out).toMatchObject({ status: "stopped", code: "CODEX_IMAGE_ABORTED" });
  }, 60_000);

  it("a failure without an image outcome: 'not called' only when it stopped before the tool; otherwise the run stops", async () => {
    const w = world();
    const d = await w.design("C_hybrid", answer({ asset: "story" }));
    const req = readRequest(w.prerender(d.outDir).dir);
    const signIn = await w.image(req, async () => Promise.reject(new CodexError("CODEX_NOT_SIGNED_IN", "x")));
    const fell = w.pkg("C", ["--brief", w.briefPath, "--design", d.outDir, "--image", signIn.outDir]);
    expect(fell.out).toMatchObject({ status: "done", record: { route: "B_html_prototype" } });
    const d2 = await w.design("C_hybrid", answer({ asset: "story" }), { plan: "plan-fictional-2" });
    const odd = await w.image(readRequest(w.prerender(d2.outDir).dir), async () => Promise.reject(new Error("boom")));
    expect(odd.r).toMatchObject({ code: "CODEX_UNEXPECTED" });
    expect(w.pkg("C", ["--brief", w.briefPath, "--design", d2.outDir, "--image", odd.outDir]).out).toMatchObject({ status: "stopped", code: "RUN_ASSET_PORT_FAILED" });
  }, 120_000);

  it("route A is packaged only for the approved concept prompt", async () => {
    const w = world();
    const prompt = "concept";
    const outDir = join(w.runs, "concept-a");
    await runImageCall(
      { route: "A_image", prompt, common: { humanApprovalConfirmed: true, approvalId: "fictional-concept-2", planId: "plan-fictional-1", retryOf: null, expected: { promptSha256: sha256(Buffer.from(prompt)), promptChars: prompt.length, commit: COMMIT }, outDir } },
      { ledger: w.ledger, commit: clean, image: saved },
    );
    expect(w.pkg("A", ["--image", outDir]).status).toBe(2);
    expect(w.pkg("A", ["--image", outDir, "--expected-prompt-sha256", "0".repeat(64)]).out).toMatchObject({ status: "stopped", code: "RECORD_PROMPT_MISMATCH" });
    expect(w.pkg("A", ["--image", outDir, "--expected-prompt-sha256", sha256(Buffer.from(prompt))]).out).toMatchObject({ status: "done", record: { route: "A_image" } });
  }, 60_000);
});

describe("Fresh Review 2 fixes", () => {
  it("a .env found after Codex ran: never 'not called' — the package stops", async () => {
    const w = world();
    const d = await w.design("C_hybrid", answer({ asset: "story" }));
    const img = await w.image(readRequest(w.prerender(d.outDir).dir), failed("not_applicable", "CODEX_RESULT_DISCARDED_DOTENV"));
    expect(img.r).toMatchObject({ code: "CODEX_RESULT_DISCARDED_DOTENV" });
    expect(w.pkg("C", ["--brief", w.briefPath, "--design", d.outDir, "--image", img.outDir]).out).toMatchObject({ status: "stopped", code: "RUN_ASSET_PORT_FAILED" });
  }, 60_000);

  it("a usage limit waits: never a fallback to B", async () => {
    const w = world();
    const d = await w.design("C_hybrid", answer({ asset: "story" }));
    const img = await w.image(readRequest(w.prerender(d.outDir).dir), failed("TOOL_NOT_CALLED", "CODEX_QUOTA"));
    expect(w.pkg("C", ["--brief", w.briefPath, "--design", d.outDir, "--image", img.outDir]).out).toMatchObject({ status: "stopped", code: "CODEX_QUOTA" });
  }, 60_000);

  it("a failed image whose retry succeeded: the successful call must be the one given", async () => {
    const w = world();
    const d = await w.design("C_hybrid", answer({ asset: "story" }));
    const req = readRequest(w.prerender(d.outDir).dir);
    const first = await w.image(req, failed("TOOL_FAILED", "CODEX_IMAGE_TOOL_FAILED"), { approvalId: "fictional-img-first" });
    const retry = await w.image(req, saved, { approvalId: "fictional-img-retry", retryOf: "fictional-img-first" });
    expect(retry.r).toMatchObject({ status: "succeeded", receipt: { slot: "retry-1" } });
    expect(w.pkg("C", ["--brief", w.briefPath, "--design", d.outDir, "--image", first.outDir]).out).toMatchObject({ status: "stopped", code: "IMAGE_SUCCEEDED_CALL_NOT_GIVEN" });
    expect(w.pkg("C", ["--brief", w.briefPath, "--design", d.outDir, "--image", retry.outDir]).out).toMatchObject({ status: "done", record: { route: "C_hybrid" } });
  }, 120_000);

  it("an image call for another picture (another prompt) does not block a design that had none", async () => {
    const w = world();
    const one = await w.design("C_hybrid", answer({ asset: "story" }));
    await w.image(readRequest(w.prerender(one.outDir).dir), failed("TOOL_FAILED", "CODEX_IMAGE_TOOL_FAILED"));
    const other = answer({ asset: "story" });
    other.prototype.html = other.prototype.html.replace("A wrapped dorayaki on rice paper, morning light", "Two wrapped sweets side by side in soft evening light");
    const two = await w.design("C_hybrid", other);
    expect(w.pkg("C", ["--brief", w.briefPath, "--design", two.outDir]).out).toMatchObject({ status: "done", record: { route: "B_html_prototype" } });
  }, 120_000);

  it("an image recorded under another plan than its design is not packaged", async () => {
    const w = world();
    const d = await w.design("C_hybrid", answer({ asset: "story" }));
    const img = await w.image(readRequest(w.prerender(d.outDir).dir), saved);
    const id = (img.r as { receipt: { approval_id: string } }).receipt.approval_id;
    for (const f of [join(img.outDir, "call.json"), join(w.state, "approvals", id, "receipt.json")]) {
      const j = JSON.parse(readFileSync(f, "utf8"));
      if (j.receipt) j.receipt.plan_id = "plan-elsewhere";
      else j.plan_id = "plan-elsewhere";
      writeFileSync(f, JSON.stringify(j));
    }
    expect(w.pkg("C", ["--brief", w.briefPath, "--design", d.outDir, "--image", img.outDir]).out).toMatchObject({ status: "stopped", code: "RECORD_MISMATCH" });
  }, 60_000);
});

