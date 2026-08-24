import { IconCheck, IconArrow, LeafBranch } from "./Decor";

const PLANS = [
  {
    name: "実績制作",
    badge: "限定募集",
    badgeMod: "",
    for: "制作事例として掲載にご協力いただける店舗様向け",
    amount: "50,000",
    unit: "円",
    tax: "(税別)",
    terra: false,
    feature: false,
    feats: ["オリジナルデザイン", "スマートフォン対応", "お問い合わせフォーム", "掲載条件は事前にご相談"],
  },
  {
    name: "シンプルなホームページ",
    badge: "",
    badgeMod: "",
    for: "まずホームページを持ちたい方向け",
    amount: "98,000",
    unit: "円〜",
    tax: "(税別)",
    terra: false,
    feature: false,
    feats: ["オリジナルデザイン", "スマートフォン対応", "お問い合わせフォーム", "基本的なSEO設計"],
  },
  {
    name: "更新できるホームページ",
    badge: "おすすめ",
    badgeMod: "pr-badge--terra",
    for: "商品や営業時間をご自身で更新したい方向け",
    amount: "198,000",
    unit: "円〜",
    tax: "(税別)",
    terra: true,
    feature: true,
    feats: ["シンプルプランの内容すべて", "CMS導入(自分で更新)", "Instagramなど外部連携", "公開後の操作サポート"],
  },
];

export default function Pricing() {
  return (
    <section className="section section--alt" id="price" aria-labelledby="pr-h">
      <div className="container">
        <div className="sec-head sec-head--center">
          <p className="label-en">Price</p>
          <h2 className="h2" id="pr-h">
            料金プラン
          </h2>
          <p className="h2-sub">買い切りが基本です。制作費として毎月お支払いいただくものはありません。</p>
          <span className="rule-mark" />
        </div>

        <div className="pr-grid">
          {PLANS.map((p) => (
            <div
              className={`pr-card${p.feature ? " pr-card--feature" : ""}${p.terra ? " pr-card--terra" : ""}`}
              key={p.name}
            >
              {p.badge && <span className={`pr-badge ${p.badgeMod}`}>{p.badge}</span>}
              <LeafBranch className="pr-leaf" style={{ color: p.terra ? "var(--terra)" : "var(--green-soft)" }} />
              <h3 className="pr-name">{p.name}</h3>
              <p className="pr-for">{p.for}</p>
              <p className="pr-amt">
                {p.amount}
                <span className="u">{p.unit}</span>
              </p>
              <p className="pr-tax">{p.tax}</p>
              <ul className="pr-feats">
                {p.feats.map((f) => (
                  <li key={f}>
                    <IconCheck />
                    {f}
                  </li>
                ))}
              </ul>
              <div className="pr-cta">
                <a className={`btn btn--sm btn--block ${p.feature ? "btn--green" : "btn--outline"}`} href="#contact">
                  このプランで相談する
                </a>
              </div>
            </div>
          ))}
        </div>

        <div className="pr-custom">
          <p>
            <b>カスタム / 要相談</b>
            <br />
            予約・会員機能など、その他のご要望・カスタム制作は個別にお見積りします。
          </p>
          <a className="tlink" href="#contact">
            カスタムのご相談はこちら
            <IconArrow />
          </a>
        </div>

        <p className="pr-foot">
          ※ ドメイン・サーバーの実費(年間数千円〜1万円程度)のみ別途ご負担いただきます。
        </p>
      </div>
    </section>
  );
}
