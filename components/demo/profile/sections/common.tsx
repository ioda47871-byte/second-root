import type { HEADING_STYLES, LayoutSection, SectionKind } from "@/lib/design-agent/profile";
import { japaneseOnly } from "@/lib/design-agent/layout";
import styles from "../profile.module.css";
import sx from "../sections.module.css";

// Shared by the section parts (DEV-071a). A section drawn for a profile
// without `layout` (spec null) keeps the markup of the page before Stage 1
// exactly; with a layout it adds its kind, variant and ground as data
// attributes and the classes of sections.module.css. Headings are fixed words
// only.

export type HeadingStyle = (typeof HEADING_STYLES)[number];

/** The fixed heading words of each section. */
export const HEADING_WORDS: Record<SectionKind, { en: string; ja: string }> = {
  about: { en: "About", ja: "店について" },
  menu: { en: "Menu", ja: "メニュー" },
  hours: { en: "Hours", ja: "営業時間" },
  visit: { en: "Visit", ja: "店舗のご案内" },
};

export type SectionProps<K extends SectionKind> = {
  /** The section's setting, or null for a profile without layout (the page before Stage 1). */
  spec: Extract<LayoutSection, { kind: K }> | null;
  headings: HeadingStyle;
};

/**
 * The section element's class and layout attributes. `short` (data-short): the
 * section has little content (sectionIsShort); normalizeLayout keeps such a
 * page's headings horizontal.
 */
export function sectionAttrs(spec: LayoutSection | null, short = false) {
  if (!spec) return { className: styles.section };
  return { className: `${styles.section} ${sx.sec}`, "data-kind": spec.kind, "data-variant": spec.variant, "data-ground": spec.ground, "data-short": short ? "" : undefined };
}



export function Heading({ kind, headings, layout }: { kind: SectionKind; headings: HeadingStyle; layout: boolean }) {
  const words = HEADING_WORDS[kind];
  const id = `pr-${kind}`;
  if (!layout || headings === "en_ja") {
    // The page before Stage 1: the English word, then the Japanese (About has the English only).
    return (
      <h2 id={id} className={layout ? `${styles.heading} ${sx.h}` : styles.heading}>
        <span lang="en">{words.en}</span>
        {kind !== "about" && <span className={styles.headingJa}>{words.ja}</span>}
      </h2>
    );
  }
  // Vertical writing is for Japanese script only (every fixed Japanese heading word is).
  const vertical = headings === "vertical_ja" && japaneseOnly(words.ja);
  return (
    <h2 id={id} className={`${styles.heading} ${sx.h}`}>
      <span className={vertical ? `${sx.ja} ${sx.vertical}` : sx.ja}>{words.ja}</span>
      {headings === "ja_en" && (
        <span lang="en" className={sx.en}>
          {words.en}
        </span>
      )}
    </h2>
  );
}
