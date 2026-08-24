import ContactForm from "@/components/ContactForm";
import { LeafSpray, LeafBranch, IconCheck, IconSearch, IconLayout, IconYen } from "./Decor";

const CHIPS = ["24時間以内に返信", "オンライン対応OK", "しつこい営業はしません"];

const WHAT = [
  { Icon: IconSearch, t: "今の状況を確認", d: "ホームページ・Google・Instagramなど、現在の発信状況を拝見します。" },
  { Icon: IconLayout, t: "必要なものを整理", d: "お店に必要なページや機能を、優先順位をつけて整理します。" },
  { Icon: IconYen, t: "予算感をご相談", d: "どのくらいの費用でどこまでできるか、目安をお伝えします。" },
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
            ご相談・無料診断だけのご利用も歓迎しています。まずは今の状態を一緒に確認するところから始めましょう。
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
            <h3>無料診断でお伝えすること</h3>
            <p>お預かりした内容をもとに、以下の3点をご案内します。</p>
          </div>

          <ul className="fd-points" style={{ marginBottom: 32 }}>
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
