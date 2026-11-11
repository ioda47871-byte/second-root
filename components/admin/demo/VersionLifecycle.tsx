"use client";
/**
 * DEV-196d-6 (spec §4.6・§6.6・§9.4・§9.5): 品質承認を取り下げる / 版を取り消す (通常・急ぎ). Each is the admin's own explicit
 * action in two steps (choose → read what happens → confirm). Revoking needs a fixed reason. While a send screen is
 * open (send_opened) nothing here can be pressed: the open send is shown with the way to the Today screen, and it is
 * never settled or cancelled from here. After a revoke the page stays on the revoked version (no switch to another
 * version or demo, no suggestion that acts by itself).
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { revokeDemoVersion, withdrawDemoApproval } from "@/app/admin/sales/_actions/demo-versions";
import {
  APPROVAL_OPEN_MESSAGE,
  REVOKE_REASON_LABEL,
  REVOKE_REASONS,
  revokeEffects,
  unsentLegacyApprovalsText,
  URGENT_REVOKE_TEXT,
  WITHDRAW_CONFIRM_TEXT,
  WITHDRAW_SEND_EFFECT_TEXT,
  type RevokeReason,
} from "@/lib/sales/demo-version/admin-messages";
import { URGENT_REVOKE_REASONS } from "@/lib/sales/demo-version/lifecycle-input";
import styles from "./demo.module.css";

export type LifecycleVersion = {
  id: string;
  versionNo: number;
  bundleSha256: string;
  revocable: boolean;
  activeApprovalId: string | null;
  /** this version is the shop's approved version (sales_demos.approved_version_id) */
  isApprovedVersion: boolean;
};
type Step = null | "withdraw" | "revoke" | "urgent";

export default function VersionLifecycle({
  prospectId,
  version,
  openSends,
  unsentLegacyApprovals = 0,
}: {
  prospectId: string;
  version: LifecycleVersion;
  openSends: number;
  /** unsent React-demo send approvals of this shop (shown when removing the approved version would reactivate them) */
  unsentLegacyApprovals?: number;
}) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(null);
  const [code, setCode] = useState<RevokeReason | "">("");
  const [urgentCode, setUrgentCode] = useState<RevokeReason | "">("");
  const [result, setResult] = useState<{ kind: "error" | "done"; text: string } | null>(null);
  const [pending, start] = useTransition();
  const blocked = openSends > 0;

  const done = (text: string) => {
    setResult({ kind: "done", text });
    setStep(null);
    // stay on this version: no automatic switch to another version or demo
    router.replace(`/admin/sales/demos/${prospectId}?v=${version.id}`);
    router.refresh();
  };
  const withdraw = () =>
    start(async () => {
      setResult(null);
      if (!version.activeApprovalId) return;
      const r = await withdrawDemoApproval({ prospectId, versionId: version.id, reviewId: version.activeApprovalId, bundleSha256: version.bundleSha256, confirmed: true });
      if (r.ok) done("品質承認を取り下げました。この版は下書きに戻りました。");
      else setResult({ kind: "error", text: r.error });
    });
  const revoke = (urgent: boolean) =>
    start(async () => {
      setResult(null);
      const c = urgent ? urgentCode : code;
      if (!c) return;
      const r = await revokeDemoVersion({ prospectId, versionId: version.id, bundleSha256: version.bundleSha256, code: c, urgent, confirmed: true });
      if (r.ok) done("この版を取り消しました。表示しません。ほかの版や React のデモへは切り替えていません。");
      else setResult({ kind: "error", text: r.error });
    });

  const legacyCount = unsentLegacyApprovalsText(unsentLegacyApprovals);
  const effects = (
    <ul className={styles.list} data-revoke-effects="">
      {revokeEffects({ hasActiveApproval: version.activeApprovalId !== null, isApprovedVersion: version.isApprovedVersion }).map((e) => (
        <li key={e}>{e}</li>
      ))}
      {version.isApprovedVersion && legacyCount && <li data-legacy-approvals={unsentLegacyApprovals}>{legacyCount}</li>}
    </ul>
  );

  return (
    <section className={styles.panel} aria-labelledby="lifecycle-h" data-lifecycle={version.versionNo}>
      <h2 id="lifecycle-h" className={styles.h2}>
        v{version.versionNo} の取り下げ・取り消し
      </h2>
      {blocked && (
        <div className={styles.warn} role="status" data-lifecycle-blocked="approval_open">
          <p style={{ margin: 0 }}>{APPROVAL_OPEN_MESSAGE}</p>
          <p className={styles.note}>
            <Link href="/admin/sales">今日の画面へ（送信を決着させる）</Link>
          </p>
        </div>
      )}

      {version.activeApprovalId && (
        <div className={styles.item} data-withdraw="">
          <p style={{ margin: 0 }}>{WITHDRAW_CONFIRM_TEXT}</p>
          <p className={styles.note}>{WITHDRAW_SEND_EFFECT_TEXT}</p>
          {legacyCount && (
            <p className={styles.note} data-legacy-approvals={unsentLegacyApprovals}>
              {legacyCount}
            </p>
          )}
          {step === "withdraw" ? (
            <div className={styles.warn} data-confirm-step="withdraw">
              <p style={{ margin: 0 }}>本当に品質承認を取り下げますか。</p>
              <div className={styles.tabs} style={{ marginTop: 8 }}>
                <button type="button" className={styles.primary} disabled={blocked || pending} onClick={withdraw}>
                  取り下げる
                </button>
                <button type="button" className={styles.tab} onClick={() => setStep(null)}>
                  やめる
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className={styles.tab} disabled={blocked || pending} onClick={() => setStep("withdraw")}>
              品質承認を取り下げる…
            </button>
          )}
        </div>
      )}

      {version.revocable && (
        <>
          <div className={styles.item} data-revoke="normal">
            <label className={styles.sub} style={{ display: "block" }}>
              取り消しの理由
              <select className={styles.select} value={code} onChange={(e) => setCode(e.target.value as RevokeReason | "")} disabled={blocked || pending}>
                <option value="">（選んでください）</option>
                {REVOKE_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {REVOKE_REASON_LABEL[r]}
                  </option>
                ))}
              </select>
            </label>
            {step === "revoke" ? (
              <div className={styles.warn} data-confirm-step="revoke">
                <p style={{ margin: 0 }}>
                  理由「{code ? REVOKE_REASON_LABEL[code] : ""}」で v{version.versionNo} を取り消すと:
                </p>
                {effects}
                <div className={styles.tabs} style={{ marginTop: 8 }}>
                  <button type="button" className={styles.danger} disabled={blocked || pending || !code} onClick={() => revoke(false)}>
                    取り消す（元に戻せません）
                  </button>
                  <button type="button" className={styles.tab} onClick={() => setStep(null)}>
                    やめる
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" className={styles.tab} style={{ marginTop: 8 }} disabled={blocked || pending || !code} onClick={() => setStep("revoke")}>
                版を取り消す…
              </button>
            )}
          </div>

          <div className={styles.urgent} data-revoke="urgent">
            <p style={{ margin: 0 }}>
              <strong>{URGENT_REVOKE_TEXT}</strong>
            </p>
            <label className={styles.sub} style={{ display: "block", marginTop: 8 }}>
              急ぎの理由
              <select className={styles.select} value={urgentCode} onChange={(e) => setUrgentCode(e.target.value as RevokeReason | "")} disabled={blocked || pending}>
                <option value="">（選んでください）</option>
                {URGENT_REVOKE_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {REVOKE_REASON_LABEL[r]}
                  </option>
                ))}
              </select>
            </label>
            {step === "urgent" ? (
              <div data-confirm-step="urgent" style={{ marginTop: 8 }}>
                <p style={{ margin: 0 }}>今すぐ止まるもの:</p>
                {effects}
                <div className={styles.tabs} style={{ marginTop: 8 }}>
                  <button type="button" className={styles.danger} disabled={blocked || pending || !urgentCode} onClick={() => revoke(true)}>
                    急ぎで取り消す（元に戻せません）
                  </button>
                  <button type="button" className={styles.tab} onClick={() => setStep(null)}>
                    やめる
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" className={styles.danger} style={{ marginTop: 8 }} disabled={blocked || pending || !urgentCode} onClick={() => setStep("urgent")}>
                急ぎで取り消す…
              </button>
            )}
          </div>
        </>
      )}

      {result && (
        <p className={result.kind === "error" ? styles.alert : styles.warn} role={result.kind === "error" ? "alert" : "status"} data-lifecycle-result={result.kind}>
          {result.text}
        </p>
      )}
    </section>
  );
}
