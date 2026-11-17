import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FactsPack } from "@/lib/design-agent/artifact/schema";
import { resolveDirection } from "@/lib/design-agent/phase2f/open-direction";
import { buildDesignPrompt } from "@/lib/design-agent/phase2f/prompt";
import { demoContentFromFactsBytes } from "@/lib/demo-version-package/facts-content";
import { isNagoyaAddress } from "@/lib/sales/normalize";
import { checkDirectionSet, type DirectionSet } from "../../../../lib/design-agent/quality-pipeline/direction-set";
import { loadInputs } from "../../../../scripts/design-artifact/direction-set";

// DEV-139 Stage 0 A-2: three fictional shops (bakery, café, confectionery), each with its own art_direction_set_v0 of
// three directions on a facts-path edition of its facts, and the six directions selected for the generation experiment.
// READY_FOR_COMPS is "ready to draw comps", never a quality verdict. The v2 pins are rebuilt by the real CLIs as
// subprocesses (no model call); the v2.1 candidate pins (a proposal no CLI can select) by the prompt builder directly.
// The structural similarity of the six is NOT asserted here: the structure vocabulary may be imported only by its own
// module and its listed users (tests/unit/design-agent/structure/structure.test.ts); the measured values are in
// docs/operations/s0-three-shop-directions.md, and the C2 check above already holds siblings under its threshold.

const REPO = resolve(__dirname, "../../../..");
const POC = "design-library/research/quality-pipeline/poc";
const SHOPS = ["bakery", "cafe", "wagashi"] as const;
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const readJson = <T = unknown>(p: string) => JSON.parse(readFileSync(resolve(REPO, p), "utf8")) as T;
const setOf = (shop: string) => readJson<DirectionSet>(`${POC}/${shop}/direction-set.json`);
const factsOf = (shop: string) => readJson<{ shop_id: string; facts: Array<{ id: string; key: string; value: string }> }>(`${POC}/${shop}/facts-pack.json`);

type Pin = { prompt_sha256: string; prompt_chars: number };
type Selection = {
  schema: "s0_generation_selection_v0";
  blockers: Array<{ id: string }>;
  pin: { route: string };
  status: { design_generated: boolean; owner_approval: string; sendable: boolean };
  shops: Array<{
    dir: string;
    shop_id: string;
    facts_sha256: string;
    direction_set_sha256: string;
    selected: Array<{ direction_id: string; composition: { hero: string; flow: string }; reference_count: number; pins: { v2: Pin & { safe_to_run_under_current_version: boolean }; "v2.1": Pin & { status: string } } }>;
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

  it.each(SHOPS)("%s: the pack is a facts-path edition (every key mapped, Nagoya-format address, a seedable category) and plainly fictional", (shop) => {
    const bytes = readFileSync(resolve(REPO, POC, shop, "facts-pack.json"));
    const content = demoContentFromFactsBytes(bytes);
    expect(isNagoyaAddress(String(content.address))).toBe(true);
    expect(String(content.address)).toMatch(/^名古屋市.+区架空町/);
    expect(["bakery", "baked_goods", "cafe"]).toContain(content.category);
    const f = Object.fromEntries(factsOf(shop).facts.map((x) => [x.key, x.value]));
    expect(f.name).toMatch(/架空/);
    expect(f.description).toContain("実在の店舗ではありません");
    expect(f.access).toMatch(/^架空線架空駅/);
    for (const [k, v] of Object.entries(f)) {
      if (k.startsWith("service_")) expect(v).toMatch(/^架空/);
      expect(k).not.toMatch(/^menu_item_/);
      expect(v).not.toContain("テスト");
      expect(v).not.toMatch(/注文|予約|カート/);
    }
  });

  it("phone numbers are placeholders, and the reserved three-methods shop is not reused", () => {
    expect(Object.fromEntries(factsOf("bakery").facts.map((x) => [x.key, x.value])).phone).toMatch(/^000-/);
    expect(Object.fromEntries(factsOf("cafe").facts.map((x) => [x.key, x.value])).phone).toMatch(/^000-/);
    // the confectionery edition keeps the committed pack's placeholder 052-000- number
    expect(Object.fromEntries(factsOf("wagashi").facts.map((x) => [x.key, x.value])).phone).toMatch(/^052-000-/);
    const reserved = readJson<{ target: { official_name: string; allowed_aliases: string[] } }>("design-library/research/three-methods/identity-lock.json").target;
    for (const shop of SHOPS) {
      const text = readFileSync(resolve(REPO, POC, shop, "facts-pack.json"), "utf8") + readFileSync(resolve(REPO, POC, shop, "direction-set.json"), "utf8");
      for (const name of [reserved.official_name, ...reserved.allowed_aliases]) expect(text).not.toContain(name);
    }
  });

  it("the confectionery edition keeps the committed pack's ids and non-placeholder values; that pack is untouched", () => {
    const original = readJson<{ facts: Array<{ id: string; key: string; value: string }> }>("design-library/phase2f/wagashi-facts-pack.json").facts;
    const edition = factsOf("wagashi").facts;
    expect(edition.map((f) => f.id)).toEqual(original.map((f) => f.id));
    expect(factsOf("wagashi").shop_id).toBe("fictional-wagashi");
    for (let i = 0; i < original.length; i++) {
      const [o, e] = [original[i]!, edition[i]!];
      expect(e.key).toBe(o.key.replace(/^menu_item_/, "service_"));
      if (!o.value.includes("テスト")) expect(e.value).toBe(o.value);
    }
  });

  it("the nine directions are nine different hero × flow pairs and nine different section sequences", () => {
    const all = SHOPS.flatMap((s) => setOf(s).directions);
    expect(new Set(all.map((d) => `${d.composition.hero}/${d.composition.flow}`)).size).toBe(9);
    expect(new Set(all.map((d) => d.sections.map((x) => x.layout).join(","))).size).toBe(9);
  });

  it("no shop is another re-skinned (review L4): across shops, motifs differ and concepts and body facets do not read alike (lexical)", () => {
    const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[\s\d\p{P}\p{S}]/gu, "");
    const grams = (s: string) => new Set(Array.from({ length: Math.max(s.length - 1, 1) }, (_, i) => s.slice(i, i + 2)));
    const similar = (a: string, b: string) => {
      const [x, y] = [grams(norm(a)), grams(norm(b))];
      const n = [...x].filter((g) => y.has(g)).length;
      return n / (x.size + y.size - n);
    };
    const motifs = SHOPS.flatMap((s) => setOf(s).motif.candidates.map((m) => m.what));
    expect(new Set(motifs).size).toBe(motifs.length);
    for (let i = 0; i < SHOPS.length; i++)
      for (let j = i + 1; j < SHOPS.length; j++)
        for (const a of setOf(SHOPS[i]!).directions)
          for (const b of setOf(SHOPS[j]!).directions) {
            expect(similar(a.concept, b.concept), `${a.id}|${b.id}`).toBeLessThan(0.3);
            // the body (every section but the visit) — the same threshold the C2 copy check uses for facets
            for (const x of a.sections.slice(0, -1)) for (const y of b.sections.slice(0, -1)) expect(similar(x.motif_facet, y.motif_facet), `${a.id}/${x.id}|${b.id}/${y.id}`).toBeLessThan(0.6);
          }
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

  it("each reference carries its own translation (review L2), so research entries do not repeat one text", () => {
    for (const shop of SHOPS)
      for (const d of setOf(shop).directions) {
        const t = d.references.map((r) => r.use.split("／翻訳：")[1]?.trim());
        expect(t.every(Boolean), d.id).toBe(true);
        expect(new Set(t).size, d.id).toBe(t.length);
      }
  });
});

describe("S0 A-2: the six directions selected for the generation experiment", () => {
  const selected = selection.shops.flatMap((s) => s.selected.map((d) => ({ shop: s, d })));

  it("two per shop, six in all, each a direction of that shop's set; the record is pinned to the committed bytes and names the H1 blocker", () => {
    expect(selection.shops.map((s) => s.dir)).toEqual(SHOPS.map((s) => `${POC}/${s}`));
    expect(selection.status).toEqual({ design_generated: false, owner_approval: "required", sendable: false, note: expect.any(String) });
    expect(selection.blockers.map((b) => b.id)).toContain("H1");
    expect(selected.map(({ d }) => d.direction_id)).toEqual(["d1-kiln-clock", "d3-flour-crust", "c1-window-street", "c2-nel-drop", "w1-wrapping-sheet", "w2-tsubu-stations"]);
    for (const s of selection.shops) {
      const set = readJson<DirectionSet>(`${s.dir}/direction-set.json`);
      expect(s.shop_id).toBe(set.shop_id);
      expect(s.facts_sha256).toBe(sha(readFileSync(resolve(REPO, s.dir, "facts-pack.json"))));
      expect(s.facts_sha256).toBe(set.facts_sha256);
      expect(s.direction_set_sha256).toBe(sha(readFileSync(resolve(REPO, s.dir, "direction-set.json"))));
      expect(s.selected).toHaveLength(2);
      const ids = [...s.selected.map((d) => d.direction_id), ...s.not_selected.map((d) => d.direction_id)].sort();
      expect(ids).toEqual(set.directions.map((d) => d.id).sort());
      for (const d of s.selected) {
        expect(d.composition).toEqual(set.directions.find((x) => x.id === d.direction_id)!.composition);
        // only the confectionery pins are safe under the approved v2 (its address and "sweets" lines are wagashi-only)
        expect(d.pins.v2.safe_to_run_under_current_version).toBe(s.shop_id === "fictional-wagashi");
        expect(d.pins["v2.1"].status).toBe("candidate_requires_owner_approval_to_activate");
      }
    }
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

  it.each(selected.map(({ shop, d }) => [d.direction_id, shop, d] as const))("%s: the recorded v2 pin is rebuilt by the CLI, and the v2.1 candidate by the builder", { timeout: 300_000 }, (id, shop, d) => {
    const out = join(root, id);
    const facts = resolve(REPO, shop.dir, "facts-pack.json");
    const input = tsx("scripts/sales/demo-version/prepare-design-input.ts", "--facts", facts, "--directions", resolve(REPO, shop.dir, "direction-set.json"), "--direction-id", id, "--out", out);
    expect(input.status, input.stderr).toBe(0);
    expect(input.out).toMatchObject({ facts_sha256: shop.facts_sha256, prompt_pin_required: true, sendable: false });
    const pin = tsx("scripts/design-artifact/phase2f-design.ts", "--print-pin", "--route", "B", "--prompt-version", "v2", "--facts", facts, "--direction", join(out, "direction.json"), "--references", join(out, "references.json"));
    expect(pin.status, pin.stderr).toBe(0);
    expect(pin.out).toMatchObject({ mode: "print_pin", route: "B_html_prototype", prompt_version: "v2", direction: { direction_id: id, composition: d.composition } });
    expect([pin.out?.prompt_sha256, pin.out?.prompt_chars]).toEqual([d.pins.v2.prompt_sha256, d.pins.v2.prompt_chars]);
    expect((pin.out?.references as unknown[]).length).toBe(d.reference_count);
    const r = resolveDirection(JSON.parse(readFileSync(join(out, "direction.json"), "utf8")), JSON.parse(readFileSync(join(out, "references.json"), "utf8")));
    if (!r.ok) throw new Error(r.code);
    const pack = FactsPack.parse(JSON.parse(readFileSync(facts, "utf8")));
    const v2 = buildDesignPrompt({ route: "B_html_prototype", facts: pack, maxAssets: 1, variant: { version: "v2", direction: r.direction, references: r.references } });
    expect(v2.sha256).toBe(d.pins.v2.prompt_sha256); // the builder and the CLI agree
    const v21 = buildDesignPrompt({ route: "B_html_prototype", facts: pack, maxAssets: 1, variant: { version: "v2.1", direction: r.direction, references: r.references } });
    expect([v21.sha256, v21.chars]).toEqual([d.pins["v2.1"].prompt_sha256, d.pins["v2.1"].prompt_chars]);
    expect(v21.prompt).not.toContain("show only 名古屋市東区");
    // each research entry has its own translation
    expect(new Set(r.direction.research.map((x) => x.translate_to_this_shop)).size).toBe(r.direction.research.length);
  });
});
