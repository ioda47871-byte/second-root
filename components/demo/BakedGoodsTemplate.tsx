import type { DemoView } from "@/lib/sales/demo-content";
import DemoFrame from "./DemoFrame";
import { areaLabel, areaName, CATEGORY_EN, infoRows, nameStyle, ordinal } from "./info";
import styles from "./bakedGoods.module.css";

// baked_goods_v1 — editorial patisserie. Generic headings and decorative
// English labels only; everything shop-specific is a verified fact. The
// hero and the ribbon band carry the page when only the name, category and
// area are known. Sections without facts are omitted.

function HeroArt() {
  return (
    <svg className={styles.art} viewBox="0 0 480 560" aria-hidden="true">
      <defs>
        <pattern id="bg-dots" width="14" height="14" patternUnits="userSpaceOnUse">
          <circle cx="3" cy="3" r="1.4" className={styles.artDot} />
        </pattern>
      </defs>
      <path className={styles.artArch} d="M72 560V236a168 168 0 0 1 336 0v324Z" />
      <path className={styles.artDots} d="M72 560V236a168 168 0 0 1 336 0v324Z" />
      <path className={styles.artArchLine} d="M96 560V240a144 144 0 0 1 288 0v320" />
      <circle className={styles.artRing} cx="352" cy="150" r="104" />
      <circle className={styles.artSun} cx="352" cy="150" r="46" />
      <path className={styles.artDome} d="M126 452a114 114 0 0 1 228 0Z" />
      <path className={styles.artDomeLine} d="M150 452a90 90 0 0 1 180 0" />
      <path className={styles.artShelf} d="M24 452h432M24 466h432" />
      <path className={styles.artRibbon} d="M0 506h300l-18 20 18 20H0Z" />
      <path className={styles.artSpark} d="M88 120l6 18 18 6-18 6-6 18-6-18-18-6 18-6Z" />
      <path className={styles.artSpark} d="M430 330l4 11 11 4-11 4-4 11-4-11-11-4 11-4Z" />
    </svg>
  );
}

function AddressArt() {
  return (
    <svg className={styles.map} viewBox="0 0 320 140" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <path className={styles.mapGrid} d="M0 28h320M0 70h320M0 112h320M52 0v140M132 0v140M212 0v140M280 0v140" />
      <path className={styles.mapRoad} d="M-10 124L150 36 330 96" />
      <circle className={styles.mapPulse} cx="170" cy="62" r="22" />
      <circle className={styles.mapPin} cx="170" cy="62" r="7" />
    </svg>
  );
}

export default function BakedGoodsTemplate({ demo }: { demo: DemoView }) {
  const rows = infoRows(demo);
  const address = rows.find((r) => r.key === "address");
  const others = rows.filter((r) => r.key !== "address");
  const band = [CATEGORY_EN[demo.category], areaName(demo)];
  return (
    <DemoFrame shopName={demo.name} template={demo.template}>
      <header className={styles.hero}>
        <div className={styles.heroText}>
          <p className={styles.kicker}>{areaLabel(demo)}</p>
          <h1 className={styles.name} style={nameStyle(demo.name)}>
            {demo.name}
          </h1>
          <p lang="en" className={styles.ribbon}>{CATEGORY_EN[demo.category]}</p>
        </div>
        <div className={styles.heroArt} aria-hidden="true">
          <HeroArt />
          <div className={styles.stamp}>
            <span>Nagoya</span>
            <svg viewBox="0 0 12 12">
              <path d="M6 0l1.6 4.4L12 6l-4.4 1.6L6 12 4.4 7.6 0 6l4.4-1.6Z" />
            </svg>
            <span>{CATEGORY_EN[demo.category]}</span>
          </div>
        </div>
      </header>

      <div className={styles.band} aria-hidden="true">
        <div className={styles.bandTrack}>
          {[0, 1].map((copy) => (
            <span key={copy} className={styles.bandGroup}>
              {Array.from({ length: 4 }, (_, i) =>
                band.map((word) => (
                  <span key={`${i}-${word}`} className={styles.bandWord}>
                    {word}
                  </span>
                )),
              )}
            </span>
          ))}
        </div>
      </div>

      <main className={styles.main}>
        {demo.description && (
          <section className={styles.about} aria-labelledby="baked-about">
            <h2 id="baked-about" lang="en" className={styles.eyebrow}>
              About
            </h2>
            <p className={styles.lead}>{demo.description}</p>
          </section>
        )}

        {demo.menuItems.length > 0 && (
          <section className={styles.section} aria-labelledby="baked-menu">
            <h2 id="baked-menu" className={styles.sectionTitle}>
              <span lang="en" className={styles.titleEn}>Menu</span>
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
          <section className={styles.section} aria-labelledby="baked-info">
            <h2 id="baked-info" className={styles.sectionTitle}>
              <span lang="en" className={styles.titleEn}>Information</span>
              <span className={styles.titleJa}>店舗のご案内</span>
            </h2>
            <div className={styles.infoGrid} data-single={address && others.length === 0 ? "" : undefined}>
              {address && (
                <div className={styles.addressCard}>
                  <AddressArt />
                  <p className={styles.rowLabel}>
                    <span lang="en" className={styles.rowEn}>{address.en}</span>
                    {address.label}
                  </p>
                  <p className={styles.addressValue}>{address.value}</p>
                </div>
              )}
              {others.length > 0 && (
                <dl className={styles.rows}>
                  {others.map((row) => (
                    <div key={row.key} className={styles.row}>
                      <dt className={styles.rowLabel}>
                        <span lang="en" className={styles.rowEn}>{row.en}</span>
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
