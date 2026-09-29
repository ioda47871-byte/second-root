import type { DemoView } from "@/lib/sales/demo-content";
import DemoFrame from "../DemoFrame";
import { editorial } from "../fonts";
import { areaLabel, CATEGORY_EN, infoRows, monogram, nameStyle, ordinal } from "../info";
import styles from "./luxury.module.css";

// baked_goods_v1 / luxury — a fashion-magazine cover and spread: ivory,
// burgundy, high-contrast serif. The shop name is the cover line; hairline
// rules and a monogram do the decorating. Only verified facts.

export default function Luxury({ demo }: { demo: DemoView }) {
  const rows = infoRows(demo);
  const address = rows.find((r) => r.key === "address");
  const others = rows.filter((r) => r !== address);
  return (
    <DemoFrame shopName={demo.name} template={demo.template} variant="luxury" className={`${styles.root} ${editorial.variable}`}>
      <header className={styles.cover}>
        <p className={styles.folio}>
          <span lang="en">{CATEGORY_EN[demo.category]}</span>
          <span className={styles.folioMark} aria-hidden="true">
            {monogram(demo.name)}
          </span>
          <span lang="en">Nagoya</span>
        </p>
        <div className={styles.title}>
          <h1 className={styles.name} style={nameStyle(demo.name)}>
            {demo.name}
          </h1>
        </div>
        <p className={styles.dateline}>{areaLabel(demo)}</p>
      </header>

      <main className={styles.main}>
        {demo.description && (
          <section className={styles.feature} aria-labelledby="lux-about">
            <h2 id="lux-about" lang="en" className={styles.kicker}>
              About
            </h2>
            <p className={styles.lead}>{demo.description}</p>
          </section>
        )}

        {demo.menuItems.length > 0 && (
          <section className={styles.spread} aria-labelledby="lux-menu">
            <h2 id="lux-menu" className={styles.spreadTitle}>
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
          <section className={styles.spread} aria-labelledby="lux-info">
            <h2 id="lux-info" className={styles.spreadTitle}>
              <span lang="en">Information</span>
              <span className={styles.titleJa}>店舗のご案内</span>
            </h2>
            <div className={styles.info} data-address-only={address && others.length === 0 ? "" : undefined}>
              {address && (
                <div className={styles.address}>
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
