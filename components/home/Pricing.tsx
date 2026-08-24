import { IconCheck, IconArrow, LeafBranch, Dots } from "./Decor";
import Jp from "./Jp";

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
    for: "制作事例として｜掲載にご協力いただける｜店舗様向け",
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
    for: "まずホームページを｜持ちたい方向け",
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
    for: "商品や営業時間を｜ご自身で更新したい｜方向け",
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

/**
 * 「制作料金が買い切り」と「公開し続けるための費用」を混同させないための
 * 4区分。金額は確定していないものを載せない。
 */
const RUNNING = [
  {
    t: "制作料金",
    v: "買い切り",
    d: "制作料金として毎月｜お支払いいただく｜費用はありません",
  },
  {
    t: "独自ドメイン",
    v: "別途必要",
    d: "ホームページの住所に｜あたるもの。｜お客様名義で取得し、｜ドメイン会社へ｜直接お支払いいただきます",
  },
  {
    t: "公開環境",
    v: "初年度は制作料金に含む",
    d: "Second Rootの公開環境を｜ご利用の場合。｜初年度は本番公開日から｜1年間です",
  },
  {
    t: "2年目以降",
    v: "ご希望の場合のみ 年1回",
    d: "更新前に費用と内容を｜ご案内します。｜銀行振込で、｜自動課金ではありません",
  },
];

const COND = [
  "Second Rootサイトへの｜制作事例掲載に｜ご同意いただけること",
  "お客様の声・｜完成サイトへの｜リンク掲載に｜ご協力いただけること",
  "必要に応じて｜管理画面や制作過程の｜紹介をご許可｜いただけること",
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
            <Jp t="買い切りが基本です。｜制作費として毎月｜お支払いいただくものは｜ありません。" />
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
              <p className="pr-for">
                <Jp t={p.for} />
              </p>
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

          {/* 「買い切り = 公開後も一切無料」と読まれないよう、料金のすぐ下に
              置く。制作料金 / ドメイン / 公開環境 / 2年目以降 の4区分。 */}
          <div className="pr-running">
            <h3 className="pr-detail-h">公開後にかかる費用</h3>
            <dl className="pr-running-grid">
              {RUNNING.map((r) => (
                <div className="pr-term pr-term--run" key={r.t}>
                  <dt>{r.t}</dt>
                  <dd>
                    <b>
                      <Jp t={r.v} />
                    </b>
                    <span>
                      <Jp t={r.d} />
                    </span>
                  </dd>
                </div>
              ))}
            </dl>
            <p className="pr-running-note">
              <Jp t="ドメインの選定・取得・接続・｜初期設定は｜Second Rootが｜サポートします。｜ドメイン会社の設定によっては、｜登録したクレジットカードから｜自動更新されます。｜Second Rootがお客様の｜クレジットカード情報を｜お預かりすることは｜ありません。" />
            </p>
            <p className="pr-running-note">
              <Jp t="2年目以降にSecond Rootの公開環境を｜継続されない場合は、｜お客様自身の公開環境への移管、｜別の管理者への引き継ぎ、｜またはサイトの｜公開終了について｜ご相談します。｜完成データやサイトの利用権が｜自動的に失われることは｜ありません。" />
            </p>
          </div>

          <div className="pr-notes">
            <div className="pr-note pr-note--cond">
              <h4 className="pr-note-h">実績制作プランの適用条件</h4>
              <ul className="pr-note-list">
                {COND.map((c) => (
                  <li key={c}>
                    <IconCheck />
                    <span>
                      <Jp t={c} />
                    </span>
                  </li>
                ))}
              </ul>
              <p className="pr-note-p">
                <Jp t="掲載する項目｜(店舗名・画像・URL・｜お客様の声など)は、｜それぞれ事前に個別で｜確認します。｜内容・必要な機能・｜スケジュールによっては、｜実績制作価格でお受けできない｜場合があります。" />
              </p>
            </div>

            <div className="pr-note pr-note--custom">
              <h4 className="pr-note-h">カスタム / その他の費用</h4>
              <p className="pr-note-p">
                <b>
                  <Jp t="カスタムは要相談。" />
                </b>
                <Jp t="予約・EC・｜複雑なCMS・｜その他の個別要件は、｜内容をうかがったうえで｜個別にお見積りします。｜追加ページは｜15,000円(税別)〜／｜1ページが目安です。" />
              </p>
              <p className="pr-note-p">
                <b>
                  <Jp t="月額保守契約への加入は｜必須ではありません。" />
                </b>
                <Jp t="保守契約なしでも、｜サイトを継続して｜運用・改修いただけます。｜必要な場合のみ、｜保守・更新プランを｜ご案内します。" />
              </p>
              <p className="pr-note-p pr-note-p--muted">
                <Jp t="ここでいう保守は、｜文章修正・画像差し替え・｜ページ追加などの｜継続的な対応です。｜上記の公開環境管理費とは｜別のサービスです。" />
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
