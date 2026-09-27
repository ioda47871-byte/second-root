import type { DemoView } from "@/lib/sales/demo-content";
import DemoFrame from "./DemoFrame";
import { areaLabel, infoRows } from "./info";
import styles from "./cafe.module.css";

// cafe_v1. Generic headings only; everything shop-specific is a verified
// fact. Hours are shown prominently only when they were confirmed.

function Cup() {
  return (
    <svg className={styles.cup} viewBox="0 0 120 120" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
      <path d="M28 52h56v18a28 28 0 0 1-56 0V52Z" />
      <path d="M84 58h6a10 10 0 0 1 0 20h-8" />
      <path d="M22 104h76" />
      <path d="M46 24c-4 6 4 10 0 16M58 20c-4 6 4 10 0 16M70 24c-4 6 4 10 0 16" />
    </svg>
  );
}

export default function CafeTemplate({ demo }: { demo: DemoView }) {
  const rows = infoRows(demo).filter((r) => r.key !== "hours");
  return (
    <DemoFrame shopName={demo.name} template={demo.template}>
      <header className={styles.hero}>
        <div className={styles.heroText}>
          <p className={styles.label}>{areaLabel(demo)}</p>
          <h1 className={styles.name}>{demo.name}</h1>
          {demo.description && <p className={styles.description}>{demo.description}</p>}
        </div>
        <Cup />
      </header>
      {demo.hours && (
        <div className={styles.hoursCard}>
          <p className={styles.hoursLabel}>営業時間</p>
          <p className={styles.hoursValue}>{demo.hours}</p>
        </div>
      )}
      <main className={styles.body}>
        {demo.menuItems.length > 0 && (
          <section aria-labelledby="cafe-menu">
            <h2 id="cafe-menu" className={styles.sectionTitle}>
              メニュー
            </h2>
            <ul className={styles.menu}>
              {demo.menuItems.map((item) => (
                <li key={item} className={styles.menuItem}>
                  {item}
                </li>
              ))}
            </ul>
          </section>
        )}
        {rows.length > 0 && (
          <section aria-labelledby="cafe-info">
            <h2 id="cafe-info" className={styles.sectionTitle}>
              お店について
            </h2>
            <dl className={styles.info}>
              {rows.map((row) => (
                <div key={row.key} className={styles.row}>
                  <dt>{row.label}</dt>
                  <dd>{row.value}</dd>
                </div>
              ))}
            </dl>
          </section>
        )}
      </main>
    </DemoFrame>
  );
}
