import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkDirectionSet, type DirectionSet } from "../../../../lib/design-agent/quality-pipeline/direction-set";
import { structuralSimilarity, THRESHOLDS } from "../../../../lib/design-agent/structure/descriptor";
import { loadInputs } from "../../../../scripts/design-artifact/direction-set";

// DEV-139 Stage 0 A-2: three fictional shops (bakery, café, confectionery), each with its own art_direction_set_v0 of
// three directions, and the six directions selected for the generation experiment. READY_FOR_COMPS is "ready to draw
// comps", never a quality verdict. The prompt pins are re-built here by the real CLIs as subprocesses (no model call),
// so this test imports nothing from the isolated Phase 2f modules. See docs/operations/s0-three-shop-directions.md.

const REPO = resolve(__dirname, "../../../..");
const POC = "design-library/research/quality-pipeline/poc";
const SHOPS = ["bakery", "cafe", "wagashi"] as const;
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const readJson = <T = unknown>(p: string) => JSON.parse(readFileSync(resolve(REPO, p), "utf8")) as T;
const setOf = (shop: string) => readJson<DirectionSet>(`${POC}/${shop}/direction-set.json`);
const factsOf = (shop: string) => readJson<{ shop_id: string; facts: Array<{ id: string; key: string; value: string }> }>(`${POC}/${shop}/facts-pack.json`);

type Selection = {
  schema: "s0_generation_selection_v0";
  pin: { route: string; prompt_version: string };
  status: { design_generated: boolean; owner_approval: string; sendable: boolean };
  shops: Array<{
    dir: string;
    shop_id: string;
    facts_sha256: string;
    direction_set_sha256: string;
    selected: Array<{ direction_id: string; composition: { hero: string; flow: string }; prompt_sha256: string; prompt_chars: number; reference_count: number }>;
    not_selected: Array<{ direction_id: string }>;
  }>;
};
const selection = readJson<Selection>(`${POC}/s0-generation-selection.json`);

describe("S0 A-2: three fictional shops, three directions each (C1–C7)", () => {
  it.each(SHOPS)("%s: the direction set is READY_FOR_COMPS against its own facts pack", (shop) => {
    const r = checkDirectionSet(setOf(shop), loadInputs(resolve(REPO, POC, shop, "facts-pack.json")));
    expect(r.findings).toEqual([]);
    expect(r.status).toBe("READY_FOR_COMPS");
    expect(r.note).toMatch(/not a quality verdict/);
    expect(setOf(shop).directions).toHaveLength(3);
  });

  it("reuses the committed bakery and confectionery packs byte for byte (no fork)", () => {
    expect(sha(readFileSync(resolve(REPO, POC, "bakery/facts-pack.json")))).toBe(sha(readFileSync(resolve(REPO, "design-library/research/three-methods/facts-pack.json"))));
    expect(sha(readFileSync(resolve(REPO, POC, "wagashi/facts-pack.json")))).toBe(sha(readFileSync(resolve(REPO, "design-library/phase2f/wagashi-facts-pack.json"))));
    expect(factsOf("bakery").shop_id).toBe("fictional-bakery-komugi");
    expect(factsOf("wagashi").shop_id).toBe("fictional-wagashi");
  });

  it("the new café pack is plainly fictional (name, address, phone placeholder, disclaimer)", () => {
    const f = Object.fromEntries(factsOf("cafe").facts.map((x) => [x.key, x.value]));
    expect(factsOf("cafe").shop_id).toBe("fictional-cafe-nikai");
    expect(f.name).toMatch(/^架空/);
    expect(f.address).toMatch(/^架空市架空区/);
    expect(f.phone).toMatch(/^000-/);
    expect(f.description).toContain("実在の店舗ではありません");
    for (const k of Object.keys(f).filter((k) => k.startsWith("menu_item_"))) expect(f[k]).toMatch(/^架空/);
    // no ordering or reservation words in the facts themselves (the page rules forbid them)
    for (const v of Object.values(f)) expect(v).not.toMatch(/注文|予約|カート/);
  });

  it("no direction writes a fact value that contains テスト (those are never shown)", () => {
    for (const shop of SHOPS) {
      const hidden = factsOf(shop).facts.filter((x) => x.value.includes("テスト")).map((x) => x.value);
      const text = JSON.stringify(setOf(shop).directions);
      for (const v of hidden) expect(text, `${shop}: ${v}`).not.toContain(v);
    }
  });

  it("the nine directions are nine different hero × flow pairs (no shop is another re-skinned)", () => {
    const pairs = SHOPS.flatMap((s) => setOf(s).directions.map((d) => `${d.composition.hero}/${d.composition.flow}`));
    expect(pairs).toHaveLength(9);
    expect(new Set(pairs).size).toBe(9);
  });

  it("checklist B6 inside each shop: at most 1 of the 8 declared aspects shared by any two directions", () => {
    const aspects = ["hero", "flow", "navigation", "reading_path", "section_layouts", "transitions", "text_direction", "imagery"] as const;
    for (const shop of SHOPS) {
      const ds = setOf(shop).directions;
      for (let i = 0; i < ds.length; i++)
        for (let j = i + 1; j < ds.length; j++) {
          const same = aspects.filter((k) => JSON.stringify(ds[i]!.descriptor[k]?.value) === JSON.stringify(ds[j]!.descriptor[k]?.value));
          expect(same.length, `${ds[i]!.id}|${ds[j]!.id}: ${same.join(",")}`).toBeLessThanOrEqual(1);
        }
    }
  });
});

describe("S0 A-2: the six directions selected for the generation experiment", () => {
  const selected = selection.shops.flatMap((s) => s.selected.map((d) => ({ shop: s, d })));

  it("two per shop, six in all, each a direction of that shop's set; the record is pinned to the committed bytes", () => {
    expect(selection.shops.map((s) => s.dir)).toEqual(SHOPS.map((s) => `${POC}/${s}`));
    expect(selection.status).toEqual({ design_generated: false, owner_approval: "required", sendable: false, note: expect.any(String) });
    expect(selection.pin).toMatchObject({ route: "B_html_prototype", prompt_version: "v2" });
    expect(selected).toHaveLength(6);
    for (const s of selection.shops) {
      const set = readJson<DirectionSet>(`${s.dir}/direction-set.json`);
      expect(s.shop_id).toBe(set.shop_id);
      expect(s.facts_sha256).toBe(sha(readFileSync(resolve(REPO, s.dir, "facts-pack.json"))));
      expect(s.facts_sha256).toBe(set.facts_sha256);
      expect(s.direction_set_sha256).toBe(sha(readFileSync(resolve(REPO, s.dir, "direction-set.json"))));
      expect(s.selected).toHaveLength(2);
      const ids = [...s.selected.map((d) => d.direction_id), ...s.not_selected.map((d) => d.direction_id)].sort();
      expect(ids).toEqual(set.directions.map((d) => d.id).sort());
      for (const d of s.selected) expect(d.composition).toEqual(set.directions.find((x) => x.id === d.direction_id)!.composition);
    }
  });

  it("no two of the six share a skeleton (structural similarity below the siblings threshold, across shops too)", () => {
    const desc = selected.map(({ shop, d }) => ({ id: d.direction_id, descriptor: readJson<DirectionSet>(`${shop.dir}/direction-set.json`).directions.find((x) => x.id === d.direction_id)!.descriptor }));
    for (let i = 0; i < desc.length; i++)
      for (let j = i + 1; j < desc.length; j++)
        expect(structuralSimilarity(desc[i]!.descriptor, desc[j]!.descriptor), `${desc[i]!.id}|${desc[j]!.id}`).toBeLessThan(THRESHOLDS.siblings_same_skeleton);
  });

  // the real CLIs as separate processes: design input, then the existing prompt pin (--print-pin: no model, no approval)
  const root = mkdtempSync(join(tmpdir(), "secondroot-s0-a2-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const tsx = (script: string, ...args: string[]) => {
    const r = spawnSync(process.execPath, ["--import", "tsx", join(REPO, script), ...args], { cwd: REPO, encoding: "utf8", timeout: 120_000, env: { ...process.env } });
    let out: Record<string, unknown> | null = null;
    try {
      out = JSON.parse(r.stdout) as Record<string, unknown>;
    } catch {
      out = null;
    }
    return { status: r.status, out, stderr: r.stderr };
  };

  it.each(selected.map(({ shop, d }) => [d.direction_id, shop, d] as const))("%s: the recorded prompt SHA-256 and length are rebuilt by the pin CLI", { timeout: 300_000 }, (id, shop, d) => {
    const out = join(root, id);
    const facts = resolve(REPO, shop.dir, "facts-pack.json");
    const input = tsx("scripts/sales/demo-version/prepare-design-input.ts", "--facts", facts, "--directions", resolve(REPO, shop.dir, "direction-set.json"), "--direction-id", id, "--out", out);
    expect(input.status, input.stderr).toBe(0);
    expect(input.out).toMatchObject({ facts_sha256: shop.facts_sha256, prompt_pin_required: true, sendable: false });
    const pin = tsx("scripts/design-artifact/phase2f-design.ts", "--print-pin", "--route", "B", "--prompt-version", "v2", "--facts", facts, "--direction", join(out, "direction.json"), "--references", join(out, "references.json"));
    expect(pin.status, pin.stderr).toBe(0);
    expect(pin.out).toMatchObject({ mode: "print_pin", route: "B_html_prototype", prompt_version: "v2", direction: { direction_id: id, composition: d.composition } });
    expect(pin.out?.prompt_sha256).toBe(d.prompt_sha256);
    expect(pin.out?.prompt_chars).toBe(d.prompt_chars);
    expect((pin.out?.references as unknown[]).length).toBe(d.reference_count);
  });
});
