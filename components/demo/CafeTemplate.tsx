import type { DemoView } from "@/lib/sales/demo-content";
import DemoFrame from "./DemoFrame";
import { areaLabel, CATEGORY_EN, infoRows, nameStyle, ordinal } from "./info";
import styles from "./cafe.module.css";

// cafe_v1 — contemporary cafe on an editorial grid. Generic headings and
// fixed English labels only; everything shop-specific is a verified fact.
// Hours get a large card only when they were confirmed.

function CupArt() {
  return (
    <svg className={styles.cup} viewBox="0 0 400 400" aria-hidden="true">
      <circle className={styles.cupSaucer} cx="200" cy="220" r="170" />
      <circle className={styles.cupRing} cx="200" cy="220" r="150" />
      <circle className={styles.cupRim} cx="200" cy="220" r="104" />
      <circle className={styles.cupCoffee} cx="200" cy="220" r="86" />
      <circle className={styles.cupCrema} cx="200" cy="220" r="52" />
      <path className={styles.cupHandle} d="M304 196h26a24 24 0 0 1 0 48h-26" />
      <g className={styles.steam}>
        <path d="M168 110c-14-18 14-30 0-50s14-32 0-52" />
        <path d="M204 104c-14-18 14-30 0-50s14-32 0-52" />
        <path d="M240 110c-14-18 14-30 0-50s14-32 0-52" />
      </g>
    </svg>
  );
}

export default function CafeTemplate({ demo }: { demo: DemoView }) {
  const rows = infoRows(demo);
  const hours = rows.find((r) => r.key === "hours");
  // Closed days sit on the hours card when there is one.
  const closed = hours ? rows.find((r) => r.key === "closedDays") : undefined;
  const address = rows.find((r) => r.key === "address");
  const others = rows.filter((r) => r !== hours && r !== closed && r !== address);
  return (
    <DemoFrame shopName={demo.name} template={demo.template}>
      <header className={styles.hero} data-hours={hours ? "" : undefined}>
        <p className={styles.masthead}>
          <span className={styles.mastEn}>{CATEGORY_EN[demo.category]}</span>
          <span>{areaLabel(demo)}</span>
          <span className={styles.mastEn}>Nagoya</span>
        </p>
        <div className={styles.heroText}>
          <h1 className={styles.name} style={nameStyle(demo.name)}>
            {demo.name}
          </h1>
        </div>
        <div className={styles.heroArt} aria-hidden="true">
          <CupArt />
        </div>
        {hours && (
          <dl className={styles.hoursCard}>
            <div className={styles.hoursMain}>
              <dt className={styles.hoursLabel}>
                <span className={styles.hoursEn}>{hours.en}</span>
                {hours.label}
              </dt>
              <dd className={styles.hoursValue}>{hours.value}</dd>
            </div>
            {closed && (
              <div className={styles.hoursSub}>
                <dt className={styles.hoursLabel}>
                  <span className={styles.hoursEn}>{closed.en}</span>
                  {closed.label}
                </dt>
                <dd className={styles.hoursSubValue}>{closed.value}</dd>
              </div>
            )}
          </dl>
        )}
      </header>

      <main className={styles.main}>
        {demo.description && (
          <section className={styles.split} aria-labelledby="cafe-about">
            <h2 id="cafe-about" className={styles.splitTitle}>
              About
            </h2>
            <p className={styles.lead}>{demo.description}</p>
          </section>
        )}

        {demo.menuItems.length > 0 && (
          <section className={styles.split} aria-labelledby="cafe-menu">
            <h2 id="cafe-menu" className={styles.splitTitle}>
              <span>Menu</span>
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

        {(address || others.length > 0) && (
          <section className={styles.split} aria-labelledby="cafe-info">
            <h2 id="cafe-info" className={styles.splitTitle}>
              <span>Information</span>
              <span className={styles.titleJa}>お店について</span>
            </h2>
            <div className={styles.infoGrid}>
              {address && (
                <div className={styles.addressCell}>
                  <svg className={styles.addressArt} viewBox="0 0 120 120" aria-hidden="true">
                    <circle cx="60" cy="60" r="56" />
                    <circle cx="60" cy="60" r="36" />
                    <circle cx="60" cy="60" r="8" />
                  </svg>
                  <p className={styles.cellLabel}>
                    <span className={styles.cellEn}>{address.en}</span>
                    {address.label}
                  </p>
                  <p className={styles.addressValue}>{address.value}</p>
                </div>
              )}
              {others.length > 0 && (
                <dl className={styles.cells}>
                  {others.map((row) => (
                    <div key={row.key} className={styles.cell}>
                      <dt className={styles.cellLabel}>
                        <span className={styles.cellEn}>{row.en}</span>
                        {row.label}
                      </dt>
                      <dd className={styles.cellValue}>{row.value}</dd>
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
