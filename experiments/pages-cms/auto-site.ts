/**
 * Issue #380 (owner 2026-11-27): a THIRD fictional shop's own page code (「架空のカーケア工房 そらいろ」, invented for this
 * experiment; no real shop, no real car, no real customer), a car-detailing / auto-service shop whose customer updates
 * its 施工実績 (finished jobs) and their photos in Pages CMS. Deliberately unlike the bakery (dark hero + card grid) and
 * the café (bar + price list + side column): a light top band, the 施工実績 as a gallery of job cards (a 施工前 / 施工後
 * pair side by side when the job has both, otherwise one large photo, the job's other photos as small thumbnails), then
 * an information band of three boxes (お知らせ, 営業時間 with closures, アクセス). No menu: the site turns the `works`
 * collection on and `menu` off (content-model.ts ShopCollection), and no trade extension.
 *
 * It reads the shared content model (content-model.ts worksOf, viewOf) and only fills its own slots with escaped text
 * and the customer's photos; the content cannot add elements, classes, styles or scripts. A job's photos are the shop's
 * own (B or C; a generated picture is refused by the model), so no イメージ label appears on this page.
 */
import type { Announcement, ShopInfo, ShopProfile, Work, WorkPhoto } from "./content-model";
import { viewOf, worksOf, type ShopContent } from "./content-model";

export const AUTO_PROFILE: ShopProfile = { fixedName: "架空のカーケア工房 そらいろ", extensions: [], collections: ["works"] };

const e = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const DAY_LABEL: Record<ShopInfo["hours"][number]["day"], string> = { mon: "月", tue: "火", wed: "水", thu: "木", fri: "金", sat: "土", sun: "日" };
const ROLE_LABEL: Record<WorkPhoto["role"], string> = { other: "", before: "施工前", after: "施工後" };

type SlotOf = ((image: string) => string | undefined) | undefined;

function img(p: WorkPhoto, slotOf: SlotOf, w: number, h: number): string {
  const slot = slotOf?.(p.image);
  return `<img ${slot ? `data-slot="${e(slot)}" ` : ""}src="${e(p.image)}" alt="${e(p.imageAlt)}" loading="lazy" width="${w}" height="${h}">`;
}
const frame = (p: WorkPhoto, slotOf: SlotOf, cls: string, w: number, h: number) =>
  `<figure class="frame ${cls}">${img(p, slotOf, w, h)}${ROLE_LABEL[p.role] ? `<figcaption class="role">${ROLE_LABEL[p.role]}</figcaption>` : ""}</figure>`;

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
  return `<li class="job" data-q1="item">${shots(w, slotOf)}<div class="body"><p class="svc">${e(w.service)}</p><h3>${e(w.vehicle)}</h3>${w.description ? `<p class="desc">${e(w.description)}</p>` : ""}</div></li>`;
}

function info(shop: ShopInfo, news: Announcement[], today: string): string {
  const closures = shop.specialClosures.filter((c) => c.date >= today).sort((a, b) => (a.date < b.date ? -1 : 1));
  const hours = shop.hours.map((h) => `<tr><th scope="row">${e(DAY_LABEL[h.day])}</th><td>${h.closed ? "定休日" : h.open && h.close ? `${e(h.open)}–${e(h.close)}` : "—"}</td></tr>`).join("");
  const newsBox = news.length
    ? `<section class="box" id="news" data-q1="section"><h2>お知らせ</h2><ul class="notes">${news.map((n) => `<li data-q1="news"><time datetime="${e(n.publishedAt)}">${e(n.publishedAt)}</time><p class="title">${e(n.title)}</p>${n.body ? `<p>${e(n.body)}</p>` : ""}</li>`).join("")}</ul></section>`
    : "";
  const hoursBox = `<section class="box" id="hours" data-q1="section"><h2>営業時間</h2>${hours ? `<table class="week"><tbody>${hours}</tbody></table>` : "<p>営業時間はお問い合わせください。</p>"}${shop.hoursNote ? `<p class="note">${e(shop.hoursNote)}</p>` : ""}${
    closures.length ? `<h3>臨時休業</h3><ul class="off">${closures.map((c) => `<li><time datetime="${e(c.date)}">${e(c.date)}</time>${c.note ? ` ${e(c.note)}` : ""}</li>`).join("")}</ul>` : ""
  }</section>`;
  const accessBox = shop.address || shop.phone ? `<section class="box" id="access" data-q1="section"><h2>アクセス</h2>${shop.address ? `<p>${e(shop.address)}</p>` : ""}${shop.phone ? `<p class="tel">${e(shop.phone)}</p>` : ""}</section>` : "";
  return `<div class="info">${newsBox}${hoursBox}${accessBox}</div>`;
}

/** The page (pure). `today` (YYYY-MM-DD) decides which special closures are still ahead. */
export function renderAuto(content: ShopContent, today: string, slotOf?: (image: string) => string | undefined): { html: string; css: string } {
  const v = viewOf(content);
  const works = worksOf(content);
  const gallery = works.length ? `<ol class="jobs">${works.map((w) => job(w, slotOf)).join("")}</ol>` : '<p class="empty">施工実績は準備中です。</p>';
  const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(v.shop.name)}</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
<header class="top" data-q1="section"><div class="in"><p class="name">${e(v.shop.name)}</p><p class="demo">提案用デモ（架空の店）</p><nav><a href="#works">施工実績</a><a href="#hours">営業時間</a>${v.news.length ? '<a href="#news">お知らせ</a>' : ""}${v.shop.address || v.shop.phone ? '<a href="#access">アクセス</a>' : ""}</nav></div></header>
<main>
<section class="works" id="works" data-q1="section"><h2>施工実績</h2>${gallery}</section>
${info(v.shop, v.news, today)}
</main>
<footer data-q1="section"><p>${e(v.shop.name)}</p></footer>
</body>
</html>
`;
  return { html, css: CSS };
}

/** The shop's own CSS (fixed; content never reaches it). */
const CSS = `*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:#eef1f4;color:#17212b;font-family:"Hiragino Sans","Yu Gothic",sans-serif;line-height:1.7;overflow-wrap:anywhere}
.top{background:#fff;border-top:6px solid #1d4e89;box-shadow:0 1px 0 #d3dae2}
.top .in{max-width:1200px;margin:0 auto;padding:16px 32px;display:flex;flex-wrap:wrap;align-items:center;gap:4px 24px}
.top .name{margin:0;font-size:24px;font-weight:bold;letter-spacing:.04em}
.top .demo{margin:0;font-size:13px;color:#4a5866}
.top nav{display:flex;flex-wrap:wrap;gap:0 20px;margin-left:auto}
.top nav a{color:#1d4e89;font-size:15px;font-weight:bold;text-decoration:none;display:inline-flex;align-items:center;min-height:44px;min-width:44px}
main{max-width:1200px;margin:0 auto;padding:8px 32px 0}
h2{font-size:22px;margin:32px 0 14px;padding-left:12px;border-left:6px solid #1d4e89}
.jobs{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:24px}
.job{background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 3px rgba(23,33,43,.12);min-width:0;display:flex;flex-direction:column}
.frame{position:relative;margin:0;background:#d9dfe6;overflow:hidden}
.frame img{width:100%;height:100%;object-fit:cover;display:block}
.main{aspect-ratio:4/3}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:2px}
.half{aspect-ratio:3/4}
.thumbs{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:2px;margin-top:2px}
.thumb{aspect-ratio:1/1}
.role{position:absolute;left:8px;top:8px;margin:0;padding:0 8px;font-size:13px;line-height:1.8;font-weight:bold;background:#17212b;color:#fff;border-radius:4px}
.body{padding:12px 16px 16px}
.svc{display:inline-block;margin:0;padding:0 10px;font-size:13px;font-weight:bold;color:#1d4e89;border:1px solid #1d4e89;border-radius:4px;max-width:100%}
.job h3{margin:6px 0 0;font-size:17px;line-height:1.5}
.desc{margin:6px 0 0;font-size:14px;color:#3b4855}
.empty{margin:24px 0;font-size:16px}
.info{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:24px;margin-top:40px;align-items:start}
.box{background:#fff;border-radius:10px;padding:4px 20px 18px;min-width:0}
.box h2{font-size:18px;margin:18px 0 10px}
.box h3{font-size:15px;margin:14px 0 4px}
.box p{margin:4px 0;font-size:15px}
.notes{list-style:none;margin:0;padding:0}
.notes li{padding:8px 0;border-top:1px solid #e3e8ee}
.notes time{font-size:13px;color:#4a5866}
.notes .title{font-weight:bold}
.week{width:100%;border-collapse:collapse;font-size:15px}
.week th,.week td{padding:4px 0;border-bottom:1px solid #e3e8ee;text-align:left;font-weight:normal}
.week td{text-align:right}
.off{margin:0;padding-left:18px;font-size:14px}
.note{font-size:13px;color:#4a5866}
.tel{font-size:18px;font-weight:bold}
footer{margin-top:56px;padding:24px 32px;background:#17212b;color:#eef1f4;font-size:14px}
footer p{max-width:1136px;margin:0 auto}
@media (max-width:1080px){.jobs{grid-template-columns:repeat(2,minmax(0,1fr))}.info{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:720px){.top .in{padding:10px 16px}.top nav{margin-left:0;width:100%}main{padding:4px 16px 0}.jobs{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.body{padding:8px 10px 12px}.svc{font-size:12px;padding:0 8px}.job h3{font-size:14px}.desc{font-size:13px}.role{left:4px;top:4px;padding:0 6px;font-size:12px}.info{grid-template-columns:1fr;gap:16px}footer{padding:20px 16px}}
`;
