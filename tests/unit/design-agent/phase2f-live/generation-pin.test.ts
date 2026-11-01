import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { CodexRunMeta } from "@/lib/design-agent/codex";
import { FactsPack } from "@/lib/design-agent/artifact/schema";
import { runDirectionCall } from "@/lib/design-agent/phase2f-live/direction-call";
import { openLedger } from "@/lib/design-agent/phase2f-live/ledger";
import { ThreeMethodBrief } from "@/lib/design-agent/three-methods/brief";
import { buildDirectionPrompt, directionJsonSchema } from "@/lib/design-agent/three-methods/direction";
import { checkGeneration, generationPinOf, modelWarning, probeCliVersion } from "../../../../scripts/design-artifact/phase2f-live-cli";
import { passthroughSandbox } from "../../../support/passthrough-sandbox";

// DEV-150 (Issue #180, owner approval A′, decision 5): the generation pin. Before an approval is used, the Codex CLI
// version (one sandboxed `codex --version`, the FAKE CLI here) must be the approved one, and the earlier calls named
// must have succeeded with that version and one model. Fake Codex only; temporary ledgers; nothing calls a model.

const REPO = resolve(__dirname, "../../../..");
const DIR = "design-library/research/three-methods";
const FAKE = join(REPO, "tests/support/fake-codex.mjs");
const temps: string[] = [];
const tmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
const readJson = (p: string) => JSON.parse(readFileSync(resolve(REPO, DIR, p), "utf8"));
const facts = FactsPack.parse(readJson("facts-pack.json"));
const built = buildDirectionPrompt({ facts, brief: ThreeMethodBrief.parse(readJson("brief.json")) });
const COMMIT = "a".repeat(40);
const META: CodexRunMeta = { threadId: null, cliVersion: "0.200.0", modelReported: "gpt-fictional-5", redactions: [] };
const DIRECTION = { schema: "three_method_direction_v0", concept: "朝の石窯。", dna: Object.fromEntries(["hero", "typography", "palette", "product_visual", "section_rhythm", "navigation", "mobile", "implementation"].map((p) => [p, { choice: "x", fact_refs: ["F1"] }])), avoid: [] };
let n = 0;

function world() {
  const base = tmp("dev150-gen-");
  const ledger = openLedger(join(base, "state"));
  const step = async (meta: Partial<CodexRunMeta> = {}, answer: unknown = DIRECTION) => {
    const outDir = join(base, `d-${++n}`);
    await runDirectionCall(
      { prompt: built.prompt, schema: directionJsonSchema(), facts, humanApprovalConfirmed: true, approvalId: `fictional-gen-${n}`, planId: "plan-fictional-gen", retryOf: null, expected: { promptSha256: built.sha256, promptChars: built.chars, commit: COMMIT }, outDir },
      { ledger, commit: async () => ({ head: COMMIT, base: COMMIT, clean: true }), codex: async () => ({ answer, meta: { ...META, ...meta } }) },
    );
    return outDir;
  };
  const check = (previousSteps: string[], now: string | null = "0.200.0", expectCliVersion = "0.200.0") => checkGeneration({ pin: { expectCliVersion, previousSteps }, ledger, probe: async () => now });
  return { base, step, check };
}

describe("the generation pin's flags", () => {
  const args = (o: Record<string, string>) => new Map(Object.entries(o));
  it("required: refused without --expect-cli-version; optional: absent is no pin (the existing routes are unchanged)", () => {
    expect(generationPinOf(args({}), true)).toBe("USAGE");
    expect(generationPinOf(args({}), false)).toBeNull();
    expect(generationPinOf(args({ "--previous-steps": "a" }), false)).toBe("USAGE");
    expect(generationPinOf(args({ "--expect-cli-version": "not a version" }), false)).toBe("USAGE");
    expect(generationPinOf(args({ "--expect-cli-version": "abc" }), false)).toBe("USAGE");
    expect(generationPinOf(args({ "--expect-cli-version": "0.159.0" }), true)).toEqual({ expectCliVersion: "0.159.0", previousSteps: [] });
    expect(generationPinOf(args({ "--expect-cli-version": "0.159.0", "--previous-steps": "a,b" }), true)).toEqual({ expectCliVersion: "0.159.0", previousSteps: ["a", "b"] });
    expect(generationPinOf(args({ "--expect-cli-version": "0.159.0", "--previous-steps": "," }), true)).toBe("USAGE");
  });
});

describe("checkGeneration (before the approval is used)", () => {
  it("the same version now and in every earlier call, one model: goes on, and gives that model", async () => {
    const w = world();
    const a = await w.step();
    const b = await w.step();
    expect(await w.check([a, b])).toEqual({ code: null, model: "gpt-fictional-5" });
    expect(await w.check([])).toEqual({ code: null, model: null });
  });

  it.each<[string, (w: ReturnType<typeof world>) => Promise<{ code: string | null }>, string]>([
    ["the CLI now is another version", async (w) => w.check([await w.step()], "0.201.0"), "CODEX_CLI_VERSION_MISMATCH"],
    ["the CLI version cannot be read now", async (w) => w.check([], null), "CODEX_CLI_VERSION_UNKNOWN"],
    ["an earlier call ran another version", async (w) => w.check([await w.step({ cliVersion: "0.199.0" })]), "CODEX_CLI_VERSION_CHANGED"],
    ["two earlier calls ran different models (a changed model stops the next call)", async (w) => w.check([await w.step(), await w.step({ modelReported: "gpt-fictional-6" })]), "CODEX_MODEL_CHANGED"],
    ["an earlier call's model is unknown", async (w) => w.check([await w.step({ modelReported: null })]), "PREVIOUS_GENERATION_UNKNOWN"],
    ["an earlier call did not succeed", async (w) => w.check([await w.step({}, { schema: "x" })]), "PREVIOUS_STEP_NOT_SUCCEEDED"],
    ["an earlier step is not a call's output", async (w) => w.check([w.base]), "PREVIOUS_STEP_INVALID"],
  ])("%s", async (_n, run, code) => {
    expect(await run(world())).toMatchObject({ code });
  });

  it("the model warning after a call names a change, and nothing when there is no earlier model", () => {
    expect(modelWarning("gpt-fictional-5", "gpt-fictional-6")).toHaveLength(1);
    expect(modelWarning("gpt-fictional-5", null)).toHaveLength(1);
    expect(modelWarning("gpt-fictional-5", "gpt-fictional-5")).toEqual([]);
    expect(modelWarning(null, "gpt-fictional-6")).toEqual([]);
  });
});

describe("probeCliVersion: one `codex --version` in the sandbox (the FAKE CLI; no model call)", () => {
  it("reads the version, and null when it does not look like one", async () => {
    const env = (v: string) => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tmp("dev150-home-"), FAKE_CODEX_VERSION: v });
    expect(await probeCliVersion(passthroughSandbox(FAKE, env("codex-cli 0.200.0")))).toBe("0.200.0");
    expect(await probeCliVersion(passthroughSandbox(FAKE, env("?? not a version ??")))).toBeNull();
  }, 30_000);
});

describe("the three-method entries require it; the existing routes are unchanged without it (refused before anything is used)", () => {
  const run = (script: string, args: string[], state: string) => {
    const r = spawnSync(process.execPath, ["--import", "tsx", resolve(REPO, "scripts/design-artifact", script), ...args], { encoding: "utf8", env: { ...process.env, SR_PHASE2F_STATE: state } });
    return { status: r.status, out: JSON.parse(r.stdout || "{}") as Record<string, unknown> };
  };
  const tm = ["--facts", resolve(REPO, DIR, "facts-pack.json"), "--tm-brief", resolve(REPO, DIR, "brief.json")];
  const call = (out: string) => ["--out", out, "--plan-id", "plan-fictional-gen", "--approval-id", "fictional-gen-cli", "--expected-prompt-sha256", "0".repeat(64), "--expected-prompt-chars", "10", "--expected-commit", COMMIT, "--human-approval-confirmed"];

  it("tm0 design, direction and route P image: USAGE without --expect-cli-version; with it, the usual checks go on", () => {
    const state = tmp("dev150-gen-cli-");
    const out = join(tmp("dev150-gen-out-"), "run");
    const req = join(tmp("dev150-gen-req-"), "req.json");
    writeFileSync(req, "{}");
    const page = ["--page-request", req, "--page-root", REPO, "--facts", resolve(REPO, DIR, "facts-pack.json")];
    for (const [script, args] of [
      ["phase2f-design.ts", ["--route", "C", "--prompt-version", "tm0", ...tm, ...call(out)]],
      ["phase2f-direction.ts", [...tm, ...call(out)]],
      ["phase2f-image.ts", ["--route", "P", ...page, ...call(out)]],
    ] as const) {
      expect(run(script, [...args], state), script).toEqual({ status: 2, out: { status: "refused", code: "USAGE" } });
      // with the pin given, the call goes on to the existing checks (here the fictional prompt pin or request), nothing used
      const r = run(script, [...args, "--expect-cli-version", "0.200.0"], state);
      expect(r.status, script).toBe(2);
      expect(r.out.code, script).not.toBe("USAGE");
    }
    expect(readdirSync(state)).toEqual([]);
  }, 120_000);

  it("v1 design and route C / A image need no pin (unchanged); a malformed pin is refused", () => {
    const state = tmp("dev150-gen-cli-");
    const out = join(tmp("dev150-gen-out-"), "run");
    const v1 = ["--route", "B", "--facts", resolve(REPO, "design-library/phase2f/wagashi-facts-pack.json"), "--brief", resolve(REPO, "design-library/phase2f/wagashi-brief-v4.json")];
    expect(run("phase2f-design.ts", [...v1, ...call(out)], state).out).toMatchObject({ code: "PROMPT_PIN_MISMATCH" });
    expect(run("phase2f-design.ts", [...v1, ...call(out), "--expect-cli-version", "x y"], state).out).toEqual({ status: "refused", code: "USAGE" });
    const dir = tmp("dev150-gen-c-");
    mkdirSync(join(dir, "x"));
    expect(run("phase2f-image.ts", ["--route", "C", "--request", join(dir, "missing.json"), ...call(out)], state).out).toEqual({ status: "refused", code: "IMAGE_REQUEST_INVALID" });
    expect(readdirSync(state)).toEqual([]);
  }, 120_000);
});
