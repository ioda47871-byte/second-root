import { z } from "zod";
import { describe, expect, it } from "vitest";
import { availableFirstViews, availableSections, DEFAULT_LAYOUT, factPlacement, japaneseOnly, normalizeLayout, verticalName } from "@/lib/design-agent/layout";
import {
  checkProfile,
  DesignProfileCoreSchema,
  designProfileJsonSchema,
  DesignProfileSchema,
  FIRST_VIEWS,
  GROUNDS,
  HEADING_STYLES,
  LayoutSchema,
  SECTION_KINDS,
  SECTION_VARIANTS,
  TYPE_SCALES,
  type Layout,
  type LayoutSection,
} from "@/lib/design-agent/profile";
import type { DemoView } from "@/lib/sales/demo-content";
import { AMERICAN_EDITORIAL, MINIMAL_SHOP, SHOP } from "./fixtures";

// Stage 1 (DEV-071a): the Design Spec's schema and its normalization against
// the facts. Fictional shops only.

const layout = (over: Partial<Layout> = {}): Layout => ({ ...DEFAULT_LAYOUT, ...over });
const s = <K extends LayoutSection["kind"]>(kind: K, variant: Extract<LayoutSection, { kind: K }>["variant"], ground: LayoutSection["ground"] = "plain") =>
  ({ kind, variant, ground }) as LayoutSection;

describe("layout schema", () => {
  it("accepts a profile without layout exactly as before, and every valid layout", () => {
    expect(checkProfile(AMERICAN_EDITORIAL)).toEqual({ ok: true, profile: AMERICAN_EDITORIAL });
    expect(checkProfile({ ...AMERICAN_EDITORIAL, layout: DEFAULT_LAYOUT })).toMatchObject({ ok: true });
    for (const kind of SECTION_KINDS) {
      for (const variant of SECTION_VARIANTS[kind]) {
        for (const ground of GROUNDS) {
          const value = { ...AMERICAN_EDITORIAL, layout: layout({ sections: [{ kind, variant, ground } as LayoutSection] }) };
          expect(checkProfile(value).ok, `${kind}/${variant}/${ground}`).toBe(true);
        }
      }
    }
    for (const firstView of FIRST_VIEWS)
      for (const scale of TYPE_SCALES)
        for (const headings of HEADING_STYLES) expect(checkProfile({ ...AMERICAN_EDITORIAL, layout: layout({ firstView, type: { scale, headings } }) }).ok).toBe(true);
  });

  it("refuses repeated kinds, unknown or mismatched variants, five sections, no sections and extra fields", () => {
    const bad: unknown[] = [
      layout({ sections: [s("menu", "chips"), s("menu", "numbered")] }),
      layout({ sections: [{ kind: "menu", variant: "carousel", ground: "plain" } as never] }),
      layout({ sections: [{ kind: "about", variant: "chips", ground: "plain" } as never] }),
      layout({ sections: [{ kind: "reviews", variant: "lead", ground: "plain" } as never] }),
      layout({ sections: [{ kind: "about", variant: "lead", ground: "gradient" } as never] }),
      layout({ sections: [s("about", "lead"), s("menu", "chips"), s("hours", "strip"), s("visit", "cards"), s("about", "statement")] }),
      layout({ sections: [] }),
      layout({ firstView: "slogan" as never }),
      layout({ type: { scale: "huge", headings: "en_ja" } as never }),
      { ...layout(), tagline: "Best in Nagoya" },
      layout({ sections: [{ ...s("about", "lead"), text: "x" } as never] }),
      { ...layout(), type: { scale: "quiet", headings: "en_ja", css: "x" } },
    ];
    for (const value of bad) expect(checkProfile({ ...AMERICAN_EDITORIAL, layout: value }).ok, JSON.stringify(value)).toBe(false);
  });

  it("keeps version 1 and stays far below the database's 8192 bytes", () => {
    expect(checkProfile({ ...AMERICAN_EDITORIAL, version: 2, layout: DEFAULT_LAYOUT }).ok).toBe(false);
    const biggest: Layout = {
      firstView: "vertical_name",
      sections: [s("visit", "stacked", "inverted"), s("about", "side_heading", "inverted"), s("menu", "feature_first", "inverted"), s("hours", "strip", "inverted")],
      type: { scale: "dramatic", headings: "vertical_ja" },
    };
    expect(LayoutSchema.parse(biggest)).toEqual(biggest);
    expect(Buffer.byteLength(JSON.stringify(biggest))).toBeLessThanOrEqual(400);
    const full = { ...AMERICAN_EDITORIAL, rationale: Array(4).fill("あ".repeat(160)), layout: biggest };
    expect(checkProfile(full).ok).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(full))).toBeLessThan(8192);
  });

  it("leaves Codex's output schema without layout until DEV-071b, and a required-layout schema is strict", () => {
    expect(Object.keys((designProfileJsonSchema() as { properties: object }).properties)).not.toContain("layout");
    const { $schema, ...core } = z.toJSONSchema(DesignProfileCoreSchema) as Record<string, unknown>;
    expect($schema).toBeDefined();
    expect(designProfileJsonSchema()).toEqual(core);
    // DEV-071b: Codex's schema will require layout. It stays closed and fully required.
    const required = z.toJSONSchema(DesignProfileCoreSchema.extend({ layout: LayoutSchema }));
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== "object") return;
      const o = node as Record<string, unknown>;
      if (o.type === "object") {
        expect(o.additionalProperties).toBe(false);
        expect([...(o.required as string[])].sort()).toEqual(Object.keys(o.properties as object).sort());
      }
      Object.values(o).forEach(walk);
    };
    walk(required);
    expect(JSON.stringify(required)).not.toContain("oneOf"); // structured output takes anyOf only
    // stored profiles: layout optional
    expect(DesignProfileSchema.safeParse(AMERICAN_EDITORIAL).success).toBe(true);
  });
});

// ------------------------------------------------------------------ normalize

const SHOPS: Record<string, DemoView> = {
  full: SHOP,
  no_description: { ...SHOP, description: null },
  no_menu: { ...SHOP, menuItems: [] },
  no_hours: { ...SHOP, hours: null, closedDays: null },
  closed_days_only: { ...SHOP, hours: null },
  hours_and_menu_only: { ...MINIMAL_SHOP, hours: "9:00〜18:00", menuItems: ["テストパン"] },
  address_only: { ...MINIMAL_SHOP, address: "名古屋市北区テスト町1-2-3" },
  name_only: MINIMAL_SHOP,
  japanese_full: { ...SHOP, name: "架空焼菓子店" },
  japanese_name_only: { ...MINIMAL_SHOP, name: "テスト珈琲" },
};

const LAYOUTS: Record<string, Omit<Layout, "firstView">> = {
  default: DEFAULT_LAYOUT,
  all_four: { sections: [s("menu", "chips", "surface"), s("hours", "block", "inverted"), s("about", "statement"), s("visit", "cards")], type: { scale: "dramatic", headings: "ja_en" } },
  hours_no_visit: { sections: [s("hours", "strip"), s("menu", "columns")], type: { scale: "quiet", headings: "ja_only" } },
  visit_only: { sections: [s("visit", "stacked", "inverted")], type: { scale: "standard", headings: "vertical_ja" } },
  about_only: { sections: [s("about", "side_heading", "surface")], type: { scale: "standard", headings: "en_ja" } },
  duplicate: { sections: [s("menu", "feature_first"), s("menu", "chips"), s("visit", "split")], type: { scale: "standard", headings: "en_ja" } },
};

const FACTS = ["description", "menuItems", "hours", "closedDays", "address", "access", "phone"] as const;
const factPresent = (demo: DemoView, fact: (typeof FACTS)[number]) => (fact === "menuItems" ? demo.menuItems.length > 0 : demo[fact] !== null);

describe("normalizeLayout", () => {
  it("never keeps a section without facts, puts every fact on the page once, and is stable", () => {
    for (const [shopKey, demo] of Object.entries(SHOPS)) {
      for (const [layoutKey, base] of Object.entries(LAYOUTS)) {
        for (const firstView of FIRST_VIEWS) {
          const label = `${shopKey}/${layoutKey}/${firstView}`;
          const input = { ...base, firstView } as Layout;
          const { layout: out, adjustments } = normalizeLayout(input, demo);
          const kinds = out.sections.map((x) => x.kind);
          // a kind at most once
          expect(new Set(kinds).size, label).toBe(kinds.length);
          // every section has content of its own
          const hoursSection = kinds.includes("hours");
          for (const kind of kinds) {
            const content = {
              about: demo.description !== null && out.firstView !== "name_lead",
              menu: demo.menuItems.length > 0,
              hours: demo.hours !== null || demo.closedDays !== null,
              visit: demo.address !== null || demo.access !== null || demo.phone !== null || (!hoursSection && (demo.hours !== null || demo.closedDays !== null)),
            }[kind];
            expect(content, `${label}: ${kind} without facts`).toBe(true);
          }
          // the first view has its facts, or is the name alone
          expect(availableFirstViews(demo), label).toContain(out.firstView);
          if (out.firstView !== firstView) {
            expect(out.firstView, label).toBe("name_only");
            expect(adjustments, label).toContain(`first_view:${firstView}`);
          }
          // every fact is placed; the description exactly once
          const placed = factPlacement(out, demo);
          for (const fact of FACTS) expect(placed[fact] !== null, `${label}: ${fact}`).toBe(factPresent(demo, fact));
          if (out.firstView === "name_lead") expect(kinds, label).not.toContain("about");
          // kept sections keep their order, variant and ground; added ones come last in the default setting
          const kept = base.sections.filter((x, i) => base.sections.findIndex((y) => y.kind === x.kind) === i && kinds.includes(x.kind));
          expect(out.sections.slice(0, kept.length), label).toEqual(kept);
          for (const added of out.sections.slice(kept.length)) {
            expect(adjustments, label).toContain(`added:${added.kind}`);
            expect(added, label).toEqual({ kind: added.kind, variant: SECTION_VARIANTS[added.kind][0], ground: "plain" });
          }
          // adjustments are fixed codes only
          for (const a of adjustments) expect(a, label).toMatch(/^(duplicate|dropped|added):(about|menu|hours|visit)$|^first_view:[a-z_]+$|^about_in_first_view$/);
          // normalizing again changes nothing
          expect(normalizeLayout(out, demo), label).toEqual({ layout: out, adjustments: [] });
          expect(out.type, label).toEqual(base.type);
        }
      }
    }
  });

  it("reports what it changed with fixed codes", () => {
    expect(normalizeLayout(DEFAULT_LAYOUT, SHOP)).toEqual({ layout: DEFAULT_LAYOUT, adjustments: [] });
    expect(normalizeLayout(DEFAULT_LAYOUT, MINIMAL_SHOP)).toEqual({ layout: { ...DEFAULT_LAYOUT, sections: [] }, adjustments: ["dropped:about", "dropped:menu", "dropped:visit"] });
    expect(normalizeLayout(layout({ firstView: "name_lead" }), SHOP).adjustments).toEqual(["about_in_first_view"]);
    expect(normalizeLayout(layout({ firstView: "name_lead" }), { ...SHOP, description: null }).adjustments).toEqual(["first_view:name_lead", "dropped:about"]);
    expect(normalizeLayout(layout({ firstView: "vertical_name" }), SHOP).adjustments).toEqual(["first_view:vertical_name"]);
    expect(normalizeLayout(layout({ firstView: "vertical_name" }), { ...SHOP, name: "架空焼菓子店" }).adjustments).toEqual([]);
    expect(normalizeLayout({ ...LAYOUTS.duplicate, firstView: "name_only" }, SHOP)).toEqual({
      layout: { firstView: "name_only", sections: [s("menu", "feature_first"), s("visit", "split"), s("about", "lead")], type: LAYOUTS.duplicate.type },
      adjustments: ["duplicate:menu", "added:about"],
    });
    // the hours section takes the hours and closed days; visit with nothing else is dropped
    const hoursOnly = { ...MINIMAL_SHOP, hours: "9:00〜18:00", closedDays: "火曜" };
    expect(normalizeLayout(layout({ sections: [s("hours", "strip"), s("visit", "cards")] }), hoursOnly)).toEqual({
      layout: layout({ sections: [s("hours", "strip")] }),
      adjustments: ["dropped:visit"],
    });
    // without an hours section, visit shows them (it is added when missing)
    expect(normalizeLayout(layout({ sections: [s("menu", "chips")] }), hoursOnly)).toEqual({
      layout: layout({ sections: [s("visit", "ledger")] }),
      adjustments: ["dropped:menu", "added:visit"],
    });
  });

  it("shows the menu excerpt only for a longer menu that does not open the page", () => {
    const menu = { ...SHOP, menuItems: ["a", "b", "c", "d"] };
    const ok = normalizeLayout(layout({ firstView: "name_menu" }), menu);
    expect(ok).toEqual({ layout: layout({ firstView: "name_menu" }), adjustments: [] });
    expect(normalizeLayout(layout({ firstView: "name_menu", sections: [s("menu", "chips"), s("visit", "cards")] }), menu)).toEqual({
      layout: layout({ firstView: "name_only", sections: [s("menu", "chips"), s("visit", "cards"), s("about", "lead")] }),
      adjustments: ["added:about", "first_view:name_menu"],
    });
    // a short menu has no excerpt: the whole menu would be shown twice
    expect(normalizeLayout(layout({ firstView: "name_menu" }), SHOP).adjustments).toEqual(["first_view:name_menu"]);
  });

  it("returns a render plan that may have no section; stored layouts keep at least one", () => {
    const { layout: plan } = normalizeLayout(DEFAULT_LAYOUT, MINIMAL_SHOP);
    expect(plan.sections).toEqual([]);
    // never parsed or stored again: the stored schema still refuses an empty list
    expect(LayoutSchema.safeParse(plan).success).toBe(false);
    expect(normalizeLayout(plan, MINIMAL_SHOP)).toEqual({ layout: plan, adjustments: [] });
  });

  it("lists the sections and first views each shop's facts support", () => {
    expect(availableSections(SHOP)).toEqual(["about", "menu", "hours", "visit"]);
    expect(availableSections(MINIMAL_SHOP)).toEqual([]);
    expect(availableSections(SHOPS.hours_and_menu_only)).toEqual(["menu", "hours", "visit"]);
    expect(availableFirstViews(SHOP)).toEqual(["name_only", "name_lead", "name_hours"]); // 2 items: no excerpt
    expect(availableFirstViews({ ...SHOP, menuItems: ["a", "b", "c", "d"] })).toEqual(["name_only", "name_lead", "name_hours", "name_menu"]);
    expect(availableFirstViews(MINIMAL_SHOP)).toEqual(["name_only"]);
    expect(availableFirstViews(SHOPS.japanese_name_only)).toEqual(["name_only", "vertical_name"]);
  });

  it("sets only Japanese script vertically", () => {
    for (const name of ["架空焼菓子店", "テスト珈琲", "ぱんのいえ", "麦と灯", "パン・ド", "店"]) expect(verticalName(name), name).toBe(true);
    // over six characters a vertical name could not lead the page (it would be set near heading size)
    for (const name of ["EXAMPLE", "テスト cafe", "テスト 珈琲", "テスト3号店", "パン屋ＡＢＣ", "パン・ド・テスト", "一二三四五六七", "", "テスト！"]) expect(verticalName(name), name).toBe(false);
    for (const word of ["店について", "メニュー", "営業時間", "店舗のご案内"]) expect(japaneseOnly(word)).toBe(true);
  });
});
