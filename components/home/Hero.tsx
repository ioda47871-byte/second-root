import Image from "next/image";
import { BlobGreen, BlobSand, LeafSpray, LeafBranch, Dots, IconArrow, IconMail, IconGift } from "./Decor";

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
            パン屋・カフェ・美容室・整体院など、地域のお店の魅力を整理し、初めてのお客様にも伝わるホームページをつくります。情報が見つかりやすく、更新しやすいサイトで、事業の魅力をWebにもう一つの根として育てます。
          </p>

          <div className="hero-ctas">
            <a className="btn btn--green" href="#contact">
              <IconMail />
              無料診断を申し込む
            </a>
            <a className="btn btn--outline" href="#works">
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
          <div className="mock">
            <span className="mock-tag">実際に公開中のサイト</span>

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
                sizes="210px"
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
