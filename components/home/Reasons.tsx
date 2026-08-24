import { IconInstagram, IconClock, IconPhone, IconPencil, LeafBranch } from "./Decor";

const ITEMS = [
  {
    n: "01",
    Icon: IconInstagram,
    title: "Instagramはあるけど、\nホームページがない",
    body: "投稿は流れてしまい、営業時間や商品をまとめて見られる場所がない状態です。",
  },
  {
    n: "02",
    Icon: IconClock,
    title: "情報を整理したいけど、\n時間がない",
    body: "店に立ちながら構成を考えるのは大変です。整理からご一緒します。",
  },
  {
    n: "03",
    Icon: IconPhone,
    title: "スマホで見やすく\n信頼感のあるサイトにしたい",
    body: "多くのお客様はスマホで見ます。小さな画面での見え方から設計します。",
  },
  {
    n: "04",
    Icon: IconPencil,
    title: "自分で更新できる\nサイトがほしい",
    body: "専門知識がなくても、商品や営業時間をご自身で変えられるようにします。",
  },
];

export default function Reasons() {
  return (
    <section className="section section--alt" aria-labelledby="reasons-h">
      <div className="container">
        <div className="sec-head sec-head--center">
          <p className="label-en">Problem</p>
          <h2 className="h2" id="reasons-h">
            こんなお悩みありませんか？
          </h2>
          <p className="h2-sub">
            ひとつでも当てはまるなら、まずは今の状態を一緒に確認するところから始めます。
          </p>
          <span className="rule-mark" />
        </div>

        <div className="reasons-wrap">
          <LeafBranch
            className="decor"
            style={{ right: -18, bottom: -18, width: 130, color: "var(--green-soft)", opacity: 0.22 }}
          />
          <div className="reason-grid sec-body">
            {ITEMS.map(({ n, Icon, title, body }) => (
              <div className="reason" key={n}>
                <div className="reason-top">
                  <span className="reason-no">{n}</span>
                  <Icon className="reason-ic" />
                </div>
                <p className="reason-t" style={{ whiteSpace: "pre-line" }}>
                  {title}
                </p>
                <p className="reason-d">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
