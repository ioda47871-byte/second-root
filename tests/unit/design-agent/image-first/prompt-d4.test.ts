import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPromptPlan, DIRECTIONS, EXCLUDED_READS, LINEAGE_PATTERNS, LINEAGE_TOKENS, loadPromptInputs, pinOf, PROMPT_INPUTS, type DirectionKey } from "@/lib/design-agent/image-first/prompt";

// Issue #302 P5: d4, the owner's revise of d3 (design-library/research-log/briefs/hoshigama-d4.md). Offline: builds the
// plan from the repository files; no model, no image, no approval.
const REPO = resolve(__dirname, "../../../..");
const D4_PACKET = "docs/design/image-first-hoshigama-d4-packet.md";

const opened: string[] = [];
const reader = async (p: string) => {
  opened.push(p);
  return readFile(resolve(REPO, p));
};
const planOf = async (key: DirectionKey) => buildPromptPlan(await loadPromptInputs(reader, key));
const prompts = (plan: Awaited<ReturnType<typeof planOf>>) => [plan.batch.prompt, ...plan.viewports.desktop_1440.parts.map((p) => p.prompt), ...plan.viewports.mobile_390.parts.map((p) => p.prompt)];

describe("image-first-prompt.ts --print-direction-sha (read-only)", () => {
  it.each(["d1", "d3", "d4"] as const)("%s: prints the canonical direction SHA-256 and that it matches the pin", (key) => {
    const r = spawnSync(process.execPath, ["--import", "tsx", resolve(REPO, "scripts/design-artifact/image-first-prompt.ts"), "--direction", key, "--print-direction-sha"], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as { sha256: string; matches_pin: boolean; file: string };
    expect(out).toMatchObject({ sha256: DIRECTIONS[key].sha256, matches_pin: true, file: DIRECTIONS[key].set });
  });

  it("refuses an unknown direction", () => {
    const r = spawnSync(process.execPath, ["--import", "tsx", resolve(REPO, "scripts/design-artifact/image-first-prompt.ts"), "--direction", "d9", "--print-direction-sha"], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("USAGE");
  });
});

describe("IMAGE_FIRST d4 (revise of d3)", () => {
  it("reads only the facts pack, its own direction file and the principles — never direction-set.json or an excluded path", async () => {
    opened.length = 0;
    await loadPromptInputs(reader, "d4");
    expect([...opened].sort()).toEqual([PROMPT_INPUTS.factsPack.path, DIRECTIONS.d4.set, PROMPT_INPUTS.principles.path].sort());
    expect(opened).not.toContain(PROMPT_INPUTS.directionSet.path);
    for (const p of opened) expect(EXCLUDED_READS.some((re) => re.test(p)), p).toBe(false);
  });

  it("the packet shows exactly the pins the builder prints, and stays unapproved until the owner fills §10", async () => {
    const pin = pinOf(await planOf("d4"));
    const text = await readFile(resolve(REPO, D4_PACKET), "utf8");
    for (const v of [pin.plan_sha256, pin.batch.sha256, String(pin.batch.chars), pin.direction_sha256, pin.facts_sha256, pin.principles_sha256]) expect(text).toContain(v);
    for (const p of pin.parts) expect(text).toContain(`\`${p.prompt_sha256}\` / ${p.prompt_chars}`);
    expect(text.slice(0, text.indexOf("\n## "))).toContain("**状態: 未承認。**");
    expect(/^\| 状態（[^|]*\| (.*) \|$/m.exec(text.slice(text.lastIndexOf("\n## 10.")))?.[1]).toBe("未記入");
    expect(text).not.toContain(pin.parts[0]!.prompt.split("\n")[0]!);
  });

  it("the info section may carry the facts schema's labels; the footer may repeat only the name and the fictional note", async () => {
    const plan = await planOf("d4");
    for (const vp of [plan.viewports.desktop_1440, plan.viewports.mobile_390]) {
      const last = vp.parts.at(-1)!;
      expect(last.prompt).toContain("区画「info」の値の上に小さな見出しとして使ってよい語: 「営業時間」 「定休日」 「所在地」 「道順」 「電話」");
      expect(last.prompt).toMatch(/フッターに書いてよい文字: 上の一覧のうち 「架空パン店 ほし窯」 「比較研究用の架空のパン屋です。/);
      for (const p of vp.parts.slice(0, -1)) {
        expect(p.prompt).not.toContain("フッターに書いてよい文字");
        expect(p.prompt).not.toContain("小さな見出しとして使ってよい語");
      }
    }
  });

  it("the SP header offers only three navigation words; the PC header keeps all five; d1/d3 keep all five on both", async () => {
    const nav = (t: string) => /ナビゲーションの項目に使ってよい語: (.*)/.exec(t)?.[1];
    const d4 = await planOf("d4");
    expect(nav(d4.viewports.mobile_390.parts[0]!.prompt)).toBe("「営業時間」 「所在地」 「電話」");
    expect(nav(d4.viewports.desktop_1440.parts[0]!.prompt)).toBe("「営業時間」 「定休日」 「所在地」 「道順」 「電話」");
    for (const key of ["d1", "d3"] as const) {
      const p = await planOf(key);
      for (const vp of [p.viewports.desktop_1440, p.viewports.mobile_390]) expect(nav(vp.parts[0]!.prompt)).toBe("「営業時間」 「定休日」 「所在地」 「道順」 「電話」");
    }
  });

  it("d1 and d3 prompts carry neither the label line nor the footer line (their bytes are pinned in prompt.test.ts)", async () => {
    for (const key of ["d1", "d3"] as const) for (const t of prompts(await planOf(key))) expect(t).not.toMatch(/小さな見出しとして使ってよい語|フッターに書いてよい文字/);
  });

  it("carries no word of the earlier same-shop design, no fact id, and the shelf names every product only through the allowed strings", async () => {
    const plan = await planOf("d4");
    for (const t of prompts(plan)) {
      for (const w of LINEAGE_TOKENS) expect(t).not.toContain(w);
      for (const re of LINEAGE_PATTERNS) expect(t).not.toMatch(re);
      expect(t).not.toMatch(/\bF\d{1,2}\b/);
    }
    const shelf = plan.viewports.desktop_1440.parts.find((p) => p.sections.some((s) => s.id === "shelf"))!.prompt;
    expect(shelf).toContain("「石窯で焼くのは田舎パンとバゲットです」");
    for (const bare of ["塩パン・", "くるみパン・"]) expect(shelf).not.toContain(bare);
  });
});
