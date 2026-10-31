import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// DEV-133: the repository-managed second-root-design-director skill. It points at repository files; a path that
// moves or disappears would leave the skill sending the agent to nothing, so every path it names must exist.
const DIR = ".claude/skills/second-root-design-director";
const files = [join(DIR, "SKILL.md"), ...readdirSync(join(DIR, "references")).map((f) => join(DIR, "references", f))];
const text = (p: string) => readFileSync(p, "utf8");

describe("second-root-design-director skill", () => {
  it("loads as a project skill with a name and a description", () => {
    const head = text(join(DIR, "SKILL.md")).split("\n");
    expect(head[0]).toBe("---");
    expect(head[1]).toBe("name: second-root-design-director");
    expect(head[2]).toMatch(/^description: .{100,}/);
  });

  it("names only reference files that exist", () => {
    for (const ref of text(join(DIR, "SKILL.md")).match(/references\/[a-z-]+\.md/g) ?? []) {
      expect(existsSync(join(DIR, ref)), ref).toBe(true);
    }
  });

  it("names only repository paths that exist", () => {
    // backticked repo paths (files or directories); glob-like or placeholder paths are skipped
    const PATH = /`((?:lib|design-library|docs|tests)\/[^`*<>]+?)`/g;
    for (const file of files) {
      for (const [, path] of text(file).matchAll(PATH)) {
        const clean = path!.replace(/\/$/, "").split(" ")[0]!;
        expect(existsSync(clean), `${file}: ${clean}`).toBe(true);
      }
    }
  });

  it("never claims images the repository does not hold", () => {
    // the only success-case images are CP-001..003; the skill must say so, not suggest others exist
    const cases = text(join(DIR, "references/evidence-and-cases.md"));
    expect(cases).toContain("欠けている画像を、あるものとして扱わない");
    expect(readdirSync("design-library/success-cases/assets").every((f) => /^CP-00[123]_/.test(f))).toBe(true);
  });

  it("does not run models: it hands instructions to an approval, never calls Codex itself", () => {
    const skill = text(join(DIR, "SKILL.md"));
    expect(skill).toContain("実モデルを呼ばない");
    expect(skill).toContain("承認 ID");
  });

  it("keeps the eval cases loadable by claude plugin eval", () => {
    for (const c of readdirSync(join(DIR, "evals"))) {
      const base = join(DIR, "evals", c);
      expect(text(join(base, "case.yaml"))).toContain(`name: ${c}`);
      expect(text(join(base, "prompt.md"))).toMatch(/^---\n[\s\S]*?\n---\n/);
      expect(readdirSync(join(base, "graders")).length).toBeGreaterThan(0);
      expect(JSON.parse(text(join(base, "files/facts.json"))).schema).toBe("shop_facts_pack_v1");
    }
  });
});
