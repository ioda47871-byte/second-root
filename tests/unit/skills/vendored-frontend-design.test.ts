import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// DEV-132: Anthropic's frontend-design skill (v1.1.1) is vendored unmodified under the Apache 2.0
// licence. The hashes are those of the upstream files at the recorded commit; a local edit must
// not pass silently as "the official skill".
const DIR = ".claude/skills/frontend-design";
const sha = (path: string) => createHash("sha256").update(readFileSync(`${DIR}/${path}`)).digest("hex");

describe("vendored frontend-design skill", () => {
  it("is byte-for-byte the upstream SKILL.md and LICENSE.txt", () => {
    expect(sha("SKILL.md")).toBe("d91970639e9f5c37682ac7ab60094d35f1c7c1f38d731bd56396563aee10c1d3");
    expect(sha("LICENSE.txt")).toBe("0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594");
  });

  it("keeps the licence and provenance next to it", () => {
    expect(readFileSync(`${DIR}/LICENSE.txt`, "utf8")).toContain("Apache License");
    const provenance = readFileSync(`${DIR}/PROVENANCE.md`, "utf8");
    for (const fact of ["anthropics/claude-plugins-official", "1.1.1", "a7ba5b93db0c7c8d17f3f1d25853adca79598a1a", sha("SKILL.md")]) {
      expect(provenance).toContain(fact);
    }
  });

  it("loads as a project skill named frontend-design", () => {
    const head = readFileSync(`${DIR}/SKILL.md`, "utf8").split("\n").slice(0, 4).join("\n");
    expect(head).toMatch(/^---\nname: frontend-design\n/);
  });
});
