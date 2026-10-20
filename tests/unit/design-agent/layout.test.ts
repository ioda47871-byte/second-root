import { z } from "zod";
import { describe, expect, it } from "vitest";
import { availableFirstViews, availableSections, DEFAULT_LAYOUT, sectionIsShort, SHORT_DESCRIPTION, factPlacement, japaneseOnly, normalizeLayout, verticalName } from "@/lib/design-agent/layout";
import {
  checkProfile,
  DesignProfileCoreSchema,
  designProfileJsonSchema,
  DesignProfileSchema,
  FIRST_VIEWS,
  GROUNDS,
  HEADING_STYLES,
  LayoutSchema,
  looseJsonSchema,
  SECTION_KINDS,
  SECTION_VARIANTS,
  TYPE_SCALES,
  type Layout,
  type LayoutSection,
} from "@/lib/design-agent/profile";
import type { DemoView } from "@/lib/sales/demo-content";
import { sectionsPresent } from "@/lib/design-agent/assets/resolve";
import { photoReviewJsonSchema } from "@/lib/design-agent/photo-review";
import { visualReviewJsonSchema, VisualReviewSchema } from "@/lib/design-agent/review";
import { AMERICAN_EDITORIAL, MINIMAL_SHOP, review, SHOP } from "./fixtures";

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

  it("asks Codex for a layout (DEV-071b): its schemas require one, stay closed and fully required, and use no oneOf", () => {
    const required = designProfileJsonSchema() as { properties: object; required: string[] };
    expect(Object.keys(required.properties)).toContain("layout");
    expect(required.required).toContain("layout");
    const { $schema, ...codex } = z.toJSONSchema(DesignProfileCoreSchema.extend({ layout: LayoutSchema })) as Record<string, unknown>;
    expect($schema).toBeDefined();
    expect(required).toEqual(codex);
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
    for (const schema of [required, visualReviewJsonSchema(), photoReviewJsonSchema(), looseJsonSchema(required)]) {
      walk(schema);
      expect(JSON.stringify(schema)).not.toContain("oneOf"); // structured output takes anyOf only
    }
    // the review's revised profile carries the layout too
    expect(JSON.stringify(visualReviewJsonSchema())).toContain('"firstView"');
    expect(JSON.stringify(photoReviewJsonSchema())).toContain('"firstView"');
    // answers are parsed with the stored schema: an answer without a layout is still a valid profile
    expect(VisualReviewSchema.safeParse(review({ recommended_profile_changes: { summary: [], revised_profile: AMERICAN_EDITORIAL } })).success).toBe(true);
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
          for (const a of adjustments) expect(a, label).toMatch(/^(duplicate|dropped|added):(about|menu|hours|visit)$|^first_view:[a-z_]+$|^about_in_first_view$|^headings:vertical_ja$/);
          // normalizing again changes nothing
          expect(normalizeLayout(out, demo), label).toEqual({ layout: out, adjustments: [] });
          // vertical headings fall back to Japanese-only headings when a section is short
          expect(out.type, label).toEqual(adjustments.includes("headings:vertical_ja") ? { ...base.type, headings: "ja_only" } : base.type);
          if (out.type.headings === "vertical_ja") for (const x of out.sections) expect(sectionIsShort(x, demo, kinds.includes("hours")), `${label}: short ${x.kind}`).toBe(false);
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

  it("keeps vertical headings only when no section is short (headings:vertical_ja)", () => {
    const vertical = (sections: LayoutSection[]) => layout({ sections, type: { scale: "standard", headings: "vertical_ja" } });
    // the full fixture: a short description and two menu items
    expect(normalizeLayout(vertical(DEFAULT_LAYOUT.sections), SHOP)).toEqual({ layout: { ...vertical(DEFAULT_LAYOUT.sections), type: { scale: "standard", headings: "ja_only" } }, adjustments: ["headings:vertical_ja"] });
    const long = { ...SHOP, description: "あ".repeat(SHORT_DESCRIPTION + 1), menuItems: ["a", "b", "c"] };
    expect(normalizeLayout(vertical(DEFAULT_LAYOUT.sections), long).adjustments).toEqual([]);
    // an hours strip is one band: short; the block is not
    expect(normalizeLayout(vertical([s("hours", "strip"), s("about", "lead"), s("menu", "chips"), s("visit", "ledger")]), long).adjustments).toEqual(["headings:vertical_ja"]);
    expect(normalizeLayout(vertical([s("hours", "block"), s("about", "lead"), s("menu", "chips"), s("visit", "ledger")]), long).adjustments).toEqual([]);
    // visit without the hours rows (an hours section takes them) and only two rows left: short
    expect(normalizeLayout(vertical([s("hours", "block"), s("about", "lead"), s("menu", "chips"), s("visit", "ledger")]), { ...long, phone: null }).adjustments).toEqual(["headings:vertical_ja"]);
  });

  it("gives photos the sections of the drawn page (sectionsPresent from the normalized layout)", () => {
    expect(sectionsPresent(SHOP)).toEqual({ about: true, visit: true });
    expect(sectionsPresent(SHOP, DEFAULT_LAYOUT)).toEqual({ about: true, visit: true });
    // the description in the first view: no about section, no about photo
    expect(sectionsPresent(SHOP, layout({ firstView: "name_lead" }))).toEqual({ about: false, visit: true });
    // an hours section takes the only visit rows
    const hoursOnly = { ...MINIMAL_SHOP, hours: "9:00〜18:00" };
    expect(sectionsPresent(hoursOnly)).toEqual({ about: false, visit: true });
    expect(sectionsPresent(hoursOnly, layout({ sections: [s("hours", "block")] }))).toEqual({ about: false, visit: false });
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
