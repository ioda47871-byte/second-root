/**
 * DEV-303 §6.1 rows 10 and 12, first experiment: ONE fictional shop's own page code (「架空のパン屋 こむぎ舎」, invented
 * for this experiment; no real shop). In the formal flow this file is what Claude writes for one shop from its
 * approved design: its composition, its CSS and its label wording are its own. It reads the shared content model
 * (content-model.ts viewOf) at build time and only fills its own slots with escaped text and the customer's pictures;
 * the content cannot add elements, classes, styles or scripts.
 *
 * Output: index.html + style.css (static; no script; pictures under /media/; links only in-page). Every picture frame
 * is a plain rectangle with a fixed aspect (object-fit: cover), so a replaced picture of any shape keeps the layout.
 */
import type { Announcement, MenuItem, ShopInfo, ShopProfile } from "./content-model";
import { shownGenerated, viewOf, type ShopContent } from "./content-model";

/**
 * What this shop's page code declares (owner decision 2026-11-26): its name is fixed (the brand is this code), and it
 * turns on the bakery's optional extensions (allergens, shelf life). Sizes are a cafe's; this shop does not use them.
 */
export const BAKERY_PROFILE: ShopProfile = { fixedName: "架空のパン屋 こむぎ舎", extensions: ["allergens", "shelfLife"] };

const e = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const DAY_LABEL: Record<ShopInfo["hours"][number]["day"], string> = { mon: "月", tue: "火", wed: "水", thu: "木", fri: "金", sat: "土", sun: "日" };

function item(m: MenuItem): string {
  const pic = m.image
    ? `<img src="${e(m.image)}" alt="${e(m.imageAlt)}" loading="lazy" width="600" height="450">`
    : `<span class="noimg" aria-hidden="true">${e(m.name.slice(0, 1))}</span>`;
  return `<li class="item${m.soldOut ? " soldout" : ""}" data-q1="item"><figure class="frame">${pic}${m.image && m.imageKind === "generated" ? '<figcaption class="cap">イメージ</figcaption>' : ""}</figure><div class="body"><h3>${e(m.name)}</h3>${m.priceDisplay ? `<p class="price">${e(m.priceDisplay)}</p>` : ""}${m.soldOut ? '<p class="badge">売り切れ</p>' : ""}${m.description ? `<p class="desc">${e(m.description)}</p>` : ""}${extras(m)}</div></li>`;
}

/** The bakery's extensions, in its own words; nothing when the item has none. */
function extras(m: MenuItem): string {
  const rows = [m.shelfLife ? `<dt>日持ち</dt><dd>${e(m.shelfLife)}</dd>` : "", m.allergens?.length ? `<dt>アレルゲン</dt><dd>${m.allergens.map(e).join("・")}</dd>` : ""].join("");
  return rows ? `<dl class="extra">${rows}</dl>` : "";
}

function hours(shop: ShopInfo, today: string): string {
  const rows = shop.hours.map((h) => `<tr><th>${e(DAY_LABEL[h.day])}</th><td>${h.closed ? "定休日" : h.open && h.close ? `${e(h.open)}–${e(h.close)}` : "—"}</td></tr>`).join("");
  const closures = shop.specialClosures.filter((c) => c.date >= today).sort((a, b) => (a.date < b.date ? -1 : 1));
  return `<section class="hours" id="hours" data-q1="section"><h2>営業時間</h2>${rows ? `<table>${rows}</table>` : "<p>営業時間はお問い合わせください。</p>"}${shop.hoursNote ? `<p class="note">${e(shop.hoursNote)}</p>` : ""}${
    closures.length ? `<div class="closures"><h3>臨時休業</h3><ul>${closures.map((c) => `<li><time datetime="${e(c.date)}">${e(c.date)}</time>${c.note ? ` ${e(c.note)}` : ""}</li>`).join("")}</ul></div>` : ""
  }</section>`;
}

function news(list: Announcement[]): string {
  if (list.length === 0) return "";
  return `<section class="news" id="news" data-q1="section"><h2>お知らせ</h2><ul>${list
    .map((n) => `<li data-q1="news"><time datetime="${e(n.publishedAt)}">${e(n.publishedAt)}</time><h3>${e(n.title)}</h3>${n.body ? `<p>${e(n.body)}</p>` : ""}</li>`)
    .join("")}</ul></section>`;
}

/** The page (pure). `today` (YYYY-MM-DD) decides which special closures are still ahead. */
export function renderBakery(content: ShopContent, today: string): { html: string; css: string } {
  const v = viewOf(content);
  const menu = v.sections.length
    ? v.sections.map((s) => `<section class="cat" data-q1="section"><h2>${e(s.category.name)}</h2><ul class="grid">${s.items.map(item).join("")}</ul></section>`).join("")
    : '<p class="empty">ただいまメニューを準備しています。</p>';
  const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(v.shop.name)}</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
<header class="hero" data-q1="section"><p class="kicker">提案用デモ（架空の店）</p><h1>${e(v.shop.name)}</h1><nav><a href="#menu">メニュー</a><a href="#hours">営業時間</a>${v.news.length ? '<a href="#news">お知らせ</a>' : ""}</nav></header>
<main>
${news(v.news)}
<div id="menu" class="menu">${menu}</div>
${hours(v.shop, today)}
</main>
<footer data-q1="section"><p>${e(v.shop.name)}</p>${v.shop.address ? `<p>${e(v.shop.address)}</p>` : ""}${v.shop.phone ? `<p>${e(v.shop.phone)}</p>` : ""}${shownGenerated(v) ? '<p class="note">「イメージ」の写真は生成した画像素材で、店の写真ではありません。</p>' : ""}</footer>
</body>
</html>
`;
  return { html, css: CSS };
}

/** The shop's own CSS (fixed; content never reaches it). */
const CSS = `*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:#f6efe4;color:#2b211b;font-family:"Hiragino Mincho ProN","Yu Mincho",serif;line-height:1.8;overflow-wrap:anywhere}
.hero{padding:72px 6vw 48px;background:#3a2a20;color:#f6efe4}
.hero .kicker{margin:0 0 8px;font-size:14px;letter-spacing:.2em}
.hero h1{margin:0;font-size:clamp(32px,6vw,64px);line-height:1.2}
.hero nav{display:flex;flex-wrap:wrap;gap:4px 24px;margin-top:16px}
.hero nav a{color:#f6efe4;font-size:16px;display:inline-flex;align-items:center;min-height:44px;min-width:44px}
main{max-width:1200px;margin:0 auto;padding:0 6vw}
h2{font-size:clamp(22px,3vw,30px);margin:56px 0 20px;border-bottom:1px solid #b9a58f;padding-bottom:8px}
.grid{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:28px}
.item{background:#fffaf2;border:1px solid #e3d5c3;display:flex;flex-direction:column;min-width:0}
.frame{position:relative;margin:0;aspect-ratio:4/3;background:#e9dccb;overflow:hidden;display:flex;align-items:center;justify-content:center}
.cap{position:absolute;left:8px;bottom:8px;margin:0;padding:0 8px;font-size:12px;line-height:1.7;background:rgba(43,33,27,.82);color:#fff}
.frame img{width:100%;height:100%;object-fit:cover;display:block}
.noimg{font-size:48px;color:#a48c74}
.body{padding:14px 16px 18px}
.body h3{margin:0;font-size:18px;line-height:1.5}
.price{margin:6px 0 0;font-size:16px;font-weight:bold}
.badge{display:inline-block;margin:8px 0 0;padding:2px 10px;background:#7a2e1f;color:#fff;font-size:14px}
.soldout .frame img{opacity:.55}
.desc{margin:8px 0 0;font-size:15px}
.extra{margin:8px 0 0;font-size:14px;display:grid;grid-template-columns:auto 1fr;gap:2px 10px}.extra dt{color:#6b5a4c}.extra dd{margin:0}
.empty{margin:48px 0;font-size:16px}
.news ul{list-style:none;margin:0;padding:0}
.news li{padding:14px 0;border-bottom:1px dashed #c8b6a1}
.news time{font-size:14px;color:#6b5a4c}
.news h3{margin:2px 0 0;font-size:18px}
.news p{margin:4px 0 0;font-size:15px}
.hours table{border-collapse:collapse;font-size:16px}
.hours th,.hours td{padding:6px 16px 6px 0;text-align:left;border-bottom:1px solid #e3d5c3}
.closures ul{margin:8px 0 0;padding-left:20px;font-size:15px}
.note{font-size:14px;color:#6b5a4c}
footer{margin-top:72px;padding:32px 6vw;background:#2b211b;color:#efe5d8;font-size:15px}
footer .note{color:#cdbfae}
@media (max-width:600px){.hero{padding:48px 20px 32px}main{padding:0 20px}.grid{grid-template-columns:1fr 1fr;gap:14px}.body{padding:10px}.body h3{font-size:16px}.desc{font-size:14px}}
`;
