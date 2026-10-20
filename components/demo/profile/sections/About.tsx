import type { RenderFeature } from "@/lib/design-agent/assets/resolve";
import { PhotoFigure } from "../parts";
import styles from "../profile.module.css";
import sx from "../sections.module.css";
import { chars, Heading, sectionAttrs, type SectionProps } from "./common";

// About: the shop's description (a fact), nothing else.
//   lead          the description as the page's lead paragraph (the page before Stage 1)
//   statement     the description as a large display statement across the section
//   side_heading  a small heading at the side, the description in a ruled column

/** A description longer than this is set smaller in the statement variant. */
export const LONG_STATEMENT = 120;

export default function About({ description, photo, spec, headings }: SectionProps<"about"> & { description: string; photo: RenderFeature | null }) {
  const variant = spec?.variant ?? "lead";
  return (
    <section {...sectionAttrs(spec, chars(description) <= 60)} aria-labelledby="pr-about" data-photo-section={photo ? "about" : undefined}>
      <Heading kind="about" headings={headings} layout={spec !== null} />
      {variant === "lead" ? (
        <p className={spec ? `${styles.lead} ${sx.leadText}` : styles.lead}>{description}</p>
      ) : (
        <p className={variant === "statement" ? sx.statement : sx.sideText} data-long={variant === "statement" && Array.from(description).length > LONG_STATEMENT ? "" : undefined}>
          {description}
        </p>
      )}
      {photo && <PhotoFigure photo={photo} className={styles.band} role="about" side={photo.side} />}
    </section>
  );
}
