/**
 * DEV-196d-3 (spec §7.4, MVP_SPEC §7): the shop's verified facts as stored for the demo, so the admin can check the
 * version against them. A missing fact is shown as 未確認 — never filled in. Email addresses are never shown: such a
 * fact reads 「非表示（メールアドレスを含む）」 (it exists, it is just not shown), and a value cut at its display limit
 * ends with 「…（以下略）」. Whether
 * the version was made from these same facts is shown as same / changed / unknown (unknown never reads as same).
 */
import { CATEGORY_LABEL } from "@/lib/sales/demo-content";
import { UNCONFIRMED } from "@/lib/sales/evidence";
import type { VersionView } from "@/lib/sales/demo-version/view-model";
import styles from "./demo.module.css";

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;

/** Review of #248 L2: a stored fact that holds an email address is hidden — which is not the same as unconfirmed. */
export const FACT_HIDDEN_EMAIL = "非表示（メールアドレスを含む）";
/** …and a value cut at its display limit says so, so it never reads as the whole fact. */
export const FACT_TRUNCATED = "…（以下略）";

export type FactRow = { label: string; value: string | null; hidden: "email" | null };

type Text = { value: string | null; hidden: "email" | null };

function text(value: unknown, max: number): Text {
  if (typeof value !== "string") return { value: null, hidden: null };
  const t = value.trim();
  if (!t) return { value: null, hidden: null };
  if (EMAIL.test(t)) return { value: null, hidden: "email" };
  return { value: t.length > max ? `${t.slice(0, max)}${FACT_TRUNCATED}` : t, hidden: null };
}

/** The facts the demo may show, from sales_demos.content. Pure. */
export function demoFacts(content: unknown): FactRow[] {
  const c = content && typeof content === "object" && !Array.isArray(content) ? (content as Record<string, unknown>) : {};
  const category = typeof c.category === "string" && Object.hasOwn(CATEGORY_LABEL, c.category) ? CATEGORY_LABEL[c.category as keyof typeof CATEGORY_LABEL] : null;
  const items = Array.isArray(c.menu_items) ? c.menu_items.map((m) => text(m, 100)) : [];
  const shown = items.filter((m) => m.value !== null).map((m) => m.value!);
  const menuHidden = items.some((m) => m.hidden === "email");
  const menu = shown.length > 12 ? `${shown.slice(0, 12).join("・")}${FACT_TRUNCATED}` : shown.join("・");
  const row = (label: string, t: Text): FactRow => ({ label, ...t });
  return [
    row("店名", text(c.name, 200)),
    row("業種", { value: category, hidden: null }),
    row("区", text(c.ward, 20)),
    row("住所", text(c.address, 300)),
    row("営業時間", text(c.hours, 500)),
    row("定休日", text(c.closed_days, 500)),
    row("アクセス", text(c.access, 500)),
    row("電話", text(c.phone, 30)),
    {
      label: "メニュー",
      value: menu ? (menuHidden ? `${menu}（メールアドレスを含む項目は非表示）` : menu) : null,
      hidden: !menu && menuHidden ? "email" : null,
    },
    row("紹介文", text(c.description, 500)),
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
            <dd className={r.value === null && r.hidden === null ? styles.unconfirmed : undefined} data-fact-state={r.value !== null ? "shown" : r.hidden ? "hidden" : "unconfirmed"}>
              {r.value ?? (r.hidden === "email" ? FACT_HIDDEN_EMAIL : UNCONFIRMED)}
            </dd>
          </div>
        ))}
      </dl>
      <p className={styles.note}>未確認のことを、版の頁が事実として書いていないかを確かめてください。創作の見出しは事実ではありません。</p>
    </section>
  );
}
