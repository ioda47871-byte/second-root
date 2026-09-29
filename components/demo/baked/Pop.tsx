import type { DemoView } from "@/lib/sales/demo-content";
import DemoFrame from "../DemoFrame";
import { grotesk } from "../fonts";
import { areaLabel, areaName, CATEGORY_EN, infoRows, monogram, nameStyle, ordinal } from "../info";
import styles from "./pop.module.css";

// baked_goods_v1 / pop — an American bake-shop: cream, tomato red, navy,
// heavy condensed grotesk, a round stamp built from the monogram, and a
// ticket for the address. Only verified facts.

export default function Pop({ demo }: { demo: DemoView }) {
  const rows = infoRows(demo);
  const address = rows.find((r) => r.key === "address");
  const others = rows.filter((r) => r !== address);
  return (
    <DemoFrame shopName={demo.name} template={demo.template} variant="pop" className={`${styles.root} ${grotesk.variable}`}>
      <header className={styles.hero}>
        <div className={styles.heroText}>
          <p className={styles.eyebrow}>
            <span lang="en">{CATEGORY_EN[demo.category]}</span>
            <span aria-hidden="true" className={styles.dot} />
            <span>{areaName(demo)}</span>
          </p>
          <h1 className={styles.name} style={nameStyle(demo.name)}>
            {demo.name}
          </h1>
          <p className={styles.tagline}>{areaLabel(demo)}</p>
        </div>
        <div className={styles.stamp} aria-hidden="true">
          <span lang="en" className={styles.stampTop}>
            Nagoya
          </span>
          <span className={styles.stampMark}>{monogram(demo.name)}</span>
          <span lang="en" className={styles.stampBottom}>
            {CATEGORY_EN[demo.category]}
          </span>
        </div>
      </header>

      <main className={styles.main}>
        {demo.description && (
          <section className={styles.about} aria-labelledby="pop-about">
            <h2 id="pop-about" lang="en" className={styles.tag}>
              About
            </h2>
            <p className={styles.lead}>{demo.description}</p>
          </section>
        )}

        {demo.menuItems.length > 0 && (
          <section className={styles.section} aria-labelledby="pop-menu">
            <h2 id="pop-menu" className={styles.title}>
              <span lang="en">Menu</span>
              <span className={styles.titleJa}>メニュー</span>
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
          <section className={styles.section} aria-labelledby="pop-info">
            <h2 id="pop-info" className={styles.title}>
              <span lang="en">Information</span>
              <span className={styles.titleJa}>店舗のご案内</span>
            </h2>
            <div className={styles.info} data-address-only={address && others.length === 0 ? "" : undefined}>
              {address && (
                <div className={styles.ticket}>
                  <p className={styles.label}>
                    <span lang="en" className={styles.labelEn}>
                      {address.en}
                    </span>
                    {address.label}
                  </p>
                  <p className={styles.addressValue}>{address.value}</p>
                </div>
              )}
              {others.length > 0 && (
                <dl className={styles.rows}>
                  {others.map((row) => (
                    <div key={row.key} className={styles.row}>
                      <dt className={styles.label}>
                        <span lang="en" className={styles.labelEn}>
                          {row.en}
                        </span>
                        {row.label}
                      </dt>
                      <dd className={styles.rowValue}>{row.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          </section>
        )}
      </main>
    </DemoFrame>
  );
}
