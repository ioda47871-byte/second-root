import Image from "next/image";
import { BlobGreen, BlobSand, LeafSpray, LeafBranch, Dots, IconArrow, IconMail, IconGift } from "./Decor";
import Jp from "./Jp";

/**
 * Hero.
 *
 * The visual is built from the real Brot Yanagi site — the desktop
 * screenshot in a laptop shell, the mobile screenshot in a phone shell,
 * and a real photograph of the shop as the small floating card. Nothing
 * here is a mocked-up or generated store screen.
 */
export default function Hero() {
  return (
    <section className="hero" id="home">
      {/* background art */}
      <BlobGreen className="hero-blob-green" />
      <BlobSand className="hero-blob-sand" />
      <span className="hero-circle" aria-hidden="true" />
      <LeafSpray className="decor hero-leaf-a" />
      <LeafBranch className="decor hero-leaf-b" />
      <LeafSpray className="decor hero-leaf-c" />
      <Dots className="decor hero-dots-a" cols={5} rows={4} />
      <Dots className="decor hero-dots-b" cols={4} rows={3} />

      <div className="container hero-in">
        <div className="hero-copy">
          <p className="hero-kicker">
            <span className="dot" />
            地域の&ldquo;想い&rdquo;を、Webでカタチに。
          </p>

          <h1 className="hero-title">
            事業に、
            <br />
            もう一つの根を。
          </h1>

          <p className="hero-lead">
            <Jp t="パン屋・カフェなど｜地域のお店の｜魅力と情報を整理し、｜初めてのお客様にも｜伝わる、｜更新しやすい｜ホームページを｜制作します。" />
          </p>

          <ul className="hero-badges">
            <li>名古屋・金山拠点</li>
            <li>全国オンライン対応</li>
            <li>買い切りが基本</li>
          </ul>

          <div className="hero-ctas">
            <a className="btn btn--green" href="#contact" data-ga="hero_cta_click">
              <IconMail />
              無料診断を申し込む
            </a>
            <a className="btn btn--outline" href="#works" data-ga="hero_works_click">
              制作事例を見る
              <IconArrow />
            </a>
          </div>

          <p className="hero-note">
            <IconGift className="" />
            初回のご相談・お見積りは無料です
          </p>
        </div>

        <div className="hero-visual">
          <div className="mock mock--lg">
            {/* 公開URLを確認できていないため「公開中」とは書かない */}
            <span className="mock-tag">実店舗の制作案件</span>

            <div className="mock-laptop">
              <div className="mock-laptop-screen">
                <Image
                  src="/screenshots-source/menu-desktop.jpg"
                  alt="Brot Yanagi の商品ページ(PC表示)"
                  width={1119}
                  height={897}
                  sizes="(max-width:960px) 92vw, 54vw"
                  priority
                />
              </div>
              <div className="mock-laptop-base" />
            </div>

            <div className="mock-phone">
              <div className="mock-phone-screen">
                <Image
                  src="/screenshots-source/home-mobile.jpeg"
                  alt="Brot Yanagi のトップページ(スマートフォン表示)"
                  width={710}
                  height={1536}
                  sizes="150px"
                />
              </div>
            </div>

            <div className="mock-chip mock-chip--l">
              <Image
                src="/screenshots-source/entrance-photo-crop.jpg"
                alt="Brot Yanagi の店舗入口"
                width={830}
                height={640}
                sizes="220px"
              />
            </div>

            <div className="mock-chip mock-chip--r">
              <Image
                src="/screenshots-source/interior-photo.jpeg"
                alt="Brot Yanagi の店内"
                width={1179}
                height={1614}
                sizes="180px"
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
