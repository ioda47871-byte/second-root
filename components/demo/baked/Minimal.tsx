import type { DemoView } from "@/lib/sales/demo-content";
import DemoFrame from "../DemoFrame";
import { grotesk } from "../fonts";
import { areaLabel, CATEGORY_EN, infoRows, monogram, nameStyle, ordinal } from "../info";
import styles from "./minimal.module.css";

// baked_goods_v1 / minimal — a boutique on a strict grid: white, charcoal,
// one muted accent, the name at an oversized light weight. Whitespace is
// measured on the grid, never filled. Only verified facts.

export default function Minimal({ demo }: { demo: DemoView }) {
  const rows = infoRows(demo);
  return (
    <DemoFrame shopName={demo.name} template={demo.template} variant="minimal" className={`${styles.root} ${grotesk.variable}`}>
      <header className={styles.hero}>
        <p lang="en" className={styles.metaStart}>
          {CATEGORY_EN[demo.category]}
        </p>
        <p lang="en" className={styles.metaEnd}>
          Nagoya
        </p>
        <div className={styles.title}>
          <h1 className={styles.name} style={nameStyle(demo.name)}>
            {demo.name}
          </h1>
        </div>
        <p className={styles.area}>{areaLabel(demo)}</p>
        <span className={styles.mark} aria-hidden="true">
          {monogram(demo.name)}
        </span>
      </header>

      <main className={styles.main}>
        {demo.description && (
          <section className={styles.block} aria-labelledby="min-about">
            <h2 id="min-about" lang="en" className={styles.heading}>
              About
            </h2>
            <p className={styles.lead}>{demo.description}</p>
          </section>
        )}

        {demo.menuItems.length > 0 && (
          <section className={styles.block} aria-labelledby="min-menu">
            <h2 id="min-menu" className={styles.heading}>
              <span lang="en">Menu</span>
              <span className={styles.headingJa}>メニュー</span>
            </h2>
            <ol className={styles.menu}>
              {demo.menuItems.map((item, i) => (
                <li key={`${i}-${item}`} className={styles.menuItem}>
                  <span className={styles.menuNo}>{ordinal(i)}</span>
                  <span className={styles.menuName}>{item}</span>
                </li>
              ))}
            </ol>
          </section>
        )}

        {rows.length > 0 && (
          <section className={styles.block} aria-labelledby="min-info" data-single={rows.length === 1 ? "" : undefined}>
            <h2 id="min-info" className={styles.heading}>
              <span lang="en">Information</span>
              <span className={styles.headingJa}>店舗のご案内</span>
            </h2>
            <dl className={styles.rows}>
              {rows.map((row) => (
                <div key={row.key} className={styles.row} data-key={row.key}>
                  <dt className={styles.label}>
                    <span lang="en">{row.en}</span>
                    <span className={styles.labelJa}>{row.label}</span>
                  </dt>
                  <dd className={styles.value}>{row.value}</dd>
                </div>
              ))}
            </dl>
          </section>
        )}
      </main>
    </DemoFrame>
  );
}
