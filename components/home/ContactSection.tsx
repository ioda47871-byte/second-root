import ContactForm from "@/components/ContactForm";
import { LeafSpray, LeafBranch, Dots, IconCheck, IconSearch, IconLayout, IconYen } from "./Decor";
import Jp from "./Jp";

const CHIPS = ["原則24時間以内に返信", "オンライン対応OK", "しつこい営業はしません"];

/** 無料診断で実際に見るもの。抽象語ではなく確認項目まで書く。 */
const WHAT = [
  {
    Icon: IconSearch,
    mod: "a",
    t: "今の発信状況",
    d: "現在の｜ホームページ・｜Instagram・｜Google上の店舗情報を｜拝見し、｜営業時間・商品・｜アクセス・予約方法が｜どこまで伝わる状態か｜確認します。",
  },
  {
    Icon: IconLayout,
    mod: "b",
    t: "情報の整理と導線",
    d: "情報が探しやすいか、｜スマートフォンでの表示に｜問題がないか、｜問い合わせや｜来店までの導線が｜途切れていないかを｜見ます。",
  },
  {
    Icon: IconYen,
    mod: "c",
    t: "改善点と予算感",
    d: "改善できそうな点を｜2〜3点お伝えし、｜どのくらいの費用で｜どこまでできるかの｜目安をご案内します。",
  },
];

const FLOW = [
  { n: "01", t: "フォーム送信", d: "下のフォームから｜お送りください。" },
  { n: "02", t: "受領のご返信", d: "原則24時間以内に｜ご連絡します。" },
  { n: "03", t: "簡易診断のご案内", d: "原則3営業日以内を｜目安にお送りします。" },
  { n: "04", t: "オンライン面談", d: "ご希望の方のみ、｜Google Meetで｜約20分。" },
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
            <Jp t="ご相談・無料診断だけの｜ご利用も歓迎しています。｜診断後に｜ご契約いただく義務は｜ありません。" />
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
            <p>
              <Jp t="お預かりした内容をもとに、｜以下の3点を｜ご案内します。" />
            </p>
          </div>

          <ul className="ct-what">
            {WHAT.map(({ Icon, mod, t, d }) => (
              <li className={`ct-what-card ct-what-card--${mod}`} key={t}>
                <Icon className="ct-what-ic" />
                <b>{t}</b>
                <span>
                  <Jp t={d} />
                </span>
              </li>
            ))}
          </ul>

          <p className="ct-exclude">
            <Jp t="※ 完成デザイン・｜詳細なサイト設計・｜無料のサンプルサイト制作は｜無料診断には｜含みません。" />
          </p>

          <div className="ct-flow">
            <h4 className="ct-flow-h">お申し込み後の流れ</h4>
            <ol className="ct-flow-row">
              {FLOW.map((f) => (
                <li className="ct-flow-step" key={f.n}>
                  <span className="ct-flow-no">{f.n}</span>
                  <b>{f.t}</b>
                  <span className="ct-flow-d">
                    <Jp t={f.d} />
                  </span>
                </li>
              ))}
            </ol>
            <p className="ct-flow-note">
              <Jp t="土日祝にいただいた｜お問い合わせは、｜翌営業日のご返信と｜なる場合があります。" />
            </p>
          </div>

          <ContactForm />
        </div>
      </div>
    </section>
  );
}
