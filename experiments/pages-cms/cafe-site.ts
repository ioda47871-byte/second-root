/**
 * PR (3): a SECOND fictional shop's own page code (「架空のカフェ 木洩れ日珈琲」, invented for this experiment; no real
 * shop), deliberately unlike the bakery: a narrow header instead of a dark hero, the menu as a price list (rows with a
 * small square picture, sizes with their own price texts) instead of a card grid, and on PC a side column for news,
 * hours and closures next to the menu. It reads the same shared content model (content-model.ts viewOf) and only
 * fills its own slots with escaped text and the customer's pictures; the content cannot add elements, classes, styles
 * or scripts. It turns on the `sizes` extension (a café's S / M / L), not the bakery's allergens / shelf life.
 */
import type { Announcement, MenuItem, ShopInfo, ShopProfile } from "./content-model";
import { viewOf, type ShopContent } from "./content-model";

export const CAFE_PROFILE: ShopProfile = { fixedName: "架空のカフェ 木洩れ日珈琲", extensions: ["sizes"] };

const e = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const DAY_LABEL: Record<ShopInfo["hours"][number]["day"], string> = { mon: "月", tue: "火", wed: "水", thu: "木", fri: "金", sat: "土", sun: "日" };

function prices(m: MenuItem): string {
  if (m.sizes?.length) return `<ul class="sizes">${m.sizes.map((s) => `<li><span class="size">${e(s.label)}</span>${s.priceDisplay ? `<span class="yen">${e(s.priceDisplay)}</span>` : ""}</li>`).join("")}</ul>`;
  return m.priceDisplay ? `<p class="yen">${e(m.priceDisplay)}</p>` : "";
}

function row(m: MenuItem): string {
  const pic = m.image ? `<img src="${e(m.image)}" alt="${e(m.imageAlt)}" loading="lazy" width="160" height="160">` : "";
  return `<li class="row${m.soldOut ? " out" : ""}" data-q1="item"><div class="thumb">${pic}</div><div class="what"><h3>${e(m.name)}</h3>${m.soldOut ? '<p class="tag">売り切れ</p>' : ""}${m.description ? `<p class="desc">${e(m.description)}</p>` : ""}</div><div class="cost">${prices(m)}</div></li>`;
}

function side(shop: ShopInfo, news: Announcement[], today: string): string {
  const closures = shop.specialClosures.filter((c) => c.date >= today).sort((a, b) => (a.date < b.date ? -1 : 1));
  const hours = shop.hours.map((h) => `<li><span>${e(DAY_LABEL[h.day])}</span><span>${h.closed ? "定休日" : h.open && h.close ? `${e(h.open)}–${e(h.close)}` : "—"}</span></li>`).join("");
  return `<aside class="side">${
    news.length ? `<section class="box news" id="news" data-q1="section"><h2>お知らせ</h2><ol>${news.map((n) => `<li data-q1="news"><time datetime="${e(n.publishedAt)}">${e(n.publishedAt)}</time><p class="title">${e(n.title)}</p>${n.body ? `<p>${e(n.body)}</p>` : ""}</li>`).join("")}</ol></section>` : ""
  }<section class="box hours" id="hours" data-q1="section"><h2>営業時間</h2>${hours ? `<ul class="week">${hours}</ul>` : "<p>営業時間はお問い合わせください。</p>"}${shop.hoursNote ? `<p class="note">${e(shop.hoursNote)}</p>` : ""}${
    closures.length ? `<h3>臨時休業</h3><ul class="off">${closures.map((c) => `<li><time datetime="${e(c.date)}">${e(c.date)}</time>${c.note ? ` ${e(c.note)}` : ""}</li>`).join("")}</ul>` : ""
  }</section></aside>`;
}

/** The page (pure). `today` (YYYY-MM-DD) decides which special closures are still ahead. */
export function renderCafe(content: ShopContent, today: string): { html: string; css: string } {
  const v = viewOf(content);
  const menu = v.sections.length
    ? v.sections.map((s) => `<section class="cat" data-q1="section"><h2>${e(s.category.name)}</h2><ul class="list">${s.items.map(row).join("")}</ul></section>`).join("")
    : '<p class="empty">メニューは準備中です。</p>';
  const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(v.shop.name)}</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
<header class="bar" data-q1="section"><p class="name">${e(v.shop.name)}</p><nav><a href="#menu">メニュー</a><a href="#hours">営業時間</a>${v.news.length ? '<a href="#news">お知らせ</a>' : ""}</nav><p class="demo">提案用デモ（架空の店）</p></header>
<div class="page">
<main id="menu" class="menu">${menu}</main>
${side(v.shop, v.news, today)}
</div>
<footer data-q1="section"><p>${e(v.shop.name)}</p>${v.shop.address ? `<p>${e(v.shop.address)}</p>` : ""}${v.shop.phone ? `<p>${e(v.shop.phone)}</p>` : ""}<p class="note">写真はイメージです。</p></footer>
</body>
</html>
`;
  return { html, css: CSS };
}

/** The café's own CSS (fixed; content never reaches it). */
const CSS = `*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:#f3f1e8;color:#23312a;font-family:"Hiragino Sans","Yu Gothic",sans-serif;line-height:1.7;overflow-wrap:anywhere}
.bar{display:flex;flex-wrap:wrap;align-items:center;gap:4px 28px;padding:14px 5vw;background:#fffdf6;border-bottom:3px solid #2f5d46}
.bar .name{margin:0;font-size:22px;font-weight:bold;letter-spacing:.05em}
.bar nav{display:flex;flex-wrap:wrap;gap:0 18px}
.bar nav a{color:#2f5d46;font-size:15px;display:inline-flex;align-items:center;min-height:44px;min-width:44px}
.bar .demo{margin:0 0 0 auto;font-size:13px;color:#5e6b63}
.page{max-width:1240px;margin:0 auto;padding:24px 5vw 0;display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:40px;align-items:start}
h2{font-size:20px;margin:28px 0 10px;color:#2f5d46}
.list{list-style:none;margin:0;padding:0}
.row{display:grid;grid-template-columns:80px minmax(0,1fr) auto;gap:14px;align-items:start;padding:14px 0;border-top:1px solid #d6d2c2;min-width:0}
.thumb{width:80px;height:80px;background:#e3e0d2;border-radius:6px;overflow:hidden}
.thumb img{width:100%;height:100%;object-fit:cover;display:block}
.what h3{margin:0;font-size:17px;line-height:1.5}
.desc{margin:4px 0 0;font-size:14px;color:#46544c}
.tag{display:inline-block;margin:4px 0 0;padding:0 8px;border:1px solid #8a3b22;color:#8a3b22;font-size:13px}
.out .thumb{opacity:.5}
.cost{text-align:right;min-width:0;max-width:220px}
.yen{margin:0;font-size:15px;font-weight:bold}
.sizes{list-style:none;margin:0;padding:0;font-size:14px}
.sizes li{display:flex;justify-content:flex-end;gap:8px}
.size{color:#5e6b63}
.empty{margin:32px 0;font-size:16px}
.side{display:flex;flex-direction:column;gap:20px;min-width:0}
.box{background:#fffdf6;border:1px solid #d6d2c2;border-radius:8px;padding:6px 18px 16px}
.box h3{font-size:15px;margin:14px 0 4px}
.news ol{list-style:none;margin:0;padding:0}
.news li{padding:8px 0;border-top:1px dashed #d6d2c2}
.news time{font-size:13px;color:#5e6b63}
.news .title{margin:0;font-weight:bold;font-size:15px}
.news p{margin:2px 0 0;font-size:14px}
.week{list-style:none;margin:0;padding:0;font-size:15px}
.week li{display:flex;justify-content:space-between;border-bottom:1px solid #ebe8dc;padding:4px 0}
.off{margin:0;padding-left:18px;font-size:14px}
.note{font-size:13px;color:#5e6b63}
footer{margin-top:56px;padding:24px 5vw;background:#2f5d46;color:#f3f1e8;font-size:14px}
footer .note{color:#d9e4dc}
@media (max-width:760px){.page{grid-template-columns:1fr;gap:8px;padding:12px 16px 0}.bar{padding:10px 16px}.bar .demo{margin:0;width:100%}.row{grid-template-columns:64px minmax(0,1fr);}.thumb{width:64px;height:64px}.cost{grid-column:2;text-align:left;max-width:none}.sizes li{justify-content:flex-start}}
`;
