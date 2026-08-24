import Image from "next/image";
import { IconArrow } from "./Decor";

/** 自主制作。実在の店舗ではないため、Real Project とは明確に分けて扱う。 */
const WORKS = [
  {
    slug: "hoshi-no-cha",
    tag: "TEA STAND",
    tagClass: "cw-tag--a",
    name: "星の茶スタンド",
    cat: "日本茶スタンド",
    role: "ブランド / 世界観設計",
    image: "/concept-work/hoshi-no-cha.jpg",
    w: 1560,
    h: 860,
    url: "https://hoshi-no-cha-stand.vercel.app",
  },
  {
    slug: "yasashii-beauty-salon",
    tag: "SALON",
    tagClass: "cw-tag--b",
    name: "やさしい美を彩るサロン",
    cat: "美容サロン",
    role: "美容 / 写真 / 安心感",
    image: "/concept-work/yasashii-beauty-salon.webp",
    w: 1600,
    h: 1000,
    url: "https://yasashii-beauty-salon.vercel.app",
  },
  {
    slug: "midori-seitai",
    tag: "CLINIC",
    tagClass: "cw-tag--c",
    name: "みどり整体院",
    cat: "整体院",
    role: "情報設計 / 導線設計",
    image: "/concept-work/midori-seitai.webp",
    w: 1500,
    h: 1000,
    url: "https://midori-seitai.vercel.app",
  },
];

export default function ConceptWorks() {
  return (
    <section className="section section--alt" aria-labelledby="cw-h">
      <div className="container">
        <div className="sec-head sec-head--center">
          <p className="label-en">Concept Work</p>
          <h2 className="h2" id="cw-h">
            自主制作
          </h2>
          <p className="h2-sub">
            業種ごとの設計力をお見せするために制作した自主制作サイトです。実在する店舗ではありません。
          </p>
          <span className="rule-mark" />
        </div>

        <div className="cw-grid">
          {WORKS.map((w) => (
            <a
              className="cw-card"
              key={w.slug}
              href={w.url}
              target="_blank"
              rel="noopener noreferrer"
              data-ga="external_work_click"
            >
              <div className="cw-thumb">
                <span className={`cw-tag ${w.tagClass}`}>{w.tag}</span>
                <Image
                  src={w.image}
                  alt={`${w.name}(自主制作サイト)のスクリーンショット`}
                  width={w.w}
                  height={w.h}
                  sizes="(max-width:900px) 92vw, 30vw"
                />
              </div>
              <div className="cw-body">
                <h3 className="cw-name">{w.name}</h3>
                <p className="cw-cat">{w.cat}</p>
                <p className="cw-role">{w.role}</p>
                <span className="cw-go">
                  サイトを見る
                  <IconArrow />
                </span>
              </div>
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}
