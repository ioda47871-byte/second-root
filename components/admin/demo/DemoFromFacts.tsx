"use client";
/**
 * DEV-263h (Issue #263): デモの事実を facts pack から作る — the owner pastes the shop's confirmed facts pack (JSON); the
 * server checks it against the prospect and its demo and says what would happen (内容を確認); the owner then creates the
 * demo content from exactly those bytes and registers them in the facts store in one step
 * (sales_create_demo_from_facts as the admin). Replacing an existing demo's content needs an explicit confirmation.
 */
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createDemoFromFactsPack, previewDemoFromFactsPack } from "@/app/admin/sales/_actions/demo-versions";
import type { DemoFromFactsPreview } from "@/lib/admin/demo-onboarding";
import styles from "./demo.module.css";

export type DemoFromFactsTarget = "no_demo" | "legacy" | "facts";

const ACTION_TEXT: Record<string, string> = {
  create: "この候補にはまだデモがありません。この事実からデモの事実を作り、事実を登録します。",
  replace_legacy: "今のデモ（React のデモ）の内容を、この事実から作った内容に置き換え、事実を登録します。React のデモの表示も変わります。",
  replace_facts: "今のデモの事実（前の facts pack）を、この事実から作った内容に置き換え、事実を登録します。前の事実で作った版は送信できなくなります（取り込み直しが要ります）。",
  unchanged: "デモの事実はすでにこの facts pack から作られています。事実の登録だけを行います（同じなら変更なし）。",
};

export default function DemoFromFacts({ prospectId, target, enabled }: { prospectId: string; target: DemoFromFactsTarget; enabled: boolean }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<DemoFromFactsPreview | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [confirmIdentity, setConfirmIdentity] = useState(false);
  const [result, setResult] = useState<{ kind: "error" | "done"; text: string } | null>(null);
  const [pending, start] = useTransition();

  const reset = () => {
    setPreview(null);
    setConfirmReplace(false);
    setConfirmIdentity(false);
  };
  const check = () =>
    start(async () => {
      setResult(null);
      setConfirmReplace(false);
      setConfirmIdentity(false);
      setPreview(await previewDemoFromFactsPack({ prospectId, factsPack: text }));
    });
  const create = () =>
    start(async () => {
      if (!preview?.ok) return;
      const r = await createDemoFromFactsPack({ prospectId, factsPack: text, sha256: preview.sha256, replaceContent: preview.needsConfirm && confirmReplace, identityConfirmed: preview.identity.mismatch && confirmIdentity });
      if (r.ok) {
        setResult({
          kind: "done",
          text: r.demoCreated ? "デモの事実を作り、事実を登録しました。" : r.contentChanged ? "デモの事実を置き換え、事実を登録しました。" : r.replayed ? "変更はありません（すでに今の登録です）。" : "事実を登録しました。",
        });
        reset();
        setText("");
        router.refresh();
      } else setResult({ kind: "error", text: r.error });
    });

  return (
    <section className={styles.panel} aria-labelledby="demo-from-facts-h" data-demo-from-facts={target}>
      <h2 id="demo-from-facts-h" className={styles.h2}>
        デモの事実を facts pack から作る
      </h2>
      <p style={{ margin: 0 }}>
        {target === "no_demo"
          ? "この候補にはデモがありません。確認済みの店舗の事実（facts pack）から作れます。"
          : target === "legacy"
            ? "このデモは facts pack から作られていません（React のデモ）。実店舗の版を送るには、確認済みの事実から作り直します。"
            : "このデモは facts pack から作られています。事実が変わったときだけ、新しい facts pack で置き換えます。"}
      </p>
      <p className={styles.note}>
        オーナーが確認した事実だけを貼ります。未確認の事実・写真・推測を足さない。デモの事実はサーバーと DB がこの JSON から作り、同じバイトを店舗の事実として登録します（追記のみ）。送信の承認済み・送信済み・共有中のデモは置き換えられません。
      </p>
      {enabled ? (
        <>
          <label className={styles.note}>
            facts pack（JSON）
            <textarea
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                reset();
              }}
              rows={6}
              disabled={pending}
              spellCheck={false}
              style={{ display: "block", width: "100%", fontFamily: "monospace" }}
              data-demo-from-facts-input=""
            />
          </label>
          <p style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "8px 0 0" }}>
            <button type="button" className={styles.primary} disabled={pending || text.trim().length < 2} onClick={check}>
              内容を確認
            </button>
            <button type="button" className={styles.primary} disabled={pending || !preview?.ok || (preview.needsConfirm && !confirmReplace) || (preview.identity.mismatch && !confirmIdentity)} onClick={create}>
              この事実からデモの事実を作る
            </button>
          </p>
          {preview && (
            <div className={preview.ok ? styles.item : styles.alert} role={preview.ok ? "status" : "alert"} data-demo-from-facts-preview={preview.ok ? preview.action : "refused"}>
              {preview.ok ? (
                <>
                  <p style={{ margin: 0 }}>
                    {preview.shopId} の事実 {preview.facts.length} 件（sha256 {preview.sha256.slice(0, 12)}…）。{ACTION_TEXT[preview.action]}
                  </p>
                  <dl style={{ margin: "8px 0 0" }} data-demo-from-facts-identity={preview.identity.mismatch ? "mismatch" : "match"}>
                    <dt>候補の登録</dt>
                    <dd>
                      {preview.identity.prospectName}／{preview.identity.prospectAddress}
                    </dd>
                    <dt>facts pack</dt>
                    <dd>
                      {preview.identity.packName}／{preview.identity.packAddress}
                    </dd>
                  </dl>
                  {preview.identity.mismatch && (
                    <>
                      <p className={styles.alert} role="alert" style={{ margin: "8px 0 0" }}>
                        店名または住所が候補の登録と一致しません。別の店の事実ではないか確かめてください。
                      </p>
                      <label style={{ display: "block", marginTop: 8 }}>
                        <input type="checkbox" checked={confirmIdentity} onChange={(e) => setConfirmIdentity(e.target.checked)} disabled={pending} data-demo-from-facts-identity-confirm="" /> 店名・住所の違いを確かめ、同じ店であることを確認しました
                      </label>
                    </>
                  )}
                  {preview.needsConfirm && (
                    <label style={{ display: "block", marginTop: 8 }}>
                      <input type="checkbox" checked={confirmReplace} onChange={(e) => setConfirmReplace(e.target.checked)} disabled={pending} data-demo-from-facts-confirm="" /> 今のデモの内容を置き換えることを確認しました
                    </label>
                  )}
                </>
              ) : (
                <p style={{ margin: 0 }}>{preview.error}</p>
              )}
              {!!preview.facts?.length && (
                <ul className={styles.list}>
                  {preview.facts.map((f) => (
                    <li key={f.id}>
                      {f.key}: {f.value}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {result && (
            <p className={result.kind === "error" ? styles.alert : styles.note} role={result.kind === "error" ? "alert" : "status"} data-demo-from-facts-result={result.kind}>
              {result.text}
            </p>
          )}
        </>
      ) : null}
    </section>
  );
}
