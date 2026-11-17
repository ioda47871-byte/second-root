import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FactsPack } from "@/lib/design-agent/artifact/schema";
import { resolveDirection } from "@/lib/design-agent/phase2f/open-direction";
import {
  ACTIVATED_PROMPT_VERSIONS,
  buildDesignPrompt,
  CATEGORY_KINDS,
  promptVariantOf,
  ShopNeutralFactsError,
  shopNeutralFactsStop,
  shopNeutralRules,
  V2_FACT_RULES,
  V2_IMAGE_RULES,
  type PromptVariant,
} from "@/lib/design-agent/phase2f/prompt";

// DEV-139 S0 A-2 (PR #283 review H1), activated by DEV-139 (owner approval 2026-11-17): v2.1 is v2 with its two
// wagashi-only lines replaced by shop-neutral rules built from the facts. Offline: nothing is called.

const REPO = resolve(__dirname, "../../../..");
const read = (p: string) => JSON.parse(readFileSync(resolve(REPO, p), "utf8")) as Record<string, unknown>;
const REFS = "design-library/phase2f/references/success-references-v1.json";
const DIR = "design-library/phase2f/directions/wagashi-open-a.json";
const POC = "design-library/research/quality-pipeline/poc";
/** Packs without テスト values (v2.1 builds for them). The committed wagashi pack has a テスト address (refused). */
const PACKS = [`${POC}/bakery/facts-pack.json`, `${POC}/cafe/facts-pack.json`, `${POC}/wagashi/facts-pack.json`, "design-library/research/three-methods/facts-pack.json"];
const COMMITTED_WAGASHI = "design-library/phase2f/wagashi-facts-pack.json";
const pack = (p: string) => FactsPack.parse(read(p));
const open = (version: "v2" | "v2.1"): PromptVariant => {
  const r = resolveDirection(read(DIR), read(REFS));
  if (!r.ok) throw new Error(r.code);
  return { version, direction: r.direction, references: r.references };
};
const build = (route: "B_html_prototype" | "C_hybrid", version: "v2" | "v2.1", p: string | FactsPack) => buildDesignPrompt({ route, facts: typeof p === "string" ? pack(p) : p, maxAssets: 1, variant: open(version) });
const withValue = (p: FactsPack, key: string, value: string): FactsPack => ({ ...p, facts: p.facts.map((f) => (f.key === key ? { ...f, value } : f)) });

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
const cli = (script: string, args: string[]) => {
  const state = mkdtempSync(join(tmpdir(), "dev139-v21-"));
  temps.push(state);
  const r = spawnSync(process.execPath, ["--import", "tsx", resolve(REPO, script), ...args], { cwd: REPO, encoding: "utf8", timeout: 120_000, env: { ...process.env, SR_PHASE2F_STATE: state } });
  return { status: r.status, out: JSON.parse(r.stdout || "{}") as Record<string, unknown>, stdout: r.stdout, state };
};
const pinArgs = (version: string, facts = PACKS[0]!) => ["--print-pin", "--route", "B", "--prompt-version", version, "--facts", resolve(REPO, facts), "--direction", resolve(REPO, DIR), "--references", resolve(REPO, REFS)];

describe("the v2.1 prompt (shop-neutral v2, activated)", () => {
  it.each(PACKS)("is v2 with only the wagashi-only lines replaced (%s, routes B and C)", (p) => {
    for (const route of ["B_html_prototype", "C_hybrid"] as const) {
      const v2 = build(route, "v2", p).prompt;
      const v21 = build(route, "v2.1", p).prompt;
      const old = [...V2_FACT_RULES, V2_IMAGE_RULES[route]].join("\n");
      expect(v2.endsWith(old)).toBe(true);
      expect(v21).toBe(`${v2.slice(0, v2.length - old.length)}${shopNeutralRules(pack(p), route).join("\n")}`);
      expect(v21).not.toContain("show only");
      expect(v21).not.toMatch(/sweets;|the sweets/);
    }
  });

  it.each(PACKS)("takes the address, the kind and the products from the facts' own ids (%s)", (p) => {
    const facts = pack(p);
    const prompt = build("B_html_prototype", "v2.1", p).prompt;
    const fact = (k: string) => facts.facts.find((f) => f.key === k)!;
    // the address in full: the rule names the fact, and the facts block quotes its whole value
    expect(prompt).toContain(`- Show the address exactly as fact ${fact("address").id} gives it, in full, as plain text.`);
    expect(prompt).toContain(JSON.stringify(fact("address").value));
    // what the shop is: from the category code, with the code's meaning, never another shop's goods
    expect(prompt).toContain(`fact ${fact("category").id} is the category code ${JSON.stringify(fact("category").value)}, which means ${CATEGORY_KINDS[fact("category").value]}; the description (fact ${fact("description").id}) and the products say exactly what it makes or serves.`);
    // the products: every service_N (or menu_item_N) fact, by id, in order
    const products = facts.facts.filter((f) => /^(?:service|menu_item)_\d+$/.test(f.key)).map((f) => f.id);
    expect(products.length).toBeGreaterThan(0);
    expect(prompt).toContain(`- The shop's products are facts ${products.join(", ")}: show them by these names, exactly as written.`);
  });

  it("names the confectioner as 菓子 (和菓子 or 洋菓子) from its category code, the bakery as パン and the café as 喫茶 (review L2), and only the kind: what it sells comes from the facts (PR #285 review L1)", () => {
    for (const kind of Object.values(CATEGORY_KINDS)) expect(kind).not.toMatch(/bread|coffee|light food|sweets|:/);
    expect(shopNeutralRules(pack(`${POC}/wagashi/facts-pack.json`), "B_html_prototype").join("\n")).toContain('"baked_goods", which means a confectioner (菓子), Japanese (和菓子) or Western (洋菓子);');
    expect(shopNeutralRules(pack(`${POC}/bakery/facts-pack.json`), "B_html_prototype").join("\n")).toContain('"bakery", which means a bakery (パン);');
    expect(shopNeutralRules(pack(`${POC}/cafe/facts-pack.json`), "C_hybrid").join("\n")).toContain('"cafe", which means a café (喫茶);');
  });

  it("refuses facts it would contradict, by name, before any prompt exists (review L2)", () => {
    // the committed wagashi pack: a テスト address cannot be shown in full AND never shown
    expect(shopNeutralFactsStop(pack(COMMITTED_WAGASHI))).toBe("FACTS_ADDRESS_PLACEHOLDER");
    expect(() => build("B_html_prototype", "v2.1", COMMITTED_WAGASHI)).toThrow(ShopNeutralFactsError);
    expect(() => build("B_html_prototype", "v2.1", COMMITTED_WAGASHI)).toThrow("FACTS_ADDRESS_PLACEHOLDER");
    const cafe = pack(`${POC}/cafe/facts-pack.json`);
    expect(shopNeutralFactsStop(withValue(cafe, "service_2", "テスト厚切りトースト"))).toBe("FACTS_PRODUCT_PLACEHOLDER");
    expect(shopNeutralFactsStop(withValue(cafe, "category", "bicycle_repair"))).toBe("FACTS_CATEGORY_UNSUPPORTED");
    expect(shopNeutralFactsStop({ ...cafe, facts: cafe.facts.filter((f) => f.key !== "category") })).toBe("FACTS_CATEGORY_UNSUPPORTED");
    // a テスト value elsewhere (not one the rules tell the model to show) is left to the general rule
    expect(shopNeutralFactsStop(withValue(cafe, "access", "テスト線テスト駅"))).toBeNull();
    // v2 itself is unchanged for the committed pack (its own address rule hides the テスト part)
    expect(build("B_html_prototype", "v2", COMMITTED_WAGASHI).prompt).toContain("show only 名古屋市東区");
  });

  it("without an address or products it says to show none (never a placeholder)", () => {
    const facts = pack(`${POC}/cafe/facts-pack.json`);
    expect(shopNeutralRules({ ...facts, facts: facts.facts.filter((f) => f.key !== "address") }, "B_html_prototype")).toContain("- The facts give no address: show none.");
    expect(shopNeutralRules({ ...facts, facts: facts.facts.filter((f) => !f.key.startsWith("service_")) }, "B_html_prototype")).toContain("- The facts name no products: show none and invent none.");
  });

  it("the parser, given the facts, refuses a v2.1 request whose facts the rules would contradict (v2 is not affected)", () => {
    const o = { route: "B_html_prototype" as const, research: undefined, direction: read(DIR), references: read(REFS), facts: pack(COMMITTED_WAGASHI) };
    expect(promptVariantOf({ ...o, version: "v2.1" })).toEqual({ ok: false, code: "FACTS_ADDRESS_PLACEHOLDER" });
    expect(promptVariantOf({ ...o, version: "v2" }).ok).toBe(true);
    expect(promptVariantOf({ ...o, version: "v2.1", facts: pack(PACKS[0]!) }).ok).toBe(true);
  });

  it("is selectable: the parser gives the v2.1 variant with the same inputs as v2, and refuses what v2 refuses", () => {
    const v = promptVariantOf({ route: "B_html_prototype", version: "v2.1", research: undefined, direction: read(DIR), references: read(REFS) });
    expect(v.ok && v.variant.version).toBe("v2.1");
    expect(promptVariantOf({ route: "B_html_prototype", version: "v2.1", research: undefined })).toEqual({ ok: false, code: "DIRECTION_REQUIRED" });
    expect(promptVariantOf({ route: "B_html_prototype", version: "v2.1", research: {}, direction: read(DIR), references: read(REFS) })).toEqual({ ok: false, code: "RESEARCH_NEEDS_V1_1" });
    expect(ACTIVATED_PROMPT_VERSIONS).toEqual(["v1", "v1.1", "v2", "v2.1", "tm0"]);
  });

  it("the design CLI prints the v2.1 pin (route B, with the direction and its references), equal to the builder's", { timeout: 120_000 }, () => {
    const r = cli("scripts/design-artifact/phase2f-design.ts", pinArgs("v2.1"));
    expect(r.status).toBe(0);
    const built = build("B_html_prototype", "v2.1", PACKS[0]!);
    expect(r.out).toMatchObject({ mode: "print_pin", route: "B_html_prototype", prompt_version: "v2.1", direction: { direction_id: read(DIR).direction_id }, prompt_sha256: built.sha256, prompt_chars: built.chars });
    const v = open("v2.1");
    expect(r.out.references).toEqual(v.version === "v2.1" ? v.references.map((x) => ({ id: x.id, webp_sha256: x.webp_sha256 })) : null);
    expect(readdirSync(r.state)).toEqual([]);
  });

  it("the design CLI refuses the committed wagashi pack under v2.1 by name, printing no pin", { timeout: 120_000 }, () => {
    const r = cli("scripts/design-artifact/phase2f-design.ts", pinArgs("v2.1", COMMITTED_WAGASHI));
    expect({ status: r.status, out: r.out }).toEqual({ status: 2, out: { status: "refused", code: "FACTS_ADDRESS_PLACEHOLDER" } });
    expect(r.stdout).not.toContain("prompt_sha256");
  });
});

describe("versions that are not activated (review L1)", () => {
  it("the parser tells them apart from the activated versions (v3: not activated; anything else: unknown)", () => {
    const of = (version: string) => promptVariantOf({ route: "B_html_prototype", version, research: undefined });
    expect(of("v3")).toEqual({ ok: false, code: "PROMPT_VERSION_NOT_ACTIVATED" });
    for (const v of ["v9", "V2.1", "v2.2"]) expect(of(v)).toEqual({ ok: false, code: "PROMPT_VERSION_UNKNOWN" });
    for (const v of ACTIVATED_PROMPT_VERSIONS) expect(["PROMPT_VERSION_NOT_ACTIVATED", "PROMPT_VERSION_UNKNOWN"]).not.toContain((of(v) as { code?: string }).code);
  });

  it("the design CLI leaves a --prompt-version without a value to the usage check", { timeout: 120_000 }, () => {
    const r = cli("scripts/design-artifact/phase2f-design.ts", ["--print-pin", "--route", "B", "--facts", resolve(REPO, PACKS[0]!), "--prompt-version"]);
    expect({ status: r.status, out: r.out }).toEqual({ status: 2, out: { status: "refused", code: "USAGE" } });
  });

  it.each(["v3", "v9", "v2.2"])("both CLIs refuse --prompt-version %s with PROMPT_VERSION_NOT_ACTIVATED (never USAGE), writing nothing", { timeout: 120_000 }, (version) => {
    const refused = { status: 2, out: { status: "refused", code: "PROMPT_VERSION_NOT_ACTIVATED" } };
    // the open-direction shape, a brief, or a malformed line: the version refusal wins in every case
    for (const extra of [[], ["--no-such-flag"]]) {
      const d = cli("scripts/design-artifact/phase2f-design.ts", [...pinArgs(version), ...extra]);
      expect({ status: d.status, out: d.out }).toEqual(refused);
      expect(d.stdout).not.toContain("prompt_sha256");
      expect(readdirSync(d.state)).toEqual([]);
    }
    const b = cli("scripts/design-artifact/phase2f-design.ts", ["--print-pin", "--route", "B", "--prompt-version", version, "--facts", resolve(REPO, COMMITTED_WAGASHI), "--brief", resolve(REPO, "design-library/phase2f/wagashi-brief-v4.json")]);
    expect({ status: b.status, out: b.out }).toEqual(refused);
    const s = cli("scripts/design-artifact/phase2f-steps.ts", ["--package", "--route", "B", "--facts", resolve(REPO, PACKS[0]!), "--design", "/nonexistent", "--out", "/nonexistent/out", "--result", "/nonexistent/r.json", "--artifact-id", "a", "--shop-id", "s", "--shop-name", "n", "--prompt-version", version, "--direction", resolve(REPO, DIR), "--references", resolve(REPO, REFS)]);
    expect({ status: s.status, out: s.out }).toEqual(refused);
    expect(readdirSync(s.state)).toEqual([]);
  });
});
