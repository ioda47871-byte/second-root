import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DESIGN_DNA_FIXTURE_DIR } from "@/lib/design-agent/design-image/design-dna";
import {
  DEFAULT_DIRECTION_VERSION, DIRECTION_VERSIONS, FIXTURE_PATH, PocInputError, V1_PROMPT_CHARS, buildMockupPrompt, loadPocInputs, parseDirectionVersion,
} from "@/lib/design-agent/design-image/prompt";
import { sharedV2SafetyLines } from "@/lib/design-agent/design-image/prompt-research-exp";
import {
  WAGASHI_A_DIRECTION_PATH, WAGASHI_A_PROMPT_MAX_CHARS, WagashiADirectionError, buildWagashiAPrompt, parseWagashiADirection,
} from "@/lib/design-agent/design-image/prompt-wagashi-a";

const REPO = process.cwd();
const raw = () => JSON.parse(readFileSync(join(REPO, WAGASHI_A_DIRECTION_PATH), "utf8")) as Record<string, unknown> & { facts: { label: string; fact_key: string; quote: string }[] };
const fixture = () => JSON.parse(readFileSync(join(REPO, FIXTURE_PATH), "utf8")) as { facts: Record<string, string | string[]> };
const DOC = "docs/design/wagashi-a-image-prompt.md";
const promptInDoc = () => /<!-- prompt:begin -->\n```text\n([\s\S]*?)\n```\n<!-- prompt:end -->/.exec(readFileSync(join(REPO, DOC), "utf8"))?.[1] ?? null;
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const factsBlock = (p: string) => p.slice(p.indexOf("<<<FACTS_BEGIN"), p.indexOf("FACTS_END>>>"));

/** The v4 prompt a run approval must name (DEV-109); a change to the direction file or the builder changes it. */
const V4_PROMPT_SHA256 = "78c0004f8bb9577fe0f59902c68a58a066c7861f2fbcf1319c7af5633feb027e";

describe("the v4 wagashi A prompt (DEV-109, prepared only)", () => {
  it("is selectable as v4 beside v1-v3, v2 stays the default, and the built prompt is the pinned one", async () => {
    expect([...DIRECTION_VERSIONS]).toEqual(["v1", "v2", "v3", "v4"]);
    expect(DEFAULT_DIRECTION_VERSION).toBe("v2");
    expect(parseDirectionVersion("v4")).toBe("v4");
    expect(readFileSync(join(REPO, "lib/design-agent/design-image/prompt.ts"), "utf8")).toContain(`v4: "${WAGASHI_A_DIRECTION_PATH}"`);
    const inputs = await loadPocInputs(REPO, "v4");
    expect(inputs.version).toBe("v4");
    const built = buildMockupPrompt(inputs);
    expect(built).toBe(buildWagashiAPrompt(parseWagashiADirection(raw(), inputs.demo)));
    expect(sha(built)).toBe(V4_PROMPT_SHA256);
  });

  it("is shorter than the v1 prompt (the one that produced an image) and keeps every v2 safety line word for word", async () => {
    const v4 = buildMockupPrompt(await loadPocInputs(REPO, "v4"));
    const v2 = buildMockupPrompt(await loadPocInputs(REPO, "v2"));
    expect(v4.length).toBeLessThanOrEqual(WAGASHI_A_PROMPT_MAX_CHARS);
    expect(WAGASHI_A_PROMPT_MAX_CHARS).toBe(V1_PROMPT_CHARS);
    for (const line of sharedV2SafetyLines()) expect(v4, line).toContain(line);
    const block = v2.slice(v2.indexOf("HARD RULES"), v2.indexOf("YOU MAY LEAVE OUT")).split("\n").slice(1).filter((l) => l.trim());
    for (const line of block) expect(v4, line).toContain(line);
    expect(v4).toContain("架空店舗のデザイン提案｜和菓子の画像はAI生成のイメージです");
  });

  it("asks for a web page, not a poster: header, five bands, the dorayaki cross-section, two numbered reasons, horizontal text only", async () => {
    const v4 = buildMockupPrompt(await loadPocInputs(REPO, "v4"));
    for (const part of ["NOT a poster", "1. Header", "2. Hero", "3. On the band", "4. Heading", "5. The hairline", "6. Footer", "cut cleanly in half", "numeral 1", "numeral 2", "Every text is horizontal", "No text on the image"]) expect(v4, part).toContain(part);
    expect(v4).not.toMatch(/VERTICAL|縦書き/);
    expect(v4).not.toMatch(/購入|予約|注文|通販|カート|買う|お取り寄せ/);
    // only one image on the page
    expect(v4).toContain("the only image");
  });

  it("sends only verbatim, non-placeholder facts: no テスト item, no placeholder station or town, no fictional-shop sentence", async () => {
    const v4 = buildMockupPrompt(await loadPocInputs(REPO, "v4"));
    const facts = fixture().facts;
    const block = factsBlock(v4);
    expect(block).not.toMatch(/テスト|実在|比較用/);
    for (const f of raw().facts) {
      const value = facts[f.fact_key]!;
      expect((Array.isArray(value) ? value : [value]).some((v) => v.includes(f.quote)), f.label).toBe(true);
      expect(block).toContain(`${f.label}: ${f.quote}`);
    }
    for (const item of facts.menu_items as string[]) expect(v4).not.toContain(item);
    expect(v4).not.toContain(facts.access as string);
  });

  it("follows DEV-107 direction A: the same palette, the same quoted traits, the image after the name on a phone", () => {
    const proposal = JSON.parse(readFileSync(join(REPO, DESIGN_DNA_FIXTURE_DIR, "proposals/wagashi.json"), "utf8")) as { traits: { quote: string }[]; directions: { id: string; palette: { colors: { hex: string }[] } }[] };
    const a = proposal.directions.find((d) => d.id === "morning_batch")!;
    const d = parseWagashiADirection(raw(), fixtureDemo());
    expect(d.palette.map((c) => c.hex).sort()).toEqual(a.palette.colors.map((c) => c.hex).sort());
    const quotes = new Set(proposal.traits.map((t) => t.quote));
    for (const label of ["reason 1", "reason 2", "product 1", "product 2", "所在地", "電話"]) expect(quotes.has(d.facts.find((f) => f.label === label)!.quote), label).toBe(true);
    const order = d.mobile_390.order.join(" | ");
    expect(order.indexOf("毎朝炊く粒あん")).toBeLessThan(order.indexOf("dorayaki image"));
  });

  it.each<[string, (r: ReturnType<typeof raw>) => void, string]>([
    ["a quote that is not in the fixture", (r) => { r.facts[1]!.quote = "毎朝炊く北海道産の粒あん"; }, "fact_not_in_fixture"],
    ["a placeholder town", (r) => { r.facts[8]!.quote = "名古屋市東区テスト町"; }, "fact_placeholder"],
    ["the fictional-shop sentence", (r) => { r.facts[5]!.quote = "実在の店舗ではありません。"; }, "fact_placeholder"],
    ["a reservation label", (r) => { (r.web_ui as { hero_link: string }).hero_link = "予約する"; }, "schema"],
    ["a missing fact label", (r) => { r.facts[9]!.label = "所在地"; }, "fact_labels"],
    ["another shop name", (r) => { r.facts[0]!.quote = "架空"; }, "shop_name"],
    ["a menu item as a fact", (r) => { r.facts[3]!.fact_key = "menu_items"; }, "schema"],
  ])("refuses %s", (_name, mutate, reason) => {
    const r = raw();
    mutate(r);
    expect(() => parseWagashiADirection(r, fixtureDemo())).toThrow(new WagashiADirectionError(reason));
  });

  it("refuses a tampered v4 file through the PoC's own loader (POC_INPUT_INVALID)", async () => {
    const bad = raw();
    bad.facts[1]!.quote = "毎朝炊く北海道産の粒あん";
    const repo = mkdtempSync(join(tmpdir(), "v4-bad-"));
    try {
      for (const [rel, body] of [[FIXTURE_PATH, readFileSync(join(REPO, FIXTURE_PATH), "utf8")], [WAGASHI_A_DIRECTION_PATH, JSON.stringify(bad)]] as const) {
        mkdirSync(join(repo, rel, ".."), { recursive: true });
        writeFileSync(join(repo, rel), body);
      }
      await expect(loadPocInputs(repo, "v4")).rejects.toBeInstanceOf(PocInputError);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("is the text the review doc shows, with its sha256", async () => {
    const v4 = buildMockupPrompt(await loadPocInputs(REPO, "v4"));
    expect(promptInDoc()).toBe(v4);
    expect(readFileSync(join(REPO, DOC), "utf8")).toContain(V4_PROMPT_SHA256);
  });
});

/** The fixture's facts as the PoC's demo view (the loader builds the same). */
let demo: Awaited<ReturnType<typeof loadPocInputs>>["demo"] | null = null;
const fixtureDemo = () => demo!;
beforeAll(async () => { demo = (await loadPocInputs(REPO, "v2")).demo; });
