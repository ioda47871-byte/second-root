/**
 * DEV-303 §3.7 Q1, first experiment: FICTIONAL test content for the CMS-update check (no real shop, no real
 * pictures). Each fixture is a shop repository (content/ + media/) as the customer could leave it after edits in
 * Pages CMS: 0 / 3 / 10 / 50 items, long names and descriptions, price formats, pictures of every shape (and none),
 * hidden / sold-out / reordered items, changed hours and special closures, 0 / 1 / many announcements.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import type { Announcement, Category, MenuItem, ShopInfo } from "./content-model";

/** A solid-colour PNG (synthetic). */
export function solidPng(w: number, h: number, rgb: [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

export type Fixture = { shop: ShopInfo; categories: Category[]; menu: MenuItem[]; news: Announcement[]; media: Record<string, Buffer> };

const SHOP: ShopInfo = {
  name: "架空のパン屋 こむぎ舎",
  address: "架空県架空市1-2-3（試験用）",
  phone: "03-0000-0000",
  hours: (["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const).map((day) => (day === "wed" ? { day, closed: true, open: "", close: "" } : { day, closed: false, open: "08:00", close: "18:00" })),
  hoursNote: "",
  specialClosures: [],
};
const CATEGORIES: Category[] = [
  { id: "bread", name: "食事パン", displayOrder: 1, visible: true },
  { id: "sweet", name: "菓子パン", displayOrder: 2, visible: true },
  { id: "bake", name: "焼き菓子", displayOrder: 3, visible: true },
];
const SHAPES: [number, number][] = [
  [600, 400],
  [500, 500],
  [400, 600],
];
const COLOURS: [number, number, number][] = [
  [196, 160, 112],
  [150, 98, 60],
  [222, 200, 160],
];
const PRICES = ["280円", "320円（税込）", "¥1,280", "時価", "380〜520円", ""];

function items(n: number): { menu: MenuItem[]; media: Record<string, Buffer> } {
  const media: Record<string, Buffer> = {};
  const menu = Array.from({ length: n }, (_, k) => {
    const shape = k % 4 === 3 ? null : SHAPES[k % 3]!;
    const file = shape ? `item-${k + 1}.png` : "";
    if (shape) media[file] = solidPng(shape[0], shape[1], COLOURS[k % 3]!);
    return {
      id: `item-${k + 1}`,
      name: `試験の商品 ${k + 1}`,
      category: CATEGORIES[k % 3]!.id,
      description: k % 2 ? "架空の説明です。" : "",
      priceDisplay: PRICES[k % PRICES.length]!,
      image: file ? `/media/${file}` : "",
      imageAlt: file ? `試験の画像 ${k + 1}` : "",
      imageKind: k % 5 === 4 ? ("shop" as const) : ("generated" as const),
      visible: true,
      soldOut: false,
      displayOrder: k,
    };
  });
  return { menu, media };
}

const LONG_NAME = "北の大地の全粒粉と天然酵母でじっくり二日かけて発酵させた、香ばしい皮ともっちりした中身の大きなカンパーニュ（季節の木の実入り）";
const LONG_WORD = "Pain-au-levain-traditionnel-de-campagne-aux-noix-et-raisins-secs";

/** The Q1 fixtures by name (fictional). `today` for the closures is 2026-12-01. */
let cached: Record<string, Fixture> | undefined;
/** The fixtures (made once per process; callers must not change them). */
export function q1Fixtures(): Record<string, Fixture> {
  return (cached ??= makeFixtures());
}
function makeFixtures(): Record<string, Fixture> {
  const base = (n: number) => ({ shop: SHOP, categories: CATEGORIES, news: [] as Announcement[], ...items(n) });
  const f: Record<string, Fixture> = {
    "items-0": base(0),
    "items-3": base(3),
    "items-10": base(10),
    "items-50": base(50),
  };
  const long = base(6);
  long.menu[0] = { ...long.menu[0]!, name: LONG_NAME, description: `${LONG_NAME}。`.repeat(3) };
  long.menu[1] = { ...long.menu[1]!, name: LONG_WORD, priceDisplay: "1,280円（税込・1本）〜2,480円（税込・特大）" };
  f["long-text"] = long;
  const states = base(10);
  states.menu = states.menu.map((m, k) => ({ ...m, visible: k % 5 !== 0, soldOut: k % 3 === 0, displayOrder: 100 - k }));
  f["hidden-soldout-reorder"] = states;
  const hours = base(3);
  hours.shop = {
    ...SHOP,
    hours: SHOP.hours.map((h) => (h.day === "sat" ? { ...h, open: "07:30", close: "15:00" } : h.day === "mon" ? { ...h, closed: true, open: "", close: "" } : h)),
    hoursNote: "売り切れ次第閉店します。祝日は営業時間が変わることがあります。",
    specialClosures: [
      { date: "2026-11-20", note: "過ぎた休業（表示しない）" },
      { date: "2026-12-29", note: "年末年始" },
      { date: "2026-12-30", note: "" },
      { date: "2027-01-05", note: "設備の点検のため臨時休業します" },
    ],
  };
  f["hours-closures"] = hours;
  const one = base(3);
  one.news = [{ id: "news-1", title: "冬の限定パンを始めました", body: "試験用のお知らせです。", publishedAt: "2026-11-30", visible: true }];
  f["news-1"] = one;
  const many = base(3);
  many.news = Array.from({ length: 12 }, (_, k) => ({
    id: `news-${k + 1}`,
    title: k === 0 ? `${LONG_NAME}のお知らせ` : `お知らせ ${k + 1}`,
    body: k % 2 ? "" : "試験用の本文です。".repeat(k + 1),
    publishedAt: `2026-11-${String(k + 1).padStart(2, "0")}`,
    visible: k !== 3,
  }));
  f["news-many"] = many;
  // the bakery's optional extensions (allergens, shelf life) and every price-text class of the 総額表示 report
  const trade = base(6);
  const prices = ["324円（税込）", "300円（税別）", "¥1,280", "時価", "", "本体1,000円（税込1,080円）"];
  trade.menu = trade.menu.map((m, k) => ({ ...m, priceDisplay: prices[k]!, ...(k % 2 === 0 ? { allergens: ["小麦", "乳", "卵"], shelfLife: k === 0 ? "当日中" : "翌日まで" } : {}) }));
  f["trade-extensions"] = trade;
  f["photos-large-odd"] = photoVariety(base(6), "item");
  return f;
}

/**
 * PR (4): pictures at the edges of the photo limits (photos.ts), every one allowed: a large one, the widest and the
 * tallest ratio (3:1, 1:3), the smallest side, a square; generated materials and shop photos mixed.
 */
export const PHOTO_VARIETY: { w: number; h: number; kind: "generated" | "shop" }[] = [
  { w: 3600, h: 2400, kind: "generated" },
  { w: 1200, h: 400, kind: "generated" },
  { w: 400, h: 1200, kind: "shop" },
  { w: 320, h: 320, kind: "generated" },
  { w: 2000, h: 2000, kind: "shop" },
  { w: 960, h: 340, kind: "generated" },
];
export function photoVariety(fx: Fixture, prefix: string): Fixture {
  const media: Record<string, Buffer> = {};
  const menu = fx.menu.map((m, k) => {
    const p = PHOTO_VARIETY[k % PHOTO_VARIETY.length]!;
    const file = `${prefix}-photo-${k + 1}.png`;
    media[file] = solidPng(p.w, p.h, COLOURS[k % 3]!);
    return { ...m, image: `/media/${file}`, imageAlt: `試験の画像 ${k + 1}`, imageKind: p.kind };
  });
  return { ...fx, menu, media };
}

/** Writes one fixture as a shop repository (content/ + media/) under `dir`. */
export async function writeFixture(dir: string, fx: Fixture): Promise<void> {
  for (const d of ["content/menu", "content/categories", "content/news", "media"]) await mkdir(join(dir, d), { recursive: true });
  const json = (o: unknown) => `${JSON.stringify(o, null, 2)}\n`;
  await writeFile(join(dir, "content", "shop.json"), json(fx.shop));
  for (const c of fx.categories) await writeFile(join(dir, "content", "categories", `${c.id}.json`), json(c));
  for (const m of fx.menu) await writeFile(join(dir, "content", "menu", `${m.id}.json`), json(m));
  for (const n of fx.news) await writeFile(join(dir, "content", "news", `${n.id}.json`), json(n));
  for (const [name, bytes] of Object.entries(fx.media)) await writeFile(join(dir, "media", name), bytes);
}

export const Q1_TODAY = "2026-12-01";
