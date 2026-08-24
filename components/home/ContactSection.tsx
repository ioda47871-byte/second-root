import ContactForm from "@/components/ContactForm";
import { LeafSpray, LeafBranch, Dots, IconCheck, IconSearch, IconLayout, IconYen } from "./Decor";

const CHIPS = ["原則24時間以内に返信", "オンライン対応OK", "しつこい営業はしません"];

/** 無料診断で実際に見るもの。抽象語ではなく確認項目まで書く。 */
const WHAT = [
  {
    Icon: IconSearch,
    mod: "a",
    t: "今の発信状況",
    d: "現在のホームページ・Instagram・Google上の店舗情報を拝見し、営業時間・商品・アクセス・予約方法がどこまで伝わる状態か確認します。",
  },
  {
    Icon: IconLayout,
    mod: "b",
    t: "情報の整理と導線",
    d: "情報が探しやすいか、スマートフォンでの表示に問題がないか、問い合わせや来店までの導線が途切れていないかを見ます。",
  },
  {
    Icon: IconYen,
    mod: "c",
    t: "改善点と予算感",
    d: "改善できそうな点を2〜3点お伝えし、どのくらいの費用でどこまでできるかの目安をご案内します。",
  },
];

const FLOW = [
  { n: "01", t: "フォーム送信", d: "下のフォームからお送りください。" },
  { n: "02", t: "受領のご返信", d: "原則24時間以内にご連絡します。" },
  { n: "03", t: "簡易診断のご案内", d: "原則3営業日以内を目安にお送りします。" },
  { n: "04", t: "オンライン面談", d: "ご希望の方のみ、Google Meetで約20分。" },
];

export default function ContactSection() {
  return (
    <section id="contact" aria-labelledby="ct-h">
      <div className="ct-hero section">
        <LeafSpray className="decor ct-leaf-a" />
        <LeafBranch className="decor ct-leaf-b" />
        <Dots className="decor ct-dots" cols={5} rows={4} />
        <span className="ct-circle" aria-hidden="true" />
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

      <div className="container ct-body">
        <div className="ct-form-card">
          <div className="ct-form-head">
            <h3>無料診断で見ること</h3>
            <p>お預かりした内容をもとに、以下の3点をご案内します。</p>
          </div>

          <ul className="ct-what">
            {WHAT.map(({ Icon, mod, t, d }) => (
              <li className={`ct-what-card ct-what-card--${mod}`} key={t}>
                <Icon className="ct-what-ic" />
                <b>{t}</b>
                <span>{d}</span>
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
        </div>
      </div>
    </section>
  );
}
