import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FactsPack } from "@/lib/design-agent/artifact/schema";
import { resolveDirection } from "@/lib/design-agent/phase2f/open-direction";
import { buildDesignPrompt, promptVariantOf, shopNeutralRules, V2_FACT_RULES, V2_IMAGE_RULES, type PromptVariant } from "@/lib/design-agent/phase2f/prompt";

// DEV-139 S0 A-2 (PR #283 review H1): the v2.1 PROPOSAL — v2 with its two wagashi-only lines replaced by shop-neutral
// rules built from the facts. Offline: nothing is called. Not activated: only code that passes the variant builds it;
// the CLIs refuse "v2.1". Activating it needs the owner's approval (docs/operations/s0-three-shop-directions.md).

const REPO = resolve(__dirname, "../../../..");
const read = (p: string) => JSON.parse(readFileSync(resolve(REPO, p), "utf8")) as Record<string, unknown>;
const REFS = "design-library/phase2f/references/success-references-v1.json";
const DIR = "design-library/phase2f/directions/wagashi-open-a.json";
const PACKS = ["design-library/phase2f/wagashi-facts-pack.json", "design-library/research/quality-pipeline/poc/bakery/facts-pack.json", "design-library/research/quality-pipeline/poc/cafe/facts-pack.json"];
const open = (version: "v2" | "v2.1"): PromptVariant => {
  const r = resolveDirection(read(DIR), read(REFS));
  if (!r.ok) throw new Error(r.code);
  return { version, direction: r.direction, references: r.references };
};
const build = (route: "B_html_prototype" | "C_hybrid", version: "v2" | "v2.1", pack: string) => buildDesignPrompt({ route, facts: FactsPack.parse(read(pack)), maxAssets: 1, variant: open(version) });

describe("the v2.1 prompt (shop-neutral v2; proposal, not activated)", () => {
  it.each(PACKS)("is v2 with only the wagashi-only lines replaced (%s, routes B and C)", (pack) => {
    for (const route of ["B_html_prototype", "C_hybrid"] as const) {
      const v2 = build(route, "v2", pack).prompt;
      const v21 = build(route, "v2.1", pack).prompt;
      const old = [...V2_FACT_RULES, V2_IMAGE_RULES[route]].join("\n");
      expect(v2.endsWith(old)).toBe(true);
      expect(v21).toBe(`${v2.slice(0, v2.length - old.length)}${shopNeutralRules(FactsPack.parse(read(pack)), route).join("\n")}`);
    }
  });

  it("names no other shop's address or goods: the address rule and the kind come from the facts' own ids", () => {
    const p = build("B_html_prototype", "v2.1", PACKS[1]!).prompt;
    expect(p).not.toContain("名古屋市東区");
    expect(p).not.toMatch(/sweets/);
    const facts = FactsPack.parse(read(PACKS[1]!));
    const id = (k: string) => facts.facts.find((f) => f.key === k)!.id;
    expect(p).toContain(`- Show the address exactly as fact ${id("address")} gives it, in full, as plain text.`);
    expect(p).toContain(`(the shop's kind is fact ${id("category")})`);
    // the v2 prompt for the same shop does carry the wagashi-only lines (the defect v2.1 removes)
    expect(build("B_html_prototype", "v2", PACKS[1]!).prompt).toContain("show only 名古屋市東区");
  });

  it("without an address fact it says to show none (never a placeholder)", () => {
    const facts = FactsPack.parse(read(PACKS[2]!));
    const noAddress = { ...facts, facts: facts.facts.filter((f) => f.key !== "address") };
    expect(shopNeutralRules(noAddress, "B_html_prototype")).toContain("- The facts give no address: show none.");
  });

  it("no command can select it: the parser and the design CLI refuse v2.1, and print no prompt pin", () => {
    expect(promptVariantOf({ route: "B_html_prototype", version: "v2.1", research: undefined, direction: read(DIR), references: read(REFS) })).toEqual({ ok: false, code: "PROMPT_VERSION_NOT_ACTIVATED" });
    const r = spawnSync(process.execPath, ["--import", "tsx", resolve(REPO, "scripts/design-artifact/phase2f-design.ts"), "--print-pin", "--route", "B", "--prompt-version", "v2.1", "--facts", resolve(REPO, PACKS[0]!), "--direction", resolve(REPO, DIR), "--references", resolve(REPO, REFS)], { cwd: REPO, encoding: "utf8", timeout: 120_000 });
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout)).toMatchObject({ status: "refused" });
    expect(r.stdout).not.toContain("prompt_sha256");
  });
});
