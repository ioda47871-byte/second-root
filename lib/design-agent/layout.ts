import type { DemoView } from "@/lib/sales/demo-content";
import { FIRST_VIEWS, SECTION_KINDS, SECTION_VARIANTS, type Layout, type LayoutSection, type SectionKind } from "./profile";

// Stage 1 (DEV-071): every layout is normalized against the shop's facts
// before it is drawn, saved or compared. Pure: same layout and facts, same
// result. A section without facts is never drawn, a fact is never left off
// the page, and the description is never shown twice. Adjustments are fixed
// codes only (never Codex's words), for the run report.

/** The page before Stage 1: profiles without `layout` render exactly this. */
export const DEFAULT_LAYOUT: Layout = {
  firstView: "name_only",
  sections: [
    { kind: "about", variant: "lead", ground: "plain" },
    { kind: "menu", variant: "numbered", ground: "plain" },
    { kind: "visit", variant: "ledger", ground: "plain" },
  ],
  type: { scale: "standard", headings: "en_ja" },
};

/** The variant and ground a section gets when normalizing has to add it. */
const DEFAULT_SECTION: { [K in SectionKind]: Extract<LayoutSection, { kind: K }> } = {
  about: { kind: "about", variant: SECTION_VARIANTS.about[0], ground: "plain" },
  menu: { kind: "menu", variant: SECTION_VARIANTS.menu[0], ground: "plain" },
  hours: { kind: "hours", variant: SECTION_VARIANTS.hours[0], ground: "plain" },
  visit: { kind: "visit", variant: SECTION_VARIANTS.visit[0], ground: "plain" },
};

export type LayoutAdjustment =
  | `duplicate:${SectionKind}`
  | `dropped:${SectionKind}`
  | `added:${SectionKind}`
  | `first_view:${(typeof FIRST_VIEWS)[number]}`
  | "about_in_first_view"
  | "headings:vertical_ja";

/**
 * How many menu items a name_menu first view shows (all of them stay in the menu
 * section). The excerpt needs a longer menu than this (otherwise it is the whole
 * menu twice) and is not used when the menu section comes straight after the hero
 * (the same items twice on the first screen); then the first view is the name alone.
 */
export const FIRST_VIEW_MENU_ITEMS = 3;
/**
 * The longest name set vertically (vertical_name). A vertical name must lead the
 * page: at this length it is still set at least twice the size of the section
 * headings on a 900px-high desktop; a longer name stays horizontal (name_only).
 */
export const VERTICAL_NAME_MAX = 6;

// Japanese script only: kanji, kana, the long-vowel mark, iteration marks and the middle dot.
// Latin letters, digits and spaces are never set vertically (they would lie on their side).
const JAPANESE_ONLY = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー々〆ヶ・]+$/u;

/** True when the text is Japanese script only (vertical writing is allowed for it). */
export function japaneseOnly(text: string): boolean {
  return JAPANESE_ONLY.test(text);
}

/** A shop name that may be set vertically: Japanese only, no spaces, at most VERTICAL_NAME_MAX characters. */
export function verticalName(name: string): boolean {
  return japaneseOnly(name) && Array.from(name).length <= VERTICAL_NAME_MAX;
}

const hasHours = (demo: DemoView) => demo.hours !== null || demo.closedDays !== null;

/** The first views the shop's facts support (name_only always). */
export function availableFirstViews(demo: DemoView): (typeof FIRST_VIEWS)[number][] {
  return FIRST_VIEWS.filter((v) => firstViewHasEvidence(v, demo));
}

function firstViewHasEvidence(view: (typeof FIRST_VIEWS)[number], demo: DemoView): boolean {
  switch (view) {
    case "name_only":
      return true;
    case "name_lead":
      return demo.description !== null;
    case "name_hours":
      return demo.hours !== null;
    case "name_menu":
      return demo.menuItems.length > FIRST_VIEW_MENU_ITEMS;
    case "vertical_name":
      return verticalName(demo.name);
  }
}

/**
 * The sections the shop's facts support. Visit carries the hours and closed days
 * only when there is no hours section, so whether it has content depends on that.
 */
export function availableSections(demo: DemoView): SectionKind[] {
  return SECTION_KINDS.filter((kind) => sectionHasEvidence(kind, demo, false));
}

function sectionHasEvidence(kind: SectionKind, demo: DemoView, hoursSection: boolean): boolean {
  switch (kind) {
    case "about":
      return demo.description !== null;
    case "menu":
      return demo.menuItems.length > 0;
    case "hours":
      return hasHours(demo);
    case "visit":
      return demo.address !== null || demo.access !== null || demo.phone !== null || (!hoursSection && hasHours(demo));
  }
}

/**
 * A layout after normalizeLayout: a render plan, never parsed or stored again.
 * Unlike a stored layout (LayoutSchema: 1–4 sections) it may have no section at
 * all — a shop with only its name has none, as the page before Stage 1.
 */
export type NormalizedLayout = Omit<Layout, "sections"> & { sections: LayoutSection[] };

/** An about text up to this many characters is a short section (two lines or so). */
export const SHORT_DESCRIPTION = 60;

/**
 * A section with little content beside its heading (DEV-071b, from the facts and
 * the variant only): a description of at most SHORT_DESCRIPTION characters, at
 * most two menu items, the one-band hours strip, at most two visit rows. A
 * vertical heading beside it would set the section's height, so a page with one
 * keeps its headings horizontal (normalizeLayout: headings:vertical_ja).
 */
export function sectionIsShort(section: LayoutSection, demo: DemoView, hoursSection: boolean): boolean {
  switch (section.kind) {
    case "about":
      return demo.description !== null && Array.from(demo.description).length <= SHORT_DESCRIPTION;
    case "menu":
      return demo.menuItems.length <= 2;
    case "hours":
      return section.variant === "strip";
    case "visit": {
      const rows = [demo.address, demo.access, demo.phone, ...(hoursSection ? [] : [demo.hours, demo.closedDays])].filter((v) => v !== null);
      return rows.length <= 2;
    }
  }
}

export function normalizeLayout(input: Layout | NormalizedLayout, demo: DemoView): { layout: NormalizedLayout; adjustments: LayoutAdjustment[] } {
  const adjustments: LayoutAdjustment[] = [];

  // 4. a kind once (the schema refuses repeats; a saved or hand-made layout may not have passed it)
  const seen = new Set<SectionKind>();
  let sections: LayoutSection[] = [];
  for (const s of input.sections) {
    if (seen.has(s.kind)) {
      adjustments.push(`duplicate:${s.kind}`);
      continue;
    }
    seen.add(s.kind);
    sections.push({ ...s });
  }

  // 3. a first view without facts falls back to the name alone
  let firstView = input.firstView;
  if (!firstViewHasEvidence(firstView, demo)) {
    adjustments.push(`first_view:${firstView}`);
    firstView = "name_only";
  }
  // the description is in the first view: no about section (the same text never twice)
  const leadInHero = firstView === "name_lead";
  if (leadInHero && sections.some((s) => s.kind === "about")) {
    adjustments.push("about_in_first_view");
    sections = sections.filter((s) => s.kind !== "about");
  }

  // 1. sections without facts are not drawn (hours first: visit's content depends on it)
  const hoursSection = sections.some((s) => s.kind === "hours") && hasHours(demo);
  sections = sections.filter((s) => {
    const ok = sectionHasEvidence(s.kind, demo, hoursSection);
    if (!ok) adjustments.push(`dropped:${s.kind}`);
    return ok;
  });

  // 2. a fact no section shows gets its section, at the end, in the default setting
  const present = new Set(sections.map((s) => s.kind));
  const needed: SectionKind[] = [];
  if (demo.description !== null && !leadInHero && !present.has("about")) needed.push("about");
  if (demo.menuItems.length > 0 && !present.has("menu")) needed.push("menu");
  // hours and closed days are shown by an hours section or, without one, by visit
  if (!present.has("visit") && sectionHasEvidence("visit", demo, present.has("hours"))) needed.push("visit");
  for (const kind of needed) {
    adjustments.push(`added:${kind}`);
    sections.push({ ...DEFAULT_SECTION[kind] });
  }

  // the menu excerpt is not shown when the menu section opens the page (the same items twice in a row)
  if (firstView === "name_menu" && sections[0]?.kind === "menu") {
    adjustments.push("first_view:name_menu");
    firstView = "name_only";
  }

  // vertical headings only beside enough content on every section (one page never mixes the two)
  const type = { ...input.type };
  const hoursHere = sections.some((s) => s.kind === "hours");
  if (type.headings === "vertical_ja" && sections.some((s) => sectionIsShort(s, demo, hoursHere))) {
    adjustments.push("headings:vertical_ja");
    type.headings = "ja_only";
  }

  return { layout: { firstView, sections, type }, adjustments };
}

/** Where each fact of the shop is drawn under a normalized layout (for tests and the report). */
export function factPlacement(layout: NormalizedLayout, demo: DemoView): Record<string, SectionKind | "first_view" | null> {
  const has = (kind: SectionKind) => layout.sections.some((s) => s.kind === kind);
  const hoursHome: SectionKind | null = has("hours") ? "hours" : has("visit") ? "visit" : null;
  return {
    description: demo.description === null ? null : layout.firstView === "name_lead" ? "first_view" : has("about") ? "about" : null,
    menuItems: demo.menuItems.length === 0 ? null : has("menu") ? "menu" : null,
    hours: demo.hours === null ? null : hoursHome,
    closedDays: demo.closedDays === null ? null : hoursHome,
    address: demo.address === null ? null : has("visit") ? "visit" : null,
    access: demo.access === null ? null : has("visit") ? "visit" : null,
    phone: demo.phone === null ? null : has("visit") ? "visit" : null,
  };
}
