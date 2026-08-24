import { IconInstagram, IconClock, IconPhone, IconPencil, LeafBranch, LeafSpray, Dots } from "./Decor";
import Jp from "./Jp";

const ITEMS = [
  {
    n: "01",
    Icon: IconInstagram,
    title: "Instagramはあるけど、\nホームページがない",
    body: "投稿は流れてしまい、｜営業時間や商品を｜まとめて見られる｜場所がない状態です。",
  },
  {
    n: "02",
    Icon: IconClock,
    title: "情報を整理したいけど、\n時間がない",
    body: "店に立ちながら｜構成を考えるのは大変です。｜整理からご一緒します。",
  },
  {
    n: "03",
    Icon: IconPhone,
    title: "スマホで見やすく\n信頼感のあるサイトにしたい",
    body: "多くのお客様は｜スマホで見ます。｜小さな画面での見え方から｜設計します。",
  },
  {
    n: "04",
    Icon: IconPencil,
    title: "自分で更新できる\nサイトがほしい",
    body: "専門知識がなくても、｜商品や営業時間を｜ご自身で｜変えられるようにします。",
  },
];

export default function Reasons() {
  return (
    <section className="section section--alt" aria-labelledby="reasons-h">
      <div className="container">
        {/* 参考画像と同じく「見出しごと一枚のパネルに収める」構成。
            項目を独立カードにせず、縦罫で区切って一群として見せる。 */}
        <div className="reasons-wrap">
          <LeafSpray className="decor reasons-leaf-a" />
          <LeafBranch className="decor reasons-leaf-b" />
          <Dots className="decor reasons-dots" cols={4} rows={3} />

          <div className="reasons-head sec-body">
            <p className="label-en">Problem</p>
            <h2 className="h2" id="reasons-h">
              こんなお悩みありませんか？
            </h2>
            <p className="h2-sub">
              <Jp t="ひとつでも｜当てはまるなら、｜まずは今の状態を｜一緒に確認する｜ところから始めます。" />
            </p>
          </div>

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
                <p className="reason-d">
                  <Jp t={body} />
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
