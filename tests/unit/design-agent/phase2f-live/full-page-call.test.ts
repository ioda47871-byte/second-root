import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CodexAbortedError } from "@/lib/design-agent/codex";
import { assembleRecord, readImageFirstRun } from "@/lib/design-agent/image-first/builder";
import { encodePng, type RgbImage } from "@/lib/design-agent/image-first/pixels";
import { buildPromptPlan, loadPromptInputs, type PromptInputs, type PromptPlan } from "@/lib/design-agent/image-first/prompt";
import { CODEX_STOP_CODES } from "@/lib/design-agent/image-first/record";
import { validateImageFirst } from "@/lib/design-agent/image-first/validate";
import { runFullPageCall, type FullPageBatch, type FullPageBatchResult, type FullPageCallInput } from "@/lib/design-agent/phase2f-live/full-page-call";
import { openLedger } from "@/lib/design-agent/phase2f-live/ledger";
import type { CommitState } from "@/lib/design-agent/phase2f-live/steps";

// Issue #293 P3 (preparation): the gated IMAGE_FIRST real-call step. The batch is a stub (an injected function): nothing
// here calls Codex, a model, the image tool, the network or a process. The ledger lives in a temporary directory.

const temps: string[] = [];
const tmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const REPO = resolve(__dirname, "../../../..");
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const COMMIT = "c".repeat(40);
const THREAD = "0193a7c2-1111-4222-8333-944455556666";
const PACKET = Buffer.from("IMAGE_FIRST P3 approval packet (test only)\n");
const NOW = Date.parse("2026-11-20T10:00:00+09:00");

let cached: { plan: PromptPlan; inputs: PromptInputs } | null = null;
async function planD1() {
  cached ??= await (async () => {
    const inputs = await loadPromptInputs((p) => readFile(resolve(REPO, p)), "d1");
    return { plan: buildPromptPlan(inputs), inputs };
  })();
  return cached;
}

/** A synthetic picture (flat colours; PC: two columns of blocks, SP: one column of bars), never a real comp. */
function picture(kind: "pc" | "sp", seed: number): RgbImage {
  const width = 768;
  const height = 1152;
  const data = Buffer.alloc(width * height * 3);
  const base: [number, number, number] = kind === "pc" ? [20 + seed * 30, 40, 90] : [230, 200 - seed * 25, 150];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let c = base;
      if (kind === "pc" && x > width * 0.1 && x < width * 0.45 && Math.floor(y / 96) % 2 === 0) c = [240, 230, 210];
      if (kind === "pc" && x > width * 0.55 && x < width * 0.9 && Math.floor(y / 40) % 3 === 0) c = [250, 160, 60];
      if (kind === "sp" && x > width * 0.08 && x < width * (0.4 + (seed % 3) * 0.15) && Math.floor(y / 60) % 2 === 1) c = [30, 30, 30];
      data.set(c, (y * width + x) * 3);
    }
  return { width, height, data };
}

function okBatch(n = 6, over: Partial<FullPageBatchResult> = {}): FullPageBatchResult {
  const images = Array.from({ length: n }, (_, i) => {
    const img = picture(i < 2 ? "pc" : "sp", i);
    return { png: encodePng(img), width: img.width, height: img.height };
  });
  return { images, outcome: "IMAGE_SAVED", stopCode: null, imageCalls: n, imageFailed: 0, imageCallIds: images.map((_, i) => `ig_call_${i + 1}`), threadId: THREAD, cliVersion: "0.169.0", model: null, ...over };
}

function setup() {
  const state = tmp("sr-if-ledger-");
  const runs = tmp("sr-if-runs-");
  const calls: { prompt: string; maxImages: number }[] = [];
  const batchOf =
    (r: FullPageBatchResult | (() => Promise<FullPageBatchResult>)): FullPageBatch =>
    async (o) => {
      calls.push({ prompt: o.prompt, maxImages: o.maxImages });
      return typeof r === "function" ? r() : r;
    };
  return { state, runs, calls, batchOf, ledger: openLedger(state) };
}

async function input(s: ReturnType<typeof setup>, over: Partial<Omit<FullPageCallInput, "expected">> & { expected?: Partial<FullPageCallInput["expected"]> } = {}): Promise<FullPageCallInput> {
  const { plan, inputs } = await planD1();
  const { expected, ...rest } = over;
  return {
    plan,
    inputs,
    packetBytes: PACKET,
    humanApprovalConfirmed: true,
    approvalId: "test-imagefirst-d1-20261120-01",
    planId: "test-imagefirst-plan-01",
    approvalExpires: "2026-11-27",
    expected: { promptSha256: plan.batch.sha256, promptChars: plan.batch.chars, commit: COMMIT, planSha256: plan.plan_sha256, packetSha256: sha(PACKET), ...expected },
    outDir: join(s.runs, "run-1"),
    repoRoot: REPO,
    ...rest,
  };
}
const deps = (s: ReturnType<typeof setup>, batch: FullPageBatch, commit: CommitState = { head: COMMIT, base: COMMIT, clean: true }) => ({ ledger: s.ledger, batch, commit: async () => commit, preflight: async () => null, now: () => NOW });
const ledgerEntries = (s: ReturnType<typeof setup>) => (existsSync(join(s.state, "approvals")) ? readdirSync(join(s.state, "approvals")) : []);

describe("IMAGE_FIRST P3 real-call step: refused before the approval is used", () => {
  const cases: [string, (s: ReturnType<typeof setup>) => Promise<FullPageCallInput>, string, CommitState?][] = [
    ["the owner's flag is missing", (s) => input(s, { humanApprovalConfirmed: false }), "HUMAN_APPROVAL_REQUIRED"],
    ["the plan is not the approved one", (s) => input(s, { expected: { planSha256: "0".repeat(64) } }), "PLAN_PIN_MISMATCH"],
    ["the packet's bytes are not the approved ones", (s) => input(s, { packetBytes: Buffer.from("other packet") }), "PACKET_PIN_MISMATCH"],
    ["the packet is unreadable / untracked", (s) => input(s, { packetBytes: null }), "PACKET_PIN_MISMATCH"],
    ["the batch prompt SHA is not the approved one", (s) => input(s, { expected: { promptSha256: "0".repeat(64) } }), "PROMPT_PIN_MISMATCH"],
    ["the batch prompt length is not the approved one", async (s) => input(s, { expected: { promptChars: (await planD1()).plan.batch.chars + 1 } }), "PROMPT_PIN_MISMATCH"],
    ["the commit is not the approved one", (s) => input(s, { expected: { commit: "d".repeat(40) } }), "COMMIT_PIN_MISMATCH"],
    ["the tree is not clean", (s) => input(s), "COMMIT_PIN_MISMATCH", { head: COMMIT, base: COMMIT, clean: false }],
    ["the approval names the other direction", (s) => input(s, { approvalId: "test-imagefirst-d3-20261120-01" }), "APPROVAL_ID_DIRECTION_MISMATCH"],
    ["the approval id is not in the IMAGE_FIRST format", (s) => input(s, { approvalId: "phase2f-image-20261120-01" }), "APPROVAL_ID_DIRECTION_MISMATCH"],
    ["the approval is past its expiry", (s) => input(s, { approvalExpires: "2026-11-19" }), "APPROVAL_EXPIRED"],
    ["the expiry is not a date", (s) => input(s, { approvalExpires: "next week" }), "APPROVAL_EXPIRED"],
    ["the run directory is inside the repository", async (s) => input(s, { outDir: join(REPO, "tmp-if-run-never-created") }), "RUN_DIR_IN_REPO"],
    [
      "the run directory is inside the (given) repository root",
      async (s) => {
        const repo = tmp("sr-if-fake-repo-");
        mkdirSync(join(repo, "runs"));
        return input(s, { repoRoot: repo, outDir: join(repo, "runs", "x") });
      },
      "RUN_DIR_IN_REPO",
    ],
    [
      "the run directory already exists",
      async (s) => {
        mkdirSync(join(s.runs, "run-1"));
        return input(s);
      },
      "OUT_DIR_EXISTS",
    ],
    ["the run directory is relative", (s) => input(s, { outDir: "runs/x" }), "OUT_DIR_INVALID"],
    ["the plan id is malformed", (s) => input(s, { planId: "X" }), "PLAN_ID_INVALID"],
  ];

  it.each(cases.map(([name, make, code, commit]) => ({ name, make, code, commit })))("$name → $code; nothing is reserved, created or called", async ({ make, code, commit }) => {
    const s = setup();
    const i = await make(s);
    const r = await runFullPageCall(i, deps(s, s.batchOf(okBatch()), commit));
    expect(r).toEqual({ status: "stopped", code, stage: "precheck", aborted: false });
    expect(s.calls).toEqual([]);
    expect(ledgerEntries(s)).toEqual([]);
    expect(existsSync(join(s.runs, "run-1", "run-plan.json"))).toBe(false);
  });

  it("the preflight's stop refuses before the approval is used", async () => {
    const s = setup();
    const r = await runFullPageCall(await input(s), { ...deps(s, s.batchOf(okBatch())), preflight: async () => "CODEX_DOTENV_PRESENT" });
    expect(r).toMatchObject({ status: "stopped", code: "CODEX_DOTENV_PRESENT", stage: "precheck" });
    expect(s.calls).toEqual([]);
    expect(ledgerEntries(s)).toEqual([]);
  });

  it("a used approval is refused, and is never used twice", async () => {
    const s = setup();
    expect((await runFullPageCall(await input(s), deps(s, s.batchOf(okBatch())))).status).toBe("succeeded");
    const again = await runFullPageCall(await input(s, { outDir: join(s.runs, "run-2") }), deps(s, s.batchOf(okBatch())));
    expect(again).toMatchObject({ status: "stopped", code: "APPROVAL_ALREADY_USED", stage: "precheck" });
    expect(s.calls).toHaveLength(1);
  });
});

describe("IMAGE_FIRST P3 real-call step: the first failure ends the run (no retry, the approval stays used)", () => {
  it.each(CODEX_STOP_CODES.map((c) => [c]))("a batch stopped with %s writes no run plan and records the stop", async (code) => {
    const s = setup();
    const i = await input(s);
    const r = await runFullPageCall(i, deps(s, s.batchOf(okBatch(2, { stopCode: code, outcome: "TOOL_FAILED", imageFailed: 1, imageCalls: 3 }))));
    expect(r).toEqual({ status: "stopped", code, stage: "call", aborted: false, outcome: "TOOL_FAILED" });
    expect(s.calls).toHaveLength(1);
    expect(existsSync(join(i.outDir, "run-plan.json"))).toBe(false);
    expect(readdirSync(join(i.outDir, "parts"))).toEqual([]);
    expect(readdirSync(join(i.outDir, "stopped")).sort()).toEqual(["image-1.png", "image-2.png"]);
    const call = JSON.parse(readFileSync(join(i.outDir, "call.json"), "utf8")) as { status: string; code: string };
    expect([call.status, call.code]).toEqual(["failed", code]);
    expect(await s.ledger.get(i.approvalId)).toMatchObject({ receipt: { kind: "full_page_comp", route: "image_first", slot: "first-1" }, result: { status: "failed", code } });
    // the approval is used: the same id never runs again
    expect(await runFullPageCall(await input(s, { outDir: join(s.runs, "run-2") }), deps(s, s.batchOf(okBatch())))).toMatchObject({ code: "APPROVAL_ALREADY_USED" });
    expect(s.calls).toHaveLength(1);
  });

  it("fewer pictures than planned, with no stop code, is CODEX_IMAGE_COUNT_MISMATCH", async () => {
    const s = setup();
    const i = await input(s);
    expect(await runFullPageCall(i, deps(s, s.batchOf(okBatch(5))))).toMatchObject({ status: "stopped", code: "CODEX_IMAGE_COUNT_MISMATCH", stage: "call" });
    expect(existsSync(join(i.outDir, "run-plan.json"))).toBe(false);
  });

  it("an aborted call is recorded as aborted", async () => {
    const s = setup();
    const i = await input(s);
    const r = await runFullPageCall(
      i,
      deps(
        s,
        s.batchOf(async () => {
          throw new CodexAbortedError();
        }),
      ),
    );
    expect(r).toEqual({ status: "stopped", code: "CODEX_ABORTED", stage: "call", aborted: true });
    expect(await s.ledger.get(i.approvalId)).toMatchObject({ result: { status: "aborted", code: "CODEX_ABORTED" } });
  });
});

describe("IMAGE_FIRST P3 real-call step: one stubbed success reaches AWAITING_OWNER_EVALUATION", () => {
  it("writes the private run in the Phase 2 builder's shape; assembled and validated it awaits the owner", async () => {
    const s = setup();
    const i = await input(s);
    const { plan, inputs } = await planD1();
    const r = await runFullPageCall(i, deps(s, s.batchOf(okBatch())));
    expect(r).toMatchObject({ status: "succeeded", images: 6, warnings: ["session_model_unknown"] });
    expect(s.calls).toEqual([{ prompt: plan.batch.prompt, maxImages: 6 }]);
    expect(await s.ledger.get(i.approvalId)).toMatchObject({ receipt: { kind: "full_page_comp", route: "image_first", prompt_sha256: plan.batch.sha256, commit: COMMIT }, result: { status: "succeeded" } });
    expect(readFileSync(join(i.outDir, "facts-pack.json"))).toEqual(inputs.factsBytes);
    expect(readFileSync(join(i.outDir, "direction.json"))).toEqual(inputs.directionBytes);
    expect(readFileSync(join(i.outDir, "prompts", "batch.txt"), "utf8")).toBe(plan.batch.prompt);

    // offline, as the owner would: --assemble, then the located read and the identity audits, then --run
    const built = await assembleRecord(i.outDir);
    expect(built.problems).toEqual([]);
    const record = built.record!;
    expect(record.generation).toMatchObject({ approval_ids: [i.approvalId], approval_packet_sha256: sha(PACKET), plan_id: i.planId, repo_commit: COMMIT, image_model: null, stop_code: null });
    const recordBytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
    writeFileSync(join(i.outDir, "manifest.json"), recordBytes);
    const name = plan.shop.display_name;
    const hours = inputs.facts.facts.find((f) => f.key === "hours")!.value;
    const parts = (["desktop_1440", "mobile_390"] as const).flatMap((v) => record.viewports[v]!.parts.map((p, n, all) => ({ p, first: n === 0, last: n === all.length - 1 })));
    writeFileSync(
      join(i.outDir, "visual-read.json"),
      JSON.stringify({
        schema: "image_first_visual_read_v0",
        run_id: record.run_id,
        method: "assistant_visual",
        parts: parts.map(({ p, first, last }) => ({
          inspected_sha256: p.png_sha256,
          observed_section_ids: p.sections.map((x) => x.id),
          header_visible: first,
          footer_visible: last,
          web_structure: { nav: first, text_blocks: true, info_block: last },
          photo_only: false,
          looks_like_browser_screenshot: false,
          visible_texts: first ? [{ text: name, kind: "shop_name" }] : last ? [{ text: "営業時間", kind: "ui_label" }, { text: hours, kind: "fact" }] : [],
          note: "synthetic stub picture (test only)",
        })),
        sp_independent: { judged: true, note: "synthetic stub (test only)" },
      }),
    );
    writeFileSync(
      join(i.outDir, "identity.json"),
      JSON.stringify({
        schema: "image_first_identity_v0",
        run_id: record.run_id,
        audits: parts.map(({ p }) => ({
          schema_version: 1,
          case_id: "CP-901",
          attempt_id: "stub",
          target: { official_name: name, allowed_aliases: [], category_code: plan.shop.category_code, official_source_url: "https://example.com/fictional-bakery" },
          prompt: { shop_name: name, category_code: plan.shop.category_code, is_research_only: true },
          output: { image_sha256: p.png_sha256 },
          visual_inspection: { status: "completed", method: "assistant_visual", inspected_image_sha256: p.png_sha256, reviewer_note: "stub", visible_site_identity_labels: [name], category_code: plan.shop.category_code, unreadable_site_identity: false, image_looks_like_unrelated_shop: false },
        })),
      }),
    );
    const verdict = validateImageFirst(await readImageFirstRun(i.outDir));
    expect(verdict.rejects).toEqual([]);
    expect(verdict.status).toBe("AWAITING_OWNER_EVALUATION");
    expect(verdict.warnings).toEqual(["IMAGE_MODEL_UNKNOWN", "SESSION_MODEL_UNKNOWN"]);
    expect(verdict.parts).toHaveLength(6);
  }, 60_000);
});
