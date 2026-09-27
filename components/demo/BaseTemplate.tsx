import { CATEGORY_LABEL, type DemoView } from "@/lib/sales/demo-content";
import DemoFrame from "./DemoFrame";
import styles from "./demo.module.css";

// Shared layout used by all three templates until each gets its own design
// (DEV-005–007). Unknown facts are simply omitted — nothing is invented.

export default function BaseTemplate({ demo }: { demo: DemoView }) {
  const info: Array<[string, string | null]> = [
    ["営業時間", demo.hours],
    ["定休日", demo.closedDays],
    ["住所", demo.address],
    ["アクセス", demo.access],
    ["電話", demo.phone],
  ];
  const shown = info.filter((row): row is [string, string] => row[1] !== null);

  return (
    <DemoFrame shopName={demo.name} template={demo.template}>
      <header className={styles.hero}>
        <p className={styles.eyebrow}>
          {demo.ward ? `名古屋市${demo.ward}の` : ""}
          {CATEGORY_LABEL[demo.category]}
        </p>
        <h1 className={styles.title}>{demo.name}</h1>
        {demo.description && <p className={styles.lead}>{demo.description}</p>}
      </header>
      <main className={styles.main}>
        {demo.menuItems.length > 0 && (
          <section className={styles.card} aria-labelledby="demo-menu">
            <h2 id="demo-menu" className={styles.cardTitle}>
              メニュー
            </h2>
            <ul className={styles.menu}>
              {demo.menuItems.map((item, i) => (
                <li key={`${i}-${item}`}>{item}</li>
              ))}
            </ul>
          </section>
        )}
        {shown.length > 0 && (
          <section className={styles.card} aria-labelledby="demo-info">
            <h2 id="demo-info" className={styles.cardTitle}>
              店舗情報
            </h2>
            <dl className={styles.info}>
              {shown.map(([label, value]) => (
                <div key={label} style={{ display: "contents" }}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </section>
        )}
      </main>
    </DemoFrame>
  );
}
