import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDesignCall } from "@/lib/design-agent/phase2f-live/design-call";
import { openLedger } from "@/lib/design-agent/phase2f-live/ledger";
import { sha256 } from "@/lib/design-agent/phase2f-live/steps";
import { liveContext } from "../../../../scripts/design-artifact/phase2f-live-cli";

// DEV-117: environment problems the CLIs can see before an approval is used are refused before it is used — through
// the CLIs' own preflight (the real sandbox set-up, which starts neither Codex nor bubblewrap). No Codex runs here.

const COMMIT = "d".repeat(40);
const saved = { ...process.env };
let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "dev117-pre-"));
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

async function designWith(preflight: () => Promise<string | null>) {
  const state = join(base, "state");
  let called = 0;
  const r = await runDesignCall(
    { route: "B_html_prototype", prompt: "p", schema: {}, humanApprovalConfirmed: true, approvalId: "fictional-pre-1", planId: "plan-fictional-1", retryOf: null, expected: { promptSha256: sha256(Buffer.from("p")), promptChars: 1, commit: COMMIT }, outDir: join(base, "runs", "d1") },
    { ledger: openLedger(state), commit: async () => ({ head: COMMIT, base: COMMIT, clean: true }), preflight, codex: async () => ((called += 1), Promise.reject(new Error("must not run"))) },
  );
  return { r, called, ledger: (() => { try { return readdirSync(state); } catch { return []; } })() };
}

describe("the CLIs' preflight: refused before the approval is used", () => {
  it("no bubblewrap (or no Codex) on PATH: the sandbox set-up refuses with its own code; nothing is used", async () => {
    mkdirSync(join(base, "runs"));
    const empty = join(base, "empty-bin");
    mkdirSync(empty);
    process.env.PATH = empty;
    process.env.CODEX_HOME = join(base, "codex-home");
    process.env.SR_PHASE2F_STATE = join(base, "state");
    const ctx = await liveContext(join(base, "runs", "d1"), () => undefined);
    if ("code" in ctx) throw new Error(ctx.code);
    const code = await ctx.preflight();
    expect(["CODEX_NOT_INSTALLED", "CODEX_SANDBOX_UNAVAILABLE", "CODEX_SANDBOX_CONFIG"]).toContain(code);
    const { r, called, ledger } = await designWith(ctx.preflight);
    expect(r).toMatchObject({ status: "stopped", stage: "precheck", code });
    expect(called).toBe(0);
    expect(ledger).toEqual([]);
  });

  it("a .env in Codex's home: CODEX_DOTENV_PRESENT before anything else; nothing is used", async () => {
    mkdirSync(join(base, "runs"));
    mkdirSync(join(base, "codex-home"));
    writeFileSync(join(base, "codex-home", ".env"), "OPENAI_API_KEY=x");
    process.env.CODEX_HOME = join(base, "codex-home");
    process.env.SR_PHASE2F_STATE = join(base, "state");
    const ctx = await liveContext(join(base, "runs", "d1"), () => undefined);
    if ("code" in ctx) throw new Error(ctx.code);
    expect(await ctx.preflight()).toBe("CODEX_DOTENV_PRESENT");
    const { r, called, ledger } = await designWith(ctx.preflight);
    expect(r).toMatchObject({ status: "stopped", stage: "precheck", code: "CODEX_DOTENV_PRESENT" });
    expect(called).toBe(0);
    expect(ledger).toEqual([]);
  });
});
