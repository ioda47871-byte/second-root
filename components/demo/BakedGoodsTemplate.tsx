import type { DemoView } from "@/lib/sales/demo-content";
import DemoFrame from "./DemoFrame";
import { areaLabel, infoRows } from "./info";
import styles from "./bakedGoods.module.css";

// baked_goods_v1. Generic headings only; everything shop-specific is a
// verified fact. Sections without facts are omitted.

function Ornament() {
  return (
    <svg className={styles.ornament} viewBox="0 0 120 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M0 6h46M74 6h46" />
      <path d="M60 1l5 5-5 5-5-5 5-5Z" />
    </svg>
  );
}

export default function BakedGoodsTemplate({ demo }: { demo: DemoView }) {
  const rows = infoRows(demo);
  return (
    <DemoFrame shopName={demo.name} template={demo.template}>
      <header className={styles.hero}>
        <div className={styles.frame}>
          <p className={styles.label}>{areaLabel(demo)}</p>
          <h1 className={styles.name}>{demo.name}</h1>
          <Ornament />
          {demo.description && <p className={styles.description}>{demo.description}</p>}
        </div>
      </header>
      <main className={styles.body}>
        {demo.menuItems.length > 0 && (
          <section aria-labelledby="baked-menu">
            <h2 id="baked-menu" className={styles.sectionTitle}>
              メニュー
            </h2>
            <ul className={styles.menu}>
              {demo.menuItems.map((item, i) => (
                <li key={`${i}-${item}`} className={styles.menuItem}>
                  {item}
                </li>
              ))}
            </ul>
          </section>
        )}
        {rows.length > 0 && (
          <section aria-labelledby="baked-info">
            <h2 id="baked-info" className={styles.sectionTitle}>
              店舗のご案内
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
