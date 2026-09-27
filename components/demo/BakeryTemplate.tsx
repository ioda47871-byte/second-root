import type { DemoView } from "@/lib/sales/demo-content";
import DemoFrame from "./DemoFrame";
import { InfoIcon } from "./icons";
import { areaLabel, infoRows } from "./info";
import styles from "./bakery.module.css";

// bakery_v1. Headings are generic; every shop-specific word comes from a
// verified fact. Sections without facts are omitted.

function Loaves() {
  return (
    <svg className={styles.loaves} viewBox="0 0 400 240" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <g fill="#ecd3aa" opacity="0.55">
        <ellipse cx="40" cy="40" rx="46" ry="26" />
        <ellipse cx="370" cy="200" rx="52" ry="30" />
        <ellipse cx="350" cy="36" rx="22" ry="14" />
      </g>
      <g stroke="#dcb987" strokeWidth="3" strokeLinecap="round" opacity="0.6" fill="none">
        <path d="M18 34c10-6 16-6 26 0M38 30c10-6 16-6 26 0" />
        <path d="M344 196c10-6 16-6 26 0M364 190c10-6 16-6 26 0" />
      </g>
    </svg>
  );
}

function Wheat() {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="#c07a3e" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <path d="M12 21V9M12 13c-3 0-4-2-4-4 2 0 4 1 4 4Zm0 0c3 0 4-2 4-4-2 0-4 1-4 4Zm0-4c-3 0-4-2-4-4 2 0 4 1 4 4Zm0 0c3 0 4-2 4-4-2 0-4 1-4 4Z" />
    </svg>
  );
}

export default function BakeryTemplate({ demo }: { demo: DemoView }) {
  const rows = infoRows(demo);
  return (
    <DemoFrame shopName={demo.name} template={demo.template}>
      <header className={styles.hero}>
        <Loaves />
        <div className={styles.heroInner}>
          <p className={styles.label}>{areaLabel(demo, "パン屋")}</p>
          <h1 className={styles.name}>{demo.name}</h1>
          {demo.description && <p className={styles.description}>{demo.description}</p>}
        </div>
      </header>
      <main className={styles.body}>
        {demo.menuItems.length > 0 && (
          <section aria-labelledby="bakery-menu">
            <h2 id="bakery-menu" className={styles.sectionTitle}>
              パンのご紹介
            </h2>
            <ul className={styles.menu}>
              {demo.menuItems.map((item) => (
                <li key={item} className={styles.menuItem}>
                  <Wheat />
                  {item}
                </li>
              ))}
            </ul>
          </section>
        )}
        {rows.length > 0 && (
          <section aria-labelledby="bakery-info">
            <h2 id="bakery-info" className={styles.sectionTitle}>
              お店の情報
            </h2>
            <dl className={styles.info}>
              {rows.map((row) => (
                <div key={row.key} className={styles.row}>
                  <InfoIcon kind={row.key} className={styles.icon} />
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
