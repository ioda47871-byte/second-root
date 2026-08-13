"use client";

import { useEffect } from "react";
import ContactForm from "@/components/ContactForm";
import MacBookFrame from "@/components/MacBookFrame";
import BrowserFrame from "@/components/BrowserFrame";
import PhoneFrame from "@/components/PhoneFrame";

export default function Home() {
  useEffect(() => {
    function bindSpine(
      wrapEl: HTMLElement,
      fillEl: HTMLElement,
      nodeEls: HTMLElement[],
      resolveTarget: (node: HTMLElement) => HTMLElement | null
    ) {
      function layout() {
        const wrapRect = wrapEl.getBoundingClientRect();
        nodeEls.forEach((node) => {
          const target = resolveTarget(node);
          if (!target) return;
          const r = target.getBoundingClientRect();
          const top = r.top - wrapRect.top + r.height / 2;
          node.style.top = `${top}px`;
        });
      }

      let ticking = false;
      function update() {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(() => {
          const rect = wrapEl.getBoundingClientRect();
          const triggerY = window.innerHeight * 0.85;
          let progress = rect.height > 0 ? (triggerY - rect.top) / rect.height : 0;
          progress = Math.min(Math.max(progress, 0), 1);
          const atDocBottom =
            window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
          if (atDocBottom) progress = 1;
          fillEl.style.height = `${progress * 100}%`;
          ticking = false;
        });
      }

      window.addEventListener("scroll", update, { passive: true });
      window.addEventListener("resize", () => {
        layout();
        update();
      });
      layout();
      update();

      return () => {
        window.removeEventListener("scroll", update);
      };
    }

    function bindActive(nodeEls: HTMLElement[], ids: string[], rootMargin: string) {
      if (!("IntersectionObserver" in window)) return () => {};
      const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          const id = entry.target.id;
          const node = nodeEls.find((n) => n.getAttribute("data-target") === id);
          if (node) node.classList.toggle("is-active", entry.isIntersecting);
        });
      }, { rootMargin });
      ids.forEach((id) => {
        const el = document.getElementById(id);
        if (el) observer.observe(el);
      });
      return () => observer.disconnect();
    }

    const cleanups: Array<() => void> = [];

    const pageWrap = document.getElementById("spineWrap");
    const pageFill = document.getElementById("spineFill");
    const pageNodes = Array.from(document.querySelectorAll<HTMLElement>(".spine-rail .node"));
    if (pageWrap && pageFill) {
      cleanups.push(
        bindSpine(pageWrap, pageFill, pageNodes, (node) =>
          document.getElementById(node.getAttribute("data-target") || "")
        ) || (() => {})
      );
    }
    cleanups.push(
      bindActive(
        pageNodes,
        ["home", "philosophy", "services", "works", "process", "pricing", "founder", "faq", "contact"],
        "-45% 0px -45% 0px"
      )
    );

    const worksWrap = document.getElementById("worksMiniWrap");
    const worksFill = document.getElementById("worksMiniFill");
    if (worksWrap && worksFill) {
      const worksNodes = Array.from(worksWrap.querySelectorAll<HTMLElement>(".mini-node"));
      cleanups.push(
        bindSpine(worksWrap, worksFill, worksNodes, (node) =>
          document.getElementById(node.getAttribute("data-target") || "")
        ) || (() => {})
      );
      cleanups.push(bindActive(worksNodes, ["case-brot", "case-progress"], "-40% 0px -40% 0px"));
    }

    const processWrap = document.getElementById("processMiniWrap");
    const processFill = document.getElementById("processMiniFill");
    if (processWrap && processFill) {
      const processNodes = Array.from(processWrap.querySelectorAll<HTMLElement>(".mini-node"));
      cleanups.push(
        bindSpine(processWrap, processFill, processNodes, (node) =>
          document.getElementById(node.getAttribute("data-target") || "")
        ) || (() => {})
      );
      cleanups.push(
        bindActive(
          processNodes,
          ["step-1", "step-2", "step-3", "step-4", "step-5", "step-6"],
          "-40% 0px -40% 0px"
        )
      );
    }

    let revealCleanup = () => {};
    if ("IntersectionObserver" in window) {
      const revealObserver = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              entry.target.classList.add("in-view");
              revealObserver.unobserve(entry.target);
            }
          });
        },
        { threshold: 0.2, rootMargin: "0px 0px -10% 0px" }
      );
      document.querySelectorAll(".reveal").forEach((el) => revealObserver.observe(el));
      revealCleanup = () => revealObserver.disconnect();
    } else {
      document.querySelectorAll(".reveal").forEach((el) => el.classList.add("in-view"));
    }
    cleanups.push(revealCleanup);

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reducedMotion) {
      const parallaxEls = Array.from(document.querySelectorAll<HTMLElement>(".parallax"));
      if (parallaxEls.length > 0) {
        let ticking = false;
        const updateParallax = () => {
          if (ticking) return;
          ticking = true;
          requestAnimationFrame(() => {
            const viewportCenter = window.innerHeight / 2;
            parallaxEls.forEach((el) => {
              const factor = parseFloat(el.dataset.parallax || "0.06");
              const rect = el.getBoundingClientRect();
              const elCenter = rect.top + rect.height / 2;
              const offset = Math.max(-32, Math.min(32, (viewportCenter - elCenter) * factor));
              el.style.transform = `translateY(${offset}px)`;
            });
            ticking = false;
          });
        };
        window.addEventListener("scroll", updateParallax, { passive: true });
        window.addEventListener("resize", updateParallax);
        updateParallax();
        cleanups.push(() => window.removeEventListener("scroll", updateParallax));
      }
    }

    return () => cleanups.forEach((fn) => fn && fn());
  }, []);

  return (
    <>
      <header className="topbar">
        <a className="wordmark" href="#home">Second Root</a>
        <a className="topbar-cta" href="#contact">無料で相談する</a>
      </header>

      <div className="spine-wrap" id="spineWrap">
        <div className="spine-rail">
          <div className="spine-track" />
          <div className="spine-fill" id="spineFill" />
          <div className="node" data-target="home"><span className="node-dot" /><span className="node-label">Home</span></div>
          <div className="node" data-target="philosophy"><span className="node-dot" /><span className="node-label">Philosophy</span></div>
          <div className="node" data-target="services"><span className="node-dot" /><span className="node-label">Services</span></div>
          <div className="node" data-target="works"><span className="node-dot" /><span className="node-label">Works</span></div>
          <div className="node" data-target="process"><span className="node-dot" /><span className="node-label">Process</span></div>
          <div className="node" data-target="pricing"><span className="node-dot" /><span className="node-label">Pricing</span></div>
          <div className="node" data-target="founder"><span className="node-dot" /><span className="node-label">Founder</span></div>
          <div className="node" data-target="faq"><span className="node-dot" /><span className="node-label">FAQ</span></div>
          <div className="node" data-target="contact"><span className="node-dot" /><span className="node-label">Contact</span></div>
        </div>

        <main className="content">

          <section id="home" className="section hero">
            <div className="hero-glow" aria-hidden="true" />
            <div className="hero-grid">
              <div className="hero-copy">
                <div className="hero-eyebrow eyebrow">Second Root</div>
                <h1 className="hero-title">事業に、<br />もう一つの根を。</h1>
                <p className="hero-service"><span className="tick" />地域のお店のホームページ制作</p>
                <p className="hero-sub">ホームページは、公開した日がゴールではありません。<br />公開後の更新や見直しまで、一緒に考えていきます。</p>
                <div className="hero-cta">
                  <a className="btn-primary" href="#contact">無料診断を申し込む<span className="arrow">→</span></a>
                </div>
              </div>
              <div className="hero-visual">
                <div className="parallax" data-parallax="0.08">
                  <div className="hero-float">
                    <MacBookFrame
                      src="/screenshots-source/home-desktop.png"
                      alt="Brot Yanagi トップページ(PC版)"
                      aspectRatio={1903 / 828}
                    />
                  </div>
                </div>
              </div>
            </div>
            <div className="scroll-cue"><div className="line" /><span>Scroll</span></div>
          </section>

          <div className="lead-band">
            <p className="lead-target reveal">パン屋・カフェ・美容室・整体など、地域のお店を中心にホームページを制作しています。</p>
            <ul className="lead-strengths reveal">
              <li><span className="tick" />一人で、相談から公開後まで対応します。</li>
              <li><span className="tick" />パン屋の現場で働きながら、地域のお店のホームページをつくっています。</li>
              <li><span className="tick" />ご連絡には、原則24時間以内に返信します。</li>
              <li><span className="tick" />料金は、買い切りが基本です。</li>
            </ul>
          </div>

          <section id="philosophy" className="section">
            <div className="eyebrow reveal">Philosophy</div>
            <h2 className="section-heading reveal">更新しやすく、相談しやすく。</h2>
            <div className="philosophy-body">
              <p className="reveal">メニューが変わる。営業時間が変わる。新しい取り組みが始まる。</p>
              <p className="reveal">そのたびに、ご自身で更新できて、気軽に相談できることを大事にしています。</p>
              <p className="reveal">完成より、成長を大事にしています。</p>
            </div>
            <div className="philosophy-story">
              <p className="reveal">Second Rootという名前には、意味があります。</p>
              <p className="reveal">すでにお店には、大切にしてきたものがあります。看板、常連さん、味、接客。</p>
              <p className="reveal">ホームページは、それに取って代わるものではなく、すでにあるものを、もう一つの形で支えるためのものだと考えています。</p>
            </div>
          </section>

          <section id="services" className="section">
            <div className="eyebrow reveal">Services</div>
            <h2 className="section-heading reveal">できることを、3つに整理しました。</h2>
            <p className="section-sub reveal">サービス一覧というより、実際に対応できる範囲を、正直にお伝えします。</p>
            <div className="service-grid reveal">
              <div className="service-card">
                <h3 className="pillar-name">サイト制作</h3>
                <p className="pillar-desc">お店の紹介や商品情報を、分かりやすく伝えるホームページをつくります。</p>
                <ul className="pillar-items"><li>スマートフォン対応</li><li>基本的なSEO設計</li></ul>
              </div>
              <div className="service-card">
                <h3 className="pillar-name">更新の仕組みづくり</h3>
                <p className="pillar-desc">営業時間や商品情報を、ご自身で更新できる仕組みを整えます。</p>
                <ul className="pillar-items"><li>CMS導入</li><li>Instagramなど外部連携</li></ul>
              </div>
              <div className="service-card">
                <h3 className="pillar-name">公開後の伴走</h3>
                <p className="pillar-desc">公開して終わりにせず、その後の相談や調整に対応します。</p>
                <ul className="pillar-items"><li>無料診断</li><li>修正・更新対応</li></ul>
              </div>
            </div>

            <div className="eyebrow reveal reasons-label">Second Rootに任せる理由</div>
            <ul className="reasons-list reveal">
              <li><span className="tick" />公開して終わりにせず、その後の改善提案まで行います。</li>
              <li><span className="tick" />デザインの前に、お店の魅力をどう伝えるかを一緒に考えます。</li>
              <li><span className="tick" />パン屋の現場に立っているからこそ、日々の忙しさの中でも続けられる仕組みを考えます。</li>
            </ul>
          </section>

          <section id="works" className="section section--roomy">
            <div className="eyebrow reveal">Works</div>
            <h2 className="section-heading reveal">テンプレートではなく、お店ごとに設計します。</h2>
            <p className="section-sub reveal">相談から公開後まで、一人で責任を持って対応します。<br />この線は、事例が増えるたびに長くなっていきます。</p>

            <div className="mini-wrap reveal" id="worksMiniWrap">
              <div className="mini-spine">
                <div className="mini-spine-track" />
                <div className="mini-spine-fill" id="worksMiniFill" />
                <div className="mini-node" data-target="case-brot" />
                <div className="mini-node is-muted" data-target="case-progress" />
              </div>

              <div className="mini-list">
                <div id="case-brot">
                  <div className="eyebrow" style={{ marginBottom: 8 }}>パン屋</div>
                  <h3 className="case-name">Brot Yanagi</h3>
                  <div className="case-real">
                    <div className="case-visual">
                      <div className="works-devices reveal-group">
                        <div className="reveal reveal-media">
                          <BrowserFrame
                            src="/screenshots-source/menu-desktop.png"
                            alt="Brot Yanagi メニューページ(PC版)"
                            aspectRatio={1119 / 843}
                          />
                        </div>
                        <div className="reveal reveal-media">
                          <PhoneFrame
                            className="is-back"
                            src="/screenshots-source/access-mobile-portrait.jpeg"
                            alt="Brot Yanagi アクセスページ(スマホ版)"
                            aspectRatio={710 / 1413}
                          />
                        </div>
                        <div className="reveal reveal-media">
                          <PhoneFrame
                            className="is-front"
                            src="/screenshots-source/home-mobile.jpeg"
                            alt="Brot Yanagi トップページ(スマホ版)"
                            aspectRatio={710 / 1413}
                          />
                        </div>
                      </div>
                      <p className="case-photo-caption">実際に公開しているBrot Yanagiの画面(PC・スマホ)</p>
                    </div>
                    <div className="case-story">
                      <p className="case-result">Instagramだけの運営から、<br />更新も集客も自分たちで回せるサイトへ。</p>
                      <dl>
                        <div className="stage"><span className="stage-no">01</span><dt>課題</dt><dd>SNS(Instagram)だけで運営しており、お店の存在を伝える場所がなかった。</dd></div>
                        <div className="stage"><span className="stage-no">02</span><dt>提案</dt><dd>売り込まない、シンプルなホームページの制作を提案。</dd></div>
                        <div className="stage"><span className="stage-no">03</span><dt>制作</dt><dd>オーナー自身で商品情報を更新できるよう、CMSを導入。</dd></div>
                        <div className="stage"><span className="stage-no">04</span><dt>公開後</dt><dd>商品ページの更新が自分たちだけでできるようになり、Instagramの最新投稿も自動で反映されるように。</dd></div>
                      </dl>
                    </div>
                  </div>

                  <div className="eyebrow" style={{ marginTop: 40 }}>Gallery</div>
                  <h4 className="case-name" style={{ marginTop: 10, marginBottom: 8 }}>店舗の雰囲気</h4>
                  <p className="case-photo-caption" style={{ marginBottom: 4 }}>パンの香りに包まれる、あたたかい空間です。</p>
                  <div className="gallery-photos reveal-group">
                    <figure className="gallery-photo reveal reveal-media">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src="/screenshots-source/exterior-photo.png" alt="Brot Yanagi 外観" style={{ objectPosition: "center 30%" }} />
                      <figcaption>外観</figcaption>
                    </figure>
                    <figure className="gallery-photo reveal reveal-media">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src="/screenshots-source/entrance-photo.png" alt="Brot Yanagi エントランス" style={{ aspectRatio: 1025 / 827 }} />
                      <figcaption>エントランス</figcaption>
                    </figure>
                    <figure className="gallery-photo reveal reveal-media">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src="/screenshots-source/interior-photo.jpeg"
                        alt="Brot Yanagi 内観"
                        style={{ aspectRatio: 0.84, objectPosition: "center 34%" }}
                      />
                      <figcaption>内観</figcaption>
                    </figure>
                  </div>
                </div>

                <div className="case-soon" id="case-progress">
                  <div className="case-name">制作中の事例</div>
                  <p>現在、新しい実績を制作しています。完成次第、ここに公開します。</p>
                </div>
              </div>
            </div>

            <div className="cta-band reveal">
              <p>この事例のような形が、あなたのお店にも合うか。今なら実績制作価格(¥50,000)でご相談いただけます。</p>
              <a className="btn-primary" href="#contact">無料診断を申し込む<span className="arrow">→</span></a>
            </div>
          </section>

          <section id="process" className="section section--tight">
            <div className="eyebrow reveal">Process</div>
            <h2 className="section-heading reveal">制作の流れ</h2>
            <p className="section-sub reveal">相談から公開まで、6つのステップで進みます。</p>

            <div className="mini-wrap reveal" id="processMiniWrap">
              <div className="mini-spine">
                <div className="mini-spine-track" />
                <div className="mini-spine-fill" id="processMiniFill" />
                <div className="mini-node" data-target="step-1" />
                <div className="mini-node" data-target="step-2" />
                <div className="mini-node" data-target="step-3" />
                <div className="mini-node" data-target="step-4" />
                <div className="mini-node" data-target="step-5" />
                <div className="mini-node" data-target="step-6" />
              </div>

              <div className="mini-list" style={{ gap: 36 }}>
                <div id="step-1"><h3 className="step-name">相談</h3><p className="step-desc">まずは、今困っていることをお聞きします。</p></div>
                <div id="step-2"><h3 className="step-name">ヒアリング</h3><p className="step-desc">お店の状況、お客様層、伝えたいことを整理します。</p></div>
                <div id="step-3"><h3 className="step-name">提案</h3><p className="step-desc">必要な機能と構成を、分かりやすい形でご提案します。</p></div>
                <div id="step-4"><h3 className="step-name">制作</h3><p className="step-desc">デザインとコーディングを進め、途中経過もご確認いただきます。</p></div>
                <div id="step-5"><h3 className="step-name">確認</h3><p className="step-desc">公開前に、内容と動作を一緒に確認します。</p></div>
                <div id="step-6"><h3 className="step-name">公開</h3><p className="step-desc">ドメイン・サーバーの設定を行い、公開します。</p></div>
              </div>
            </div>
          </section>

          <section id="pricing" className="section">
            <div className="eyebrow reveal">Pricing</div>
            <h2 className="section-heading reveal">実績制作について</h2>
            <p className="section-sub reveal">将来的には¥250,000〜を通常価格として予定しています。まずは、実績とお客様の声を大切にしたいと考えています。</p>

            <div className="campaign-box reveal">
              <div className="campaign-label">実績制作価格</div>
              <p className="campaign-price">¥50,000<span className="unit">(税込)</span></p>
              <p className="campaign-desc">現在、Second Rootでは実績づくりのため、この価格でご案内しています。</p>
              <ul className="campaign-conditions">
                <li>制作事例として掲載可能</li>
                <li>お客様の声を掲載可能</li>
                <li>完成サイトへのリンク掲載可能</li>
              </ul>
              <p className="campaign-note">対応内容や制作への姿勢は、通常と変わりません。</p>
              <p className="campaign-scope">実績制作価格は、シンプルな店舗サイトを対象としています。ECサイト、予約システム、会員機能など、特殊な機能をご希望の場合は、内容に応じて別途お見積りとなります。</p>
              <a className="btn-primary" href="#contact">実績制作価格で相談する<span className="arrow">→</span></a>
            </div>

            <p className="future-price-label reveal">将来の通常価格(参考・現在はご案内していません)</p>
            <div className="pillar-list reveal future-pricing">
              <div className="pillar">
                <h3 className="pillar-name">シンプル店舗サイト</h3>
                <p className="pillar-price">¥250,000〜(税別)</p>
                <p className="pillar-for">まずはお店の存在を伝えたい方に</p>
                <p className="pillar-desc">1〜3ページ程度の構成。スマートフォン対応・基本的なSEO設計を含みます。</p>
              </div>
              <div className="pillar">
                <h3 className="pillar-name">CMS付きサイト</h3>
                <p className="pillar-price">¥400,000〜(税別)</p>
                <p className="pillar-for">ご自身で更新していきたい方に</p>
                <p className="pillar-desc">営業時間や商品情報を更新できるCMSと、Instagramなど外部連携を含みます。</p>
              </div>
              <div className="pillar">
                <h3 className="pillar-name">オーダーメイド</h3>
                <p className="pillar-price">¥600,000〜(税別)</p>
                <p className="pillar-for">お店に合わせて、必要な機能を個別に</p>
                <p className="pillar-desc">予約システムや会員機能など、内容に応じて個別に設計します。</p>
              </div>
            </div>

            <dl className="info-list reveal" style={{ marginTop: 44 }}>
              <div className="info-row"><dt>お支払い方法</dt><dd>買い切りを基本とし、分割のご相談も可能です。</dd></div>
              <div className="info-row"><dt>公開後の対応</dt><dd>都度のご依頼(実費)、または月額¥5,000〜の保守プランからお選びいただけます。</dd></div>
              <div className="info-row"><dt>ドメイン・サーバー</dt><dd>取得・設定を代行します。年間の実費(数千円〜1万円程度)のみお客様のご負担となります。</dd></div>
            </dl>

            <div className="cta-band reveal">
              <p>料金だけでは分からないことも、無料診断でお答えします。今なら実績制作価格(¥50,000)のご相談も可能です。</p>
              <a className="btn-primary" href="#contact">無料診断を申し込む<span className="arrow">→</span></a>
            </div>
            <p className="section-sub reveal" style={{ marginTop: 32, marginBottom: 0 }}>まずはお気軽にご相談ください。ご予算やご希望に合わせたご提案も可能です。</p>
          </section>

          <section id="founder" className="section">
            <div className="eyebrow reveal">Founder</div>
            <h2 className="section-heading reveal">パン屋で働きながら、つくっています。</h2>
            <div className="founder-body">
              <p className="reveal">Second Rootは、一人で運営しています。</p>
              <p className="reveal">普段はパン屋の現場に立ちながら、地域のお店のホームページを制作しています。</p>
              <p className="reveal">「更新が面倒で、つい後回しになる」感覚も、「忙しい合間に、お店を続ける大変さ」も、実感として分かります。</p>
              <p className="reveal">パン屋の仕事は主に早朝が中心のため、平日夜と休日を中心にご連絡・制作対応をしています。ご連絡には、原則24時間以内に返信します。</p>
              <p className="reveal">制作には、AIを開発パートナーとして活用しています。コードの品質を確認し、表示の崩れや動作の不具合を減らすために使うもので、内容や仕上がりの責任は、すべて自分自身にあります。</p>
            </div>
            <div className="signature reveal">Second Root</div>

            <ul className="promise-list reveal">
              <li className="promise-item"><span className="tick" />専門用語をできるだけ使わず、説明します。</li>
              <li className="promise-item"><span className="tick" />できないことを、できるとは言いません。</li>
              <li className="promise-item"><span className="tick" />お店に必要な機能を、一緒に整理します。</li>
              <li className="promise-item"><span className="tick" />更新しやすい仕組みを考えます。</li>
              <li className="promise-item"><span className="tick" />公開して終わりではなく、その後の使い方まで考えます。</li>
              <li className="promise-item"><span className="tick" />不要な機能や、余分な費用は提案しません。</li>
            </ul>
          </section>

          <section id="faq" className="section section--tight">
            <div className="eyebrow reveal">FAQ</div>
            <h2 className="section-heading reveal">よくある質問</h2>
            <div className="faq-list reveal">
              <details className="faq-item">
                <summary>相談したら、契約しないといけませんか?<span className="mark" /></summary>
                <p>いいえ。ご相談・無料診断だけのご利用も歓迎しています。無理な営業はいたしませんので、お気軽にお問い合わせください。</p>
              </details>
              <details className="faq-item">
                <summary>買い切りの場合、公開後に毎月かかる費用はありますか?<span className="mark" /></summary>
                <p>必ずかかるのは、ドメインとサーバーの実費(年間数千円〜1万円程度)のみです。制作費用として毎月お支払いいただくものはありません。修正・更新を都度ではなくお任せしたい場合のみ、月額¥5,000〜の保守プランをご案内しています。</p>
              </details>
              <details className="faq-item">
                <summary>修正は何回までですか?<span className="mark" /></summary>
                <p>公開前の確認では、回数に明確な上限を設けていません。公開後の修正は都度のご依頼、または月額保守プランでの対応となります。</p>
              </details>
              <details className="faq-item">
                <summary>実績制作価格は、なぜそんなに安いのですか?<span className="mark" /></summary>
                <p>Second Rootはまだ実績とお客様の声が少ない、立ち上げ段階だからです。制作事例やお客様の声としての掲載にご協力いただくことを条件に、特別価格でご案内しています。対応内容や丁寧さが変わることはありません。</p>
              </details>
              <details className="faq-item">
                <summary>実績制作価格でも、対応内容は変わりますか?<span className="mark" /></summary>
                <p>いいえ。デザイン・制作への姿勢や品質は通常と変わりません。価格が異なるのは、実績づくりへのご協力をお願いしているためです。</p>
              </details>
              <details className="faq-item">
                <summary>対応エリアはどこまでですか?<span className="mark" /></summary>
                <p>オンラインで全国対応しています。打ち合わせもオンラインを中心に進めますので、遠方の方もご相談いただけます。</p>
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
                <summary>スマートフォンでの見え方も対応していますか?<span className="mark" /></summary>
                <p>はい。すべてのページでスマートフォン表示を前提に設計しています。</p>
              </details>
              <details className="faq-item">
                <summary>パソコンやITに詳しくなくても大丈夫ですか?<span className="mark" /></summary>
                <p>専門用語をできるだけ使わずに進めます。分からないことは、その都度確認しながら進めます。</p>
              </details>
            </div>
          </section>

          <section id="contact" className="section">
            <div className="eyebrow reveal">Contact</div>
            <p className="contact-echo reveal">事業に、もう一つの根を。</p>
            <h2 className="contact-title reveal">まずは、お店のお話を聞かせてください。</h2>
            <p className="section-sub reveal" style={{ marginBottom: 0 }}>ご相談だけでも歓迎しています。無理な営業はいたしません。</p>

            <div className="diagnosis-box reveal">
              <p>無料診断では、次の3つを確認し、改善できそうなポイントを簡単にお伝えします。</p>
              <ul>
                <li>ホームページ(まだない場合は、Instagramなど今の集客方法)</li>
                <li>Googleビジネスプロフィール</li>
                <li>Instagram</li>
              </ul>
            </div>

            {/* contact-channels: today this holds the form only. Adding LINE later
                means dropping a second button into this same flex row. */}
            <div className="contact-channels reveal">
              <ContactForm />
            </div>

            <div className="footer">
              <span>© 2026 Second Root</span>
              <nav>
                <a href="#home">Home</a>
                <a href="#works">Works</a>
                <a href="#pricing">Pricing</a>
                <a href="#contact">Contact</a>
              </nav>
            </div>
          </section>

        </main>
      </div>
    </>
  );
}
