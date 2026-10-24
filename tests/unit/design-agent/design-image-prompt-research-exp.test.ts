import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DIRECTION_VERSIONS, V2_PROMPT_MAX_CHARS, buildMockupPrompt, loadPocInputs } from "@/lib/design-agent/design-image/prompt";
import {
  EXPERIMENT_DIRECTION_PATH, ExperimentDirectionError, SHARED_V2_SAFETY_LINES, buildExperimentPrompt, parseExperimentDirection,
} from "@/lib/design-agent/design-image/prompt-research-exp";
import { RESEARCH_V02_DIR, RESEARCH_V02_LIBRARY_SHA256 } from "@/lib/design-agent/design-image/research-v02";

const REPO = process.cwd();
const rawDirection = () => JSON.parse(readFileSync(join(REPO, EXPERIMENT_DIRECTION_PATH), "utf8")) as Record<string, unknown>;
const DOC = "docs/design/wagashi-v02-research-direction.md";
/** The prepared prompt as the review doc shows it (between the two marker lines). */
const promptInDoc = () => {
  const doc = readFileSync(join(REPO, DOC), "utf8");
  const m = /<!-- prompt:begin -->\n```text\n([\s\S]*?)\n```\n<!-- prompt:end -->/.exec(doc);
  return m ? m[1]! : null;
};

describe("the prepared experimental prompt (DEV-101, not runnable)", () => {
  it("is not a selectable PoC direction: the CLI can still only run v1 and v2", () => {
    expect([...DIRECTION_VERSIONS]).toEqual(["v1", "v2"]);
    expect(readFileSync(join(REPO, "lib/design-agent/design-image/prompt.ts"), "utf8")).not.toContain(EXPERIMENT_DIRECTION_PATH);
  });

  it("keeps every v2 safety line word for word, stays within the v2 length budget, and differs from v2 in the page", async () => {
    const inputs = await loadPocInputs(REPO, "v2");
    const v2 = buildMockupPrompt(inputs);
    const exp = buildExperimentPrompt(inputs.demo, parseExperimentDirection(rawDirection()));
    for (const line of SHARED_V2_SAFETY_LINES) {
      expect(v2, line).toContain(line);
      expect(exp, line).toContain(line);
    }
    // every line of the v2 HARD RULES block, word for word
    const block = v2.slice(v2.indexOf("HARD RULES"), v2.indexOf("YOU MAY LEAVE OUT")).split("\n").slice(1).filter((l) => l.trim());
    expect(block.length).toBeGreaterThanOrEqual(9);
    for (const line of block) expect(exp, line).toContain(line);
    expect(exp.length).toBeLessThanOrEqual(V2_PROMPT_MAX_CHARS);
    expect(exp).toContain("VERTICALLY");
    expect(exp).not.toMatch(/product visual cards/);
    expect(exp).not.toBe(v2);
  });

  it("names the research it rests on (the imported library, the URL check, cards A02/A07/A09)", () => {
    const d = parseExperimentDirection(rawDirection());
    expect(d.based_on.research_library_sha256).toBe(RESEARCH_V02_LIBRARY_SHA256);
    expect(readFileSync(join(REPO, RESEARCH_V02_DIR, d.based_on.url_checks), "utf8")).toContain("DR-032");
    expect(d.based_on.cards).toEqual(["A02", "A07", "A09"]);
  });

  it("refuses a direction with a sales label or other nav labels", () => {
    const sales = rawDirection();
    (sales.web_ui as { link: string }).link = "予約する";
    expect(() => parseExperimentDirection(sales)).toThrow(ExperimentDirectionError);
    const nav = rawDirection();
    (nav.web_ui as { nav: string[] }).nav = ["メニュー", "店舗情報"];
    expect(() => parseExperimentDirection(nav)).toThrow(ExperimentDirectionError);
  });

  it("is the text the review doc shows (the reviewed prompt is the prompt the code builds)", async () => {
    const inputs = await loadPocInputs(REPO, "v2");
    const exp = buildExperimentPrompt(inputs.demo, parseExperimentDirection(rawDirection()));
    expect(promptInDoc()).toBe(exp);
    expect(readFileSync(join(REPO, DOC), "utf8")).toContain(createHash("sha256").update(exp, "utf8").digest("hex"));
  });
});
