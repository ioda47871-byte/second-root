import ContactForm from "@/components/ContactForm";
import { LeafSpray, LeafBranch, IconCheck, IconSearch, IconLayout, IconYen } from "./Decor";

const CHIPS = ["原則24時間以内に返信", "オンライン対応OK", "しつこい営業はしません"];

/** 無料診断で実際に見るもの。抽象語ではなく確認項目まで書く。 */
const WHAT = [
  {
    Icon: IconSearch,
    t: "今の発信状況を確認",
    d: "現在のホームページ・Instagram・Google上の店舗情報を拝見し、営業時間・商品・アクセス・予約方法がどこまで伝わる状態か確認します。",
  },
  {
    Icon: IconLayout,
    t: "情報の整理状態と導線を確認",
    d: "情報が探しやすいか、スマートフォンでの表示に問題がないか、問い合わせや来店までの導線が途切れていないかを見ます。",
  },
  {
    Icon: IconYen,
    t: "改善点と予算感をご提案",
    d: "改善できそうな点を2〜3点お伝えし、どのくらいの費用でどこまでできるかの目安をご案内します。",
  },
];

const FLOW = [
  { n: "01", t: "フォーム送信", d: "下のフォームからお送りください。" },
  { n: "02", t: "受領のご返信", d: "原則24時間以内にご連絡します。" },
  { n: "03", t: "簡易診断のご案内", d: "原則3営業日以内にお送りします。" },
  { n: "04", t: "オンライン面談", d: "ご希望の方のみ、約20分。" },
];

export default function ContactSection() {
  const line = process.env.NEXT_PUBLIC_LINE_URL;

  return (
    <section id="contact" aria-labelledby="ct-h">
      <div className="ct-hero section">
        <LeafSpray className="decor ct-leaf-a" />
        <LeafBranch className="decor ct-leaf-b" />
        <div className="container ct-hero-in">
          <p className="ct-kick">Contact</p>
          <h2 className="ct-h" id="ct-h">
            あなたのお店に合った
            <br />
            ホームページの考え方をお伝えします。
          </h2>
          <p className="ct-p">
            ご相談・無料診断だけのご利用も歓迎しています。診断後にご契約いただく義務はありません。
          </p>
          <ul className="ct-chips">
            {CHIPS.map((c) => (
              <li key={c}>
                <IconCheck />
                {c}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="container" style={{ paddingBottom: "clamp(56px,6.4vw,86px)" }}>
        <div className="ct-form-card">
          <div className="ct-form-head">
            <h3>無料診断で見ること</h3>
            <p>お預かりした内容をもとに、以下の3点をご案内します。</p>
          </div>

          <ul className="fd-points" style={{ marginBottom: 28 }}>
            {WHAT.map(({ Icon, t, d }) => (
              <li className="fd-point" key={t}>
                <Icon style={{ width: 22, height: 22 }} />
                <span>
                  <b>{t}</b>
                  <span>{d}</span>
                </span>
              </li>
            ))}
          </ul>

          <p className="ct-exclude">
            ※ 完成デザイン・詳細なサイト設計・無料のサンプルサイト制作は無料診断には含みません。
          </p>

          <div className="ct-flow">
            <h4 className="ct-flow-h">お申し込み後の流れ</h4>
            <ol className="ct-flow-row">
              {FLOW.map((f) => (
                <li className="ct-flow-step" key={f.n}>
                  <span className="ct-flow-no">{f.n}</span>
                  <b>{f.t}</b>
                  <span className="ct-flow-d">{f.d}</span>
                </li>
              ))}
            </ol>
            <p className="ct-flow-note">
              土日祝にいただいたお問い合わせは、翌営業日のご返信となる場合があります。
            </p>
          </div>

          <ContactForm />

          {line && (
            <p style={{ marginTop: 28, fontSize: ".88rem", color: "var(--gray)" }}>
              フォームの入力が面倒な方は、
              <a
                href={line}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "var(--green)", fontWeight: 700 }}
              >
                LINEからのご相談
              </a>
              も承っています。
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
