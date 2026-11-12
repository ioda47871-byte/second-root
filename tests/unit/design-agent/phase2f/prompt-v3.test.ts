import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FactsPack } from "@/lib/design-agent/artifact/schema";
import { resolveDirection } from "@/lib/design-agent/phase2f/open-direction";
import { B_V11_RULES, buildDesignPrompt, COPY_V3_RULES, DesignBrief, PromptVariantError, promptVariantOf, V2_FACT_RULES, type PromptVariant } from "@/lib/design-agent/phase2f/prompt";

// DEV-199f (Issue #258): the v3 copy-rules PROPOSAL. Offline: no Codex, no image tool, no real generation.
// v3 is not activated: only code that passes the variant explicitly builds it; every CLI refuses "v3".

const REPO = resolve(__dirname, "../../../..");
const REFS = "design-library/phase2f/references/success-references-v1.json";
const DIRS = ["design-library/phase2f/directions/wagashi-open-a.json", "design-library/phase2f/directions/wagashi-open-b.json"];
const read = (p: string) => JSON.parse(readFileSync(resolve(REPO, p), "utf8")) as Record<string, unknown>;
const facts = FactsPack.parse(read("design-library/phase2f/wagashi-facts-pack.json"));
const brief = DesignBrief.parse(read("design-library/phase2f/wagashi-brief-v4.json"));
const open = (version: "v2" | "v3", dir: string): PromptVariant => {
  const r = resolveDirection(read(dir), read(REFS));
  if (!r.ok) throw new Error(r.code);
  return { version, direction: r.direction, references: r.references };
};
const build = (route: "B_html_prototype" | "C_hybrid", version: "v2" | "v3", dir = DIRS[0]!) => buildDesignPrompt({ route, facts, maxAssets: 1, variant: open(version, dir) });
const rules = COPY_V3_RULES.join("\n");

describe("the v3 prompt (proposal, not activated)", () => {
  it("is pinned for both wagashi directions on routes B and C", () => {
    expect([build("B_html_prototype", "v3", DIRS[0]), build("C_hybrid", "v3", DIRS[0]), build("B_html_prototype", "v3", DIRS[1]), build("C_hybrid", "v3", DIRS[1])].map((b) => [b.sha256, b.chars])).toEqual([
      ["3ca3f33da64c669a90bc8a9e912c4199136d8433e3031c9482d25a20c7b0f487", 9594],
      ["09de0749fabee3ae9705e37cb2aeecf242e28b8a67c3ff0f08a31153c7880fff", 10040],
      ["a90d99c0b2a69ebb367e9d0ad8db06944115407aa81f2045689f874c074ee4a4", 9476],
      ["faf40d24a92dce62d47dc4911c0044b015cbeef5e3fa5d60a76fc31786fc39f2", 9922],
    ]);
    // v3 = v2, a newline, then the rules: 9594 - 6996 - 1
    expect(rules.length).toBe(2597);
  });

  it("is v2 + the copy rules at the end, byte for byte; nothing else differs", () => {
    for (const route of ["B_html_prototype", "C_hybrid"] as const)
      for (const dir of DIRS) expect(build(route, "v3", dir).prompt).toBe([build(route, "v2", dir).prompt, ...COPY_V3_RULES].join("\n"));
  });

  it("keeps v2's fact, technical and verbatim rules (the copy rules are added, never swapped in)", () => {
    const p = build("B_html_prototype", "v3").prompt;
    expect(p).toContain("- Text shown must be facts (verbatim) or short neutral UI labels.");
    expect(p).toContain("never invent prices, reviews, history, people or claims");
    for (const r of [...B_V11_RULES, ...V2_FACT_RULES]) expect(p).toContain(r);
  });

  it("carries the section-role rules, the five axes as guidance and the never-invent list", () => {
    // section roles: each section has a job the visitor can name, its text cites facts, no fact = no section
    expect(rules).toMatch(/Give each section one job a visitor can name: what they learn there/);
    expect(rules).toMatch(/Its live_text lists the facts it shows/);
    expect(rules).toMatch(/A content section with no fact to show is dropped, not filled with decoration; navigation made only of neutral ui_label words .* is not a content section/);
    // the five axes, in the spec's order, framed as guidance and not a blacklist
    expect(rules).toMatch(/five axes\. They guide the writing; they are not a list of banned words/);
    expect(COPY_V3_RULES.filter((l) => /^ {2}[1-5]\. /.test(l)).map((l) => l.slice(5, l.indexOf(":")))).toEqual(["Natural Japanese", "This shop only", "Useful", "Restraint and variety", "Faithful"]);
    // facts verbatim or neutral labels, for every shop on this route (the answer schema has no creative field)
    expect(rules).toMatch(/Facts and labels only, for every shop: each text shown is a fact's value quoted verbatim \(fact_ref\) or a short neutral UI label \(ui_label\)/);
    expect(rules).toMatch(/Never rephrase, paraphrase, shorten mid-sentence, merge or embellish a fact/);
    expect(rules).toMatch(/Write no slogan, tagline, motto, poem or other creative line/);
    // review M1: v2's address rule is the one allowed partial value, so the two rules do not conflict
    expect(rules).toMatch(/One exception: the address rule above \(show only 名古屋市東区\) is the one allowed partial value of a fact/);
    expect(V2_FACT_RULES[0]).toContain("for the address show only 名古屋市東区");
    // review L5: labels are plain sign words naming only what the facts contain
    expect(rules).toMatch(/labels are plain words a shop sign would use \(メニュー, 営業時間\), naming only what the facts contain/);
    // never invent (spec axis 5)
    for (const w of ["a price", "a booking or reservation route", "stock or availability", "years in business or of experience", "words of the owner or staff", "a customer review or voice"]) expect(rules).toContain(w);
    expect(rules).toMatch(/Never invent a price/);
    expect(rules).toMatch(/leave it out; never fill it from what shops of this kind usually do/);
    // one strong line may stay, and it is a fact; plain labels are not penalised
    expect(rules).toMatch(/At most one line on the page carries the design's voice, and it is a fact's value placed prominently .*never a new sentence/);
    expect(rules).toMatch(/Plain is not a fault: ordinary labels such as メニュー, アクセス and 営業時間 are good/);
  });

  it("grants no permission to invent, rephrase or write creative copy", () => {
    const p = build("C_hybrid", "v3").prompt;
    const permissive = [
      /\b(you )?(may|can|are free to|feel free to|are allowed to)\s+(invent|rephrase|paraphrase|reword|rewrite|embellish|summari[sz]e|create (a )?(slogan|tagline|catch))/i,
      /\bcreative_expression\b/,
      /\bcatch ?(phrase|copy)s? (are|is) (allowed|welcome|fine)\b/i,
      /\bown words\b(?! that say)/i,
    ];
    for (const re of permissive) expect(rules).not.toMatch(re);
    // every use of "invent" in the whole prompt is a prohibition
    for (const line of p.split("\n").filter((l) => /invent/i.test(l))) expect(line).toMatch(/\bnever invent\b|\bNever invent\b/);
    // the rules name no shop, model or product (the address exception repeats v2's fixture rule, review M1, and adds
    // no new fact)
    expect(rules).not.toMatch(/菓|和菓子|wagashi|輪|自転車|SR-001|gpt|claude|codex|opus|sonnet/i);
    // no line asks the page to sound poetic
    for (const line of COPY_V3_RULES.filter((l) => /poetic/i.test(l))) expect(line).toMatch(/Do not make the page sound poetic/);
  });
});

describe("existing prompts and the default selection are unchanged", () => {
  it("the default (no variant / v1) is still the pinned v1; v1.1 and v2 keep their pins", () => {
    const v1 = buildDesignPrompt({ route: "B_html_prototype", facts, brief, maxAssets: 1 });
    expect([v1.sha256, v1.chars]).toEqual(["a2fdd00365087046c44f03b4c3ea43530046af658b017ae5229fd7577c817954", 5706]);
    const v11 = buildDesignPrompt({ route: "B_html_prototype", facts, brief, maxAssets: 1, variant: { version: "v1.1", research: null } });
    expect([v11.sha256, v11.chars]).toEqual(["c5973afbdc87b750cb12f05438c6a2b328407b3d226ad0c89fe44107bbada243", 6010]);
    const v2 = build("B_html_prototype", "v2");
    expect([v2.sha256, v2.chars]).toEqual(["0ad56d85df1c713047d638664fa4872f710003c841f2f96db0fd5f397fc46070", 6996]);
    // no copy rule leaks into the earlier versions
    for (const p of [v1.prompt, v11.prompt, v2.prompt, build("C_hybrid", "v2").prompt]) expect(p).not.toContain(COPY_V3_RULES[2]!);
  });

  it("the CLI parser still defaults to v1 and refuses v3 as not activated (no command can select it)", () => {
    const of = (version: string | undefined, extra: Partial<Parameters<typeof promptVariantOf>[0]> = {}) => {
      const r = promptVariantOf({ route: "B_html_prototype", version, research: undefined, ...extra });
      return r.ok ? r.variant.version : r.code;
    };
    expect(of(undefined)).toBe("v1");
    expect(of("v3")).toBe("PROMPT_VERSION_NOT_ACTIVATED");
    expect(of("v3", { direction: read(DIRS[0]!), references: read(REFS) })).toBe("PROMPT_VERSION_NOT_ACTIVATED");
    expect(of("v3", { route: "C_hybrid", direction: read(DIRS[0]!), references: read(REFS) } as never)).toBe("PROMPT_VERSION_NOT_ACTIVATED");
    expect(of("v4")).toBe("PROMPT_VERSION_UNKNOWN");
  });

  it("v3 takes no brief, like v2", () => {
    expect(() => buildDesignPrompt({ route: "B_html_prototype", facts, brief, maxAssets: 1, variant: open("v3", DIRS[0]!) })).toThrow(PromptVariantError);
  });

  it("the design CLI refuses --prompt-version v3 even for --print-pin, and writes nothing", () => {
    const state = mkdtempSync(join(tmpdir(), "dev199f-pin-"));
    const run = (args: string[]) => {
      const r = spawnSync(process.execPath, ["--import", "tsx", resolve(REPO, "scripts/design-artifact/phase2f-design.ts"), "--print-pin", "--route", "B", "--facts", resolve(REPO, "design-library/phase2f/wagashi-facts-pack.json"), "--prompt-version", "v3", ...args], {
        encoding: "utf8",
        env: { ...process.env, SR_PHASE2F_STATE: state },
      });
      expect(r.stdout).not.toContain("prompt_sha256");
      return { status: r.status, out: JSON.parse(r.stdout || "{}") as Record<string, unknown> };
    };
    // review L4: the v3 refusal wins in every case: the v2 shape (direction + references), a brief, nothing more, or an
    // unknown flag never turns it into USAGE
    const refused = { status: 2, out: { status: "refused", code: "PROMPT_VERSION_NOT_ACTIVATED" } };
    expect(run(["--references", resolve(REPO, REFS), "--direction", resolve(REPO, DIRS[0]!)])).toMatchObject(refused);
    expect(run(["--brief", resolve(REPO, "design-library/phase2f/wagashi-brief-v4.json")])).toMatchObject(refused);
    expect(run([])).toMatchObject(refused);
    expect(run(["--no-such-flag"])).toMatchObject(refused);
    expect(readdirSync(state)).toEqual([]);
  }, 60_000);

  it("the steps CLI refuses --prompt-version v3 before anything else (the v2 shape included), and writes nothing", () => {
    const state = mkdtempSync(join(tmpdir(), "dev199f-steps-"));
    const out = join(state, "out");
    const r = spawnSync(process.execPath, ["--import", "tsx", resolve(REPO, "scripts/design-artifact/phase2f-steps.ts"), "--package", "--route", "B", "--facts", resolve(REPO, "design-library/phase2f/wagashi-facts-pack.json"), "--design", join(state, "design"), "--out", out, "--result", join(state, "result.json"), "--artifact-id", "a", "--shop-id", "s", "--shop-name", "n", "--prompt-version", "v3", "--direction", resolve(REPO, DIRS[0]!), "--references", resolve(REPO, REFS)], {
      encoding: "utf8",
      env: { ...process.env, SR_PHASE2F_STATE: state },
    });
    expect({ status: r.status, out: JSON.parse(r.stdout || "{}") as Record<string, unknown> }).toMatchObject({ status: 2, out: { status: "refused", code: "PROMPT_VERSION_NOT_ACTIVATED" } });
    expect(readdirSync(state)).toEqual([]);
  }, 60_000);
});

describe("the design-director copy review v2 (proposal, not loaded by the skill)", () => {
  const SKILL = ".claude/skills/second-root-design-director";
  const proposal = readFileSync(resolve(REPO, "docs/design/design-director-copy-review-v2.md"), "utf8");

  it("is not loaded: neither the skill nor its references name it", () => {
    const refs = readdirSync(resolve(REPO, SKILL, "references"));
    expect(refs).not.toContain("copy-review.md");
    for (const f of ["SKILL.md", ...refs.map((n) => `references/${n}`)]) expect(readFileSync(resolve(REPO, SKILL, f), "utf8")).not.toMatch(/copy-review-v2|copy-review\.md/);
  });

  it("says activation needs the owner's approval and covers the review rules", () => {
    expect(proposal).toMatch(/提案 \/ 未有効/);
    expect(proposal).toMatch(/有効にする .*オーナーの承認が要る/);
    for (const s of ["自然な日本語", "店舗固有性", "情報の有用性", "表現の抑制と一貫性", "事実・出典の正しさ", "COPY_RHETORICAL_OVERUSE", "HOLD", "claim_type` を変えない", "事実は逐語のまま", "quality_research_fictional", "real_shop_proposal"]) expect(proposal).toContain(s);
  });
});
