"use client";
/**
 * DEV-263f (Issue #263): 店舗の事実の登録 — the owner pastes the shop's facts pack (JSON), the server checks it against
 * the demo's content and shows the facts (内容を確認), then the owner registers exactly those bytes
 * (この事実を登録する → sales_register_facts_pack as the admin). Append-only: a registration is never changed; a newer one
 * becomes the shop's current facts, and a send whose copy was reviewed on other facts is refused.
 */
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { previewDemoFactsPack, registerDemoFactsPack } from "@/app/admin/sales/_actions/demo-versions";
import type { FactsPackPreview } from "@/lib/admin/demo-facts-pack";
import styles from "./demo.module.css";

export type CurrentFactsPack = { kind: "none" } | { kind: "error" } | { kind: "not_set_up" } | { kind: "ok"; sha256: string; recordedAt: string; via: string };

const VIA_LABEL: Record<string, string> = { admin_session: "管理画面", operator_cli: "登録の CLI" };

export default function FactsPackRegistration({ prospectId, current, enabled }: { prospectId: string; current: CurrentFactsPack; enabled: boolean }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<FactsPackPreview | null>(null);
  const [result, setResult] = useState<{ kind: "error" | "done"; text: string } | null>(null);
  const [pending, start] = useTransition();

  const check = () =>
    start(async () => {
      setResult(null);
      setPreview(await previewDemoFactsPack({ prospectId, factsPack: text }));
    });
  const register = () =>
    start(async () => {
      if (!preview?.ok) return;
      const r = await registerDemoFactsPack({ prospectId, factsPack: text, sha256: preview.sha256 });
      if (r.ok) {
        setResult({ kind: "done", text: r.replayed ? "この事実はすでに今の登録です（変更なし）。" : "店舗の事実を登録しました。記録は変更できません。" });
        setPreview(null);
        setText("");
        router.refresh();
      } else setResult({ kind: "error", text: r.error });
    });

  return (
    <section className={styles.panel} aria-labelledby="facts-pack-h" data-facts-registration="">
      <h2 id="facts-pack-h" className={styles.h2}>
        店舗の事実の登録（facts pack）
      </h2>
      <p style={{ margin: 0 }} data-facts-current={current.kind}>
        {current.kind === "ok"
          ? `今の登録: sha256 ${current.sha256.slice(0, 12)}…（${new Date(current.recordedAt).toLocaleString("ja-JP")}、${VIA_LABEL[current.via] ?? current.via}）`
          : current.kind === "none"
            ? "まだ登録されていません。文章の監査は、登録した事実と照合したものだけが送信の対象になります。"
            : current.kind === "not_set_up"
              ? "店舗の事実の保存先がこの DB にまだ設定されていません（migration の適用前）。登録できません。"
              : "登録を読み込めませんでした。画面を再読み込みしてください。"}
      </p>
      <p className={styles.note}>確認済みの事実だけを登録します。デモの事実がこの facts pack から作られていないときは登録できません。登録は追記のみで、後から変更・削除できません。</p>
      {enabled && current.kind !== "not_set_up" ? (
        <>
          <label className={styles.note}>
            facts pack（JSON）
            <textarea
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setPreview(null);
              }}
              rows={6}
              disabled={pending}
              spellCheck={false}
              style={{ display: "block", width: "100%", fontFamily: "monospace" }}
              data-facts-input=""
            />
          </label>
          <p style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "8px 0 0" }}>
            <button type="button" className={styles.primary} disabled={pending || text.trim().length < 2} onClick={check}>
              内容を確認
            </button>
            <button type="button" className={styles.primary} disabled={pending || !preview?.ok || preview.alreadyCurrent} onClick={register}>
              この事実を登録する
            </button>
          </p>
          {preview && (
            <div className={preview.ok ? styles.item : styles.alert} role={preview.ok ? "status" : "alert"} data-facts-preview={preview.ok ? "ok" : "refused"}>
              {preview.ok ? (
                <p style={{ margin: 0 }}>
                  {preview.shopId} の事実 {preview.facts.length} 件（sha256 {preview.sha256.slice(0, 12)}…）。デモの事実と一致しました。
                  {preview.alreadyCurrent ? "これはすでに今の登録です。" : ""}
                </p>
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
            <p className={result.kind === "error" ? styles.alert : styles.note} role={result.kind === "error" ? "alert" : "status"} data-facts-result={result.kind}>
              {result.text}
            </p>
          )}
        </>
      ) : null}
    </section>
  );
}
