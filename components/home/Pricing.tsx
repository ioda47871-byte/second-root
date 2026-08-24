import { IconCheck, IconArrow, LeafBranch } from "./Decor";

/**
 * Cards carry price / who it's for / 4-6 headline items only.
 * Everything conditional (納期・修正回数・支払い・公開後・実費) lives in
 * the terms strip below and in the FAQ, so the cards stay scannable.
 */
const PLANS = [
  {
    name: "実績制作",
    badge: "条件あり",
    badgeMod: "",
    for: "制作事例として掲載にご協力いただける店舗様向け",
    amount: "50,000",
    unit: "円",
    tax: "税込 55,000円",
    terra: false,
    feature: false,
    feats: [
      "1〜3ページ程度",
      "スマートフォン対応",
      "文章整理・基本的な情報設計",
      "問い合わせ／Instagram等への導線",
      "基本的なSEO設定",
      "CMSなし",
    ],
  },
  {
    name: "シンプルプラン",
    badge: "",
    badgeMod: "",
    for: "まずホームページを持ちたい方向け",
    amount: "98,000",
    unit: "円〜",
    tax: "税込 107,800円〜",
    terra: false,
    feature: false,
    feats: [
      "5ページ程度まで",
      "オリジナルデザイン",
      "文章整理・情報設計",
      "問い合わせフォーム／Instagram・Googleマップ導線",
      "GA4・Search Console 初期接続",
      "CMSなし",
    ],
  },
  {
    name: "更新プラン",
    badge: "おすすめ",
    badgeMod: "pr-badge--terra",
    for: "商品や営業時間をご自身で更新したい方向け",
    amount: "198,000",
    unit: "円〜",
    tax: "税込 217,800円〜",
    terra: true,
    feature: true,
    feats: [
      "シンプルプランの内容すべて",
      "原則1種類の情報を更新できるCMS",
      "追加・編集・削除・公開／非公開",
      "画像登録・カテゴリ設定",
      "初期データ10件程度・操作説明",
      "Brot Yanagi級の商品管理に対応",
    ],
  },
];

const TERMS = [
  { t: "納期", d: "素材の受領・仕様確定・着手金入金から通常3〜5週間程度" },
  { t: "修正", d: "料金内で2回まで(当方のミス・不具合は回数に含みません)" },
  { t: "お支払い", d: "銀行振込。着手金50% / 公開前に残金50%" },
  { t: "公開後", d: "公開日から30日間、当方の不具合・表示崩れを無料修正" },
  { t: "写真", d: "原則ご用意いただきます。選定・トリミング・調整は料金内" },
  { t: "文章", d: "ヒアリングと既存情報の整理は基本料金に含みます" },
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
          <p className="h2-sub">
            買い切りが基本です。制作費として毎月お支払いいただくものはありません。
          </p>
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
              <p className="pr-tax">
                (税別) / {p.tax}
              </p>
              <ul className="pr-feats">
                {p.feats.map((f) => (
                  <li key={f}>
                    <IconCheck />
                    {f}
                  </li>
                ))}
              </ul>
              <div className="pr-cta">
                <a
                  className={`btn btn--sm btn--block ${p.feature ? "btn--green" : "btn--outline"}`}
                  href="#contact"
                  data-ga="pricing_cta_click"
                >
                  このプランで相談する
                </a>
              </div>
            </div>
          ))}
        </div>

        {/* 実績制作の適用条件 — 「限定枠」ではなく交換条件であることを明示 */}
        <div className="pr-cond">
          <h3 className="pr-cond-h">実績制作プランの適用条件</h3>
          <ul className="pr-cond-list">
            <li>
              <IconCheck />
              Second Rootサイトへの制作事例掲載にご協力いただけること
            </li>
            <li>
              <IconCheck />
              お客様の声・完成サイトへのリンク掲載にご協力いただけること
            </li>
            <li>
              <IconCheck />
              必要に応じて管理画面や制作過程の紹介をご許可いただけること
            </li>
          </ul>
          <p className="pr-cond-note">
            掲載いただく項目(店舗名・画像・URL・お客様の声など)は、それぞれ事前に個別で確認いたします。内容・必要な機能・スケジュールによっては、実績制作価格でお受けできない場合があります。
          </p>
        </div>

        <div className="pr-custom">
          <p>
            <b>カスタム / 要相談</b>
            <br />
            予約・EC・複雑なCMS・その他の個別要件は、内容をうかがったうえで個別にお見積りします。
            追加ページは15,000円(税別)〜／1ページが目安です。
          </p>
          <a className="tlink" href="#contact" data-ga="pricing_cta_click">
            カスタムのご相談はこちら
            <IconArrow />
          </a>
        </div>

        <div className="pr-terms">
          <h3 className="pr-terms-h">お取引の条件</h3>
          <dl className="pr-terms-grid">
            {TERMS.map((t) => (
              <div className="pr-term" key={t.t}>
                <dt>{t.t}</dt>
                <dd>{t.d}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="pr-monthly">
          <p>
            <b>月額保守契約への加入は必須ではありません。</b>
            保守契約なしでもサイトはお客様のものとして運用いただけます。必要な場合のみ、保守・更新プランをご案内します。
          </p>
          <p className="pr-monthly-note">
            ※ ドメイン・サーバー・外部サービスの利用料は制作費とは別に、お客様のご負担となります(お客様名義での取得・設定を代行します)。
          </p>
        </div>
      </div>
    </section>
  );
}
