import type { DemoView } from "@/lib/sales/demo-content";
import DemoFrame from "./DemoFrame";
import { InfoIcon } from "./icons";
import { areaLabel, areaName, CATEGORY_EN, infoRows, nameStyle, ordinal } from "./info";
import styles from "./bakery.module.css";

// bakery_v1 — artisan bakery / craft editorial. Headings are generic and
// the English words are fixed template ornaments; every shop-specific word
// comes from a verified fact. Sections without facts are omitted.

function WheatArt() {
  const grain = "c-7-3-10-10-8-18 7 2 10 9 8 18Zm0 0c7-3 10-10 8-18-7 2-10 9-8 18Z";
  return (
    <svg className={styles.wheat} viewBox="0 0 360 520" aria-hidden="true">
      <g className={styles.wheatStroke}>
        <path d="M180 520C180 380 176 250 188 120" />
        <path d={`M184 170${grain}M183 205${grain}M182 240${grain}M181 275${grain}M181 310${grain}M186 135${grain}`} />
        <path d="M188 120c2-22 6-40 14-58" />
        <path d="M120 520c8-120 2-210-26-300" />
        <path d={`M100 260${grain}M106 292${grain}M111 324${grain}M114 356${grain}`} transform="rotate(-14 100 260)" />
        <path d="M250 520c-4-100 10-190 44-262" />
        <path d={`M292 268${grain}M285 300${grain}M278 332${grain}M272 364${grain}`} transform="rotate(16 292 268)" />
      </g>
    </svg>
  );
}

function LoafArt() {
  return (
    <svg className={styles.loaf} viewBox="0 0 320 200" aria-hidden="true">
      <ellipse className={styles.loafShadow} cx="166" cy="176" rx="140" ry="14" />
      <path className={styles.loafBody} d="M30 150c-6-60 50-112 130-112s140 48 132 112c-2 16-16 24-40 24H70c-24 0-38-8-40-24Z" />
      <path className={styles.loafScore} d="M96 70c18 14 30 36 34 64M146 56c18 16 30 40 32 74M198 58c16 16 26 38 28 66" />
    </svg>
  );
}

export default function BakeryTemplate({ demo }: { demo: DemoView }) {
  const rows = infoRows(demo);
  const address = rows.find((r) => r.key === "address");
  const others = rows.filter((r) => r.key !== "address");
  return (
    <DemoFrame shopName={demo.name} template={demo.template}>
      <header className={styles.hero}>
        <p className={styles.vertical}>{areaLabel(demo)}</p>
        <div className={styles.heroText}>
          <p className={styles.kicker}>
            <span className={styles.kickerEn}>{CATEGORY_EN[demo.category]}</span>
            <span className={styles.kickerRule} aria-hidden="true" />
            <span>{areaName(demo)}</span>
          </p>
          <h1 className={styles.name} style={nameStyle(demo.name)}>
            {demo.name}
          </h1>
        </div>
        <div className={styles.heroArt} aria-hidden="true">
          <WheatArt />
          <div className={styles.sheet}>
            <LoafArt />
          </div>
        </div>
        <p className={styles.giant} aria-hidden="true">
          {CATEGORY_EN[demo.category]}
        </p>
      </header>

      <main className={styles.main}>
        {demo.description && (
          <section className={styles.about} aria-labelledby="bakery-about">
            <h2 id="bakery-about" className={styles.aboutTitle}>
              About
            </h2>
            <p className={styles.lead}>{demo.description}</p>
          </section>
        )}

        {demo.menuItems.length > 0 && (
          <section className={styles.section} aria-labelledby="bakery-menu">
            <h2 id="bakery-menu" className={styles.sectionTitle}>
              <span className={styles.titleEn}>Menu</span>
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
          <section className={styles.section} aria-labelledby="bakery-info">
            <h2 id="bakery-info" className={styles.sectionTitle}>
              <span className={styles.titleEn}>Information</span>
              <span className={styles.titleJa}>お店の情報</span>
            </h2>
            <div className={styles.paper}>
              {address && (
                <div className={styles.address}>
                  <p className={styles.rowLabel}>
                    <InfoIcon kind="address" className={styles.icon} />
                    {address.label}
                    <span className={styles.rowEn}>{address.en}</span>
                  </p>
                  <p className={styles.addressValue}>{address.value}</p>
                </div>
              )}
              {others.length > 0 && (
                <dl className={styles.rows}>
                  {others.map((row) => (
                    <div key={row.key} className={styles.row}>
                      <dt className={styles.rowLabel}>
                        <InfoIcon kind={row.key} className={styles.icon} />
                        {row.label}
                        <span className={styles.rowEn}>{row.en}</span>
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
