import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FactsPack } from "@/lib/design-agent/artifact/schema";
import { buildDesignPrompt, DesignBrief } from "@/lib/design-agent/phase2f/prompt";

// DEV-116: the shared inputs of the A/B/C test (fictional shop 架空菓庵) and the design step's CLI, offline only.

const REPO = resolve(__dirname, "../../../..");
const json = (p: string) => JSON.parse(readFileSync(resolve(REPO, p), "utf8"));
const PACK = "design-library/phase2f/wagashi-facts-pack.json";
const BRIEF = "design-library/phase2f/wagashi-brief-v4.json";
const SOURCES = "design-library/phase2f/wagashi-sources.json";
const FIXTURE = "scripts/sales-design-worker/compare/shops/wagashi.json";

describe("the facts pack is the fixture, copied verbatim, with its source named", () => {
  const pack = FactsPack.parse(json(PACK));
  const fixture = json(FIXTURE) as { facts: Record<string, string | string[]> };

  it("one fact per fixture key in fixture order; menu items one by one; every value unchanged", () => {
    const expected = Object.entries(fixture.facts).flatMap(([k, v]) => (Array.isArray(v) ? v.map((m, i) => [`menu_item_${i + 1}`, m]) : [[k, v]]));
    expect(pack.facts.map((f) => [f.key, f.value])).toEqual(expected);
    expect(pack.facts.map((f) => f.id)).toEqual(expected.map((_, i) => `F${i + 1}`));
    expect(pack.facts.find((f) => f.key === "hours")?.value).toBe("9:00〜18:00（売り切れ次第終了）");
  });

  it("every fact points to the fixture as its source", () => {
    expect(new Set(pack.facts.map((f) => f.source_id))).toEqual(new Set(["S1"]));
    expect(json(SOURCES)).toMatchObject({ pack: "wagashi-facts-pack.json", sources: { S1: { path: FIXTURE } } });
  });
});

describe("the Design DNA v4 brief (owner review pending before any real Codex call)", () => {
  const brief = DesignBrief.parse(json(BRIEF));
  const pack = FactsPack.parse(json(PACK));
  const text = JSON.stringify(brief);

  it("keeps the shop's concept, palette and story", () => {
    for (const s of ["The morning batch", "#F4EFE4", "#2B2622", "#E2D6C0", "#6B2E2E", "dorayaki", "tsubu-an"]) expect(text).toContain(s);
  });

  it("quotes the shop only with words that are in its facts (no invented fact)", () => {
    const facts = pack.facts.map((f) => f.value).join("\n");
    const quotes = (text.match(/[\u3040-\u30ff\u3400-\u9fff\uff00-\uffef0-9:〜（）・]{2,}/g) ?? []).filter((q) => /[\u3040-\u30ff\u3400-\u9fff]/.test(q));
    expect(quotes.length).toBeGreaterThan(5);
    // テスト is named only to tell Codex to leave the placeholders out
    for (const q of quotes.filter((x) => x !== "テスト")) expect(facts, q).toContain(q);
  });

  it("carries no restriction from the old implementation CSS allowlist into the Codex prototype", () => {
    for (const s of ["writing-mode", "clip-path", "inline SVG", "overlap"]) expect(text).toContain(s);
    expect(text).not.toMatch(/horizontal text only|no vertical|vertical text is (not|never)|no gradients|current (CSS )?allowlist|within the allowlist/i);
  });

  it("builds a different prompt for B and C (C may ask for one image)", () => {
    const b = buildDesignPrompt({ route: "B_html_prototype", facts: pack, brief, maxAssets: 1 });
    const c = buildDesignPrompt({ route: "C_hybrid", facts: pack, brief, maxAssets: 1 });
    expect(b.sha256).not.toBe(c.sha256);
    expect(c.prompt).toContain("up to 1 generated image");
  });
});

describe("the design step's CLI (offline paths only)", () => {
  const cli = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, ["--import", "tsx", resolve(REPO, "scripts/design-artifact/phase2f-design.ts"), ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  const inputs = ["--facts", resolve(REPO, PACK), "--brief", resolve(REPO, BRIEF)];

  it("--print-pin prints the prompt's SHA-256 and length and calls nothing (the value the owner approves)", () => {
    const r = cli(["--print-pin", "--route", "B", ...inputs]);
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    const expected = buildDesignPrompt({ route: "B_html_prototype", facts: FactsPack.parse(json(PACK)), brief: DesignBrief.parse(json(BRIEF)), maxAssets: 1 });
    expect(out).toEqual({ mode: "print_pin", route: "B_html_prototype", prompt_sha256: expected.sha256, prompt_chars: expected.chars });
  }, 30_000);

  it("refuses bad usage and a call without the owner's confirmation, before the ledger is touched", () => {
    for (const args of [[], ["--route", "B"], ["--print-pin", "--route", "X", ...inputs], ["--route", "B", ...inputs, "--codex"]]) expect(cli(args).status, args.join(" ")).toBe(2);
    const state = mkdtempSync(join(tmpdir(), "dev116-cli-"));
    const out = join(mkdtempSync(join(tmpdir(), "dev116-out-")), "run");
    const r = cli(["--route", "B", ...inputs, "--out", out, "--plan-id", "plan-fictional-1", "--approval-id", "fictional-2f-b-01", "--expected-prompt-sha256", "0".repeat(64), "--expected-prompt-chars", "10", "--expected-commit", "a".repeat(40)], { SR_PHASE2F_STATE: state });
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout)).toMatchObject({ status: "stopped", code: "HUMAN_APPROVAL_REQUIRED", approval_used: false });
    expect(spawnSync("ls", ["-A", state], { encoding: "utf8" }).stdout).toBe("");
  }, 30_000);

  it("refuses output and ledger places that would break the sandbox or sit in the repository, before anything is used", () => {
    const state = mkdtempSync(join(tmpdir(), "dev116-cli-"));
    const pin = ["--route", "B", ...inputs, "--plan-id", "plan-fictional-1", "--approval-id", "fictional-2f-b-02", "--expected-prompt-sha256", "0".repeat(64), "--expected-prompt-chars", "10", "--expected-commit", "a".repeat(40), "--human-approval-confirmed"];
    const run = (out: string, env: Record<string, string> = { SR_PHASE2F_STATE: state }) => JSON.parse(cli([...pin, "--out", out], env).stdout) as { code: string };
    expect(run(join(tmpdir(), "dev116-run"))).toMatchObject({ code: "OUT_DIR_PARENT_UNSAFE" });
    expect(run(join(homedir(), "dev116-run"))).toMatchObject({ code: "OUT_DIR_PARENT_UNSAFE" });
    expect(run("/dev116-run")).toMatchObject({ code: "OUT_DIR_PARENT_UNSAFE" });
    expect(run(join(REPO, "tmp-dev116-run"))).toMatchObject({ code: "OUT_DIR_INSIDE_REPO" });
    expect(run(join(state, "missing", "run"))).toMatchObject({ code: "OUT_DIR_PARENT_MISSING" });
    const out = join(mkdtempSync(join(tmpdir(), "dev116-out-")), "run");
    expect(run(out, { SR_PHASE2F_STATE: join(REPO, "tmp-dev116-ledger") })).toMatchObject({ code: "LEDGER_INSIDE_REPO" });
    expect(spawnSync("ls", ["-A", state], { encoding: "utf8" }).stdout).toBe("");
  }, 60_000);
});
