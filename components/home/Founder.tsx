import { IconUser, IconClock, IconCheckCircle, IconHands, LeafBranch } from "./Decor";
import Jp from "./Jp";

const POINTS = [
  {
    Icon: IconUser,
    t: "最初から最後まで｜同じ担当者",
    d: "窓口が変わって、｜伝えたことが｜振り出しに戻ることは｜ありません。",
  },
  {
    Icon: IconClock,
    t: "原則24時間以内に｜返信",
    d: "忙しさを理由に、｜ご連絡を｜曖昧にはしません。",
  },
  {
    Icon: IconCheckCircle,
    t: "できないことは、｜できると言わない",
    d: "不要な機能や、｜余分な費用は｜提案しません。",
  },
  {
    Icon: IconHands,
    t: "一つひとつ、丁寧に",
    d: "同時に多くを抱えず、｜お店ごとに｜向き合います。",
  },
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
                <Jp t="閉店後に｜ホームページのことを｜考える余力が、｜どれだけ｜残っていないか。｜忙しい時間帯に｜手が離せないと｜どうなるか。｜現場にいるからこそ、｜無理のない更新の仕組みや、｜本当は必要のない機能を｜見分けられます。" />
              </p>
              <p className="fd-body">
                <Jp t="デザインの前に、｜お店の魅力を｜どう伝えるかを、｜一緒に考えます。｜文章が｜まとまっていなくても｜大丈夫です。｜ヒアリングと既存情報の｜整理から一緒に進めます。" />
              </p>

              <div className="fd-profile">
                <h3 className="fd-profile-h">プロフィール</h3>
                <p>
                  <Jp t="愛知県名古屋市・｜金山駅周辺を拠点に｜活動しています。｜大学で学びながら、｜パン屋の現場に立ち、｜Second Rootとして｜地域のお店の｜ホームページ制作を｜行っています。｜名古屋市内は｜対面でのご相談も｜可能です。｜全国からオンラインで｜ご相談いただけます。" />
                </p>
              </div>
            </div>

            <ul className="fd-points">
              {POINTS.map(({ Icon, t, d }) => (
                <li className="fd-point" key={t}>
                  <Icon style={{ width: 22, height: 22 }} />
                  <span>
                    <b>
                      <Jp t={t} />
                    </b>
                    <span>
                      <Jp t={d} />
                    </span>
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
