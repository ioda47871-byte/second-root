import { IconArrow } from "./Decor";

const ITEMS = [
  {
    q: "相談したら、契約しないといけませんか?",
    a: "いいえ。ご相談・無料診断だけのご利用も歓迎しています。無理な営業はいたしませんので、お気軽にお問い合わせください。",
  },
  {
    q: "買い切りの場合、公開後に毎月かかる費用はありますか?",
    a: "必ずかかるのは、ドメインとサーバーの実費(年間数千円〜1万円程度)のみです。制作費用として毎月お支払いいただくものはありません。修正・更新を都度ではなくお任せしたい場合のみ、月額¥3,000〜の保守プランをご案内しています。",
  },
  {
    q: "制作期間はどれくらいですか?",
    a: "内容にもよりますが、目安は1〜2ヶ月程度です。ヒアリングの進み具合によって前後します。",
  },
  {
    q: "公開後に自分で更新できますか?",
    a: "はい。CMSを導入することで、文章や商品情報、営業時間などをご自身で更新できるようにします。",
  },
  {
    q: "対応エリアはどこまでですか?",
    a: "全国からご相談いただけます。基本的なやり取りはメールやLINEなどオンラインで進め、必要に応じてお電話やオンラインでお話しします。",
  },
  {
    q: "パソコンやITに詳しくなくても大丈夫ですか?",
    a: "専門用語をできるだけ使わずに進めます。分からないことは、その都度確認しながら進めます。",
  },
];

export default function Faq() {
  return (
    <section className="section" id="faq" aria-labelledby="faq-h">
      <div className="container">
        <div className="faq-wrap">
          <div className="faq-grid">
            <div className="faq-side">
              <p className="label-en">FAQ</p>
              <h2 className="h2" id="faq-h">
                よくあるご質問
              </h2>
              <p className="h2-sub">お客様からよくいただくご質問をまとめました。</p>
              <p style={{ marginTop: 22 }}>
                <a className="tlink" href="#contact">
                  ここにない質問は直接どうぞ
                  <IconArrow />
                </a>
              </p>
            </div>

            <div className="faq-list">
              {ITEMS.map(({ q, a }, i) => (
                <details className="faq-item" key={q} open={i === 0}>
                  <summary>
                    <span className="faq-q">Q</span>
                    {q}
                    <span className="faq-plus" aria-hidden="true" />
                  </summary>
                  <p>{a}</p>
                </details>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
