"use client";

import { useEffect } from "react";
import ContactForm from "@/components/ContactForm";

// Real Brot Yanagi feedback, once it exists — never a placeholder or
// AI-drafted quote. Set to { quote, name, role } to publish it.
const ownerVoice: { quote: string; name: string; role: string } | null = null;

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
        ["home", "works", "services", "founder", "pricing", "process", "faq", "philosophy", "contact"],
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
          <div className="node" data-target="works"><span className="node-dot" /><span className="node-label">Works</span></div>
          <div className="node" data-target="services"><span className="node-dot" /><span className="node-label">Services</span></div>
          <div className="node" data-target="founder"><span className="node-dot" /><span className="node-label">Founder</span></div>
          <div className="node" data-target="pricing"><span className="node-dot" /><span className="node-label">Pricing</span></div>
          <div className="node" data-target="process"><span className="node-dot" /><span className="node-label">Process</span></div>
          <div className="node" data-target="faq"><span className="node-dot" /><span className="node-label">FAQ</span></div>
          <div className="node" data-target="philosophy"><span className="node-dot" /><span className="node-label">Philosophy</span></div>
          <div className="node" data-target="contact"><span className="node-dot" /><span className="node-label">Contact</span></div>
        </div>

        <main className="content">

          <section id="home" className="section hero">
            <div className="hero-content">
              <div className="hero-eyebrow eyebrow">Second Root</div>
              <h1 className="hero-title">事業に、<br />もう一つの根を。</h1>
              <p className="hero-service"><span className="tick" />地域のお店のホームページ制作</p>
              <p className="hero-tags">パン屋・カフェ・美容室・整体</p>
              <p className="hero-sub">公開した日がゴールではありません。<br />その先まで、一緒に考えていきます。</p>
              <div className="hero-cta">
                <a className="btn-stamp" href="#contact">
                  <span className="mark">
                    <svg viewBox="0 0 24 40" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                      <line x1="12" y1="4" x2="12" y2="24" strokeWidth="2.5" strokeLinecap="round" />
                      <circle cx="12" cy="31" r="4" />
                    </svg>
                  </span>
                  <span className="label">無料診断を申し込む</span>
                </a>
              </div>
            </div>
            <div className="scroll-cue"><div className="line" /><span>Scroll</span></div>
          </section>

          <div className="lead-band">
            <p className="lead-target reveal">パン屋・カフェ・美容室・整体など、地域のお店を中心にホームページを制作しています。</p>
            <ul className="lead-strengths reveal">
              <li><span className="tick" />今も店に立ちながら、この仕事をしています。</li>
              <li><span className="tick" />相談から公開後まで、同じ担当者が対応します。</li>
              <li><span className="tick" />ご連絡には、原則24時間以内に返信します。</li>
              <li><span className="tick" />料金は、買い切りが基本です。</li>
            </ul>
          </div>

          <section id="works" className="section section--roomy section--wide">
            <h2 className="eyebrow reveal">Works</h2>

            <div className="pause pause--compact reveal">
              <p className="pause-no">03 — WORKS</p>
              <p className="pause-text">テンプレートではなく、お店ごとに設計します。</p>
              <p className="pause-sub">一つひとつのお店に合わせて、目的や雰囲気から一緒に考えます。</p>
            </div>

            <div className="mini-wrap reveal" id="worksMiniWrap">
              <div className="mini-spine">
                <div className="mini-spine-track" />
                <div className="mini-spine-fill" id="worksMiniFill" />
                <div className="mini-node" data-target="case-brot" />
                <div className="mini-node is-muted" data-target="case-progress" />
              </div>

              <div className="mini-list">
                <div id="case-brot">
                  <div className="eyebrow" style={{ marginBottom: 8 }}>特集 — Brot Yanagi</div>
                  <h3 className="case-name">Brot Yanagi<span className="case-type"> — パン屋</span></h3>
                  <div className="case-story case-story--full">
                    <div className="case-story-kicker">Result</div>
                    <p className="case-result">Instagramだけの運営から、<br />更新は自分たちでできる<br />サイトへ。</p>
                    <dl>
                      <div className="stage" data-no="01"><dt>Situation</dt><dd>Instagramだけで情報発信しており、ホームページは持っていなかった。</dd></div>
                      <div className="stage" data-no="02"><dt>Problem</dt><dd>SNSでは投稿が流れていくため、店舗情報や商品情報をひとつの場所で確認できるWebサイトがなかった。</dd></div>
                      <div className="stage" data-no="03"><dt>Approach</dt><dd>営業時間・アクセス・商品情報など、初めて訪れた人が必要な情報を迷わず確認できる構成を設計。あわせて、商品情報を店舗側で更新できる仕組みを用意した。</dd></div>
                      <div className="stage" data-no="04"><dt>Build</dt><dd>商品情報を店舗側で更新できるCMSを導入し、Instagramの投稿をサイト上でも確認できる仕組みを用意した。</dd></div>
                      <div className="stage" data-no="05"><dt>After</dt><dd>商品ページの更新は、オーナー自身の手でできるようになった。Instagramの最新投稿も、サイト上に自動で反映されている。</dd></div>
                    </dl>
                    {process.env.NEXT_PUBLIC_BROT_YANAGI_URL && (
                      <a
                        className="link-quiet case-live-link"
                        href={process.env.NEXT_PUBLIC_BROT_YANAGI_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <span className="case-live-kicker">Live Site</span>
                        実際のサイトを見る<span className="arrow">→</span>
                      </a>
                    )}
                    {ownerVoice && (
                      <div className="owner-voice">
                        <div className="case-story-kicker">Owner&apos;s Voice — 店主の声</div>
                        <p className="owner-voice-quote">{ownerVoice.quote}</p>
                        <p className="owner-voice-attr">{ownerVoice.name} — {ownerVoice.role}</p>
                      </div>
                    )}
                  </div>
                  <p className="case-credit">EDIT — Second Root</p>
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
            <h2 className="eyebrow reveal">Services</h2>

            <div className="pause pause--compact reveal">
              <p className="pause-no">04 — SERVICES</p>
              <p className="pause-text">できることを、3つに整理しました。</p>
              <p className="pause-sub">サービス一覧というより、実際に対応できる範囲を、正直にお伝えします。</p>
            </div>

            <div className="service-list reveal">
              <div className="service-item">
                <span className="service-no">01</span>
                <div>
                  <h3 className="pillar-name">サイト制作</h3>
                  <p className="pillar-desc">お店の紹介や商品情報を、初めて訪れた人にも迷わず伝わる形にします。</p>
                  <ul className="pillar-items"><li>スマートフォン対応</li><li>基本的なSEO設計</li></ul>
                </div>
              </div>
              <div className="service-item">
                <span className="service-no">02</span>
                <div>
                  <h3 className="pillar-name">更新の仕組みづくり</h3>
                  <p className="pillar-desc">営業時間や商品情報を、専門知識がなくてもご自身で更新できるようにします。</p>
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

            <p className="services-closing reveal">デザインの前に、お店の魅力をどう伝えるかを、一緒に考えます。</p>
          </section>

          <section id="founder" className="section founder-section">
            <h2 className="eyebrow reveal">Founder</h2>

            <div className="pause pause--compact reveal">
              <p className="pause-no">05 — FOUNDER</p>
              <p className="pause-text">話を、聞いてみました。</p>
            </div>

            <div className="interview reveal">
              <div className="interview-kicker">インタビュー</div>
              <h3 className="interview-title">「同じ疲れを、知っているから。」</h3>
              <div className="interview-qa">
                <div className="qa-item">
                  <p className="qa-q">Q. なぜ、パン屋の現場に立ちながら、この仕事を?</p>
                  <p className="qa-a">もともとは兼業でした。ただ、店に立っていると、閉店後にホームページのことを考える余力がどれだけ残っていないか、身体で分かるんです。だから、その感覚を知っている人間として、この仕事をしています。</p>
                </div>
                <div className="qa-item">
                  <p className="qa-q">Q. 一人で対応することに、不安はありませんか?</p>
                  <p className="qa-a">窓口が変わるたびに、伝えたことが振り出しに戻る。それが一番もったいないと思っています。最初から最後まで、同じ人間が向き合う方が、結局早いんです。公開して終わりにもせず、お店の変化に合わせて長く伴走します。</p>
                </div>
                <div className="qa-item">
                  <p className="qa-q">Q. 連絡が取りづらくなったりは?</p>
                  <p className="qa-a">その約束は、崩しません。忙しさを理由にはしない、というのが、最初に決めたことです。</p>
                </div>
              </div>
            </div>
            <div className="signature reveal">Second Root</div>

            <ul className="promise-list reveal">
              <li className="promise-item"><span className="tick" />できないことを、できるとは言いません。</li>
              <li className="promise-item"><span className="tick" />不要な機能や、余分な費用は提案しません。</li>
            </ul>
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
                  <p className="price-plan-for">店舗紹介・会社紹介など、まずホームページを持ちたい方向け。</p>
                  <p className="price-plan-desc">オリジナルデザインで制作し、スマートフォン対応・お問い合わせフォームなど、必要な機能を備えたホームページを制作します。</p>
                </div>
              </div>
              <div className="price-plan price-plan--featured">
                <div className="price-plan-figure">
                  <p className="price-plan-price">¥198,000<span className="unit">〜(税別)</span></p>
                  <p className="price-plan-name">更新できるホームページ</p>
                </div>
                <div className="price-plan-body">
                  <p className="price-plan-for">商品・営業時間・お知らせなどをご自身で更新したい方向け。</p>
                  <p className="price-plan-desc">営業時間や商品情報を更新できるCMSを導入し、Instagramなど必要な外部サービスとの連携にも対応します。</p>
                </div>
              </div>
              <div className="price-plan">
                <div className="price-plan-figure">
                  <p className="price-plan-price price-plan-price--quote">お見積もり</p>
                  <p className="price-plan-name">オーダーメイド</p>
                </div>
                <div className="price-plan-body">
                  <p className="price-plan-for">予約・会員機能など、独自の仕組みが必要な方向け。</p>
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

            <div className="portfolio-note reveal">
              <p className="portfolio-note-label">実績制作について</p>
              <p className="portfolio-note-desc">現在、Second Rootでは制作実績として掲載にご協力いただける店舗様を限定で募集しています。<br />通常料金とは別に、「実績制作価格:50,000円(税別)」での制作もご相談いただけます。</p>
              <p className="portfolio-note-note">※掲載内容や制作条件については、事前にご相談のうえ決定いたします。</p>
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
                <div id="step-1" className="step-item"><span className="step-no">01</span><div><h3 className="step-name">相談</h3><p className="step-desc">まずは、今困っていることをお聞きします。</p></div></div>
                <div id="step-2" className="step-item"><span className="step-no">02</span><div><h3 className="step-name">ヒアリング</h3><p className="step-desc">お店の状況、お客様層、伝えたいことを整理します。</p></div></div>
                <div id="step-3" className="step-item"><span className="step-no">03</span><div><h3 className="step-name">提案</h3><p className="step-desc">必要な機能と構成を、分かりやすい形でご提案します。</p></div></div>
                <div id="step-4" className="step-item"><span className="step-no">04</span><div><h3 className="step-name">制作</h3><p className="step-desc">デザインとコーディングを進め、途中経過もご確認いただきます。</p></div></div>
                <div id="step-5" className="step-item"><span className="step-no">05</span><div><h3 className="step-name">確認</h3><p className="step-desc">公開前に、内容と動作を一緒に確認します。</p></div></div>
                <div id="step-6" className="step-item"><span className="step-no">06</span><div><h3 className="step-name">公開</h3><p className="step-desc">ドメイン・サーバーの設定を行い、公開します。</p></div></div>
              </div>
            </div>
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
              <details className="faq-item">
                <summary>なぜこの価格で対応できるのですか?<span className="mark" /></summary>
                <p>効率化できる部分にはツールを活用し、お待たせする時間を減らしています。ただし、設計やデザイン、お店ごとのご提案は、必ず人が責任を持って行っています。</p>
              </details>
            </div>
          </section>

          <section id="philosophy" className="section pause">
            <p className="pause-no reveal">09 — PHILOSOPHY</p>
            <p className="pause-text reveal">看板も、常連さんとの間柄も、積み重ねてきた時間も、もうそこにある。私たちが作るのは、真新しい何かではありません。すでにあるものが、これからも続いていくための、もう一つの根です。</p>
          </section>

          <section id="contact" className="section">
            <h2 className="eyebrow reveal">Contact</h2>

            <div className="pause pause--compact reveal">
              <p className="pause-no">10 — CONTACT</p>
              <p className="pause-echo">事業に、もう一つの根を。</p>
              <p className="pause-text">まずは、お店のお話を聞かせてください。</p>
            </div>

            <div className="diagnosis-box reveal">
              <p>ホームページ・Google・Instagramなど、現在の発信状況を確認し、改善できそうなポイントを簡単にお伝えします。</p>
            </div>

            <p className="contact-closing-note reveal">夜遅くのご相談でも、大丈夫です。<br />まずは、お気軽にご連絡ください。</p>

            <div className="contact-channels reveal">
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
