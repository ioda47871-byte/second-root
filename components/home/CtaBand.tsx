import { RootMark, LeafSpray, LeafBranch, Dots, IconArrow, IconCheck } from "./Decor";
import Jp from "./Jp";

const CHIPS = ["ご相談・お見積り無料", "オンライン対応OK", "しつこい営業はしません"];

/** The wide green CTA that recurs through the page. */
export default function CtaBand() {
  return (
    <section className="section section--tight" aria-label="無料相談のご案内">
      <div className="container">
        <div className="ctaband">
          <LeafSpray className="ctaband-leaf" />
          <LeafBranch className="ctaband-leaf2" />
          <Dots className="ctaband-dots" cols={5} rows={4} />
          <span className="ctaband-circle" aria-hidden="true" />
          <div className="ctaband-in">
            <RootMark className="ctaband-mark" style={{ color: "var(--gold-soft)" }} />
            <div>
              <p className="ctaband-kick">まずはお気軽にご相談ください</p>
              <h2 className="ctaband-h">
                あなたのお店に合った
                <br />
                <Jp t="ホームページの考え方を｜お伝えします。" />
              </h2>
              <ul className="ctaband-chips">
                {CHIPS.map((c) => (
                  <li key={c}>
                    <IconCheck />
                    {c}
                  </li>
                ))}
              </ul>
            </div>
            <a className="btn btn--white" href="#contact" data-ga="diagnosis_cta_click">
              無料診断を申し込む
              <IconArrow />
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
