import Image from "next/image";
import { IconCheck, IconLayout, IconRefresh, IconExternal, Dots } from "./Decor";

const BUILT = ["情報設計", "オリジナルデザイン", "スマートフォン対応", "CMS導入", "公開作業"];
const EDITABLE = ["商品の追加", "商品の編集", "商品の削除", "人気商品の設定", "売り切れ表示", "季節限定表示"];

/**
 * The one real, commissioned project. Deliberately given more visual
 * weight than Concept Work: its own badge, a full-width device
 * composition, and two panels of concrete facts instead of prose.
 */
export default function RealProject() {
  const live = process.env.NEXT_PUBLIC_BROT_YANAGI_URL;

  return (
    <section className="section" id="works" aria-labelledby="rp-h">
      <div className="container">
        <div className="sec-head">
          <p className="label-en">Real Project</p>
          <span className="rp-badge">実際の店舗で使われているホームページ</span>
          <h2 className="rp-title" id="rp-h">
            Brot Yanagi<span>パン屋</span>
          </h2>
          <p className="rp-sub">
            Web制作実績 第1号 — 情報設計からデザイン・CMS導入・公開まで担当しました。
          </p>
          <p className="rp-value">
            公開後は、<b>専門知識がなくても店舗側で商品情報を変更できます。</b>
            営業時間や商品を知りたいお客様に、Instagramの古い投稿をさかのぼって探してもらう必要が減りました。
          </p>
        </div>

        <div className="rp-visual">
          <Dots className="decor" style={{ left: -22, top: -18, color: "var(--gold)", opacity: 0.6 }} cols={5} rows={3} />
          <div className="mock">
            <div className="mock-laptop">
              <div className="mock-laptop-screen">
                <Image
                  src="/screenshots-source/menu-desktop.jpg"
                  alt="Brot Yanagi の商品ページ(PC表示)のスクリーンショット"
                  width={1119}
                  height={897}
                  sizes="(max-width:900px) 92vw, 76vw"
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
                  sizes="150px"
                />
              </div>
            </div>
            <div className="mock-chip mock-chip--l">
              <Image
                src="/screenshots-source/interior-photo-crop.jpeg"
                alt="Brot Yanagi の店内"
                width={608}
                height={833}
                sizes="210px"
              />
            </div>
          </div>
        </div>

        <div className="rp-panels">
          <div className="rp-panel rp-panel--green">
            <h3 className="rp-panel-h">
              <IconLayout style={{ width: 22, height: 22, color: "var(--green)" }} />
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
              <IconRefresh style={{ width: 22, height: 22, color: "var(--gold)" }} />
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

        {live && (
          <p style={{ marginTop: 26 }}>
            <a
              className="btn btn--outline btn--sm"
              href={live}
              target="_blank"
              rel="noopener noreferrer"
              data-ga="external_work_click"
            >
              実際のサイトを見る
              <IconExternal />
            </a>
          </p>
        )}
        <p className="rp-note">※ 掲載内容は店舗様の許可を得ています。</p>
      </div>
    </section>
  );
}
