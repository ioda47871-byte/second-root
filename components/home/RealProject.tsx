import Image from "next/image";
import { IconCheck, IconLayout, IconRefresh, IconExternal, Dots, LeafBranch } from "./Decor";
import Jp from "./Jp";

const BUILT = ["情報設計", "オリジナルデザイン", "スマートフォン対応", "CMS導入", "公開作業"];
const EDITABLE = ["商品の追加", "商品の編集", "商品の削除", "人気商品の設定", "売り切れ表示", "季節限定表示"];

/**
 * The one real, commissioned project. Presented as a single large work
 * panel — the device composition is the hero of the section and the facts
 * sit beside it as chips, not prose. Deliberately heavier than Concept
 * Work, which is self-initiated.
 *
 * Wording note: we do not claim the site is publicly live, because no
 * public URL is confirmed. "実店舗の制作案件" is what we can state.
 */
export default function RealProject() {
  const live = process.env.NEXT_PUBLIC_BROT_YANAGI_URL;

  return (
    <section className="section" id="works" aria-labelledby="rp-h">
      <div className="container">
        <div className="rp-stage">
          <Dots className="decor rp-dots" cols={5} rows={4} />
          <LeafBranch className="decor rp-leaf" />
          <span className="rp-circle" aria-hidden="true" />

          <div className="rp-stage-in">
            <div className="rp-visual">
              <div className="mock mock--lg">
                <div className="mock-laptop">
                  <div className="mock-laptop-screen">
                    <Image
                      src="/screenshots-source/menu-desktop.jpg"
                      alt="Brot Yanagi の商品ページ(PC表示)のスクリーンショット"
                      width={1119}
                      height={897}
                      sizes="(max-width:960px) 92vw, 52vw"
                    />
                  </div>
                  <div className="mock-laptop-base" />
                </div>
                <div className="mock-phone">
                  <div className="mock-phone-screen">
                    <Image
                      src="/screenshots-source/home-mobile.jpeg"
                      alt="Brot Yanagi のトップページ(スマートフォン表示)のスクリーンショット"
                      width={710}
                      height={1536}
                      sizes="170px"
                    />
                  </div>
                </div>
                <div className="mock-chip mock-chip--l">
                  <Image
                    src="/screenshots-source/interior-photo-crop.jpeg"
                    alt="Brot Yanagi の店内"
                    width={608}
                    height={833}
                    sizes="200px"
                  />
                </div>
              </div>
            </div>

            <div className="rp-info">
              <p className="label-en">Real Project</p>
              <span className="rp-badge">実店舗の制作案件</span>
              <h2 className="rp-title" id="rp-h">
                Brot Yanagi<span>パン屋</span>
              </h2>
              <p className="rp-sub">
                <Jp t="Web制作実績 第1号 — ｜情報設計から｜デザイン・｜CMS導入・公開まで｜担当しました。" />
              </p>
              <p className="rp-value">
                <Jp t="公開後は、" />
                <b>
                  <Jp t="専門知識がなくても｜店舗側で商品情報を｜変更できます。" />
                </b>
                <Jp t="営業時間や商品を｜知りたいお客様に、｜Instagramの｜古い投稿を｜さかのぼって｜探してもらう｜必要が減りました。" />
              </p>

              <div className="rp-panels">
                <div className="rp-panel rp-panel--green">
                  <h3 className="rp-panel-h">
                    <IconLayout style={{ width: 20, height: 20, color: "var(--green)" }} />
                    Second Root が担当したこと
                  </h3>
                  <ul className="rp-chips">
                    {BUILT.map((t) => (
                      <li key={t}>
                        <IconCheck />
                        {t}
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="rp-panel rp-panel--gold">
                  <h3 className="rp-panel-h">
                    <IconRefresh style={{ width: 20, height: 20, color: "var(--gold)" }} />
                    公開後、店舗側でできること
                  </h3>
                  <ul className="rp-chips">
                    {EDITABLE.map((t) => (
                      <li key={t}>
                        <IconCheck />
                        {t}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              <div className="rp-foot">
                {live && (
                  <a
                    className="btn btn--outline btn--sm"
                    href={live}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-ga="external_work_click"
                  >
                    サイトを見る
                    <IconExternal />
                  </a>
                )}
                <p className="rp-note">
                  <Jp t="※ 掲載内容は｜店舗様の許可を｜得ています。" />
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
