/**
 * Issue #380: the THIRD fictional shop's own page code (「架空のカーケア工房 そらいろ」 / SORAIRO WRAP & CARE LAB; no real
 * shop, car or customer). Owner 2026-11-28: its look is the design the owner made on the ChatGPT side
 * (design-preview.html, single HTML, inline CSS, system fonts, breakpoint 800px): a dark page with a notice line, a
 * brand header, a hero (copy + a picture), a three-service bar, sections with an eyebrow / large title / note, a
 * light service list, and a details band.
 *
 * What is the customer's (Pages CMS, content-model.ts) and what is fixed design:
 *   - CMS: 施工実績 (works: 車種, 施工種別, description, photos with 施工前 / 施工後, visible, order), お知らせ, 営業時間 and
 *     closures, address / phone (the existing shop fields). The shop name stays fixed (profile).
 *   - Fixed design (this file): the hero copy, the service list, every label, the layout and the CSS, and the static
 *     design pictures (site.design: the hero picture and the 表示形式サンプル before / after pair). Those pictures are
 *     AI-generated material (class A, recorded in design/sorairo/generated-materials.json) and are always captioned
 *     「AI生成・架空の施工イメージ」; the sample block is separate from the customer's works list, which never shows a
 *     generated picture (the model refuses one for a job).
 *
 * The hero title keeps the supplied two lines (愛車の表情を、／一枚のフィルムで。): the supplied 4.1vw size wraps
 * 「で。」 onto a third line at 1440 in Chromium (measured on design-preview.html), so the title is 3.4vw with each line
 * unbroken from 1140px up. On SP the sample's AI label sits under each picture (still visible, 12px) instead of over it.
 * Deviations from the supplied CSS, each for an existing check: text under 12px is raised to 12px (Q1 / phone checks:
 * nothing smaller than 12px), the brand link gets a 44px tap height, the CMS works list is a compact card grid (the
 * supplied page shows one large pair; 50 works must stay under the render cap) — the large pair layout is kept for the
 * static sample. Everything the content gives is escaped; the content cannot add elements, classes, styles or scripts.
 */
import type { Announcement, ShopInfo, ShopProfile, Work, WorkPhoto } from "./content-model";
import { viewOf, worksOf, type ShopContent } from "./content-model";

export const AUTO_PROFILE: ShopProfile = { fixedName: "架空のカーケア工房 そらいろ", extensions: [], collections: ["works"] };

/** The static design pictures the page uses (ids → file in the design folder). */
export const AUTO_DESIGN_PICTURES = [
  { id: "hero", file: "sorairo-matte-black.jpg", alt: "AI生成によるマットブラックの架空SUV" },
  { id: "sample-before", file: "sorairo-silver.jpg", alt: "AI生成の施工前イメージ、シルバーの架空SUV" },
  { id: "sample-after", file: "sorairo-matte-black.jpg", alt: "AI生成の施工後イメージ、マットブラックの架空SUV" },
] as const;
export type DesignAssets = Record<string, { src: string; alt: string }>;

const e = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const DAY_LABEL: Record<ShopInfo["hours"][number]["day"], string> = { mon: "月", tue: "火", wed: "水", thu: "木", fri: "金", sat: "土", sun: "日" };
const ROLE: Record<WorkPhoto["role"], { en: string; ja: string } | null> = { other: null, before: { en: "BEFORE", ja: "施工前" }, after: { en: "AFTER", ja: "施工後" } };
const AI_NOTE = "AI生成・架空の施工イメージ";

type SlotOf = ((image: string) => string | undefined) | undefined;

function img(p: WorkPhoto, slotOf: SlotOf, w: number, h: number): string {
  const slot = slotOf?.(p.image);
  return `<img ${slot ? `data-slot="${e(slot)}" ` : ""}src="${e(p.image)}" alt="${e(p.imageAlt)}" loading="lazy" width="${w}" height="${h}">`;
}
const frame = (p: WorkPhoto, slotOf: SlotOf, cls: string, w: number, h: number) => {
  const r = ROLE[p.role];
  return `<figure class="frame ${cls}">${img(p, slotOf, w, h)}${r ? `<figcaption class="role"><span class="en">${r.en}</span> <b>${r.ja}</b></figcaption>` : ""}</figure>`;
};

/** A job's photos: the 施工前 / 施工後 pair when it has both, otherwise its first photo large; the rest as thumbnails. */
function shots(w: Work, slotOf: SlotOf): string {
  const before = w.photos.find((p) => p.role === "before");
  const after = w.photos.find((p) => p.role === "after");
  const lead = before && after ? [before, after] : [w.photos[0]!];
  const rest = w.photos.filter((p) => !lead.includes(p));
  const top = lead.length === 2 ? `<div class="pair">${lead.map((p) => frame(p, slotOf, "half", 400, 300)).join("")}</div>` : frame(lead[0]!, slotOf, "main", 800, 600);
  return `${top}${rest.length ? `<div class="thumbs">${rest.map((p) => frame(p, slotOf, "thumb", 200, 200)).join("")}</div>` : ""}`;
}

function job(w: Work, slotOf: SlotOf): string {
  return `<li class="job" data-q1="item">${shots(w, slotOf)}<div class="meta"><p class="tag">${e(w.service)}</p><h3>${e(w.vehicle)}</h3>${w.description ? `<p class="desc">${e(w.description)}</p>` : ""}</div></li>`;
}

/** The static 表示形式サンプル (fixed design, AI-generated, captioned) — not a work of the shop. */
function sample(d: DesignAssets): string {
  const before = d["sample-before"];
  const after = d["sample-after"];
  if (!before || !after) return "";
  const fig = (a: { src: string; alt: string }, en: string, ja: string) => `<figure><img src="${e(a.src)}" alt="${e(a.alt)}" loading="lazy" width="1086" height="724"><figcaption>${en} <b>${ja}</b></figcaption><span class="ai">${AI_NOTE}</span></figure>`;
  return `<section class="section sample" id="sample" data-q1="section"><div class="section-title"><div><p class="eyebrow">FINISH STUDY / 02</p><h2>表示形式サンプル</h2></div><p>施工前後を見比べる表示の見本です。${AI_NOTE}で、実際の施工・車両ではありません。</p></div><div class="study">${fig(before, "BEFORE", "施工前")}${fig(after, "AFTER", "施工後")}</div><div class="study-meta"><div><p class="tag">FULL WRAP / MATTE FINISH</p><h3>架空車 SUV 2026年式</h3></div><p>シルバーからマットブラックへ。車体の輪郭と光の反射の違いを表現した架空のフルラッピングイメージです。</p></div></section>`;
}

function details(shop: ShopInfo, news: Announcement[], today: string): string {
  const closures = shop.specialClosures.filter((c) => c.date >= today).sort((a, b) => (a.date < b.date ? -1 : 1));
  const hours = shop.hours.map((h) => `<tr><th scope="row">${e(DAY_LABEL[h.day])}</th><td>${h.closed ? "定休日" : h.open && h.close ? `${e(h.open)}–${e(h.close)}` : "—"}</td></tr>`).join("");
  const newsPanel = `<div class="detail-panel" id="news" data-q1="section"><p class="eyebrow">NEWS / 04</p><h2>お知らせ</h2>${
    news.length ? `<ul class="notes">${news.map((n) => `<li data-q1="news"><time datetime="${e(n.publishedAt)}">${e(n.publishedAt)}</time><p class="title">${e(n.title)}</p>${n.body ? `<p>${e(n.body)}</p>` : ""}</li>`).join("")}</ul>` : '<p class="muted">お知らせはまだありません。</p>'
  }</div>`;
  const hoursPanel = `<div class="detail-panel" id="hours" data-q1="section"><p class="eyebrow">HOURS / 05</p><h2>営業時間</h2>${hours ? `<table class="week"><tbody>${hours}</tbody></table>` : '<p class="muted">営業時間はお問い合わせください。</p>'}${shop.hoursNote ? `<p class="muted">${e(shop.hoursNote)}</p>` : ""}${
    closures.length ? `<h3>臨時休業</h3><ul class="off">${closures.map((c) => `<li><time datetime="${e(c.date)}">${e(c.date)}</time>${c.note ? ` ${e(c.note)}` : ""}</li>`).join("")}</ul>` : ""
  }</div>`;
  const infoPanel = `<div class="detail-panel" id="info" data-q1="section"><p class="eyebrow">INFORMATION / 06</p><h2>${e(shop.name)}</h2>${shop.address ? `<p>${e(shop.address)}</p>` : ""}${shop.phone ? `<p class="tel">${e(shop.phone)}</p>` : ""}<p class="muted">実在する店舗ではありません。営業・予約・お問い合わせは受け付けていません。</p></div>`;
  return `<section class="section details" aria-label="店舗情報">${newsPanel}${hoursPanel}${infoPanel}</section>`;
}

/** The page (pure). `today` (YYYY-MM-DD) decides which special closures are still ahead; `design` are the static pictures. */
export function renderAuto(content: ShopContent, today: string, slotOf?: (image: string) => string | undefined, design: DesignAssets = {}): { html: string; css: string } {
  const v = viewOf(content);
  const works = worksOf(content);
  const hero = design["hero"];
  const gallery = works.length ? `<ol class="jobs">${works.map((w) => job(w, slotOf)).join("")}</ol>` : '<p class="empty">施工実績は準備中です。</p>';
  const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SORAIRO | ${e(v.shop.name)}</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
<div class="shell">
<div class="notice" data-q1="section"><span>提案用デモ（架空の店）/ デザインの写真はAI生成</span><span>SECOND ROOT — CMS DESIGN STUDY</span></div>
<header class="head" data-q1="section"><a class="brand" href="#top" aria-label="SORAIRO トップ"><span class="mark">S</span><span><span class="word">SORAIRO</span><span class="sub">${e(v.shop.name)}</span></span></a><nav aria-label="主要メニュー"><a href="#works">施工実績</a><a href="#services">サービス</a><a href="#info" class="link">店舗情報 <span>↗</span></a></nav></header>
<main id="top">
<section class="hero" aria-label="トップ" data-q1="section"><div class="hero-label"><span>CAR WRAPPING / VEHICLE PROTECTION</span><span>CONCEPT 01</span></div><div class="hero-grid"><div class="intro"><p class="eyebrow">A DIFFERENT FINISH.</p><h1><span class="nb">愛車の表情を、</span><br><span class="nb">一枚のフィルムで。</span></h1><p class="lead">カラーを変える。質感を選ぶ。<br>カーラッピングと車両保護の架空専門店、そらいろ。</p><a class="cta" href="#works">施工実績を見る <span>↘</span></a></div>${
    hero ? `<figure class="hero-art"><img src="${e(hero.src)}" alt="${e(hero.alt)}" width="1086" height="724"><figcaption class="photo-note">${AI_NOTE}</figcaption><span class="hero-code">MATTE CHARCOAL / CONCEPT</span></figure>` : '<div class="hero-art"></div>'
  }</div></section>
<div class="bar"><div><b>01</b> カーラッピング</div><div><b>02</b> 車両保護フィルム</div><div><b>03</b> 部分ラッピング</div></div>
<section class="section" id="works" data-q1="section"><div class="section-title"><div><p class="eyebrow">WORKS / 01</p><h2>施工実績</h2></div><p>お店が更新する施工の記録です。</p></div>${gallery}</section>
${sample(design)}
<section class="section service" id="services" data-q1="section"><div class="section-title"><div><p class="eyebrow">SERVICE MENU / 03</p><h2>変える。守る。整える。</h2></div><p>以下は架空店舗のサービス構成例です。実際の提供内容・料金はありません。</p></div><div class="service-list"><div class="service-item"><span>01 / WRAP</span><h3>フルラッピング</h3><p>車体全体の色や質感を変える施工のイメージ。</p></div><div class="service-item"><span>02 / PPF</span><h3>車両保護フィルム</h3><p>ボディ表面を保護する透明フィルムの紹介。</p></div><div class="service-item"><span>03 / DETAIL</span><h3>部分ラッピング</h3><p>ルーフやミラーなど、部分ごとの仕上げを紹介。</p></div></div></section>
${details(v.shop, v.news, today)}
</main>
<footer class="footer" data-q1="section"><span>SORAIRO / ${e(v.shop.name)}<br>DESIGN STUDY BY SECOND ROOT</span>${hero ? `<span>「${AI_NOTE}」の写真は生成した画像素材で、店の写真ではありません。</span>` : ""}<a href="#top">BACK TO TOP ↑</a></footer>
</div>
</body>
</html>
`;
  return { html, css: CSS };
}

/** The shop's own CSS (from the supplied design; content never reaches it). */
const CSS = `*{box-sizing:border-box}
html{scroll-behavior:smooth;-webkit-text-size-adjust:100%}
body{margin:0;background:#101111;color:#f5f3ed;font-family:Arial,"Hiragino Kaku Gothic ProN","Yu Gothic",Meiryo,sans-serif;line-height:1.7;overflow-wrap:anywhere}
a{color:inherit;text-decoration:none}
img{display:block;width:100%;height:auto}
p,h1,h2,h3,figure{margin:0}
a:focus-visible{outline:2px solid #c9ba92;outline-offset:5px}
.shell{max-width:1440px;margin:auto}
.notice{font-size:12px;color:#c6c7c4;padding:10px 5%;border-bottom:1px solid #313332;letter-spacing:.06em;display:flex;justify-content:space-between;gap:12px}
.head{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:24px 5%}
.brand{display:flex;align-items:center;gap:12px;line-height:1.08;min-height:44px}
.mark{width:38px;height:38px;display:grid;place-items:center;border:1px solid #a6a9a6;font-size:23px;font-weight:700;font-style:italic;transform:skew(-8deg)}
.word{font-size:24px;font-weight:800;letter-spacing:.16em}
.sub{display:block;font-size:12px;letter-spacing:.12em;color:#c7c9c7;margin-top:5px}
.head nav{display:flex;gap:30px;align-items:center;font-size:13px}
.head nav a{display:flex;align-items:center;min-height:44px}
.head nav .link{border:1px solid #787b78;padding:0 17px;gap:13px}
.hero{padding:0 5% 64px}
.hero-label{font-size:12px;letter-spacing:.19em;color:#b1b4b2;border-top:1px solid #3c3e3d;padding:12px 0;display:flex;justify-content:space-between}
.hero-grid{display:grid;grid-template-columns:35% 65%;min-height:465px}
.intro{padding:38px 26px 32px 0;align-self:center}
.eyebrow{font-size:12px;letter-spacing:.22em;color:#c9ba92;font-weight:700}
.intro h1{font-size:clamp(30px,3.4vw,58px);line-height:1.25;letter-spacing:-.045em;margin:20px 0 22px;font-weight:700}
.intro .lead{font-size:14px;color:#c0c3c1;max-width:300px}
.cta{display:inline-flex;align-items:center;justify-content:space-between;min-height:49px;gap:34px;border-bottom:1px solid #c9ba92;margin-top:25px;color:#f6f3e9;font-size:13px}
.hero-art{position:relative;overflow:hidden;min-height:100%;background:#202222}
.hero-art img{height:100%;object-fit:cover;object-position:56% center}
.hero-art:after{content:"";position:absolute;inset:auto 0 0;height:30%;background:linear-gradient(transparent,rgba(0,0,0,.68));pointer-events:none}
.photo-note{position:absolute;z-index:1;bottom:18px;left:20px;font-size:12px;color:#fff;background:#101111d9;padding:4px 8px}
.hero-code{position:absolute;z-index:1;bottom:20px;right:20px;letter-spacing:.16em;font-size:12px}
.bar{display:grid;grid-template-columns:1fr 1fr 1fr;border-top:1px solid #393b39;border-bottom:1px solid #393b39;margin:0 5%;padding:0}
.bar div{padding:18px 20px 18px 0;display:flex;gap:13px;align-items:center;font-size:13px}
.bar div+div{border-left:1px solid #393b39;padding-left:24px}
.bar b{color:#c9ba92;font-size:12px;letter-spacing:.13em}
.section{padding:76px 5%}
.section-title{display:flex;align-items:end;justify-content:space-between;gap:24px;margin-bottom:32px}
.section-title h2{font-size:clamp(28px,3.7vw,50px);letter-spacing:-.03em;line-height:1.25;margin-top:8px}
.section-title p{color:#b5b7b5;font-size:13px;max-width:330px}
.jobs{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:28px 24px}
.job{border-top:1px solid #454745;padding-top:16px;min-width:0;display:flex;flex-direction:column}
.frame{position:relative;margin:0;background:#222;overflow:hidden;min-width:0}
.frame img{width:100%;height:100%;object-fit:cover}
.main{aspect-ratio:3/2}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:2px}
.half{aspect-ratio:3/4}
.thumbs{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:2px;margin-top:2px}
.thumb{aspect-ratio:1/1}
.role{position:absolute;top:0;left:0;background:#101111ed;padding:5px 10px;font-size:12px;letter-spacing:.1em;display:flex;gap:8px;align-items:center}
.role b{color:#c9ba92;font-weight:400}
.meta{padding:14px 0 0}
.tag{font-size:12px;letter-spacing:.12em;color:#c9ba92}
.job h3{font-size:20px;line-height:1.4;margin-top:4px}
.desc{font-size:13px;color:#c0c3c1;margin-top:8px}
.empty{font-size:15px;color:#c0c3c1;border-top:1px solid #454745;padding:24px 0}
.study{border-top:1px solid #454745;border-bottom:1px solid #454745;padding:20px 0;display:grid;grid-template-columns:1fr 1fr;gap:2px}
.study figure{position:relative;min-width:0;background:#222}
.study img{aspect-ratio:3/2;object-fit:cover}
.study figcaption{position:absolute;top:0;left:0;background:#101111ed;padding:8px 14px;font-size:12px;letter-spacing:.12em;display:flex;gap:10px;align-items:center}
.study figcaption b{color:#c9ba92;font-weight:400}
.study .ai{position:absolute;bottom:9px;right:9px;color:#fff;font-size:12px;padding:3px 6px;background:#101111e0}
.study-meta{display:grid;grid-template-columns:1fr 1fr;gap:20px;padding:22px 0 0}
.study-meta h3{font-size:24px;line-height:1.35;margin-top:5px}
.study-meta p{font-size:13px;color:#c0c3c1;align-self:end}
.service{background:#e5e4dd;color:#141615}
.service .eyebrow{color:#625a43}
.service .section-title p{color:#454a45}
.service-list{border-top:1px solid #a2a39b}
.service-item{display:grid;grid-template-columns:96px minmax(0,1fr) minmax(0,1fr);gap:20px;align-items:center;border-bottom:1px solid #a2a39b;padding:24px 0}
.service-item span{font-size:12px;letter-spacing:.14em;color:#5c625c}
.service-item h3{font-size:22px;line-height:1.4}
.service-item p{font-size:14px;color:#414641}
.details{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:40px}
.details h2{font-size:26px;margin-top:10px;line-height:1.4}
.details p{color:#bfc2bf;font-size:14px;margin-top:14px}
.details .detail-panel{border-top:1px solid #515351;padding-top:20px;min-width:0}
.details h3{font-size:15px;margin-top:16px}
.notes{list-style:none;margin:14px 0 0;padding:0}
.notes li{padding:10px 0;border-top:1px solid #333534}
.notes time{font-size:12px;color:#a6aaa6}
.notes p{margin-top:2px}
.notes .title{color:#f5f3ed;font-weight:700}
.week{width:100%;border-collapse:collapse;font-size:14px;margin-top:14px}
.week th,.week td{padding:5px 0;border-bottom:1px solid #333534;text-align:left;font-weight:400;color:#d8dad7}
.week td{text-align:right}
.off{margin:6px 0 0;padding-left:18px;font-size:14px;color:#d8dad7}
.details .tel{font-size:18px;color:#f5f3ed}
.muted{color:#bfc2bf}
.footer{padding:32px 5%;border-top:1px solid #3c3e3d;color:#a6aaa6;font-size:12px;display:flex;justify-content:space-between;gap:18px}
.footer a{min-height:44px;display:flex;align-items:center}
@media(min-width:1140px){.intro h1 .nb{white-space:nowrap}}
@media(max-width:1080px){.jobs{grid-template-columns:repeat(2,minmax(0,1fr))}.details{grid-template-columns:1fr 1fr}}
@media(max-width:800px){.head{flex-wrap:wrap;padding:18px 5%;gap:12px}.head nav{width:100%;justify-content:space-between;gap:12px;font-size:13px}.head nav .link{padding:0 10px;gap:6px}.notice span:last-child{display:none}.hero{padding-bottom:35px}.hero-grid{grid-template-columns:1fr;min-height:0}.intro{padding:24px 0 28px}.intro h1{font-size:40px;margin:14px 0}.intro .lead{max-width:unset}.hero-art{min-height:0;aspect-ratio:4/3}.hero-code{display:none}.photo-note{left:10px;bottom:10px}.bar div{padding:13px 8px 13px 0;display:block;font-size:12px;line-height:1.5}.bar div+div{padding-left:10px}.bar b{display:block;margin-bottom:5px}.section{padding:48px 5%}.section-title{display:block;margin-bottom:22px}.section-title p{margin-top:12px}.jobs{grid-template-columns:repeat(2,minmax(0,1fr));gap:18px 10px}.job{padding-top:10px}.role{padding:3px 6px;gap:4px}.role .en{display:none}.job h3{font-size:15px}.desc{font-size:13px}.study{padding:12px 0}.study img{aspect-ratio:4/3}.study figcaption{padding:5px 7px;gap:5px}.study .ai{position:static;display:block;background:none;padding:6px 2px 4px;font-size:12px;line-height:1.4;color:#c0c3c1}.study-meta{grid-template-columns:1fr;gap:9px;padding-top:14px}.study-meta h3{font-size:21px}.service-item{grid-template-columns:72px 1fr;gap:7px 10px;padding:20px 0}.service-item p{grid-column:2}.service-item h3{font-size:19px}.details{grid-template-columns:1fr;gap:30px}.footer{flex-wrap:wrap;padding:24px 5%}}
`;
