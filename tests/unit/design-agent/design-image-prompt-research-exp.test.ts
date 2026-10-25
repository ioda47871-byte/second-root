import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_DIRECTION_VERSION, DIRECTION_VERSIONS, FIXTURE_PATH, POC_SHOP_KEY, PocInputError, V2_PROMPT_MAX_CHARS, buildMockupPrompt, loadPocInputs, parseDirectionVersion } from "@/lib/design-agent/design-image/prompt";
import {
  EXPERIMENT_DIRECTION_PATH, ExperimentDirectionError, buildExperimentPrompt, parseExperimentDirection, sharedV2SafetyLines,
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

/** The v3 prompt the owner reviews and a run approval names (DEV-102); a change to the direction or the builder changes it. */
const V3_PROMPT_SHA256 = "15d38b844702b9c0e3d32820ad1f526ac5a43b273e6f87083430e4eaf805c4fd";

describe("the v3 experimental prompt (DEV-101 prepared, DEV-102 selectable)", () => {
  it("is selectable as v3 beside v1 and v2 (v2 stays the default) and is the prompt the PoC builds for v3", async () => {
    expect([...DIRECTION_VERSIONS]).toEqual(["v1", "v2", "v3", "v4"]); // DEV-109 added v4 (prompt-wagashi-a.ts)
    expect(DEFAULT_DIRECTION_VERSION).toBe("v2");
    expect(parseDirectionVersion("v3")).toBe("v3");
    const inputs = await loadPocInputs(REPO, "v3");
    expect(inputs.version).toBe("v3");
    const built = buildMockupPrompt(inputs);
    expect(built).toBe(buildExperimentPrompt(inputs.demo, parseExperimentDirection(rawDirection())));
    expect(createHash("sha256").update(built, "utf8").digest("hex")).toBe(V3_PROMPT_SHA256);
    // the v3 loader reads the file this module names, and its fixture literal is the PoC's shop
    expect(readFileSync(join(REPO, "lib/design-agent/design-image/prompt.ts"), "utf8")).toContain(`v3: "${EXPERIMENT_DIRECTION_PATH}"`);
    expect(parseExperimentDirection(rawDirection()).fixture).toBe(POC_SHOP_KEY);
  });

  it("refuses a v3 direction file that fails its schema as a refused input (POC_INPUT_INVALID), like v1 and v2", async () => {
    const bad = rawDirection();
    (bad.web_ui as { link: string }).link = "購入する";
    expect(() => parseExperimentDirection(bad)).toThrow(ExperimentDirectionError);
    // through the PoC's own loader: a copy of the fixture and the tampered v3 file in a scratch repo
    const repo = mkdtempSync(join(tmpdir(), "v3-bad-"));
    try {
      for (const [rel, body] of [[FIXTURE_PATH, readFileSync(join(REPO, FIXTURE_PATH), "utf8")], [EXPERIMENT_DIRECTION_PATH, JSON.stringify(bad)]] as const) {
        mkdirSync(join(repo, rel, ".."), { recursive: true });
        writeFileSync(join(repo, rel), body);
      }
      await expect(loadPocInputs(repo, "v3")).rejects.toBeInstanceOf(PocInputError);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("keeps every v2 safety line word for word, stays within the v2 length budget, and differs from v2 in the page", async () => {
    const inputs = await loadPocInputs(REPO, "v2");
    const v2 = buildMockupPrompt(inputs);
    const exp = buildExperimentPrompt(inputs.demo, parseExperimentDirection(rawDirection()));
    for (const line of sharedV2SafetyLines()) {
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
