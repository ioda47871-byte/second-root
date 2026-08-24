import { IconCheck, IconArrow, LeafBranch, Dots } from "./Decor";

/**
 * Cards carry price / who it's for / 4-6 headline items only.
 * Everything conditional (納期・修正回数・支払い・公開後・実費) lives in
 * the one terms panel below, so the cards stay scannable.
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
      "問い合わせフォーム／各種導線",
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

/** 見出し語＋短い値＋補足、の3点だけ。長文の羅列にしない。 */
const TERMS = [
  { t: "納期", v: "3〜5週間", d: "素材の受領・仕様確定・着手金入金から" },
  { t: "修正", v: "2回まで", d: "当方のミス・不具合は回数に含みません" },
  { t: "お支払い", v: "着手50%・公開前50%", d: "銀行振込" },
  { t: "公開後", v: "30日間 無料対応", d: "当方の不具合・表示崩れ・誤字" },
  { t: "写真", v: "原則お客様支給", d: "選定・トリミング・調整は料金内" },
  { t: "文章", v: "整理は料金内", d: "ヒアリングから一緒に進めます" },
];

const COND = [
  "Second Rootサイトへの制作事例掲載にご同意いただけること",
  "お客様の声・完成サイトへのリンク掲載にご協力いただけること",
  "必要に応じて管理画面や制作過程の紹介をご許可いただけること",
];

export default function Pricing() {
  return (
    <section className="section section--alt" id="price" aria-labelledby="pr-h">
      <LeafBranch className="decor pr-deco-leaf" />
      <Dots className="decor pr-deco-dots" cols={5} rows={4} />

      <div className="container">
        <div className="sec-head sec-head--center sec-body">
          <p className="label-en">Price</p>
          <h2 className="h2" id="pr-h">
            料金プラン
          </h2>
          <p className="h2-sub">
            買い切りが基本です。制作費として毎月お支払いいただくものはありません。
          </p>
          <span className="rule-mark" />
        </div>

        <div className="pr-grid sec-body">
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
                <span className="pr-tax-ex">税別</span>
                {p.tax}
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

        {/* 条件はすべてこの一枚に集約する。カード側は金額と内容だけに保つ。 */}
        <div className="pr-detail sec-body">
          <div className="pr-terms">
            <h3 className="pr-detail-h">お取引の条件</h3>
            <dl className="pr-terms-grid">
              {TERMS.map((t) => (
                <div className="pr-term" key={t.t}>
                  <dt>{t.t}</dt>
                  <dd>
                    <b>{t.v}</b>
                    <span>{t.d}</span>
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="pr-notes">
            <div className="pr-note pr-note--cond">
              <h4 className="pr-note-h">実績制作プランの適用条件</h4>
              <ul className="pr-note-list">
                {COND.map((c) => (
                  <li key={c}>
                    <IconCheck />
                    {c}
                  </li>
                ))}
              </ul>
              <p className="pr-note-p">
                掲載する項目(店舗名・画像・URL・お客様の声など)は、それぞれ事前に個別で確認します。内容・必要な機能・スケジュールによっては、実績制作価格でお受けできない場合があります。
              </p>
            </div>

            <div className="pr-note pr-note--custom">
              <h4 className="pr-note-h">カスタム / その他の費用</h4>
              <p className="pr-note-p">
                <b>カスタムは要相談。</b>
                予約・EC・複雑なCMS・その他の個別要件は、内容をうかがったうえで個別にお見積りします。追加ページは15,000円(税別)〜／1ページが目安です。
              </p>
              <p className="pr-note-p">
                <b>月額保守契約への加入は必須ではありません。</b>
                保守契約なしでも、サイトを継続して運用・改修いただけます。必要な場合のみ、保守・更新プランをご案内します。
              </p>
              <p className="pr-note-p pr-note-p--muted">
                ドメイン・サーバー・外部サービスの利用料は、制作費とは別にお客様のご負担となります(お客様名義での取得・設定を代行します)。
              </p>
              <a className="tlink" href="#contact" data-ga="pricing_cta_click">
                カスタムのご相談はこちら
                <IconArrow />
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
