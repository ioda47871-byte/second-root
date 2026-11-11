import Link from "next/link";
import { notFound } from "next/navigation";
import CompareVisual, { type CompareRender } from "@/components/admin/demo/CompareVisual";
import { CopyDiffList, FilesDiffTable, MetaDiffTable, StructureDiffTable } from "@/components/admin/demo/CompareTables";
import styles from "@/components/admin/demo/demo.module.css";
import { requireAdminPage } from "@/lib/admin/auth";
import { buildCompare } from "@/lib/admin/demo-compare";
import { loadDemoVersionsPage } from "@/lib/admin/demo-versions";
import { demoVersionsEnabled } from "@/lib/sales/demo-version/flags";
import type { VersionView } from "@/lib/sales/demo-version/view-model";

// DEV-196d-4 (spec §4.1・§7.2・§7.5): compare two versions of one shop's demo — by default the approved version (else
// the candidate's parent) against the candidate. Read only. The [prospectId] layout already answered 404 for the flag
// off, a non-admin and a shop without a demo; this page checks again before reading (every admin page does).

const label = (v: VersionView) => `v${v.versionNo}（${v.statusLabel}）`;

export default async function DemoComparePage({ params, searchParams }: PageProps<"/admin/sales/demos/[prospectId]/compare">) {
  if (!demoVersionsEnabled(process.env)) notFound();
  await requireAdminPage();
  const { prospectId } = await params;
  const sp = await searchParams;
  const ask = { a: typeof sp.a === "string" ? sp.a : null, b: typeof sp.b === "string" ? sp.b : null };

  const data = await loadDemoVersionsPage(prospectId, { env: process.env, now: new Date() });
  if (data.kind === "not_found") notFound();
  if (data.kind === "error") {
    return (
      <div className={styles.page}>
        <h1 className={styles.title}>版の比較</h1>
        <p className={styles.alert} role="alert">
          版を読み込めませんでした。画面を再読み込みしてください。
        </p>
      </div>
    );
  }
  const cmp = await buildCompare(data, ask);
  const back = `/admin/sales/demos/${data.prospectId}`;
  const renders = (v: VersionView): { pc: CompareRender; sp: CompareRender } => {
    const token = data.tokens[v.id];
    const pick = (vp: "desktop_1440" | "mobile_390") => {
      const r = v.renders.find((x) => x.viewport === vp);
      return token && r ? { src: `/demo-frame/a/${token}/${r.urlPath}`, width: r.width, height: r.height } : null;
    };
    return { pc: pick("desktop_1440"), sp: pick("mobile_390") };
  };

  return (
    <div className={styles.page} data-demo-compare-page="">
      <div>
        <p className={styles.sub}>
          <Link href={back}>版の一覧へ戻る</Link>
        </p>
        <h1 className={styles.title}>版の比較{data.shopName ? `：${data.shopName}` : ""}</h1>
      </div>

      {cmp.kind === "no_candidate" ? (
        <section className={styles.panel} data-empty="no-versions">
          <p style={{ margin: 0 }}>比べる版がありません。</p>
        </section>
      ) : (
        <>
          <form method="get" className={`${styles.panel} ${styles.picker}`} aria-label="比べる版を選ぶ">
            <label>
              <span className={styles.sub}>比べる元（左）</span>
              <select name="a" className={styles.select} defaultValue={cmp.kind === "ok" ? cmp.a.id : ""}>
                {cmp.kind === "no_base" && <option value="">（選んでください）</option>}
                {cmp.choices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {label(v)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className={styles.sub}>比べる版（右）</span>
              <select name="b" className={styles.select} defaultValue={cmp.b.id}>
                {cmp.choices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {label(v)}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className={styles.tab}>
              比較する
            </button>
          </form>

          {cmp.kind === "no_base" ? (
            <section className={styles.panel} data-empty="no-base">
              <p style={{ margin: 0 }}>{label(cmp.b)} と比べる版（承認済みの版・元の版）がありません。上で比べる元を選んでください。</p>
            </section>
          ) : (
            <>
              <section className={styles.panel} aria-labelledby="cmp-visual-h" data-compare-pair={`${cmp.a.versionNo}-${cmp.b.versionNo}`}>
                <h2 id="cmp-visual-h" className={styles.h2}>
                  見た目：{label(cmp.a)} と {label(cmp.b)}
                </h2>
                {data.previewUnavailable ? (
                  <p className={styles.alert} role="alert">
                    描画画像を表示できません（閲覧の署名鍵か配信元の設定）。
                  </p>
                ) : (
                  <CompareVisual a={{ label: label(cmp.a), ...renders(cmp.a) }} b={{ label: label(cmp.b), ...renders(cmp.b) }} />
                )}
              </section>
              <section className={styles.panel} aria-labelledby="cmp-meta-h">
                <h2 id="cmp-meta-h" className={styles.h2}>
                  中身・事実・検査・権利
                </h2>
                <MetaDiffTable meta={cmp.meta} a={label(cmp.a)} b={label(cmp.b)} />
              </section>
              <section className={styles.panel} aria-labelledby="cmp-structure-h">
                <h2 id="cmp-structure-h" className={styles.h2}>
                  構成（構造記述子）
                </h2>
                <StructureDiffTable entries={cmp.structure} a={label(cmp.a)} b={label(cmp.b)} />
              </section>
              <section className={styles.panel} aria-labelledby="cmp-copy-h">
                <h2 id="cmp-copy-h" className={styles.h2}>
                  頁の文
                </h2>
                <CopyDiffList copy={cmp.copy} />
              </section>
              <section className={styles.panel} aria-labelledby="cmp-files-h">
                <h2 id="cmp-files-h" className={styles.h2}>
                  ファイル
                </h2>
                <FilesDiffTable entries={cmp.files.entries} counts={cmp.files.counts} />
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}
