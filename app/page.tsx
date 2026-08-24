"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import ContactForm from "@/components/ContactForm";

// Real Brot Yanagi feedback, once it exists — never a placeholder or
// AI-drafted quote. Set to { quote, name, role } to publish it.
const ownerVoice: { quote: string; name: string; role: string } | null = null;

// 自主制作(Concept Work)。実案件ではないので、Selected Work とは別枠で扱う。
// 1件追加するだけで、1件=約半幅 / 2件=2列 / 3件以上=3列 に切り替わる。
// 各サムネイルは業種ごとに作りが違う。thumbBg は枠の余白色で、比率の違いを
// 揃えるときに帯が見えないよう、その画像自身の地色を指定している。
const conceptWorks = [
  {
    slug: "hoshi-no-cha",
    title: "星の茶スタンド",
    titleEn: "HOSHI NO CHA STAND",
    industry: "日本茶スタンド",
    description:
      "夜と日本茶をテーマに、小さなティースタンドを想定して設計した自主制作サイト。",
    image: "/concept-work/hoshi-no-cha.jpg",
    imageWidth: 1560,
    imageHeight: 860,
    thumbBg: "#101113",
    imageAlt:
      "星の茶スタンド(自主制作サイト)のPC表示とスマートフォン表示のスクリーンショット",
    url: "https://hoshi-no-cha-stand.vercel.app",
  },
  {
    slug: "yasashii-beauty-salon",
    title: "やさしい美を彩るサロン",
    titleEn: "YASASHII BEAUTY SALON",
    industry: "美容サロン",
    description:
      "プライベート美容サロンを想定し、施術メニュー・料金・初めての方への案内まで、やわらかく安心感のある世界観で設計した自主制作サイト。淡いピンクとアイボリー、曲線、自然光の写真を中心に構成しています。",
    image: "/concept-work/yasashii-beauty-salon.webp",
    imageWidth: 1600,
    imageHeight: 1000,
    thumbBg: "#faf7f4",
    imageAlt:
      "やさしい美を彩るサロン(自主制作サイト)のPC表示とスマートフォン表示のスクリーンショット",
    url: "https://yasashii-beauty-salon.vercel.app",
  },
  {
    slug: "midori-seitai",
    title: "みどり整体院",
    titleEn: "MIDORI OSTEOPATHY",
    industry: "整体院",
    description:
      "整体院を想定し、施術内容・料金・初めての方への案内など、情報量の多い内容を迷わず確認できるよう設計した自主制作サイト。白・ブルーグレー・グリーンと罫線を基調に、実務的で清潔感のある情報設計にまとめています。",
    image: "/concept-work/midori-seitai.webp",
    imageWidth: 1500,
    imageHeight: 1000,
    thumbBg: "#e4eaec",
    imageAlt:
      "みどり整体院(自主制作サイト)のPC表示とスマートフォン表示のスクリーンショット",
    url: "https://midori-seitai.vercel.app",
  },
];

const NAV_LINKS = [
  { href: "#home", label: "ホーム" },
  { href: "#works", label: "制作例" },
  { href: "#services", label: "サービス" },
  { href: "#pricing", label: "料金" },
  { href: "#process", label: "制作の流れ" },
  { href: "#philosophy", label: "哲学" },
  { href: "#faq", label: "よくある質問" },
];

export default function Home() {
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!("IntersectionObserver" in window)) {
      document.querySelectorAll(".reveal").forEach((el) => el.classList.add("in-view"));
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("in-view");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15, rootMargin: "0px 0px -8% 0px" }
    );
    document.querySelectorAll(".reveal").forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <header className="site-header">
        <div className="site-header-inner">
          <a className="logo" href="#home" onClick={() => setMenuOpen(false)}>
            <span className="logo-name">Second Root</span>
            <span className="logo-sub">WEB DESIGN STUDIO</span>
          </a>
          <nav className="site-nav">
            {NAV_LINKS.slice(1).map((link) => (
              <a key={link.href} href={link.href}>{link.label}</a>
            ))}
          </nav>
          <a className="btn-primary header-cta" href="#contact">無料診断を申し込む</a>
          <button
            type="button"
            className={`nav-toggle${menuOpen ? " is-open" : ""}`}
            aria-label="メニューを開く"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <span /><span /><span />
          </button>
        </div>
        {menuOpen && (
          <div className="mobile-nav">
            {NAV_LINKS.map((link) => (
              <a key={link.href} href={link.href} onClick={() => setMenuOpen(false)}>{link.label}</a>
            ))}
            <a className="btn-primary mobile-nav-cta" href="#contact" onClick={() => setMenuOpen(false)}>
              無料診断を申し込む
            </a>
          </div>
        )}
      </header>

      <main>

        <section id="home" className="section hero-band">
          <div className="hero-copy">
            <p className="hero-kicker eyebrow">地域のお店のホームページ制作</p>
            <h1 className="hero-title">事業に、<br />もう一つの根を。</h1>
            <p className="hero-tags">パン屋 ・ カフェ ・ 美容室 ・ 整体</p>
            <p className="hero-sub">公開した日がゴールではありません。<br />その先まで、一緒に考えていきます。</p>
            <div className="hero-cta">
              <a className="btn-primary" href="#contact">無料診断を申し込む</a>
              <a className="btn-outline" href="#works">制作例を見る</a>
            </div>
          </div>
          <div className="hero-media">
            <Image
              className="hero-photo"
              src="/brand-photos/hero-shop-entrance.webp"
              alt=""
              width={1800}
              height={1200}
              sizes="(max-width: 900px) 100vw, 54vw"
              priority
            />
          </div>
        </section>

        <div className="lead-band">
          <div className="lead-band-inner">
            <p className="lead-target reveal">パン屋・カフェ・美容室・整体など、地域のお店を中心にホームページを制作しています。</p>
            <ul className="lead-strengths reveal">
              <li><span className="lead-no">01</span>今も店に立ちながら、この仕事をしています。</li>
              <li><span className="lead-no">02</span>相談から公開後まで、同じ担当者が対応します。</li>
              <li><span className="lead-no">03</span>ご連絡には、原則24時間以内に返信します。</li>
              <li><span className="lead-no">04</span>料金は、買い切りが基本です。</li>
            </ul>
          </div>
        </div>

        <section id="works" className="section rule-top">
          <div className="section-lede reveal">
            <p className="eyebrow">02 — Works</p>
            <h2 className="section-heading">テンプレートではなく、お店ごとに設計します。</h2>
            <p className="section-sub" style={{ marginBottom: 0 }}>一つひとつのお店に合わせて、目的や雰囲気から一緒に考えます。</p>
          </div>

          <div className="works-band reveal">
            <div className="works-label">
              <p className="works-label-name">制作例</p>
              <p className="works-label-en">Selected Work</p>
            </div>

            <div className="works-content">
              <h3 className="case-name">Brot Yanagi<span className="case-type"> — パン屋</span></h3>

              <div className="works-visual">
                <div className="works-visual-desktop">
                  <Image
                    src="/screenshots-source/menu-desktop.jpg"
                    alt="Brot Yanagi 商品ページ(PC表示)のスクリーンショット"
                    width={1119}
                    height={897}
                    sizes="(max-width: 640px) 320px, 680px"
                  />
                </div>
                <div className="works-visual-mobile">
                  <Image
                    src="/screenshots-source/home-mobile.jpeg"
                    alt="Brot Yanagi トップページ(スマートフォン表示)のスクリーンショット"
                    width={710}
                    height={1536}
                    sizes="(max-width: 640px) 112px, 126px"
                  />
                </div>
              </div>

              <p className="works-desc">Instagram中心の発信だったBrot Yanagiに、必要な情報がすぐ見つかるホームページを制作。商品ページの更新は、オーナー自身の手でできます。</p>

              <div className="works-links">
                <details className="works-detail">
                  <summary>制作例を見る<span className="arrow">→</span></summary>
                  <div className="case-story">
                    <dl>
                      <div className="stage" data-no="01"><dt>Context</dt><dd>パン屋のBrot Yanagi。Instagramを中心に情報発信していたが、ホームページは持っていなかった。</dd></div>
                      <div className="stage" data-no="02"><dt>Problem</dt><dd>SNSでは投稿が流れていくため、店舗情報や商品情報をひとつの場所で確認できるWebサイトがなかった。</dd></div>
                      <div className="stage" data-no="03"><dt>Approach</dt><dd>営業時間・アクセス・商品情報など、初めて訪れた人が必要な情報を迷わず確認できる構成を設計。あわせて、商品情報を店舗側で更新できる仕組みを用意した。</dd></div>
                      <div className="stage" data-no="04"><dt>Build</dt><dd>商品情報を店舗側で更新できるCMSを導入し、Instagramの投稿をサイト上でも確認できる仕組みを実装。スマートフォン表示にも対応した。</dd></div>
                      <div className="stage" data-no="05"><dt>What You Can Do</dt><dd>商品ページの更新は、オーナー自身の手でできる。Instagramの最新投稿も、サイト上に自動で反映される。</dd></div>
                    </dl>

                    {ownerVoice && (
                      <div className="owner-voice">
                        <div className="case-story-kicker">Owner&apos;s Voice — 店主の声</div>
                        <p className="owner-voice-quote">{ownerVoice.quote}</p>
                        <p className="owner-voice-attr">{ownerVoice.name} — {ownerVoice.role}</p>
                      </div>
                    )}
                  </div>
                  <p className="case-credit">EDIT — Second Root</p>

                </details>

                {process.env.NEXT_PUBLIC_BROT_YANAGI_URL && (
                  <a
                    className="link-quiet"
                    href={process.env.NEXT_PUBLIC_BROT_YANAGI_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    実際のサイトを見る<span className="arrow">↗</span>
                  </a>
                )}
              </div>

              <div className="cta-band">
                <p>実際のサイトを見た上で、あなたのお店ならどうなるか——まずは無料診断でご相談ください。</p>
                <a className="btn-primary" href="#contact">無料診断を申し込む<span className="arrow">→</span></a>
              </div>
            </div>
          </div>

          {/* 自主制作。実案件のSelected Workとは別枠であることが分かるように置く。 */}
          <div className="works-band concept-band reveal">
            <div className="works-label">
              <p className="works-label-name">自主制作</p>
              <p className="works-label-en">Concept Work</p>
            </div>

            <div className="works-content">
              <p className="concept-lede">
                実際の業種を想定し、デザイン・情報設計を行った自主制作サイトです。実在する店舗ではありません。
              </p>

              <ul className="concept-grid" data-count={Math.min(conceptWorks.length, 3)}>
                {conceptWorks.map((work) => (
                  <li className="concept-item" key={work.slug}>
                    <a
                      className="concept-thumb"
                      href={work.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      tabIndex={-1}
                      aria-hidden="true"
                      style={{ background: work.thumbBg }}
                    >
                      <Image
                        src={work.image}
                        alt={work.imageAlt}
                        width={work.imageWidth}
                        height={work.imageHeight}
                        sizes="(max-width: 767px) 92vw, (max-width: 1023px) 44vw, 31vw"
                      />
                    </a>

                    <p className="concept-kicker">
                      Concept Work<span className="concept-sep">—</span>{work.industry}
                    </p>

                    <h3 className="concept-name">
                      {work.title}
                      <span className="concept-name-en">{work.titleEn}</span>
                    </h3>

                    <p className="concept-desc">{work.description}</p>

                    <a
                      className="link-quiet"
                      href={work.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      サイトを見る<span className="arrow">↗</span>
                    </a>
                  </li>
                ))}
              </ul>

            </div>
          </div>
        </section>

        <section className="section rule-top">
          <div className="trio reveal">
            <div className="trio-col trio-col--services" id="services">
              <p className="trio-no">03</p>
              <h3 className="trio-heading">サービス</h3>
              <span className="trio-label">Service</span>

              <div className="service-list">
                <div className="service-item">
                  <h4 className="pillar-name">サイト制作</h4>
                  <p className="pillar-desc">お店や商品の魅力を、初めて訪れた人にも分かりやすく届けます。</p>
                  <ul className="pillar-items"><li>スマートフォン対応</li><li>基本的なSEO設計</li></ul>
                </div>
                <div className="service-item">
                  <h4 className="pillar-name">更新の仕組みづくり</h4>
                  <p className="pillar-desc">営業時間や商品情報を、専門知識がなくても自分で更新できる仕組みにします。</p>
                  <ul className="pillar-items"><li>CMS導入</li><li>Instagramなど外部連携</li></ul>
                </div>
                <div className="service-item">
                  <h4 className="pillar-name">公開後の伴走</h4>
                  <p className="pillar-desc">公開後も、修正や更新、ちょっとした相談まで継続して対応します。</p>
                  <ul className="pillar-items"><li>修正・更新対応</li><li>公開後のご相談</li></ul>
                </div>
              </div>
              <p className="services-closing">デザインの前に、お店の魅力をどう伝えるかを、一緒に考えます。</p>
            </div>

            <div className="trio-col trio-col--founder" id="founder">
              <p className="trio-no">04</p>
              <h3 className="trio-heading">担当者について</h3>
              <span className="trio-label">Founder</span>

              <p className="founder-teaser">
                パン屋の現場に立ちながら、この仕事をしているのには理由があります。<br />
                できないことを、できるとは言いません。
              </p>

              <details className="founder-more">
                <summary>インタビューを読む<span className="arrow">→</span></summary>
                <div className="interview">
                  <div className="interview-kicker">インタビュー</div>
                  <h4 className="interview-title">「同じ疲れを、知っているから。」</h4>
                  <div className="interview-qa">
                    <div className="qa-item">
                      <p className="qa-q">Q. なぜ、パン屋の現場に立ちながら、この仕事を?</p>
                      <p className="qa-a">パン屋の現場に立ちながら、この仕事をしているのには理由があります。閉店後にホームページのことを考える余力がどれだけ残っていないか、身体で分かるんです。だから、その感覚を知っている人間として、この仕事をしています。</p>
                    </div>
                    <div className="qa-item">
                      <p className="qa-q">Q. 一人で対応することに、不安はありませんか?</p>
                      <p className="qa-a">窓口が変わるたびに、伝えたことが振り出しに戻る。それが一番もったいないと思っています。最初から最後まで、同じ人間が向き合う方が、結局早いんです。公開して終わりにもせず、お店の変化に合わせて長く伴走します。</p>
                    </div>
                    <div className="qa-item">
                      <p className="qa-q">Q. 連絡が取りづらくなったりは?</p>
                      <p className="qa-a">ご連絡には、原則24時間以内に返信します。忙しさを理由に、連絡を曖昧にはしません。</p>
                    </div>
                  </div>
                  <div className="signature">Second Root</div>
                </div>
              </details>

              <ul className="promise-list">
                <li className="promise-item"><span className="tick" />できないことを、できるとは言いません。</li>
                <li className="promise-item"><span className="tick" />不要な機能や、余分な費用は提案しません。</li>
              </ul>
            </div>

            <div className="trio-col trio-col--price" id="pricing">
              <p className="trio-no">05</p>
              <h3 className="trio-heading">料金について</h3>
              <span className="trio-label">Price</span>

              <div className="pricing-teaser">
                <div className="price-row-mini">
                  <span className="price-row-mini-name">シンプルホームページ</span>
                  <span className="price-row-mini-price">¥98,000〜</span>
                </div>
                <div className="price-row-mini">
                  <span className="price-row-mini-name">更新できるホームページ</span>
                  <span className="price-row-mini-price">¥198,000〜</span>
                </div>
                <div className="price-row-mini">
                  <span className="price-row-mini-name">オーダーメイド</span>
                  <span className="price-row-mini-price">お見積もり</span>
                </div>
              </div>
              <p className="pricing-note">掲載協力いただける店舗様は、実績制作価格¥50,000(税別)もご相談いただけます。</p>

              <details className="detail-section">
                <summary>
                  <span className="detail-section-title">料金の詳細を見る</span>
                  <span className="arrow">→</span>
                </summary>
                <div className="detail-section-body">

                  <div className="price-plan-list">
                    <div className="price-plan">
                      <div>
                        <p className="price-plan-price">¥98,000<span className="unit">〜(税別)</span></p>
                        <p className="price-plan-name">シンプルホームページ</p>
                      </div>
                      <div>
                        <p className="price-plan-for">店舗紹介・会社紹介など、まずホームページを持ちたい方向け。</p>
                        <p className="price-plan-desc">オリジナルデザインで制作し、スマートフォン対応・お問い合わせフォームなど、必要な機能を備えたホームページを制作します。</p>
                      </div>
                    </div>
                    <div className="price-plan price-plan--featured">
                      <div>
                        <p className="price-plan-price">¥198,000<span className="unit">〜(税別)</span></p>
                        <p className="price-plan-name">更新できるホームページ</p>
                      </div>
                      <div>
                        <p className="price-plan-for">商品・営業時間・お知らせなどをご自身で更新したい方向け。</p>
                        <p className="price-plan-desc">営業時間や商品情報を更新できるCMSを導入し、Instagramなど必要な外部サービスとの連携にも対応します。</p>
                      </div>
                    </div>
                    <div className="price-plan">
                      <div>
                        <p className="price-plan-price price-plan-price--quote">お見積もり</p>
                        <p className="price-plan-name">オーダーメイド</p>
                      </div>
                      <div>
                        <p className="price-plan-for">予約・会員機能など、独自の仕組みが必要な方向け。</p>
                        <p className="price-plan-desc">予約機能や会員機能など、お店に必要な機能を一緒に整理し、最適な形でご提案します。</p>
                      </div>
                    </div>
                  </div>

                  <dl className="info-list">
                    <div className="info-row"><dt>お支払い</dt><dd>買い切りを基本としています。分割をご希望の場合も、お気軽にご相談ください。</dd></div>
                    <div className="info-row">
                      <dt>公開後のサポート</dt>
                      <dd>公開後も必要に応じて対応しています。都度対応(内容に応じてお見積もり)、または保守プラン(月額¥3,000〜)からお選びいただけます。</dd>
                    </div>
                    <div className="info-row">
                      <dt>保守プラン内容</dt>
                      <dd>
                        <ul className="info-sublist">
                          <li>サーバー・ドメインの状態確認</li>
                          <li>SSL証明書の確認</li>
                          <li>定期バックアップ</li>
                          <li>軽微な文章・画像修正</li>
                          <li>ご相談対応</li>
                        </ul>
                      </dd>
                    </div>
                    <div className="info-row"><dt>ドメイン・サーバー</dt><dd>取得・設定はこちらで代行します。年間の実費(数千円〜1万円程度)のみ、お客様にご負担いただきます。</dd></div>
                  </dl>

                  <div className="cta-band">
                    <p>料金だけでは分からないことも、無料診断でお答えします。</p>
                    <a className="btn-primary" href="#contact">無料診断を申し込む<span className="arrow">→</span></a>
                  </div>
                  <p className="section-sub" style={{ marginTop: 28, marginBottom: 0 }}>まずはお気軽にご相談ください。ご予算やご希望に合わせたご提案も可能です。</p>

                  <div className="portfolio-note">
                    <p className="portfolio-note-label">実績制作について</p>
                    <p className="portfolio-note-desc">現在、Second Rootでは制作実績として掲載にご協力いただける店舗様を限定で募集しています。<br />通常料金とは別に、「実績制作価格:50,000円(税別)」での制作もご相談いただけます。</p>
                    <p className="portfolio-note-note">※掲載内容や制作条件については、事前にご相談のうえ決定いたします。</p>
                  </div>

                </div>
              </details>
            </div>
          </div>
        </section>

        <section id="process" className="section section--tight rule-top">
          <div className="section-lede reveal">
            <p className="eyebrow">06 — Process</p>
            <h2 className="section-heading">制作の流れ</h2>
            <p className="section-sub" style={{ marginBottom: 0 }}>相談から公開まで、6つのステップで進みます。</p>
          </div>

          <div className="process-row reveal">
            <div className="process-step"><span className="step-no">01</span><h3 className="step-name">相談</h3><p className="step-desc">まずは、今困っていることをお聞きします。</p></div>
            <div className="process-step"><span className="step-no">02</span><h3 className="step-name">ヒアリング</h3><p className="step-desc">お店の状況、お客様層、伝えたいことを整理します。</p></div>
            <div className="process-step"><span className="step-no">03</span><h3 className="step-name">提案</h3><p className="step-desc">必要な機能と構成を、分かりやすくご提案します。</p></div>
            <div className="process-step"><span className="step-no">04</span><h3 className="step-name">制作</h3><p className="step-desc">デザインとコーディングを進め、途中経過もご確認いただきます。</p></div>
            <div className="process-step"><span className="step-no">05</span><h3 className="step-name">確認</h3><p className="step-desc">公開前に、内容と動作を一緒に確認します。</p></div>
            <div className="process-step"><span className="step-no">06</span><h3 className="step-name">公開</h3><p className="step-desc">ドメイン・サーバーの設定を行い、公開します。</p></div>
          </div>
        </section>

        <section className="section rule-top">
          <div className="split">
            <div className="split-faq reveal" id="faq">
              <p className="eyebrow" style={{ marginBottom: 10 }}>07 — FAQ</p>
              <h2 className="section-heading" style={{ marginTop: 0 }}>よくある質問</h2>
              <div className="faq-list">
                <details className="faq-item">
                  <summary>相談したら、契約しないといけませんか?<span className="mark" /></summary>
                  <p>いいえ。ご相談・無料診断だけのご利用も歓迎しています。無理な営業はいたしませんので、お気軽にお問い合わせください。</p>
                </details>
                <details className="faq-item">
                  <summary>買い切りの場合、公開後に毎月かかる費用はありますか?<span className="mark" /></summary>
                  <p>必ずかかるのは、ドメインとサーバーの実費(年間数千円〜1万円程度)のみです。制作費用として毎月お支払いいただくものはありません。修正・更新を都度ではなくお任せしたい場合のみ、月額¥3,000〜の保守プランをご案内しています。</p>
                </details>
                <details className="faq-item">
                  <summary>制作期間はどれくらいですか?<span className="mark" /></summary>
                  <p>内容にもよりますが、目安は1〜2ヶ月程度です。ヒアリングの進み具合によって前後します。</p>
                </details>
                <details className="faq-item">
                  <summary>公開後に自分で更新できますか?<span className="mark" /></summary>
                  <p>はい。CMSを導入することで、文章や商品情報、営業時間などをご自身で更新できるようにします。</p>
                </details>
                <details className="faq-item">
                  <summary>対応エリアはどこまでですか?<span className="mark" /></summary>
                  <p>全国からご相談いただけます。基本的なやり取りはメールやLINEなどオンラインで進め、必要に応じてお電話やオンラインでお話しします。</p>
                </details>
              </div>
              <details className="faq-more">
                <summary>すべての質問を見る<span className="arrow">→</span></summary>
                <div className="faq-list">
                  <details className="faq-item">
                    <summary>修正は何回までですか?<span className="mark" /></summary>
                    <p>公開前に必要な確認・調整を行います。大幅な構成変更や、当初の制作範囲を超える追加については、事前にご相談します。公開後の修正は都度のご依頼、または月額保守プランでの対応となります。</p>
                  </details>
                  <details className="faq-item">
                    <summary>スマートフォンでの見え方も対応していますか?<span className="mark" /></summary>
                    <p>はい。すべてのページでスマートフォン表示を前提に設計しています。</p>
                  </details>
                  <details className="faq-item">
                    <summary>パソコンやITに詳しくなくても大丈夫ですか?<span className="mark" /></summary>
                    <p>専門用語をできるだけ使わずに進めます。分からないことは、その都度確認しながら進めます。</p>
                  </details>
                  <details className="faq-item">
                    <summary>なぜこの価格で対応できるのですか?<span className="mark" /></summary>
                    <p>効率化できる部分にはツールを活用し、お待たせする時間を減らしています。ただし、設計やデザイン、お店ごとのご提案は、必ず人が責任を持って行っています。</p>
                  </details>
                </div>
              </details>
            </div>

            <div className="split-philosophy reveal" id="philosophy">
              <p className="eyebrow" style={{ marginBottom: 10 }}>08 — Philosophy</p>
              <div className="philosophy-body">
                <div>
                  <h2 className="philosophy-heading">私たちの哲学</h2>
                  <p className="philosophy-text">看板も、常連さんとの間柄も、積み重ねてきた時間も、もうそこにある。私たちが作るのは、真新しい何かではありません。すでにあるものが、これからも続いていくための、もう一つの根です。</p>
                </div>
                <div className="philosophy-photo">
                  <Image
                    src="/brand-photos/philosophy-still-life.webp"
                    alt=""
                    width={1800}
                    height={1200}
                    sizes="(max-width: 640px) 100vw, 640px"
                  />
                </div>
              </div>
            </div>
          </div>
        </section>

        <section id="contact" className="section rule-top">
          <div className="contact-band reveal">
            <div className="contact-band-copy">
              <p className="eyebrow contact-band-eyebrow">09 — Contact</p>
              <h2 className="contact-band-heading">事業に、もう一つの根を。</h2>
              <p className="contact-band-desc">まずは、お店のお話を聞かせてください。</p>
            </div>
            <div className="contact-band-cta">
              <a className="btn-primary" href="#contact-form">無料診断を申し込む<span className="arrow">→</span></a>
            </div>
          </div>

          <div className="diagnosis-box reveal">
            <p>ホームページ・Google・Instagramなど、現在の発信状況を確認し、改善できそうなポイントを簡単にお伝えします。</p>
          </div>

          <div className="contact-channels reveal" id="contact-form">
            <ContactForm />
          </div>

          {process.env.NEXT_PUBLIC_LINE_URL && (
            <div className="line-note reveal">
              <p className="line-note-title">LINEでもご相談いただけます。</p>
              <p className="line-note-body">
                フォームへの入力が面倒な方や、まずは簡単に相談してみたい方は、LINEからでもご連絡いただけます。<br />
                友だち追加後、「無料診断希望」と送っていただければ大丈夫です。
              </p>
              <a className="link-quiet" href={process.env.NEXT_PUBLIC_LINE_URL} target="_blank" rel="noopener noreferrer">
                LINEで相談する<span className="arrow">→</span>
              </a>
            </div>
          )}
        </section>

      </main>

      <footer className="site-footer">
        <div className="site-footer-inner">
          <div className="site-footer-brand">
            <span className="logo-name">Second Root</span>
            <span className="logo-sub">WEB DESIGN STUDIO</span>
          </div>
          <nav className="site-footer-nav">
            {NAV_LINKS.map((link) => (
              <a key={link.href} href={link.href}>{link.label}</a>
            ))}
            {/* legal links close the same row in the same quiet style —
                present, but not competing with the section links */}
            <a href="/privacy">プライバシーポリシー</a>
            <a href="/terms">利用規約</a>
          </nav>
          <span className="site-footer-copy">© 2026 Second Root</span>
        </div>
      </footer>
    </>
  );
}
