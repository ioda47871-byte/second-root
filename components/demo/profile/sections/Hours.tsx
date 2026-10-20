import type { InfoRow } from "../../info";
import { FactText, ROW_EN } from "../parts";
import styles from "../profile.module.css";
import sx from "../sections.module.css";
import { Heading, sectionAttrs, type SectionProps } from "./common";

// Hours: the opening hours and closed days (facts), as a section of their own.
// Only with a layout that asks for it; visit then leaves them out.
//   strip  the hours and the closed days side by side in one ruled band
//   block  the hours set large, the closed days under them

export default function Hours({ short = false, rows, spec, headings }: SectionProps<"hours"> & { short?: boolean; rows: InfoRow[] }) {
  if (!spec) return null;
  return (
    <section {...sectionAttrs(spec, short)} aria-labelledby="pr-hours">
      <Heading kind="hours" headings={headings} layout />
      <dl className={spec.variant === "strip" ? sx.strip : sx.block}>
        {rows.map((row) => (
          <div key={row.key} className={sx.pair} data-key={row.key}>
            <dt className={styles.rowLabel}>
              <span lang="en" className={styles.rowEn}>
                {ROW_EN[row.key]}
              </span>
              <span>{row.label}</span>
            </dt>
            <dd className={sx.value}>
              <FactText text={row.value} />
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
