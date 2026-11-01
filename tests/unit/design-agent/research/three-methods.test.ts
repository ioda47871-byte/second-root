import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FactsPack } from "@/lib/design-agent/artifact/schema";
import { auditPageText } from "@/lib/design-agent/identity/identity-lock";
import { LIMITS } from "@/lib/design-agent/loop/controller";
import { LIVE_LIMITS } from "@/lib/design-agent/phase2f-live/ledger";

// DEV-141 (Issue #180): the shared inputs of the three-method study (VISUAL_FIRST / LAYOUT_FIRST / DIRECTION_FIRST).
// Fictional only; nothing here calls a model.

const REPO = resolve(__dirname, "../../../..");
const DIR = "design-library/research/three-methods";
const read = (p: string) => readFileSync(resolve(REPO, DIR, p), "utf8");
const pack = FactsPack.parse(JSON.parse(read("facts-pack.json")));
const lock = JSON.parse(read("identity-lock.json"));
const doc = readFileSync(resolve(REPO, "docs/design/three-methods-study.md"), "utf8");

describe("the three-method study's shared inputs", () => {
  it("is one fictional bakery with sourced facts, marked as not a real shop", () => {
    expect(pack.shop_id).toBe("fictional-bakery-komugi");
    const by = Object.fromEntries(pack.facts.map((f) => [f.key, f.value]));
    expect(by.category).toBe("bakery");
    expect(by.description).toContain("実在の店舗ではありません");
    // every named thing carries 架空, so nothing can be taken for a real shop, product or place
    for (const k of ["name", "address", "access", ...Object.keys(by).filter((k) => k.startsWith("menu_item_"))]) expect(by[k], k).toContain("架空");
    // a phone number in the fictional 000 exchange, like the other fixtures
    expect(by.phone).toMatch(/^052-000-\d{4}$/);
    const sources = JSON.parse(read("sources.json"));
    for (const f of pack.facts) expect(Object.keys(sources.sources), f.id).toContain(f.source_id);
  });

  it("has a research-only identity lock that a page with every fact passes, and another shop's name fails", () => {
    expect(lock.prompt.is_research_only).toBe(true);
    expect(lock.target.official_name).toBe(pack.facts.find((f) => f.key === "name")!.value);
    expect(lock.target.official_source_url).toMatch(/\.invalid\//);
    const page = pack.facts.map((f) => f.value).join("\n");
    expect(auditPageText(lock, page).status).toBe("PASS_IDENTITY_ONLY");
    expect(auditPageText(lock, `${page}\n架空菓庵`).status).not.toBe("PASS_IDENTITY_ONLY");
  });

  it("is a shop never handed to Codex before: its name and id appear nowhere else in the design library, the skills or the scripts", () => {
    for (const other of lock.other_shop_names as string[]) expect(pack.facts.map((f) => f.value).join("")).not.toContain(other);
    expect(lock.other_shop_names).toEqual(expect.arrayContaining(["架空菓庵", "月見湯", "紙縁堂", "ひびや継工房"]));
    const g = spawnSync("git", ["grep", "--untracked", "-lE", "こむぎ灯|fictional-bakery-komugi", "--", "design-library", ".claude", "scripts", "lib", `:!${DIR}/**`], { cwd: REPO, encoding: "utf8" });
    expect([g.status, g.stdout.trim()]).toEqual([1, ""]);
  });

  it("quotes the code's own limits correctly (a change there shows here)", () => {
    expect(LIVE_LIMITS).toMatchObject({ firstCalls: 4, retries: 2, callTimeoutMs: 15 * 60 * 1000, planBudgetMs: 2 * 60 * 60 * 1000 });
    expect(LIMITS).toEqual({ implementationAttempts: 3, fixesPerCause: 2 });
    expect(readFileSync(resolve(REPO, "scripts/design-artifact/phase2f-design.ts"), "utf8")).toMatch(/^const MAX_ASSETS = 1;$/m);
    expect(doc).toContain("`implementationAttempts: 3`、`fixesPerCause: 2`");
    expect(doc).toContain("`MAX_ASSETS = 1`");
    expect(doc).toContain("`LIVE_LIMITS` (最初の呼び出し4回・やり直し2回)");
    expect(doc).toContain("15分で打ち切る (`LIVE_LIMITS.callTimeoutMs`)");
    expect(doc).toContain("1つの計画は2時間まで (`planBudgetMs`)");
    // report-only findings never become a repair trigger in the study (DEV-140, Issue #177 condition 4)
    // the repair triggers: overflow only; identity stops for the owner; the rest is recorded (Issue #177 condition 4)
    const trig = doc.split("\n").filter((l) => l.startsWith("| 修正のきっかけ |"));
    expect(trig).toHaveLength(1);
    expect(trig[0]).toContain("**修正のきっかけは、横はみ出し (`PROTOTYPE_HORIZONTAL_OVERFLOW`、既存の描画の停止) だけ**");
    expect(trig[0]).toContain("**店の取り違え (Identity Lock の REJECT / HOLD) は、修正せず、その回をオーナーへ止める**");
    expect(trig[0]).toContain("**SP の所見 (`measureMobileQuality`)・事実に無い文・VISUAL_FIRST の比較の差は、記録するだけで、修正のきっかけにしない**");
  });

  it("records runs in one shape, and the design keeps mock and live apart and names the three methods", () => {
    const t = JSON.parse(read("run-record-template.json"));
    expect(t.schema).toBe("three_method_run_v0");
    expect(t.run_kind).toBe("mock | live");
    for (const k of ["codex_calls", "images", "claude", "artifacts", "checks", "stops", "cost", "failure", "rework"]) expect(t, k).toHaveProperty(k);
    for (const k of ["commit", "cli_version", "model_reported", "approval_id", "prompt_sha256"]) expect(t.codex_calls[0], k).toHaveProperty(k);
    for (const m of ["VISUAL_FIRST", "LAYOUT_FIRST", "DIRECTION_FIRST"]) expect(doc).toContain(m);
    expect(doc).toContain("模擬の画像や数値は、方式の優劣の証拠にしない");
    expect(read("review-sheet.md")).toContain("模擬 (`MOCK`) の画像では評価しない");
  });

  it("pins the shared inputs by hash in the design (a later change shows)", () => {
    for (const f of ["facts-pack.json", "identity-lock.json"]) {
      const sha = createHash("sha256").update(read(f)).digest("hex");
      expect(doc, f).toContain(sha);
    }
  });
});
