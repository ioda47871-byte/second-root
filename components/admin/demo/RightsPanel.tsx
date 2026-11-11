/**
 * DEV-196d-3 (spec §8.1–§8.3, read only): every photo of the version with its rights in the owner's words. A real
 * shop's AI concept image carries the red badge 「AI生成・管理者だけ・共有不可」. An image whose rights do not allow the
 * preview (unknown, revoked, expired, or not bound to these bytes) shows 「権利不明のため使用不可」 and no thumbnail —
 * and the whole version is then not previewable. Provenance is a date, a yes/no and a hash prefix only.
 */
import { RIGHTS_BLOCKED_LABEL, SOURCE_KIND_LABEL } from "@/lib/sales/demo-version/admin-messages";
import type { ImageView } from "@/lib/sales/demo-version/view-model";
import styles from "./demo.module.css";

export default function RightsPanel({ images, photoBase }: { images: ImageView[]; photoBase: string | null }) {
  return (
    <section className={styles.panel} aria-labelledby="rights-h">
      <h2 id="rights-h" className={styles.h2}>
        画像の権利
      </h2>
      {images.length === 0 ? (
        <p className={styles.note}>この版に写真はありません。</p>
      ) : (
        <ul className={styles.images}>
          {images.map((img) => (
            <li key={img.path} className={styles.image} data-image={img.path} data-rights={img.rightsStatus} data-previewable={img.previewable ? "true" : "false"}>
              {img.previewable && photoBase ? (
                // eslint-disable-next-line @next/next/no-img-element -- served by the artifact route after its own rights check
                <img className={styles.thumb} src={`${photoBase}${img.path.slice("page/".length)}`} alt="" width={72} height={72} referrerPolicy="no-referrer" loading="lazy" />
              ) : (
                <span className={styles.thumbBlocked}>{img.previewable ? "表示なし" : RIGHTS_BLOCKED_LABEL}</span>
              )}
              <div>
                <div className={styles.mono}>{img.path.slice("page/".length)}</div>
                <div>
                  {img.aiBadge && (
                    <span className={styles.tagAi} data-ai-badge="true">
                      {img.aiBadge}
                    </span>
                  )}{" "}
                  <span className={img.previewable ? undefined : styles.unconfirmed}>{img.rightsLabel}</span>
                </div>
                {img.sourceKind && Object.hasOwn(SOURCE_KIND_LABEL, img.sourceKind) && <div className={styles.sub}>出所: {SOURCE_KIND_LABEL[img.sourceKind]}</div>}
                {img.adminLabel && <div className={styles.sub}>表示の注記: {img.adminLabel}</div>}
                {img.provenance && (
                  <div className={styles.sub}>
                    生成日 {img.provenance.generatedOn ?? "不明"}・承認の記録 {img.provenance.hasApprovalId ? "あり" : "なし"}
                    {img.provenance.promptShaPrefix ? `・prompt ${img.provenance.promptShaPrefix}…` : ""}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
