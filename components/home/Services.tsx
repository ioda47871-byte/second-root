import { IconMonitor, IconRefresh, IconHands, LeafBranch } from "./Decor";

const ITEMS = [
  {
    n: "01",
    mod: "a",
    Icon: IconMonitor,
    title: "サイト制作",
    body: "お店や商品の魅力を、初めて訪れた人にも分かりやすく届けます。",
    tags: ["スマートフォン対応", "基本的なSEO設計"],
    leaf: "var(--green)",
  },
  {
    n: "02",
    mod: "b",
    Icon: IconRefresh,
    title: "更新の仕組みづくり",
    body: "営業時間や商品情報を、専門知識がなくても自分で更新できる仕組みにします。",
    tags: ["CMS導入", "Instagramなど外部連携"],
    leaf: "var(--terra)",
  },
  {
    n: "03",
    mod: "c",
    Icon: IconHands,
    title: "公開後の伴走",
    body: "公開後も、修正や更新、ちょっとした相談まで継続して対応します。",
    tags: ["修正・更新対応", "公開後のご相談"],
    leaf: "var(--blue)",
  },
];

export default function Services() {
  return (
    <section className="section" id="service" aria-labelledby="sv-h">
      <div className="container">
        <div className="sec-head sec-head--center">
          <p className="label-en">Service</p>
          <h2 className="h2" id="sv-h">
            できることを、3つに整理しました。
          </h2>
          <p className="h2-sub">サービス一覧というより、実際に対応できる範囲を正直にお伝えします。</p>
          <span className="rule-mark" />
        </div>

        <div className="sv-grid">
          {ITEMS.map(({ n, mod, Icon, title, body, tags, leaf }) => (
            <div className={`sv-card sv-card--${mod}`} key={n}>
              <LeafBranch className="sv-leaf" style={{ color: leaf }} />
              <p className="sv-no">{n}</p>
              <Icon className="sv-ic" />
              <h3 className="sv-t">{title}</h3>
              <p className="sv-d">{body}</p>
              <ul className="sv-tags">
                {tags.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
