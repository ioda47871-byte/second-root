import { ordinal } from "../text";
import styles from "../profile.module.css";
import sx from "../sections.module.css";
import { Heading, sectionAttrs, type SectionProps } from "./common";

// Menu: the shop's menu items (facts), in the shop's own order, every item.
//   numbered       a numbered list (the page before Stage 1)
//   chips          the items as a row of chips
//   columns        the items set in columns, like a printed menu card
//   feature_first  the first item set large, the rest as a list (no word is added:
//                  the order is the shop's, nothing is called a speciality)

export default function Menu({ items, spec, headings }: SectionProps<"menu"> & { items: string[] }) {
  const variant = spec?.variant ?? "numbered";
  return (
    <section {...sectionAttrs(spec, items.length <= 2)} aria-labelledby="pr-menu">
      <Heading kind="menu" headings={headings} layout={spec !== null} />
      {variant === "numbered" ? (
        <ol className={styles.menu}>
          {items.map((item, i) => (
            <li key={`${i}-${item}`} className={styles.menuItem}>
              <span className={styles.menuNo}>{ordinal(i)}</span>
              <span className={styles.menuName}>{item}</span>
            </li>
          ))}
        </ol>
      ) : (
        <ol className={variant === "chips" ? sx.chips : variant === "columns" ? sx.columns : sx.feature} data-count={items.length}>
          {items.map((item, i) => (
            <li key={`${i}-${item}`} className={sx.item}>
              {item}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
