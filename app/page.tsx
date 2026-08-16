"use client";

import { useEffect } from "react";
import ContactForm from "@/components/ContactForm";
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
        ["home", "philosophy", "works", "services", "process", "pricing", "founder", "faq", "contact"],
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
          <div className="node" data-target="works"><span className="node-dot" /><span className="node-label">Works</span></div>
          <div className="node" data-target="services"><span className="node-dot" /><span className="node-label">Services</span></div>
          <div className="node" data-target="process"><span className="node-dot" /><span className="node-label">Process</span></div>
          <div className="node" data-target="pricing"><span className="node-dot" /><span className="node-label">Pricing</span></div>
          <div className="node" data-target="founder"><span className="node-dot" /><span className="node-label">Founder</span></div>
          <div className="node" data-target="faq"><span className="node-dot" /><span className="node-label">FAQ</span></div>
          <div className="node" data-target="contact"><span className="node-dot" /><span className="node-label">Contact</span></div>
        </div>

        <main className="content">

          <section id="home" className="section hero hero--photo">
            <div className="hero-photo">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/brand-photos/desk-laptop-back-daylight.jpg" alt="" />
              <div className="hero-photo-scrim" aria-hidden="true" />
            </div>
            <div className="hero-photo-content">
              <div className="hero-eyebrow eyebrow">Second Root</div>
              <h1 className="hero-title">事業に、<br />もう一つの根を。</h1>
              <p className="hero-service"><span className="tick" />地域のお店のホームページ制作</p>
              <p className="hero-sub">公開した日がゴールではありません。<br />その先まで、一緒に考えていきます。</p>
              <div className="hero-cta">
                <a className="btn-primary" href="#contact">無料診断を申し込む<span className="arrow">→</span></a>
              </div>
            </div>
            <div className="scroll-cue"><div className="line" /><span>Scroll</span></div>
          </section>

          <div className="lead-band">
            <p className="lead-target reveal">パン屋・カフェ・美容室・整体など、地域のお店を中心にホームページを制作しています。</p>
            <ul className="lead-strengths reveal">
              <li><span className="tick" />相談から公開後まで、同じ担当者が対応します。</li>
              <li><span className="tick" />ご連絡には、原則24時間以内に返信します。</li>
              <li><span className="tick" />料金は、買い切りが基本です。</li>
            </ul>
          </div>

          <section id="philosophy" className="section philosophy">
            <div className="eyebrow reveal">Philosophy</div>
            <h2 className="section-heading reveal">更新しやすく、相談しやすく。</h2>

            <div className="philosophy-row">
              <div className="philosophy-body">
                <p className="reveal">完成がゴールではありません。<br />変わり続けるお店と一緒に、更新していく。</p>
              </div>
              <figure className="philosophy-photo reveal reveal-media">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/brand-photos/wall-shadow-plant-a.jpg" alt="" style={{ objectPosition: "center 55%" }} />
              </figure>
            </div>

            <div className="philosophy-row">
              <figure className="philosophy-photo philosophy-photo--compact reveal reveal-media">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/brand-photos/table-shadow-empty.jpg" alt="" style={{ aspectRatio: 3 / 4, objectPosition: "center 70%" }} />
              </figure>
              <div className="philosophy-story">
                <p className="reveal">看板、常連さん、味、接客。<br />すでにあるものを、もう一つの形で支える。<br />それが、Second Rootという名前の意味です。</p>
              </div>
            </div>
          </section>

          <section id="works" className="section section--roomy section--wide">
            <div className="eyebrow reveal">Works</div>
            <h2 className="section-heading reveal">テンプレートではなく、お店ごとに設計します。</h2>
            <p className="section-sub reveal">一つひとつのお店に合わせて、目的や雰囲気から一緒に考えます。</p>

            <figure className="works-process reveal reveal-media">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/brand-photos/notebook-wireframe-wide.jpg" alt="" />
            </figure>

            <div className="mini-wrap reveal" id="worksMiniWrap">
              <div className="mini-spine">
                <div className="mini-spine-track" />
                <div className="mini-spine-fill" id="worksMiniFill" />
                <div className="mini-node" data-target="case-brot" />
                <div className="mini-node is-muted" data-target="case-progress" />
              </div>

              <div className="mini-list">
                <div id="case-brot">
                  <div className="eyebrow" style={{ marginBottom: 8 }}>Case Study — 01</div>
                  <h3 className="case-name">Brot Yanagi<span className="case-type"> — パン屋</span></h3>
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
                      <div className="case-story-kicker">Result</div>
                      <p className="case-result">Instagramだけの運営から、<br />更新も集客も自分たちで回せる<br />サイトへ。</p>
                      <dl>
                        <div className="stage"><span className="stage-no">01</span><div className="stage-body"><dt>課題</dt><dd>SNS(Instagram)だけで運営しており、お店の存在を伝える場所がなかった。</dd></div></div>
                        <div className="stage"><span className="stage-no">02</span><div className="stage-body"><dt>提案</dt><dd>売り込まない、シンプルなホームページの制作を提案。</dd></div></div>
                        <div className="stage"><span className="stage-no">03</span><div className="stage-body"><dt>制作</dt><dd>オーナー自身で商品情報を更新できるよう、CMSを導入。</dd></div></div>
                        <div className="stage"><span className="stage-no">04</span><div className="stage-body"><dt>公開後</dt><dd>商品ページの更新が自分たちだけでできるようになり、Instagramの最新投稿も自動で反映されるように。</dd></div></div>
                      </dl>
                    </div>
                  </div>

                  <div className="gallery-heading">
                    <div className="eyebrow">Gallery</div>
                    <h4 className="case-name" style={{ marginTop: 10, marginBottom: 8 }}>店舗の雰囲気</h4>
                    <p className="case-photo-caption">パンの香りに包まれる、あたたかい空間です。</p>
                  </div>
                  <div className="gallery-photos reveal-group">
                    {/* these three use pre-cropped source files (see
                        scripts/crop-gallery-sources.mjs) — a straight
                        rectangular trim that removes the site chrome and a
                        floating demo-tool badge baked into the original
                        captures, done once so no CSS crop math has to fight
                        it. Nothing inside the kept region is altered. */}
                    <figure className="gallery-photo gallery-photo--primary reveal reveal-media">
                      <div className="gallery-photo-frame">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src="/screenshots-source/exterior-photo-crop.png"
                          alt="Brot Yanagi 外観"
                          style={{ aspectRatio: 16 / 9, objectPosition: "center 45%" }}
                        />
                      </div>
                      <figcaption><span className="tick" />外観</figcaption>
                    </figure>
                    <figure className="gallery-photo gallery-photo--portrait reveal reveal-media">
                      <div className="gallery-photo-frame">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src="/screenshots-source/interior-photo-crop.jpeg"
                          alt="Brot Yanagi 内観"
                          style={{ aspectRatio: 0.8, objectPosition: "center 50%" }}
                        />
                      </div>
                      <figcaption><span className="tick" />内観</figcaption>
                    </figure>
                    <figure className="gallery-photo gallery-photo--secondary reveal reveal-media">
                      <div className="gallery-photo-frame">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src="/screenshots-source/entrance-photo-crop.png"
                          alt="Brot Yanagi エントランス"
                          style={{ aspectRatio: 1.5, objectPosition: "center 50%" }}
                        />
                      </div>
                      <figcaption><span className="tick" />エントランス</figcaption>
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
              <p>この事例のような形が、あなたのお店にも合うか。まずは無料診断でご相談ください。</p>
              <a className="btn-primary" href="#contact">無料診断を申し込む<span className="arrow">→</span></a>
            </div>
          </section>

          <section id="services" className="section">
            <div className="eyebrow reveal">Services</div>
            <h2 className="section-heading reveal">できることを、3つに整理しました。</h2>
            <p className="section-sub reveal">サービス一覧というより、実際に対応できる範囲を、正直にお伝えします。</p>
            <div className="service-list reveal">
              <div className="service-item">
                <span className="service-no">01</span>
                <div>
                  <h3 className="pillar-name">サイト制作</h3>
                  <p className="pillar-desc">お店の紹介や商品情報を、分かりやすく伝えるホームページをつくります。</p>
                  <ul className="pillar-items"><li>スマートフォン対応</li><li>基本的なSEO設計</li></ul>
                </div>
              </div>
              <div className="service-item">
                <span className="service-no">02</span>
                <div>
                  <h3 className="pillar-name">更新の仕組みづくり</h3>
                  <p className="pillar-desc">営業時間や商品情報を、ご自身で更新できる仕組みを整えます。</p>
                  <ul className="pillar-items"><li>CMS導入</li><li>Instagramなど外部連携</li></ul>
                </div>
              </div>
              <div className="service-item">
                <span className="service-no">03</span>
                <div>
                  <h3 className="pillar-name">公開後の伴走</h3>
                  <p className="pillar-desc">公開して終わりにせず、その後の相談や調整に対応します。</p>
                  <ul className="pillar-items"><li>無料診断</li><li>修正・更新対応</li></ul>
                </div>
              </div>
            </div>

            <div className="eyebrow reveal reasons-label">Second Rootに任せる理由</div>
            <ul className="reasons-list reveal">
              <li><span className="tick" />公開して終わりにせず、その後の改善提案まで行います。</li>
              <li><span className="tick" />デザインの前に、お店の魅力をどう伝えるかを一緒に考えます。</li>
              <li><span className="tick" />担当者が変わらないからこそ、密なやり取りができます。</li>
            </ul>
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
                <div id="step-1" className="step-item"><span className="step-no">01</span><div><h3 className="step-name">相談</h3><p className="step-desc">まずは、今困っていることをお聞きします。</p></div></div>
                <div id="step-2" className="step-item"><span className="step-no">02</span><div><h3 className="step-name">ヒアリング</h3><p className="step-desc">お店の状況、お客様層、伝えたいことを整理します。</p></div></div>
                <div id="step-3" className="step-item"><span className="step-no">03</span><div><h3 className="step-name">提案</h3><p className="step-desc">必要な機能と構成を、分かりやすい形でご提案します。</p></div></div>
                <div id="step-4" className="step-item"><span className="step-no">04</span><div><h3 className="step-name">制作</h3><p className="step-desc">デザインとコーディングを進め、途中経過もご確認いただきます。</p></div></div>
                <div id="step-5" className="step-item"><span className="step-no">05</span><div><h3 className="step-name">確認</h3><p className="step-desc">公開前に、内容と動作を一緒に確認します。</p></div></div>
                <div id="step-6" className="step-item"><span className="step-no">06</span><div><h3 className="step-name">公開</h3><p className="step-desc">ドメイン・サーバーの設定を行い、公開します。</p></div></div>
              </div>
            </div>
          </section>

          <section id="pricing" className="section">
            <div className="eyebrow reveal">Pricing</div>
            <h2 className="section-heading reveal">料金について</h2>
            <p className="section-sub reveal">3つのプランを目安にご案内しています。<br />内容に応じて、柔軟にご提案します。</p>

            <div className="price-plan-list reveal">
              <div className="price-plan">
                <div className="price-plan-figure">
                  <p className="price-plan-price">¥98,000<span className="unit">〜(税別)</span></p>
                  <p className="price-plan-name">シンプルホームページ</p>
                </div>
                <div className="price-plan-body">
                  <p className="price-plan-for">ホームページを初めて作る方に</p>
                  <p className="price-plan-desc">オリジナルデザインで制作し、スマートフォン対応・お問い合わせフォームなど、必要な機能を備えたホームページを制作します。</p>
                </div>
              </div>
              <div className="price-plan">
                <div className="price-plan-figure">
                  <p className="price-plan-price">¥198,000<span className="unit">〜(税別)</span></p>
                  <p className="price-plan-name">更新できるホームページ</p>
                </div>
                <div className="price-plan-body">
                  <p className="price-plan-for">ご自身で更新していきたい方に</p>
                  <p className="price-plan-desc">営業時間や商品情報を更新できるCMSを導入し、Instagramなど必要な外部サービスとの連携にも対応します。</p>
                </div>
              </div>
              <div className="price-plan">
                <div className="price-plan-figure">
                  <p className="price-plan-price price-plan-price--quote">お見積もり</p>
                  <p className="price-plan-name">オーダーメイド</p>
                </div>
                <div className="price-plan-body">
                  <p className="price-plan-for">内容に応じてお見積もり</p>
                  <p className="price-plan-desc">予約機能や会員機能など、お店に必要な機能を一緒に整理し、最適な形でご提案します。</p>
                </div>
              </div>
            </div>

            <dl className="info-list reveal" style={{ marginTop: 64 }}>
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

            <div className="cta-band reveal">
              <p>料金だけでは分からないことも、無料診断でお答えします。</p>
              <a className="btn-primary" href="#contact">無料診断を申し込む<span className="arrow">→</span></a>
            </div>
            <p className="section-sub reveal" style={{ marginTop: 32, marginBottom: 0 }}>まずはお気軽にご相談ください。ご予算やご希望に合わせたご提案も可能です。</p>
          </section>

          <section id="founder" className="section founder-section">
            <div className="eyebrow reveal">Founder</div>
            <h2 className="section-heading reveal">担当者が変わることなく、<br />ご相談から公開後まで一貫して対応します。</h2>
            <figure className="founder-photo reveal reveal-media">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/brand-photos/office-room-wide.jpg" alt="" style={{ objectPosition: "center 42%" }} />
            </figure>
            <div className="founder-body">
              <p className="reveal">窓口が変わるたびに、伝えたはずのことが振り出しに戻る。<br />そんなことがないように、最初から最後まで同じ人間が向き合います。</p>
              <p className="reveal">公開して終わりにせず、お店の変化に合わせて長く伴走します。</p>
              <p className="reveal">ご連絡には、原則24時間以内に返信します。</p>
            </div>
            <div className="signature reveal">Second Root</div>

            <ul className="promise-list reveal">
              <li className="promise-item"><span className="tick" />できないことを、できるとは言いません。</li>
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
                <p>必ずかかるのは、ドメインとサーバーの実費(年間数千円〜1万円程度)のみです。制作費用として毎月お支払いいただくものはありません。修正・更新を都度ではなくお任せしたい場合のみ、月額¥3,000〜の保守プランをご案内しています。</p>
              </details>
              <details className="faq-item">
                <summary>修正は何回までですか?<span className="mark" /></summary>
                <p>公開前の確認では、回数に明確な上限を設けていません。公開後の修正は都度のご依頼、または月額保守プランでの対応となります。</p>
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

            <p className="contact-closing-note reveal">夜遅くのご相談でも、大丈夫です。<br />まずは、お気軽にご連絡ください。</p>

            {/* contact-channels: today this holds the form only. Adding LINE later
                means dropping a second button into this same flex row. This is
                deliberately the last thing in the section — the submit button
                is meant to read as the page's actual close. */}
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
