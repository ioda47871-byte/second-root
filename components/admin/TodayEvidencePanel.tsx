import { UNCONFIRMED, type CheckState, type TodayEvidence } from "@/lib/sales/evidence";
import styles from "./admin.module.css";

// DEV-194: the folded evidence of a today card — why the shop is listed,
// where its facts come from (and when they were researched), and whether it
// can be contacted. Only stored values are shown; anything missing reads 未確認.

const STATE_MARK: Record<CheckState, string> = { ok: "OK", ng: "NG", unconfirmed: UNCONFIRMED };

export default function TodayEvidencePanel({ evidence }: { evidence: TodayEvidence }) {
  const { contact } = evidence;
  return (
    <details className={styles.details} data-testid="today-evidence">
      <summary>選んだ理由・出典・連絡の可否</summary>

      <section className={styles.evidence} data-testid="evidence-selection">
        <h3 className={styles.evidenceTitle}>選んだ理由（保存された項目から）</h3>
        <p>{evidence.summary}</p>
        <dl className={styles.evidenceList}>
          {evidence.lines.map((l) => (
            <div key={l.label} data-unconfirmed={l.unconfirmed || undefined}>
              <dt>{l.label}</dt>
              <dd>{l.value}</dd>
            </div>
          ))}
          <div data-unconfirmed="true" data-testid="evidence-hypothesis">
            <dt>改善の仮説</dt>
            <dd>{evidence.hypothesis ?? `${UNCONFIRMED}（保存されていません）`}</dd>
          </div>
        </dl>
      </section>

      <section className={styles.evidence} data-testid="evidence-sources">
        <h3 className={styles.evidenceTitle}>出典</h3>
        <p className={styles.muted}>
          調査日: <span data-testid="evidence-researched">{evidence.researchedDate}</span>・登録日: {evidence.registeredDate}
        </p>
        {evidence.sources.length === 0 ? (
          <p data-testid="evidence-no-sources">出典: {UNCONFIRMED}（保存された出典がありません）</p>
        ) : (
          <ul className={styles.evidenceSources}>
            {evidence.sources.map((s, i) => (
              <li key={`${s.field}-${i}`} data-testid="evidence-source" data-field={s.field} data-source-type={s.sourceType}>
                <strong>{s.fieldLabel}</strong>: {s.value}
                <br />
                <span className={styles.muted}>
                  {s.sourceTypeLabel}
                  {s.firstParty ? "（店舗自身）" : ""}・{s.verifiedDate}・
                  {s.sourceUrl ? (
                    <a href={s.sourceUrl} target="_blank" rel="noopener noreferrer nofollow">
                      出典を開く
                    </a>
                  ) : (
                    `出典URL ${UNCONFIRMED}`
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        {evidence.missingSources.length > 0 && (
          <p className={styles.muted} data-testid="evidence-missing">
            出典{UNCONFIRMED}: {evidence.missingSources.map((m) => m.fieldLabel).join("・")}
          </p>
        )}
      </section>

      <section className={styles.evidence} data-testid="evidence-contact">
        <h3 className={styles.evidenceTitle}>連絡の可否: {contact.badge}</h3>
        <ul className={styles.evidenceChecks}>
          {contact.checks.map((c) => (
            <li key={c.id} data-testid="contact-check" data-check={c.id} data-state={c.state}>
              <span className={c.state === "ok" ? styles.checkOk : styles.checkNg}>{STATE_MARK[c.state]}</span> {c.label}: {c.detail}
            </li>
          ))}
        </ul>
        {contact.unconfirmed.length > 0 && (
          <>
            <p className={styles.muted}>送る前に人が確認すること（{UNCONFIRMED}）:</p>
            <ul className={styles.evidenceChecks} data-testid="contact-unconfirmed">
              {contact.unconfirmed.map((u) => (
                <li key={u}>{u}</li>
              ))}
            </ul>
          </>
        )}
      </section>
    </details>
  );
}
