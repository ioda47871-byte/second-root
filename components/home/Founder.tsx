import { IconUser, IconClock, IconCheckCircle, IconHands, LeafBranch } from "./Decor";

const POINTS = [
  { Icon: IconUser, t: "最初から最後まで同じ担当者", d: "窓口が変わって、伝えたことが振り出しに戻ることはありません。" },
  { Icon: IconClock, t: "原則24時間以内に返信", d: "忙しさを理由に、ご連絡を曖昧にはしません。" },
  { Icon: IconCheckCircle, t: "できないことは、できると言わない", d: "不要な機能や、余分な費用は提案しません。" },
  { Icon: IconHands, t: "一つひとつ、丁寧に", d: "同時に多くを抱えず、お店ごとに向き合います。" },
];

/**
 * No portrait. The site never depicts a person, and a generated one is
 * out of the question — so trust is carried by concrete commitments.
 */
export default function Founder() {
  return (
    <section className="section" id="about" aria-labelledby="fd-h">
      <div className="container">
        <div className="sec-head sec-head--center">
          <p className="label-en">Founder</p>
          <h2 className="h2" id="fd-h">
            誰がつくるのか
          </h2>
          <span className="rule-mark" />
        </div>

        <div className="fd-wrap">
          <LeafBranch
            className="decor"
            style={{ right: -20, top: -20, width: 150, color: "var(--green-soft)", opacity: 0.2 }}
          />
          <div className="fd-grid sec-body">
            <div>
              <p className="fd-quote">
                パン屋の現場に立ちながら、
                <br />
                地域のお店のホームページをつくっています。
              </p>
              <p className="fd-body">
                閉店後にホームページのことを考える余力が、どれだけ残っていないか。忙しい時間帯に手が離せないとどうなるか。現場にいるからこそ、無理のない更新の仕組みや、本当は必要のない機能を見分けられます。
              </p>
              <p className="fd-body" style={{ marginBottom: 0 }}>
                デザインの前に、お店の魅力をどう伝えるかを、一緒に考えます。
              </p>
            </div>

            <ul className="fd-points">
              {POINTS.map(({ Icon, t, d }) => (
                <li className="fd-point" key={t}>
                  <Icon style={{ width: 22, height: 22 }} />
                  <span>
                    <b>{t}</b>
                    <span>{d}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
