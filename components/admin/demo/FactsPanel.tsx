/**
 * DEV-196d-3 (spec §7.4, MVP_SPEC §7): the shop's verified facts as stored for the demo, so the admin can check the
 * version against them. A missing fact is shown as 未確認 — never filled in. Email addresses are never shown. Whether
 * the version was made from these same facts is shown as same / changed / unknown (unknown never reads as same).
 */
import { CATEGORY_LABEL } from "@/lib/sales/demo-content";
import { UNCONFIRMED } from "@/lib/sales/evidence";
import type { VersionView } from "@/lib/sales/demo-version/view-model";
import styles from "./demo.module.css";

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return !t || EMAIL.test(t) ? null : t.slice(0, max);
}

export type FactRow = { label: string; value: string | null };

/** The facts the demo may show, from sales_demos.content. Pure. */
export function demoFacts(content: unknown): FactRow[] {
  const c = content && typeof content === "object" && !Array.isArray(content) ? (content as Record<string, unknown>) : {};
  const category = typeof c.category === "string" && Object.hasOwn(CATEGORY_LABEL, c.category) ? CATEGORY_LABEL[c.category as keyof typeof CATEGORY_LABEL] : null;
  const menu = Array.isArray(c.menu_items) ? c.menu_items.map((m) => text(m, 100)).filter((m): m is string => m !== null).slice(0, 12) : [];
  return [
    { label: "店名", value: text(c.name, 200) },
    { label: "業種", value: category },
    { label: "区", value: text(c.ward, 20) },
    { label: "住所", value: text(c.address, 300) },
    { label: "営業時間", value: text(c.hours, 500) },
    { label: "定休日", value: text(c.closed_days, 500) },
    { label: "アクセス", value: text(c.access, 500) },
    { label: "電話", value: text(c.phone, 30) },
    { label: "メニュー", value: menu.length ? menu.join("・") : null },
    { label: "紹介文", value: text(c.description, 500) },
  ];
}

export const FACTS_STATE_TEXT: Record<VersionView["facts"], string> = {
  same: "この版は、今の事実から作られています。",
  changed: "この版を作った後に店舗の事実が変わりました（この版は品質承認できません）。",
  unknown: "今の事実と同じかどうかを確認できませんでした（同じとは扱いません）。",
};

export default function FactsPanel({ content, facts }: { content: unknown; facts: VersionView["facts"] | null }) {
  const rows = demoFacts(content);
  return (
    <section className={styles.panel} aria-labelledby="facts-h">
      <h2 id="facts-h" className={styles.h2}>
        店舗の事実
      </h2>
      {facts !== null && (
        <p className={facts === "same" ? styles.note : styles.warn} data-facts={facts} role={facts === "same" ? undefined : "status"}>
          {FACTS_STATE_TEXT[facts]}
        </p>
      )}
      <dl className={styles.facts}>
        {rows.map((r) => (
          <div key={r.label} style={{ display: "contents" }}>
            <dt>{r.label}</dt>
            <dd className={r.value === null ? styles.unconfirmed : undefined}>{r.value ?? UNCONFIRMED}</dd>
          </div>
        ))}
      </dl>
      <p className={styles.note}>未確認のことを、版の頁が事実として書いていないかを確かめてください。創作の見出しは事実ではありません。</p>
    </section>
  );
}
